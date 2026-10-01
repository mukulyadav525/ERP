// ============================================================================
// Section 9 — Expenses (spec §36)
// Branch-scoped entry, receipt reference, and an approval workflow that only
// engages above a configurable threshold — small everyday spends should not need
// the owner's attention, large ones must. An expense is dated the day the money
// was spent, and says how it was paid and to whom.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, str, optionalStr, num, oneOf, writeBranch, resolveBranchScope, limit as clampLimit,
} from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { businessToday } from '../../lib/dates.js';

const METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(v: unknown, field: string, fallback?: string): string {
  if (v === undefined || v === null || v === '') {
    if (fallback) return fallback;
    throw badRequest(`${field} is required.`);
  }
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(new Date(s).getTime())) throw badRequest(`${field} must be a date.`);
  return s;
}

/** The receipt reference is a link or a short document id — never a filesystem path. */
function receiptRef(v: unknown): string | null {
  const s = optionalStr(v, 'Receipt link', { max: 500 });
  if (!s) return null;
  if (!/^https?:\/\//i.test(s) && !/^[\w\-./]{1,80}$/.test(s)) {
    throw badRequest('The receipt must be a web link (https://…) or a short reference number.');
  }
  if (/^[./]|\.\./.test(s)) throw badRequest('That receipt reference is not allowed.');
  return s;
}

export default async function expensesRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_expenses', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const from = q.from ? dateValue(q.from, 'From date') : null;
    const to = q.to ? dateValue(q.to, 'To date') : null;
    return (await sql<any>`
      SELECT e.expense_id, e.branch_id, b.name AS branch_name, e.category_id, c.name AS category_name,
             e.amount, e.expense_date, e.payment_method, e.payee, e.reference, e.description, e.receipt_url,
             e.status, e.reject_reason, e.created_at, e.paid_from_till_session_id, e.created_by,
             ureq.full_name AS requested_by_name, uapp.full_name AS approved_by_name
        FROM expenses e
        JOIN expense_categories c ON c.category_id = e.category_id
        JOIN branches b ON b.branch_id = e.branch_id
        LEFT JOIN users ureq ON ureq.user_id = e.created_by
        LEFT JOIN users uapp ON uapp.user_id = e.approved_by
       WHERE 1=1 ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND e.status = ${oneOf(q.status, 'status', ['PENDING', 'APPROVED', 'REJECTED'] as const)}::expense_status` : sql``}
         ${q.category_id ? sql`AND e.category_id = ${uuid(q.category_id, 'category_id')}` : sql``}
         ${q.payment_method ? sql`AND e.payment_method = ${oneOf(q.payment_method, 'Payment method', METHODS)}` : sql``}
         ${from ? sql`AND e.expense_date >= ${from}::date` : sql``}
         ${to ? sql`AND e.expense_date <= ${to}::date` : sql``}
         ${q.q ? sql`AND (e.description ILIKE ${'%' + q.q.trim() + '%'} OR e.payee ILIKE ${'%' + q.q.trim() + '%'} OR e.reference ILIKE ${'%' + q.q.trim() + '%'})` : sql``}
       ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
  }));

  app.post('/', guarded('create_expense', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    const amount = num(body.amount, 'Amount', { min: 0.01, max: 100_000_000 });
    const today = businessToday();
    const expenseDate = dateValue(body.expense_date, 'Expense date', today);
    if (expenseDate > today) throw badRequest('An expense cannot be dated in the future.');
    const method = oneOf(body.payment_method ?? 'CASH', 'Payment method', METHODS);
    const categoryId = uuid(body.category_id, 'Category');
    const category = (await sql<any>`SELECT name FROM expense_categories WHERE category_id = ${categoryId}`.execute(trx)).rows[0];
    if (!category) throw badRequest('Choose an expense category.');
    const settings = await loadSettings(trx, branchId);

    // Section 9 — the threshold decides whether this needs approval at all.
    // Anything at or below it from a manager is approved on entry, so routine
    // spending does not silently pile up in a queue nobody looks at.
    const threshold = Number(settings.expense_approval_threshold);
    const autoApprove = amount <= threshold && ['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role);

    const row = (await sql<any>`
      INSERT INTO expenses (branch_id, category_id, amount, expense_date, payment_method, payee, reference,
                            description, receipt_url, status, created_by, approved_by)
      VALUES (${branchId}, ${categoryId}, ${amount}, ${expenseDate}, ${method},
              ${optionalStr(body.payee, 'Paid to', { max: 150 })},
              ${optionalStr(body.reference, 'Reference', { max: 80 })},
              ${optionalStr(body.description, 'Description', { max: 500 })},
              ${receiptRef(body.receipt_url)},
              ${autoApprove ? 'APPROVED' : 'PENDING'}::expense_status,
              ${session.user_id}, ${autoApprove ? session.user_id : null})
      RETURNING *
    `.execute(trx)).rows[0];
    await audit(trx, session, 'EXPENSE_CREATED', 'expenses', row.expense_id,
      { after: { amount, category: category.name, expense_date: expenseDate, method, auto_approved: autoApprove } },
      { branchId });

    return {
      ...row,
      requires_approval: !autoApprove,
      message: autoApprove
        ? 'Recorded and approved.'
        : `Above the ₹${threshold} approval threshold — sent for approval.`,
    };
  }));

  /** A pending expense can be corrected by whoever raised it (or a manager). Once
   *  decided it is part of the books and is not edited. */
  app.put('/:id', guarded('create_expense', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'expense_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const e = (await sql<any>`SELECT * FROM expenses WHERE expense_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!e) throw notFound('Expense not found.');
    if (e.status !== 'PENDING') throw conflict(`This expense is already ${e.status.toLowerCase()} and cannot be edited.`);
    const manager = ['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role);
    if (!manager && e.created_by !== session.user_id) throw forbidden('Only the person who raised this expense, or a manager, can edit it.');
    const today = businessToday();
    const expenseDate = body.expense_date === undefined ? e.expense_date : dateValue(body.expense_date, 'Expense date');
    if (expenseDate > today) throw badRequest('An expense cannot be dated in the future.');
    await sql`
      UPDATE expenses SET
        amount = ${body.amount === undefined ? e.amount : num(body.amount, 'Amount', { min: 0.01, max: 100_000_000 })},
        category_id = ${body.category_id === undefined ? e.category_id : uuid(body.category_id, 'Category')},
        expense_date = ${expenseDate},
        payment_method = ${body.payment_method === undefined ? e.payment_method : oneOf(body.payment_method, 'Payment method', METHODS)},
        payee = ${body.payee === undefined ? e.payee : optionalStr(body.payee, 'Paid to', { max: 150 })},
        reference = ${body.reference === undefined ? e.reference : optionalStr(body.reference, 'Reference', { max: 80 })},
        description = ${body.description === undefined ? e.description : optionalStr(body.description, 'Description', { max: 500 })},
        receipt_url = ${body.receipt_url === undefined ? e.receipt_url : receiptRef(body.receipt_url)}
      WHERE expense_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'EXPENSE_CREATED', 'expenses', id, { before: { amount: e.amount }, after: { edited: body } },
      { branchId: e.branch_id });
    return { ok: true };
  }));

  app.post('/:id/approve', guarded('approve_expense', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'expense_id');
    const expense = (await sql<any>`SELECT * FROM expenses WHERE expense_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!expense) throw notFound('Expense not found.');
    if (expense.status !== 'PENDING') throw badRequest(`That expense is already ${expense.status.toLowerCase()}.`);
    // Approving your own claim defeats the point of having an approval step.
    if (expense.created_by === session.user_id && session.role !== 'OWNER_ADMIN') {
      throw forbidden('You cannot approve an expense you raised yourself. Ask the owner to approve it.');
    }

    await sql`
      UPDATE expenses SET status = 'APPROVED', approved_by = ${session.user_id} WHERE expense_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'EXPENSE_APPROVED', 'expenses', id, { after: { amount: expense.amount } },
      { branchId: expense.branch_id });
    return { ok: true };
  }));

  app.post('/:id/reject', guarded('approve_expense', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'expense_id');
    const reason = optionalStr((req.body as any)?.reason, 'Reason', { max: 300 });
    const expense = (await sql<any>`SELECT * FROM expenses WHERE expense_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!expense) throw notFound('Expense not found.');
    if (expense.status !== 'PENDING') throw badRequest(`That expense is already ${expense.status.toLowerCase()}.`);

    await sql`
      UPDATE expenses SET status = 'REJECTED', approved_by = ${session.user_id}, reject_reason = ${reason}
       WHERE expense_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'EXPENSE_REJECTED', 'expenses', id, { after: { reason } }, { branchId: expense.branch_id });
    return { ok: true };
  }));

  app.get('/categories', guarded(null, async ({ db: trx }) =>
    (await sql<any>`SELECT * FROM expense_categories ORDER BY name`.execute(trx)).rows));

  app.post('/categories', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const name = str((req.body as any)?.name, 'Category name', { max: 100 });
    const dup = (await sql<any>`SELECT name FROM expense_categories WHERE lower(btrim(name)) = lower(btrim(${name}))`.execute(trx)).rows[0];
    if (dup) throw conflict(`An expense category called "${dup.name}" already exists.`);
    const row = (await sql<any>`INSERT INTO expense_categories (name) VALUES (${name}) RETURNING *`.execute(trx)).rows[0];
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'expense_categories', row.category_id, { after: row });
    return row;
  }));

  /** Section 9 — branch-wise and month-over-month comparison, plus the
   *  expense-vs-revenue ratio the requirement names explicitly. */
  app.get('/summary', guarded('view_expenses', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const months = Math.min(Math.max(Number(q.months) || 12, 1), 36);

    const [byMonth, byCategory, ratio, pending] = await Promise.all([
      sql<any>`
        SELECT to_char(e.expense_date, 'YYYY-MM') AS month, b.name AS branch_name,
               SUM(e.amount) AS total
          FROM expenses e JOIN branches b ON b.branch_id = e.branch_id
         WHERE e.status = 'APPROVED'
           AND e.expense_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => ${months})
           ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         GROUP BY 1, 2 ORDER BY 1
      `.execute(trx),
      sql<any>`
        SELECT c.name AS category_name, SUM(e.amount) AS total, COUNT(*) AS entry_count
          FROM expenses e JOIN expense_categories c ON c.category_id = e.category_id
         WHERE e.status = 'APPROVED'
           AND e.expense_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => ${months})
           ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         GROUP BY 1 ORDER BY total DESC
      `.execute(trx),
      sql<any>`
        WITH rev AS (
          SELECT to_char(server_received_at, 'YYYY-MM') AS month, branch_id, SUM(grand_total + round_off) AS revenue
            FROM invoices WHERE status = 'FINAL'
             AND server_received_at >= date_trunc('month', CURRENT_DATE) - make_interval(months => ${months})
             ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
           GROUP BY 1, 2
        ), exp AS (
          SELECT to_char(expense_date, 'YYYY-MM') AS month, branch_id, SUM(amount) AS expenses
            FROM expenses WHERE status = 'APPROVED'
             AND expense_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => ${months})
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
      sql<any>`
        SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM expenses
         WHERE status = 'PENDING' ${branchId ? sql`AND branch_id = ${branchId}` : sql``}
      `.execute(trx),
    ]);

    return {
      by_month: byMonth.rows, by_category: byCategory.rows, expense_vs_revenue: ratio.rows,
      pending: { count: Number(pending.rows[0].count), total: Number(pending.rows[0].total) },
    };
  }));
}
