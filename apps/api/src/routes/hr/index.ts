// ============================================================================
// Section 10 — HR / Staff
//   10.1 attendance (in-app check-in by default, biometric/manual configurable)
//   10.2 sales attribution per employee, feeding the incentive report
//   10.3 payroll, off in Phase 1 and feature-flagged on
//   10.4 shifts and leave
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, str, optionalStr, num, oneOf,
  writeBranch, resolveBranchScope, limit as clampLimit,
} from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { round2 } from '../../lib/tax.js';
import { audit } from '../../lib/audit.js';

export default async function hrRoutes(app: FastifyInstance) {
  app.get('/employees', guarded('view_hr', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT e.employee_id, e.branch_id, b.name AS branch_name, e.user_id,
             u.full_name, u.role, u.phone, u.email, u.is_active, e.designation, e.joined_at,
             (SELECT count(*) FROM attendance a
               WHERE a.employee_id = e.employee_id AND a.work_date >= CURRENT_DATE - 30) AS days_present_30d
        FROM employees e
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE 1=1 ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
       ORDER BY u.full_name LIMIT ${clampLimit(q.limit, 100, 300)}
    `.execute(trx)).rows;
  }));

  /**
   * Creating an employee creates a login too — the two are the same person and
   * splitting them is how you end up with staff who exist on the roster but
   * cannot sign in. The credential itself is set through /auth (hashed there);
   * this endpoint never touches a password field.
   */
  app.post('/employees', guarded('manage_staff', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    const role = oneOf(body.role ?? 'CASHIER', 'Role',
      ['BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'] as const);
    const phone = str(body.phone, 'Phone number', { max: 20 });
    const pin = optionalStr(body.pin, 'PIN', { max: 6 });
    if (pin && !/^[0-9]{4,6}$/.test(pin)) throw badRequest('A PIN must be 4 to 6 digits.');

    const existing = (await sql<any>`SELECT user_id FROM users WHERE phone = ${phone}`.execute(trx)).rows[0];
    if (existing) throw badRequest('Someone is already registered with that phone number.');

    const user = (await sql<any>`
      INSERT INTO users (branch_id, role, full_name, phone, email, pin_hash, language_pref, must_change_password)
      VALUES (${branchId}, ${role}::user_role, ${str(body.full_name, 'Full name', { max: 120 })}, ${phone},
              ${optionalStr(body.email, 'Email', { max: 254 })},
              ${pin ? sql`crypt(${pin}, gen_salt('bf', 12))` : null},
              ${optionalStr(body.language_pref, 'language') ?? 'en'}, TRUE)
      RETURNING user_id, full_name, role
    `.execute(trx)).rows[0];

    const employee = (await sql<any>`
      INSERT INTO employees (user_id, branch_id, designation, joined_at)
      VALUES (${user.user_id}, ${branchId}, ${optionalStr(body.designation, 'Designation', { max: 100 }) ?? role},
              ${optionalStr(body.joined_at, 'Joining date', { max: 20 }) ?? new Date().toISOString().slice(0, 10)}::date)
      RETURNING *
    `.execute(trx)).rows[0];

    await audit(trx, session, 'USER_CREATED', 'employees', employee.employee_id, { after: { role, branchId } });
    return { ...employee, full_name: user.full_name, role: user.role };
  }));

  // ── Attendance (10.1) ─────────────────────────────────────────────────────
  app.get('/attendance', guarded('view_hr', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT a.*, u.full_name, e.branch_id, b.name AS branch_name,
             EXTRACT(EPOCH FROM (a.check_out - a.check_in)) / 3600 AS hours_worked
        FROM attendance a
        JOIN employees e ON e.employee_id = a.employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE 1=1 ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         ${q.employee_id ? sql`AND a.employee_id = ${uuid(q.employee_id, 'employee_id')}` : sql``}
         ${q.from ? sql`AND a.work_date >= ${q.from}::date` : sql``}
         ${q.to ? sql`AND a.work_date <= ${q.to}::date` : sql``}
       ORDER BY a.work_date DESC, u.full_name LIMIT ${clampLimit(q.limit, 200, 1000)}
    `.execute(trx)).rows;
  }));

  /** Every role can mark their own attendance; only a manager can mark someone else's. */
  app.post('/attendance/check-in', guarded('mark_attendance', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const settings = await loadSettings(trx, session.branch_id);

    const ownEmployeeId = (await sql<any>`
      SELECT employee_id FROM employees WHERE user_id = ${session.user_id}
    `.execute(trx)).rows[0]?.employee_id ?? null;

    const employee = body.employee_id
      ? (() => {
          if (!['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role)) {
            throw forbidden('Only a manager can mark attendance for someone else.');
          }
          return uuid(body.employee_id, 'employee_id');
        })()
      : ownEmployeeId;
    if (!employee) throw badRequest('No employee record is linked to your account.');

    // Comparing a user id against an employee id (which is what this used to do)
    // is never equal, so a self check-in was always recorded as a manual entry by
    // a manager. The comparison has to be employee id to employee id.
    const method = employee !== ownEmployeeId ? 'MANUAL' : String(settings.attendance_method);

    const row = (await sql<any>`
      INSERT INTO attendance (employee_id, work_date, check_in, method)
      VALUES (${employee}, CURRENT_DATE, now(), ${method})
      ON CONFLICT (employee_id, work_date) DO UPDATE
        SET check_in = COALESCE(attendance.check_in, now())
      RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  app.post('/attendance/check-out', guarded('mark_attendance', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Same authority rule as check-in. Without it anyone could close out anyone
    // else's shift, which is the half that actually decides hours worked.
    const employee = body.employee_id
      ? (() => {
          if (!['OWNER_ADMIN', 'BRANCH_MANAGER'].includes(session.role)) {
            throw forbidden('Only a manager can mark attendance for someone else.');
          }
          return uuid(body.employee_id, 'employee_id');
        })()
      : (await sql<any>`SELECT employee_id FROM employees WHERE user_id = ${session.user_id}`.execute(trx)).rows[0]?.employee_id;
    if (!employee) throw badRequest('No employee record is linked to your account.');

    const row = (await sql<any>`
      UPDATE attendance SET check_out = now()
       WHERE employee_id = ${employee} AND work_date = CURRENT_DATE
      RETURNING *
    `.execute(trx)).rows[0];
    if (!row) throw badRequest('No check-in has been recorded for today.');
    return row;
  }));

  // ── Leave (10.4) ──────────────────────────────────────────────────────────
  app.get('/leave-requests', guarded('view_hr', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT lr.*, u.full_name, e.branch_id, b.name AS branch_name,
             (lr.to_date - lr.from_date + 1) AS days, ua.full_name AS approved_by_name
        FROM leave_requests lr
        JOIN employees e ON e.employee_id = lr.employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
        LEFT JOIN users ua ON ua.user_id = lr.approved_by
       WHERE 1=1 ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND lr.status = ${q.status}` : sql``}
       ORDER BY lr.from_date DESC LIMIT ${clampLimit(q.limit, 100, 300)}
    `.execute(trx)).rows;
  }));

  app.post('/leave-requests', guarded('mark_attendance', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const employee = (await sql<any>`SELECT employee_id FROM employees WHERE user_id = ${session.user_id}`.execute(trx)).rows[0]?.employee_id;
    if (!employee) throw badRequest('No employee record is linked to your account.');
    const from = str(body.from_date, 'From date', { max: 20 });
    const to = str(body.to_date, 'To date', { max: 20 });
    if (new Date(to) < new Date(from)) throw badRequest('The end date cannot be before the start date.');

    return (await sql<any>`
      INSERT INTO leave_requests (employee_id, from_date, to_date, status)
      VALUES (${employee}, ${from}::date, ${to}::date, 'PENDING') RETURNING *
    `.execute(trx)).rows[0];
  }));

  app.post('/leave-requests/:id/decide', guarded('approve_leave', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'leave_request_id');
    const status = oneOf((req.body as any)?.status, 'Decision', ['APPROVED', 'REJECTED'] as const);
    const updated = (await sql<any>`
      UPDATE leave_requests SET status = ${status}, approved_by = ${session.user_id}
       WHERE id = ${id} AND status = 'PENDING' RETURNING *
    `.execute(trx)).rows[0];
    if (!updated) throw notFound('That leave request is not pending a decision.');
    return updated;
  }));

  // ── Shifts (10.4) ─────────────────────────────────────────────────────────
  app.get('/shifts', guarded('view_hr', async ({ session, db: trx, req }) => {
    const branchId = resolveBranchScope(session, (req.query as any)?.branch_id);
    return (await sql<any>`
      SELECT s.*, b.name AS branch_name FROM shifts s JOIN branches b ON b.branch_id = s.branch_id
       WHERE 1=1 ${branchId ? sql`AND s.branch_id = ${branchId}` : sql``} ORDER BY s.start_time
    `.execute(trx)).rows;
  }));

  app.post('/shifts', guarded('manage_staff', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    return (await sql<any>`
      INSERT INTO shifts (branch_id, name, start_time, end_time)
      VALUES (${branchId}, ${str(body.name, 'Shift name', { max: 60 })},
              ${str(body.start_time, 'Start time', { max: 8 })}::time,
              ${str(body.end_time, 'End time', { max: 8 })}::time)
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  app.get('/roster', guarded('view_hr', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT es.*, u.full_name, s.name AS shift_name, s.start_time, s.end_time, b.name AS branch_name
        FROM employee_shifts es
        JOIN employees e ON e.employee_id = es.employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN shifts s ON s.shift_id = es.shift_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE es.work_date >= COALESCE(${q.from ?? null}::date, CURRENT_DATE)
         AND es.work_date <= COALESCE(${q.to ?? null}::date, CURRENT_DATE + 14)
         ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
       ORDER BY es.work_date, s.start_time
    `.execute(trx)).rows;
  }));

  app.post('/roster', guarded('manage_staff', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return (await sql<any>`
      INSERT INTO employee_shifts (employee_id, shift_id, work_date)
      VALUES (${uuid(body.employee_id, 'Employee')}, ${uuid(body.shift_id, 'Shift')},
              ${str(body.work_date, 'Date', { max: 20 })}::date)
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  /** 10.2 — sales attribution, which is what an incentive scheme runs off. */
  app.get('/performance', guarded('view_hr', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 365);
    return (await sql<any>`
      SELECT e.employee_id, u.full_name, u.role, b.name AS branch_name,
             COALESCE(s.revenue, 0) AS revenue,
             COALESCE(s.invoice_count, 0) AS invoice_count,
             CASE WHEN COALESCE(s.invoice_count, 0) > 0
                  THEN round(s.revenue / s.invoice_count, 2) END AS avg_ticket,
             COALESCE(a.days_present, 0) AS days_present,
             CASE WHEN COALESCE(a.days_present, 0) > 0
                  THEN round(COALESCE(s.revenue, 0) / a.days_present, 2) END AS revenue_per_day
        FROM employees e
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
        LEFT JOIN LATERAL (
            SELECT SUM(i.grand_total) AS revenue, COUNT(*) AS invoice_count
              FROM invoices i
             WHERE i.sold_by_employee_id = e.employee_id AND i.status = 'FINAL'
               AND i.server_received_at >= now() - make_interval(days => ${days})
        ) s ON TRUE
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS days_present FROM attendance a
             WHERE a.employee_id = e.employee_id AND a.work_date >= CURRENT_DATE - ${days}::int
        ) a ON TRUE
       WHERE u.is_active ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
       ORDER BY revenue DESC NULLS LAST
    `.execute(trx)).rows;
  }));

  // ── Payroll (10.3) — feature-flagged off in Phase 1 ───────────────────────
  app.get('/payroll', guarded('run_payroll', async ({ session, db: trx, req }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!settings.enable_payroll_module) {
      throw forbidden('The payroll module is switched off. Turn on "Enable payroll module" in Admin Settings.');
    }
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT pe.*, u.full_name, b.name AS branch_name
        FROM payroll_entries pe
        JOIN employees e ON e.employee_id = pe.employee_id
        JOIN users u ON u.user_id = e.user_id
        JOIN branches b ON b.branch_id = e.branch_id
       WHERE 1=1 ${q.month ? sql`AND pe.pay_month = ${q.month}::date` : sql``}
       ORDER BY pe.pay_month DESC, u.full_name LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx)).rows;
  }));

  app.post('/payroll', guarded('run_payroll', async ({ session, db: trx, req }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!settings.enable_payroll_module) {
      throw forbidden('The payroll module is switched off. Turn on "Enable payroll module" in Admin Settings.');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const base = num(body.base_salary, 'Base salary', { min: 0 });
    const incentives = body.incentives === undefined ? 0 : num(body.incentives, 'Incentives', { min: 0 });
    const deductions = body.deductions === undefined ? 0 : num(body.deductions, 'Deductions', { min: 0 });

    return (await sql<any>`
      INSERT INTO payroll_entries (employee_id, pay_month, base_salary, incentives, deductions, net_pay)
      VALUES (${uuid(body.employee_id, 'Employee')}, ${str(body.pay_month, 'Pay month', { max: 20 })}::date,
              ${base}, ${incentives}, ${deductions}, ${round2(base + incentives - deductions)})
      ON CONFLICT (employee_id, pay_month) DO UPDATE
        SET base_salary = EXCLUDED.base_salary, incentives = EXCLUDED.incentives,
            deductions = EXCLUDED.deductions, net_pay = EXCLUDED.net_pay
      RETURNING *
    `.execute(trx)).rows[0];
  }));
}
