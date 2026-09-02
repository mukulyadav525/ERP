// ============================================================================
// Section 3 — Billing / POS
//
// The single most important path in the system, so the rules the requirements
// document treats as non-negotiable are all enforced here rather than trusted to
// the client:
//   2.2.1  quantities convert to base units before pricing or tax
//   3.1.1  half-up rounding per line; the invoice total is the sum of those
//   3.2    split payments
//   3.3.1  till events, not just open/close counts
//   3.4    staff discount ceiling with a manager-PIN override
//   3.5    offline sales replay idempotently via client_txn_id
//   3.5.1  a later-arriving offline sale that would oversell is flagged, not silently allowed
//   3.6    gapless invoice numbers assigned only on DRAFT -> FINAL
//   3.8    negative stock hard-blocked unless the setting says otherwise
//   3.10   line prices lock at scan time
//   6.1    credit limit enforced before a credit sale is accepted
//   11.2.1 loyalty points are earned/redeemed under the fixed refund hierarchy
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, bool, oneOf,
  writeBranch, resolveBranchScope, limit as clampLimit, arrayOf,
} from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings, canSeeCost, maskCost } from '../../lib/settings.js';
import { computeLine, totalInvoice, round2, type ComputedLine } from '../../lib/tax.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { queueMessage } from '../../lib/whatsapp.js';
import { generateInvoicePdf } from '../../lib/pdf.js';
import type { Tx } from '../../lib/db.js';
import { creditBalance, postCredit } from '../../lib/ledger.js';

const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'CREDIT', 'LOYALTY_POINTS'] as const;
const INVOICE_TYPES = ['GST', 'NON_GST'] as const;
const PRICE_TYPES = ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const;

/**
 * Consumes a single-use override grant issued by /auth/verify-override-pin.
 *
 * Accepting a manager's user id from the request body — which is what this
 * replaced — meant the "approval" was a value the client already knew and could
 * reuse forever. A grant is bound to the purpose, the branch and the cashier who
 * asked for it, expires in minutes, and cannot be spent twice.
 */
async function consumeOverride(
  trx: Tx, approvalId: string | null, purpose: string, branchId: string, requestedBy: string,
): Promise<{ approver_id: string; approver_name: string } | null> {
  if (!approvalId) return null;
  const res = await sql<{ ok: boolean; approver_id: string | null; approver_name: string | null }>`
    SELECT * FROM auth_consume_override(${approvalId}, ${purpose}, ${branchId}, ${requestedBy})
  `.execute(trx);
  const row = res.rows[0];
  if (!row?.ok) return null;
  return { approver_id: row.approver_id!, approver_name: row.approver_name! };
}

export default async function billingRoutes(app: FastifyInstance) {
  // ── Invoice list ──────────────────────────────────────────────────────────
  app.get('/invoices', guarded('view_billing', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const rows = await sql<any>`
      SELECT i.invoice_id, i.invoice_number, i.branch_id, b.name AS branch_name, i.invoice_type,
             i.status, i.subtotal, i.discount_total, i.cgst_total, i.sgst_total, i.igst_total,
             i.grand_total, i.round_off, i.server_received_at, i.is_offline_conflict,
             c.name AS customer_name, c.phone AS customer_phone,
             u.full_name AS created_by_name,
             (SELECT string_agg(DISTINCT ip.method::text, ', ') FROM invoice_payments ip
               WHERE ip.invoice_id = i.invoice_id) AS payment_methods
        FROM invoices i
        JOIN branches b ON b.branch_id = i.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN users u ON u.user_id = i.created_by
       WHERE 1=1
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND i.status = ${oneOf(q.status, 'status', ['DRAFT', 'FINAL', 'VOID'] as const)}::invoice_status` : sql``}
         ${q.customer_id ? sql`AND i.customer_id = ${uuid(q.customer_id, 'customer_id')}` : sql``}
         ${q.from ? sql`AND i.server_received_at >= ${q.from}::timestamptz` : sql``}
         ${q.to ? sql`AND i.server_received_at < (${q.to}::date + 1)` : sql``}
         ${q.q ? sql`AND (i.invoice_number ILIKE ${'%' + q.q + '%'} OR c.name ILIKE ${'%' + q.q + '%'} OR c.phone ILIKE ${'%' + q.q + '%'})` : sql``}
       ORDER BY i.server_received_at DESC
       LIMIT ${clampLimit(q.limit, 50, 500)} OFFSET ${Math.max(Number(q.offset) || 0, 0)}
    `.execute(trx);
    return rows.rows;
  }));

  app.get('/invoices/:id', guarded('view_billing', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'invoice_id');
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);

    const invoice = (await sql<any>`
      SELECT i.*, b.name AS branch_name, b.address AS branch_address, b.gstin AS branch_gstin,
             b.state_code AS branch_state_code, b.phone AS branch_phone,
             c.name AS customer_name, c.phone AS customer_phone, c.gstin AS customer_gstin,
             u.full_name AS created_by_name, eu.full_name AS sold_by_name
        FROM invoices i
        JOIN branches b ON b.branch_id = i.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN users u ON u.user_id = i.created_by
        LEFT JOIN employees e ON e.employee_id = i.sold_by_employee_id
        LEFT JOIN users eu ON eu.user_id = e.user_id
       WHERE i.invoice_id = ${id}
    `.execute(trx)).rows[0];
    if (!invoice) throw notFound('Invoice not found.');

    const [lines, payments, returns] = await Promise.all([
      sql<any>`
        SELECT il.*, p.name AS product_name, p.sku, p.base_unit, pu.unit_label,
               pu.multiplier_to_base, tr.base_shade, tr.tint_formula
          FROM invoice_lines il
          JOIN products p ON p.product_id = il.product_id
          LEFT JOIN product_units pu ON pu.product_unit_id = il.product_unit_id
          LEFT JOIN paint_tint_records tr ON tr.invoice_line_id = il.line_id
         WHERE il.invoice_id = ${id} ORDER BY il.line_id
      `.execute(trx),
      sql<any>`SELECT * FROM invoice_payments WHERE invoice_id = ${id}`.execute(trx),
      sql<any>`SELECT r.return_id, r.created_at, cn.credit_note_number, cn.total_amount
                 FROM sales_returns r LEFT JOIN credit_notes cn ON cn.credit_note_id = r.credit_note_id
                WHERE r.invoice_id = ${id}`.execute(trx),
    ]);

    return {
      ...invoice,
      lines: maskCost(lines.rows, showCost, { keepRate: true }),
      payments: payments.rows,
      returns: returns.rows,
    };
  }));

  // ── Invoice PDF (3.6 printed + WhatsApp PDF) ──────────────────────────────
  app.get('/invoices/:id/pdf', guarded('view_billing', async ({ db: trx, req, reply }) => {
    const id = uuid((req.params as any).id, 'invoice_id');
    const invoice = (await sql<any>`
      SELECT i.*, b.name AS branch_name, b.address AS branch_address, b.gstin AS branch_gstin,
             b.phone AS branch_phone, b.state_code AS branch_state_code,
             c.name AS customer_name, c.phone AS customer_phone, c.gstin AS customer_gstin
        FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
       WHERE i.invoice_id = ${id}
    `.execute(trx)).rows[0];
    if (!invoice) throw notFound('Invoice not found.');

    const lines = (await sql<any>`
      SELECT il.*, p.name AS product_name, p.hsn_code, COALESCE(pu.unit_label, p.base_unit::text) AS unit_label
        FROM invoice_lines il JOIN products p ON p.product_id = il.product_id
        LEFT JOIN product_units pu ON pu.product_unit_id = il.product_unit_id
       WHERE il.invoice_id = ${id} ORDER BY il.line_id
    `.execute(trx)).rows;
    const payments = (await sql<any>`SELECT * FROM invoice_payments WHERE invoice_id = ${id}`.execute(trx)).rows;

    const pdf = await generateInvoicePdf(invoice, lines, payments);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition',
      `inline; filename="Invoice-${(invoice.invoice_number ?? id).replace(/[^\w.-]/g, '_')}.pdf"`);
    return reply.send(pdf);
  }));

  // ── Create an invoice ─────────────────────────────────────────────────────
  app.post('/invoices', guarded('create_invoice', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const settings = await loadSettings(trx, branchId);

    // 3.5 — an offline till retries until the server acknowledges. If we have
    // already recorded this client transaction, return the original invoice
    // instead of billing the customer a second time.
    const clientTxnId = optionalUuid(body.client_txn_id, 'client_txn_id');
    if (clientTxnId) {
      const existing = (await sql<any>`
        SELECT invoice_id, invoice_number, grand_total, status FROM invoices WHERE client_txn_id = ${clientTxnId}
      `.execute(trx)).rows[0];
      if (existing) return { ...existing, duplicate_of_client_txn: true };
    }

    const invoiceType = oneOf(body.invoice_type ?? 'GST', 'Invoice type', INVOICE_TYPES);
    const customerId = optionalUuid(body.customer_id, 'customer_id');
    const rawLines = arrayOf(body.lines, 'lines', (l) => l, { min: 1, max: 200 });

    const branch = (await sql<any>`SELECT * FROM branches WHERE branch_id = ${branchId}`.execute(trx)).rows[0];
    if (!branch) throw notFound('Branch not found.');

    let customer: any = null;
    if (customerId) {
      customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${customerId}`.execute(trx)).rows[0];
      if (!customer) throw notFound('Customer not found.');
    }

    // 12.1.1 / 15 — interstate movement attracts IGST instead of CGST+SGST. The
    // place of supply is the customer's state when we know it, else the branch's.
    const placeOfSupply = optionalStr(body.place_of_supply_state_code, 'place_of_supply_state_code', { max: 4 })
      ?? branch.state_code;
    const interstate = placeOfSupply !== branch.state_code;

    // ── Price each line ─────────────────────────────────────────────────────
    const prepared: Array<{
      product_id: string; product_unit_id: string | null; qty_in_sale_unit: number;
      computed: ComputedLine; price_type: 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';
      rate_locked_at_scan: number; catalog_rate: number; implied_discount: number;
      batch_id: string | null;
      tint?: { base_shade?: string | null; tint_formula?: string | null } | null;
      serials: string[]; product_name: string;
    }> = [];

    for (const raw of rawLines) {
      const productId = uuid(raw.product_id, 'lines[].product_id');
      const qty = num(raw.qty_in_sale_unit, 'lines[].qty_in_sale_unit', { min: 0.0001 });
      const productUnitId = optionalUuid(raw.product_unit_id, 'lines[].product_unit_id');

      const product = (await sql<any>`
        SELECT p.product_id, p.name, p.base_unit, p.hsn_code, p.default_price_type, p.batch_tracked, p.serial_tracked,
               COALESCE(pu.multiplier_to_base, 1) AS multiplier_to_base,
               COALESCE(pu.product_unit_id, defu.product_unit_id) AS resolved_unit_id,
               pp.selling_price,
               COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct
          FROM products p
          LEFT JOIN product_units pu ON pu.product_unit_id = ${productUnitId} AND pu.product_id = p.product_id
          LEFT JOIN product_units defu ON defu.product_id = p.product_id AND defu.is_default_sale_unit
          LEFT JOIN LATERAL (
              SELECT selling_price FROM product_prices
               WHERE product_id = p.product_id AND effective_to IS NULL
               ORDER BY (branch_id = ${branchId}) DESC NULLS LAST LIMIT 1
          ) pp ON TRUE
          LEFT JOIN LATERAL (
              SELECT gst_rate_pct FROM hsn_tax_rates
               WHERE hsn_code = p.hsn_code
                 AND daterange(effective_from, effective_to, '[)') @> CURRENT_DATE
               LIMIT 1
          ) htr ON TRUE
         WHERE p.product_id = ${productId} AND p.is_active
      `.execute(trx)).rows[0];
      if (!product) throw badRequest(`One of the items is no longer in the catalog. Remove it and try again.`);

      // 3.9 — a barcode is a speed option, never mandatory, unless the owner has
      // turned that on for this branch.
      if (settings.require_barcode_at_billing && !raw.scanned_barcode) {
        const hasBarcode = (await sql<any>`SELECT 1 FROM product_barcodes WHERE product_id = ${productId} LIMIT 1`.execute(trx)).rows[0];
        if (hasBarcode) throw badRequest(`"${product.name}" must be scanned — barcode entry is required at this branch.`);
      }

      // 3.10 — the price locked into the cart at scan time wins, because a price
      // that moves under a customer mid-sale is worse than a few minutes of
      // staleness. But "the client said so" cannot be the end of it: a rate below
      // the catalog price is a discount by another name, and if it were not
      // counted as one, posting rate: 1 would bypass the 3.4 ceiling entirely and
      // leave no audit trail. The shortfall is therefore folded into the line's
      // discount for the ceiling calculation below.
      const catalogRate = Number(product.selling_price ?? 0);
      if (!catalogRate) throw badRequest(`"${product.name}" has no selling price set. Add one in the catalog first.`);
      const lockedRate = raw.rate_locked_at_scan === undefined
        ? catalogRate
        : num(raw.rate_locked_at_scan, 'lines[].rate_locked_at_scan', { min: 0 });

      const priceType = oneOf(raw.price_type ?? product.default_price_type, 'lines[].price_type', PRICE_TYPES);
      const gstRate = invoiceType === 'NON_GST' ? 0 : Number(product.gst_rate_pct);

      const computed = computeLine({
        qty_in_sale_unit: qty,
        multiplier_to_base: Number(product.multiplier_to_base),
        rate_per_base_unit: lockedRate,
        gst_rate_pct: gstRate,
        price_type: priceType,
        discount_amount: raw.discount_amount === undefined ? 0 : num(raw.discount_amount, 'lines[].discount_amount', { min: 0 }),
        interstate,
      }, Number(settings.fractional_unit_rounding_dp));

      // How much of the catalog price this line gave away, whether it was entered
      // as a discount or quietly baked into a lowered rate.
      const impliedDiscount = round2(
        Math.max(catalogRate - lockedRate, 0) * computed.base_unit_qty + computed.discount_amount,
      );

      prepared.push({
        product_id: productId,
        product_unit_id: product.resolved_unit_id ?? null,
        qty_in_sale_unit: qty,
        computed,
        price_type: priceType,
        rate_locked_at_scan: lockedRate,
        catalog_rate: catalogRate,
        implied_discount: impliedDiscount,
        batch_id: optionalUuid(raw.batch_id, 'lines[].batch_id'),
        tint: raw.tint ?? null,
        serials: Array.isArray(raw.serial_numbers) ? raw.serial_numbers.map(String) : [],
        product_name: product.name,
      });
    }

    const totals = totalInvoice(prepared.map((p) => p.computed), bool(body.apply_cash_rounding, 'apply_cash_rounding', false));

    // ── 3.4 discount ceiling ────────────────────────────────────────────────
    // Measured against the CATALOG value of the basket, not against what was
    // billed, so a lowered line rate counts the same as a typed discount.
    const catalogValue = round2(prepared.reduce(
      (sum, p) => sum + p.catalog_rate * p.computed.base_unit_qty, 0));
    const givenAway = round2(prepared.reduce((sum, p) => sum + p.implied_discount, 0));
    const discountPct = catalogValue > 0 ? (givenAway / catalogValue) * 100 : 0;
    const discountLimit = Number(settings.staff_discount_limit_pct);

    let discountApprovedBy: string | null = null;
    if (discountPct > discountLimit + 0.001) {
      // A manager or owner can exceed the limit on their own authority; anyone
      // else needs a grant from /auth/verify-override-pin.
      const selfAuthorised = session.role === 'OWNER_ADMIN' || session.role === 'BRANCH_MANAGER';
      if (selfAuthorised) {
        discountApprovedBy = session.user_id;
      } else {
        const grant = await consumeOverride(
          trx, optionalUuid(body.discount_approval_id, 'discount_approval_id'),
          'DISCOUNT', branchId, session.user_id);
        if (!grant) {
          throw forbidden(`This bill gives away ${discountPct.toFixed(1)}% against the catalog price, above the ${discountLimit}% staff limit. A manager PIN is needed to approve it.`);
        }
        discountApprovedBy = grant.approver_id;
      }
    }

    // ── Stock check (3.8 / 3.5.1) ───────────────────────────────────────────
    const conflicts: Array<{ product_id: string; product_name: string; requested: number; available: number }> = [];
    for (const line of prepared) {
      const stock = (await sql<any>`
        SELECT base_unit_qty, reserved_qty FROM branch_stock
         WHERE branch_id = ${branchId} AND product_id = ${line.product_id}
         FOR UPDATE
      `.execute(trx)).rows[0];
      const available = Number(stock?.base_unit_qty ?? 0) - Number(stock?.reserved_qty ?? 0);
      if (available < line.computed.base_unit_qty) {
        conflicts.push({
          product_id: line.product_id, product_name: line.product_name,
          requested: line.computed.base_unit_qty, available,
        });
      }
    }

    const isOfflineSale = Boolean(body.device_created_at);
    if (conflicts.length) {
      const offlineFlagged = isOfflineSale && settings.offline_sync_conflict_rule === 'FIRST_TO_CLOUD_WINS';
      // Only spend a grant if this path actually needs one — an offline sale that
      // is being flagged for human resolution does not.
      const stockGrant = offlineFlagged ? null : await consumeOverride(
        trx, optionalUuid(body.negative_stock_approval_id, 'negative_stock_approval_id'),
        'NEGATIVE_STOCK', branchId, session.user_id);

      if (offlineFlagged) {
        // 3.5.1 — the sale already happened at the counter. Voiding it behind the
        // staff's back is worse than a stock discrepancy, so it is recorded and
        // flagged for a human at that branch to resolve.
      } else if (!settings.allow_negative_stock && !stockGrant) {
        const detail = conflicts.map((c) => `${c.product_name} (asked ${c.requested}, have ${Math.max(c.available, 0)})`).join('; ');
        throw conflict(`Not enough stock: ${detail}. Adjust the quantity, or use a manager PIN to override.`);
      } else if (stockGrant) {
        await audit(trx, session, 'NEGATIVE_STOCK_OVERRIDE', 'branch_stock', null,
          { after: { conflicts, approved_by: stockGrant.approver_id, approver: stockGrant.approver_name } });
      }

      // The database trigger blocks negative stock independently of anything the
      // API decides — which is right, but it also means an approved override, or a
      // flagged offline sale, would be vetoed by it and the sale would abort before
      // its stock_conflicts row could be written. This transaction-local flag is
      // how a decision a human is entitled to make gets through. It is set only
      // after a grant has been consumed, or on the documented offline path.
      if (offlineFlagged || stockGrant || settings.allow_negative_stock) {
        await sql`SELECT set_config('erp.allow_negative_stock', 'on', true)`.execute(trx);
      }
    }

    // ── Payments (3.2 split) ────────────────────────────────────────────────
    const payments = arrayOf(body.payments ?? [], 'payments', (p) => ({
      method: oneOf(p.method, 'payments[].method', PAYMENT_METHODS),
      amount: num(p.amount, 'payments[].amount', { min: 0 }),
      ref_no: optionalStr(p.ref_no, 'payments[].ref_no', { max: 80 }),
    }), { min: 1, max: 6 });

    const paidTotal = round2(payments.reduce((s, p) => s + p.amount, 0));
    if (Math.abs(paidTotal - totals.payable) > 0.01) {
      throw badRequest(`Payments total ₹${paidTotal.toFixed(2)} but the bill is ₹${totals.payable.toFixed(2)}. They must match.`);
    }

    // ── 11.2 loyalty redemption ─────────────────────────────────────────────
    const loyaltyPayment = payments.find((p) => p.method === 'LOYALTY_POINTS');
    let pointsRedeemed = 0;
    if (loyaltyPayment && loyaltyPayment.amount > 0) {
      if (!customer) throw badRequest('Loyalty points can only be redeemed for an identified customer.');
      const pointValue = Number(settings.loyalty_point_value_rupees) || 1;
      pointsRedeemed = Math.ceil(loyaltyPayment.amount / pointValue);
      if (pointsRedeemed > Number(customer.loyalty_points_balance)) {
        throw badRequest(`${customer.name} has ${customer.loyalty_points_balance} points, worth ₹${(Number(customer.loyalty_points_balance) * pointValue).toFixed(2)}. That is less than the ₹${loyaltyPayment.amount.toFixed(2)} being redeemed.`);
      }
      // 11.2 — stacking points with a manual discount is off by default because it
      // makes the margin on a bill unpredictable.
      //
      // Measured against `givenAway`, not `totals.discount_total`. The two differ:
      // discount_total counts only what was typed into the discount box, while
      // givenAway also counts a line sold below its catalog price. The rule was
      // therefore trivially bypassable — typing a 4% discount was refused, baking
      // the identical 4% into the line rate went through, same margin either way.
      // The discount ceiling above already measures the whole giveaway; this now
      // agrees with it.
      if (!settings.allow_loyalty_discount_stacking && givenAway > 0) {
        throw badRequest('This bill already has a discount. Loyalty points and discounts cannot be combined unless "Allow loyalty + discount stacking" is turned on.');
      }
    }

    // ── 6.1 credit limit ────────────────────────────────────────────────────
    const creditPayment = payments.find((p) => p.method === 'CREDIT');
    let creditOverrideBy: string | null = null;
    if (creditPayment && creditPayment.amount > 0) {
      if (!customer) throw badRequest('A credit sale needs an identified customer.');
      if (!customer.credit_allowed) throw badRequest(`${customer.name} is not approved for credit. Take payment by cash, UPI or card.`);

      // A provisional read for the message text and for the offline cap. The
      // binding check happens under the row lock when the ledger is actually
      // written, further down — checking here alone would be racy.
      const current = await creditBalance(trx, customer.customer_id);
      const limit = Number(customer.credit_limit);
      const projected = round2(current + creditPayment.amount);

      // 6.1.1 — an offline-originated sale draws against the conservative cached
      // limit, because the till could not have confirmed the real balance.
      const isOfflineReplay = Boolean(body.device_created_at) && clientTxnId !== null;
      const effectiveLimit = isOfflineReplay && settings.allow_offline_credit_sales === 'CAP_50_PCT'
        ? limit * 0.5
        : limit;

      if (projected > effectiveLimit) {
        const creditGrant = await consumeOverride(
          trx, optionalUuid(body.credit_approval_id, 'credit_approval_id'),
          'CREDIT_LIMIT', branchId, session.user_id);
        if (!creditGrant) {
          throw conflict(`${customer.name} would go to ₹${projected.toFixed(2)} against a limit of ₹${effectiveLimit.toFixed(2)}. A manager PIN is needed to allow it.`);
        }
        creditOverrideBy = creditGrant.approver_id;
        // Over-limit sales are surfaced to the Owner rather than silently accepted.
        await audit(trx, session, 'CREDIT_LIMIT_CHANGE', 'customers', customer.customer_id,
          { after: { over_limit: true, projected_balance: projected, limit: effectiveLimit,
                     approved_by: creditGrant.approver_id, approver: creditGrant.approver_name } });
      }
    }

    // ── Write the invoice ───────────────────────────────────────────────────
    // The till's clock is recorded (offline billing needs it) but is NOT trusted
    // to choose anything. Left unchecked, a device claiming 2019 would draw a
    // number from a closed fiscal-year series — the exact failure gapless
    // numbering exists to prevent — and an unparseable value would 500.
    const claimed = body.device_created_at ? new Date(body.device_created_at) : new Date();
    const deviceCreatedAt = Number.isFinite(claimed.getTime()) ? claimed : new Date();
    const now = new Date();
    const deviceClockSkewDays = Math.abs(now.getTime() - deviceCreatedAt.getTime()) / 86_400_000;
    // 10.2 sales attribution feeds the incentive report, so the tag has to be a
    // real employee AT THIS BRANCH. A foreign key alone would not do it: Postgres
    // bypasses RLS when checking a reference, so the FK would happily accept
    // somebody from another branch.
    const requestedSoldBy = optionalUuid(body.sold_by_employee_id, 'sold_by_employee_id');
    let soldBy: string | null = null;
    if (requestedSoldBy) {
      const ok = (await sql<any>`
        SELECT employee_id FROM employees WHERE employee_id = ${requestedSoldBy} AND branch_id = ${branchId}
      `.execute(trx)).rows[0];
      if (!ok) throw badRequest('That salesperson is not on this branch\'s staff list.');
      soldBy = requestedSoldBy;
    } else {
      soldBy = (await sql<any>`
        SELECT employee_id FROM employees WHERE user_id = ${session.user_id} LIMIT 1
      `.execute(trx)).rows[0]?.employee_id ?? null;
    }
    const tillSessionId = optionalUuid(body.till_session_id, 'till_session_id');

    if (tillSessionId) {
      const till = (await sql<any>`
        SELECT status, branch_id FROM till_sessions WHERE session_id = ${tillSessionId}
      `.execute(trx)).rows[0];
      if (!till) throw notFound('That till session does not exist.');
      if (till.status !== 'OPEN') throw badRequest('That till session is already closed. Open a new one before billing.');
    }

    // 3.6 — the number is drawn here, inside the transaction, at the moment the
    // invoice becomes FINAL. If anything below throws, the transaction rolls back
    // and the number returns to the pool, keeping the series gapless. The fiscal
    // year comes from the SERVER clock.
    const invoiceNumber = await nextNumber(trx, branchId, 'INVOICE', now);

    const invoice = (await sql<any>`
      INSERT INTO invoices (invoice_number, branch_id, till_session_id, customer_id, invoice_type, status,
                            subtotal, discount_total, cgst_total, sgst_total, igst_total, grand_total,
                            round_off, place_of_supply_state_code, client_txn_id, device_created_at,
                            is_offline_conflict, created_by, sold_by_employee_id)
      VALUES (${invoiceNumber}, ${branchId}, ${tillSessionId}, ${customerId}, ${invoiceType}::invoice_type, 'FINAL',
              ${totals.subtotal}, ${totals.discount_total}, ${totals.cgst_total}, ${totals.sgst_total},
              ${totals.igst_total}, ${totals.grand_total}, ${totals.round_off}, ${placeOfSupply},
              ${clientTxnId}, ${deviceCreatedAt}, ${conflicts.length > 0 && isOfflineSale},
              ${session.user_id}, ${soldBy})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const line of prepared) {
      const inserted = (await sql<any>`
        INSERT INTO invoice_lines (invoice_id, product_id, product_unit_id, qty_in_sale_unit, base_unit_qty,
                                   price_type, rate_locked_at_scan, discount_amount, taxable_value,
                                   cgst_amount, sgst_amount, igst_amount, batch_id)
        VALUES (${invoice.invoice_id}, ${line.product_id}, ${line.product_unit_id}, ${line.qty_in_sale_unit},
                ${line.computed.base_unit_qty}, ${line.price_type}::price_type, ${line.rate_locked_at_scan},
                ${line.computed.discount_amount}, ${line.computed.taxable_value}, ${line.computed.cgst_amount},
                ${line.computed.sgst_amount}, ${line.computed.igst_amount}, ${line.batch_id})
        RETURNING line_id
      `.execute(trx)).rows[0];

      // 2.3 paint tinting note, so the exact colour can be reproduced later.
      if (line.tint && (line.tint.base_shade || line.tint.tint_formula) && settings.enable_tinting_records) {
        await sql`
          INSERT INTO paint_tint_records (invoice_line_id, base_shade, tint_formula)
          VALUES (${inserted.line_id}, ${line.tint.base_shade ?? null}, ${line.tint.tint_formula ?? null})
        `.execute(trx);
      }

      // 12.2 — a serialised unit's serial is captured at sale, which is what a
      // warranty claim is later matched against.
      for (const serial of line.serials) {
        await sql`
          UPDATE stock_serials SET status = 'SOLD', invoice_line_id = ${inserted.line_id}
           WHERE branch_id = ${branchId} AND product_id = ${line.product_id}
             AND serial_number = ${serial} AND status = 'IN_STOCK'
        `.execute(trx);
      }

      // 4.1 — the ledger is the source of truth for how stock reached its number.
      const cost = (await sql<any>`
        SELECT weighted_avg_cost FROM branch_stock WHERE branch_id = ${branchId} AND product_id = ${line.product_id}
      `.execute(trx)).rows[0]?.weighted_avg_cost ?? null;

      // A plain UPDATE, not an upsert: Postgres fires the BEFORE INSERT trigger
      // on the insert attempt before it notices the ON CONFLICT, so an upsert
      // carrying a negative delta gets rejected by the non-negative-stock trigger
      // even when the existing row would end up comfortably positive.
      const updated = await sql`
        UPDATE branch_stock
           SET base_unit_qty = base_unit_qty - ${line.computed.base_unit_qty}, updated_at = now()
         WHERE branch_id = ${branchId} AND product_id = ${line.product_id}
        RETURNING product_id
      `.execute(trx);
      if (!updated.rows.length) {
        await sql`
          INSERT INTO branch_stock (branch_id, product_id, base_unit_qty)
          VALUES (${branchId}, ${line.product_id}, ${-line.computed.base_unit_qty})
        `.execute(trx);
      }

      await sql`
        INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change,
                                  cost_at_movement, ref_table, ref_id, created_by)
        VALUES (${branchId}, ${line.product_id}, 'SALE', ${-line.computed.base_unit_qty},
                ${cost}, 'invoices', ${invoice.invoice_id}, ${session.user_id})
      `.execute(trx);

      // 4.2 — draw down the batch the cashier picked, so expiry tracking stays real.
      if (line.batch_id) {
        await sql`
          UPDATE stock_batches SET qty_remaining = GREATEST(qty_remaining - ${line.computed.base_unit_qty}, 0)
           WHERE batch_id = ${line.batch_id}
        `.execute(trx);
      }
    }

    // 3.5.1 — flagged, routed to the branch queue, never auto-voided.
    for (const c of conflicts) {
      await sql`
        INSERT INTO stock_conflicts (branch_id, invoice_id, product_id, requested_qty, available_qty)
        VALUES (${branchId}, ${invoice.invoice_id}, ${c.product_id}, ${c.requested}, ${c.available})
      `.execute(trx);
    }

    // ── Payments, till events, credit, loyalty ──────────────────────────────
    for (const p of payments) {
      if (p.amount <= 0) continue;
      await sql`
        INSERT INTO invoice_payments (invoice_id, method, amount, ref_no)
        VALUES (${invoice.invoice_id}, ${p.method}::payment_method, ${p.amount}, ${p.ref_no})
      `.execute(trx);

      if (p.method === 'CASH' && tillSessionId) {
        await sql`
          INSERT INTO till_events (session_id, event_type, amount, ref_table, ref_id)
          VALUES (${tillSessionId}, 'CASH_SALE', ${p.amount}, 'invoices', ${invoice.invoice_id})
        `.execute(trx);
      }

      if (p.method === 'CREDIT' && customer) {
        // Posted under a lock on the customer row, so two branches billing the
        // same customer at the same moment cannot both extend the same balance.
        // The limit is enforced here unless a manager already approved going over.
        const posted = await postCredit(trx, {
          customerId: customer.customer_id, branchId, entryType: 'SALE_ON_CREDIT',
          amount: p.amount, refTable: 'invoices', refId: invoice.invoice_id,
          enforceLimit: !creditOverrideBy,
        });
        if (posted.over_limit) {
          throw conflict(`${customer.name} would go to ₹${posted.balance_after.toFixed(2)} against a limit of ₹${posted.credit_limit.toFixed(2)}. A manager PIN is needed to allow it.`);
        }
      }
    }

    if (customer) {
      let balance = Number(customer.loyalty_points_balance);
      if (pointsRedeemed > 0) {
        balance -= pointsRedeemed;
        await sql`
          INSERT INTO loyalty_transactions (customer_id, invoice_id, txn_type, points, balance_after)
          VALUES (${customer.customer_id}, ${invoice.invoice_id}, 'REDEEM', ${-pointsRedeemed}, ${balance})
        `.execute(trx);
      }
      // Points are earned on what was actually paid in money, not on the portion
      // settled with points — otherwise points would compound into themselves.
      const earnBase = round2(totals.payable - (loyaltyPayment?.amount ?? 0));
      const earned = Math.floor((earnBase / 100) * Number(settings.loyalty_earn_points_per_100));
      if (earned > 0) {
        balance += earned;
        await sql`
          INSERT INTO loyalty_transactions (customer_id, invoice_id, txn_type, points, balance_after)
          VALUES (${customer.customer_id}, ${invoice.invoice_id}, 'EARN', ${earned}, ${balance})
        `.execute(trx);
      }
      if (pointsRedeemed > 0 || earned > 0) {
        await sql`UPDATE customers SET loyalty_points_balance = ${balance} WHERE customer_id = ${customer.customer_id}`.execute(trx);
      }

      // Requirement #4 — queued, so an internet outage never blocks the counter.
      if (customer.phone) {
        await queueMessage(trx, {
          to_phone: customer.phone,
          customer_id: customer.customer_id,
          invoice_id: invoice.invoice_id,
          message_type: 'INVOICE_PDF',
          body: `${branch.name}: invoice ${invoiceNumber} for ₹${totals.payable.toFixed(2)}. Thank you for your purchase.`,
        });
      }
    }

    if (discountApprovedBy) {
      await audit(trx, session, 'DISCOUNT_OVERRIDE', 'invoices', invoice.invoice_id,
        { after: { discount_pct: round2(discountPct), limit: discountLimit, approved_by: discountApprovedBy } });
    }

    return {
      ...invoice,
      totals,
      points_redeemed: pointsRedeemed,
      stock_conflicts: conflicts,
      warning: conflicts.length
        ? 'This sale went through but stock was short. It has been flagged for the branch to resolve.'
        : null,
    };
  }));

  /**
   * 3.5 — offline batch sync status. The till uploads each queued sale to
   * POST /invoices with its own client_txn_id, which the server treats as
   * idempotent; this endpoint tells the till which of its queued ids the server
   * has already accepted, so a device that lost its acknowledgement can work out
   * what still needs sending instead of guessing.
   *
   * It deliberately does NOT accept a batch of invoice bodies. An earlier version
   * did, returned {ok:true}, and discarded them — a till that trusted that
   * acknowledgement would silently lose the shift's sales.
   */
  app.post('/sync/status', guarded('create_invoice', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as { client_txn_ids?: unknown };
    const ids = arrayOf(body.client_txn_ids, 'client_txn_ids',
      (id, i) => uuid(id, `client_txn_ids[${i}]`), { min: 1, max: 500 });

    const known = (await sql<{ client_txn_id: string; invoice_id: string; invoice_number: string }>`
      SELECT client_txn_id, invoice_id, invoice_number FROM invoices
       WHERE client_txn_id = ANY(${ids}::uuid[])
    `.execute(trx)).rows;

    const accepted = new Set(known.map((r) => r.client_txn_id));
    return {
      accepted: known,
      still_pending: ids.filter((id) => !accepted.has(id)),
      instructions: 'Re-post anything under still_pending to POST /api/billing/invoices with the same client_txn_id. Duplicates are ignored.',
    };
  }));

  // ── Void (3.6: a void keeps its number, it is never reused) ────────────────
  app.post('/invoices/:id/void', guarded('void_invoice', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'invoice_id');
    const reason = str((req.body as any)?.reason, 'Reason', { max: 300 });

    const invoice = (await sql<any>`SELECT * FROM invoices WHERE invoice_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!invoice) throw notFound('Invoice not found.');
    if (invoice.status === 'VOID') throw badRequest('That invoice is already void.');

    const returned = (await sql<any>`SELECT 1 FROM sales_returns WHERE invoice_id = ${id} LIMIT 1`.execute(trx)).rows[0];
    if (returned) throw badRequest('This invoice already has a return against it. Handle it through Returns, not by voiding.');

    // A void has to unwind everything the sale did, not just the stock. Reversing
    // the goods but leaving the receivable, the points and the till entry behind
    // means the customer still owes for a cancelled bill, keeps points they did
    // not earn, and the drawer reads short at close for cash that was never taken.
    const lines = (await sql<any>`SELECT * FROM invoice_lines WHERE invoice_id = ${id}`.execute(trx)).rows;
    for (const line of lines) {
      await sql`
        UPDATE branch_stock SET base_unit_qty = base_unit_qty + ${line.base_unit_qty}, updated_at = now()
         WHERE branch_id = ${invoice.branch_id} AND product_id = ${line.product_id}
      `.execute(trx);
      await sql`
        INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change, ref_table, ref_id, reason_code, created_by)
        VALUES (${invoice.branch_id}, ${line.product_id}, 'COUNT_ADJUSTMENT', ${line.base_unit_qty},
                'invoices', ${id}, 'INVOICE_VOID', ${session.user_id})
      `.execute(trx);
      // A serialised unit goes back on the shelf as stock, not as sold.
      await sql`
        UPDATE stock_serials SET status = 'IN_STOCK', invoice_line_id = NULL
         WHERE invoice_line_id = ${line.line_id}
      `.execute(trx);
      // The sale drew the quantity out of a specific batch (4.2); the void has to
      // put it back. Restoring branch_stock but not the batch left the two
      // disagreeing — the shelf total said the goods were there, and no batch
      // claimed them, so expiry tracking quietly lost sight of the units.
      if (line.batch_id) {
        await sql`
          UPDATE stock_batches SET qty_remaining = qty_remaining + ${line.base_unit_qty}
           WHERE batch_id = ${line.batch_id}
        `.execute(trx);
      }
    }

    const payments = (await sql<any>`SELECT * FROM invoice_payments WHERE invoice_id = ${id}`.execute(trx)).rows;

    // 1. The credit ledger: a voided credit sale is not owed.
    const creditPaid = payments.filter((p: any) => p.method === 'CREDIT')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);
    if (creditPaid > 0 && invoice.customer_id) {
      await postCredit(trx, {
        customerId: invoice.customer_id, branchId: invoice.branch_id,
        entryType: 'REFUND_ADJUSTMENT', amount: -creditPaid,
        refTable: 'invoices', refId: id,
      });
    }

    // 2. Loyalty: take back what was earned, give back what was spent.
    if (invoice.customer_id) {
      const moves = (await sql<any>`
        SELECT txn_type, SUM(points) AS pts FROM loyalty_transactions
         WHERE invoice_id = ${id} AND txn_type IN ('EARN', 'REDEEM') GROUP BY txn_type
      `.execute(trx)).rows;
      const net = moves.reduce((sum: number, m: any) => sum + Number(m.pts), 0);
      if (net !== 0) {
        const balance = Number((await sql<any>`
          SELECT loyalty_points_balance FROM customers WHERE customer_id = ${invoice.customer_id} FOR UPDATE
        `.execute(trx)).rows[0]?.loyalty_points_balance ?? 0);
        const after = Math.max(balance - net, 0);
        await sql`UPDATE customers SET loyalty_points_balance = ${after} WHERE customer_id = ${invoice.customer_id}`.execute(trx);
        await sql`
          INSERT INTO loyalty_transactions (customer_id, invoice_id, txn_type, points, balance_after)
          VALUES (${invoice.customer_id}, ${id}, ${net > 0 ? 'REVOKE' : 'RESTORE'}::loyalty_txn_type, ${-net}, ${after})
        `.execute(trx);
      }
    }

    // 3. The till: cancel the cash the drawer is expected to hold for this bill.
    const cashPaid = payments.filter((p: any) => p.method === 'CASH')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);
    if (cashPaid > 0 && invoice.till_session_id) {
      const till = (await sql<any>`
        SELECT status FROM till_sessions WHERE session_id = ${invoice.till_session_id}
      `.execute(trx)).rows[0];
      if (till?.status === 'OPEN') {
        // Still open: a negative CASH_SALE nets the expected drawer figure back out.
        await sql`
          INSERT INTO till_events (session_id, event_type, amount, ref_table, ref_id, note)
          VALUES (${invoice.till_session_id}, 'CASH_SALE', ${-cashPaid}, 'invoices', ${id},
                  ${'Void of ' + (invoice.invoice_number ?? id)})
        `.execute(trx);
      }
      // If the shift is already closed its reconciliation is history; the audit
      // entry below is what ties the void to that closed session.
    }

    await sql`UPDATE invoices SET status = 'VOID' WHERE invoice_id = ${id}`.execute(trx);
    await audit(trx, session, 'INVOICE_VOIDED', 'invoices', id, {
      before: { status: invoice.status, grand_total: invoice.grand_total },
      after: { status: 'VOID', reason, credit_reversed: creditPaid, cash_reversed: cashPaid,
               till_session_id: invoice.till_session_id },
    });

    return {
      ok: true,
      credit_reversed: creditPaid,
      cash_reversed: cashPaid,
      message: 'Invoice voided. Stock, credit, loyalty points and the till entry have all been reversed.',
    };
  }));

  // ── Till sessions (3.3 / 3.3.1) ───────────────────────────────────────────
  app.get('/till-sessions', guarded('manage_till', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const rows = await sql<any>`
      SELECT ts.session_id, ts.branch_id, b.name AS branch_name, ts.counter_id,
             u.full_name AS cashier_name, ts.cashier_user_id, ts.opening_float,
             ts.opened_at, ts.closed_at, ts.closing_counted_cash, ts.status,
             COALESCE(ev.cash_sales, 0) AS cash_sales,
             COALESCE(ev.cash_drops, 0) AS cash_drops,
             COALESCE(ev.petty, 0) AS petty_expenses,
             ts.opening_float + COALESCE(ev.cash_sales, 0) - COALESCE(ev.cash_drops, 0) - COALESCE(ev.petty, 0) AS expected_drawer_cash
        FROM till_sessions ts
        JOIN branches b ON b.branch_id = ts.branch_id
        JOIN users u ON u.user_id = ts.cashier_user_id
        LEFT JOIN LATERAL (
            SELECT SUM(amount) FILTER (WHERE event_type = 'CASH_SALE') AS cash_sales,
                   SUM(amount) FILTER (WHERE event_type = 'CASH_DROP') AS cash_drops,
                   SUM(amount) FILTER (WHERE event_type = 'PETTY_EXPENSE_PAYOUT') AS petty
              FROM till_events WHERE session_id = ts.session_id
        ) ev ON TRUE
       WHERE 1=1
         ${branchId ? sql`AND ts.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND ts.status = ${q.status}` : sql``}
         ${q.mine === 'true' ? sql`AND ts.cashier_user_id = ${session.user_id}` : sql``}
       ORDER BY ts.opened_at DESC
       LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx);
    return rows.rows;
  }));

  app.post('/till-sessions', guarded('manage_till', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    const counterId = str(body.counter_id, 'Counter', { max: 40 });

    // One open till per counter, or two cashiers reconcile against the same drawer
    // and neither figure means anything (3.3).
    const openAtCounter = (await sql<any>`
      SELECT session_id FROM till_sessions
       WHERE branch_id = ${branchId} AND counter_id = ${counterId} AND status = 'OPEN'
    `.execute(trx)).rows[0];
    if (openAtCounter) throw conflict(`${counterId} already has an open till session. Close it before opening a new one.`);

    const row = (await sql<any>`
      INSERT INTO till_sessions (branch_id, counter_id, cashier_user_id, opening_float)
      VALUES (${branchId}, ${counterId}, ${session.user_id}, ${num(body.opening_float, 'Opening float', { min: 0 })})
      RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  /** 3.3.1 — cash leaving the drawer mid-shift, so the close does not falsely read short. */
  app.post('/till-sessions/:id/events', guarded('manage_till', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'session_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const eventType = oneOf(body.event_type, 'Event type', ['CASH_DROP', 'PETTY_EXPENSE_PAYOUT'] as const);
    const amount = num(body.amount, 'Amount', { min: 0.01 });

    const till = (await sql<any>`SELECT * FROM till_sessions WHERE session_id = ${id}`.execute(trx)).rows[0];
    if (!till) throw notFound('Till session not found.');
    if (till.status !== 'OPEN') throw badRequest('That till session is closed.');

    // 3.3.1 — a cash drop requires a manager/owner acknowledgement, because it is
    // the one event that moves money out of the drawer with no customer involved.
    let acknowledgedBy: string | null = null;
    if (eventType === 'CASH_DROP') {
      if (['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role)) {
        acknowledgedBy = session.user_id;
      } else {
        // A cashier needs a manager's PIN. Accepting an acknowledged_by id from
        // the request body would have let the one event that removes cash from
        // the drawer acknowledge itself.
        const grant = await consumeOverride(
          trx, optionalUuid(body.approval_id, 'approval_id'),
          'CASH_DROP', till.branch_id, session.user_id);
        if (!grant) throw forbidden('A cash drop must be acknowledged by a manager or the owner.');
        acknowledgedBy = grant.approver_id;
      }
    }

    let expenseId: string | null = null;
    if (eventType === 'PETTY_EXPENSE_PAYOUT') {
      // Petty cash is not a footnote: it becomes a real expense row against a real
      // category, so it shows up in the expense reports like everything else (Section 9).
      const categoryId = uuid(body.category_id, 'Expense category');
      expenseId = (await sql<any>`
        INSERT INTO expenses (branch_id, category_id, amount, description, status, created_by, paid_from_till_session_id)
        VALUES (${till.branch_id}, ${categoryId}, ${amount},
                ${optionalStr(body.note, 'Note', { max: 300 })}, 'PENDING', ${session.user_id}, ${id})
        RETURNING expense_id
      `.execute(trx)).rows[0].expense_id;
    }

    const row = (await sql<any>`
      INSERT INTO till_events (session_id, event_type, amount, ref_table, ref_id, note, acknowledged_by)
      VALUES (${id}, ${eventType}::till_event_type, ${amount},
              ${expenseId ? 'expenses' : null}, ${expenseId},
              ${optionalStr(body.note, 'Note', { max: 300 })}, ${acknowledgedBy})
      RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  app.get('/till-sessions/:id/reconcile', guarded('manage_till', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'session_id');
    const till = (await sql<any>`
      SELECT ts.*, u.full_name AS cashier_name, b.name AS branch_name
        FROM till_sessions ts JOIN users u ON u.user_id = ts.cashier_user_id
        JOIN branches b ON b.branch_id = ts.branch_id
       WHERE ts.session_id = ${id}
    `.execute(trx)).rows[0];
    if (!till) throw notFound('Till session not found.');

    const events = (await sql<any>`
      SELECT te.*, u.full_name AS acknowledged_by_name
        FROM till_events te LEFT JOIN users u ON u.user_id = te.acknowledged_by
       WHERE te.session_id = ${id} ORDER BY te.created_at
    `.execute(trx)).rows;

    const sum = (type: string) => round2(events.filter((e: any) => e.event_type === type)
      .reduce((s: number, e: any) => s + Number(e.amount), 0));

    const cashSales = sum('CASH_SALE');
    const cashDrops = sum('CASH_DROP');
    const petty = sum('PETTY_EXPENSE_PAYOUT');
    // 3.3.1 — the formula, verbatim. Only the variance against this expected figure
    // is flagged; the raw open-vs-close difference would call every legitimate
    // cash drop a shortage.
    const expected = round2(Number(till.opening_float) + cashSales - cashDrops - petty);
    const counted = till.closing_counted_cash === null ? null : Number(till.closing_counted_cash);

    const nonCash = (await sql<any>`
      SELECT ip.method, SUM(ip.amount) AS total, COUNT(*) AS txn_count
        FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
       WHERE i.till_session_id = ${id} AND i.status = 'FINAL'
       GROUP BY ip.method
    `.execute(trx)).rows;

    return {
      session: till, events,
      opening_float: Number(till.opening_float),
      cash_sales: cashSales, cash_drops: cashDrops, petty_expenses: petty,
      expected_drawer_cash: expected,
      counted_cash: counted,
      variance: counted === null ? null : round2(counted - expected),
      payment_breakdown: nonCash,
    };
  }));

  app.post('/till-sessions/:id/close', guarded('manage_till', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'session_id');
    const counted = num((req.body as any)?.closing_counted_cash, 'Counted cash', { min: 0 });

    const till = (await sql<any>`SELECT * FROM till_sessions WHERE session_id = ${id}`.execute(trx)).rows[0];
    if (!till) throw notFound('Till session not found.');
    if (till.status === 'CLOSED') throw badRequest('That till session is already closed.');

    await sql`
      UPDATE till_sessions SET status = 'CLOSED', closed_at = now(), closing_counted_cash = ${counted}
       WHERE session_id = ${id}
    `.execute(trx);
    await sql`
      INSERT INTO till_events (session_id, event_type, amount, note)
      VALUES (${id}, 'CLOSING_COUNT', ${counted}, 'Shift close count')
    `.execute(trx);

    const events = (await sql<any>`
      SELECT event_type, SUM(amount) AS total FROM till_events WHERE session_id = ${id} GROUP BY event_type
    `.execute(trx)).rows;
    const pick = (t: string) => Number(events.find((e: any) => e.event_type === t)?.total ?? 0);
    const expected = round2(Number(till.opening_float) + pick('CASH_SALE') - pick('CASH_DROP') - pick('PETTY_EXPENSE_PAYOUT'));
    const variance = round2(counted - expected);

    if (Math.abs(variance) > 0.01) {
      await audit(trx, session, 'STOCK_ADJUSTMENT', 'till_sessions', id,
        { after: { expected, counted, variance } });
    }
    return { ok: true, expected_drawer_cash: expected, counted_cash: counted, variance };
  }));

  // ── Offline stock conflicts (3.5.1) ───────────────────────────────────────
  app.get('/stock-conflicts', guarded('view_billing', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const rows = await sql<any>`
      SELECT sc.*, p.name AS product_name, i.invoice_number, b.name AS branch_name
        FROM stock_conflicts sc
        JOIN products p ON p.product_id = sc.product_id
        JOIN invoices i ON i.invoice_id = sc.invoice_id
        JOIN branches b ON b.branch_id = sc.branch_id
       WHERE sc.status = ${q.status ?? 'OPEN'}
         ${branchId ? sql`AND sc.branch_id = ${branchId}` : sql``}
       ORDER BY sc.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx);
    return rows.rows;
  }));

  app.post('/stock-conflicts/:id/resolve', guarded('resolve_stock_conflict', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'conflict_id');
    const resolution = oneOf((req.body as any)?.resolution, 'Resolution',
      ['SUBSTITUTED', 'BACKORDERED', 'NEGATIVE_STOCK_OVERRIDE', 'CANCELLED'] as const);
    // RETURNING, and then check it. Without this the endpoint answered {ok:true}
    // for a conflict id that does not exist, is at another branch, or was resolved
    // by somebody else a moment earlier — and wrote an audit entry saying a human
    // had dealt with something that is still sitting open in the queue.
    const updated = await sql<{ conflict_id: string }>`
      UPDATE stock_conflicts
         SET status = 'RESOLVED', resolution = ${resolution}, resolved_by = ${session.user_id}, resolved_at = now()
       WHERE conflict_id = ${id} AND status = 'OPEN'
      RETURNING conflict_id
    `.execute(trx);
    if (!updated.rows.length) {
      const existing = (await sql<{ status: string }>`
        SELECT status FROM stock_conflicts WHERE conflict_id = ${id}
      `.execute(trx)).rows[0];
      if (!existing) throw notFound('That stock conflict was not found at your branch.');
      throw conflict(`That conflict has already been resolved (${existing.status}).`);
    }
    await audit(trx, session, 'STOCK_CONFLICT_RESOLVED', 'stock_conflicts', id, { after: { resolution } });
    return { ok: true, conflict_id: id, resolution };
  }));
}
