// ============================================================================
// Attack simulation: what a curious or malicious user can do with a valid login
// and a copy of the network tab.
//
//   cross-branch   another branch's records by id — read, change, download
//   headers/body   X-Branch-Id and branch_id pointed at a branch you don't work at
//   roles          endpoints above your role, called directly
//   mass assign    extra fields in a body (credit limit, price) that your role
//                  may not set must be ignored or refused, never applied
//   sessions       forged, signed-out and missing tokens
//   input          injection strings, script tags, absurd numbers, huge bodies
//
//   node tests/security.mjs     (needs the seeded demo database)
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
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 220)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

async function call(method, path, { token, body, branch, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(branch ? { 'X-Branch-Id': branch } : {}),
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, type: res.headers.get('content-type') ?? '' };
}
async function login(email, password) {
  const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return r.body.token;
}
async function loginPin(phone, pin) {
  const r = await call('POST', '/api/auth/login/pin', { body: { phone, pin } });
  if (r.status !== 200) throw new Error(`pin ${phone}: ${r.status}`);
  return r.body.token;
}
const denied = (r) => r.status === 403 || r.status === 404;

const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

try {
  const owner = await login('owner@hardwareerp.in', 'Owner@12345');
  const andheriMgr = await login('sunita@hardwareerp.in', 'Manager@12345');
  const thaneMgr = await login('vikas@hardwareerp.in', 'Manager@12345');
  const cashier = await loginPin('9900000005', '1234');           // Andheri
  const andheri = (await one(`SELECT branch_id FROM users WHERE email = 'sunita@hardwareerp.in'`)).branch_id;
  const thane = (await one(`SELECT branch_id FROM users WHERE email = 'vikas@hardwareerp.in'`)).branch_id;
  const pune = (await one(`SELECT branch_id FROM users WHERE email = 'anita@hardwareerp.in'`)).branch_id;

  // Andheri's records, by id.
  const inv = await one(`SELECT invoice_id, status FROM invoices WHERE branch_id = $1 AND status = 'FINAL' ORDER BY server_received_at DESC LIMIT 1`, [andheri]);
  const draft = await one(`SELECT invoice_id FROM invoices WHERE branch_id = $1 AND status = 'DRAFT' LIMIT 1`, [andheri]);
  const quote = await one(`SELECT quotation_id FROM quotations WHERE branch_id = $1 LIMIT 1`, [andheri]);
  const ret = await one(`SELECT return_id, credit_note_id FROM sales_returns WHERE branch_id = $1 AND credit_note_id IS NOT NULL LIMIT 1`, [andheri]);
  const po = await one(`SELECT po_id FROM purchase_orders WHERE branch_id = $1 LIMIT 1`, [andheri]);
  const grn = await one(`SELECT grn_id FROM grn WHERE branch_id = $1 LIMIT 1`, [andheri]);
  const audit = await one(`SELECT audit_id FROM stock_audits WHERE branch_id = $1 LIMIT 1`, [andheri]);
  const transfer = await one(`SELECT transfer_id FROM stock_transfers WHERE from_branch_id = $1 AND to_branch_id <> $2 LIMIT 1`, [andheri, thane]);
  let expense = await one(`SELECT expense_id FROM expenses WHERE branch_id = $1 AND status = 'PENDING' LIMIT 1`, [andheri]);
  if (!expense) {
    const cat = await one(`SELECT category_id FROM expense_categories LIMIT 1`);
    const made = await call('POST', '/api/expenses', { token: andheriMgr, body: { category_id: cat.category_id, amount: 999999, payment_method: 'CASH', description: 'security probe' } });
    expense = made.body?.expense_id ? { expense_id: made.body.expense_id } : null;
    check('an Andheri expense waiting for approval exists to attack', Boolean(expense), JSON.stringify(made.body).slice(0, 100));
  }
  const till = await one(`SELECT session_id FROM till_sessions WHERE branch_id = $1 LIMIT 1`, [andheri]);
  const receipt = await one(`SELECT payment_id FROM customer_payments WHERE branch_id = $1 LIMIT 1`, [andheri]);

  // ── Another branch's records ─────────────────────────────────────────────
  section("Thane's manager goes after Andheri's records by id");
  const reads = [
    ['bill', inv && `/api/billing/invoices/${inv.invoice_id}`],
    ['bill PDF', inv && `/api/billing/invoices/${inv.invoice_id}/pdf`],
    ['draft', draft && `/api/billing/drafts/${draft.invoice_id}`],
    ['estimate', quote && `/api/quotations/${quote.quotation_id}`],
    ['estimate PDF', quote && `/api/quotations/${quote.quotation_id}/pdf`],
    ['return', ret && `/api/returns/${ret.return_id}`],
    ['credit note PDF', ret && `/api/returns/credit-notes/${ret.credit_note_id}/pdf`],
    ['purchase order', po && `/api/inventory/purchase-orders/${po.po_id}`],
    ['supplier bill', grn && `/api/inventory/grn/${grn.grn_id}`],
    ['stock take', audit && `/api/inventory/stock-audits/${audit.audit_id}`],
    ['transfer to Pune', transfer && `/api/inventory/transfers/${transfer.transfer_id}`],
    ['till reconciliation', till && `/api/billing/till-sessions/${till.session_id}/reconcile`],
  ];
  for (const [what, path] of reads) {
    if (!path) { check(`(no Andheri ${what} in the seed to try)`, true); continue; }
    const r = await call('GET', path, { token: thaneMgr });
    check(`cannot read Andheri's ${what}`, denied(r), `${r.status} ${typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 80) : r.type}`);
  }
  const writes = [
    ['void a bill', inv && ['POST', `/api/billing/invoices/${inv.invoice_id}/void`, { reason: 'x' }]],
    ['finalise a draft', draft && ['POST', `/api/billing/drafts/${draft.invoice_id}/finalize`, { payments: [{ method: 'CASH', amount: 1 }] }]],
    ['discard a draft', draft && ['DELETE', `/api/billing/drafts/${draft.invoice_id}`]],
    ['approve an estimate', quote && ['POST', `/api/quotations/${quote.quotation_id}/approve`, {}]],
    ['edit an estimate', quote && ['PUT', `/api/quotations/${quote.quotation_id}`, { notes: 'hijack' }]],
    ['approve an expense', expense && ['POST', `/api/expenses/${expense.expense_id}/approve`, {}]],
    ['edit an expense', expense && ['PUT', `/api/expenses/${expense.expense_id}`, { amount: 1 }]],
    ['cancel a receipt', receipt && ['POST', `/api/customers/payments/${receipt.payment_id}/cancel`, { reason: 'x' }]],
    ['receive a transfer meant for Pune', transfer && ['POST', `/api/inventory/transfers/${transfer.transfer_id}/receive`, { lines: [] }]],
    ['close a till', till && ['POST', `/api/billing/till-sessions/${till.session_id}/close`, { closing_counted_cash: 0 }]],
  ];
  const invBefore = inv && await one(`SELECT status FROM invoices WHERE invoice_id = $1`, [inv.invoice_id]);
  for (const [what, spec] of writes) {
    if (!spec) { check(`(no Andheri record to try "${what}")`, true); continue; }
    const [m, path, body] = spec;
    const r = await call(m, path, { token: thaneMgr, body });
    check(`cannot ${what} at Andheri`, r.status >= 400 && r.status < 500 && r.status !== 409, `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
  }
  if (inv) check("Andheri's bill is untouched", (await one(`SELECT status FROM invoices WHERE invoice_id = $1`, [inv.invoice_id])).status === invBefore.status);

  // ── Branch headers and bodies ────────────────────────────────────────────
  section('Pointing the branch header or body somewhere else');
  let r = await call('GET', '/api/billing/invoices?limit=5', { token: cashier, branch: thane });
  check('an Andheri cashier claiming Thane in the header is refused', r.status === 403, `${r.status}`);
  r = await call('GET', `/api/billing/invoices?limit=50&branch_id=${thane}`, { token: cashier });
  const leaked = Array.isArray(r.body) && r.body.some((i) => i.branch_id === thane || /THA/.test(i.invoice_number ?? ''));
  check('…and asking for Thane in the query returns only Andheri', r.status === 200 && !leaked, `${r.status} leaked=${leaked}`);
  const someCust = await one(`SELECT customer_id FROM erp_customer_dues() d WHERE balance > 100 LIMIT 1`);
  r = await call('POST', `/api/customers/${someCust.customer_id}/payments`, { token: cashier, body: { amount: 1, method: 'UPI', reference: 'x', branch_id: thane } });
  check('a receipt booked to Thane by an Andheri cashier is refused', r.status === 403, `${r.status} ${r.body.error ?? ''}`);
  r = await call('GET', '/api/billing/invoices?limit=1', { token: owner, branch: randomUUID() });
  check('the Owner naming a branch that does not exist is told so', r.status === 400, `${r.status}`);
  r = await call('GET', '/api/billing/invoices?limit=1', { token: owner, branch: "'; DROP TABLE invoices; --" });
  check('a branch header that is not an id is refused', r.status === 400, `${r.status}`);
  r = await call('POST', '/api/billing/till-sessions', { token: owner, body: { counter_id: 'X', opening_float: 0 } });
  check('the Owner on All branches is asked to pick a branch', r.status === 400 && /select a branch/i.test(r.body.error ?? ''), r.body.error);

  // ── Roles, called directly ───────────────────────────────────────────────
  section('A cashier calls endpoints above their role');
  const above = [
    ['void a bill', 'POST', inv ? `/api/billing/invoices/${inv.invoice_id}/void` : '/api/billing/invoices/x/void', { reason: 'x' }],
    ['set a credit limit', 'PUT', `/api/customers/${someCust.customer_id}/credit`, { credit_allowed: true, credit_limit: 999999 }],
    ['change a price', 'PUT', `/api/catalog/products/${(await one(`SELECT product_id FROM products LIMIT 1`)).product_id}/price`, { selling_price: 1 }],
    ['change settings', 'PUT', '/api/admin/settings/staff_discount_limit_pct', { value: 100 }],
    ['list users', 'GET', '/api/auth/users'],
    ['create a user', 'POST', '/api/auth/users', { full_name: 'x', phone: '9123456789', role: 'OWNER_ADMIN', password: 'Password123' }],
    ['adjust stock', 'POST', '/api/inventory/stock-adjustments', { lines: [] }],
    ['pay a supplier', 'POST', `/api/vendors/${(await one(`SELECT vendor_id FROM vendors LIMIT 1`)).vendor_id}/payments`, { amount: 1, method: 'CASH' }],
    ['read the audit trail', 'GET', '/api/admin/audit-log'],
    ['export customer data', 'GET', `/api/customers/${someCust.customer_id}/export`],
    ['merge customers', 'POST', '/api/customers/merge', {}],
    ['run payroll', 'POST', '/api/hr/payroll', {}],
  ];
  for (const [what, m, path, body] of above) {
    r = await call(m, path, { token: cashier, body });
    check(`cannot ${what}`, r.status === 403, `${r.status}`);
  }

  // ── Mass assignment ──────────────────────────────────────────────────────
  section('Extra fields slipped into a body');
  const custBefore = await one(`SELECT credit_limit, credit_allowed FROM customers WHERE customer_id = $1`, [someCust.customer_id]);
  r = await call('PUT', `/api/customers/${someCust.customer_id}`, { token: cashier, body: { credit_limit: 9999999, credit_allowed: true, loyalty_points_balance: 99999 } });
  const custAfter = await one(`SELECT credit_limit, credit_allowed, loyalty_points_balance FROM customers WHERE customer_id = $1`, [someCust.customer_id]);
  check('a cashier editing a customer cannot raise their credit limit', Number(custAfter.credit_limit) === Number(custBefore.credit_limit) && custAfter.credit_allowed === custBefore.credit_allowed,
    `${r.status} ${custBefore.credit_limit}→${custAfter.credit_limit}`);
  check('…or give them loyalty points', Number(custAfter.loyalty_points_balance) !== 99999);
  const prod = await one(`SELECT p.product_id, pp.selling_price FROM products p JOIN product_prices pp ON pp.product_id = p.product_id AND pp.effective_to IS NULL LIMIT 1`);
  r = await call('PUT', `/api/catalog/products/${prod.product_id}`, { token: andheriMgr, body: { selling_price: 1, name: undefined } });
  const priceAfter = await one(`SELECT selling_price FROM product_prices WHERE product_id = $1 AND effective_to IS NULL`, [prod.product_id]);
  check('a manager editing a product cannot change its price that way', Number(priceAfter.selling_price) === Number(prod.selling_price), `${prod.selling_price}→${priceAfter.selling_price}`);
  r = await call('POST', '/api/customers', { token: cashier, body: { name: `Sneaky ${Date.now()}`, phone: `96${String(Date.now()).slice(-8)}`, credit_allowed: true, credit_limit: 500000 } });
  const sneaky = r.body.customer_id && await one(`SELECT credit_allowed, credit_limit FROM customers WHERE customer_id = $1`, [r.body.customer_id]);
  check('a cashier creating a customer cannot give them credit', !sneaky || (!sneaky.credit_allowed && Number(sneaky.credit_limit) === 0), JSON.stringify(sneaky));
  r = await call('POST', '/api/hr/employees', { token: andheriMgr, body: { full_name: 'Owner Wannabe', phone: '9555512345', role: 'OWNER_ADMIN' } });
  check('a manager cannot create an owner through the staff screen', r.status === 400 || r.status === 403, `${r.status}`);

  // ── Sessions ─────────────────────────────────────────────────────────────
  section('Tokens');
  r = await call('GET', '/api/auth/me', { token: 'not-a-real-token' });
  check('a forged token is refused', r.status === 401);
  r = await call('GET', '/api/auth/me');
  check('no token is refused', r.status === 401);
  const throwaway = await login('meera@hardwareerp.in', 'Account@12345');
  await call('POST', '/api/auth/logout', { token: throwaway, body: {} });
  r = await call('GET', '/api/auth/me', { token: throwaway });
  check('a signed-out token stops working at once', r.status === 401, `${r.status}`);
  r = await call('POST', '/api/auth/login/password', { body: { email: 'owner@hardwareerp.in', password: "' OR '1'='1" } });
  check('SQL in the password field is just a wrong password', r.status === 401, `${r.status}`);

  // ── Input ────────────────────────────────────────────────────────────────
  section('Hostile and absurd input');
  r = await call('GET', `/api/catalog/products?q=${encodeURIComponent("' OR 1=1 --")}&limit=5`, { token: cashier });
  check('an injection string in search is searched for, not run', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, `${r.status} ${Array.isArray(r.body) ? r.body.length : ''}`);
  const xss = '<img src=x onerror=alert(1)>';
  r = await call('POST', '/api/customers', { token: cashier, body: { name: xss, phone: `95${String(Date.now()).slice(-8)}` } });
  check('a script tag as a name is stored as text', r.status === 200 && r.body.name === xss, `${r.status}`);
  if (r.status === 200) {
    const p1 = await one(`SELECT p.product_id, pu.product_unit_id FROM products p JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit
                            JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = $1 WHERE bs.base_unit_qty - bs.reserved_qty > 5 AND NOT p.batch_tracked AND NOT p.serial_tracked AND p.base_unit = 'PIECE' LIMIT 1`, [andheri]);
    const d = await call('POST', '/api/billing/drafts', { token: andheriMgr, body: { invoice_type: 'GST', customer_id: r.body.customer_id, lines: [{ product_id: p1.product_id, product_unit_id: p1.product_unit_id, qty_in_sale_unit: 1 }] } });
    const f = await call('POST', `/api/billing/drafts/${d.body.invoice_id}/finalize`, { token: andheriMgr, body: { payments: [{ method: 'UPI', amount: d.body.totals.payable, ref_no: 'x' }] } });
    const pdf = await fetch(`${API}/api/billing/invoices/${f.body.invoice_id}/pdf`, { headers: { Authorization: `Bearer ${andheriMgr}` } });
    check('…and a bill for that customer still prints', pdf.status === 200 && /pdf/.test(pdf.headers.get('content-type') ?? ''), `${pdf.status}`);
  }
  const p2 = await one(`SELECT p.product_id, pu.product_unit_id FROM products p JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit LIMIT 1`);
  for (const [what, qty] of [['a negative quantity', -5], ['zero', 0], ['a trillion', 1e12], ['text', 'lots']]) {
    r = await call('POST', '/api/billing/drafts', { token: andheriMgr, body: { invoice_type: 'GST', lines: [{ product_id: p2.product_id, product_unit_id: p2.product_unit_id, qty_in_sale_unit: qty }] } });
    check(`${what} as a quantity is refused with a message`, r.status === 400 && typeof r.body.error === 'string', `${r.status} ${r.body.error ?? ''}`);
  }
  r = await call('POST', '/api/customers', { token: cashier, raw: JSON.stringify({ name: 'x'.repeat(3_000_000), phone: '9000000000' }) });
  check('a 3 MB body is refused as too large', r.status === 413, `${r.status}`);
  r = await call('POST', '/api/customers', { token: cashier, raw: '{"name": ' });
  check('broken JSON is a 400, not a 500', r.status === 400, `${r.status}`);
  r = await call('GET', '/api/billing/invoices/not-a-uuid', { token: andheriMgr });
  check('a malformed id is a 400, not a 500', r.status === 400, `${r.status}`);
  r = await call('GET', `/api/billing/invoices/${randomUUID()}`, { token: andheriMgr });
  check('an id that does not exist is a 404', r.status === 404, `${r.status}`);
  r = await call('GET', '/health');
  const exposed = JSON.stringify(r.body);
  check('the public health check leaks no connection details', !/postgres|password|@|DATABASE_URL/i.test(exposed), exposed);
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
console.log(`${C.g}Every attempt was refused by the server.${C.x}`);
