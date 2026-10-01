// ============================================================================
// Section 13 — Reporting & Analytics (+ Section 14 accounting exports; spec §38–39)
//
// Every endpoint runs inside the caller's RLS-scoped transaction, so a Branch
// Manager's "chain" report is automatically their own branch's numbers and an
// Accountant cannot read another branch's revenue. The chain-wide comparisons
// are gated behind view_chain_reports, which only the Owner holds.
//
// Two conventions hold everywhere, so the same number reads the same on every
// screen:
//   * a bill's AMOUNT is grand_total + round_off — what the customer was asked
//     to pay and what the payments add up to. (grand_total alone is the GST
//     document total before cash rounding.)
//   * a period is [from, to] in the SHOP's calendar (the connection timezone),
//     inclusive of both days.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { guarded, uuid, resolveBranchScope, oneOf, limit as clampLimit } from '../../lib/http.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { loadSettings, canSeeCost } from '../../lib/settings.js';
import { round2, fiscalYear } from '../../lib/tax.js';
import type { Session } from '../../lib/session.js';
import { addDays, businessToday } from '../../lib/dates.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRESETS = ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'last_month',
  'last_30_days', 'last_90_days', 'this_fy', 'custom'] as const;

export interface Period { from: string; to: string; days: number; label: string; prev_from: string; prev_to: string }

/**
 * Resolves the requested period. Explicit from/to wins; then a named preset; then
 * the older rolling `days=N` (kept so bookmarks and scripts keep working).
 */
export function period(q: Record<string, string | undefined>, fallbackDays = 30): Period {
  const today = businessToday();
  let from: string, to: string, label: string;
  const preset = q.period ? oneOf(q.period, 'Period', PRESETS) : null;
  if (q.from || q.to) {
    from = q.from ?? today; to = q.to ?? today;
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw badRequest('Dates must be in YYYY-MM-DD format.');
    label = `${from} to ${to}`;
  } else if (preset && preset !== 'custom') {
    to = today;
    const d = new Date(`${today}T00:00:00Z`);
    switch (preset) {
      case 'today': from = today; label = 'Today'; break;
      case 'yesterday': from = addDays(today, -1); to = from; label = 'Yesterday'; break;
      case 'this_week': from = addDays(today, -((d.getUTCDay() + 6) % 7)); label = 'This week'; break;
      case 'last_7_days': from = addDays(today, -6); label = 'Last 7 days'; break;
      case 'this_month': from = `${today.slice(0, 7)}-01`; label = 'This month'; break;
      case 'last_month': {
        const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
        from = first.toISOString().slice(0, 10);
        to = addDays(`${today.slice(0, 7)}-01`, -1); label = 'Last month'; break;
      }
      case 'last_90_days': from = addDays(today, -89); label = 'Last 90 days'; break;
      case 'this_fy': {
        const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
        from = `${y}-04-01`; label = `FY ${fiscalYear(new Date(`${from}T00:00:00Z`))}`; break;
      }
      default: from = addDays(today, -29); label = 'Last 30 days';
    }
  } else {
    const n = Number(q.days);
    const days = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 730) : fallbackDays;
    to = today; from = addDays(today, -(days - 1)); label = `Last ${days} days`;
  }
  if (from > to) throw badRequest('The start date is after the end date.');
  const days = Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (days > 1100) throw badRequest('Choose a period of at most three years.');
  return { from, to, days, label, prev_to: addDays(from, -1), prev_from: addDays(from, -days) };
}

/** `col` falls within the period (inclusive of both days). */
const inPeriod = (col: ReturnType<typeof sql.ref> | ReturnType<typeof sql.raw>, p: { from: string; to: string }) =>
  sql`${col} >= ${p.from}::date AND ${col} < (${p.to}::date + 1)`;

function scope(session: Session, q: Record<string, string | undefined>) {
  return resolveBranchScope(session, q.branch_id);
}

export default async function reportsRoutes(app: FastifyInstance) {
  /** The headline tiles on the dashboard, with a like-for-like previous period. */
  app.get('/dashboard', guarded('view_dashboard', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const financial = ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'].includes(session.role);
    const bf = (col: string) => (branchId ? sql`AND ${sql.ref(col)} = ${branchId}` : sql``);

    const salesFor = (from: string, to: string, sameTimeOfDay = false) => sql<any>`
      SELECT COALESCE(SUM(grand_total + round_off), 0) AS revenue, COUNT(*) AS invoice_count,
             COALESCE(AVG(grand_total + round_off), 0) AS avg_ticket,
             COALESCE(SUM(cgst_total + sgst_total + igst_total), 0) AS tax_collected,
             COALESCE(SUM(subtotal), 0) AS taxable
        FROM invoices WHERE status = 'FINAL'
         AND ${sameTimeOfDay
           // The period runs to today, so today is not over: compare with the previous
           // period only up to the same time of day, not with its whole last day.
           ? sql`server_received_at >= ${from}::date AND server_received_at < ${to}::date + (now() - date_trunc('day', now()))`
           : inPeriod(sql.ref('server_received_at'), { from, to })} ${bf('branch_id')}
    `.execute(trx);
    const inProgress = p.to === businessToday();

    const [current, previous, returns, lowStock, dues, payables, pendingExp, openTills, drafts, expenses, cogs, conflicts, discrepancies] = await Promise.all([
      salesFor(p.from, p.to),
      salesFor(p.prev_from, p.prev_to, inProgress),
      sql<any>`
        SELECT COUNT(*) AS count, COALESCE(SUM(r.refund_total + r.store_credit_total), 0) AS value,
               COALESCE((SELECT SUM(cnl.cgst_amount + cnl.sgst_amount + cnl.igst_amount)
                           FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.credit_note_id
                           JOIN invoices ci ON ci.invoice_id = cn.invoice_id
                          WHERE ${inPeriod(sql.ref('cn.created_at'), p)} ${bf('ci.branch_id')}), 0) AS tax_reversed
          FROM sales_returns r WHERE ${inPeriod(sql.ref('r.created_at'), p)} ${bf('r.branch_id')}
      `.execute(trx),
      sql<any>`
        SELECT COUNT(*) AS count FROM products pr
          ${branchId
            ? sql`LEFT JOIN branch_stock bs ON bs.product_id = pr.product_id AND bs.branch_id = ${branchId}`
            : sql`JOIN branch_stock bs ON bs.product_id = pr.product_id`}
         WHERE pr.is_active AND COALESCE(bs.reorder_min, pr.reorder_level) IS NOT NULL
           AND COALESCE(bs.base_unit_qty, 0) <= COALESCE(bs.reorder_min, pr.reorder_level)
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
      financial ? sql<any>`
        WITH latest AS (
          SELECT DISTINCT ON (vendor_id) vendor_id, balance_after
            FROM vendor_ledger ORDER BY vendor_id, created_at DESC, entry_id DESC
        )
        SELECT COALESCE(SUM(balance_after), 0) AS total, COUNT(*) AS vendors FROM latest WHERE balance_after > 0
      `.execute(trx) : Promise.resolve({ rows: [{ total: null, vendors: null }] }),
      sql<any>`SELECT COUNT(*) AS count FROM expenses WHERE status = 'PENDING' ${bf('branch_id')}`.execute(trx),
      sql<any>`SELECT COUNT(*) AS count FROM till_sessions WHERE status = 'OPEN' ${bf('branch_id')}`.execute(trx),
      sql<any>`SELECT COUNT(*) AS count FROM invoices WHERE status = 'DRAFT' ${bf('branch_id')}`.execute(trx),
      sql<any>`
        SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
         WHERE status = 'APPROVED' AND expense_date BETWEEN ${p.from}::date AND ${p.to}::date ${bf('branch_id')}
      `.execute(trx),
      // Cost of goods sold, from the cost snapshotted on each sale's stock movement
      // (never today's average, which would rewrite last month's margin).
      showCost ? sql<any>`
        SELECT COALESCE(SUM(-sl.base_unit_qty_change * COALESCE(sl.cost_at_movement, 0)), 0) AS cogs
          FROM stock_ledger sl
         WHERE sl.movement_type IN ('SALE', 'SALE_RETURN')
           AND ${inPeriod(sql.ref('sl.created_at'), p)} ${bf('sl.branch_id')}
      `.execute(trx) : Promise.resolve({ rows: [{ cogs: null }] }),
      sql<any>`SELECT COUNT(*) AS count FROM stock_conflicts WHERE status = 'OPEN' ${bf('branch_id')}`.execute(trx),
      sql<any>`SELECT COUNT(*) AS count FROM stock_transfers WHERE status = 'TRANSFER_DISCREPANCY'`.execute(trx),
    ]);

    const cur = current.rows[0];
    const prev = previous.rows[0];
    const change = (a: number, b: number) => (b > 0 ? round2(((a - b) / b) * 100) : null);
    const revenue = round2(Number(cur.revenue));
    const returnsValue = round2(Number(returns.rows[0].value));
    const netTaxable = round2(Number(cur.taxable) - (returnsValue - Number(returns.rows[0].tax_reversed)));
    const cogsValue = cogs.rows[0].cogs === null ? null : round2(Number(cogs.rows[0].cogs));

    return {
      period: p,
      period_days: p.days,
      revenue,
      revenue_change_pct: change(revenue, Number(prev.revenue)),
      comparison_label: inProgress
        ? (p.days === 1 ? 'vs yesterday at this time' : `vs the previous ${p.days} days, to this time`)
        : (p.days === 1 ? 'vs the day before' : `vs the previous ${p.days} days`),
      invoice_count: Number(cur.invoice_count),
      invoice_count_change_pct: change(Number(cur.invoice_count), Number(prev.invoice_count)),
      avg_ticket: round2(Number(cur.avg_ticket)),
      tax_collected: round2(Number(cur.tax_collected) - Number(returns.rows[0].tax_reversed)),
      returns_count: Number(returns.rows[0].count),
      returns_value: returnsValue,
      net_sales: round2(revenue - returnsValue),
      low_stock_items: Number(lowStock.rows[0].count),
      total_outstanding: Number(dues.rows[0].total_due),
      customers_with_balance: Number(dues.rows[0].customers_with_balance),
      vendor_payable: payables.rows[0].total === null ? null : Number(payables.rows[0].total),
      vendors_owed: payables.rows[0].vendors === null ? null : Number(payables.rows[0].vendors),
      pending_expense_approvals: Number(pendingExp.rows[0].count),
      open_till_sessions: Number(openTills.rows[0].count),
      open_drafts: Number(drafts.rows[0].count),
      open_stock_conflicts: Number(conflicts.rows[0].count),
      transfer_discrepancies: Number(discrepancies.rows[0].count),
      expenses: financial ? round2(Number(expenses.rows[0].total)) : null,
      // Indicative only: taxable sales net of returns, less the recorded cost of
      // what was sold. Shown only to people allowed to see cost.
      gross_profit: cogsValue === null ? null : round2(netTaxable - cogsValue),
      gross_margin_pct: cogsValue === null || netTaxable <= 0 ? null : round2(((netTaxable - cogsValue) / netTaxable) * 100),
      cost_visible: showCost,
    };
  }));

  app.get('/sales-trend', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 90);
    const grain = oneOf(q.grain ?? (p.days > 120 ? 'month' : p.days > 45 ? 'week' : 'day'), 'grain', ['day', 'week', 'month'] as const);
    return (await sql<any>`
      SELECT to_char(date_trunc(${grain}, i.server_received_at), 'YYYY-MM-DD') AS period,
             i.branch_id, b.name AS branch_name,
             SUM(i.grand_total + i.round_off) AS revenue, COUNT(*) AS invoice_count,
             SUM(i.cgst_total + i.sgst_total + i.igst_total) AS tax
        FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
       WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY 1, 2, 3 ORDER BY 1
    `.execute(trx)).rows;
  }));

  app.get('/branch-comparison', guarded('view_chain_reports', async ({ db: trx, req }) => {
    const p = period((req.query ?? {}) as Record<string, string | undefined>, 90);
    return (await sql<any>`
      SELECT b.branch_id, b.name AS branch_name,
             COALESCE(SUM(i.grand_total + i.round_off), 0) AS revenue,
             COUNT(i.invoice_id) AS invoice_count,
             COALESCE(AVG(i.grand_total + i.round_off), 0) AS avg_ticket,
             COALESCE((SELECT SUM(amount) FROM expenses e
                        WHERE e.branch_id = b.branch_id AND e.status = 'APPROVED'
                          AND e.expense_date BETWEEN ${p.from}::date AND ${p.to}::date), 0) AS expenses,
             COALESCE((SELECT SUM(r.refund_total + r.store_credit_total) FROM sales_returns r
                        WHERE r.branch_id = b.branch_id AND ${inPeriod(sql.ref('r.created_at'), p)}), 0) AS returns,
             COALESCE((SELECT SUM(bs.base_unit_qty * bs.weighted_avg_cost) FROM branch_stock bs
                        WHERE bs.branch_id = b.branch_id AND bs.base_unit_qty > 0), 0) AS stock_value
        FROM branches b
        LEFT JOIN invoices i ON i.branch_id = b.branch_id AND i.status = 'FINAL'
             AND ${inPeriod(sql.ref('i.server_received_at'), p)}
       WHERE b.is_active
       GROUP BY b.branch_id, b.name ORDER BY revenue DESC
    `.execute(trx)).rows;
  }));

  app.get('/category-breakdown', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 90);
    return (await sql<any>`
      SELECT COALESCE(c.name, 'Uncategorised') AS category_name,
             SUM(il.line_total) AS revenue, SUM(il.taxable_value) AS taxable_value,
             COUNT(DISTINCT i.invoice_id) AS invoice_count
        FROM invoice_lines il
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN products p ON p.product_id = il.product_id
        LEFT JOIN categories c ON c.category_id = p.category_id
       WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY 1 ORDER BY revenue DESC
    `.execute(trx)).rows;
  }));

  app.get('/payment-mode-split', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 90);
    return (await sql<any>`
      SELECT ip.method, SUM(ip.amount) AS total, COUNT(*) AS txn_count
        FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
       WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
       GROUP BY ip.method ORDER BY total DESC
    `.execute(trx)).rows;
  }));

  app.get('/top-products', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 90);
    return (await sql<any>`
      SELECT p.product_id, p.name AS product_name, p.sku, p.base_unit, u.print_label AS base_unit_label,
             c.name AS category_name,
             SUM(il.line_total) AS revenue, SUM(il.base_unit_qty) AS qty_sold,
             COUNT(DISTINCT i.invoice_id) AS invoice_count
        FROM invoice_lines il
        JOIN invoices i ON i.invoice_id = il.invoice_id
        JOIN products p ON p.product_id = il.product_id
        JOIN units u ON u.unit_code = p.base_unit
        LEFT JOIN categories c ON c.category_id = p.category_id
       WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         ${q.category_id ? sql`AND p.category_id = ${uuid(q.category_id, 'category_id')}` : sql``}
       GROUP BY p.product_id, p.name, p.sku, p.base_unit, u.print_label, c.name
       ORDER BY ${q.order === 'qty' ? sql`qty_sold` : sql`revenue`} DESC
       LIMIT ${clampLimit(q.limit, 10, 200)}
    `.execute(trx)).rows;
  }));

  /**
   * 2.6 — margin by product/category/branch. The requirement makes cost data a
   * field-level permission, so this endpoint is gated on cost visibility rather
   * than on view_reports: an Accountant can see revenue but not margin unless the
   * Owner grants it.
   */
  app.get('/margin', guarded(null, async ({ session, db: trx, req }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!canSeeCost(session.role, settings)) {
      throw forbidden('Margin figures include purchase cost, which your role cannot view. An Owner can grant this under Admin → Settings → Catalog.');
    }
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const p = period(q, 90);
    const branchId = scope(session, q);
    const groupBy = oneOf(q.group_by ?? 'category', 'group_by', ['category', 'product', 'branch'] as const);

    // COGS uses the cost snapshotted on the stock ledger at the moment of sale,
    // not today's weighted average — otherwise a later purchase at a different
    // price would retroactively rewrite last month's margin. The movement is
    // matched per product per invoice and summed, so two lines of one product on
    // one bill are each costed once.
    //
    // The cost is looked up per sold line through the (ref_table, ref_id) index.
    // Joining a whole-period aggregate of the stock ledger instead left the plan
    // at the mercy of a row estimate: under row-level security the planner could
    // decide to re-scan the ledger once per bill, and the report never finished.
    return (await sql<any>`
      WITH sold AS (
        SELECT i.invoice_id, i.branch_id, il.product_id, SUM(il.taxable_value) AS revenue
          FROM invoice_lines il JOIN invoices i ON i.invoice_id = il.invoice_id
         WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
           ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         GROUP BY i.invoice_id, i.branch_id, il.product_id
      )
      SELECT ${groupBy === 'category' ? sql`COALESCE(c.name, 'Uncategorised')`
             : groupBy === 'product' ? sql`p.name`
             : sql`b.name`} AS group_name,
             SUM(s.revenue) AS revenue,
             SUM(COALESCE(sc.cogs, 0)) AS cogs,
             SUM(s.revenue) - SUM(COALESCE(sc.cogs, 0)) AS margin_amount,
             CASE WHEN SUM(s.revenue) > 0
                  THEN round(((SUM(s.revenue) - SUM(COALESCE(sc.cogs, 0))) / SUM(s.revenue)) * 100, 2) END AS margin_pct
        FROM sold s
        JOIN products p ON p.product_id = s.product_id
        JOIN branches b ON b.branch_id = s.branch_id
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN LATERAL (
          SELECT SUM(-sl.base_unit_qty_change * COALESCE(sl.cost_at_movement, 0)) AS cogs
            FROM stock_ledger sl
           WHERE sl.ref_table = 'invoices' AND sl.ref_id = s.invoice_id
             AND sl.product_id = s.product_id AND sl.movement_type = 'SALE'
        ) sc ON TRUE
       GROUP BY 1 ORDER BY revenue DESC LIMIT 200
    `.execute(trx)).rows;
  }));

  app.get('/slow-moving', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const rows = (await sql<any>`
      SELECT p.name AS product_name, p.sku, b.name AS branch_name, p.base_unit,
             bs.base_unit_qty AS qty_on_hand, bs.weighted_avg_cost,
             bs.base_unit_qty * bs.weighted_avg_cost AS tied_up_value, ls.last_sale,
             CASE WHEN ls.last_sale IS NULL THEN NULL ELSE (CURRENT_DATE - ls.last_sale::date) END AS days_since_sale
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id AND p.is_active
        JOIN branches b ON b.branch_id = bs.branch_id
        LEFT JOIN LATERAL (
            SELECT MAX(created_at) AS last_sale FROM stock_ledger sl
             WHERE sl.product_id = bs.product_id AND sl.branch_id = bs.branch_id AND sl.movement_type = 'SALE'
        ) ls ON TRUE
       WHERE bs.base_unit_qty > 0 ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
       ORDER BY ls.last_sale ASC NULLS FIRST LIMIT ${clampLimit(q.limit, 20, 200)}
    `.execute(trx)).rows;
    return showCost ? rows : rows.map(({ weighted_avg_cost, tied_up_value, ...r }: any) => r);
  }));

  app.get('/stock-value', guarded('view_cost_price', async ({ db: trx }) =>
    (await sql<any>`
      SELECT b.name AS branch_name, b.branch_id,
             SUM(bs.base_unit_qty * bs.weighted_avg_cost) FILTER (WHERE bs.base_unit_qty > 0) AS stock_value,
             COUNT(*) FILTER (WHERE bs.base_unit_qty > 0) AS sku_count,
             COUNT(*) FILTER (WHERE bs.base_unit_qty <= 0) AS out_of_stock_count
        FROM branch_stock bs JOIN branches b ON b.branch_id = bs.branch_id
       GROUP BY b.branch_id, b.name ORDER BY stock_value DESC NULLS LAST
    `.execute(trx)).rows));

  /** Stock position by category, valued at cost for those allowed to see it. */
  app.get('/stock-summary', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const settings = await loadSettings(trx, session.branch_id);
    const rows = (await sql<any>`
      SELECT COALESCE(c.name, 'Uncategorised') AS category_name,
             COUNT(DISTINCT p.product_id) AS products,
             COUNT(*) FILTER (WHERE COALESCE(bs.base_unit_qty, 0) <= 0) AS out_of_stock,
             COUNT(*) FILTER (WHERE COALESCE(bs.base_unit_qty, 0) <= COALESCE(bs.reorder_min, p.reorder_level, 0)) AS low_stock,
             SUM(GREATEST(COALESCE(bs.base_unit_qty, 0), 0) * COALESCE(bs.weighted_avg_cost, 0)) AS stock_value
        FROM products p
        ${branchId ? sql`LEFT JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = ${branchId}`
                   : sql`LEFT JOIN branch_stock bs ON bs.product_id = p.product_id`}
        LEFT JOIN categories c ON c.category_id = p.category_id
       WHERE p.is_active
       GROUP BY 1 ORDER BY stock_value DESC NULLS LAST
    `.execute(trx)).rows;
    return canSeeCost(session.role, settings) ? rows : rows.map(({ stock_value, ...r }: any) => r);
  }));

  app.get('/expense-vs-revenue', guarded('view_financial_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 365);
    return (await sql<any>`
      WITH rev AS (
        SELECT to_char(server_received_at, 'YYYY-MM') AS month, branch_id, SUM(grand_total + round_off) AS revenue
          FROM invoices WHERE status = 'FINAL' AND ${inPeriod(sql.ref('server_received_at'), p)}
           ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2
      ), exp AS (
        SELECT to_char(expense_date, 'YYYY-MM') AS month, branch_id, SUM(amount) AS expenses
          FROM expenses WHERE status = 'APPROVED' AND expense_date BETWEEN ${p.from}::date AND ${p.to}::date
           ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
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

  /**
   * An INDICATIVE profit statement for the period. Every line is computed from
   * recorded transactions, and the response says which figures are estimates:
   * cost of goods sold is the weighted-average cost captured at each sale, which
   * is only as accurate as the purchase entries behind it.
   */
  app.get('/profit-and-loss', guarded('view_financial_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const settings = await loadSettings(trx, session.branch_id);
    if (!canSeeCost(session.role, settings)) {
      throw forbidden('The profit statement uses purchase cost, which your role cannot view.');
    }
    const branchId = scope(session, q);
    const p = period(q, 30);
    const bf = (col: string) => (branchId ? sql`AND ${sql.ref(col)} = ${branchId}` : sql``);
    const [sales, returns, cogs, expenses] = await Promise.all([
      sql<any>`SELECT COALESCE(SUM(subtotal), 0) AS taxable, COALESCE(SUM(discount_total), 0) AS discounts,
                      COALESCE(SUM(round_off), 0) AS round_off
                 FROM invoices WHERE status = 'FINAL' AND ${inPeriod(sql.ref('server_received_at'), p)} ${bf('branch_id')}`.execute(trx),
      sql<any>`
        SELECT COALESCE(SUM(srl_val.taxable), 0) AS taxable
          FROM sales_returns r
          JOIN LATERAL (
              SELECT SUM(il.taxable_value * srl.qty_base_unit / NULLIF(il.base_unit_qty, 0)) AS taxable
                FROM sales_return_lines srl JOIN invoice_lines il ON il.line_id = srl.invoice_line_id
               WHERE srl.return_id = r.return_id
          ) srl_val ON TRUE
         WHERE ${inPeriod(sql.ref('r.created_at'), p)} ${bf('r.branch_id')}`.execute(trx),
      sql<any>`
        SELECT COALESCE(SUM(-sl.base_unit_qty_change * COALESCE(sl.cost_at_movement, 0)) FILTER (WHERE sl.movement_type = 'SALE'), 0) AS sold,
               COALESCE(SUM(sl.base_unit_qty_change * COALESCE(sl.cost_at_movement, 0)) FILTER (WHERE sl.movement_type = 'SALE_RETURN'), 0) AS returned,
               COALESCE(SUM(-sl.base_unit_qty_change * COALESCE(sl.cost_at_movement, 0))
                 FILTER (WHERE sl.movement_type = 'WRITE_OFF' OR (sl.movement_type = 'ADJUSTMENT' AND sl.base_unit_qty_change < 0)), 0) AS shrinkage
          FROM stock_ledger sl WHERE ${inPeriod(sql.ref('sl.created_at'), p)} ${bf('sl.branch_id')}`.execute(trx),
      sql<any>`
        SELECT ec.name AS category, SUM(e.amount) AS total
          FROM expenses e JOIN expense_categories ec ON ec.category_id = e.category_id
         WHERE e.status = 'APPROVED' AND e.expense_date BETWEEN ${p.from}::date AND ${p.to}::date ${bf('e.branch_id')}
         GROUP BY ec.name ORDER BY total DESC`.execute(trx),
    ]);
    const netSales = round2(Number(sales.rows[0].taxable) - Number(returns.rows[0].taxable));
    const cogsValue = round2(Number(cogs.rows[0].sold) - Number(cogs.rows[0].returned));
    const shrinkage = round2(Number(cogs.rows[0].shrinkage));
    const grossProfit = round2(netSales - cogsValue);
    const expenseTotal = round2(expenses.rows.reduce((s: number, e: any) => s + Number(e.total), 0));
    return {
      period: p,
      net_sales: netSales,
      returns_taxable: round2(Number(returns.rows[0].taxable)),
      discounts_given: round2(Number(sales.rows[0].discounts)),
      cost_of_goods_sold: cogsValue,
      gross_profit: grossProfit,
      gross_margin_pct: netSales > 0 ? round2((grossProfit / netSales) * 100) : null,
      stock_shrinkage: shrinkage,
      expenses: expenses.rows,
      expense_total: expenseTotal,
      operating_profit: round2(grossProfit - shrinkage - expenseTotal),
      basis: 'Sales and returns are ex-GST. Cost of goods sold uses the weighted-average cost recorded at each sale. Indicative, not a statutory statement.',
    };
  }));

  // ── Registers (spec §38) — the rows behind every total, for review and export ──
  app.get('/sales-register', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    return (await sql<any>`
      SELECT i.invoice_id, i.invoice_number, i.server_received_at AS invoice_date, b.name AS branch,
             COALESCE(c.name, 'Walk-in') AS customer, c.gstin AS customer_gstin, i.invoice_type,
             i.subtotal AS taxable_value, i.discount_total, i.cgst_total, i.sgst_total, i.igst_total,
             i.round_off, round(i.grand_total + i.round_off, 2) AS amount, i.status,
             (SELECT string_agg(ip.method::text || ' ' || ip.amount, ', ') FROM invoice_payments ip WHERE ip.invoice_id = i.invoice_id) AS payments,
             u.full_name AS billed_by
        FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN users u ON u.user_id = i.created_by
       WHERE i.status IN ('FINAL', 'VOID') AND ${inPeriod(sql.ref('i.server_received_at'), p)}
         ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         ${q.customer_id ? sql`AND i.customer_id = ${uuid(q.customer_id, 'customer_id')}` : sql``}
         ${q.invoice_type ? sql`AND i.invoice_type = ${oneOf(q.invoice_type, 'Invoice type', ['GST', 'NON_GST'] as const)}::invoice_type` : sql``}
         ${q.payment_method ? sql`AND EXISTS (SELECT 1 FROM invoice_payments ip WHERE ip.invoice_id = i.invoice_id
                                   AND ip.method = ${oneOf(q.payment_method, 'Payment method', ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CREDIT', 'LOYALTY_POINTS'] as const)}::payment_method)` : sql``}
       ORDER BY i.server_received_at LIMIT 5000
    `.execute(trx)).rows;
  }));

  app.get('/purchase-register', guarded('view_financial_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    return (await sql<any>`
      SELECT g.grn_id, g.grn_number, g.received_at, b.name AS branch, v.name AS vendor, v.gstin AS vendor_gstin,
             g.vendor_invoice_no, g.vendor_invoice_date, g.taxable_total, g.cgst_total, g.sgst_total, g.igst_total,
             g.round_off, g.grand_total,
             COALESCE((SELECT SUM(dn.total_amount) FROM vendor_debit_notes dn WHERE dn.grn_id = g.grn_id), 0) AS returned_value,
             COALESCE((SELECT SUM(amount) FROM vendor_payments vp WHERE vp.grn_id = g.grn_id
                         AND NOT EXISTS (SELECT 1 FROM payment_cancellations pc WHERE pc.payment_table = 'vendor_payments' AND pc.payment_id = vp.payment_id)), 0) AS paid_against
        FROM grn g JOIN vendors v ON v.vendor_id = g.vendor_id JOIN branches b ON b.branch_id = g.branch_id
       WHERE ${inPeriod(sql.ref('g.received_at'), p)} ${branchId ? sql`AND g.branch_id = ${branchId}` : sql``}
         ${q.vendor_id ? sql`AND g.vendor_id = ${uuid(q.vendor_id, 'vendor_id')}` : sql``}
       ORDER BY g.received_at LIMIT 5000
    `.execute(trx)).rows;
  }));

  app.get('/returns-register', guarded('view_returns', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    return (await sql<any>`
      SELECT r.return_id, r.created_at, b.name AS branch, i.invoice_number, COALESCE(c.name, 'Walk-in') AS customer,
             cn.credit_note_number, r.return_reason, r.refund_method, r.refund_total, r.store_credit_total,
             round(r.refund_total + r.store_credit_total, 2) AS value, u.full_name AS processed_by
        FROM sales_returns r JOIN invoices i ON i.invoice_id = r.invoice_id
        JOIN branches b ON b.branch_id = r.branch_id
        LEFT JOIN customers c ON c.customer_id = i.customer_id
        LEFT JOIN credit_notes cn ON cn.credit_note_id = r.credit_note_id
        LEFT JOIN users u ON u.user_id = r.created_by
       WHERE ${inPeriod(sql.ref('r.created_at'), p)} ${branchId ? sql`AND r.branch_id = ${branchId}` : sql``}
       ORDER BY r.created_at LIMIT 5000
    `.execute(trx)).rows;
  }));

  /** Money in and out in one list: sales payments, account receipts, vendor payments. */
  app.get('/payments-register', guarded('view_financial_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    return (await sql<any>`
      SELECT * FROM (
        SELECT 'SALE' AS kind, i.server_received_at AS at, b.name AS branch, i.invoice_number AS document,
               COALESCE(c.name, 'Walk-in') AS party, ip.method::text AS method, ip.amount AS amount_in,
               0::numeric AS amount_out, ip.ref_no AS reference
          FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
          JOIN branches b ON b.branch_id = i.branch_id LEFT JOIN customers c ON c.customer_id = i.customer_id
         WHERE i.status = 'FINAL' AND ip.method NOT IN ('CREDIT', 'LOYALTY_POINTS')
           AND ${inPeriod(sql.ref('i.server_received_at'), p)} ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
        UNION ALL
        SELECT 'RECEIPT', cp.created_at, b.name, cp.receipt_number, c.name, cp.method, cp.amount, 0, cp.reference
          FROM customer_payments cp JOIN branches b ON b.branch_id = cp.branch_id JOIN customers c ON c.customer_id = cp.customer_id
         WHERE ${inPeriod(sql.ref('cp.created_at'), p)} ${branchId ? sql`AND cp.branch_id = ${branchId}` : sql``}
           AND NOT EXISTS (SELECT 1 FROM payment_cancellations pc WHERE pc.payment_table = 'customer_payments' AND pc.payment_id = cp.payment_id)
        UNION ALL
        SELECT 'VENDOR_PAYMENT', vp.created_at, b.name, vp.payment_number, v.name, vp.method, 0, vp.amount, vp.reference
          FROM vendor_payments vp JOIN branches b ON b.branch_id = vp.branch_id JOIN vendors v ON v.vendor_id = vp.vendor_id
         WHERE ${inPeriod(sql.ref('vp.created_at'), p)} ${branchId ? sql`AND vp.branch_id = ${branchId}` : sql``}
           AND NOT EXISTS (SELECT 1 FROM payment_cancellations pc WHERE pc.payment_table = 'vendor_payments' AND pc.payment_id = vp.payment_id)
        UNION ALL
        SELECT 'REFUND', r.created_at, b.name, COALESCE(cn.credit_note_number, i.invoice_number), COALESCE(c.name, 'Walk-in'),
               r.refund_method::text, 0, r.refund_total, NULL
          FROM sales_returns r JOIN invoices i ON i.invoice_id = r.invoice_id JOIN branches b ON b.branch_id = r.branch_id
          LEFT JOIN customers c ON c.customer_id = i.customer_id LEFT JOIN credit_notes cn ON cn.credit_note_id = r.credit_note_id
         WHERE r.refund_total > 0 AND ${inPeriod(sql.ref('r.created_at'), p)} ${branchId ? sql`AND r.branch_id = ${branchId}` : sql``}
        UNION ALL
        SELECT 'EXPENSE', e.expense_date::timestamptz, b.name, e.reference, COALESCE(e.payee, ec.name), e.payment_method, 0, e.amount, e.description
          FROM expenses e JOIN branches b ON b.branch_id = e.branch_id JOIN expense_categories ec ON ec.category_id = e.category_id
         WHERE e.status = 'APPROVED' AND e.expense_date BETWEEN ${p.from}::date AND ${p.to}::date
           ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
      ) x
      ${q.method ? sql`WHERE x.method = ${oneOf(q.method, 'Method', ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const)}` : sql``}
      ORDER BY x.at LIMIT 10000
    `.execute(trx)).rows;
  }));

  /** Every till in the period with its expected and counted cash (spec §37). */
  app.get('/till-report', guarded('view_financial_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    return (await sql<any>`
      SELECT ts.session_id, ts.counter_id, b.name AS branch, u.full_name AS cashier, ts.opened_at, ts.closed_at,
             ts.status, ts.opening_float,
             COALESCE(ev.sales, 0) AS cash_sales, COALESCE(ev.receipts, 0) AS cash_receipts,
             COALESCE(ev.drops, 0) AS cash_drops, COALESCE(ev.petty, 0) AS petty,
             ts.opening_float + COALESCE(ev.sales, 0) + COALESCE(ev.receipts, 0) - COALESCE(ev.drops, 0) - COALESCE(ev.petty, 0) AS expected,
             ts.closing_counted_cash AS counted,
             ts.closing_counted_cash - (ts.opening_float + COALESCE(ev.sales, 0) + COALESCE(ev.receipts, 0)
               - COALESCE(ev.drops, 0) - COALESCE(ev.petty, 0)) AS variance
        FROM till_sessions ts JOIN branches b ON b.branch_id = ts.branch_id
        JOIN users u ON u.user_id = ts.cashier_user_id
        LEFT JOIN LATERAL (
            SELECT SUM(amount) FILTER (WHERE event_type = 'CASH_SALE') AS sales,
                   SUM(amount) FILTER (WHERE event_type = 'CASH_RECEIPT') AS receipts,
                   SUM(amount) FILTER (WHERE event_type = 'CASH_DROP') AS drops,
                   SUM(amount) FILTER (WHERE event_type = 'PETTY_EXPENSE_PAYOUT') AS petty
              FROM till_events WHERE session_id = ts.session_id
        ) ev ON TRUE
       WHERE ${inPeriod(sql.ref('ts.opened_at'), p)} ${branchId ? sql`AND ts.branch_id = ${branchId}` : sql``}
       ORDER BY ts.opened_at DESC LIMIT 2000
    `.execute(trx)).rows;
  }));

  app.get('/attendance-summary', guarded('view_hr', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 30);
    return (await sql<any>`
      SELECT u.full_name, b.name AS branch_name, COUNT(*) AS present_days,
             ROUND(AVG(EXTRACT(EPOCH FROM (a.check_out - a.check_in)) / 3600)::numeric, 1) AS avg_hours
        FROM attendance a
        JOIN employees e ON e.employee_id = a.employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE a.work_date BETWEEN ${p.from}::date AND ${p.to}::date
         ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
       GROUP BY u.full_name, b.name ORDER BY present_days DESC
    `.execute(trx)).rows;
  }));

  app.get('/sales-by-employee', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const p = period(q, 90);
    return (await sql<any>`
      SELECT u.full_name, b.name AS branch_name, SUM(i.grand_total + i.round_off) AS revenue,
             COUNT(*) AS invoice_count, ROUND(AVG(i.grand_total + i.round_off), 2) AS avg_ticket
        FROM invoices i
        JOIN employees e ON e.employee_id = i.sold_by_employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
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
    const p = period(q, 30);
    const branchId = scope(session, q);
    const [outward, creditNotes, hsn, itc] = await Promise.all([
      sql<any>`
        SELECT to_char(i.server_received_at, 'YYYY-MM') AS month,
               CASE WHEN c.gstin IS NOT NULL AND c.gstin <> '' THEN 'B2B' ELSE 'B2C' END AS supply_type,
               SUM(i.subtotal) AS taxable_value, SUM(i.cgst_total) AS cgst,
               SUM(i.sgst_total) AS sgst, SUM(i.igst_total) AS igst,
               COUNT(*) AS invoice_count
          FROM invoices i LEFT JOIN customers c ON c.customer_id = i.customer_id
         WHERE i.status = 'FINAL' AND i.invoice_type = 'GST'
           AND ${inPeriod(sql.ref('i.server_received_at'), p)} ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2 ORDER BY 1, 2
      `.execute(trx),
      sql<any>`
        SELECT to_char(cn.created_at, 'YYYY-MM') AS month,
               SUM(cnl.taxable_value) AS taxable_value, SUM(cnl.cgst_amount) AS cgst,
               SUM(cnl.sgst_amount) AS sgst, SUM(cnl.igst_amount) AS igst,
               COUNT(DISTINCT cn.credit_note_id) AS credit_note_count
          FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.credit_note_id
          JOIN invoices i ON i.invoice_id = cn.invoice_id
         WHERE ${inPeriod(sql.ref('cn.created_at'), p)} ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         GROUP BY 1 ORDER BY 1
      `.execute(trx),
      sql<any>`
        SELECT p.hsn_code, MAX(u.print_label) AS uqc, SUM(il.base_unit_qty) AS qty, SUM(il.taxable_value) AS taxable_value,
               SUM(il.cgst_amount) AS cgst, SUM(il.sgst_amount) AS sgst, SUM(il.igst_amount) AS igst
          FROM invoice_lines il
          JOIN invoices i ON i.invoice_id = il.invoice_id
          JOIN products p ON p.product_id = il.product_id
          JOIN units u ON u.unit_code = p.base_unit
         WHERE i.status = 'FINAL' AND i.invoice_type = 'GST'
           AND ${inPeriod(sql.ref('i.server_received_at'), p)} ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
         GROUP BY p.hsn_code ORDER BY taxable_value DESC
      `.execute(trx),
      sql<any>`
        SELECT COALESCE(SUM(g.cgst_total), 0) AS cgst, COALESCE(SUM(g.sgst_total), 0) AS sgst,
               COALESCE(SUM(g.igst_total), 0) AS igst,
               COALESCE((SELECT SUM(dn.tax_total) FROM vendor_debit_notes dn
                          WHERE ${inPeriod(sql.ref('dn.created_at'), p)} ${branchId ? sql`AND dn.branch_id = ${branchId}` : sql``}), 0) AS reversed
          FROM grn g WHERE ${inPeriod(sql.ref('g.received_at'), p)} ${branchId ? sql`AND g.branch_id = ${branchId}` : sql``}
      `.execute(trx),
    ]);

    const sumRows = (rows: any[], k: string) => round2(rows.reduce((s, r) => s + Number(r[k] ?? 0), 0));
    const outputTax = round2(sumRows(outward.rows, 'cgst') + sumRows(outward.rows, 'sgst') + sumRows(outward.rows, 'igst')
      - sumRows(creditNotes.rows, 'cgst') - sumRows(creditNotes.rows, 'sgst') - sumRows(creditNotes.rows, 'igst'));
    const it = itc.rows[0];
    const inputTax = round2(Number(it.cgst) + Number(it.sgst) + Number(it.igst) - Number(it.reversed));

    return {
      period: p,
      fiscal_year: fiscalYear(),
      // An Accountant is pinned to a branch, so row-level security scopes this
      // report to that branch. Saying so matters: a return filed from a figure
      // that silently omitted three other branches is a compliance problem, and
      // nothing on the page would otherwise reveal it.
      scope: session.role === 'OWNER_ADMIN' && !branchId ? 'CHAIN_WIDE' : 'SINGLE_BRANCH',
      scope_note: session.role === 'OWNER_ADMIN' && !branchId
        ? 'Chain-wide: every branch is included.'
        : 'These figures cover one branch only. A chain-wide GST return must be produced from the Owner account with All branches selected.',
      outward_supplies: outward.rows,
      credit_notes: creditNotes.rows,
      hsn_summary: hsn.rows,
      summary: {
        output_tax: outputTax,
        input_tax_credit: inputTax,
        net_payable_indicative: round2(outputTax - inputTax),
      },
      note: 'Credit notes reduce outward supply in the period they were issued, not the period of the original invoice. Input tax is from recorded purchase bills; confirm against GSTR-2B before filing.',
    };
  }));

  /** 4.5.1 — the purchase-side view: GST paid on purchases (ITC) and the debit notes reversing it. */
  app.get('/itc-summary', guarded('view_gst_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const p = period(q, 30);
    const branchId = scope(session, q);
    return (await sql<any>`
      WITH purchases AS (
        SELECT to_char(g.received_at, 'YYYY-MM') AS month, g.vendor_id,
               SUM(g.taxable_total) AS purchase_value,
               SUM(g.cgst_total + g.sgst_total + g.igst_total) AS itc
          FROM grn g
         WHERE ${inPeriod(sql.ref('g.received_at'), p)} ${branchId ? sql`AND g.branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2
      ), reversals AS (
        SELECT to_char(dn.created_at, 'YYYY-MM') AS month, dn.vendor_id,
               SUM(dn.taxable_total) AS value_returned, SUM(dn.tax_total) AS itc_reversed
          FROM vendor_debit_notes dn
         WHERE ${inPeriod(sql.ref('dn.created_at'), p)} ${branchId ? sql`AND dn.branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2
      )
      SELECT COALESCE(p.month, r.month) AS month, v.name AS vendor_name, v.gstin,
             COALESCE(p.purchase_value, 0) AS purchase_value,
             COALESCE(p.itc, 0) AS itc,
             COALESCE(r.itc_reversed, 0) AS itc_reversed,
             COALESCE(p.itc, 0) - COALESCE(r.itc_reversed, 0) AS net_itc,
             COALESCE(p.purchase_value, 0) - COALESCE(r.value_returned, 0) AS net_purchase_value
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
  app.get('/accounting-export', guarded('export_accounting', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (!q.from || !q.to) throw badRequest('Choose a date range (from and to) for the export.');
    const p = period(q, 30);
    const branchId = scope(session, q);
    const kind = oneOf(q.kind ?? 'sales', 'kind',
      ['sales', 'purchases', 'credit_notes', 'expenses', 'payments'] as const);

    switch (kind) {
      case 'sales':
        return (await sql<any>`
          SELECT i.invoice_number, i.server_received_at AS invoice_date, b.name AS branch,
                 COALESCE(c.name, 'Cash Sale') AS party, c.gstin AS party_gstin,
                 i.invoice_type, i.subtotal AS taxable_value, i.cgst_total, i.sgst_total, i.igst_total,
                 i.round_off, round(i.grand_total + i.round_off, 2) AS invoice_amount,
                 i.place_of_supply_state_code AS place_of_supply
            FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
            LEFT JOIN customers c ON c.customer_id = i.customer_id
           WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
             ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
           ORDER BY i.server_received_at
        `.execute(trx)).rows;
      case 'purchases':
        return (await sql<any>`
          SELECT g.grn_number, g.received_at AS grn_date, b.name AS branch, v.name AS vendor, v.gstin AS vendor_gstin,
                 g.vendor_invoice_no, g.vendor_invoice_date, g.taxable_total AS taxable_value,
                 g.cgst_total, g.sgst_total, g.igst_total, g.round_off, g.grand_total AS bill_amount
            FROM grn g JOIN vendors v ON v.vendor_id = g.vendor_id JOIN branches b ON b.branch_id = g.branch_id
           WHERE ${inPeriod(sql.ref('g.received_at'), p)} ${branchId ? sql`AND g.branch_id = ${branchId}` : sql``}
           ORDER BY g.received_at
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
           WHERE ${inPeriod(sql.ref('cn.created_at'), p)} ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
           GROUP BY cn.credit_note_number, cn.created_at, i.invoice_number, b.name, c.name, c.gstin, cn.total_amount
           ORDER BY cn.created_at
        `.execute(trx)).rows;
      case 'expenses':
        return (await sql<any>`
          SELECT e.expense_date, b.name AS branch, ec.name AS category, e.payee, e.amount, e.payment_method,
                 e.reference, e.description, e.status, u.full_name AS approved_by
            FROM expenses e JOIN expense_categories ec ON ec.category_id = e.category_id
            JOIN branches b ON b.branch_id = e.branch_id
            LEFT JOIN users u ON u.user_id = e.approved_by
           WHERE e.expense_date BETWEEN ${p.from}::date AND ${p.to}::date
             ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
           ORDER BY e.expense_date
        `.execute(trx)).rows;
      case 'payments':
        return (await sql<any>`
          SELECT i.invoice_number, i.server_received_at AS invoice_date, b.name AS branch,
                 ip.method, ip.amount, ip.ref_no
            FROM invoice_payments ip JOIN invoices i ON i.invoice_id = ip.invoice_id
            JOIN branches b ON b.branch_id = i.branch_id
           WHERE i.status = 'FINAL' AND ${inPeriod(sql.ref('i.server_received_at'), p)}
             ${branchId ? sql`AND i.branch_id = ${branchId}` : sql``}
           ORDER BY i.server_received_at
        `.execute(trx)).rows;
    }
  }));

  /** Section 14 — the daily admin digest, also used by the scheduled WhatsApp job. */
  app.get('/daily-digest', guarded('view_reports', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = scope(session, q);
    const [sales, lowStock, dues, transfers, conflicts] = await Promise.all([
      sql<any>`
        SELECT COALESCE(SUM(grand_total + round_off), 0) AS revenue, COUNT(*) AS invoice_count
          FROM invoices WHERE status = 'FINAL' AND server_received_at::date = CURRENT_DATE
           ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
      sql<any>`
        SELECT p.name, bs.base_unit_qty, COALESCE(bs.reorder_min, p.reorder_level) AS reorder_min, b.name AS branch_name
          FROM branch_stock bs JOIN products p ON p.product_id = bs.product_id AND p.is_active
          JOIN branches b ON b.branch_id = bs.branch_id
         WHERE bs.base_unit_qty <= COALESCE(bs.reorder_min, p.reorder_level, 0)
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
      date: businessToday(),
      todays_revenue: Number(sales.rows[0].revenue),
      todays_invoices: Number(sales.rows[0].invoice_count),
      low_stock: lowStock.rows,
      total_outstanding: Number(dues.rows[0].total),
      pending_transfers: Number(transfers.rows[0].count),
      open_stock_conflicts: Number(conflicts.rows[0].count),
    };
  }));
}
