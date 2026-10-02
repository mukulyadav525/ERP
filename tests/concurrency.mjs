// ============================================================================
// Concurrency and duplicate-submission chaos.
//
// Every money- or stock-moving action is fired several times AT ONCE — the
// double-click, the retry after a timeout, two cashiers on the same item, two
// tabs on the same draft — and the database is then checked: one invoice, one
// payment, one stock movement, numbers unique and gapless, no negative stock,
// no balance driven below zero.
//
//   node tests/concurrency.mjs     (needs the seeded demo database)
// ============================================================================
import pg from '../node_modules/pg/lib/index.js';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail !== '' ? `  ${C.d}${String(detail).slice(0, 120)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 220)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

async function call(method, path, { token, body, branch } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(branch ? { 'X-Branch-Id': branch } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const statuses = (rs) => rs.map((r) => r.status).join(',');
async function login(email, password) {
  // Rate-limited when run straight after other suites: wait it out, don't fail.
  for (let i = 0; i < 6; i += 1) {
    const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
    if (r.status === 200) return r.body.token;
    if (r.status !== 429) throw new Error(`login ${email}: ${r.status}`);
    await new Promise((res) => setTimeout(res, 15000));
  }
  throw new Error(`login ${email}: still rate-limited`);
}

const db = new pg.Client({ connectionString: DB });
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const one = async (sql, p = []) => (await q(sql, p))[0];

try {
  const manager = await login('sunita@hardwareerp.in', 'Manager@12345');    // Andheri West
  const thaneMgr = await login('vikas@hardwareerp.in', 'Manager@12345');    // Thane
  const owner = await login('owner@hardwareerp.in', 'Owner@12345');
  const andheri = (await one(`SELECT branch_id FROM users WHERE email = 'sunita@hardwareerp.in'`)).branch_id;
  const thane = (await one(`SELECT branch_id FROM users WHERE email = 'vikas@hardwareerp.in'`)).branch_id;

  // A plain counted item with plenty of free stock at Andheri.
  const item = await one(`
    SELECT p.product_id, pu.product_unit_id, bs.base_unit_qty - bs.reserved_qty AS free
      FROM products p
      JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit AND pu.multiplier_to_base = 1
      JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = $1
     WHERE p.is_active AND NOT p.batch_tracked AND NOT p.serial_tracked AND p.base_unit = 'PIECE'
       AND bs.base_unit_qty - bs.reserved_qty > 100
     ORDER BY bs.base_unit_qty DESC LIMIT 1`, [andheri]);
  const stockOf = async (productId, branchId = andheri) =>
    Number((await one(`SELECT base_unit_qty FROM branch_stock WHERE product_id = $1 AND branch_id = $2`, [productId, branchId])).base_unit_qty);
  const priceOne = async (qty = 1) => {
    const d = await call('POST', '/api/billing/drafts', { token: manager,
      body: { invoice_type: 'GST', lines: [{ product_id: item.product_id, product_unit_id: item.product_unit_id, qty_in_sale_unit: qty }] } });
    await call('DELETE', `/api/billing/drafts/${d.body.invoice_id}`, { token: manager });
    return Number(d.body.totals.payable);
  };
  const saleBody = (qty, payable, extra = {}) => ({
    invoice_type: 'GST',
    lines: [{ product_id: item.product_id, product_unit_id: item.product_unit_id, qty_in_sale_unit: qty }],
    payments: [{ method: 'UPI', amount: payable, ref_no: 'CHAOS' }], ...extra,
  });

  // ── 1. The same sale submitted six times at once ─────────────────────────
  section('The same sale, six submissions at once (double-click / retry)');
  const p1 = await priceOne(1);
  const s0 = await stockOf(item.product_id);
  const txn = randomUUID();
  const dup = await parallel(6, () => call('POST', '/api/billing/invoices', { token: manager, body: saleBody(1, p1, { client_txn_id: txn }) }));
  check('every submission is answered 200', dup.every((r) => r.status === 200), statuses(dup) + ' ' + JSON.stringify(dup.find((r) => r.status !== 200)?.body ?? ''));
  check('…all with the same bill', new Set(dup.map((r) => r.body.invoice_id)).size === 1);
  const rows1 = await one(`SELECT count(*)::int AS n FROM invoices WHERE client_txn_id = $1`, [txn]);
  check('exactly one invoice exists', rows1.n === 1, `${rows1.n}`);
  check('stock left once', Math.abs(s0 - await stockOf(item.product_id) - 1) < 1e-9, `${s0} → ${await stockOf(item.product_id)}`);

  // ── 2. Twelve different sales at once: numbering ─────────────────────────
  section('Twelve different sales at once at one branch');
  const many = await parallel(12, () => call('POST', '/api/billing/invoices', { token: manager, body: saleBody(1, p1, { client_txn_id: randomUUID() }) }));
  check('all twelve are billed', many.every((r) => r.status === 200), statuses(many));
  const nums = many.map((r) => r.body.invoice_number).filter(Boolean);
  check('twelve different invoice numbers', new Set(nums).size === 12, nums.join(' '));
  const seqs = nums.map((n) => Number(n.split('/').pop())).sort((a, b) => a - b);
  check('…consecutive, with no gap between them', seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), seqs.join(','));
  const dupNums = await one(`SELECT count(*)::int AS n FROM (SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x`);
  check('no invoice number exists twice anywhere', dupNums.n === 0);

  // ── 3. One draft finalised from four tabs at once ────────────────────────
  section('One draft, Finalise pressed in four tabs at once');
  const dr = await call('POST', '/api/billing/drafts', { token: manager,
    body: { invoice_type: 'GST', lines: [{ product_id: item.product_id, product_unit_id: item.product_unit_id, qty_in_sale_unit: 2 }] } });
  const s3 = await stockOf(item.product_id);
  const fin = await parallel(4, () => call('POST', `/api/billing/drafts/${dr.body.invoice_id}/finalize`, { token: manager,
    body: { payments: [{ method: 'UPI', amount: Number(dr.body.totals.payable), ref_no: 'TABS' }] } }));
  check('exactly one finalise succeeds', fin.filter((r) => r.status === 200).length === 1, statuses(fin));
  check('…the others are told it is already done', fin.filter((r) => r.status !== 200).every((r) => r.status === 409), statuses(fin));
  check('stock left once (2)', Math.abs(s3 - await stockOf(item.product_id) - 2) < 1e-9);
  const pays3 = await one(`SELECT count(*)::int AS n FROM invoice_payments WHERE invoice_id = $1`, [dr.body.invoice_id]);
  check('one payment line on the bill', pays3.n === 1, `${pays3.n}`);

  // ── 4. Two cashiers sell the last units at once ──────────────────────────
  section('Two counters sell the last units at the same moment');
  const scarce = await one(`
    SELECT p.product_id, pu.product_unit_id, bs.base_unit_qty - bs.reserved_qty AS free
      FROM products p
      JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit AND pu.multiplier_to_base = 1
      JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = $1
     WHERE p.is_active AND NOT p.batch_tracked AND NOT p.serial_tracked AND p.base_unit = 'PIECE'
       AND bs.base_unit_qty - bs.reserved_qty BETWEEN 3 AND 400 AND p.product_id <> $2
     ORDER BY bs.base_unit_qty LIMIT 1`, [andheri, item.product_id]);
  const free = Math.floor(Number(scarce.free));
  const dq = await call('POST', '/api/billing/drafts', { token: manager,
    body: { invoice_type: 'GST', lines: [{ product_id: scarce.product_id, product_unit_id: scarce.product_unit_id, qty_in_sale_unit: free }] } });
  const pay4 = Number(dq.body.totals.payable);
  await call('DELETE', `/api/billing/drafts/${dq.body.invoice_id}`, { token: manager });
  const last = await parallel(2, () => call('POST', '/api/billing/invoices', { token: manager,
    body: { invoice_type: 'GST', lines: [{ product_id: scarce.product_id, product_unit_id: scarce.product_unit_id, qty_in_sale_unit: free }],
            payments: [{ method: 'UPI', amount: pay4, ref_no: 'LAST' }], client_txn_id: randomUUID() } }));
  check('only one of the two sales goes through', last.filter((r) => r.status === 200).length === 1, statuses(last));
  check('…the other is refused for stock, not a crash', last.some((r) => r.status === 409 && /Not enough stock/i.test(r.body.error ?? '')),
    JSON.stringify(last.map((r) => r.body.error ?? r.body.invoice_number)));
  check('stock never goes negative', (await stockOf(scarce.product_id)) >= 0, `${await stockOf(scarce.product_id)}`);

  // ── 5. Three returns against two sold units, at once ─────────────────────
  section('Three returns at once against a line of two');
  const sold = await call('POST', '/api/billing/invoices', { token: manager, body: saleBody(2, await priceOne(2), { client_txn_id: randomUUID() }) });
  const inv5 = await call('GET', `/api/billing/invoices/${sold.body.invoice_id}`, { token: manager });
  const lineId = inv5.body.lines[0].line_id;
  const rets = await parallel(3, () => call('POST', '/api/returns', { token: manager,
    body: { invoice_id: sold.body.invoice_id, return_reason: 'chaos', refund_method: 'UPI', lines: [{ invoice_line_id: lineId, qty: 1, condition: 'RESELLABLE' }] } }));
  check('at most two of the three returns are accepted', rets.filter((r) => r.status === 200).length === 2, statuses(rets));
  const back = await one(`SELECT COALESCE(SUM(qty_base_unit), 0)::numeric AS q FROM sales_return_lines WHERE invoice_line_id = $1`, [lineId]);
  check('no more comes back than was sold', Number(back.q) <= 2, `${back.q}`);

  // ── 6. The same customer receipt submitted five times ────────────────────
  section('A customer receipt, five submissions at once');
  const owing = await one(`
    SELECT c.customer_id, d.balance FROM erp_customer_dues() d JOIN customers c USING (customer_id)
     WHERE d.balance > 1000 AND c.is_active ORDER BY d.balance DESC LIMIT 1`);
  const before6 = Number(owing.balance);
  const rtxn = randomUUID();
  const rcpts = await parallel(5, () => call('POST', `/api/customers/${owing.customer_id}/payments`, { token: manager,
    body: { amount: 100, method: 'UPI', reference: 'DUP', client_txn_id: rtxn } }));
  check('every submission is answered 200', rcpts.every((r) => r.status === 200), statuses(rcpts) + ' ' + JSON.stringify(rcpts.find((r) => r.status !== 200)?.body ?? ''));
  const n6 = await one(`SELECT count(*)::int AS n FROM customer_payments WHERE client_txn_id = $1`, [rtxn]);
  check('exactly one receipt recorded', n6.n === 1, `${n6.n}`);
  const after6 = Number((await one(`SELECT balance FROM erp_customer_dues($1)`, [owing.customer_id])).balance);
  check('the balance fell by 100 once', Math.abs(before6 - after6 - 100) < 0.01, `${before6} → ${after6}`);

  // ── 7. Different receipts that together would overpay ────────────────────
  section('Three different receipts at once that together overpay');
  const target = await one(`
    SELECT c.customer_id, d.balance FROM erp_customer_dues() d JOIN customers c USING (customer_id)
     WHERE d.balance BETWEEN 300 AND 100000 AND c.is_active AND c.customer_id <> $1 ORDER BY d.balance LIMIT 1`, [owing.customer_id]);
  const owed7 = Number(target.balance);
  const part = Math.round(owed7 * 0.6 * 100) / 100;
  const over = await parallel(3, () => call('POST', `/api/customers/${target.customer_id}/payments`, { token: manager,
    body: { amount: part, method: 'UPI', reference: 'OVR', client_txn_id: randomUUID() } }));
  check('only one 60% receipt fits the balance', over.filter((r) => r.status === 200).length === 1, statuses(over));
  const after7 = Number((await one(`SELECT balance FROM erp_customer_dues($1)`, [target.customer_id])).balance);
  check('the customer is never driven into credit by accident', after7 >= -0.005, `${owed7} → ${after7}`);

  // ── 8. Supplier payments that together overpay ───────────────────────────
  section('Supplier payments at once that together overpay');
  const vend = await one(`
    SELECT v.vendor_id, l.balance_after FROM vendors v
      JOIN LATERAL (SELECT balance_after FROM vendor_ledger WHERE vendor_id = v.vendor_id ORDER BY created_at DESC, entry_id DESC LIMIT 1) l ON TRUE
     WHERE l.balance_after > 300 ORDER BY l.balance_after LIMIT 1`);
  const vpart = Math.round(Number(vend.balance_after) * 0.6 * 100) / 100;
  const vpays = await parallel(3, () => call('POST', `/api/vendors/${vend.vendor_id}/payments`, { token: owner,
    body: { amount: vpart, method: 'UPI', reference: 'VOVR', branch_id: andheri, client_txn_id: randomUUID() } }));
  check('only one 60% supplier payment fits', vpays.filter((r) => r.status === 200).length === 1, statuses(vpays));
  const vafter = Number((await one(`SELECT balance_after FROM vendor_ledger WHERE vendor_id = $1 ORDER BY created_at DESC, entry_id DESC LIMIT 1`, [vend.vendor_id])).balance_after);
  check('the supplier is never overpaid', vafter >= -0.005, `${vend.balance_after} → ${vafter}`);

  // ── 9. A transfer received three times at once ───────────────────────────
  section('One transfer, Receive pressed three times at once');
  const t = await call('POST', '/api/inventory/transfers', { token: manager, body: { to_branch_id: thane, lines: [{ product_id: item.product_id, qty: 3 }] } });
  await call('POST', `/api/inventory/transfers/${t.body.transfer_id}/dispatch`, { token: manager, body: {} });
  const td = (await call('GET', `/api/inventory/transfers/${t.body.transfer_id}`, { token: thaneMgr })).body;
  const t0 = await stockOf(item.product_id, thane).catch(() => 0);
  const recv = await parallel(3, () => call('POST', `/api/inventory/transfers/${t.body.transfer_id}/receive`, { token: thaneMgr,
    body: { lines: td.lines.map((l) => ({ line_id: l.line_id, received_qty: Number(l.dispatched_qty) })) } }));
  check('exactly one receipt of the transfer', recv.filter((r) => r.status === 200).length === 1, statuses(recv));
  check('Thane gains the 3 units once', Math.abs(await stockOf(item.product_id, thane) - t0 - 3) < 1e-9);

  // ── 10. A bill voided three times at once ────────────────────────────────
  section('One bill, Void pressed three times at once');
  const vb = await call('POST', '/api/billing/invoices', { token: manager, body: saleBody(1, p1, { client_txn_id: randomUUID() }) });
  const s10 = await stockOf(item.product_id);
  const voids = await parallel(3, () => call('POST', `/api/billing/invoices/${vb.body.invoice_id}/void`, { token: manager, body: { reason: 'chaos void' } }));
  check('exactly one void', voids.filter((r) => r.status === 200).length === 1, statuses(voids));
  check('stock comes back once', Math.abs(await stockOf(item.product_id) - s10 - 1) < 1e-9);

  // ── 11. An estimate converted three times at once ────────────────────────
  section('One estimate, Convert pressed three times at once');
  const anyCust = await one(`SELECT customer_id FROM customers WHERE is_active LIMIT 1`);
  const qt = await call('POST', '/api/quotations', { token: manager, body: { customer_id: anyCust.customer_id,
    lines: [{ product_id: item.product_id, product_unit_id: item.product_unit_id, qty: 1 }] } });
  await call('POST', `/api/quotations/${qt.body.quotation_id}/approve`, { token: manager, body: { reserve_stock: false } });
  const convs = await parallel(3, () => call('POST', `/api/quotations/${qt.body.quotation_id}/convert`, { token: manager }));
  const drafts = await one(`SELECT count(*)::int AS n FROM invoices WHERE source_quotation_id = $1 AND status = 'DRAFT'`, [qt.body.quotation_id]).catch(() => ({ n: -1 }));
  check('one draft bill from the estimate', drafts.n === 1 || (drafts.n === -1 && new Set(convs.filter((r) => r.status === 200).map((r) => r.body.draft_invoice_id)).size === 1),
    `${drafts.n} drafts; ${statuses(convs)}`);

  // ── 12. Credit sales racing a limit ──────────────────────────────────────
  section('Two credit sales at once against one credit limit');
  const cc = await call('POST', '/api/customers', { token: owner, body: { name: `Race Credit ${Date.now()}`, phone: `97${String(Date.now()).slice(-8)}`, customer_type: 'RETAIL' } });
  check('a fresh credit customer is created', cc.status === 200, cc.body.error ?? '');
  const p12 = await priceOne(2);
  await call('PUT', `/api/customers/${cc.body.customer_id}/credit`, { token: owner, body: { credit_allowed: true, credit_limit: Math.ceil(p12 * 1.5) } });
  const credits = await parallel(2, () => call('POST', '/api/billing/invoices', { token: manager,
    body: { ...saleBody(2, p12, { client_txn_id: randomUUID(), customer_id: cc.body.customer_id }), payments: [{ method: 'CREDIT', amount: p12 }] } }));
  check('only one fits under the limit', credits.filter((r) => r.status === 200).length === 1, statuses(credits) + ' ' + JSON.stringify(credits.map((r) => r.body.error ?? r.body.invoice_number)));
  const bal12 = Number((await one(`SELECT balance FROM erp_customer_dues($1)`, [cc.body.customer_id]))?.balance ?? 0);
  check('the balance never exceeds the limit', bal12 <= Math.ceil(p12 * 1.5) + 0.01, `${bal12}`);

  // ── 13. Cancelling one receipt three times at once ───────────────────────
  section('One receipt, Cancel pressed three times at once');
  const rc = await call('POST', `/api/customers/${owing.customer_id}/payments`, { token: manager, body: { amount: 50, method: 'UPI', reference: 'C3', client_txn_id: randomUUID() } });
  const b13 = Number((await one(`SELECT balance FROM erp_customer_dues($1)`, [owing.customer_id])).balance);
  const cans = await parallel(3, () => call('POST', `/api/customers/payments/${rc.body.payment_id}/cancel`, { token: manager, body: { reason: 'chaos' } }));
  check('exactly one cancellation', cans.filter((r) => r.status === 200).length === 1, statuses(cans));
  const a13 = Number((await one(`SELECT balance FROM erp_customer_dues($1)`, [owing.customer_id])).balance);
  check('the balance goes back up by 50 once', Math.abs(a13 - b13 - 50) < 0.01, `${b13} → ${a13}`);

  // ── 14. Ledger and stock still agree ─────────────────────────────────────
  section('After all of that, every book still balances');
  const drift = await one(`
    SELECT count(*)::int AS n FROM branch_stock bs
     WHERE abs(bs.base_unit_qty - COALESCE((SELECT SUM(base_unit_qty_change) FROM stock_ledger l
                                            WHERE l.branch_id = bs.branch_id AND l.product_id = bs.product_id), 0)) > 0.0001`);
  check('stock on hand equals the stock ledger, everywhere', drift.n === 0, `${drift.n} rows drift`);
  const cdrift = await one(`
    SELECT count(*)::int AS n FROM customers c
     WHERE abs(COALESCE((SELECT balance_after FROM customer_credit_ledger l WHERE l.customer_id = c.customer_id
                          ORDER BY created_at DESC, entry_id DESC LIMIT 1), 0)
             - COALESCE((SELECT SUM(amount) FROM customer_credit_ledger l WHERE l.customer_id = c.customer_id), 0)) > 0.005`);
  check('every customer running balance equals the sum of their ledger', cdrift.n === 0, `${cdrift.n} customers drift`);
  const pdrift = await one(`
    SELECT count(*)::int AS n FROM invoices i
     WHERE i.status = 'FINAL'
       AND abs((SELECT COALESCE(SUM(amount), 0) FROM invoice_payments p WHERE p.invoice_id = i.invoice_id)
               - (i.grand_total + i.round_off)) > 0.01`);
  check('every final bill is paid exactly its total', pdrift.n === 0, `${pdrift.n} bills differ`);
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
console.log(`${C.g}Nothing doubled, nothing lost, nothing negative, every book balances.${C.x}`);
