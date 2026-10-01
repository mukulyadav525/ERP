// ============================================================================
// Section 5 — Estimates / Quotations & B2B / Contractor Pricing (spec §21)
//   * quotes are tax-EXCLUSIVE by default (2.8), unlike retail counter sales
//   * an estimate may be quoted without GST (an approximate cash estimate)
//   * lines are quoted in sale units (BOX, 100 G) with a per-line discount
//   * 5.1 approving a quote can hold stock, if the owner has turned that on,
//     with a hold period after which the reservation releases itself
//   * converting a quote opens a DRAFT bill through the ordinary billing path,
//     so every billing rule applies and nothing is booked twice
//   * delivery challans cover goods sent to site ahead of the final bill
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, optionalStr, num, oneOf, bool,
  writeBranch, resolveBranchScope, limit as clampLimit, arrayOf,
} from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { computeLine, totalInvoice, round2 } from '../../lib/tax.js';
import { nextNumber } from '../../lib/numbering.js';
import { buildEstimatePdf } from '../../lib/pdf/index.js';
import { queueMessage } from '../../lib/whatsapp.js';
import { audit } from '../../lib/audit.js';
import type { Tx } from '../../lib/db.js';
import { assertQuantityAllowed, optionalStateCode } from '../../lib/units.js';
import { createDraftFromQuotation } from '../billing/index.js';
import { addDays, businessToday } from '../../lib/dates.js';

const PRICE_TYPES = ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every quotation endpoint first checks the module is switched on (Section 5). */
async function assertModuleEnabled(trx: Tx, branchId: string | null) {
  const settings = await loadSettings(trx, branchId);
  if (!settings.enable_quotations_module) {
    throw forbidden('Estimates are switched off. Turn on "Quotations module" in Admin → Settings.');
  }
  return settings;
}

function optionalDate(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(new Date(s).getTime())) throw badRequest(`${field} must be a date.`);
  return s;
}

/** The lines of an estimate, with the sale unit and the GST rate in force today. */
async function quotationLines(trx: Tx, quotationIds: string[]) {
  if (!quotationIds.length) return [];
  return (await sql<any>`
    SELECT ql.*, p.name AS product_name, p.sku, p.base_unit, p.hsn_code,
           COALESCE(pu.unit_label, p.base_unit) AS unit_label,
           COALESCE(u.print_label, bu.print_label) AS unit_print_label, u.dimension AS unit_dimension,
           bu.print_label AS base_unit_label,
           COALESCE(pu.multiplier_to_base, 1) AS multiplier_to_base,
           COALESCE(ql.qty_in_sale_unit, ql.qty_base_unit) AS qty_display,
           COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct
      FROM quotation_lines ql
      JOIN products p ON p.product_id = ql.product_id
      JOIN units bu ON bu.unit_code = p.base_unit
      LEFT JOIN product_units pu ON pu.product_unit_id = ql.product_unit_id
      LEFT JOIN units u ON u.unit_code = pu.unit_label
      LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                          WHERE hsn_code = p.hsn_code
                            AND daterange(effective_from, effective_to, '[)') @> CURRENT_DATE LIMIT 1) htr ON TRUE
     WHERE ql.quotation_id = ANY(${quotationIds}::uuid[])
     ORDER BY ql.sort_order, ql.line_id
  `.execute(trx)).rows;
}

/** Prices an estimate with the same tax engine a bill uses (3.1.1), so the quote
 *  a customer is given and the bill it becomes cannot disagree about arithmetic. */
function priceQuotation(q: any, lines: any[]) {
  const interstate = Boolean(q.place_of_supply_state_code && q.branch_state_code
    && q.place_of_supply_state_code !== q.branch_state_code);
  const computed = lines.map((l: any) => computeLine({
    qty_in_sale_unit: Number(l.qty_display),
    multiplier_to_base: Number(l.qty_in_sale_unit === null || l.qty_in_sale_unit === undefined ? 1 : l.multiplier_to_base),
    rate_per_base_unit: Number(l.rate),
    gst_rate_pct: q.with_gst === false ? 0 : Number(l.gst_rate_pct),
    price_type: q.price_type,
    discount_amount: Number(l.discount_amount ?? 0),
    interstate,
  }));
  const totals = totalInvoice(computed);
  const docLines = lines.map((l: any, i: number) => ({
    ...l,
    qty_in_sale_unit: Number(l.qty_display),
    rate_per_sale_unit: round2(Number(l.rate) * (l.qty_in_sale_unit === null ? 1 : Number(l.multiplier_to_base))),
    gst_rate_pct: q.with_gst === false ? 0 : Number(l.gst_rate_pct),
    discount_amount: computed[i].discount_amount,
    taxable_value: computed[i].taxable_value,
    cgst_amount: computed[i].cgst_amount,
    sgst_amount: computed[i].sgst_amount,
    igst_amount: computed[i].igst_amount,
    line_total: computed[i].line_total,
  }));
  return { totals, lines: docLines, interstate };
}

/**
 * Parses and prices the requested lines. Quantities are in the chosen sale unit;
 * a rate, when given, is per that unit (what the person quoting types); with no
 * rate, the catalog price is used on the estimate's own tax basis.
 */
async function prepareLines(trx: Tx, rawLines: unknown, opts: { branchId: string; priceType: string }) {
  const lines = arrayOf(rawLines, 'Items', (l) => l, { min: 1, max: 200 });
  const out: any[] = [];
  for (const [i, l] of lines.entries()) {
    const label = `Item ${i + 1}`;
    const productId = uuid(l.product_id, label);
    const productUnitId = optionalUuid(l.product_unit_id, 'Unit');
    const p = (await sql<any>`
      SELECT p.product_id, p.name, p.is_active, p.base_unit, p.default_price_type,
             pu.product_unit_id, COALESCE(pu.multiplier_to_base, 1) AS multiplier,
             u.allows_fraction, u.name AS unit_name, u.print_label,
             pp.selling_price, COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct
        FROM products p
        LEFT JOIN product_units pu ON pu.product_id = p.product_id
             AND (pu.product_unit_id = ${productUnitId} OR (${productUnitId}::uuid IS NULL AND pu.unit_label = p.base_unit))
        LEFT JOIN units u ON u.unit_code = COALESCE(pu.unit_label, p.base_unit)
        LEFT JOIN LATERAL (SELECT selling_price FROM product_prices
                            WHERE product_id = p.product_id AND effective_to IS NULL
                            ORDER BY (branch_id = ${opts.branchId}) DESC NULLS LAST LIMIT 1) pp ON TRUE
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
       WHERE p.product_id = ${productId}
    `.execute(trx)).rows[0];
    if (!p || !p.is_active) throw badRequest(`${label}: that product is not available.`);
    if (productUnitId && !p.product_unit_id) throw badRequest(`${label}: that unit is not set up for "${p.name}".`);
    const qty = num(l.qty ?? l.qty_in_sale_unit ?? l.qty_base_unit, `Quantity for "${p.name}"`, { min: 0.0001, max: 1e9 });
    assertQuantityAllowed(qty, { allows_fraction: p.allows_fraction ?? true, name: p.unit_name ?? p.base_unit, print_label: p.print_label ?? p.base_unit }, p.name);
    const multiplier = Number(p.multiplier);

    let ratePerBase: number;
    if (l.unit_rate !== undefined && l.unit_rate !== null && l.unit_rate !== '') {
      ratePerBase = num(l.unit_rate, `Rate for "${p.name}"`, { min: 0, max: 10_000_000 }) / multiplier;
    } else if (l.rate !== undefined && l.rate !== null && l.rate !== '') {
      ratePerBase = num(l.rate, `Rate for "${p.name}"`, { min: 0, max: 10_000_000 });
    } else {
      const catalog = Number(p.selling_price ?? 0);
      if (!catalog) throw badRequest(`"${p.name}" has no price on file. Set a catalog price or enter a rate.`);
      const g = Number(p.gst_rate_pct);
      // The catalog price restated on the estimate's basis (a tax-inclusive
      // shelf price quoted tax-exclusive is the price without its GST).
      ratePerBase = opts.priceType === p.default_price_type || g === 0 ? catalog
        : opts.priceType === 'TAX_EXCLUSIVE' ? catalog / (1 + g / 100) : catalog * (1 + g / 100);
    }
    const discount = l.discount_amount === undefined || l.discount_amount === null || l.discount_amount === ''
      ? 0 : num(l.discount_amount, `Discount on "${p.name}"`, { min: 0, max: 10_000_000 });
    const gross = round2(qty * multiplier * ratePerBase);
    if (discount > gross + 0.001) throw badRequest(`The discount on "${p.name}" is more than its value.`);
    out.push({
      product_id: productId, product_unit_id: p.product_unit_id, qty_in_sale_unit: qty,
      qty_base_unit: Math.round(qty * multiplier * 10000) / 10000,
      rate: Math.round(ratePerBase * 10000) / 10000, discount_amount: discount, sort_order: i + 1,
    });
  }
  return out;
}

async function writeLines(trx: Tx, quotationId: string, lines: any[]) {
  await sql`DELETE FROM quotation_lines WHERE quotation_id = ${quotationId}`.execute(trx);
  for (const l of lines) {
    await sql`
      INSERT INTO quotation_lines (quotation_id, product_id, product_unit_id, qty_in_sale_unit, qty_base_unit,
                                   rate, discount_amount, sort_order)
      VALUES (${quotationId}, ${l.product_id}, ${l.product_unit_id}, ${l.qty_in_sale_unit}, ${l.qty_base_unit},
              ${l.rate}, ${l.discount_amount}, ${l.sort_order})
    `.execute(trx);
  }
}

async function releaseReservation(trx: Tx, q: any) {
  if (!q.stock_reserved) return;
  // Summed per product first: UPDATE ... FROM applies only ONE joined row per
  // target row, so two lines of the same product would release only one of them.
  await sql`
    UPDATE branch_stock bs SET reserved_qty = GREATEST(bs.reserved_qty - ql.qty, 0), updated_at = now()
      FROM (SELECT product_id, SUM(qty_base_unit) AS qty FROM quotation_lines
             WHERE quotation_id = ${q.quotation_id} GROUP BY product_id) ql
     WHERE bs.product_id = ql.product_id AND bs.branch_id = ${q.branch_id}
  `.execute(trx);
  await sql`UPDATE quotations SET stock_reserved = FALSE, reservation_hold_until = NULL WHERE quotation_id = ${q.quotation_id}`.execute(trx);
}

const HEADER_SQL = sql`
  SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp,
         c.gstin AS customer_gstin, c.customer_type,
         c.address AS customer_address, c.company_name AS customer_company,
         c.state AS customer_state, c.state_code AS customer_state_code,
         b.name AS branch_name, b.gstin AS branch_gstin, b.address AS branch_address,
         b.phone AS branch_phone, b.state_code AS branch_state_code,
         u.full_name AS created_by_name, i.invoice_number AS converted_invoice_number,
         (SELECT d.invoice_id FROM invoices d WHERE d.source_quotation_id = q.quotation_id AND d.status = 'DRAFT'
           ORDER BY d.updated_at DESC LIMIT 1) AS open_draft_id
    FROM quotations q
    JOIN customers c ON c.customer_id = q.customer_id
    JOIN branches b ON b.branch_id = q.branch_id
    LEFT JOIN users u ON u.user_id = q.created_by
    LEFT JOIN invoices i ON i.invoice_id = q.converted_invoice_id`;

export default async function quotationsRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_quotations', async ({ session, db: trx, req }) => {
    await assertModuleEnabled(trx, session.branch_id);
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const search = q.q?.trim().slice(0, 60);
    const rows = (await sql<any>`
      ${HEADER_SQL}
       WHERE 1=1 ${branchId ? sql`AND q.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND q.status = ${oneOf(q.status, 'status', ['DRAFT', 'APPROVED', 'CONVERTED', 'EXPIRED', 'CANCELLED'] as const)}::quotation_status` : sql``}
         ${q.customer_id ? sql`AND q.customer_id = ${uuid(q.customer_id, 'customer_id')}` : sql``}
         ${search ? sql`AND (q.quotation_number ILIKE ${'%' + search + '%'} OR c.name ILIKE ${'%' + search + '%'} OR c.phone ILIKE ${'%' + search + '%'})` : sql``}
       ORDER BY q.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
    // One query for every listed estimate's lines, priced in memory.
    const allLines = await quotationLines(trx, rows.map((r: any) => r.quotation_id));
    return rows.map((r: any) => {
      const lines = allLines.filter((l: any) => l.quotation_id === r.quotation_id);
      const priced = priceQuotation(r, lines);
      return {
        ...r, line_count: lines.length,
        total_value: priced.totals.grand_total, subtotal: priced.totals.subtotal, tax_total: priced.totals.tax_total,
        is_expired: r.valid_until ? r.valid_until < businessToday() : false,
      };
    });
  }));

  app.get('/:id', guarded('view_quotations', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`${HEADER_SQL} WHERE q.quotation_id = ${id}`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Estimate not found.');
    const lines = await quotationLines(trx, [id]);
    const priced = priceQuotation(quotation, lines);
    return { ...quotation, lines: priced.lines, totals: priced.totals, interstate: priced.interstate };
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
    const quotation = (await sql<any>`${HEADER_SQL} WHERE q.quotation_id = ${id}`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Estimate not found.');
    const lines = await quotationLines(trx, [id]);
    const priced = priceQuotation(quotation, lines);

    const pdf = await buildEstimatePdf(trx, {
      ...quotation,
      subtotal: priced.totals.subtotal,
      discount_total: priced.totals.discount_total,
      cgst_total: priced.totals.cgst_total,
      sgst_total: priced.totals.sgst_total,
      igst_total: priced.totals.igst_total,
      grand_total: priced.totals.grand_total,
      with_gst: quotation.with_gst !== false && priced.totals.tax_total > 0,
      valid_until: quotation.valid_until ?? quotation.reservation_hold_until }, priced.lines);

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition',
        `inline; filename="Estimate-${String(quotation.quotation_number ?? id).replace(/[^\w.-]/g, '_')}.pdf"`)
      .send(pdf);
  }));

  app.post('/', guarded('create_quotation', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    await assertModuleEnabled(trx, branchId);

    const customerId = uuid(body.customer_id, 'Customer');
    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${customerId}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');
    if (!customer.is_active) throw badRequest(`${customer.name}'s account is inactive.`);
    const priceType = oneOf(body.price_type ?? 'TAX_EXCLUSIVE', 'Price type', PRICE_TYPES);
    const lines = await prepareLines(trx, body.lines, { branchId, priceType });
    const validUntil = optionalDate(body.valid_until, 'Valid until')
      ?? addDays(businessToday(), 15);
    if (validUntil < businessToday()) throw badRequest('The validity date is already in the past.');
    const branch = (await sql<any>`SELECT state_code FROM branches WHERE branch_id = ${branchId}`.execute(trx)).rows[0];

    const quotationNumber = await nextNumber(trx, branchId, 'QUOTATION');
    const quotation = (await sql<any>`
      INSERT INTO quotations (quotation_number, branch_id, customer_id, status, price_type, with_gst,
                              place_of_supply_state_code, valid_until, notes, terms, created_by)
      VALUES (${quotationNumber}, ${branchId}, ${customerId}, 'DRAFT', ${priceType}::price_type,
              ${bool(body.with_gst, 'with_gst', true)},
              ${optionalStateCode(body.place_of_supply_state_code, 'Place of supply') ?? customer.state_code ?? branch?.state_code ?? null},
              ${validUntil}, ${optionalStr(body.notes, 'Notes', { max: 1000 })},
              ${optionalStr(body.terms, 'Terms', { max: 2000 })}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];
    await writeLines(trx, quotation.quotation_id, lines);
    await audit(trx, session, 'QUOTATION_CREATED', 'quotations', quotation.quotation_id,
      { after: { quotation_number: quotationNumber, customer: customer.name, lines: lines.length } }, { branchId });
    return quotation;
  }));

  /** Edit an estimate. An approved one goes back to DRAFT (and gives up any stock
   *  it was holding), because the price the customer agreed to has changed. */
  app.put('/:id', guarded('create_quotation', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const q = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!q) throw notFound('Estimate not found.');
    if (!['DRAFT', 'APPROVED', 'EXPIRED'].includes(q.status)) {
      throw badRequest(`This estimate is ${q.status.toLowerCase()} and can no longer be edited.`);
    }
    const open = (await sql<any>`SELECT 1 FROM invoices WHERE source_quotation_id = ${id} AND status = 'DRAFT'`.execute(trx)).rows[0];
    if (open) throw conflict('A bill is already being prepared from this estimate. Finish or discard that draft first.');
    await releaseReservation(trx, q);

    const priceType = body.price_type === undefined ? q.price_type : oneOf(body.price_type, 'Price type', PRICE_TYPES);
    if (body.lines !== undefined) {
      await writeLines(trx, id, await prepareLines(trx, body.lines, { branchId: q.branch_id, priceType }));
    }
    const validUntil = body.valid_until === undefined ? q.valid_until : optionalDate(body.valid_until, 'Valid until');
    await sql`
      UPDATE quotations SET
        status = 'DRAFT', price_type = ${priceType}::price_type,
        with_gst = ${body.with_gst === undefined ? q.with_gst : bool(body.with_gst, 'with_gst')},
        customer_id = ${body.customer_id === undefined ? q.customer_id : uuid(body.customer_id, 'Customer')},
        valid_until = ${validUntil},
        notes = ${body.notes === undefined ? q.notes : optionalStr(body.notes, 'Notes', { max: 1000 })},
        terms = ${body.terms === undefined ? q.terms : optionalStr(body.terms, 'Terms', { max: 2000 })},
        updated_at = now()
      WHERE quotation_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'QUOTATION_UPDATED', 'quotations', id,
      { before: { status: q.status }, after: { edited: Object.keys(body) } }, { branchId: q.branch_id });
    return { ok: true };
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

    const quotation = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Estimate not found.');
    if (quotation.status !== 'DRAFT') throw badRequest(`This estimate is ${quotation.status.toLowerCase()} and cannot be approved again.`);

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
        SELECT ql.product_id, SUM(ql.qty_base_unit) AS qty, MIN(p.name) AS product_name
          FROM quotation_lines ql JOIN products p ON p.product_id = ql.product_id
         WHERE ql.quotation_id = ${id} GROUP BY ql.product_id ORDER BY ql.product_id
      `.execute(trx)).rows;

      for (const l of lines) {
        const stock = (await sql<any>`
          SELECT base_unit_qty, reserved_qty FROM branch_stock
           WHERE branch_id = ${quotation.branch_id} AND product_id = ${l.product_id} FOR UPDATE
        `.execute(trx)).rows[0];
        const available = Number(stock?.base_unit_qty ?? 0) - Number(stock?.reserved_qty ?? 0);
        if (available < Number(l.qty)) {
          throw conflict(`Cannot reserve ${Number(l.qty)} of "${l.product_name}" — only ${Math.max(available, 0)} is available. Approve without a reservation, or reduce the quantity.`);
        }
        await sql`
          UPDATE branch_stock SET reserved_qty = reserved_qty + ${l.qty}, updated_at = now()
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
      UPDATE quotations SET status = 'APPROVED', stock_reserved = ${reserve}, updated_at = now(),
             reservation_hold_until = ${reserve ? sql`now() + make_interval(days => ${holdDays})` : null}
       WHERE quotation_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'QUOTATION_APPROVED', 'quotations', id,
      { after: { stock_reserved: reserve, hold_days: reserve ? holdDays : null } }, { branchId: quotation.branch_id });

    return { ok: true, stock_reserved: reserve, hold_days: reserve ? holdDays : null };
  }));

  /** Releases a reservation early. */
  app.post('/:id/release-reservation', guarded('approve_quotation', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Estimate not found.');
    if (!quotation.stock_reserved) return { ok: true, message: 'This estimate is not holding any stock.' };
    await releaseReservation(trx, quotation);
    return { ok: true };
  }));

  /**
   * Conversion opens the estimate as a DRAFT bill (see createDraftFromQuotation):
   * review, payment and finalisation follow the ordinary billing path. The
   * estimate is marked converted when that bill is finalised.
   */
  app.post('/:id/convert', guarded('convert_quotation', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const q = (await sql<any>`SELECT branch_id FROM quotations WHERE quotation_id = ${id}`.execute(trx)).rows[0];
    if (!q) throw notFound('Estimate not found.');
    await assertModuleEnabled(trx, q.branch_id);
    const draft = await createDraftFromQuotation(trx, session, id);
    return {
      ok: true, draft_invoice_id: draft.invoice_id, draft,
      message: 'The estimate is open as a draft bill. Review it, take payment and finalise it on the Billing screen.',
    };
  }));

  app.post('/:id/cancel', guarded('approve_quotation', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`SELECT * FROM quotations WHERE quotation_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Estimate not found.');
    if (quotation.status === 'CONVERTED') throw badRequest('A billed estimate cannot be cancelled.');
    if (quotation.status === 'CANCELLED') throw badRequest('This estimate is already cancelled.');
    await releaseReservation(trx, quotation);
    await sql`UPDATE quotations SET status = 'CANCELLED', stock_reserved = FALSE, updated_at = now() WHERE quotation_id = ${id}`.execute(trx);
    await audit(trx, session, 'QUOTATION_CANCELLED', 'quotations', id,
      { before: { status: quotation.status } }, { branchId: quotation.branch_id });
    return { ok: true };
  }));

  /** Shares an estimate on WhatsApp through the message queue — an explicit action. */
  app.post('/:id/share', guarded('view_quotations', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'quotation_id');
    const quotation = (await sql<any>`${HEADER_SQL} WHERE q.quotation_id = ${id}`.execute(trx)).rows[0];
    if (!quotation) throw notFound('Estimate not found.');
    const phone = quotation.customer_whatsapp ?? quotation.customer_phone;
    if (!phone) throw badRequest('This customer has no phone number on file.');
    const priced = priceQuotation(quotation, await quotationLines(trx, [id]));
    await queueMessage(trx, {
      to_phone: phone, customer_id: quotation.customer_id, message_type: 'QUOTATION',
      body: `${quotation.branch_name}: estimate ${quotation.quotation_number} for ₹${priced.totals.grand_total.toFixed(2)}`
        + (quotation.valid_until ? `, valid until ${quotation.valid_until}.` : '.'),
    });
    return { ok: true, queued: true, message: 'Queued for WhatsApp. It is sent when a WhatsApp provider is configured.' };
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
    const lines = arrayOf(body.lines, 'Items', (l, i) => ({
      product_id: uuid(l.product_id, `Item ${i + 1}`),
      qty_base_unit: num(l.qty_base_unit, `Quantity (item ${i + 1})`, { min: 0.0001, max: 1e9 }),
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
