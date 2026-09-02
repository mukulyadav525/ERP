// ============================================================================
// Section 5 — Quotations & B2B / Contractor Pricing
//   * quotes are tax-EXCLUSIVE by default (2.8), unlike retail counter sales
//   * 5.1 approving a quote can hold stock, if the owner has turned that on,
//     with a hold period after which the reservation releases itself
//   * converting a quote produces a real invoice through the billing rules
//   * delivery challans cover goods sent to site ahead of the final bill
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, oneOf,
  writeBranch, resolveBranchScope, limit as clampLimit, arrayOf,
} from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { computeLine, totalInvoice, round2 } from '../../lib/tax.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { buildEstimatePdf } from '../../lib/pdf/index.js';
import { queueMessage } from '../../lib/whatsapp.js';
import { creditBalance, postCredit } from '../../lib/ledger.js';

/** Every quotation endpoint first checks the module is switched on (Section 5). */
async function assertModuleEnabled(trx: any, branchId: string | null) {
  const settings = await loadSettings(trx, branchId);
  if (!settings.enable_quotations_module) {
    throw forbidden('The quotations module is switched off. Turn on "Enable quotations module" in Admin Settings.');
  }
  return settings;
}

export default async function quotationsRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_quotations', async ({ session, db: trx, req }) => {
    await assertModuleEnabled(trx, session.branch_id);
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, c.customer_type,
             b.name AS branch_name, u.full_name AS created_by_name,
             (SELECT COALESCE(SUM(qty_base_unit * rate), 0) FROM quotation_lines WHERE quotation_id = q.quotation_id) AS total_value,
             (SELECT count(*) FROM quotation_lines WHERE quotation_id = q.quotation_id) AS line_count
        FROM quotations q
        JOIN customers c ON c.customer_id = q.customer_id
        JOIN branches b ON b.branch_id = q.branch_id
        LEFT JOIN users u ON u.user_id = q.created_by
       WHERE 1=1 ${branchId ? sql`AND q.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND q.status = ${q.status}::quotation_status` : sql``}
         ${q.customer_id ? sql`AND q.customer_id = ${uuid(q.customer_id, 'customer_id')}` : sql``}
       ORDER BY q.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.get('/:id', guarded('view_quotations', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`
      SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, c.gstin AS customer_gstin,
             b.name AS branch_name, b.gstin AS branch_gstin
        FROM quotations q JOIN customers c ON c.customer_id = q.customer_id
        JOIN branches b ON b.branch_id = q.branch_id WHERE q.quotation_id = ${id}
    `.execute(trx)).rows[0];
    if (!quotation) throw notFound('Quotation not found.');

    const lines = (await sql<any>`
      SELECT ql.*, p.name AS product_name, p.sku, p.base_unit, p.hsn_code,
             COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct,
             ql.qty_base_unit * ql.rate AS line_value
        FROM quotation_lines ql
        JOIN products p ON p.product_id = ql.product_id
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
       WHERE ql.quotation_id = ${id}
    `.execute(trx)).rows;

    // Quotes are priced tax-exclusive, so the GST is shown as an addition rather
    // than being extracted out of the quoted rate (2.8).
    const computed = lines.map((l: any) => computeLine({
      qty_in_sale_unit: Number(l.qty_base_unit), multiplier_to_base: 1,
      rate_per_base_unit: Number(l.rate), gst_rate_pct: Number(l.gst_rate_pct),
      price_type: quotation.price_type,
    }));
    return { ...quotation, lines, totals: totalInvoice(computed) };
  }));

  // ── Estimate / Quotation PDF — Template A (Sections 58.1, 61) ─────────────
  //
  // The same renderer and the same visual system as the tax invoice, so a
  // customer who receives a quote and then a bill sees one shop rather than two
  // pieces of software. What differs is the title, the accent colour, the
  // validity terms, and the fact that it says plainly that it is not a tax
  // invoice — a quote that could be mistaken for a bill is a real problem.
  app.get('/:id/pdf', guarded('view_quotations', async ({ db: trx, req, reply }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`
      SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, c.gstin AS customer_gstin,
             c.address AS customer_address, c.company_name AS customer_company,
             c.state AS customer_state, c.state_code AS customer_state_code,
             b.name AS branch_name, b.gstin AS branch_gstin, b.address AS branch_address,
             b.phone AS branch_phone, b.state_code AS branch_state_code,
             u.full_name AS created_by_name
        FROM quotations q
        JOIN customers c ON c.customer_id = q.customer_id
        JOIN branches b ON b.branch_id = q.branch_id
        LEFT JOIN users u ON u.user_id = q.created_by
       WHERE q.quotation_id = ${id}
    `.execute(trx)).rows[0];
    if (!quotation) throw notFound('Quotation not found.');

    const lines = (await sql<any>`
      SELECT ql.*, p.name AS product_name, p.sku, p.base_unit, p.hsn_code,
             p.base_unit::text AS unit_label,
             COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct
        FROM quotation_lines ql
        JOIN products p ON p.product_id = ql.product_id
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
       WHERE ql.quotation_id = ${id} ORDER BY ql.line_id
    `.execute(trx)).rows;

    // Priced through the shared tax engine, exactly as GET /:id does, so the
    // printed estimate and the on-screen one cannot disagree (3.1.1).
    const computed = lines.map((l: any) => computeLine({
      qty_in_sale_unit: Number(l.qty_base_unit), multiplier_to_base: 1,
      rate_per_base_unit: Number(l.rate), gst_rate_pct: Number(l.gst_rate_pct),
      price_type: quotation.price_type,
    }));
    const totals = totalInvoice(computed);

    const docLines = lines.map((l: any, i: number) => ({
      ...l,
      qty_in_sale_unit: Number(l.qty_base_unit),
      rate_locked_at_scan: Number(l.rate),
      discount_amount: computed[i].discount_amount,
      taxable_value: computed[i].taxable_value,
      cgst_amount: computed[i].cgst_amount,
      sgst_amount: computed[i].sgst_amount,
      igst_amount: computed[i].igst_amount,
      line_total: computed[i].line_total,
    }));

    const pdf = await buildEstimatePdf(trx, {
      ...quotation,
      subtotal: totals.subtotal,
      discount_total: totals.discount_total,
      cgst_total: totals.cgst_total,
      sgst_total: totals.sgst_total,
      igst_total: totals.igst_total,
      grand_total: totals.grand_total,
      with_gst: totals.tax_total > 0,
      valid_until: quotation.reservation_hold_until,
    }, docLines);

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition',
      `inline; filename="Estimate-${String(quotation.quotation_number ?? id).replace(/[^\w.-]/g, '_')}.pdf"`);
    return reply.send(pdf);
  }));

  app.post('/', guarded('create_quotation', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    await assertModuleEnabled(trx, branchId);

    const customerId = uuid(body.customer_id, 'Customer');
    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${customerId}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');

    const lines = arrayOf(body.lines, 'lines', (l) => ({
      product_id: uuid(l.product_id, 'lines[].product_id'),
      qty_base_unit: num(l.qty_base_unit, 'lines[].qty_base_unit', { min: 0.0001 }),
      rate: l.rate === undefined ? null : num(l.rate, 'lines[].rate', { min: 0 }),
    }));

    const quotationNumber = await nextNumber(trx, branchId, 'QUOTATION');
    const quotation = (await sql<any>`
      INSERT INTO quotations (quotation_number, branch_id, customer_id, status, price_type, created_by)
      VALUES (${quotationNumber}, ${branchId}, ${customerId}, 'DRAFT',
              ${oneOf(body.price_type ?? 'TAX_EXCLUSIVE', 'Price type', ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const)}::price_type,
              ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      // A contractor quote falls back to the catalog price when no rate is given,
      // rather than quoting zero.
      const rate = l.rate ?? Number((await sql<any>`
        SELECT selling_price FROM product_prices
         WHERE product_id = ${l.product_id} AND effective_to IS NULL
         ORDER BY (branch_id = ${branchId}) DESC NULLS LAST LIMIT 1
      `.execute(trx)).rows[0]?.selling_price ?? 0);
      if (!rate) throw badRequest('One of the items has no price on file. Set a catalog price or enter a rate.');

      await sql`
        INSERT INTO quotation_lines (quotation_id, product_id, qty_base_unit, rate)
        VALUES (${quotation.quotation_id}, ${l.product_id}, ${l.qty_base_unit}, ${rate})
      `.execute(trx);
    }
    return quotation;
  }));

  /**
   * 5.1 — approving is the point stock can actually be held. Generating a quote
   * never touches stock; only approval does, and only if the owner has enabled
   * reservation. The alternative — quoting 50 bags of cement that walk out the
   * door before the contractor returns — is the failure this prevents.
   */
  app.post('/:id/approve', guarded('approve_quotation', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const body = (req.body ?? {}) as Record<string, any>;

    const quotation = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id}`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Quotation not found.');
    if (quotation.status !== 'DRAFT') throw badRequest(`This quotation is ${quotation.status.toLowerCase()} and cannot be approved again.`);

    const settings = await assertModuleEnabled(trx, quotation.branch_id);
    // Reservation is a per-quotation choice on top of the chain-wide setting: a
    // confirmed order awaiting pickup can hold stock while a speculative estimate
    // does not.
    const reserve = body.reserve_stock === undefined
      ? Boolean(settings.quotation_stock_reservation)
      : Boolean(body.reserve_stock);
    const holdDays = body.hold_days === undefined
      ? Number(settings.quotation_hold_days)
      : num(body.hold_days, 'Hold period (days)', { min: 1, max: 90 });

    if (reserve) {
      const lines = (await sql<any>`
        SELECT ql.*, p.name AS product_name FROM quotation_lines ql
          JOIN products p ON p.product_id = ql.product_id WHERE ql.quotation_id = ${id}
      `.execute(trx)).rows;

      for (const l of lines) {
        const stock = (await sql<any>`
          SELECT base_unit_qty, reserved_qty FROM branch_stock
           WHERE branch_id = ${quotation.branch_id} AND product_id = ${l.product_id} FOR UPDATE
        `.execute(trx)).rows[0];
        const available = Number(stock?.base_unit_qty ?? 0) - Number(stock?.reserved_qty ?? 0);
        if (available < Number(l.qty_base_unit)) {
          throw conflict(`Cannot reserve ${l.qty_base_unit} of "${l.product_name}" — only ${Math.max(available, 0)} is available. Approve without a reservation, or reduce the quantity.`);
        }
        await sql`
          UPDATE branch_stock SET reserved_qty = reserved_qty + ${l.qty_base_unit}, updated_at = now()
           WHERE branch_id = ${quotation.branch_id} AND product_id = ${l.product_id}
        `.execute(trx);
        await sql`
          INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change,
                                    ref_table, ref_id, reason_code, created_by)
          VALUES (${quotation.branch_id}, ${l.product_id}, 'RESERVATION', 0, 'quotations', ${id},
                  'QUOTATION_HOLD', ${session.user_id})
        `.execute(trx);
      }
    }

    await sql`
      UPDATE quotations SET status = 'APPROVED', stock_reserved = ${reserve},
             reservation_hold_until = ${reserve ? sql`now() + make_interval(days => ${holdDays})` : null}
       WHERE quotation_id = ${id}
    `.execute(trx);

    const customer = (await sql<any>`SELECT name, phone FROM customers WHERE customer_id = ${quotation.customer_id}`.execute(trx)).rows[0];
    if (customer?.phone) {
      await queueMessage(trx, {
        to_phone: customer.phone, customer_id: quotation.customer_id, message_type: 'QUOTATION',
        body: `Your quotation ${quotation.quotation_number} has been approved.${reserve ? ` Stock is held for ${holdDays} day(s).` : ''}`,
      });
    }
    return { ok: true, stock_reserved: reserve, hold_days: reserve ? holdDays : null };
  }));

  /** Releases a reservation early, or when a quote is cancelled. */
  app.post('/:id/release-reservation', guarded('approve_quotation', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id}`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Quotation not found.');
    if (!quotation.stock_reserved) return { ok: true, message: 'This quotation is not holding any stock.' };

    await sql`
      UPDATE branch_stock bs SET reserved_qty = GREATEST(bs.reserved_qty - ql.qty_base_unit, 0), updated_at = now()
        FROM quotation_lines ql
       WHERE ql.quotation_id = ${id} AND bs.product_id = ql.product_id AND bs.branch_id = ${quotation.branch_id}
    `.execute(trx);
    await sql`UPDATE quotations SET stock_reserved = FALSE, reservation_hold_until = NULL WHERE quotation_id = ${id}`.execute(trx);
    return { ok: true };
  }));

  /**
   * Conversion. The reservation is released first so the sale draws on ordinary
   * available stock — otherwise the quantity would be double-counted, once as
   * reserved and once as sold.
   */
  app.post('/:id/convert', guarded('convert_quotation', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const quotation = (await sql<any>`
      SELECT * FROM quotations WHERE quotation_id = ${id} FOR UPDATE
    `.execute(trx)).rows[0];
    if (!quotation) throw notFound('Quotation not found.');
    // Only an approved quote becomes a tax invoice. Letting a DRAFT or an EXPIRED
    // one through meant an unapproved price, or one the customer was told had
    // lapsed, could be billed as a live GST document.
    if (quotation.status === 'CONVERTED') throw badRequest('This quotation has already been converted to an invoice.');
    if (quotation.status === 'CANCELLED') throw badRequest('This quotation was cancelled.');
    if (quotation.status === 'EXPIRED') throw badRequest('This quotation has expired. Raise a fresh one at current prices.');
    if (quotation.status !== 'APPROVED') {
      throw badRequest('Approve the quotation before converting it — that is the point at which the price is agreed.');
    }

    const lines = (await sql<any>`
      SELECT ql.*, p.name AS product_name, p.hsn_code,
             COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct,
             COALESCE(pu.product_unit_id, NULL) AS default_unit_id
        FROM quotation_lines ql
        JOIN products p ON p.product_id = ql.product_id
        LEFT JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code
                              AND daterange(effective_from, effective_to, '[)') @> CURRENT_DATE LIMIT 1) htr ON TRUE
       WHERE ql.quotation_id = ${id}
    `.execute(trx)).rows;
    if (!lines.length) throw badRequest('This quotation has no lines to convert.');

    if (quotation.stock_reserved) {
      await sql`
        UPDATE branch_stock bs SET reserved_qty = GREATEST(bs.reserved_qty - ql.qty_base_unit, 0), updated_at = now()
          FROM quotation_lines ql
         WHERE ql.quotation_id = ${id} AND bs.product_id = ql.product_id AND bs.branch_id = ${quotation.branch_id}
      `.execute(trx);
    }

    const branch = (await sql<any>`SELECT * FROM branches WHERE branch_id = ${quotation.branch_id}`.execute(trx)).rows[0];
    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${quotation.customer_id}`.execute(trx)).rows[0];

    // 12.1.1 — a contractor in another state is an interstate supply and attracts
    // IGST. Hard-coding the branch's own state here billed CGST+SGST on every
    // conversion, which is the wrong tax on the wrong return.
    const placeOfSupply = optionalStr(body.place_of_supply_state_code, 'place_of_supply_state_code', { max: 4 })
      ?? branch.state_code;
    const interstate = placeOfSupply !== branch.state_code;

    const computed = lines.map((l: any) => computeLine({
      qty_in_sale_unit: Number(l.qty_base_unit), multiplier_to_base: 1,
      rate_per_base_unit: Number(l.rate), gst_rate_pct: Number(l.gst_rate_pct),
      price_type: quotation.price_type,
      interstate,
    }));
    const totals = totalInvoice(computed);

    // 6.1 — a conversion is a sale, so the credit limit applies exactly as it does
    // at the counter. Booking the whole invoice to the ledger without checking, as
    // this used to, was a hole straight through the credit control.
    const payOnCredit = Boolean(customer?.credit_allowed);
    if (payOnCredit) {
      // A read-only look, purely to fail early with a clear message. The binding
      // check happens under the row lock when the ledger is written below.
      const projected = round2(await creditBalance(trx, quotation.customer_id) + totals.payable);
      if (projected > Number(customer.credit_limit)) {
        throw conflict(`Converting this quote would take ${customer.name} to ₹${projected.toFixed(2)} against a credit limit of ₹${Number(customer.credit_limit).toFixed(2)}. Take payment, or raise the limit first.`);
      }
    }

    const invoiceNumber = await nextNumber(trx, quotation.branch_id, 'INVOICE');
    const invoice = (await sql<any>`
      INSERT INTO invoices (invoice_number, branch_id, customer_id, invoice_type, status,
                            subtotal, cgst_total, sgst_total, igst_total, grand_total,
                            place_of_supply_state_code, device_created_at, created_by)
      VALUES (${invoiceNumber}, ${quotation.branch_id}, ${quotation.customer_id}, 'GST', 'FINAL',
              ${totals.subtotal}, ${totals.cgst_total}, ${totals.sgst_total}, ${totals.igst_total},
              ${totals.grand_total}, ${placeOfSupply}, now(), ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], c = computed[i];
      await sql`
        INSERT INTO invoice_lines (invoice_id, product_id, product_unit_id, qty_in_sale_unit, base_unit_qty,
                                   price_type, rate_locked_at_scan, taxable_value,
                                   cgst_amount, sgst_amount, igst_amount)
        VALUES (${invoice.invoice_id}, ${l.product_id}, ${l.default_unit_id}, ${l.qty_base_unit}, ${c.base_unit_qty},
                ${quotation.price_type}::price_type, ${l.rate}, ${c.taxable_value},
                ${c.cgst_amount}, ${c.sgst_amount}, ${c.igst_amount})
      `.execute(trx);

      // The UPDATE matches nothing for a product this branch has never stocked. On
      // its own that left the ledger recording a movement that branch_stock never
      // saw — the two would disagree permanently.
      const moved = await sql<any>`
        UPDATE branch_stock SET base_unit_qty = base_unit_qty - ${c.base_unit_qty}, updated_at = now()
         WHERE branch_id = ${quotation.branch_id} AND product_id = ${l.product_id}
        RETURNING product_id
      `.execute(trx);
      if (!moved.rows.length) {
        await sql`
          INSERT INTO branch_stock (branch_id, product_id, base_unit_qty)
          VALUES (${quotation.branch_id}, ${l.product_id}, ${-c.base_unit_qty})
        `.execute(trx);
      }
      await sql`
        INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change, ref_table, ref_id, created_by)
        VALUES (${quotation.branch_id}, ${l.product_id}, 'SALE', ${-c.base_unit_qty}, 'invoices', ${invoice.invoice_id}, ${session.user_id})
      `.execute(trx);
    }

    // A converted B2B quote goes to the customer's account when they hold credit,
    // which is how contractor business normally settles; otherwise it is payable
    // at the counter.
    const payMethod = payOnCredit ? 'CREDIT' : 'CASH';
    await sql`
      INSERT INTO invoice_payments (invoice_id, method, amount)
      VALUES (${invoice.invoice_id}, ${payMethod}::payment_method, ${totals.payable})
    `.execute(trx);

    if (payOnCredit) {
      const posted = await postCredit(trx, {
        customerId: quotation.customer_id, branchId: quotation.branch_id,
        entryType: 'SALE_ON_CREDIT', amount: totals.payable,
        refTable: 'invoices', refId: invoice.invoice_id, enforceLimit: true,
      });
      if (posted.over_limit) {
        throw conflict(`Converting this quote would take ${customer.name} to ₹${posted.balance_after.toFixed(2)} against a credit limit of ₹${posted.credit_limit.toFixed(2)}. Take payment, or raise the limit first.`);
      }
    }

    await sql`
      UPDATE quotations SET status = 'CONVERTED', stock_reserved = FALSE,
             reservation_hold_until = NULL, converted_invoice_id = ${invoice.invoice_id}
       WHERE quotation_id = ${id}
    `.execute(trx);

    return {
      ok: true, invoice_id: invoice.invoice_id, invoice_number: invoiceNumber, totals,
      billed_to: payOnCredit ? 'CREDIT' : 'CASH',
      place_of_supply: placeOfSupply,
    };
  }));

  app.post('/:id/cancel', guarded('approve_quotation', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id}`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Quotation not found.');
    if (quotation.status === 'CONVERTED') throw badRequest('A converted quotation cannot be cancelled.');

    if (quotation.stock_reserved) {
      await sql`
        UPDATE branch_stock bs SET reserved_qty = GREATEST(bs.reserved_qty - ql.qty_base_unit, 0), updated_at = now()
          FROM quotation_lines ql
         WHERE ql.quotation_id = ${id} AND bs.product_id = ql.product_id AND bs.branch_id = ${quotation.branch_id}
      `.execute(trx);
    }
    await sql`UPDATE quotations SET status = 'CANCELLED', stock_reserved = FALSE WHERE quotation_id = ${id}`.execute(trx);
    return { ok: true };
  }));

  // ── Delivery challans (Section 5) ─────────────────────────────────────────
  app.get('/challans', guarded('view_quotations', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT dc.*, c.name AS customer_name, b.name AS branch_name, q.quotation_number,
             (SELECT count(*) FROM delivery_challan_lines WHERE challan_id = dc.challan_id) AS line_count
        FROM delivery_challans dc
        JOIN customers c ON c.customer_id = dc.customer_id
        JOIN branches b ON b.branch_id = dc.branch_id
        LEFT JOIN quotations q ON q.quotation_id = dc.quotation_id
       WHERE 1=1 ${branchId ? sql`AND dc.branch_id = ${branchId}` : sql``}
       ORDER BY dc.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.post('/challans', guarded('create_quotation', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const customerId = uuid(body.customer_id, 'Customer');
    const lines = arrayOf(body.lines, 'lines', (l) => ({
      product_id: uuid(l.product_id, 'lines[].product_id'),
      qty_base_unit: num(l.qty_base_unit, 'lines[].qty_base_unit', { min: 0.0001 }),
    }));

    const challanNumber = await nextNumber(trx, branchId, 'CHALLAN');
    const challan = (await sql<any>`
      INSERT INTO delivery_challans (challan_number, quotation_id, branch_id, customer_id, status)
      VALUES (${challanNumber}, ${optionalUuid(body.quotation_id, 'quotation_id')}, ${branchId}, ${customerId}, 'DELIVERED')
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      await sql`
        INSERT INTO delivery_challan_lines (challan_id, product_id, qty_base_unit)
        VALUES (${challan.challan_id}, ${l.product_id}, ${l.qty_base_unit})
      `.execute(trx);
    }
    // A challan is a delivery note, not a tax invoice — it does not move stock or
    // create a tax liability. The invoice that follows does both.
    return challan;
  }));
}
