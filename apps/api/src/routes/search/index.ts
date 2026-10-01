// ============================================================================
// Global search — one box over the records a counter actually looks things up by.
//
// Two rules govern this file, and they are the reason it is not just a UNION:
//
//  1. Every query runs inside the caller's RLS-scoped transaction, so branch
//     isolation is enforced by the database, not by a WHERE clause here. A branch
//     user searching an invoice number belonging to another branch gets nothing
//     back — the row is invisible to their transaction. Search must never become
//     the one place a record leaks.
//  2. Each result *type* is gated on the permission that guards its own screen.
//     A cashier cannot see vendors on /vendors, so vendors are not searched for a
//     cashier either; otherwise the result list becomes a read-only bypass of the
//     role matrix.
//
// The endpoint itself only requires a session (`guarded(null, …)`) because a
// blanket permission would either lock out roles that legitimately search their
// own records, or grant more than any single caller should see.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { guarded, limit as clampLimit, resolveBranchScope } from '../../lib/http.js';
import { canAccess } from '../../lib/rbac.js';

export type ResultType = 'invoice' | 'estimate' | 'customer' | 'vendor' | 'product'
  | 'payment' | 'receipt' | 'purchase_order' | 'purchase' | 'transfer' | 'credit_note';

export interface SearchHit {
  type: ResultType;
  id: string;
  /** The identifier a person searched by — invoice number, customer name, SKU. */
  title: string;
  subtitle: string | null;
  /** Right-hand column: an amount, a stock figure, a balance. Pre-formatted upstream? No —
   *  the raw number travels and the browser formats it, so one currency format governs. */
  amount: number | null;
  status: string | null;
  /** Where clicking goes. Deep links carry the id so the page can open the record. */
  href: string;
}

/** Postgres LIKE wildcards inside user input would otherwise make `%` match everything. */
function likeTerm(raw: string): string {
  return `%${raw.replace(/([\\%_])/g, '\\$1')}%`;
}

export default async function searchRoutes(app: FastifyInstance) {
  app.get('/', guarded(null, async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const raw = (q.q ?? '').trim().slice(0, 64);

    // One character matches most of the database and helps nobody; two is where a
    // SKU prefix or a bill number stub starts to mean something.
    if (raw.length < 2) return { query: raw, results: [] as SearchHit[] };

    const term = likeTerm(raw);
    const digits = raw.replace(/\D/g, '');
    const isNumeric = digits.length >= 2 && /^[\d\s+\-()]+$/.test(raw);
    const perType = clampLimit(q.limit, 5, 15);

    // An admin may narrow to one branch; every other role is already pinned to
    // theirs by RLS, and passing this through keeps search agreeing with the
    // branch selector in the top bar rather than quietly ignoring it.
    const branch = resolveBranchScope(session, q.branch_id ?? null);
    const branchFilter = branch ? sql`AND i.branch_id = ${branch}` : sql``;
    const branchFilterQ = branch ? sql`AND qt.branch_id = ${branch}` : sql``;

    const hits: SearchHit[] = [];

    // ── Invoices ────────────────────────────────────────────────────────────
    // Numeric input is the common case at a counter: someone reads the last four
    // digits off a printed bill. Customer name is included so "ABC Construction"
    // finds their bills, not only their customer record.
    if (canAccess(session.role, 'view_billing')) {
      const rows = await sql<any>`
        SELECT i.invoice_id, i.invoice_number, round(i.grand_total + i.round_off, 2) AS grand_total, i.status, i.server_received_at,
               c.name AS customer_name, b.name AS branch_name
          FROM invoices i
          LEFT JOIN customers c ON c.customer_id = i.customer_id
          LEFT JOIN branches  b ON b.branch_id  = i.branch_id
         WHERE i.status <> 'DRAFT'
           AND (i.invoice_number ILIKE ${term} ESCAPE '\'
                OR c.name ILIKE ${term} ESCAPE '\'
                OR c.phone ILIKE ${term} ESCAPE '\')
           ${branchFilter}
         ORDER BY i.server_received_at DESC
         LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'invoice',
          id: r.invoice_id,
          title: r.invoice_number ?? 'Draft bill',
          subtitle: [r.customer_name ?? 'Walk-in', r.branch_name].filter(Boolean).join(' · '),
          amount: Number(r.grand_total),
          status: r.status,
          href: `/billing?invoice=${r.invoice_id}`,
        });
      }
    }

    // ── Estimates / quotations ──────────────────────────────────────────────
    if (canAccess(session.role, 'view_quotations')) {
      const rows = await sql<any>`
        SELECT qt.quotation_id, qt.quotation_number, qt.status, qt.created_at, c.name AS customer_name
          FROM quotations qt
          JOIN customers c ON c.customer_id = qt.customer_id
         WHERE (qt.quotation_number ILIKE ${term} ESCAPE '\' OR c.name ILIKE ${term} ESCAPE '\')
           ${branchFilterQ}
         ORDER BY qt.created_at DESC
         LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'estimate',
          id: r.quotation_id,
          title: r.quotation_number,
          subtitle: r.customer_name,
          amount: null,
          status: r.status,
          href: `/quotations?quotation=${r.quotation_id}`,
        });
      }
    }

    // ── Customers ───────────────────────────────────────────────────────────
    if (canAccess(session.role, 'view_customers')) {
      const rows = await sql<any>`
        SELECT c.customer_id, c.name, c.phone, c.customer_type,
               COALESCE(bal.balance_after, 0) AS balance_owed
          FROM customers c
          LEFT JOIN LATERAL (
              SELECT balance_after FROM customer_credit_ledger
               WHERE customer_id = c.customer_id ORDER BY created_at DESC, entry_id DESC LIMIT 1
          ) bal ON TRUE
         WHERE c.name ILIKE ${term} ESCAPE '\'
            ${isNumeric ? sql`OR c.phone LIKE ${'%' + digits + '%'}` : sql``}
         ORDER BY c.name
         LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'customer',
          id: r.customer_id,
          title: r.name,
          subtitle: r.phone,
          amount: Number(r.balance_owed) > 0 ? Number(r.balance_owed) : null,
          status: Number(r.balance_owed) > 0 ? 'OUTSTANDING' : null,
          href: `/customers?customer=${r.customer_id}`,
        });
      }
    }

    // ── Vendors ─────────────────────────────────────────────────────────────
    if (canAccess(session.role, 'view_vendors')) {
      const rows = await sql<any>`
        SELECT vendor_id, name, phone, gstin FROM vendors
         WHERE is_active
           AND (name ILIKE ${term} ESCAPE '\'
                ${isNumeric ? sql`OR phone LIKE ${'%' + digits + '%'}` : sql``})
         ORDER BY name
         LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'vendor',
          id: r.vendor_id,
          title: r.name,
          subtitle: r.phone ?? r.gstin,
          amount: null,
          status: null,
          href: `/vendors?vendor=${r.vendor_id}`,
        });
      }
    }

    // ── Products, by name, SKU or barcode ───────────────────────────────────
    // The barcode match is exact, not a wildcard: a scanner sends a complete code
    // and a partial match on 13 digits would surface the wrong item at the till.
    if (canAccess(session.role, 'view_catalog')) {
      const rows = await sql<any>`
        SELECT DISTINCT ON (p.product_id)
               p.product_id, p.name, p.sku, p.base_unit,
               COALESCE(bs.base_unit_qty, 0) AS base_unit_qty,
               pb.barcode AS matched_barcode
          FROM products p
          LEFT JOIN product_barcodes pb
                 ON pb.product_id = p.product_id AND pb.barcode = ${raw}
          LEFT JOIN branch_stock bs
                 ON bs.product_id = p.product_id
                ${branch ? sql`AND bs.branch_id = ${branch}` : sql``}
         WHERE p.is_active
           AND (p.name ILIKE ${term} ESCAPE '\'
                OR p.sku ILIKE ${term} ESCAPE '\'
                OR pb.barcode IS NOT NULL)
         ORDER BY p.product_id, bs.base_unit_qty DESC NULLS LAST
         LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'product',
          id: r.product_id,
          title: r.name,
          subtitle: r.matched_barcode ? `${r.sku} · barcode ${r.matched_barcode}` : r.sku,
          amount: null,
          status: null,
          href: `/catalog?product=${r.product_id}`,
        });
      }
    }

    // ── Payment references (UTR, UPI txn id, card auth) → the bill they paid ──
    if (canAccess(session.role, 'view_billing') && raw.length >= 4) {
      const rows = await sql<any>`
        SELECT DISTINCT ON (i.invoice_id) i.invoice_id, i.invoice_number, ip.ref_no, ip.method, ip.amount
          FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
         WHERE ip.ref_no ILIKE ${term} ESCAPE '\' ${branchFilter}
         ORDER BY i.invoice_id LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'payment', id: r.invoice_id, title: r.ref_no,
          subtitle: `${String(r.method).replace('_', ' ')} on ${r.invoice_number}`,
          amount: Number(r.amount), status: null, href: `/billing?invoice=${r.invoice_id}`,
        });
      }
    }

    // ── Account receipts (RCT-…) ────────────────────────────────────────────
    if (canAccess(session.role, 'view_customer_outstanding')) {
      const rows = await sql<any>`
        SELECT cp.payment_id, cp.receipt_number, cp.amount, cp.reference, c.customer_id, c.name
          FROM customer_payments cp JOIN customers c ON c.customer_id = cp.customer_id
         WHERE (cp.receipt_number ILIKE ${term} ESCAPE '\' OR cp.reference ILIKE ${term} ESCAPE '\')
           ${branch ? sql`AND cp.branch_id = ${branch}` : sql``}
         ORDER BY cp.created_at DESC LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'receipt', id: r.payment_id, title: r.receipt_number,
          subtitle: [r.name, r.reference].filter(Boolean).join(' · '),
          amount: Number(r.amount), status: null, href: `/customers?customer=${r.customer_id}`,
        });
      }
    }

    // ── Purchase orders and goods receipts (by our number or the supplier's bill no.) ──
    if (canAccess(session.role, 'view_inventory')) {
      const pos = await sql<any>`
        SELECT po.po_id, po.po_number, po.status, v.name AS vendor_name
          FROM purchase_orders po JOIN vendors v ON v.vendor_id = po.vendor_id
         WHERE po.po_number ILIKE ${term} ESCAPE '\' ${branch ? sql`AND po.branch_id = ${branch}` : sql``}
         ORDER BY po.created_at DESC LIMIT ${perType}
      `.execute(trx);
      for (const r of pos.rows) {
        hits.push({
          type: 'purchase_order', id: r.po_id, title: r.po_number, subtitle: r.vendor_name,
          amount: null, status: r.status, href: `/inventory?tab=reorder&po=${r.po_id}`,
        });
      }
      const grns = await sql<any>`
        SELECT g.grn_id, g.grn_number, g.vendor_invoice_no, v.name AS vendor_name
          FROM grn g JOIN vendors v ON v.vendor_id = g.vendor_id
         WHERE (g.grn_number ILIKE ${term} ESCAPE '\' OR g.vendor_invoice_no ILIKE ${term} ESCAPE '\')
           ${branch ? sql`AND g.branch_id = ${branch}` : sql``}
         ORDER BY g.received_at DESC LIMIT ${perType}
      `.execute(trx);
      for (const r of grns.rows) {
        hits.push({
          type: 'purchase', id: r.grn_id, title: r.grn_number,
          subtitle: [r.vendor_name, r.vendor_invoice_no ? `bill ${r.vendor_invoice_no}` : null].filter(Boolean).join(' · '),
          amount: null, status: null, href: `/inventory?tab=purchases&grn=${r.grn_id}`,
        });
      }
      const transfers = await sql<any>`
        SELECT t.transfer_id, t.transfer_number, t.status, fb.name AS from_name, tb.name AS to_name
          FROM stock_transfers t JOIN branches fb ON fb.branch_id = t.from_branch_id
          JOIN branches tb ON tb.branch_id = t.to_branch_id
         WHERE t.transfer_number ILIKE ${term} ESCAPE '\'
         ORDER BY t.created_at DESC LIMIT ${perType}
      `.execute(trx);
      for (const r of transfers.rows) {
        hits.push({
          type: 'transfer', id: r.transfer_id, title: r.transfer_number, subtitle: `${r.from_name} → ${r.to_name}`,
          amount: null, status: r.status, href: `/inventory?tab=transfers&transfer=${r.transfer_id}`,
        });
      }
    }

    // ── Credit notes ─────────────────────────────────────────────────────────
    if (canAccess(session.role, 'view_returns')) {
      const rows = await sql<any>`
        SELECT cn.credit_note_id, cn.credit_note_number, cn.total_amount, i.invoice_id, i.invoice_number
          FROM credit_notes cn JOIN invoices i ON i.invoice_id = cn.invoice_id
         WHERE cn.credit_note_number ILIKE ${term} ESCAPE '\' ${branchFilter}
         ORDER BY cn.created_at DESC LIMIT ${perType}
      `.execute(trx);
      for (const r of rows.rows) {
        hits.push({
          type: 'credit_note', id: r.credit_note_id, title: r.credit_note_number, subtitle: `against ${r.invoice_number}`,
          amount: Number(r.total_amount), status: null, href: `/returns?tab=credit_notes`,
        });
      }
    }

    // An exact identifier match is what the searcher meant; rank it first rather
    // than leaving it wherever its type happened to land.
    const exact = raw.toLowerCase();
    hits.sort((a, b) => {
      const ax = a.title.toLowerCase() === exact ? 0 : 1;
      const bx = b.title.toLowerCase() === exact ? 0 : 1;
      return ax - bx;
    });

    return { query: raw, results: hits };
  }));
}
