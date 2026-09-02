// ============================================================================
// Section 9 — Expenses
// Branch-scoped entry, receipt attachment, and an approval workflow that only
// engages above a configurable threshold — small everyday spends should not need
// the owner's attention, large ones must.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, str, optionalStr, num, oneOf, writeBranch, resolveBranchScope, limit as clampLimit,
} from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';

export default async function expensesRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_expenses', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT e.expense_id, e.branch_id, b.name AS branch_name, e.category_id, c.name AS category_name,
             e.amount, e.description, e.receipt_url, e.status, e.created_at,
             e.paid_from_till_session_id,
             ureq.full_name AS requested_by_name, uapp.full_name AS approved_by_name
        FROM expenses e
        JOIN expense_categories c ON c.category_id = e.category_id
        JOIN branches b ON b.branch_id = e.branch_id
        LEFT JOIN users ureq ON ureq.user_id = e.created_by
        LEFT JOIN users uapp ON uapp.user_id = e.approved_by
       WHERE 1=1 ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND e.status = ${oneOf(q.status, 'status', ['PENDING', 'APPROVED', 'REJECTED'] as const)}::expense_status` : sql``}
         ${q.category_id ? sql`AND e.category_id = ${uuid(q.category_id, 'category_id')}` : sql``}
         ${q.from ? sql`AND e.created_at >= ${q.from}::timestamptz` : sql``}
         ${q.to ? sql`AND e.created_at < (${q.to}::date + 1)` : sql``}
       ORDER BY e.created_at DESC LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
  }));

  app.post('/', guarded('create_expense', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    const amount = num(body.amount, 'Amount', { min: 0.01 });
    const settings = await loadSettings(trx, branchId);

    // Section 9 — the threshold decides whether this needs approval at all.
    // Anything at or below it from a manager is approved on entry, so routine
    // spending does not silently pile up in a queue nobody looks at.
    const threshold = Number(settings.expense_approval_threshold);
    const autoApprove = amount <= threshold && ['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role);

    const row = (await sql<any>`
      INSERT INTO expenses (branch_id, category_id, amount, description, receipt_url, status, created_by, approved_by)
      VALUES (${branchId}, ${uuid(body.category_id, 'Category')}, ${amount},
              ${optionalStr(body.description, 'Description', { max: 500 })},
              ${optionalStr(body.receipt_url, 'Receipt URL', { max: 500 })},
              ${autoApprove ? 'APPROVED' : 'PENDING'}::expense_status,
              ${session.user_id}, ${autoApprove ? session.user_id : null})
      RETURNING *
    `.execute(trx)).rows[0];

    return {
      ...row,
      requires_approval: !autoApprove,
      message: autoApprove
        ? 'Recorded and approved.'
        : `Above the ₹${threshold} approval threshold — sent for approval.`,
    };
  }));

  app.post('/:id/approve', guarded('approve_expense', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'expense_id');
    const expense = (await sql<any>`SELECT * FROM expenses WHERE expense_id = ${id}`.execute(trx)).rows[0];
    if (!expense) throw notFound('Expense not found.');
    if (expense.status !== 'PENDING') throw badRequest(`That expense is already ${expense.status.toLowerCase()}.`);
    // Approving your own claim defeats the point of having an approval step.
    if (expense.created_by === session.user_id && session.role !== 'OWNER_ADMIN') {
      throw forbidden('You cannot approve an expense you raised yourself. Ask the owner to approve it.');
    }

    await sql`
      UPDATE expenses SET status = 'APPROVED', approved_by = ${session.user_id} WHERE expense_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'EXPENSE_APPROVED', 'expenses', id, { after: { amount: expense.amount } });
    return { ok: true };
  }));

  app.post('/:id/reject', guarded('approve_expense', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'expense_id');
    const reason = optionalStr((req.body as any)?.reason, 'Reason', { max: 300 });
    const expense = (await sql<any>`SELECT * FROM expenses WHERE expense_id = ${id}`.execute(trx)).rows[0];
    if (!expense) throw notFound('Expense not found.');
    if (expense.status !== 'PENDING') throw badRequest(`That expense is already ${expense.status.toLowerCase()}.`);

    await sql`
      UPDATE expenses SET status = 'REJECTED', approved_by = ${session.user_id},
             description = COALESCE(description, '') || ${reason ? ' | Rejected: ' + reason : ''}
       WHERE expense_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'EXPENSE_REJECTED', 'expenses', id, { after: { reason } });
    return { ok: true };
  }));

  app.get('/categories', guarded('view_expenses', async ({ db: trx }) =>
    (await sql<any>`SELECT * FROM expense_categories ORDER BY name`.execute(trx)).rows));

  app.post('/categories', guarded('manage_settings', async ({ db: trx, req }) =>
    (await sql<any>`
      INSERT INTO expense_categories (name) VALUES (${str((req.body as any)?.name, 'Category name', { max: 100 })})
      RETURNING *
    `.execute(trx)).rows[0]));

  /** Section 9 — branch-wise and month-over-month comparison, plus the
   *  expense-vs-revenue ratio the requirement names explicitly. */
  app.get('/summary', guarded('view_expenses', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const months = Math.min(Math.max(Number(q.months) || 12, 1), 36);

    const [byMonth, byCategory, ratio] = await Promise.all([
      sql<any>`
        SELECT to_char(e.created_at, 'YYYY-MM') AS month, b.name AS branch_name,
               SUM(e.amount) AS total
          FROM expenses e JOIN branches b ON b.branch_id = e.branch_id
         WHERE e.status = 'APPROVED'
           AND e.created_at >= date_trunc('month', now()) - make_interval(months => ${months})
           ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2 ORDER BY 1
      `.execute(trx),
      sql<any>`
        SELECT c.name AS category_name, SUM(e.amount) AS total, COUNT(*) AS entry_count
          FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id
         WHERE e.status = 'APPROVED'
           AND e.created_at >= date_trunc('month', now()) - make_interval(months => ${months})
           ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         GROUP BY 1 ORDER BY total DESC
      `.execute(trx),
      sql<any>`
        WITH rev AS (
          SELECT to_char(server_received_at, 'YYYY-MM') AS month, branch_id, SUM(grand_total) AS revenue
            FROM invoices WHERE status = 'FINAL'
             AND server_received_at >= date_trunc('month', now()) - make_interval(months => ${months})
             ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
           GROUP BY 1, 2
        ), exp AS (
          SELECT to_char(created_at, 'YYYY-MM') AS month, branch_id, SUM(amount) AS expenses
            FROM expenses WHERE status = 'APPROVED'
             AND created_at >= date_trunc('month', now()) - make_interval(months => ${months})
             ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
           GROUP BY 1, 2
        )
        SELECT COALESCE(rev.month, exp.month) AS month, b.name AS branch_name,
               COALESCE(rev.revenue, 0) AS revenue, COALESCE(exp.expenses, 0) AS expenses,
               CASE WHEN COALESCE(rev.revenue, 0) > 0
                    THEN round((COALESCE(exp.expenses, 0) / rev.revenue) * 100, 2) END AS expense_to_revenue_pct
          FROM rev FULL OUTER JOIN exp ON rev.month = exp.month AND rev.branch_id = exp.branch_id
          JOIN branches b ON b.branch_id = COALESCE(rev.branch_id, exp.branch_id)
         ORDER BY 1
      `.execute(trx),
    ]);

    return { by_month: byMonth.rows, by_category: byCategory.rows, expense_vs_revenue: ratio.rows };
  }));
}
