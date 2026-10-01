// ============================================================================
// Fixing mistakes, and who may do it. Every "I typed it wrong" path, checked
// through the API and then against the database, for each role that should and
// should not be able to take it.
//
//   users        Owner edits name / phone / email / password; one staff record
//   staff        a Branch Manager adds and edits their own counter staff only
//   my account   change own password and PIN; check in; request leave
//   GST rates    a wrong rate is corrected in place; no back-dating past a later rate
//   expenses     categories renamed by the people who record expenses
//   shifts       shifts edited, roster entries removed
//   payments     a receipt / supplier payment recorded by mistake is cancelled:
//                balance restored, reports exclude it, cannot cancel twice
//
//   node tests/edits-and-roles.mjs     (needs the seeded demo database)
// ============================================================================
import pg from '../node_modules/pg/lib/index.js';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail !== '' ? `  ${C.d}${String(detail).slice(0, 110)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 200)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(email, password) {
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
    if (r.status === 200) return r.body.token;
    if (r.status !== 429) return null;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}
async function loginPin(phone, pin) {
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/auth/login/pin', { body: { phone, pin } });
    if (r.status === 200) return r.body.token;
    if (r.status !== 429) return null;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}
const phone = () => `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (q, p = []) => (await db.query(q, p)).rows[0];

try {
  const owner = await login('owner@hardwareerp.in', 'Owner@12345');
  const manager = await login('sunita@hardwareerp.in', 'Manager@12345');       // Andheri West
  const accountant = await login('meera@hardwareerp.in', 'Account@12345');     // Andheri West
  const cashier = await loginPin('9900000005', '1234');                        // Andheri West
  const inventory = await loginPin('9900000008', '1234');                      // Andheri West
  check('every role signs in', Boolean(owner && manager && accountant && cashier && inventory));

  const andheri = (await one(`SELECT branch_id FROM users WHERE email = 'sunita@hardwareerp.in'`)).branch_id;
  const thane = (await one(`SELECT branch_id FROM users WHERE email = 'vikas@hardwareerp.in'`)).branch_id;

  // ── Owner edits a user ────────────────────────────────────────────────────
  section('Owner corrects a user (Admin → Users)');
  const target = await one(`SELECT user_id FROM users WHERE phone = '9900000007'`);   // Pune cashier
  const newPhone = phone();
  const newEmail = `fixed.${Date.now()}@shop.in`;
  let r = await call('PUT', `/api/auth/users/${target.user_id}`, { token: owner,
    body: { full_name: 'Corrected Name', phone: newPhone, email: newEmail, password: 'Corrected@123' } });
  check('name, phone, email and password saved', r.status === 200, JSON.stringify(r.body));
  const after = await one(`SELECT full_name, phone, email FROM users WHERE user_id = $1`, [target.user_id]);
  check('the database holds the new details', after.full_name === 'Corrected Name' && after.phone === newPhone && after.email === newEmail);
  check('the new password signs in', Boolean(await login(newEmail, 'Corrected@123')));
  r = await call('PUT', `/api/auth/users/${target.user_id}`, { token: owner, body: { phone: '9900000005' } });
  check('a phone already in use is refused', r.status === 400 && /already has that phone/.test(r.body.error), r.body.error);
  r = await call('PUT', `/api/auth/users/${target.user_id}`, { token: owner, body: { email: 'not-an-email' } });
  check('an invalid email is refused', r.status === 400);
  await call('PUT', `/api/auth/users/${target.user_id}`, { token: owner, body: { role: 'CASHIER' } });
  await call('PUT', `/api/auth/users/${target.user_id}`, { token: owner, body: { full_name: 'Corrected Again' } });
  const staffRows = await one(`SELECT count(*)::int AS n FROM employees WHERE user_id = $1`, [target.user_id]);
  check('saving a user again and again keeps ONE staff record', staffRows.n === 1, `${staffRows.n} rows`);
  r = await call('PUT', `/api/auth/users/${target.user_id}`, { token: manager, body: { full_name: 'x' } });
  check('a manager cannot use Admin → Users', r.status === 403);

  // ── Manager adds and edits their own staff ───────────────────────────────
  section('Branch manager and their staff (Staff page)');
  const staffPhone = phone();
  r = await call('POST', '/api/hr/employees', { token: manager,
    body: { full_name: 'New Counter Hand', phone: staffPhone, role: 'CASHIER', pin: '5678' } });
  check('a manager adds a cashier to their branch', r.status === 200, JSON.stringify(r.body).slice(0, 120));
  const added = await one(`SELECT u.branch_id, e.employee_id FROM users u JOIN employees e USING (user_id) WHERE u.phone = $1`, [staffPhone]);
  check('…at the manager\'s own branch', added?.branch_id === andheri);
  r = await call('POST', '/api/hr/employees', { token: manager,
    body: { full_name: 'Would Be Manager', phone: phone(), role: 'BRANCH_MANAGER' } });
  check('a manager cannot add another manager', r.status === 403, r.body.error);
  r = await call('POST', '/api/hr/employees', { token: manager, body: { full_name: 'Dup', phone: '9900000006', role: 'CASHIER' } });
  check('a phone used at ANOTHER branch is still caught', r.status === 400 && /already registered/.test(r.body.error), r.body.error);

  r = await call('PUT', `/api/hr/employees/${added.employee_id}`, { token: manager,
    body: { full_name: 'Counter Hand (fixed)', designation: 'Senior cashier', pin: '2468' } });
  check('the manager corrects their cashier\'s details and PIN', r.status === 200, JSON.stringify(r.body));
  check('the new PIN signs in', Boolean(await loginPin(staffPhone, '2468')));

  const thaneStaff = await one(`SELECT e.employee_id FROM employees e JOIN users u USING (user_id) WHERE e.branch_id = $1 AND u.role = 'CASHIER' LIMIT 1`, [thane]);
  r = await call('PUT', `/api/hr/employees/${thaneStaff.employee_id}`, { token: manager, body: { full_name: 'Hijack' } });
  check('a manager cannot edit another branch\'s staff', r.status === 404, `${r.status}`);
  const peer = await one(`SELECT e.employee_id FROM employees e JOIN users u USING (user_id) WHERE u.email = 'sunita@hardwareerp.in'`);
  r = await call('PUT', `/api/hr/employees/${peer.employee_id}`, { token: manager, body: { full_name: 'Self Promote' } });
  check('a manager cannot edit a manager (themselves included)', r.status === 403);
  r = await call('PUT', `/api/hr/employees/${added.employee_id}`, { token: cashier, body: { full_name: 'x' } });
  check('a cashier cannot edit staff', r.status === 403);

  const handToken = await loginPin(staffPhone, '2468');
  r = await call('PUT', `/api/hr/employees/${added.employee_id}`, { token: manager, body: { is_active: false } });
  check('the manager deactivates someone who has left', r.status === 200);
  r = await call('GET', '/api/auth/me', { token: handToken });
  check('…and their open session ends at once', r.status === 401, `${r.status}`);

  // ── My account ───────────────────────────────────────────────────────────
  section('My account (anyone, for themselves)');
  r = await call('POST', '/api/auth/change-password', { token: accountant, body: { current_password: 'wrong', new_password: 'Account@99999' } });
  check('a wrong current password is refused', r.status === 401);
  r = await call('POST', '/api/auth/change-password', { token: accountant, body: { current_password: 'Account@12345', new_password: 'Account@99999' } });
  check('the accountant changes their own password', r.status === 200);
  check('the new password signs in', Boolean(await login('meera@hardwareerp.in', 'Account@99999')));
  await call('POST', '/api/auth/change-password', { token: accountant, body: { current_password: 'Account@99999', new_password: 'Account@12345' } });
  r = await call('POST', '/api/auth/set-pin', { token: cashier, body: { pin: '1234' } });
  check('a cashier sets their own PIN', r.status === 200);
  r = await call('GET', '/api/hr/me', { token: inventory });
  check('inventory staff see their own day', r.status === 200 && Boolean(r.body.employee_id));
  r = await call('POST', '/api/hr/attendance/check-in', { token: inventory, body: {} });
  check('…and check in without the Staff page', r.status === 200);
  r = await call('GET', '/api/hr/me', { token: inventory });
  check('today shows the check-in', Boolean(r.body.today?.check_in));
  r = await call('POST', '/api/hr/leave-requests', { token: inventory, body: { from_date: '2031-01-05', to_date: '2031-01-06' } });
  check('…and request leave', r.status === 200);
  r = await call('GET', '/api/hr/employees', { token: inventory });
  check('…but still cannot list the staff', r.status === 403);

  // ── GST rates ────────────────────────────────────────────────────────────
  section('GST rates (Catalog → GST rates)');
  const hsn = `99${String(Date.now()).slice(-6)}`;
  r = await call('POST', '/api/catalog/hsn-rates', { token: owner, body: { hsn_code: hsn, gst_rate_pct: 12, effective_from: '2030-04-01' } });
  check('a new HSN rate is added', r.status === 200);
  r = await call('POST', '/api/catalog/hsn-rates', { token: owner, body: { hsn_code: hsn, gst_rate_pct: 18, effective_from: '2030-04-01' } });
  check('the same date corrects the rate in place', r.status === 200 && Number(r.body.gst_rate_pct) === 18, JSON.stringify(r.body));
  const rows = await one(`SELECT count(*)::int AS n, max(gst_rate_pct)::numeric AS rate FROM hsn_tax_rates WHERE hsn_code = $1`, [hsn]);
  check('…leaving one row at 18%', rows.n === 1 && Number(rows.rate) === 18, `${rows.n} rows`);
  r = await call('POST', '/api/catalog/hsn-rates', { token: owner, body: { hsn_code: hsn, gst_rate_pct: 5, effective_from: '2030-01-01' } });
  check('a rate dated before the latest one is refused', r.status === 400, r.body.error);
  r = await call('POST', '/api/catalog/hsn-rates', { token: manager, body: { hsn_code: hsn, gst_rate_pct: 5, effective_from: '2030-05-01' } });
  check('a manager cannot change GST rates', r.status === 403);

  // ── Expense categories ───────────────────────────────────────────────────
  section('Expense categories');
  const catName = `Electrcity ${Date.now()}`;
  r = await call('POST', '/api/expenses/categories', { token: accountant, body: { name: catName } });
  check('the accountant adds a category', r.status === 200);
  const catId = r.body.category_id;
  r = await call('PUT', `/api/expenses/categories/${catId}`, { token: accountant, body: { name: catName.replace('Electrcity', 'Electricity') } });
  check('…and fixes its spelling', r.status === 200 && r.body.name.startsWith('Electricity'));
  r = await call('PUT', `/api/expenses/categories/${catId}`, { token: owner, body: { name: 'Rent' } });
  const rentExists = await one(`SELECT 1 AS x FROM expense_categories WHERE lower(name) = 'rent'`);
  check('renaming onto an existing name is refused', rentExists ? r.status === 409 : r.status === 200, `${r.status}`);
  r = await call('POST', '/api/expenses/categories', { token: inventory, body: { name: 'Nope' } });
  check('inventory staff cannot add expense categories', r.status === 403);

  // ── Shifts ───────────────────────────────────────────────────────────────
  section('Shifts and roster');
  r = await call('POST', '/api/hr/shifts', { token: manager, body: { name: 'Mornng', start_time: '09:00', end_time: '17:00' } });
  const shiftId = r.body.shift_id;
  r = await call('PUT', `/api/hr/shifts/${shiftId}`, { token: manager, body: { name: 'Morning', start_time: '09:30', end_time: '17:30' } });
  check('a shift is renamed and its hours changed', r.status === 200 && r.body.name === 'Morning' && String(r.body.start_time).startsWith('09:30'));
  const someone = await one(`SELECT employee_id FROM employees WHERE branch_id = $1 LIMIT 1`, [andheri]);
  r = await call('POST', '/api/hr/roster', { token: manager, body: { employee_id: someone.employee_id, shift_id: shiftId, work_date: '2031-02-01' } });
  const rosterId = r.body.id;
  r = await call('DELETE', `/api/hr/roster/${rosterId}`, { token: manager });
  check('a wrong roster entry is removed', r.status === 200);
  check('…and is gone', !(await one(`SELECT 1 AS x FROM employee_shifts WHERE id = $1`, [rosterId])));

  // ── Cancelling a receipt ─────────────────────────────────────────────────
  section('A customer receipt recorded by mistake');
  const cust = await one(`
    SELECT c.customer_id, d.balance FROM erp_customer_dues() d JOIN customers c USING (customer_id)
     WHERE d.balance > 500 AND c.is_active ORDER BY d.balance DESC LIMIT 1`);
  const balBefore = Number(cust.balance);
  r = await call('POST', `/api/customers/${cust.customer_id}/payments`, { token: manager,
    body: { amount: 250, method: 'UPI', reference: 'TYPO-250', client_txn_id: randomUUID() } });
  check('a receipt is recorded', r.status === 200, r.body.error ?? '');
  const receipt = r.body;
  check('the balance goes down by 250', Math.abs(Number(receipt.balance_owed) - (balBefore - 250)) < 0.01);
  r = await call('POST', `/api/customers/payments/${receipt.payment_id}/cancel`, { token: cashier, body: { reason: 'typo' } });
  check('a cashier cannot cancel a receipt', r.status === 403);
  r = await call('POST', `/api/customers/payments/${receipt.payment_id}/cancel`, { token: accountant, body: {} });
  check('a reason is required', r.status === 400);
  r = await call('POST', `/api/customers/payments/${receipt.payment_id}/cancel`, { token: accountant, body: { reason: 'Wrong customer' } });
  check('the accountant cancels it', r.status === 200, JSON.stringify(r.body));
  check('the balance is back where it was', Math.abs(Number(r.body.balance_owed) - balBefore) < 0.01, `${r.body.balance_owed} vs ${balBefore}`);
  const dues = await one(`SELECT balance FROM erp_customer_dues($1)`, [cust.customer_id]);
  check('the outstanding list agrees', Math.abs(Number(dues.balance) - balBefore) < 0.01);
  r = await call('POST', `/api/customers/payments/${receipt.payment_id}/cancel`, { token: owner, body: { reason: 'again' } });
  check('it cannot be cancelled twice', r.status === 409);
  r = await call('GET', `/api/customers/${cust.customer_id}`, { token: manager });
  const shown = (r.body.payments ?? []).find((p) => p.payment_id === receipt.payment_id);
  check('the receipt stays on file, marked cancelled', Boolean(shown?.cancelled_at) && shown.cancel_reason === 'Wrong customer');
  r = await call('GET', '/api/reports/payments-register?preset=today', { token: owner });
  check('the payments register leaves it out', Array.isArray(r.body) && !r.body.some((x) => x.document === receipt.receipt_number || x.number === receipt.receipt_number
    || Object.values(x).includes(receipt.receipt_number)));
  const auditRow = await one(`SELECT 1 AS x FROM audit_log WHERE action = 'PAYMENT_CANCELLED' AND entity_id = $1`, [receipt.payment_id]);
  check('the cancellation is in the audit trail', Boolean(auditRow));

  // ── Cancelling a supplier payment ────────────────────────────────────────
  section('A supplier payment recorded by mistake');
  const vend = await one(`
    SELECT DISTINCT ON (vendor_id) vendor_id, balance_after FROM vendor_ledger
     ORDER BY vendor_id, created_at DESC, entry_id DESC`);
  const vendRow = await one(`
    SELECT v.vendor_id, l.balance_after FROM vendors v
      JOIN LATERAL (SELECT balance_after FROM vendor_ledger WHERE vendor_id = v.vendor_id ORDER BY created_at DESC, entry_id DESC LIMIT 1) l ON TRUE
     WHERE l.balance_after > 100 LIMIT 1`);
  const v = vendRow ?? vend;
  const vBefore = Number(v.balance_after);
  const dueBefore = await one(`SELECT COALESCE(SUM(amount_due), 0) AS d FROM erp_vendor_bill_dues($1)`, [v.vendor_id]);
  r = await call('POST', `/api/vendors/${v.vendor_id}/payments`, { token: owner,
    body: { amount: 75, method: 'UPI', reference: 'OOPS-75', branch_id: andheri, client_txn_id: randomUUID() } });
  check('a supplier payment is recorded', r.status === 200, r.body.error ?? '');
  const vp = r.body;
  r = await call('POST', `/api/vendors/payments/${vp.payment_id}/cancel`, { token: manager, body: { reason: 'x' } });
  check('a manager cannot cancel supplier payments', r.status === 403);
  r = await call('POST', `/api/vendors/payments/${vp.payment_id}/cancel`, { token: accountant, body: { reason: 'Paid the wrong supplier' } });
  check('the accountant cancels it', r.status === 200, JSON.stringify(r.body));
  check('what is payable is back where it was', Math.abs(Number(r.body.balance_after) - vBefore) < 0.01, `${r.body.balance_after} vs ${vBefore}`);
  const dueAfter = await one(`SELECT COALESCE(SUM(amount_due), 0) AS d FROM erp_vendor_bill_dues($1)`, [v.vendor_id]);
  check('the bill-by-bill dues are back too', Math.abs(Number(dueAfter.d) - Number(dueBefore.d)) < 0.01, `${dueAfter.d} vs ${dueBefore.d}`);
} catch (err) {
  failures.push(`suite crashed: ${err.stack ?? err}`);
  console.log(`${C.r}suite crashed:${C.x}`, err);
} finally {
  await db.end();
}

console.log(`\n${'─'.repeat(70)}\n${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) {
  console.log(`${C.r}Failures:${C.x}`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`${C.g}Every correction path works, for exactly the roles that should have it.${C.x}`);
