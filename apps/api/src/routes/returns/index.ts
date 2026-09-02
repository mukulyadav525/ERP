// ============================================================================
// Section 12 — Returns, Refunds & Warranty
//
// Two rules here are non-negotiable and are applied by the server, not offered
// as options to the client:
//
//  12.1.1  A return against a GST invoice MUST produce a formal Credit Note with
//          its own number series, linked to the original invoice. The return
//          record alone is not what gets reported in GSTR-1.
//
//  11.2.1  The refund hierarchy, in this fixed order, because it is a fraud
//          control rather than a business preference:
//            1. revoke the points EARNED on the original purchase
//            2. restore the points REDEEMED on it (as points, never as cash)
//            3. refund only the remaining money portion
//          Refunding the full value in cash would let someone redeem points, return
//          the goods, and walk out with cash for the points.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, num, oneOf,
  resolveBranchScope, limit as clampLimit, arrayOf,
} from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { computeReturnLine, round2 } from '../../lib/tax.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { queueMessage } from '../../lib/whatsapp.js';
import type { Tx } from '../../lib/db.js';
import { postCredit } from '../../lib/ledger.js';

/** Consumes a single-use manager approval — see the note in routes/billing. */
async function consumeOverride(
  trx: Tx, approvalId: string | null, purpose: string, branchId: string, requestedBy: string,
): Promise<{ approver_id: string; approver_name: string } | null> {
  if (!approvalId) return null;
  const res = await sql<{ ok: boolean; approver_id: string | null; approver_name: string | null }>`
    SELECT * FROM auth_consume_override(${approvalId}, ${purpose}, ${branchId}, ${requestedBy})
  `.execute(trx);
  const row = res.rows[0];
  return row?.ok ? { approver_id: row.approver_id!, approver_name: row.approver_name! } : null;
}

export default async function returnsRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_returns', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT r.return_id, r.invoice_id, i.invoice_number, i.invoice_type,
             c.name AS customer_name, c.phone AS customer_phone,
             r.branch_id, b.name AS branch_name, r.refund_method, r.refund_total,
             r.store_credit_total, r.return_reason, r.created_at,
             cn.credit_note_number, cn.total_amount AS credit_note_total,
             u.full_name AS created_by_name,
             (SELECT count(*) FROM sales_return_lines WHERE return_id = r.return_id) AS line_count
        FROM sales_returns r
        JOIN invoices i ON i.invoice_id = r.invoice_id
        JOIN branches b ON b.branch_id = r.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN credit_notes cn ON cn.credit_note_id = r.credit_note_id
        LEFT JOIN users u ON u.user_id = r.created_by
       WHERE 1=1 ${branchId ? sql`AND r.branch_id = ${branchId}` : sql``}
         ${q.q ? sql`AND (i.invoice_number ILIKE ${'%' + q.q + '%'} OR c.name ILIKE ${'%' + q.q + '%'})` : sql``}
       ORDER BY r.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.get('/:id', guarded('view_returns', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'return_id');
    const ret = (await sql<any>`
      SELECT r.*, i.invoice_number, i.invoice_type, c.name AS customer_name, c.phone AS customer_phone,
             b.name AS branch_name, cn.credit_note_number, cn.total_amount AS credit_note_total
        FROM sales_returns r JOIN invoices i ON i.invoice_id = r.invoice_id
        JOIN branches b ON b.branch_id = r.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN credit_notes cn ON cn.credit_note_id = r.credit_note_id
       WHERE r.return_id = ${id}
    `.execute(trx)).rows[0];
    if (!ret) throw notFound('Return not found.');
    const lines = (await sql<any>`
      SELECT srl.*, p.name AS product_name, p.sku, il.rate_locked_at_scan
        FROM sales_return_lines srl
        JOIN invoice_lines il ON il.line_id = srl.invoice_line_id
        JOIN products p ON p.product_id = il.product_id
       WHERE srl.return_id = ${id}
    `.execute(trx)).rows;
    return { ...ret, lines };
  }));

  /**
   * What is still returnable on an invoice, and whether the return window has
   * passed. The counter needs this before it can take anything back.
   */
  app.get('/eligibility/:invoiceId', guarded('process_return', async ({ db: trx, req }) => {
    const invoiceId = uuid((req.params as any).invoiceId, 'invoice_id');
    const invoice = (await sql<any>`
      SELECT i.*, c.name AS customer_name, c.phone AS customer_phone
        FROM invoices i LEFT JOIN customers c ON c.customer_id = i.customer_id
       WHERE i.invoice_id = ${invoiceId}
    `.execute(trx)).rows[0];
    if (!invoice) throw notFound('That invoice was not found at your branch.');
    if (invoice.status !== 'FINAL') throw badRequest('Only a finalised invoice can be returned against.');

    const settings = await loadSettings(trx, invoice.branch_id);
    const lines = (await sql<any>`
      SELECT il.*, p.name AS product_name, p.sku, p.category_id, p.serial_tracked,
             COALESCE(rw.window_days, ${Number(settings.return_window_days)}) AS window_days,
             COALESCE((SELECT SUM(qty_base_unit) FROM sales_return_lines WHERE invoice_line_id = il.line_id), 0) AS already_returned,
             w.duration_months AS warranty_months
        FROM invoice_lines il
        JOIN products p ON p.product_id = il.product_id
        LEFT JOIN return_windows rw ON rw.category_id = p.category_id
        LEFT JOIN LATERAL (
            SELECT duration_months FROM warranties
             WHERE product_id = p.product_id OR category_id = p.category_id
             ORDER BY (product_id IS NOT NULL) DESC LIMIT 1
        ) w ON TRUE
       WHERE il.invoice_id = ${invoiceId}
    `.execute(trx)).rows;

    const soldAt = new Date(invoice.server_received_at);
    const daysSince = Math.floor((Date.now() - soldAt.getTime()) / 86_400_000);

    return {
      invoice: {
        invoice_id: invoice.invoice_id, invoice_number: invoice.invoice_number,
        invoice_type: invoice.invoice_type, grand_total: invoice.grand_total,
        customer_name: invoice.customer_name, sold_at: invoice.server_received_at,
      },
      days_since_sale: daysSince,
      // 12.3 — outside the return window an electrical or power-tool item is not
      // simply refused; it routes to a warranty claim instead.
      lines: lines.map((l: any) => {
        const remaining = round2(Number(l.base_unit_qty) - Number(l.already_returned));
        const withinWindow = daysSince <= Number(l.window_days);
        return {
          line_id: l.line_id, product_id: l.product_id, product_name: l.product_name, sku: l.sku,
          sold_qty: Number(l.base_unit_qty), already_returned: Number(l.already_returned),
          returnable_qty: Math.max(remaining, 0),
          window_days: Number(l.window_days),
          within_return_window: withinWindow,
          warranty_months: l.warranty_months,
          route: remaining <= 0 ? 'FULLY_RETURNED'
               : withinWindow ? 'RETURN'
               : l.warranty_months ? 'WARRANTY_CLAIM' : 'OUTSIDE_WINDOW',
             };
      }) };
  }));

  app.post('/', guarded('process_return', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const invoiceId = uuid(body.invoice_id, 'Invoice');
    const reason = str(body.return_reason, 'Reason', { max: 300 });

    const invoice = (await sql<any>`SELECT * FROM invoices WHERE invoice_id = ${invoiceId}`.execute(trx)).rows[0];
    if (!invoice) throw notFound('That invoice was not found at your branch.');
    if (invoice.status !== 'FINAL') throw badRequest('Only a finalised invoice can be returned against.');

    const settings = await loadSettings(trx, invoice.branch_id);

    // How the original sale was actually paid. Needed BEFORE the refund method is
    // resolved, because the "original mode" policy is defined in terms of it.
    const originalPayments = (await sql<{ method: string; amount: string }>`
      SELECT method, SUM(amount) AS amount FROM invoice_payments
       WHERE invoice_id = ${invoiceId} GROUP BY method
    `.execute(trx)).rows;
    const paidBy = (method: string) =>
      Number(originalPayments.find((p) => p.method === method)?.amount ?? 0);

    // Section 17 lists four values for "Refund method": ADMIN_CHOICE, CASH,
    // ORIGINAL_MODE and STORE_CREDIT. Only the first two were handled; the other
    // two are not payment_method enum members, so ORIGINAL_MODE was cast straight
    // into `::payment_method` and every return at a shop configured that way died
    // with a 500. Each policy is now mapped explicitly to a real payment method.
    const refundMethod: 'CASH' | 'UPI' | 'CARD' | 'CREDIT' = (() => {
      switch (settings.refund_method) {
        case 'ADMIN_CHOICE':
          return oneOf(body.refund_method ?? 'CASH', 'Refund method', ['CASH', 'UPI', 'CARD', 'CREDIT'] as const);
        case 'STORE_CREDIT':
          return 'CREDIT';
        case 'ORIGINAL_MODE': {
          // Give the money back the way it came in. Where the sale was split, the
          // largest non-points component wins; a points-only sale has no money to
          // return, so it settles to the ledger as store credit.
          const ranked = originalPayments
            .filter((p) => p.method !== 'LOYALTY_POINTS')
            .sort((a, b) => Number(b.amount) - Number(a.amount));
          const top = ranked[0]?.method;
          return top === 'CASH' || top === 'UPI' || top === 'CARD' || top === 'CREDIT' ? top : 'CREDIT';
        }
        case 'CASH':
        default:
          return 'CASH';
      }
    })();

    const requested = arrayOf(body.lines, 'lines', (l) => ({
      invoice_line_id: uuid(l.invoice_line_id, 'lines[].invoice_line_id'),
      qty_base_unit: num(l.qty_base_unit, 'lines[].qty_base_unit', { min: 0.0001 }),
      condition: oneOf(l.condition ?? 'RESELLABLE', 'lines[].condition', ['RESELLABLE', 'DAMAGED'] as const),
    }));

    const daysSince = Math.floor((Date.now() - new Date(invoice.server_received_at).getTime()) / 86_400_000);

    // The till the cash is being handed back out of (3.3.1).
    //
    // An explicit session can be named, but the default matters more: cash for a
    // refund comes out of whichever drawer the person processing it is standing
    // at, so when none is given we fall back to this user's own open till at this
    // branch. Making the link opt-in would have left the reconciliation gap in
    // place for every caller that simply didn't know to pass the field.
    let tillSessionId = optionalUuid(body.till_session_id, 'till_session_id');
    if (tillSessionId) {
      const till = (await sql<any>`
        SELECT status, branch_id FROM till_sessions WHERE session_id = ${tillSessionId}
      `.execute(trx)).rows[0];
      if (!till) throw notFound('That till session does not exist.');
      if (till.status !== 'OPEN') throw badRequest('That till session is already closed.');
      if (till.branch_id !== invoice.branch_id) {
        throw badRequest('That till session belongs to a different branch than the invoice.');
      }
    } else {
      tillSessionId = (await sql<{ session_id: string }>`
        SELECT session_id FROM till_sessions
         WHERE branch_id = ${invoice.branch_id} AND cashier_user_id = ${session.user_id} AND status = 'OPEN'
         ORDER BY opened_at DESC LIMIT 1
      `.execute(trx)).rows[0]?.session_id ?? null;
    }

    // ── Validate each line before writing anything ─────────────────────────
    const prepared: any[] = [];
    let windowOverrideBy: string | null = null;
    for (const r of requested) {
      // Two statements, and the order is the whole point.
      //
      // The lock is taken FIRST, on its own. Doing it the obvious way — one query
      // that locks the line and computes `already_returned` in a SELECT-list
      // subquery — looks correct and is not: under READ COMMITTED, when the second
      // transaction is finally granted the lock it re-evaluates the row's WHERE
      // qualifiers against the new version, but the subquery in the select list
      // still runs against the statement's ORIGINAL snapshot. So the second clerk
      // reads already_returned = 0 even though the first clerk's return has just
      // committed, and the shop refunds the same goods twice. (Verified: two
      // simultaneous full returns of a 1-unit line both succeeded, and 2 units
      // came back into stock.)
      //
      // Locking first and reading second gives the follow-up statement a fresh
      // snapshot taken after the other transaction committed, so it sees the
      // return that just happened.
      const locked = (await sql<{ line_id: string }>`
        SELECT line_id FROM invoice_lines
         WHERE line_id = ${r.invoice_line_id} AND invoice_id = ${invoiceId}
         FOR UPDATE
      `.execute(trx)).rows[0];
      if (!locked) throw badRequest('One of the returned lines does not belong to that invoice.');

      const line = (await sql<any>`
        SELECT il.*, p.name AS product_name, p.category_id,
               COALESCE(rw.window_days, ${Number(settings.return_window_days)}) AS window_days,
               COALESCE((SELECT SUM(qty_base_unit) FROM sales_return_lines WHERE invoice_line_id = il.line_id), 0) AS already_returned
          FROM invoice_lines il JOIN products p ON p.product_id = il.product_id
          LEFT JOIN return_windows rw ON rw.category_id = p.category_id
         WHERE il.line_id = ${r.invoice_line_id} AND il.invoice_id = ${invoiceId}
      `.execute(trx)).rows[0];
      if (!line) throw badRequest('One of the returned lines does not belong to that invoice.');

      // Quantities already claimed by earlier lines of THIS request count too — a
      // single payload asking for 1 + 1 against a 1-unit line must not slip past a
      // per-line check that only looks at what is already committed.
      const claimedInThisRequest = prepared
        .filter((q) => q.invoice_line_id === r.invoice_line_id)
        .reduce((sum, q) => sum + q.qty_base_unit, 0);
      const remaining = Number(line.base_unit_qty) - Number(line.already_returned) - claimedInThisRequest;
      if (r.qty_base_unit > remaining + 0.0001) {
        throw badRequest(`Only ${remaining} of "${line.product_name}" is left to return on this invoice.`);
      }
      // 12.3 — past the window, a manager has to say yes, and the fact that they
      // did is recorded. An unverified id in the request body proved nothing.
      if (daysSince > Number(line.window_days)) {
        const selfAuthorised = ['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role);
        if (selfAuthorised) {
          windowOverrideBy = session.user_id;
        } else {
          const grant = await consumeOverride(
            trx, optionalUuid(body.window_approval_id, 'window_approval_id'),
            'RETURN_WINDOW', invoice.branch_id, session.user_id);
          if (!grant) {
            throw forbidden(`"${line.product_name}" is ${daysSince} days old, past its ${line.window_days}-day return window. A manager PIN can approve it, or it may qualify as a warranty claim.`);
          }
          windowOverrideBy = grant.approver_id;
        }
      }
      prepared.push({ ...r, line });
    }

    // ── Credit note (12.1.1) ────────────────────────────────────────────────
    // Only for a GST invoice. A non-GST retail return is a plain refund and needs
    // no credit note, so issuing one would be wrong, not merely unnecessary.
    let creditNoteId: string | null = null;
    let creditNoteNumber: string | null = null;
    if (invoice.invoice_type === 'GST') {
      creditNoteNumber = await nextNumber(trx, invoice.branch_id, 'CREDIT_NOTE');
      creditNoteId = (await sql<any>`
        INSERT INTO credit_notes (credit_note_number, invoice_id, reason, created_by)
        VALUES (${creditNoteNumber}, ${invoiceId}, ${reason}, ${session.user_id})
        RETURNING credit_note_id
      `.execute(trx)).rows[0].credit_note_id;
    }

    const ret = (await sql<any>`
      INSERT INTO sales_returns (invoice_id, branch_id, credit_note_id, refund_method, return_reason, created_by)
      VALUES (${invoiceId}, ${invoice.branch_id}, ${creditNoteId}, ${refundMethod}::payment_method, ${reason}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    // ── Money and stock, line by line ──────────────────────────────────────
    let returnedValue = 0;
    // The proportion of the invoice being returned drives the loyalty proration
    // in 11.2.1 — a partial return revokes a partial share of the points.
    const invoiceTotal = Number(invoice.grand_total) || 1;

    for (const p of prepared) {
      const computed = computeReturnLine(p.line, p.qty_base_unit);
      returnedValue = round2(returnedValue + computed.line_total);

      if (creditNoteId) {
        await sql`
          INSERT INTO credit_note_lines (credit_note_id, invoice_line_id, qty_base_unit,
                                         taxable_value, cgst_amount, sgst_amount, igst_amount)
          VALUES (${creditNoteId}, ${p.invoice_line_id}, ${p.qty_base_unit},
                  ${computed.taxable_value}, ${computed.cgst_amount}, ${computed.sgst_amount}, ${computed.igst_amount})
        `.execute(trx);
      }

      // 12.1 — resellable goods go back on the shelf; damaged goods do not. Sending
      // damaged stock back into sellable inventory is how a shop ends up selling a
      // returned broken item to the next customer.
      if (p.condition === 'RESELLABLE') {
        await sql`
          UPDATE branch_stock SET base_unit_qty = base_unit_qty + ${p.qty_base_unit}, updated_at = now()
           WHERE branch_id = ${invoice.branch_id} AND product_id = ${p.line.product_id}
        `.execute(trx);
        await sql`
          INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change,
                                    ref_table, ref_id, reason_code, created_by)
          VALUES (${invoice.branch_id}, ${p.line.product_id}, 'SALE_RETURN', ${p.qty_base_unit},
                  'sales_returns', ${ret.return_id}, ${reason}, ${session.user_id})
        `.execute(trx);
        // Resellable goods rejoin the batch they were sold out of, so the shelf
        // total and the batch quantities keep agreeing and expiry tracking does
        // not lose sight of units that are physically back on the shelf. Damaged
        // goods deliberately do not — they are written off below.
        if (p.line.batch_id) {
          await sql`
            UPDATE stock_batches SET qty_remaining = qty_remaining + ${p.qty_base_unit}
             WHERE batch_id = ${p.line.batch_id}
          `.execute(trx);
        }
      } else {
        // Damaged goods come back in and are immediately written off, as two
        // explicit movements that net to zero. The earlier version booked only the
        // write-off, with the goods never having re-entered stock — so every
        // shrinkage report counted the same loss twice, once as the sale and once
        // as the write-off.
        await sql`
          UPDATE branch_stock SET base_unit_qty = base_unit_qty + ${p.qty_base_unit}, updated_at = now()
           WHERE branch_id = ${invoice.branch_id} AND product_id = ${p.line.product_id}
        `.execute(trx);
        await sql`
          INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change,
                                    ref_table, ref_id, reason_code, created_by)
          VALUES (${invoice.branch_id}, ${p.line.product_id}, 'SALE_RETURN', ${p.qty_base_unit},
                  'sales_returns', ${ret.return_id}, ${'Returned damaged: ' + reason}, ${session.user_id})
        `.execute(trx);

        const writeoff = (await sql<any>`
          INSERT INTO stock_writeoffs (branch_id, product_id, qty_base_unit, reason_code, created_by)
          VALUES (${invoice.branch_id}, ${p.line.product_id}, ${p.qty_base_unit}, 'DAMAGED_RETURN', ${session.user_id})
          RETURNING writeoff_id
        `.execute(trx)).rows[0];
        await sql`
          UPDATE branch_stock SET base_unit_qty = base_unit_qty - ${p.qty_base_unit}, updated_at = now()
           WHERE branch_id = ${invoice.branch_id} AND product_id = ${p.line.product_id}
        `.execute(trx);
        await sql`
          INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change,
                                    ref_table, ref_id, reason_code, created_by)
          VALUES (${invoice.branch_id}, ${p.line.product_id}, 'WRITE_OFF', ${-p.qty_base_unit},
                  'stock_writeoffs', ${writeoff.writeoff_id}, 'DAMAGED_RETURN', ${session.user_id})
        `.execute(trx);
      }

      // Serialised units come back into stock as RETURNED, not IN_STOCK, so a
      // returned unit is never silently resold as new.
      await sql`
        UPDATE stock_serials SET status = 'RETURNED'
         WHERE invoice_line_id = ${p.invoice_line_id} AND status = 'SOLD'
      `.execute(trx);
    }

    // ── How the original sale was actually paid ─────────────────────────────
    // A refund must not hand back money the customer never handed over. Returning
    // a credit sale for cash would let someone take goods on account, return them,
    // and walk out with the shop's cash while still owing the full amount — so the
    // portion bought on credit can only ever go back to the ledger.
    // (originalPayments / paidBy were read above, before the refund method was
    // resolved, because the ORIGINAL_MODE policy is defined in terms of them.)
    const invoicePaidTotal = originalPayments.reduce((sum, p) => sum + Number(p.amount), 0) || 1;
    const returnShare = Math.min(returnedValue / invoicePaidTotal, 1);
    // The share of THIS return that was originally bought on credit.
    const creditPortion = round2(paidBy('CREDIT') * returnShare);

    // ── 11.2.1 refund hierarchy ─────────────────────────────────────────────
    let pointsRevoked = 0, pointsRestored = 0, cashRefund = returnedValue, storeCredit = 0;

    if (invoice.customer_id) {
      const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${invoice.customer_id}`.execute(trx)).rows[0];
      const share = Math.min(returnedValue / invoiceTotal, 1);

      const earned = Number((await sql<any>`
        SELECT COALESCE(SUM(points), 0) AS pts FROM loyalty_transactions
         WHERE invoice_id = ${invoiceId} AND txn_type = 'EARN'
      `.execute(trx)).rows[0]?.pts ?? 0);
      const redeemed = Math.abs(Number((await sql<any>`
        SELECT COALESCE(SUM(points), 0) AS pts FROM loyalty_transactions
         WHERE invoice_id = ${invoiceId} AND txn_type = 'REDEEM'
      `.execute(trx)).rows[0]?.pts ?? 0));

      let balance = Number(customer.loyalty_points_balance);

      // Step 1 — take back the points this purchase earned.
      pointsRevoked = Math.floor(earned * share);
      if (pointsRevoked > 0) {
        balance -= pointsRevoked;
        await sql`
          INSERT INTO loyalty_transactions (customer_id, invoice_id, sales_return_id, txn_type, points, balance_after)
          VALUES (${invoice.customer_id}, ${invoiceId}, ${ret.return_id}, 'REVOKE', ${-pointsRevoked}, ${balance})
        `.execute(trx);
      }

      // Step 2 — give redeemed points back AS POINTS, and reduce the money refund
      // by their value. This is the step that closes the points-to-cash loophole.
      pointsRestored = Math.floor(redeemed * share);
      if (pointsRestored > 0) {
        balance += pointsRestored;
        await sql`
          INSERT INTO loyalty_transactions (customer_id, invoice_id, sales_return_id, txn_type, points, balance_after)
          VALUES (${invoice.customer_id}, ${invoiceId}, ${ret.return_id}, 'RESTORE', ${pointsRestored}, ${balance})
        `.execute(trx);
        const pointValue = Number(settings.loyalty_point_value_rupees) || 1;
        cashRefund = round2(Math.max(cashRefund - pointsRestored * pointValue, 0));
      }

      if (pointsRevoked || pointsRestored) {
        await sql`UPDATE customers SET loyalty_points_balance = ${Math.max(balance, 0)} WHERE customer_id = ${invoice.customer_id}`.execute(trx);
      }

      // Step 3 — the remaining money portion.
      //
      // Whatever was bought on credit is written off the customer's balance rather
      // than paid out: they never parted with that money, so there is nothing to
      // give back. Only the part actually settled in cash/UPI/card can leave the
      // drawer, and the refund method the clerk chose applies to that part alone.
      const creditToSettle = Math.min(creditPortion, cashRefund);
      if (creditToSettle > 0 || refundMethod === 'CREDIT') {
        storeCredit = round2(refundMethod === 'CREDIT' ? cashRefund : creditToSettle);
        cashRefund = round2(cashRefund - storeCredit);

        await postCredit(trx, {
          customerId: invoice.customer_id, branchId: invoice.branch_id,
          entryType: 'REFUND_ADJUSTMENT', amount: -storeCredit,
          refTable: 'sales_returns', refId: ret.return_id,
        });
      }

      if (customer.phone) {
        await queueMessage(trx, {
          to_phone: customer.phone, customer_id: invoice.customer_id, invoice_id: invoiceId,
          message_type: creditNoteNumber ? 'CREDIT_NOTE' : 'INVOICE_PDF',
          body: creditNoteNumber
            ? `Credit note ${creditNoteNumber} has been issued against invoice ${invoice.invoice_number} for ₹${returnedValue.toFixed(2)}.`
            : `Your return against ${invoice.invoice_number} has been processed. Refund: ₹${cashRefund.toFixed(2)}.` });
      }
    }

    // ── The drawer (3.3.1) ──────────────────────────────────────────────────
    // Cash handed back across the counter physically leaves the till. Recording the
    // refund without a till event left the shift expecting money that had already
    // gone, so every close after a cash refund read short by exactly that amount
    // and the cashier wore the variance. A void already reversed its cash this way;
    // a return has to as well.
    let tillCashReversed = 0;
    if (cashRefund > 0 && refundMethod === 'CASH' && tillSessionId) {
      await sql`
        INSERT INTO till_events (session_id, event_type, amount, ref_table, ref_id, note)
        VALUES (${tillSessionId}, 'CASH_SALE', ${-cashRefund}, 'sales_returns', ${ret.return_id},
                ${'Cash refund against ' + (invoice.invoice_number ?? invoiceId)})
      `.execute(trx);
      tillCashReversed = cashRefund;
    }

    // Spread the money refund across the return lines in proportion to their value.
    for (const p of prepared) {
      const computed = computeReturnLine(p.line, p.qty_base_unit);
      const lineShare = returnedValue > 0 ? computed.line_total / returnedValue : 0;
      await sql`
        INSERT INTO sales_return_lines (return_id, invoice_line_id, qty_base_unit, condition,
                                        points_earned_reversed, points_redeemed_restored, cash_refund_amount)
        VALUES (${ret.return_id}, ${p.invoice_line_id}, ${p.qty_base_unit}, ${p.condition}::return_line_condition,
                ${Math.round(pointsRevoked * lineShare)}, ${Math.round(pointsRestored * lineShare)},
                ${round2(cashRefund * lineShare)})
      `.execute(trx);
    }

    await sql`
      UPDATE sales_returns SET refund_total = ${cashRefund}, store_credit_total = ${storeCredit}
       WHERE return_id = ${ret.return_id}
    `.execute(trx);

    await audit(trx, session, creditNoteId ? 'CREDIT_NOTE_ISSUED' : 'REFUND', 'sales_returns', ret.return_id,
      { after: { invoice_id: invoiceId, returned_value: returnedValue, cash_refund: cashRefund,
                 store_credit: storeCredit, points_revoked: pointsRevoked, points_restored: pointsRestored,
                 credit_note_number: creditNoteNumber, window_override_by: windowOverrideBy,
                 refund_method: refundMethod, till_session_id: tillSessionId,
                 till_cash_reversed: tillCashReversed },
               });

    return {
      return_id: ret.return_id,
      credit_note_id: creditNoteId,
      credit_note_number: creditNoteNumber,
      returned_value: returnedValue,
      points_earned_reversed: pointsRevoked,
      points_redeemed_restored: pointsRestored,
      cash_refund_amount: cashRefund,
      store_credit_amount: storeCredit,
      refund_method: refundMethod,
      credit_settled: storeCredit,
      till_session_id: tillSessionId,
      till_cash_reversed: tillCashReversed,
      till_note: cashRefund > 0 && refundMethod === 'CASH' && !tillSessionId
        ? 'No till session was given, so this cash refund is not reflected in any drawer count. Pass till_session_id to keep the shift reconciliation correct.'
        : null,
      refund_note: creditPortion > 0
        ? 'The portion originally bought on credit has been taken off the customer\'s balance rather than paid out.'
        : null,
      gst_note: creditNoteNumber
        ? 'Report this credit note in GSTR-1 for the period it was issued.'
        : 'Non-GST sale — no credit note is required.',
      };
  }));

  // ── Credit notes (12.1.1, and the GSTR-1 outward-supply reduction) ────────
  app.get('/credit-notes', guarded('view_returns', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT cn.*, i.invoice_number, i.branch_id, b.name AS branch_name,
             c.name AS customer_name, c.gstin AS customer_gstin
        FROM credit_notes cn
        JOIN invoices i ON i.invoice_id = cn.invoice_id
        JOIN branches b ON b.branch_id = i.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
       WHERE 1=1 ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         ${q.from ? sql`AND cn.created_at >= ${q.from}::timestamptz` : sql``}
         ${q.to ? sql`AND cn.created_at < (${q.to}::date + 1)` : sql``}
       ORDER BY cn.created_at DESC LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
  }));

  // ── Warranty (12.2) ───────────────────────────────────────────────────────
  app.get('/warranty-claims', guarded('view_returns', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT wc.*, p.name AS product_name, i.invoice_number, i.branch_id, b.name AS branch_name,
             c.name AS customer_name, c.phone AS customer_phone,
             v.name AS vendor_name, ss.serial_number
        FROM warranty_claims wc
        JOIN invoice_lines il ON il.line_id = wc.invoice_line_id
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN branches b ON b.branch_id = i.branch_id
        JOIN products p ON p.product_id = il.product_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN vendors v ON v.vendor_id = wc.vendor_id
        LEFT JOIN stock_serials ss ON ss.serial_id = wc.serial_id
       WHERE 1=1 ${q.status ? sql`AND wc.status = ${q.status}::warranty_claim_status` : sql``}
       ORDER BY wc.claim_date DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.post('/warranty-claims', guarded('manage_warranty_claim', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const invoiceLineId = uuid(body.invoice_line_id, 'Invoice line');

    const line = (await sql<any>`
      SELECT il.*, i.server_received_at, i.branch_id, i.invoice_number, p.name AS product_name, p.category_id,
             w.duration_months
        FROM invoice_lines il
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN products p ON p.product_id = il.product_id
        LEFT JOIN LATERAL (
            SELECT duration_months FROM warranties
             WHERE product_id = p.product_id OR category_id = p.category_id
             ORDER BY (product_id IS NOT NULL) DESC LIMIT 1
        ) w ON TRUE
       WHERE il.line_id = ${invoiceLineId}
    `.execute(trx)).rows[0];
    if (!line) throw notFound('That sale line was not found at your branch.');
    if (!line.duration_months) throw badRequest(`"${line.product_name}" has no warranty term on file.`);

    // The claim is checked against the warranty period as of the sale date, not
    // as of today's catalog settings.
    const soldAt = new Date(line.server_received_at);
    const expiry = new Date(soldAt);
    expiry.setMonth(expiry.getMonth() + Number(line.duration_months));
    if (Date.now() > expiry.getTime()) {
      throw badRequest(`The ${line.duration_months}-month warranty on "${line.product_name}" expired on ${expiry.toLocaleDateString('en-IN')}.`);
    }

    const rma = await nextNumber(trx, line.branch_id, 'RMA');
    const claim = (await sql<any>`
      INSERT INTO warranty_claims (invoice_line_id, serial_id, rma_number, vendor_id, status)
      VALUES (${invoiceLineId}, ${optionalUuid(body.serial_id, 'serial_id')}, ${rma},
              ${optionalUuid(body.vendor_id, 'vendor_id')}, 'OPEN')
      RETURNING *
    `.execute(trx)).rows[0];

    if (body.serial_id) {
      await sql`UPDATE stock_serials SET status = 'WARRANTY_CLAIM' WHERE serial_id = ${uuid(body.serial_id, 'serial_id')}`.execute(trx);
    }
    return { ...claim, warranty_expires_on: expiry.toISOString().slice(0, 10) };
  }));

  app.put('/warranty-claims/:id', guarded('manage_warranty_claim', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'claim_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const status = oneOf(body.status, 'Status',
      ['OPEN', 'SENT_TO_VENDOR', 'REPLACED', 'REPAIRED', 'REFUNDED', 'REJECTED'] as const);
    const terminal = ['REPLACED', 'REPAIRED', 'REFUNDED', 'REJECTED'].includes(status);

    const before = (await sql<any>`
      SELECT status, vendor_id FROM warranty_claims WHERE claim_id = ${id}
    `.execute(trx)).rows[0];
    if (!before) throw notFound('That warranty claim was not found at your branch.');

    await sql`
      UPDATE warranty_claims
         SET status = ${status}::warranty_claim_status,
             vendor_id = COALESCE(${optionalUuid(body.vendor_id, 'vendor_id')}, vendor_id),
             resolved_at = ${terminal ? sql`now()` : null}
       WHERE claim_id = ${id}
    `.execute(trx);
    // Logged as WARRANTY_CLAIM_UPDATED, not REFUND: labelling every claim update a
    // refund made the audit trail read as if the shop were paying money out each
    // time a claim moved to "sent to vendor".
    await audit(trx, session, 'WARRANTY_CLAIM_UPDATED', 'warranty_claims', id,
      { before: { status: before.status }, after: { status } });
    return { ok: true, claim_id: id, status };
  }));
}
