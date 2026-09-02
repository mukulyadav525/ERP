// ============================================================================
// Section 13 — Reporting & Analytics (+ Section 14 accounting exports)
//
// Every endpoint runs inside the caller's RLS-scoped transaction, so a Branch
// Manager's "chain" report is automatically their own branch's numbers and an
// Accountant cannot read another branch's revenue. The chain-wide comparisons
// are gated behind view_chain_reports, which only the Owner holds.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { guarded, uuid, resolveBranchScope, oneOf, limit as clampLimit } from '../../lib/http.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { loadSettings, canSeeCost } from '../../lib/settings.js';
import { round2, fiscalYear } from '../../lib/tax.js';

function days(value: unknown, fallback = 90): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 730) : fallback;
}

export default async function reportsRoutes(app: FastifyInstance) {
  /** The headline tiles on the dashboard, with a like-for-like previous period. */
  app.get('/dashboard', guarded('view_dashboard', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const n = days(q.days, 30);
    const settings = await loadSettings(trx, session.branch_id);

    const [current, previous, lowStock, dues, pendingApprovals, openTills] = await Promise.all([
      sql<any>`
        SELECT COALESCE(SUM(grand_total), 0) AS revenue, COUNT(*) AS invoice_count,
               COALESCE(AVG(grand_total), 0) AS avg_ticket,
               COALESCE(SUM(cgst_total + sgst_total + igst_total), 0) AS tax_collected
          FROM invoices WHERE status = 'FINAL'
           AND server_received_at >= now() - make_interval(days => ${n})
           ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
      sql<any>`
        SELECT COALESCE(SUM(grand_total), 0) AS revenue, COUNT(*) AS invoice_count
          FROM invoices WHERE status = 'FINAL'
           AND server_received_at >= now() - make_interval(days => ${n * 2})
           AND server_received_at <  now() - make_interval(days => ${n})
           ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
      sql<any>`
        SELECT COUNT(*) AS count FROM branch_stock bs
          JOIN products p ON p.product_id = bs.product_id AND p.is_active
         WHERE bs.base_unit_qty <= COALESCE(bs.reorder_min, 0)
           ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
      `.execute(trx),
      sql<any>`
        WITH latest AS (
          SELECT DISTINCT ON (customer_id) customer_id, balance_after
            FROM customer_credit_ledger ORDER BY customer_id, created_at DESC, entry_id DESC
        )
        SELECT COALESCE(SUM(balance_after), 0) AS total_due,
               COUNT(*) FILTER (WHERE balance_after > 0) AS customers_with_balance
          FROM latest WHERE balance_after > 0
      `.execute(trx),
      sql<any>`
        SELECT COUNT(*) AS count FROM expenses WHERE status = 'PENDING'
         ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
      sql<any>`
        SELECT COUNT(*) AS count FROM till_sessions WHERE status = 'OPEN'
         ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
    ]);

    const cur = current.rows[0];
    const prev = previous.rows[0];
    const change = (a: number, b: number) => (b > 0 ? round2(((a - b) / b) * 100) : null);

    return {
      period_days: n,
      revenue: Number(cur.revenue),
      revenue_change_pct: change(Number(cur.revenue), Number(prev.revenue)),
      invoice_count: Number(cur.invoice_count),
      invoice_count_change_pct: change(Number(cur.invoice_count), Number(prev.invoice_count)),
      avg_ticket: round2(Number(cur.avg_ticket)),
      tax_collected: Number(cur.tax_collected),
      low_stock_items: Number(lowStock.rows[0].count),
      total_outstanding: Number(dues.rows[0].total_due),
      customers_with_balance: Number(dues.rows[0].customers_with_balance),
      pending_expense_approvals: Number(pendingApprovals.rows[0].count),
      open_till_sessions: Number(openTills.rows[0].count),
      cost_visible: canSeeCost(session.role, settings),
    };
  }));

  app.get('/sales-trend', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const n = days(q.days, 90);
    const grain = oneOf(q.grain ?? 'day', 'grain', ['day', 'week', 'month'] as const);
    return (await sql<any>`
      SELECT to_char(date_trunc(${grain}, i.server_received_at), 'YYYY-MM-DD') AS period,
             i.branch_id, b.name AS branch_name,
             SUM(i.grand_total) AS revenue, COUNT(*) AS invoice_count,
             SUM(i.cgst_total + i.sgst_total + i.igst_total) AS tax
        FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
       WHERE i.status = 'FINAL' AND i.server_received_at >= now() - make_interval(days => ${n})
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY 1, 2, 3 ORDER BY 1
    `.execute(trx)).rows;
  }));

  app.get('/branch-comparison', guarded('view_chain_reports', async ({ db: trx, req }) => {
    const n = days((req.query as any)?.days, 90);
    return (await sql<any>`
      SELECT b.branch_id, b.name AS branch_name,
             COALESCE(SUM(i.grand_total), 0) AS revenue,
             COUNT(i.invoice_id) AS invoice_count,
             COALESCE(AVG(i.grand_total), 0) AS avg_ticket,
             COALESCE((SELECT SUM(amount) FROM expenses e
                        WHERE e.branch_id = b.branch_id AND e.status = 'APPROVED'
                          AND e.created_at >= now() - make_interval(days => ${n})), 0) AS expenses,
             COALESCE((SELECT SUM(bs.base_unit_qty * bs.weighted_avg_cost) FROM branch_stock bs
                        WHERE bs.branch_id = b.branch_id), 0) AS stock_value
        FROM branches b
        LEFT JOIN invoices i ON i.branch_id = b.branch_id AND i.status = 'FINAL'
             AND i.server_received_at >= now() - make_interval(days => ${n})
       WHERE b.is_active
       GROUP BY b.branch_id, b.name ORDER BY revenue DESC
    `.execute(trx)).rows;
  }));

  app.get('/category-breakdown', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const n = days(q.days, 90);
    return (await sql<any>`
      SELECT COALESCE(c.name, 'Uncategorised') AS category_name,
             SUM(il.line_total) AS revenue, SUM(il.base_unit_qty) AS qty_sold,
             COUNT(DISTINCT i.invoice_id) AS invoice_count
        FROM invoice_lines il
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN products p ON p.product_id = il.product_id
        LEFT JOIN categories c ON c.category_id = p.category_id
       WHERE i.status = 'FINAL' AND i.server_received_at >= now() - make_interval(days => ${n})
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY 1 ORDER BY revenue DESC
    `.execute(trx)).rows;
  }));

  app.get('/payment-mode-split', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const n = days(q.days, 90);
    return (await sql<any>`
      SELECT ip.method, SUM(ip.amount) AS total, COUNT(*) AS txn_count
        FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
       WHERE i.status = 'FINAL' AND i.server_received_at >= now() - make_interval(days => ${n})
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY ip.method ORDER BY total DESC
    `.execute(trx)).rows;
  }));

  app.get('/top-products', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const n = days(q.days, 90);
    return (await sql<any>`
      SELECT p.product_id, p.name AS product_name, p.sku, c.name AS category_name,
             SUM(il.line_total) AS revenue, SUM(il.base_unit_qty) AS qty_sold
        FROM invoice_lines il
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN products p ON p.product_id = il.product_id
        LEFT JOIN categories c ON c.category_id = p.category_id
       WHERE i.status = 'FINAL' AND i.server_received_at >= now() - make_interval(days => ${n})
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY p.product_id, p.name, p.sku, c.name
       ORDER BY ${q.order === 'qty' ? sql`qty_sold` : sql`revenue`} DESC
       LIMIT ${clampLimit(q.limit, 10, 100)}
    `.execute(trx)).rows;
  }));

  /**
   * 2.6 — margin by product/category/branch. The requirement makes cost data a
   * field-level permission, so this endpoint is gated on view_cost_price rather
   * than on view_reports: an Accountant can see revenue but not margin unless the
   * Owner grants it.
   */
  app.get('/margin', guarded(null, async ({ session, db: trx, req }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!canSeeCost(session.role, settings)) {
      throw forbidden('Margin figures include purchase cost, which your role cannot view. An Owner can grant this under Admin → Settings → Catalog.');
    }
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const n = days(q.days, 90);
    const groupBy = oneOf(q.group_by ?? 'category', 'group_by', ['category', 'product', 'branch'] as const);

    // COGS uses the cost snapshotted on the stock ledger at the moment of sale,
    // not today's weighted average — otherwise a later purchase at a different
    // price would retroactively rewrite last month's margin.
    return (await sql<any>`
      SELECT ${groupBy === 'category' ? sql`COALESCE(c.name, 'Uncategorised')`
             : groupBy === 'product' ? sql`p.name`
             : sql`b.name`} AS group_name,
             SUM(il.taxable_value) AS revenue,
             SUM(il.base_unit_qty * COALESCE(ABS(sl.cost_at_movement), 0)) AS cogs,
             SUM(il.taxable_value) - SUM(il.base_unit_qty * COALESCE(ABS(sl.cost_at_movement), 0)) AS margin_amount,
             CASE WHEN SUM(il.taxable_value) > 0
                  THEN round(((SUM(il.taxable_value) - SUM(il.base_unit_qty * COALESCE(ABS(sl.cost_at_movement), 0)))
                              / SUM(il.taxable_value)) * 100, 2) END AS margin_pct
        FROM invoice_lines il
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN products p ON p.product_id = il.product_id
        JOIN branches b ON b.branch_id = i.branch_id
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN LATERAL (
            SELECT cost_at_movement FROM stock_ledger
             WHERE ref_table = 'invoices' AND ref_id = i.invoice_id AND product_id = il.product_id
             LIMIT 1
        ) sl ON TRUE
       WHERE i.status = 'FINAL' AND i.server_received_at >= now() - make_interval(days => ${n})
         ${q.branch_id ? sql`AND i.branch_id = ${uuid(q.branch_id, 'branch_id')}` : sql``}
       GROUP BY 1 ORDER BY revenue DESC LIMIT 200
    `.execute(trx)).rows;
  }));

  app.get('/slow-moving', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const rows = (await sql<any>`
      SELECT p.name AS product_name, p.sku, b.name AS branch_name,
             bs.base_unit_qty AS qty_on_hand, bs.weighted_avg_cost,
             bs.base_unit_qty * bs.weighted_avg_cost AS tied_up_value, ls.last_sale
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id AND p.is_active
        JOIN branches b ON b.branch_id = bs.branch_id
        LEFT JOIN LATERAL (
            SELECT MAX(created_at) AS last_sale FROM stock_ledger sl
             WHERE sl.product_id = bs.product_id AND sl.branch_id = bs.branch_id AND sl.movement_type = 'SALE'
        ) ls ON TRUE
       WHERE bs.base_unit_qty > 0 ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
       ORDER BY ls.last_sale ASC NULLS FIRST LIMIT ${clampLimit(q.limit, 20, 100)}
    `.execute(trx)).rows;
    return showCost ? rows : rows.map(({ weighted_avg_cost, tied_up_value, ...r }: any) => r);
  }));

  app.get('/stock-value', guarded('view_cost_price', async ({ db: trx }) =>
    (await sql<any>`
      SELECT b.name AS branch_name, b.branch_id,
             SUM(bs.base_unit_qty * bs.weighted_avg_cost) AS stock_value,
             COUNT(*) AS sku_count,
             SUM(bs.base_unit_qty) AS total_units
        FROM branch_stock bs JOIN branches b ON b.branch_id = bs.branch_id
       GROUP BY b.branch_id, b.name ORDER BY stock_value DESC
    `.execute(trx)).rows));

  app.get('/expense-vs-revenue', guarded('view_financial_reports', async ({ session, db: trx, req }) => {
    const branchId = resolveBranchScope(session, (req.query as any)?.branch_id);
    return (await sql<any>`
      WITH rev AS (
        SELECT to_char(server_received_at, 'YYYY-MM') AS month, branch_id, SUM(grand_total) AS revenue
          FROM invoices WHERE status = 'FINAL' ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2
      ), exp AS (
        SELECT to_char(created_at, 'YYYY-MM') AS month, branch_id, SUM(amount) AS expenses
          FROM expenses WHERE status = 'APPROVED' ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2
      )
      SELECT COALESCE(rev.month, exp.month) AS month, b.name AS branch_name,
             COALESCE(rev.revenue, 0) AS revenue, COALESCE(exp.expenses, 0) AS expenses,
             COALESCE(rev.revenue, 0) - COALESCE(exp.expenses, 0) AS net
        FROM rev FULL OUTER JOIN exp ON rev.month = exp.month AND rev.branch_id = exp.branch_id
        JOIN branches b ON b.branch_id = COALESCE(rev.branch_id, exp.branch_id)
       ORDER BY 1
    `.execute(trx)).rows;
  }));

  app.get('/attendance-summary', guarded('view_hr', async ({ session, db: trx, req }) => {
    const branchId = resolveBranchScope(session, (req.query as any)?.branch_id);
    const n = days((req.query as any)?.days, 30);
    return (await sql<any>`
      SELECT u.full_name, b.name AS branch_name, COUNT(*) AS present_days,
             ROUND(AVG(EXTRACT(EPOCH FROM (a.check_out - a.check_in)) / 3600)::numeric, 1) AS avg_hours
        FROM attendance a
        JOIN employees e ON e.employee_id = a.employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE a.work_date >= CURRENT_DATE - ${n}::int
         ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
       GROUP BY u.full_name, b.name ORDER BY present_days DESC
    `.execute(trx)).rows;
  }));

  app.get('/sales-by-employee', guarded('view_reports', async ({ session, db: trx, req }) => {
    const branchId = resolveBranchScope(session, (req.query as any)?.branch_id);
    const n = days((req.query as any)?.days, 90);
    return (await sql<any>`
      SELECT u.full_name, b.name AS branch_name, SUM(i.grand_total) AS revenue,
             COUNT(*) AS invoice_count, ROUND(AVG(i.grand_total), 2) AS avg_ticket
        FROM invoices i
        JOIN employees e ON e.employee_id = i.sold_by_employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE i.status = 'FINAL' AND i.server_received_at >= now() - make_interval(days => ${n})
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY u.full_name, b.name ORDER BY revenue DESC
    `.execute(trx)).rows;
  }));

  // ── GST (15, and Section 14 filing exports) ───────────────────────────────
  /**
   * GSTR-1 outward supply summary. Two things make this correct rather than
   * merely plausible: credit notes are subtracted in the period they were ISSUED
   * (not the period of the original invoice), and B2B (customer has a GSTIN) is
   * separated from B2C, because GSTR-1 reports them in different tables.
   */
  app.get('/gst-summary', guarded('view_gst_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const [outward, creditNotes, hsn] = await Promise.all([
      sql<any>`
        SELECT to_char(i.server_received_at, 'YYYY-MM') AS month,
               CASE WHEN c.gstin IS NOT NULL AND c.gstin <> '' THEN 'B2B' ELSE 'B2C' END AS supply_type,
               SUM(i.subtotal) AS taxable_value, SUM(i.cgst_total) AS cgst,
               SUM(i.sgst_total) AS sgst, SUM(i.igst_total) AS igst,
               COUNT(*) AS invoice_count
          FROM invoices i LEFT JOIN customers c ON c.customer_id = i.customer_id
         WHERE i.status = 'FINAL' AND i.invoice_type = 'GST'
           ${q.from ? sql`AND i.server_received_at >= ${q.from}::timestamptz` : sql``}
           ${q.to ? sql`AND i.server_received_at < (${q.to}::date + 1)` : sql``}
         GROUP BY 1, 2 ORDER BY 1, 2
      `.execute(trx),
      sql<any>`
        SELECT to_char(cn.created_at, 'YYYY-MM') AS month,
               SUM(cnl.taxable_value) AS taxable_value, SUM(cnl.cgst_amount) AS cgst,
               SUM(cnl.sgst_amount) AS sgst, SUM(cnl.igst_amount) AS igst,
               COUNT(DISTINCT cn.credit_note_id) AS credit_note_count
          FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.credit_note_id
         WHERE 1=1
           ${q.from ? sql`AND cn.created_at >= ${q.from}::timestamptz` : sql``}
           ${q.to ? sql`AND cn.created_at < (${q.to}::date + 1)` : sql``}
         GROUP BY 1 ORDER BY 1
      `.execute(trx),
      sql<any>`
        SELECT p.hsn_code, SUM(il.base_unit_qty) AS qty, SUM(il.taxable_value) AS taxable_value,
               SUM(il.cgst_amount) AS cgst, SUM(il.sgst_amount) AS sgst, SUM(il.igst_amount) AS igst
          FROM invoice_lines il
          JOIN invoices i ON i.invoice_id = il.invoice_id
          JOIN products p ON p.product_id = il.product_id
         WHERE i.status = 'FINAL' AND i.invoice_type = 'GST'
           ${q.from ? sql`AND i.server_received_at >= ${q.from}::timestamptz` : sql``}
           ${q.to ? sql`AND i.server_received_at < (${q.to}::date + 1)` : sql``}
         GROUP BY p.hsn_code ORDER BY taxable_value DESC
      `.execute(trx),
    ]);

    return {
      fiscal_year: fiscalYear(),
      // An Accountant is pinned to a branch, so row-level security scopes this
      // report to that branch. Saying so matters: a return filed from a figure
      // that silently omitted three other branches is a compliance problem, and
      // nothing on the page would otherwise reveal it.
      scope: session.role === 'OWNER_ADMIN' ? 'CHAIN_WIDE' : 'SINGLE_BRANCH',
      scope_note: session.role === 'OWNER_ADMIN'
        ? 'Chain-wide: every branch is included.'
        : 'These figures cover your branch only. A chain-wide GST return must be produced from the Owner account.',
      outward_supplies: outward.rows,
      credit_notes: creditNotes.rows,
      hsn_summary: hsn.rows,
      note: 'Credit notes reduce outward supply in the period they were issued, not the period of the original invoice.',
    };
  }));

  /** 4.5.1 — the purchase-side view: ITC claimed, and the debit notes reversing it. */
  app.get('/itc-summary', guarded('view_gst_reports', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    // Purchases and reversals are aggregated separately and then joined on
    // (month, vendor). A correlated subquery inside the grouped SELECT cannot
    // reference the ungrouped receipt date, and reversals belong to the period the
    // debit note was ISSUED anyway, not the period of the original receipt.
    return (await sql<any>`
      WITH purchases AS (
        SELECT to_char(g.received_at, 'YYYY-MM') AS month, g.vendor_id,
               SUM(gl.qty_base_unit * gl.rate) AS purchase_value
          FROM grn g JOIN grn_lines gl ON gl.grn_id = g.grn_id
         WHERE 1=1
           ${q.from ? sql`AND g.received_at >= ${q.from}::timestamptz` : sql``}
           ${q.to ? sql`AND g.received_at < (${q.to}::date + 1)` : sql``}
         GROUP BY 1, 2
      ), reversals AS (
        SELECT to_char(dn.created_at, 'YYYY-MM') AS month, dn.vendor_id,
               SUM(dn.total_amount) AS itc_reversed
          FROM vendor_debit_notes dn
         WHERE 1=1
           ${q.from ? sql`AND dn.created_at >= ${q.from}::timestamptz` : sql``}
           ${q.to ? sql`AND dn.created_at < (${q.to}::date + 1)` : sql``}
         GROUP BY 1, 2
      )
      SELECT COALESCE(p.month, r.month) AS month, v.name AS vendor_name, v.gstin,
             COALESCE(p.purchase_value, 0) AS purchase_value,
             COALESCE(r.itc_reversed, 0) AS itc_reversed,
             COALESCE(p.purchase_value, 0) - COALESCE(r.itc_reversed, 0) AS net_purchase_value
        FROM purchases p
        FULL OUTER JOIN reversals r ON r.month = p.month AND r.vendor_id = p.vendor_id
        JOIN vendors v ON v.vendor_id = COALESCE(p.vendor_id, r.vendor_id)
       ORDER BY month DESC, purchase_value DESC
    `.execute(trx)).rows;
  }));

  /**
   * Section 14 — the dated export bundle a CA or Tally import actually needs.
   * Returned as rows the client turns into CSV, so the same endpoint serves both
   * an on-screen preview and a download.
   */
  app.get('/accounting-export', guarded('export_accounting', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (!q.from || !q.to) throw badRequest('Choose a date range (from and to) for the export.');
    const kind = oneOf(q.kind ?? 'sales', 'kind',
      ['sales', 'purchases', 'credit_notes', 'expenses', 'payments'] as const);

    switch (kind) {
      case 'sales':
        return (await sql<any>`
          SELECT i.invoice_number, i.server_received_at AS invoice_date, b.name AS branch,
                 COALESCE(c.name, 'Cash Sale') AS party, c.gstin AS party_gstin,
                 i.invoice_type, i.subtotal AS taxable_value, i.cgst_total, i.sgst_total, i.igst_total,
                 i.round_off, i.grand_total, i.place_of_supply_state_code AS place_of_supply
            FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
            LEFT JOIN customers c ON c.customer_id = i.customer_id
           WHERE i.status = 'FINAL' AND i.server_received_at >= ${q.from}::timestamptz
             AND i.server_received_at < (${q.to}::date + 1)
           ORDER BY i.server_received_at
        `.execute(trx)).rows;
      case 'purchases':
        return (await sql<any>`
          SELECT g.grn_number, g.received_at AS grn_date, b.name AS branch, v.name AS vendor, v.gstin AS vendor_gstin,
                 SUM(gl.qty_base_unit * gl.rate) AS purchase_value
            FROM grn g JOIN grn_lines gl ON gl.grn_id = g.grn_id
            JOIN vendors v ON v.vendor_id = g.vendor_id JOIN branches b ON b.branch_id = g.branch_id
           WHERE g.received_at >= ${q.from}::timestamptz AND g.received_at < (${q.to}::date + 1)
           GROUP BY g.grn_number, g.received_at, b.name, v.name, v.gstin ORDER BY g.received_at
        `.execute(trx)).rows;
      case 'credit_notes':
        return (await sql<any>`
          SELECT cn.credit_note_number, cn.created_at AS note_date, i.invoice_number AS against_invoice,
                 b.name AS branch, COALESCE(c.name, 'Cash Sale') AS party, c.gstin AS party_gstin,
                 SUM(cnl.taxable_value) AS taxable_value, SUM(cnl.cgst_amount) AS cgst,
                 SUM(cnl.sgst_amount) AS sgst, SUM(cnl.igst_amount) AS igst, cn.total_amount
            FROM credit_notes cn
            JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.credit_note_id
            JOIN invoices i ON i.invoice_id = cn.invoice_id
            JOIN branches b ON b.branch_id = i.branch_id
            LEFT JOIN customers c ON c.customer_id = i.customer_id
           WHERE cn.created_at >= ${q.from}::timestamptz AND cn.created_at < (${q.to}::date + 1)
           GROUP BY cn.credit_note_number, cn.created_at, i.invoice_number, b.name, c.name, c.gstin, cn.total_amount
           ORDER BY cn.created_at
        `.execute(trx)).rows;
      case 'expenses':
        return (await sql<any>`
          SELECT e.created_at AS expense_date, b.name AS branch, ec.name AS category,
                 e.amount, e.description, e.status, u.full_name AS approved_by
            FROM expenses e JOIN expense_categories ec ON ec.category_id = e.category_id
            JOIN branches b ON b.branch_id = e.branch_id
            LEFT JOIN users u ON u.user_id = e.approved_by
           WHERE e.created_at >= ${q.from}::timestamptz AND e.created_at < (${q.to}::date + 1)
           ORDER BY e.created_at
        `.execute(trx)).rows;
      case 'payments':
        return (await sql<any>`
          SELECT i.invoice_number, i.server_received_at AS invoice_date, b.name AS branch,
                 ip.method, ip.amount, ip.ref_no
            FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
            JOIN branches b ON b.branch_id = i.branch_id
           WHERE i.status = 'FINAL' AND i.server_received_at >= ${q.from}::timestamptz
             AND i.server_received_at < (${q.to}::date + 1)
           ORDER BY i.server_received_at
        `.execute(trx)).rows;
    }
  }));

  /** Section 14 — the daily admin digest, also used by the scheduled WhatsApp job. */
  app.get('/daily-digest', guarded('view_reports', async ({ session, db: trx, req }) => {
    const branchId = resolveBranchScope(session, (req.query as any)?.branch_id);
    const [sales, lowStock, dues, transfers, conflicts] = await Promise.all([
      sql<any>`
        SELECT COALESCE(SUM(grand_total), 0) AS revenue, COUNT(*) AS invoice_count
          FROM invoices WHERE status = 'FINAL' AND server_received_at::date = CURRENT_DATE
           ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
      sql<any>`
        SELECT p.name, bs.base_unit_qty, bs.reorder_min, b.name AS branch_name
          FROM branch_stock bs JOIN products p ON p.product_id = bs.product_id AND p.is_active
          JOIN branches b ON b.branch_id = bs.branch_id
         WHERE bs.base_unit_qty <= COALESCE(bs.reorder_min, 0)
           ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
         ORDER BY bs.base_unit_qty LIMIT 20
      `.execute(trx),
      sql<any>`
        WITH latest AS (
          SELECT DISTINCT ON (customer_id) customer_id, balance_after
            FROM customer_credit_ledger ORDER BY customer_id, created_at DESC, entry_id DESC
        )
        SELECT COALESCE(SUM(balance_after), 0) AS total FROM latest WHERE balance_after > 0
      `.execute(trx),
      sql<any>`SELECT COUNT(*) AS count FROM stock_transfers WHERE status IN ('REQUESTED', 'DISPATCHED', 'TRANSFER_DISCREPANCY')`.execute(trx),
      sql<any>`SELECT COUNT(*) AS count FROM stock_conflicts WHERE status = 'OPEN'
                ${branchId ? sql`AND branch_id = ${branchId}` : sql``}`.execute(trx),
    ]);

    return {
      date: new Date().toISOString().slice(0, 10),
      todays_revenue: Number(sales.rows[0].revenue),
      todays_invoices: Number(sales.rows[0].invoice_count),
      low_stock: lowStock.rows,
      total_outstanding: Number(dues.rows[0].total),
      pending_transfers: Number(transfers.rows[0].count),
      open_stock_conflicts: Number(conflicts.rows[0].count),
    };
  }));
}
