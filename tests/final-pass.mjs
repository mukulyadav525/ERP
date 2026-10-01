// ============================================================================
// The final-pass suite: every capability added or repaired in the last pass,
// driven through the API and then checked against the database underneath.
//
//   branch context   "All branches" is never a transaction branch; X-Branch-Id is
//                    a request the server verifies; staff multi-branch access
//   units            100 G / 250 G / 500 G / KG / pack units, derived conversions,
//                    whole-number units, gram-based stock
//   numbering        two branches never print the same document number
//   integrity        a FINAL invoice cannot be edited, even by the app role
//   GST              the buyer's state decides IGST; purchases carry GST
//   money            receipts reach the till, are idempotent, cannot overpay;
//                    vendor payments, opening balances and statements reconcile
//   procurement      partial PO receipt, duplicate supplier bill, debit note GST
//   estimates        units, discounts, edit, convert → draft → final
//   reports          period presets agree with the raw tables
//   errors           malformed input is a 4xx with a plain message
//
//   node tests/final-pass.mjs
// ============================================================================
import pg from '../node_modules/pg/lib/index.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';
const APP_DB = process.env.DATABASE_URL;

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail !== '' ? `  ${C.d}${String(detail).slice(0, 110)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 200)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

async function call(method, path, { token, body, branch, raw, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(branch ? { 'X-Branch-Id': branch } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(email, password) {
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
    if (r.status === 200) return r.body;
    if (r.status !== 429) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`login ${email}: throttled`);
}
async function loginPin(phone, pin) {
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', '/api/auth/login/pin', { body: { phone, pin } });
    if (r.status === 200) return r.body;
    if (r.status !== 429) throw new Error(`pin login ${phone}: ${r.status} ${JSON.stringify(r.body)}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`pin login ${phone}: throttled`);
}
async function pdfText(path, token) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, text: '', status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  const f = join(mkdtempSync(join(tmpdir(), 'erp-fp-')), 'doc.pdf');
  writeFileSync(f, buf);
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } catch { /* absent */ }
  return { ok: true, text, status: res.status };
}

const pool = new pg.Pool({ connectionString: DB });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const money = (n) => Math.round(Number(n) * 100) / 100;
const stamp = Date.now().toString(36).toUpperCase();

const B1 = '11111111-1111-1111-1111-111111111111';
const B2 = '22222222-2222-2222-2222-222222222222';
const B3 = '33333333-3333-3333-3333-333333333333';

const owner = await login('owner@hardwareerp.in', 'Owner@12345');
const mgr = await login('sunita@hardwareerp.in', 'Manager@12345');
const accountant = await login('meera@hardwareerp.in', 'Account@12345');
let cashier = await loginPin('9900000005', '1234');

async function stockOf(branch, product) {
  return Number((await q('SELECT COALESCE(base_unit_qty,0) q FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [branch, product]))[0]?.q ?? 0);
}
async function sell(token, lines, { payments, customerId = null, invoiceType = 'GST', branch, extra = {} } = {}) {
  const draft = await call('POST', '/api/billing/drafts', { token, branch,
    body: { invoice_type: invoiceType, customer_id: customerId, lines, ...extra } });
  if (draft.status !== 200) return { draft, res: draft };
  const payable = draft.body.totals.payable;
  const res = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, { token, branch,
    body: { payments: payments ?? [{ method: 'CASH', amount: payable }] } });
  return { draft, res, payable };
}

try {
  // ══ 1. Branch context ═══════════════════════════════════════════════════════
  section('1 · "All branches" is never a transaction branch (spec §3)');
  {
    const r = await call('POST', '/api/billing/drafts', { token: owner.token, body: { invoice_type: 'GST' } });
    check('an owner on "All branches" is asked to pick a branch, in plain words',
      r.status === 400 && r.body.error === 'Please select a branch for this transaction.', `${r.status} ${r.body.error}`);
    check('…with a code the screen can react to', r.body.details?.code === 'BRANCH_REQUIRED');
    check('the internal "branch_id is required" wording is gone', !/branch_id/.test(JSON.stringify(r.body)));

    const ok = await call('POST', '/api/billing/drafts', { token: owner.token, branch: B2, body: { invoice_type: 'GST' } });
    check('with a branch picked in the top bar the draft opens there', ok.status === 200 && ok.body.branch_id === B2, ok.body.branch_id);
    if (ok.status === 200) await call('DELETE', `/api/billing/drafts/${ok.body.invoice_id}`, { token: owner.token, branch: B2 });

    const bad = await call('GET', '/api/billing/invoices?limit=1', { token: owner.token, branch: 'not-a-uuid' });
    check('a malformed branch header is a 400, not a 500', bad.status === 400, bad.status);

    const foreign = await call('GET', '/api/billing/invoices?limit=5', { token: cashier.token, branch: B2 });
    check('a cashier asking for another branch is refused', foreign.status === 403, `${foreign.status} ${foreign.body.error}`);

    const body = await call('POST', '/api/billing/drafts', { token: cashier.token, body: { branch_id: B2, invoice_type: 'GST' } });
    check('…and cannot smuggle it in the body either', body.status === 403, body.status);
  }

  section('1b · A staff member authorised for two branches');
  {
    const users = (await call('GET', '/api/auth/users?limit=300', { token: owner.token })).body;
    const ramesh = users.find((u) => u.phone === '9900000005');
    const grant = await call('PUT', `/api/auth/users/${ramesh.user_id}`, { token: owner.token,
      body: { extra_branch_ids: [B2] } });
    check('the owner grants a second branch', grant.status === 200, grant.status);
    const stale = await call('GET', '/api/auth/me', { token: cashier.token });
    check('the change signs the user out, so no session outlives its old scope', stale.status === 401, stale.status);
    cashier = await loginPin('9900000005', '1234');
    const br = (await call('GET', '/api/auth/branches', { token: cashier.token })).body;
    check('the user now sees exactly their two branches', br.length === 2 && br[0].branch_id === B1 && br.some((b) => b.branch_id === B2),
      br.map((b) => b.code).join(','));
    const at2 = await call('GET', '/api/billing/invoices?limit=20', { token: cashier.token, branch: B2 });
    check('acting at the second branch shows its bills', at2.status === 200 && at2.body.length > 0 && at2.body.every((i) => i.branch_id === B2),
      at2.body.length);
    const at3 = await call('GET', '/api/billing/invoices?limit=5', { token: cashier.token, branch: B3 });
    check('the third branch is still refused', at3.status === 403, at3.status);
    // RLS still holds in SQL: a transaction at B2 sees no B1 rows.
    if (APP_DB) {
      const app = new pg.Client({ connectionString: APP_DB });
      await app.connect();
      await app.query('BEGIN');
      await app.query(`SELECT set_config('erp.user_id',$1,true), set_config('erp.role','CASHIER',true), set_config('erp.branch_id',$2,true)`, [ramesh.user_id, B2]);
      const leak = (await app.query('SELECT count(*)::int n FROM invoices WHERE branch_id = $1', [B1])).rows[0].n;
      await app.query('ROLLBACK'); await app.end();
      check('in SQL, a transaction acting at branch 2 reads zero branch-1 invoices', leak === 0, leak);
    }
    await call('PUT', `/api/auth/users/${ramesh.user_id}`, { token: owner.token, body: { extra_branch_ids: [] } });
    cashier = await loginPin('9900000005', '1234');
  }

  // ══ 2. Units and 100 g ═══════════════════════════════════════════════════════
  section('2 · Units: conversions are data, 100 G is not a special case (spec §10–11)');
  let putty;
  {
    const units = (await call('GET', '/api/catalog/units', { token: cashier.token })).body;
    check('the units master ships the hardware units', ['PIECE', 'PCS', 'BOX', 'PACK', 'SET', 'PAIR', 'METRE', 'CM', 'MM', 'KG', 'G', '100G', 'LITRE', 'ML']
      .every((c) => units.some((u) => u.unit_code === c)), units.length);

    const sku = `FP-PUTTY-${stamp}`;
    const bad = await call('POST', '/api/catalog/products', { token: owner.token, body: {
      sku, name: 'Final-pass loose putty', base_unit: 'KG', hsn_code: '3214', selling_price: 40, mrp: 45,
      units: [{ unit_code: '100G', multiplier_to_base: 0.2 }] } });
    check('a wrong conversion for a measured unit is refused (1 × 100 G is always 0.1 KG)', bad.status === 400 && /0\.1/.test(bad.body.error), bad.body.error);
    const noPack = await call('POST', '/api/catalog/products', { token: owner.token, body: {
      sku, name: 'Final-pass loose putty', base_unit: 'KG', hsn_code: '3214', selling_price: 40, mrp: 45,
      units: [{ unit_code: 'BAG' }] } });
    check('a pack unit without its size is refused', noPack.status === 400 && /BAG/.test(noPack.body.error), noPack.body.error);

    const created = await call('POST', '/api/catalog/products', { token: owner.token, body: {
      sku, name: 'Final-pass loose putty', base_unit: 'KG', hsn_code: '3214', selling_price: 40, mrp: 45,
      reorder_level: 5,
      units: [{ unit_code: '100G' }, { unit_code: '250G' }, { unit_code: '500G' }, { unit_code: 'BAG', multiplier_to_base: 20 }] } });
    check('a KG product with 100 G / 250 G / 500 G / 20 KG bag units is created', created.status === 200, created.body.error ?? created.body.sku);
    putty = (await call('GET', `/api/catalog/products/${created.body.product_id}`, { token: owner.token })).body;
    const mult = Object.fromEntries(putty.units.map((u) => [u.unit_code, Number(u.multiplier_to_base)]));
    check('the conversions were derived from the units master', mult['100G'] === 0.1 && mult['250G'] === 0.25 && mult['500G'] === 0.5 && mult.KG === 1 && mult.BAG === 20,
      JSON.stringify(mult));

    const adj = await call('POST', '/api/inventory/stock-adjustments', { token: mgr.token, body: {
      product_id: putty.product_id, reason_code: 'OPENING_STOCK', quantity: 10, unit_cost: 26 } });
    check('opening stock is entered as a documented adjustment', adj.status === 200 && /^ADJ-AND\//.test(adj.body.adjustment_number), adj.body.adjustment_number ?? adj.body.error);
    const noCost = await call('POST', '/api/inventory/stock-adjustments', { token: mgr.token, body: {
      product_id: putty.product_id, reason_code: 'OPENING_STOCK', quantity: 1 } });
    check('opening stock without a cost is refused, so stock is always valued', noCost.status === 400, noCost.body.error);
    const cash = await call('POST', '/api/inventory/stock-adjustments', { token: cashier.token, body: {
      product_id: putty.product_id, reason_code: 'FOUND', quantity: 1, unit_cost: 26 } });
    check('a cashier cannot adjust stock', cash.status === 403, cash.status);
    check('10 KG is on the shelf', await stockOf(B1, putty.product_id) === 10);

    const u = (code) => putty.units.find((x) => x.unit_code === code).product_unit_id;
    const before = await stockOf(B1, putty.product_id);
    const sale = await sell(cashier.token, [
      { product_id: putty.product_id, product_unit_id: u('100G'), qty_in_sale_unit: 5 },
      { product_id: putty.product_id, product_unit_id: u('250G'), qty_in_sale_unit: 1 },
      { product_id: putty.product_id, product_unit_id: u('500G'), qty_in_sale_unit: 1 },
      { product_id: putty.product_id, qty_in_sale_unit: 2 },            // 2 KG, the base unit
    ]);
    check('a bill of 5 × 100 G + 250 G + 500 G + 2 KG finalises', sale.res.status === 200, sale.res.body.error ?? sale.res.body.invoice_number);
    const after = await stockOf(B1, putty.product_id);
    check('stock falls by exactly 0.5 + 0.25 + 0.5 + 2 = 3.25 KG', Math.abs(before - after - 3.25) < 1e-9, `${before} → ${after}`);
    const lines = await q(`SELECT il.qty_in_sale_unit, il.base_unit_qty, il.taxable_value + il.cgst_amount + il.sgst_amount AS total, pu.unit_label
                             FROM invoice_lines il JOIN product_units pu ON pu.product_unit_id = il.product_unit_id
                            WHERE il.invoice_id = $1 ORDER BY il.line_no`, [sale.res.body.invoice_id]);
    check('5 × 100 G is stored as 5 in the sale unit and 0.5 KG in base', lines[0].unit_label === '100G' && Number(lines[0].qty_in_sale_unit) === 5 && Number(lines[0].base_unit_qty) === 0.5,
      JSON.stringify(lines[0]));
    check('…and priced as half a kilogram (₹20.00 at ₹40/KG, GST inclusive)', money(lines[0].total) === 20, lines[0].total);
    check('the bill keeps the order the items were rung up in', lines.map((l) => l.unit_label).join(',') === '100G,250G,500G,KG',
      lines.map((l) => l.unit_label).join(','));
    const doc = await pdfText(`/api/billing/invoices/${sale.res.body.invoice_id}/pdf`, cashier.token);
    const flat = doc.text.replace(/\s+/g, ' ');
    check('the invoice prints "100 G", not an internal unit code', /100 G/.test(flat) && !/100G\b/.test(flat), flat.slice(0, 80));
    check('…with the rate per 100 G (₹4.00), not per KG', /4\.00/.test(flat));

    const bag = await sell(cashier.token, [{ product_id: putty.product_id, product_unit_id: u('BAG'), qty_in_sale_unit: 1.5 }]);
    check('a bag cannot be sold in halves (pack units are whole numbers)', bag.draft.status === 400 && /whole numbers/.test(bag.draft.body.error), bag.draft.body.error);

    // A GRAM-based product: 3 × 100 G takes 300 G.
    const stainer = (await call('GET', '/api/catalog/products?q=Stainer&limit=5', { token: cashier.token })).body
      .find((p) => p.sku === 'PNT-STAINER-PWD');
    const s100 = stainer.units.find((x) => x.unit_code === '100G');
    check('the gram-stocked stainer converts 100 G to 100 of its base unit', Number(s100.multiplier_to_base) === 100, s100.multiplier_to_base);
    // Earlier suites may have counted this item down in a stock take; put stock on
    // the shelf the way a shop would — a numbered "found stock" adjustment.
    const reservedG = Number((await q('SELECT COALESCE(reserved_qty,0) r FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, stainer.product_id]))[0]?.r ?? 0);
    if (await stockOf(B1, stainer.product_id) - reservedG < 1000) {
      const top = await call('POST', '/api/inventory/stock-adjustments', { token: owner.token, branch: B1,
        body: { product_id: stainer.product_id, quantity: 2000 + reservedG, reason_code: 'FOUND', unit_cost: 0.24 } });
      check('found stock can be added with an adjustment', top.status === 200, top.body.error);
    }
    const g0 = await stockOf(B1, stainer.product_id);
    if (g0 >= 300) {
      const gs = await sell(cashier.token, [{ product_id: stainer.product_id, product_unit_id: s100.product_unit_id, qty_in_sale_unit: 3 }]);
      check('3 × 100 G of a gram-based product sells', gs.res.status === 200, gs.res.body.error);
      check('…and takes exactly 300 G from stock', g0 - await stockOf(B1, stainer.product_id) === 300);
    } else {
      check('the seeded stainer has stock at branch 1 to sell', false, `only ${g0} g`);
    }

    // Two lines of the same product are checked against stock TOGETHER.
    const left = await stockOf(B1, putty.product_id);
    const over = await sell(cashier.token, [
      { product_id: putty.product_id, qty_in_sale_unit: Math.floor(left) },
      { product_id: putty.product_id, product_unit_id: u('500G'), qty_in_sale_unit: Math.ceil((left - Math.floor(left)) / 0.5) + 2 },
    ]);
    check('two lines that together exceed stock are refused (per-product, not per-line)', over.res.status === 409, `${over.res.status} ${over.res.body.error ?? ''}`);
  }

  // ══ 3. Numbering ═════════════════════════════════════════════════════════════
  section('3 · Two branches never print the same number (the old collision)');
  {
    const code = `T${stamp.slice(-4)}`.slice(0, 6).replace(/[^A-Z0-9]/g, 'X');
    const nb = await call('POST', '/api/admin/branches', { token: owner.token,
      body: { code, name: `Final-pass branch ${stamp}`, state_code: '27', address: 'Test' } });
    check('a new branch is created with its own code', nb.status === 200 && nb.body.code === code, nb.body.error ?? nb.body.code);
    const badState = await call('POST', '/api/admin/branches', { token: owner.token,
      body: { code: 'ZZ9', name: 'Bad', state_code: 'MH' } });
    check('a branch state must be a GST state code', badState.status === 400, badState.body.error);
    // Every series a fresh branch opens carries its code, so it cannot collide
    // with the same series at any other branch.
    const nums = await q(`SELECT next_document_number($1, 'CREDIT_NOTE', erp_fiscal_year(), 'CN') a,
                                 next_document_number($2, 'CREDIT_NOTE', erp_fiscal_year(), 'CN') b`, [nb.body.branch_id, B3]);
    check('the first credit note at two branches gets two different numbers', nums[0].a !== nums[0].b, `${nums[0].a} / ${nums[0].b}`);
    check('…each carrying its branch code', nums[0].a.startsWith(`CN-${code}/`), nums[0].a);
    const nextFy = await q(`SELECT next_document_number($1, 'INVOICE', '2099-00', 'INV') a, next_document_number($2, 'INVOICE', '2099-00', 'INV') b`, [B1, B2]);
    check('a brand-new fiscal year does not make branches collide either', nextFy[0].a !== nextFy[0].b, `${nextFy[0].a} / ${nextFy[0].b}`);
    await pool.query(`DELETE FROM document_sequences WHERE fiscal_year = '2099-00'`);
    await pool.query(`UPDATE document_sequences SET last_number = last_number - 1 WHERE branch_id IN ($1,$2) AND series = 'CREDIT_NOTE' AND fiscal_year = erp_fiscal_year()`, [nb.body.branch_id, B3]);
    await call('PUT', `/api/admin/branches/${nb.body.branch_id}`, { token: owner.token, body: { is_active: false } });
  }

  // ══ 4. Immutability ══════════════════════════════════════════════════════════
  section('4 · A finalised invoice cannot be altered — not even by the app role');
  {
    const inv = (await q(`SELECT invoice_id, grand_total FROM invoices WHERE status = 'FINAL' AND branch_id = $1 LIMIT 1`, [B1]))[0];
    if (APP_DB) {
      const app = new pg.Client({ connectionString: APP_DB });
      await app.connect();
      const tryIt = async (stmt, params) => {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('erp.user_id',$1,true), set_config('erp.role','OWNER_ADMIN',true), set_config('erp.branch_id','',true)`, [owner.user.user_id]);
        try { await app.query(stmt, params); await app.query('ROLLBACK'); return 'allowed'; }
        catch (e) { await app.query('ROLLBACK'); return e.message; }
      };
      const a = await tryIt('UPDATE invoices SET grand_total = grand_total + 1 WHERE invoice_id = $1', [inv.invoice_id]);
      check('changing a final total is refused by the database', /cannot be altered/.test(a), a);
      const b = await tryIt('UPDATE invoice_lines SET discount_amount = 1 WHERE invoice_id = $1', [inv.invoice_id]);
      check('changing a final line is refused', /cannot be altered/.test(b), b);
      const c = await tryIt('UPDATE invoice_payments SET amount = amount + 1 WHERE invoice_id = $1', [inv.invoice_id]);
      check('changing a final payment is refused', /cannot be altered/.test(c), c);
      const d = await tryIt(`UPDATE invoices SET status = 'DRAFT' WHERE invoice_id = $1`, [inv.invoice_id]);
      check('a final invoice cannot be turned back into a draft', /cannot change/.test(d), d);
      const e = await tryIt(`UPDATE customer_payments SET amount = 1`, []);
      check('a recorded receipt cannot be edited by the app role', /permission denied/.test(e), e);
      await app.end();
    }
    const after = (await q('SELECT grand_total FROM invoices WHERE invoice_id = $1', [inv.invoice_id]))[0];
    check('and the invoice is unchanged', money(after.grand_total) === money(inv.grand_total));
  }

  // ══ 5. GST place of supply ═══════════════════════════════════════════════════
  section('5 · The buyer\'s state decides CGST+SGST vs IGST (spec §19)');
  {
    const ka = (await call('GET', '/api/customers/f0000000-0000-0000-0000-000000000060', { token: cashier.token })).body;
    check('the Karnataka customer carries state code 29', ka.state_code === '29', ka.state_code);
    const p = (await call('GET', '/api/catalog/products?q=Hammer&limit=5', { token: cashier.token })).body[0];
    const s = await sell(cashier.token, [{ product_id: p.product_id, qty_in_sale_unit: 1 }], { customerId: ka.customer_id });
    const inv = (await q('SELECT cgst_total, sgst_total, igst_total, place_of_supply_state_code FROM invoices WHERE invoice_id = $1', [s.res.body.invoice_id]))[0];
    check('a GST bill to an out-of-state buyer charges IGST only', Number(inv.igst_total) > 0 && Number(inv.cgst_total) === 0 && Number(inv.sgst_total) === 0,
      JSON.stringify(inv));
    check('…and records place of supply 29', inv.place_of_supply_state_code === '29');
    const doc = await pdfText(`/api/billing/invoices/${s.res.body.invoice_id}/pdf`, cashier.token);
    check('the PDF says Inter-state (IGST) and names Karnataka', /Inter-state/.test(doc.text) && /Karnataka/.test(doc.text));

    const local = await sell(cashier.token, [{ product_id: p.product_id, qty_in_sale_unit: 1 }]);
    const li = (await q('SELECT cgst_total, igst_total FROM invoices WHERE invoice_id = $1', [local.res.body.invoice_id]))[0];
    check('a walk-in bill at the counter stays intra-state', Number(li.cgst_total) > 0 && Number(li.igst_total) === 0);

    const nongst = await sell(cashier.token, [{ product_id: p.product_id, qty_in_sale_unit: 1 }], { invoiceType: 'NON_GST', customerId: ka.customer_id });
    const ng = (await q('SELECT cgst_total + sgst_total + igst_total AS t FROM invoices WHERE invoice_id = $1', [nongst.res.body.invoice_id]))[0];
    check('a bill of supply carries no GST at all, whoever the buyer', Number(ng.t) === 0);
  }

  // ══ 6. Invoice document fields ═══════════════════════════════════════════════
  section('6 · Order, challan, vehicle and delivery details reach the invoice');
  {
    const p = (await call('GET', '/api/catalog/products?q=Hinge&limit=5', { token: cashier.token })).body[0];
    const s = await sell(cashier.token, [{ product_id: p.product_id, qty_in_sale_unit: 2 }], { extra: {
      order_no: `PO-FP-${stamp}`, challan_no: 'DC-77', challan_date: '2026-09-28', vehicle_no: 'mh04ab1234',
      due_date: '2026-10-15', place_of_delivery: 'Site 3, Ghodbunder Road, Thane' } });
    const inv = (await q('SELECT order_no, challan_no, challan_date::text, vehicle_no, due_date::text, place_of_delivery FROM invoices WHERE invoice_id = $1', [s.res.body.invoice_id]))[0];
    check('every field is stored on the final invoice', inv.order_no === `PO-FP-${stamp}` && inv.challan_no === 'DC-77' && inv.challan_date === '2026-09-28'
      && inv.vehicle_no === 'MH04AB1234' && inv.due_date === '2026-10-15', JSON.stringify(inv));
    const doc = await pdfText(`/api/billing/invoices/${s.res.body.invoice_id}/pdf`, cashier.token);
    check('and printed on the PDF', doc.text.includes(`PO-FP-${stamp}`) && doc.text.includes('MH04AB1234') && /Ghodbunder/.test(doc.text));
    const badDate = await call('POST', '/api/billing/drafts', { token: cashier.token, body: { challan_date: '28/09/2026' } });
    check('a malformed date is a clear 400', badDate.status === 400 && /date/i.test(badDate.body.error), badDate.body.error);
  }

  // ══ 7. Payments and receipts ═════════════════════════════════════════════════
  section('7 · Split payment with bank transfer; receipts reach the till (spec §24, §37)');
  let credCustomer;
  {
    const p = (await call('GET', '/api/catalog/products?q=Padlock&limit=5', { token: cashier.token })).body[0];
    const d = await call('POST', '/api/billing/drafts', { token: cashier.token, body: { lines: [{ product_id: p.product_id, qty_in_sale_unit: 3 }] } });
    const total = d.body.totals.payable;
    const cashPart = 100, upiPart = 50;
    const f = await call('POST', `/api/billing/drafts/${d.body.invoice_id}/finalize`, { token: cashier.token, body: { payments: [
      { method: 'CASH', amount: cashPart }, { method: 'UPI', amount: upiPart, ref_no: `UPI${stamp}` },
      { method: 'BANK_TRANSFER', amount: money(total - cashPart - upiPart), ref_no: `UTR${stamp}` }] } });
    check('cash + UPI + bank transfer settles one bill', f.status === 200 && f.body.payment_summary.status === 'PAID', f.body.error ?? f.body.payment_summary?.status);
    const over = await call('POST', '/api/billing/invoices', { token: cashier.token, body: {
      lines: [{ product_id: p.product_id, qty_in_sale_unit: 1 }], payments: [{ method: 'CASH', amount: 99999 }] } });
    check('an overpayment is refused', over.status === 400 && /must match/.test(over.body.error), over.body.error);
    const neg = await call('POST', '/api/billing/invoices', { token: cashier.token, body: {
      lines: [{ product_id: p.product_id, qty_in_sale_unit: 1 }], payments: [{ method: 'CASH', amount: -5 }] } });
    check('a negative payment is refused', neg.status === 400, neg.body.error);

    // A credit customer with an opening balance, then a cash receipt at the counter.
    credCustomer = (await call('POST', '/api/customers', { token: mgr.token, body: {
      name: `FP Contractor ${stamp}`, phone: `97${String(Date.now()).slice(-8)}`, customer_type: 'B2B_CONTRACTOR',
      company_name: 'FP Builders', gstin: '27AABCF1234F1Z5', address: 'Thane', opening_balance: 1500 } })).body;
    check('a customer is created with an opening balance', Boolean(credCustomer.customer_id) && Number(credCustomer.opening_balance) === 1500, credCustomer.error);
    check('…which is a ledger entry, so the balance and the statement agree',
      Number((await call('GET', `/api/customers/${credCustomer.customer_id}`, { token: mgr.token })).body.balance_owed) === 1500);
    const badGst = await call('POST', '/api/customers', { token: mgr.token, body: { name: 'X', phone: `96${String(Date.now()).slice(-8)}`, gstin: '27ABC' } });
    check('a malformed GSTIN is refused', badGst.status === 400 && /GSTIN/.test(badGst.body.error), badGst.body.error);

    const till = await call('POST', '/api/billing/till-sessions', { token: cashier.token, body: { counter_id: `FP-${stamp}`, opening_float: 500 } });
    const T = till.body.session_id;
    const key = randomUUID();
    const pay = (amount, extra = {}) => call('POST', `/api/customers/${credCustomer.customer_id}/payments`,
      { token: cashier.token, body: { amount, method: 'CASH', client_txn_id: key, ...extra } });
    const [r1, r2] = await Promise.all([pay(600), pay(600)]);
    const receipts = await q('SELECT count(*)::int n FROM customer_payments WHERE client_txn_id = $1', [key]);
    check('two simultaneous submits of one receipt record it once', receipts[0].n === 1 && [r1.status, r2.status].includes(200),
      `${r1.status}/${r2.status}, rows ${receipts[0].n}`);
    const r = r1.status === 200 ? r1.body : r2.body;
    check('the receipt is numbered in its own series', /^RCT-AND\//.test(r.receipt_number ?? ''), r.receipt_number);
    const recon = (await call('GET', `/api/billing/till-sessions/${T}/reconcile`, { token: cashier.token })).body;
    check('cash received against the account is expected in the drawer', recon.cash_receipts === 600 && recon.expected_drawer_cash === 1100,
      `receipts ${recon.cash_receipts}, expected ${recon.expected_drawer_cash}`);
    const tooMuch = await call('POST', `/api/customers/${credCustomer.customer_id}/payments`, { token: cashier.token, body: { amount: 5000, method: 'UPI' } });
    check('paying more than is owed is refused unless taken as an advance', tooMuch.status === 400 && /advance/.test(tooMuch.body.error), tooMuch.body.error);
    const noUtr = await call('POST', `/api/customers/${credCustomer.customer_id}/payments`, { token: cashier.token, body: { amount: 100, method: 'BANK_TRANSFER' } });
    check('a bank transfer needs its reference', noUtr.status === 400 && /UTR/.test(noUtr.body.error), noUtr.body.error);

    const stmt = (await call('GET', `/api/customers/${credCustomer.customer_id}/statement`, { token: accountant.token })).body;
    check('the statement reconciles: opening + entries = closing', stmt.reconciles === true && stmt.closing_balance === 900,
      `closing ${stmt.closing_balance}, reconciles ${stmt.reconciles}`);
    check('…and names the receipt', stmt.entries.some((e) => e.reference === r.receipt_number));

    const close = await call('POST', `/api/billing/till-sessions/${T}/close`, { token: cashier.token, body: { closing_counted_cash: 1100 } });
    check('the drawer balances at close', close.status === 200 && close.body.variance === 0, JSON.stringify(close.body));
    const closedAudit = await q(`SELECT count(*)::int n FROM audit_log WHERE action = 'TILL_CLOSED' AND entity_id = $1`, [T]);
    check('every close is in the audit log (not logged as a stock adjustment)', closedAudit[0].n === 1);
  }

  // ══ 8. Purchases ═════════════════════════════════════════════════════════════
  section('8 · Purchase bill with GST, partial receipt, payments, debit note (spec §27–29, §34)');
  {
    const vendor = (await call('POST', '/api/vendors', { token: owner.token, body: {
      name: `FP Karnataka Traders ${stamp}`, gstin: `29AAACK${String(Date.now() % 10000).padStart(4, '0')}K1Z2`, phone: '9812345678', payment_terms_days: 30,
      bank_ifsc: 'HDFC0001234', opening_balance: 5000 } })).body;
    check('an out-of-state vendor is created with an opening balance', vendor.state_code === '29' && Number(vendor.opening_balance) === 5000, vendor.error ?? vendor.state_code);

    const p = (await call('GET', '/api/catalog/products?q=Hammer&limit=5', { token: mgr.token })).body[0];
    const po = await call('POST', '/api/inventory/purchase-orders', { token: mgr.token, body: {
      vendor_id: vendor.vendor_id, lines: [{ product_id: p.product_id, qty_base_unit: 10, rate: 200 }] } });
    const pod = (await call('GET', `/api/inventory/purchase-orders/${po.body.po_id}`, { token: mgr.token })).body;
    const lineId = pod.lines[0].po_line_id;
    const stock0 = await stockOf(B1, p.product_id);

    const key = randomUUID();
    const grnBody = { vendor_id: vendor.vendor_id, po_id: po.body.po_id, vendor_invoice_no: `KA-${stamp}`,
      vendor_invoice_date: '2026-09-29', client_txn_id: key,
      lines: [{ product_id: p.product_id, po_line_id: lineId, qty: 4, rate: 200, discount_amount: 40, gst_rate_pct: 18 }] };
    const [g1, g2] = await Promise.all([
      call('POST', '/api/inventory/grn', { token: mgr.token, body: grnBody }),
      call('POST', '/api/inventory/grn', { token: mgr.token, body: grnBody }),
    ]);
    const grn = g1.status === 200 && !g1.body.duplicate ? g1.body : g2.body;
    const grnCount = await q('SELECT count(*)::int n FROM grn WHERE client_txn_id = $1', [key]);
    check('a double-submitted goods receipt is recorded once', grnCount[0].n === 1, `${g1.status}/${g2.status}`);
    check('the purchase is inter-state: IGST, no CGST/SGST', Number(grn.igst_total) === 136.8 && Number(grn.cgst_total) === 0,
      `igst ${grn.igst_total}, cgst ${grn.cgst_total}`);
    check('the payable is taxable + GST (760 + 136.80 = 896.80)', Number(grn.grand_total) === 896.8, grn.grand_total);
    check('4 units arrive in stock', await stockOf(B1, p.product_id) - stock0 === 4);
    const cost = (await q('SELECT cost_at_movement FROM stock_ledger WHERE ref_id = $1', [grn.grn_id]))[0];
    check('the landed cost is net of discount and GST (₹190.00)', money(cost.cost_at_movement) === 190, cost.cost_at_movement);
    check('the order is PARTIALLY_RECEIVED', (await q('SELECT status FROM purchase_orders WHERE po_id=$1', [po.body.po_id]))[0].status === 'PARTIALLY_RECEIVED');

    const dup = await call('POST', '/api/inventory/grn', { token: mgr.token, body: { ...grnBody, client_txn_id: randomUUID() } });
    check('the same supplier bill cannot be entered twice', dup.status === 409 && /already been entered/.test(dup.body.error), dup.body.error);

    const rest = await call('POST', '/api/inventory/grn', { token: mgr.token, body: {
      vendor_id: vendor.vendor_id, po_id: po.body.po_id, vendor_invoice_no: `KA2-${stamp}`,
      lines: [{ product_id: p.product_id, po_line_id: lineId, qty: 6, rate: 200, gst_rate_pct: 18 }] } });
    check('receiving the rest closes the order', rest.status === 200
      && (await q('SELECT status FROM purchase_orders WHERE po_id=$1', [po.body.po_id]))[0].status === 'RECEIVED');

    const bal = Number((await call('GET', `/api/vendors/${vendor.vendor_id}`, { token: accountant.token })).body.balance_owed);
    check('owed = opening 5000 + 896.80 + 1416.00', money(bal) === 7312.8, bal);

    const gd = (await call('GET', `/api/inventory/grn/${grn.grn_id}`, { token: mgr.token })).body;
    const dn = await call('POST', '/api/inventory/purchase-returns', { token: mgr.token, body: {
      grn_id: grn.grn_id, reason: 'One damaged', lines: [{ grn_line_id: gd.lines[0].grn_line_id, qty_base_unit: 1 }] } });
    check('a purchase return reverses the goods AND their GST (190 + 34.20)', dn.status === 200 && Number(dn.body.total_amount) === 224.2,
      dn.body.error ?? dn.body.total_amount);

    const pay = await call('POST', `/api/vendors/${vendor.vendor_id}/payments`, { token: accountant.token, body: {
      amount: 672.6, method: 'BANK_TRANSFER', reference: `UTR${stamp}`, grn_id: grn.grn_id } });
    check('a payment is recorded against the bill with its bank reference', pay.status === 200 && /^VP-AND\//.test(pay.body.payment_number), pay.body.error ?? pay.body.payment_number);
    const overPay = await call('POST', `/api/vendors/${vendor.vendor_id}/payments`, { token: accountant.token, body: {
      amount: 1, method: 'CASH', grn_id: grn.grn_id } });
    check('a bill cannot be paid beyond what is due on it', overPay.status === 400, overPay.body.error);
    const cashierPay = await call('POST', `/api/vendors/${vendor.vendor_id}/payments`, { token: cashier.token, body: { amount: 1, method: 'CASH' } });
    check('a cashier cannot pay vendors', cashierPay.status === 403);

    const vs = (await call('GET', `/api/vendors/${vendor.vendor_id}/statement`, { token: accountant.token })).body;
    check('the vendor statement reconciles to the ledger', vs.reconciles === true && money(vs.closing_balance) === money(7312.8 - 224.2 - 672.6),
      `closing ${vs.closing_balance}`);
    const itc = (await call('GET', '/api/reports/gst-summary?period=today', { token: owner.token })).body;
    check('purchase GST shows up as input tax credit', itc.summary.input_tax_credit > 0, itc.summary.input_tax_credit);

    const found = (await call('GET', `/api/search?q=KA-${stamp}`, { token: mgr.token })).body.results;
    check('search finds the purchase by the supplier\'s bill number', found.some((h) => h.type === 'purchase' && h.id === grn.grn_id));
  }

  // ══ 9. Transfers ═════════════════════════════════════════════════════════════
  section('9 · Transfers are numbered and can be cancelled before they leave');
  {
    const p = (await call('GET', '/api/catalog/products?q=Hammer&limit=5', { token: mgr.token })).body[0];
    const t = await call('POST', '/api/inventory/transfers', { token: mgr.token, body: { to_branch_id: B2, lines: [{ product_id: p.product_id, qty: 1 }] } });
    check('a transfer draws a number from the sending branch', /^TR-AND\//.test(t.body.transfer_number ?? ''), t.body.transfer_number ?? t.body.error);
    const c = await call('POST', `/api/inventory/transfers/${t.body.transfer_id}/cancel`, { token: mgr.token, body: { reason: 'Not needed' } });
    check('a requested transfer can be cancelled', c.status === 200);
    const t2 = await call('POST', '/api/inventory/transfers', { token: mgr.token, body: { to_branch_id: B2, lines: [{ product_id: p.product_id, qty: 1 }] } });
    await call('POST', `/api/inventory/transfers/${t2.body.transfer_id}/dispatch`, { token: mgr.token, body: {} });
    const c2 = await call('POST', `/api/inventory/transfers/${t2.body.transfer_id}/cancel`, { token: mgr.token, body: {} });
    check('a dispatched transfer cannot be cancelled (the goods are on the road)', c2.status === 400, c2.body.error);
    const vikas = await login('vikas@hardwareerp.in', 'Manager@12345');
    const td = (await call('GET', `/api/inventory/transfers/${t2.body.transfer_id}`, { token: vikas.token })).body;
    const partial = await call('POST', `/api/inventory/transfers/${t2.body.transfer_id}/receive`, { token: vikas.token, body: { lines: [] } });
    check('receiving must account for every line', partial.status === 400, partial.body.error);
    const rec = await call('POST', `/api/inventory/transfers/${t2.body.transfer_id}/receive`, { token: vikas.token,
      body: { lines: td.lines.map((l) => ({ line_id: l.line_id, received_qty: Number(l.dispatched_qty) })) } });
    check('the receiving branch takes it in', rec.status === 200 && rec.body.status === 'RECEIVED', rec.body.error ?? rec.body.status);
  }

  // ══ 10. Estimates ════════════════════════════════════════════════════════════
  section('10 · Estimates: units, discount, edit, convert → draft → final (spec §21)');
  {
    const est = await call('POST', '/api/quotations', { token: cashier.token, body: {
      customer_id: credCustomer.customer_id, price_type: 'TAX_EXCLUSIVE', valid_until: '2026-12-31',
      notes: 'Delivery to site', terms: 'Prices valid for 15 days\nTransport extra',
      lines: [{ product_id: putty.product_id, product_unit_id: putty.units.find((u) => u.unit_code === '500G').product_unit_id, qty: 4, discount_amount: 2 }] } });
    check('a cashier raises an estimate in 500 G units', est.status === 200 && /^QT-AND\//.test(est.body.quotation_number), est.body.error ?? est.body.quotation_number);
    const approve = await call('POST', `/api/quotations/${est.body.quotation_id}/approve`, { token: cashier.token, body: {} });
    check('…but cannot approve it (that is the price agreement)', approve.status === 403);
    const edit = await call('PUT', `/api/quotations/${est.body.quotation_id}`, { token: cashier.token, body: {
      lines: [{ product_id: putty.product_id, product_unit_id: putty.units.find((u) => u.unit_code === '500G').product_unit_id, qty: 2, discount_amount: 1 }] } });
    check('a draft estimate can be edited', edit.status === 200, edit.body.error);
    const detail = (await call('GET', `/api/quotations/${est.body.quotation_id}`, { token: cashier.token })).body;
    // ₹40/KG incl. 18% → ₹33.8983/KG ex-GST; 2 × 500 G = 1 KG → 33.90 - 1.00 = 32.90 taxable.
    check('the estimate prices 2 × 500 G ex-GST less the discount', money(detail.totals.subtotal) === 32.9, detail.totals.subtotal);
    const doc = await pdfText(`/api/quotations/${est.body.quotation_id}/pdf`, cashier.token);
    check('the estimate PDF prints the terms and the validity', /Transport extra/.test(doc.text) && /31 Dec 2026/.test(doc.text));
    const conv = await call('POST', `/api/quotations/${est.body.quotation_id}/convert`, { token: cashier.token, body: {} });
    check('converting opens a draft bill with the same total', conv.status === 200 && money(conv.body.draft.totals.subtotal) === 32.9, conv.body.error);
    const fin = await call('POST', `/api/billing/drafts/${conv.body.draft_invoice_id}/finalize`, { token: cashier.token, body: {
      payments: [{ method: 'CASH', amount: conv.body.draft.totals.payable }] } });
    check('the bill finalises', fin.status === 200, fin.body.error);
    const qs = (await q('SELECT status FROM quotations WHERE quotation_id = $1', [est.body.quotation_id]))[0];
    check('the estimate is now CONVERTED', qs.status === 'CONVERTED');
    const again = await call('POST', `/api/quotations/${est.body.quotation_id}/convert`, { token: cashier.token, body: {} });
    check('a billed estimate cannot be billed again', again.status === 400, again.body.error);
  }

  // ══ 11. Reports agree with the tables ═══════════════════════════════════════
  section('11 · Reports: period presets agree with the raw tables (spec §7, §38)');
  {
    const raw = (await q(`SELECT COALESCE(SUM(grand_total + round_off),0) s, count(*)::int n FROM invoices
                            WHERE status='FINAL' AND branch_id = $1 AND server_received_at::date = CURRENT_DATE`, [B1]))[0];
    const dash = (await call('GET', `/api/reports/dashboard?period=today`, { token: mgr.token })).body;
    check('Today on the dashboard is exactly today\'s bills', money(dash.revenue) === money(raw.s) && dash.invoice_count === raw.n,
      `${dash.revenue} vs ${raw.s}`);
    check('the dashboard names its period', dash.period?.label === 'Today');
    const yday = (await call('GET', `/api/reports/dashboard?period=yesterday`, { token: mgr.token })).body;
    const rawY = (await q(`SELECT COALESCE(SUM(grand_total + round_off),0) s FROM invoices
                            WHERE status='FINAL' AND branch_id = $1 AND server_received_at::date = CURRENT_DATE - 1`, [B1]))[0];
    check('Yesterday agrees too', money(yday.revenue) === money(rawY.s), `${yday.revenue} vs ${rawY.s}`);
    const reg = (await call('GET', `/api/reports/sales-register?period=today`, { token: mgr.token })).body;
    const regTotal = money(reg.filter((r) => r.status === 'FINAL').reduce((s, r) => s + Number(r.amount), 0));
    check('the sales register adds up to the same figure', regTotal === money(raw.s), `${regTotal} vs ${raw.s}`);
    check('a cashier sees no cost-based figures on the dashboard',
      (await call('GET', `/api/reports/dashboard?period=today`, { token: cashier.token })).body.gross_profit === null);
    const pl = await call('GET', '/api/reports/profit-and-loss?period=this_month', { token: owner.token });
    check('the owner gets an indicative P&L, labelled as such', pl.status === 200 && /Indicative/.test(pl.body.basis), pl.body.error);
    const plAcc = await call('GET', '/api/reports/profit-and-loss?period=this_month', { token: accountant.token });
    check('an accountant without cost visibility does not', plAcc.status === 403);
    const pay = (await call('GET', '/api/reports/payments-register?period=today', { token: accountant.token })).body;
    check('the payments register shows receipts and vendor payments', pay.some((r) => r.kind === 'RECEIPT') && pay.some((r) => r.kind === 'VENDOR_PAYMENT'));
    const badP = await call('GET', '/api/reports/dashboard?from=2026-10-10&to=2026-10-01', { token: owner.token });
    check('an inverted date range is a 400', badP.status === 400, badP.body.error);
  }

  // ══ 12. Errors are plain ═════════════════════════════════════════════════════
  section('12 · Bad input gets a plain 4xx, never a raw exception');
  {
    const malformed = await call('POST', '/api/billing/drafts', { token: cashier.token, raw: '{"lines": [' });
    check('malformed JSON is a 400 with a plain message', malformed.status === 400 && !/Unexpected|JSON\./.test(malformed.body.error), malformed.body.error);
    const empty = await call('POST', '/api/auth/logout', { raw: '' });
    check('an empty JSON body is accepted as {}', empty.status === 200);
    const skuDup = await call('POST', '/api/catalog/products', { token: owner.token, body: {
      sku: 'PLB-PIPE-15', name: 'x', base_unit: 'PIECE', hsn_code: '3917', selling_price: 1 } });
    check('a duplicate SKU names the product that has it', skuDup.status === 409 && /Supreme/.test(skuDup.body.error), skuDup.body.error);
    const bcDup = await call('POST', `/api/catalog/products/${putty.product_id}/barcodes`, { token: owner.token, body: { barcode: '8901234500014' } });
    check('a duplicate barcode names the product that has it', bcDup.status === 409 && /LED/.test(bcDup.body.error), bcDup.body.error);
    const brand = await call('POST', '/api/catalog/brands', { token: mgr.token, body: { name: ' asian paints ' } });
    check('a duplicate brand (any case, any spacing) is refused', brand.status === 409, brand.body.error);
    const newBrand = await call('POST', '/api/catalog/brands', { token: mgr.token, body: { name: `FP Brand ${stamp}` } });
    check('a manager can add a brand inline', newBrand.status === 200 && newBrand.body.brand_id, newBrand.body.error);
    const cashBrand = await call('POST', '/api/catalog/brands', { token: cashier.token, body: { name: 'Nope' } });
    check('a cashier cannot', cashBrand.status === 403);
    const qty0 = await call('POST', '/api/billing/drafts', { token: cashier.token, body: { lines: [{ product_id: putty.product_id, qty_in_sale_unit: 0 }] } });
    check('quantity 0 is refused in plain words', qty0.status === 400 && /greater than zero/.test(qty0.body.error), qty0.body.error);
    const disc = await call('POST', '/api/billing/drafts', { token: cashier.token, body: { lines: [{ product_id: putty.product_id, qty_in_sale_unit: 1, discount_amount: 999 }] } });
    check('a discount larger than the line is refused', disc.status === 400 && /more than the line value/.test(disc.body.error), disc.body.error);
  }

  // ══ 13. Backups are not faked ════════════════════════════════════════════════
  section('13 · Backups are reported honestly (spec §46)');
  {
    const b = (await call('GET', '/api/admin/backups', { token: owner.token })).body;
    check('backup status is read from real backup runs', ['NOT_CONFIGURED', 'OK', 'OVERDUE'].includes(b.status), b.status);
    const claim = await call('POST', '/api/admin/backups', { token: owner.token, body: { storage_ref: 's3://pretend' } });
    check('there is no endpoint that can claim a backup was taken', claim.status === 404, claim.status);
  }
} catch (err) {
  failures.push(`suite crashed: ${err.stack ?? err}`);
  console.log(`${C.r}suite crashed:${C.x}`, err);
} finally {
  await pool.end();
}

console.log(`\n${'─'.repeat(70)}\n${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) {
  console.log(`\n${C.r}Failures:${C.x}`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`${C.g}Every final-pass capability verified against the database.${C.x}`);
