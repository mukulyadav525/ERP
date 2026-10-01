// ============================================================================
// A full working day, driven through the API and checked against the database.
//
// The day runs twice: once as the Owner working at Thane (the branch picked in
// the top bar, sent as X-Branch-Id), and once as the Andheri staff — cashier,
// manager and accountant, each doing only what their role may. Every step
// checks the money and the stock it should have moved, and nothing else.
//
//   open till → low stock → receive a purchase → new customer → GST bill with a
//   100 G line and a normal line, split payment → PDF → WhatsApp (nothing sent
//   automatically) → non-GST bill → estimate → convert → return + cash refund →
//   credit sale → return to account → receipt → statement → stock ledger →
//   reports → close the till → reconcile
//
// plus the edge cases a real day produces: a double-tapped sale, a fractional
// count, returning more than was sold, a staff member reaching for another
// branch, an overpayment.
//
//   node tests/working-day.mjs        (API on :4000, freshly seeded database)
// ============================================================================
import pg from '../node_modules/pg/lib/index.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL;
if (!DB) { console.error('MIGRATION_DATABASE_URL is required (database cross-checks).'); process.exit(2); }

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail !== '' ? `  ${C.d}${String(detail).slice(0, 120)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 220)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);
const money = (n) => Math.round(Number(n) * 100) / 100;
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;

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
async function signIn(kind, a, b) {
  for (let i = 0; i < 6; i += 1) {
    const r = kind === 'pin'
      ? await call('POST', '/api/auth/login/pin', { body: { phone: a, pin: b } })
      : await call('POST', '/api/auth/login/password', { body: { email: a, password: b } });
    if (r.status === 200) return r.body.token;
    if (r.status !== 429) throw new Error(`sign-in ${a}: ${r.status} ${JSON.stringify(r.body)}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`sign-in ${a}: throttled`);
}
async function pdfText(path, token, branch) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, ...(branch ? { 'X-Branch-Id': branch } : {}) } });
  if (!res.ok) return { ok: false, text: '' };
  const f = join(mkdtempSync(join(tmpdir(), 'erp-day-')), 'doc.pdf');
  writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } catch { /* pdftotext absent */ }
  return { ok: true, text };
}

const pool = new pg.Pool({ connectionString: DB });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const stock = async (branch, product) => Number((await q('SELECT base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [branch, product]))[0]?.base_unit_qty ?? 0);
const ledgerSum = async (branch, product) => Number((await q(`SELECT COALESCE(sum(base_unit_qty_change),0) s FROM stock_ledger
   WHERE branch_id=$1 AND product_id=$2 AND movement_type NOT IN ('RESERVATION','RESERVATION_RELEASE')`, [branch, product]))[0].s);
const unitId = async (product, code) => (await q('SELECT product_unit_id FROM product_units WHERE product_id=$1 AND unit_label=$2', [product, code]))[0]?.product_unit_id;

const PUTTY = '10000000-0000-0000-0000-000000000026';   // KG base; sold as 100 G / 250 G / 500 G / KG
const HINGE = '10000000-0000-0000-0000-000000000023';   // PIECE; BOX of 20
const ELBOW = '10000000-0000-0000-0000-000000000003';   // PIECE
const VENDOR = 'd0000000-0000-0000-0000-000000000005';  // Local Hardware Supplies Co (Maharashtra)
const today = (await q("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') d"))[0].d;
const stamp = Date.now().toString(36).toUpperCase();

/**
 * One working day at one branch. `actors` names who does each kind of work:
 * counter (till, bills, returns, receipts), manager (purchases, approvals),
 * accounts (supplier payment). `branchHeader` is sent only for the Owner.
 */
async function workingDay(label, branch, actors, branchHeader) {
  const as = (who) => ({ token: actors[who], branch: branchHeader });
  section(`${label}: opening the till`);
  // A till left open from an earlier run would make "open" refuse; close it first.
  for (const t of (await call('GET', '/api/billing/till-sessions?status=OPEN&mine=true', as('counter'))).body ?? []) {
    const rec = (await call('GET', `/api/billing/till-sessions/${t.session_id}/reconcile`, as('counter'))).body;
    await call('POST', `/api/billing/till-sessions/${t.session_id}/close`, { ...as('counter'), body: { closing_counted_cash: rec.expected_drawer_cash } });
  }
  const till = await call('POST', '/api/billing/till-sessions', { ...as('counter'), body: { counter_id: `DAY-${stamp}`, opening_float: 2000 } });
  check('the till opens with ₹2,000 float', till.status === 200, till.body.error ?? till.body.session_id);
  const tillId = till.body.session_id;
  let cashIn = 0;      // what the drawer should gain through the day
  let cashOut = 0;

  section(`${label}: what needs reordering`);
  const low = await call('GET', '/api/inventory/stock?filter=low&limit=50', as('manager'));
  check('the low-stock list loads', low.status === 200 && Array.isArray(low.body), `${low.body.length ?? low.body.error} item(s)`);
  check('every listed item really is at or below its reorder level',
    (low.body ?? []).every((r) => Number(r.base_unit_qty) <= Number(r.reorder_min ?? 0)));
  const sugg = await call('GET', '/api/inventory/reorder-suggestions', as('manager'));
  check('reorder suggestions load for the branch', sugg.status === 200, sugg.body.error ?? `${sugg.body.length} suggestion(s)`);

  section(`${label}: receiving a purchase`);
  const putty0 = await stock(branch, PUTTY), hinge0 = await stock(branch, HINGE);
  const vendorBal0 = Number((await q('SELECT COALESCE((SELECT balance_after FROM vendor_ledger WHERE vendor_id=$1 ORDER BY created_at DESC, entry_id DESC LIMIT 1),0) b', [VENDOR]))[0].b);
  const grnKey = randomUUID();
  const grnBody = {
    vendor_id: VENDOR, vendor_invoice_no: `LHS/${stamp}/${label.slice(0, 3)}`, vendor_invoice_date: today, client_txn_id: grnKey,
    lines: [
      { product_id: PUTTY, product_unit_id: await unitId(PUTTY, 'KG'), qty: 50, rate: 25, gst_rate_pct: 18 },
      { product_id: HINGE, product_unit_id: await unitId(HINGE, 'BOX'), qty: 2, rate: 600, discount_amount: 60, gst_rate_pct: 18 },
    ],
  };
  const grn = await call('POST', '/api/inventory/grn', { ...as('manager'), body: grnBody });
  check('the supplier bill is recorded', grn.status === 200, grn.body.error ?? grn.body.grn_number);
  // 50 × 25 = 1,250 + (2 × 600 − 60) = 1,140 → taxable 2,390, CGST + SGST 18% = 430.20 → 2,820.20
  check('its total is taxable + CGST + SGST', near(grn.body.grand_total, 2820.20), grn.body.grand_total);
  check('putty stock rises by exactly 50 KG', near(await stock(branch, PUTTY) - putty0, 50, 0.0001));
  check('hinge stock rises by 2 boxes = 40 pieces', near(await stock(branch, HINGE) - hinge0, 40, 0.0001));
  const vendorBal1 = Number((await q('SELECT balance_after FROM vendor_ledger WHERE vendor_id=$1 ORDER BY created_at DESC, entry_id DESC LIMIT 1', [VENDOR]))[0].balance_after);
  check('the supplier is owed the bill total', near(vendorBal1 - vendorBal0, 2820.20), vendorBal1 - vendorBal0);
  const again = await call('POST', '/api/inventory/grn', { ...as('manager'), body: grnBody });
  check('saving the same purchase twice records it once', again.status === 200 && again.body.grn_id === grn.body.grn_id && again.body.duplicate === true);
  check('…and stock moved only once', near(await stock(branch, PUTTY) - putty0, 50, 0.0001));

  section(`${label}: a new customer`);
  const phone = `97${String(Date.now()).slice(-8)}`;
  const cust = await call('POST', '/api/customers', { ...as('counter'), body: { name: `Day Customer ${stamp}`, phone, state_code: '27', email: 'day.customer@example.com' } });
  check('the customer is created', cust.status === 200 && cust.body.customer_id, cust.body.error);
  const dupe = await call('POST', '/api/customers', { ...as('counter'), body: { name: 'Someone else', phone } });
  check('the same phone returns the existing customer instead of a duplicate', dupe.body.customer_id === cust.body.customer_id && dupe.body.already_existed === true);

  section(`${label}: a GST bill with a 100 G line and a normal line`);
  const p1 = await stock(branch, PUTTY), h1 = await stock(branch, HINGE);
  const draft = await call('POST', '/api/billing/drafts', { ...as('counter'), body: {
    invoice_type: 'GST', customer_id: cust.body.customer_id,
    lines: [
      { product_id: PUTTY, product_unit_id: await unitId(PUTTY, '100G'), qty_in_sale_unit: 3 },
      { product_id: HINGE, product_unit_id: await unitId(HINGE, 'PIECE'), qty_in_sale_unit: 2 },
    ] } });
  check('the draft is priced by the server', draft.status === 200 && draft.body.totals?.payable > 0, draft.body.error ?? draft.body.totals?.payable);
  const puttyLine = draft.body.lines?.find((l) => l.product_id === PUTTY);
  check('the 100 G line is priced per 100 G (a tenth of the KG price)', puttyLine && near(puttyLine.rate_per_sale_unit, Number(puttyLine.rate_locked_at_scan) * 0.1),
    `${puttyLine?.rate_per_sale_unit} per 100 G`);
  check('nothing is billed by a draft: stock unchanged', near(await stock(branch, PUTTY), p1, 0.0001));
  const payable = Number(draft.body.totals.payable);
  const cashPart = money(Math.floor(payable / 2));
  const fin = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, { ...as('counter'), body: {
    till_session_id: tillId, payments: [{ method: 'CASH', amount: cashPart }, { method: 'UPI', amount: money(payable - cashPart), ref_no: `UPI${stamp}` }] } });
  check('the bill is finalised with a cash + UPI split', fin.status === 200, fin.body.error ?? fin.body.invoice_number);
  cashIn += cashPart;
  const inv1 = fin.body;
  check('it gets a numbered GST invoice for this branch', /^INV-[A-Z0-9]+\/\d{4}-\d{2}\/\d{5}$/.test(inv1.invoice_number ?? ''), inv1.invoice_number);
  check('0.3 KG of putty leaves stock', near(p1 - await stock(branch, PUTTY), 0.3, 0.0001));
  check('2 hinges leave stock', near(h1 - await stock(branch, HINGE), 2, 0.0001));
  const dbInv = (await q('SELECT * FROM invoices WHERE invoice_id=$1', [inv1.invoice_id]))[0];
  check('CGST equals SGST for an in-state customer, and no IGST', near(dbInv.cgst_total, dbInv.sgst_total, 0.02) && Number(dbInv.igst_total) === 0);
  check('the bill adds up: taxable + GST + round-off = amount',
    near(Number(dbInv.subtotal) + Number(dbInv.cgst_total) + Number(dbInv.sgst_total) + Number(dbInv.round_off), inv1.amount ?? payable));
  const edit = await call('PUT', `/api/billing/drafts/${inv1.invoice_id}`, { ...as('counter'), body: { lines: [] } });
  check('a finalised bill cannot be edited', edit.status >= 400 && edit.status < 500, edit.body.error);

  section(`${label}: the PDF and sharing`);
  const pdf = await pdfText(`/api/billing/invoices/${inv1.invoice_id}/pdf`, actors.counter, branchHeader);
  check('the invoice PDF downloads', pdf.ok);
  if (pdf.text) {
    check('it carries the invoice number', pdf.text.includes(inv1.invoice_number));
    check('it shows the 100 G unit', /100\s*G/.test(pdf.text));
    check('it states the amount in words', /Rupees .* Only/i.test(pdf.text.replace(/\s+/g, ' ')));
  }
  const queued = Number((await q("SELECT count(*) n FROM whatsapp_message_log WHERE invoice_id=$1", [inv1.invoice_id]))[0].n);
  check('no WhatsApp message is sent or queued automatically for the bill', queued === 0, `${queued} queued`);

  section(`${label}: a non-GST bill for a walk-in, paid in cash`);
  const e0 = await stock(branch, ELBOW);
  const saleKey = randomUUID();
  const nonGstBody = { invoice_type: 'NON_GST', till_session_id: tillId, client_txn_id: saleKey,
    lines: [{ product_id: ELBOW, product_unit_id: await unitId(ELBOW, 'PIECE'), qty_in_sale_unit: 4 }] };
  const nd = await call('POST', '/api/billing/drafts', { ...as('counter'), body: nonGstBody });
  const nonGstTotal = Number(nd.body.totals?.payable ?? 0);
  await call('DELETE', `/api/billing/drafts/${nd.body.invoice_id}`, as('counter'));
  const ng = await call('POST', '/api/billing/invoices', { ...as('counter'), body: { ...nonGstBody, payments: [{ method: 'CASH', amount: nonGstTotal }] } });
  check('the non-GST bill is made', ng.status === 200, ng.body.error ?? ng.body.invoice_number);
  cashIn += nonGstTotal;
  const ngRow = (await q('SELECT * FROM invoices WHERE invoice_id=$1', [ng.body.invoice_id]))[0];
  check('it carries no GST at all', Number(ngRow.cgst_total) + Number(ngRow.sgst_total) + Number(ngRow.igst_total) === 0);
  const ng2 = await call('POST', '/api/billing/invoices', { ...as('counter'), body: { ...nonGstBody, payments: [{ method: 'CASH', amount: nonGstTotal }] } });
  check('a double-tapped sale returns the same bill', ng2.status === 200 && ng2.body.invoice_id === ng.body.invoice_id);
  check('…and the elbows left stock once', near(e0 - await stock(branch, ELBOW), 4, 0.0001));
  const frac = await call('POST', '/api/billing/drafts', { ...as('counter'), body: { invoice_type: 'GST', lines: [{ product_id: ELBOW, product_unit_id: await unitId(ELBOW, 'PIECE'), qty_in_sale_unit: 1.5 }] } });
  check('1.5 pieces is refused in plain words', frac.status === 400 && /whole/i.test(frac.body.error ?? ''), frac.body.error);

  section(`${label}: an estimate, approved and converted to a bill`);
  // A counted item with free stock here (some may be held by other estimates).
  const spare = (await q(`SELECT p.product_id FROM products p JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = $1
     WHERE p.is_active AND p.base_unit = 'PIECE' AND p.product_id NOT IN ($2, $3) AND bs.base_unit_qty - bs.reserved_qty >= 30
     ORDER BY p.sku LIMIT 1`, [branch, HINGE, ELBOW]))[0].product_id;
  const qt = await call('POST', '/api/quotations', { ...as('manager'), body: { customer_id: cust.body.customer_id, price_type: 'TAX_INCLUSIVE',
    lines: [{ product_id: PUTTY, product_unit_id: await unitId(PUTTY, 'KG'), qty: 2 }, { product_id: spare, product_unit_id: await unitId(spare, 'PIECE'), qty: 10, discount_amount: 5 }],
    notes: 'Site delivery', terms: 'Valid 15 days' } });
  check('the estimate is created', qt.status === 200, qt.body.error ?? qt.body.quotation_number);
  const ap = await call('POST', `/api/quotations/${qt.body.quotation_id}/approve`, { ...as('manager'), body: { reserve_stock: true, hold_days: 2 } });
  check('it is approved and holds the stock', ap.status === 200 && ap.body.stock_reserved === true, ap.body.error);
  const qpdf = await pdfText(`/api/quotations/${qt.body.quotation_id}/pdf`, actors.manager, branchHeader);
  check('the estimate PDF downloads and says it is an estimate', qpdf.ok && (!qpdf.text || /ESTIMATE|QUOTATION/i.test(qpdf.text)));
  const conv = await call('POST', `/api/quotations/${qt.body.quotation_id}/convert`, as('counter'));
  check('converting opens it as a draft bill (nothing billed yet)', conv.status === 200 && conv.body.draft_invoice_id, conv.body.error);
  const qfin = await call('POST', `/api/billing/drafts/${conv.body.draft_invoice_id}/finalize`, { ...as('counter'), body: {
    till_session_id: tillId, payments: [{ method: 'BANK_TRANSFER', amount: conv.body.draft.totals.payable, ref_no: `UTR${stamp}` }] } });
  check('the converted bill is finalised (bank transfer with UTR)', qfin.status === 200, qfin.body.error ?? qfin.body.invoice_number);
  const qAfter = (await q('SELECT status, stock_reserved FROM quotations WHERE quotation_id=$1', [qt.body.quotation_id]))[0];
  check('the estimate is marked billed and its hold released', qAfter.status === 'CONVERTED' && qAfter.stock_reserved === false, JSON.stringify(qAfter));

  section(`${label}: a return with a cash refund`);
  const elig = await call('GET', `/api/returns/eligibility/${inv1.invoice_id}`, as('counter'));
  const puttyRet = elig.body.lines?.find((l) => l.product_id === PUTTY);
  check('the bill shows what can still be returned, in its sale unit', puttyRet && near(puttyRet.returnable_qty_in_unit, 3) && /100\s*G/.test(puttyRet.unit_print_label), `${puttyRet?.returnable_qty_in_unit} × ${puttyRet?.unit_print_label}`);
  const tooMany = await call('POST', '/api/returns', { ...as('counter'), body: { invoice_id: inv1.invoice_id, return_reason: 'test', refund_method: 'CASH',
    lines: [{ invoice_line_id: puttyRet.line_id, qty: 4 }] } });
  check('returning more than was sold is refused', tooMany.status === 400, tooMany.body.error);
  const p2 = await stock(branch, PUTTY);
  const ret = await call('POST', '/api/returns', { ...as('counter'), body: { invoice_id: inv1.invoice_id, return_reason: 'Excess quantity', refund_method: 'CASH',
    till_session_id: tillId, lines: [{ invoice_line_id: puttyRet.line_id, qty: 1, condition: 'RESELLABLE' }] } });
  check('1 × 100 G comes back with a credit note', ret.status === 200 && /^CN-/.test(ret.body.credit_note_number ?? ''), ret.body.error ?? ret.body.credit_note_number);
  check('the refund is a tenth of what 0.3 KG cost… one 100 G line', near(ret.body.returned_value, Number(puttyLine.line_total) / 3, 0.02), `${ret.body.returned_value} vs ${puttyLine.line_total}/3`);
  check('0.1 KG goes back into stock', near(await stock(branch, PUTTY) - p2, 0.1, 0.0001));
  cashOut += Number(ret.body.cash_refund_amount);
  const cnPdf = await pdfText(`/api/returns/credit-notes/${ret.body.credit_note_id}/pdf`, actors.counter, branchHeader);
  check('the credit note PDF downloads with its number', cnPdf.ok && (!cnPdf.text || cnPdf.text.includes(ret.body.credit_note_number)));

  section(`${label}: credit sale, return to the account, and a receipt`);
  const creditCust = (await q(`SELECT c.customer_id, c.credit_limit FROM customers c WHERE c.credit_allowed AND c.is_active
      AND c.credit_limit - COALESCE((SELECT sum(amount) FROM customer_credit_ledger l WHERE l.customer_id=c.customer_id),0) > 2000
      ORDER BY c.customer_id LIMIT 1`))[0];
  check('there is a credit customer with room on their limit', Boolean(creditCust));
  const bal = async () => Number((await q('SELECT COALESCE(sum(amount),0) s FROM customer_credit_ledger WHERE customer_id=$1', [creditCust.customer_id]))[0].s);
  const b0 = await bal();
  const cd = await call('POST', '/api/billing/drafts', { ...as('counter'), body: { invoice_type: 'GST', customer_id: creditCust.customer_id,
    lines: [{ product_id: HINGE, product_unit_id: await unitId(HINGE, 'PIECE'), qty_in_sale_unit: 5 }] } });
  const cf = await call('POST', `/api/billing/drafts/${cd.body.invoice_id}/finalize`, { ...as('counter'), body: {
    till_session_id: tillId, payments: [{ method: 'CREDIT', amount: cd.body.totals.payable }] } });
  check('a sale goes on the customer\'s account', cf.status === 200, cf.body.error);
  check('their balance rises by the bill', near(await bal() - b0, cd.body.totals.payable));
  const celig = await call('GET', `/api/returns/eligibility/${cf.body.invoice_id}`, as('counter'));
  const cret = await call('POST', '/api/returns', { ...as('counter'), body: { invoice_id: cf.body.invoice_id, return_reason: 'Wrong size', refund_method: 'CREDIT',
    lines: [{ invoice_line_id: celig.body.lines[0].line_id, qty: 1 }] } });
  check('a return goes back onto the account, not out of the drawer', cret.status === 200 && Number(cret.body.cash_refund_amount) === 0, cret.body.error);
  check('their balance falls by the returned value', near(await bal() - b0, Number(cd.body.totals.payable) - Number(cret.body.returned_value)));
  const owed = await bal();
  const over = await call('POST', `/api/customers/${creditCust.customer_id}/payments`, { ...as('counter'), body: { amount: money(owed + 500), method: 'CASH' } });
  check('a receipt larger than the balance is refused unless taken as an advance', over.status === 400, over.body.error);
  const rKey = randomUUID();
  const receipt = money(Math.min(1000, Math.floor(owed)));    // never more than is owed
  const rc = await call('POST', `/api/customers/${creditCust.customer_id}/payments`, { ...as('counter'), body: { amount: receipt, method: 'CASH', client_txn_id: rKey } });
  check('a cash receipt is recorded with its own number', rc.status === 200 && /^RCT-/.test(rc.body.receipt_number ?? ''), rc.body.error ?? rc.body.receipt_number);
  check('the receipt went into the open till', rc.body.till_session_id === tillId);
  cashIn += receipt;
  const rc2 = await call('POST', `/api/customers/${creditCust.customer_id}/payments`, { ...as('counter'), body: { amount: receipt, method: 'CASH', client_txn_id: rKey } });
  check('the same receipt submitted twice is recorded once', rc2.body.payment_id === rc.body.payment_id && rc2.body.duplicate === true);
  const st = await call('GET', `/api/customers/${creditCust.customer_id}/statement?from=${today}&to=${today}`, as('manager'));
  check('the customer statement reconciles', st.status === 200 && st.body.reconciles === true, st.body.error ?? `closing ${st.body.closing_balance}`);
  check('its closing balance is the ledger balance', near(st.body.closing_balance, await bal()));

  section(`${label}: paying the supplier`);
  const vp = await call('POST', `/api/vendors/${VENDOR}/payments`, { ...as('accounts'), body: { amount: 1000, method: 'BANK_TRANSFER', reference: `UTR-V-${stamp}`, grn_id: grn.body.grn_id } });
  check('a supplier payment against the new bill is recorded', vp.status === 200 && /^VP-/.test(vp.body.payment_number ?? ''), vp.body.error ?? vp.body.payment_number);
  const dues = (await q('SELECT amount_due FROM erp_vendor_bill_dues($1) WHERE grn_id=$2', [VENDOR, grn.body.grn_id]))[0];
  check('the bill shows what is still due on it', near(dues.amount_due, 2820.20 - 1000), dues.amount_due);

  section(`${label}: stock agrees with its ledger`);
  for (const [name, id] of [['putty', PUTTY], ['hinges', HINGE], ['elbows', ELBOW]]) {
    check(`${name}: stock on hand equals the sum of its movements`, near(await stock(branch, id), await ledgerSum(branch, id), 0.0001));
  }

  section(`${label}: reports agree with the bills`);
  const dash = await call('GET', '/api/reports/dashboard?period=today', as('manager'));
  const dbToday = (await q(`SELECT COALESCE(sum(grand_total + round_off),0) s, count(*) n FROM invoices
     WHERE status='FINAL' AND branch_id=$1 AND (server_received_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date`, [branch, today]))[0];
  check('the dashboard\'s sales today match the bills', near(dash.body.revenue, dbToday.s), `${dash.body.revenue} vs ${dbToday.s}`);
  check('…and the bill count', Number(dash.body.invoice_count) === Number(dbToday.n));
  const reg = await call('GET', '/api/reports/sales-register?period=today', as('manager'));
  const regTotal = (reg.body ?? []).filter((r) => r.status === 'FINAL').reduce((s, r) => s + Number(r.amount), 0);
  check('the sales register total matches', near(regTotal, dbToday.s), regTotal);

  section(`${label}: closing the till`);
  const rec = (await call('GET', `/api/billing/till-sessions/${tillId}/reconcile`, as('counter'))).body;
  check('expected cash = float + cash taken − cash refunded', near(rec.expected_drawer_cash, 2000 + cashIn - cashOut),
    `${rec.expected_drawer_cash} vs ${2000 + cashIn - cashOut}`);
  const close = await call('POST', `/api/billing/till-sessions/${tillId}/close`, { ...as('counter'), body: { closing_counted_cash: rec.expected_drawer_cash } });
  check('the till closes balanced', close.status === 200 && near(close.body.variance, 0), close.body.error ?? close.body.variance);
  const tr = await call('GET', '/api/reports/till-report?period=today', as('manager'));
  const mine = (tr.body ?? []).find((t) => t.session_id === tillId);
  check('the till report shows it closed with no variance', mine && mine.status === 'CLOSED' && near(mine.variance, 0));
  const audits = Number((await q("SELECT count(*) n FROM audit_log WHERE action IN ('TILL_OPENED','TILL_CLOSED') AND entity_id=$1", [tillId]))[0].n);
  check('opening and closing the till are in the audit trail', audits >= 2, `${audits} entries`);
}

try {
  const OWNER = await signIn('pw', 'owner@hardwareerp.in', 'Owner@12345');
  const THANE = '22222222-2222-2222-2222-222222222222';
  const ANDHERI = '11111111-1111-1111-1111-111111111111';

  section('Branch context');
  const noBranch = await call('POST', '/api/billing/till-sessions', { token: OWNER, body: { counter_id: 'X', opening_float: 0 } });
  check('the Owner on All branches is asked to pick a branch, in plain words', noBranch.status === 400 && /select a branch/i.test(noBranch.body.error ?? ''), noBranch.body.error);

  await workingDay('Owner at Thane', THANE, { counter: OWNER, manager: OWNER, accounts: OWNER }, THANE);

  const CASHIER = await signIn('pin', '9900000005', '1234');            // Ramesh, Andheri
  const MANAGER = await signIn('pw', 'sunita@hardwareerp.in', 'Manager@12345');
  const ACCOUNTANT = await signIn('pw', 'meera@hardwareerp.in', 'Account@12345');
  await workingDay('Andheri staff', ANDHERI, { counter: CASHIER, manager: MANAGER, accounts: ACCOUNTANT }, undefined);

  section('Staff stay inside their branch');
  const other = await call('GET', '/api/billing/invoices?limit=5', { token: CASHIER, branch: THANE });
  check('a cashier asking for another branch is refused', other.status === 403, other.body.error);
  const theirs = await call('GET', '/api/billing/invoices?limit=50', { token: CASHIER });
  check('a cashier\'s bill list holds only their branch', (theirs.body ?? []).every((r) => r.branch_id === ANDHERI || r.branch_name === 'Andheri West'));
  const cashierGrn = await call('POST', '/api/inventory/grn', { token: CASHIER, body: { vendor_id: VENDOR, lines: [] } });
  check('a cashier cannot record a purchase', cashierGrn.status === 403, cashierGrn.body.error);
} catch (err) {
  failures.push(`suite crashed: ${err.stack ?? err}`);
  console.log(`\n${C.r}suite crashed:${C.x} ${err.stack ?? err}`);
} finally {
  await pool.end();
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) { console.log(`\n${C.r}Failures:${C.x}`); failures.forEach((f) => console.log(`  • ${f}`)); process.exit(1); }
console.log(`${C.g}The working day reconciles end to end, for the Owner and for branch staff.${C.x}`);
