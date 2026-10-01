// ============================================================================
// End-to-end business workflows (Section 45) and the data-consistency chain
// (Section 44).
//
// These are the ten journeys a real shop runs, driven through the API exactly as
// the app drives it, and then checked against the database underneath. The point
// is not that each request returns 200: it is that the invoice, the payment, the
// stock ledger, the customer ledger, the report and the PDF all end up saying the
// same number.
//
//   node tests/workflows.mjs
// ============================================================================
import pg from '../node_modules/pg/lib/index.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail ? `  ${C.d}${String(detail).slice(0, 110)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 170)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (email, password) => (await call('POST', '/api/auth/login/password', { body: { email, password } })).body;
const loginPin = async (phone, pin) => (await call('POST', '/api/auth/login/pin', { body: { phone, pin } })).body;

async function pdfText(path, token) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false, text: '', status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  const f = join(mkdtempSync(join(tmpdir(), 'erp-wf-')), 'doc.pdf');
  writeFileSync(f, buf);
  let text = '';
  try { text = execFileSync('pdftotext', ['-layout', f, '-'], { encoding: 'utf8' }); } catch { /* absent */ }
  return { ok: true, text, bytes: buf.length, status: res.status };
}

const pool = new pg.Pool({ connectionString: DB });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const money = (n) => Number(Number(n).toFixed(2));

const owner = await login('owner@hardwareerp.in', 'Owner@12345');
const mgr = await login('sunita@hardwareerp.in', 'Manager@12345');
const cashier = await loginPin('9900000005', '1234');
const invStaff = await loginPin('9900000008', '1234');
const accountant = await login('meera@hardwareerp.in', 'Account@12345');
const B1 = cashier.user.branch_id;
const stamp = Date.now();

try {
  // ══ Workflow 1 ════════════════════════════════════════════════════════════
  section('1 · Customer → product → stock → GST bill → cash → finalise → PDF');
  let wf1 = {};
  {
    const cust = await call('POST', '/api/customers', { token: cashier.token,
      body: { name: `Workflow Customer ${stamp}`, phone: `98${String(stamp).slice(-8)}`,
              gstin: '27AAAFP2676D1ZD', address: 'Plot 14, J.K. Gram Road, Thane', state: 'Maharashtra', state_code: '27' } });
    check('a customer is created', cust.status === 200, cust.body.name ?? JSON.stringify(cust.body).slice(0, 70));

    const cat = (await call('GET', '/api/catalog/categories', { token: owner.token })).body[0];
    const prod = await call('POST', '/api/catalog/products', { token: owner.token,
      body: { name: `GI 1/2in Pipe WF${stamp}`, sku: `WF-${stamp}`, category_id: cat.category_id,
              base_unit: 'PIECE', hsn_code: '3917', default_price_type: 'TAX_INCLUSIVE',
              mrp: 60, selling_price: 45 } });
    check('a product is created with an HSN that has a GST rate', prod.status === 200,
      prod.body.name ?? JSON.stringify(prod.body).slice(0, 90));

    // Stock arrives the way it really does — through a GRN against a vendor.
    const vendor = (await call('GET', '/api/vendors?limit=1', { token: invStaff.token })).body[0];
    const grn = await call('POST', '/api/inventory/grn', { token: invStaff.token,
      body: { vendor_id: vendor.vendor_id, invoice_no: `VINV-${stamp}`,
              lines: [{ product_id: prod.body.product_id, qty_base_unit: 100, rate: 30 }] } });
    check('stock arrives through a GRN', grn.status === 200, grn.body.grn_number ?? JSON.stringify(grn.body).slice(0, 90));

    const stock = await q('SELECT base_unit_qty, weighted_avg_cost FROM branch_stock WHERE branch_id=$1 AND product_id=$2',
      [B1, prod.body.product_id]);
    check('the stock is on the shelf at the right cost',
      Number(stock[0]?.base_unit_qty) === 100 && Number(stock[0]?.weighted_avg_cost) === 30,
      `${stock[0]?.base_unit_qty} @ ${stock[0]?.weighted_avg_cost}`);

    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', customer_id: cust.body.customer_id,
              lines: [{ product_id: prod.body.product_id, qty_in_sale_unit: 40 }] } });
    const payable = draft.body.totals.payable;
    check('a draft prices 40 pipes at the catalog rate', money(payable) === 1800, `₹${payable} (40 × ₹45)`);

    const inv = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, { token: cashier.token,
      body: { payments: [{ method: 'CASH', amount: payable }] } });
    check('it finalises with an invoice number', inv.status === 200 && inv.body.invoice_number, inv.body.invoice_number);
    wf1 = { ...wf1, invoice: inv.body, product: prod.body, customer: cust.body, payable };

    // ── Section 44: the same number, everywhere ─────────────────────────────
    const row = (await q('SELECT * FROM invoices WHERE invoice_id=$1', [inv.body.invoice_id]))[0];
    const pay = (await q('SELECT COALESCE(SUM(amount),0) s FROM invoice_payments WHERE invoice_id=$1', [inv.body.invoice_id]))[0];
    const led = (await q(`SELECT COALESCE(SUM(base_unit_qty_change),0) s FROM stock_ledger WHERE ref_id=$1 AND movement_type='SALE'`, [inv.body.invoice_id]))[0];
    const dbTotal = money(Number(row.grand_total) + Number(row.round_off));
    check('database total matches the API', dbTotal === money(payable), `${dbTotal} vs ${payable}`);
    check('payments match the invoice', money(pay.s) === money(payable), `${pay.s} vs ${payable}`);
    check('stock moved by exactly what was sold', Number(led.s) === -40, String(led.s));

    const doc = await pdfText(`/api/billing/invoices/${inv.body.invoice_id}/pdf`, cashier.token);
    const shown = doc.text.replace(/,/g, '');
    check('the PDF shows the same grand total', shown.includes(payable.toFixed(2)),
      `looking for ${payable.toFixed(2)}`);
    check('the PDF is a TAX INVOICE carrying the invoice number and GSTIN',
      /TAX INVOICE/.test(doc.text) && doc.text.includes(inv.body.invoice_number) && /GSTIN/.test(doc.text));
    check('the customer GSTIN is on the bill', doc.text.includes('27AAAFP2676D1ZD'));

    // The last link in the Section 44 chain: the report has to agree with the raw
    // transactions, not compute its own version of the truth.
    const rep = await call('GET', `/api/reports/sales-trend?days=1&branch_id=${B1}`, { token: owner.token });
    // The shop's calendar day, as the database sees it — not the test runner's UTC date.
    const today = (await q(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`))[0].d;
    const reported = rep.body.find((r) => String(r.period).startsWith(today));
    const raw = (await q(
      `SELECT COALESCE(SUM(grand_total + round_off), 0) s FROM invoices
        WHERE branch_id = $1 AND status = 'FINAL' AND server_received_at::date = CURRENT_DATE`, [B1]))[0];
    check('the sales report agrees with the invoice table to the paisa',
      rep.status === 200 && reported && Math.abs(money(reported.revenue) - money(raw.s)) < 0.01,
      `report ₹${reported?.revenue} vs invoices ₹${raw.s}`);
  }

  // ══ Workflow 2 ════════════════════════════════════════════════════════════
  section('2 · Non-GST bill → split payment → finalise → PDF');
  {
    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'NON_GST', lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 10 }] } });
    const payable = draft.body.totals.payable;
    check('a non-GST draft carries no tax',
      Number(draft.body.totals.cgst_total) === 0 && Number(draft.body.totals.sgst_total) === 0
      && Number(draft.body.totals.igst_total) === 0, `payable ₹${payable}`);

    const inv = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, { token: cashier.token,
      body: { payments: [{ method: 'CASH', amount: money(payable - 100) }, { method: 'UPI', amount: 100, ref_no: `UPI${stamp}` }] } });
    check('a split payment settles the bill', inv.status === 200, inv.body.invoice_number ?? JSON.stringify(inv.body).slice(0, 80));

    const pays = await q('SELECT method, amount FROM invoice_payments WHERE invoice_id=$1 ORDER BY method', [inv.body.invoice_id]);
    check('both payment legs are recorded', pays.length === 2 && money(pays.reduce((s, p) => s + Number(p.amount), 0)) === money(payable),
      pays.map((p) => `${p.method} ${p.amount}`).join(', '));

    const doc = await pdfText(`/api/billing/invoices/${inv.body.invoice_id}/pdf`, cashier.token);
    check('the PDF is a bill of supply, not a tax invoice',
      /CASH MEMO|BILL OF SUPPLY/i.test(doc.text) && !/TAX INVOICE/.test(doc.text));
    check('and mentions no GST at all', !/CGST|SGST|IGST/i.test(doc.text),
      (doc.text.match(/CGST|SGST|IGST/i) ?? ['clean'])[0]);
    check('both payment methods are printed', /CASH/.test(doc.text) && /UPI/.test(doc.text));
  }

  // ══ Workflow 3 ════════════════════════════════════════════════════════════
  section('3 · GST bill → partial return → credit note → refund → stock back');
  {
    const before = Number((await q('SELECT base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].base_unit_qty);
    const el = await call('GET', `/api/returns/eligibility/${wf1.invoice.invoice_id}`, { token: cashier.token });
    const line = el.body.lines[0];
    const ret = await call('POST', '/api/returns', { token: cashier.token,
      body: { invoice_id: wf1.invoice.invoice_id, return_reason: 'customer returned 10 pipes', refund_method: 'CASH',
              lines: [{ invoice_line_id: line.line_id, qty_base_unit: 10, condition: 'RESELLABLE' }] } });
    check('a partial return is accepted', ret.status === 200, JSON.stringify(ret.body).slice(0, 80));
    check('a GST return issues a credit note on its own series',
      Boolean(ret.body.credit_note_number) && ret.body.credit_note_number.startsWith('CN'), ret.body.credit_note_number);
    check('the refund is a quarter of the bill (10 of 40)',
      money(ret.body.returned_value) === money(wf1.payable / 4), `₹${ret.body.returned_value} of ₹${wf1.payable}`);

    const after = Number((await q('SELECT base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].base_unit_qty);
    check('resellable stock goes back on the shelf', after - before === 10, `${before} → ${after}`);

    const cn = (await q('SELECT cn.credit_note_number, SUM(cnl.taxable_value + cnl.cgst_amount + cnl.sgst_amount + cnl.igst_amount) total FROM credit_notes cn JOIN credit_note_lines cnl ON cnl.credit_note_id = cn.credit_note_id WHERE cn.credit_note_number=$1 GROUP BY 1', [ret.body.credit_note_number]))[0];
    check('the credit note lines add up to the refund', money(cn.total) === money(ret.body.returned_value),
      `${cn.total} vs ${ret.body.returned_value}`);

    const again = await call('POST', '/api/returns', { token: cashier.token,
      body: { invoice_id: wf1.invoice.invoice_id, return_reason: 'trying to return more than was sold',
              lines: [{ invoice_line_id: line.line_id, qty_base_unit: 999, condition: 'RESELLABLE' }] } });
    check('returning more than was sold is refused', again.status === 400, String(again.body.error).slice(0, 70));
  }

  // ══ Workflow 4 ════════════════════════════════════════════════════════════
  section('4 · Purchase order → GRN → stock → payable → purchase return → debit note');
  {
    const vendor = (await call('GET', '/api/vendors?limit=1', { token: invStaff.token })).body[0];
    const po = await call('POST', '/api/inventory/purchase-orders', { token: invStaff.token,
      body: { vendor_id: vendor.vendor_id, lines: [{ product_id: wf1.product.product_id, qty_base_unit: 50, rate: 32 }] } });
    check('a purchase order is raised', po.status === 200, po.body.po_number ?? JSON.stringify(po.body).slice(0, 70));

    const beforeCost = Number((await q('SELECT weighted_avg_cost FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].weighted_avg_cost);
    const beforeQty = Number((await q('SELECT base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].base_unit_qty);
    const grn = await call('POST', '/api/inventory/grn', { token: invStaff.token,
      body: { vendor_id: vendor.vendor_id, po_id: po.body.po_id, invoice_no: `VINV2-${stamp}`,
              lines: [{ product_id: wf1.product.product_id, qty_base_unit: 50, rate: 32 }] } });
    check('receiving against the PO works', grn.status === 200, grn.body.grn_number ?? JSON.stringify(grn.body).slice(0, 70));

    const afterCost = Number((await q('SELECT weighted_avg_cost FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].weighted_avg_cost);
    const expected = money((beforeQty * beforeCost + 50 * 32) / (beforeQty + 50));
    check('the weighted-average cost is recalculated, not overwritten',
      Math.abs(afterCost - expected) < 0.01, `${afterCost} vs expected ${expected}`);

    const ledgerBefore = (await call('GET', `/api/vendors/${vendor.vendor_id}/ledger`, { token: accountant.token })).body;
    const payableAfterGrn = Number(ledgerBefore[0]?.balance_after ?? 0);
    check('the GRN raises a vendor payable', payableAfterGrn > 0, `balance ₹${payableAfterGrn}`);

    // The debit note references GRN LINES, not products — that is what ties the
    // ITC reversal back to the rate the goods were received at (4.5.1).
    const grnDetail = await call('GET', `/api/inventory/grn/${grn.body.grn_id}`, { token: invStaff.token });
    const grnLine = grnDetail.body.lines.find((l) => l.product_id === wf1.product.product_id);
    const pr = await call('POST', '/api/inventory/purchase-returns', { token: invStaff.token,
      body: { grn_id: grn.body.grn_id, reason: 'damaged in transit',
              lines: [{ grn_line_id: grnLine.grn_line_id, qty_base_unit: 5 }] } });
    check('a purchase return issues a vendor debit note', pr.status === 200 && pr.body.debit_note_number,
      pr.body.debit_note_number ?? JSON.stringify(pr.body).slice(0, 80));
    check('the debit note uses its own number series',
      String(pr.body.debit_note_number).startsWith('DN'), pr.body.debit_note_number);

    const ledgerAfter = (await call('GET', `/api/vendors/${vendor.vendor_id}/ledger`, { token: accountant.token })).body;
    check('and reduces what is owed to the vendor',
      Number(ledgerAfter[0].balance_after) < payableAfterGrn,
      `${payableAfterGrn} → ${ledgerAfter[0].balance_after}`);
  }

  // ══ Workflow 5 ════════════════════════════════════════════════════════════
  section('5 · Inter-branch transfer → dispatch → receive → both ledgers');
  {
    const branches = (await call('GET', '/api/admin/branches', { token: owner.token })).body;
    const B2 = branches.find((b) => b.branch_id !== B1 && b.is_active).branch_id;
    const qtyA0 = Number((await q('SELECT base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].base_unit_qty);

    const tr = await call('POST', '/api/inventory/transfers', { token: invStaff.token,
      body: { to_branch_id: B2, lines: [{ product_id: wf1.product.product_id, qty_base_unit: 20 }] } });
    check('a transfer request is raised', tr.status === 200, tr.body.transfer_number ?? JSON.stringify(tr.body).slice(0, 70));

    const disp = await call('POST', `/api/inventory/transfers/${tr.body.transfer_id}/dispatch`, { token: invStaff.token, body: { driver_ref: 'MH-01-AB-1234' } });
    check('dispatch takes the goods out of the sending branch', disp.status === 200, String(disp.status));
    const qtyA1 = Number((await q('SELECT base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].base_unit_qty);
    check('the sending branch is down by 20', qtyA0 - qtyA1 === 20, `${qtyA0} → ${qtyA1}`);

    const b2mgr = await login('anita@hardwareerp.in', 'Manager@12345').catch(() => null);
    const receiver = b2mgr?.token ? b2mgr : owner;
    const trDetail = await call('GET', `/api/inventory/transfers/${tr.body.transfer_id}`, { token: owner.token });
    const trLine = trDetail.body.lines.find((l) => l.product_id === wf1.product.product_id);
    const rec = await call('POST', `/api/inventory/transfers/${tr.body.transfer_id}/receive`, { token: owner.token,
      body: { lines: [{ line_id: trLine.line_id, received_qty: 20 }] } });
    check('the receiving branch takes them in', rec.status === 200, JSON.stringify(rec.body).slice(0, 80));
    const qtyB = Number((await q('SELECT COALESCE(base_unit_qty,0) base_unit_qty FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B2, wf1.product.product_id]))[0]?.base_unit_qty ?? 0);
    check('branch B now holds the 20', qtyB >= 20, `branch B has ${qtyB}`);

    const both = await q(`SELECT branch_id, movement_type, SUM(base_unit_qty_change) s FROM stock_ledger
                           WHERE ref_id=$1 GROUP BY 1,2 ORDER BY 2`, [tr.body.transfer_id]);
    check('both branch ledgers carry the movement', both.length === 2,
      both.map((r) => `${r.movement_type} ${r.s}`).join(', '));
    check('and they net to zero across the chain',
      money(both.reduce((s, r) => s + Number(r.s), 0)) === 0,
      String(both.reduce((s, r) => s + Number(r.s), 0)));
    void receiver;
  }

  // ══ Workflow 6 ════════════════════════════════════════════════════════════
  section('6 · Offline sale → reconnect → sync → exactly one invoice');
  {
    const txnId = crypto.randomUUID();
    const body = {
      invoice_type: 'GST', client_txn_id: txnId, device_created_at: new Date().toISOString(),
      lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 1 }],
      payments: [{ method: 'CASH', amount: 45 }],
    };
    const first = await call('POST', '/api/billing/invoices', { token: cashier.token, body });
    check('the queued sale uploads', first.status === 200, first.body.invoice_number ?? JSON.stringify(first.body).slice(0, 70));

    // A till that lost its acknowledgement re-sends the same transaction.
    const replays = await Promise.all([
      call('POST', '/api/billing/invoices', { token: cashier.token, body }),
      call('POST', '/api/billing/invoices', { token: cashier.token, body }),
    ]);
    const rows = await q('SELECT COUNT(*)::int c FROM invoices WHERE client_txn_id=$1', [txnId]);
    check('re-sending it three times still creates one invoice', rows[0].c === 1, `${rows[0].c} invoices`);
    check('the replays report the original invoice',
      replays.every((r) => r.status === 200 && r.body.invoice_id === first.body.invoice_id));
    const led = await q(`SELECT COUNT(*)::int c FROM stock_ledger WHERE ref_id=$1 AND movement_type='SALE'`, [first.body.invoice_id]);
    check('and stock was decremented exactly once', led[0].c === 1, `${led[0].c} ledger entries`);

    const status = await call('POST', '/api/billing/sync/status', { token: cashier.token,
      body: { client_txn_ids: [txnId, crypto.randomUUID()] } });
    check('sync status tells the till what is already accepted',
      status.body.accepted.length === 1 && status.body.still_pending.length === 1,
      `${status.body.accepted.length} accepted, ${status.body.still_pending.length} pending`);
  }

  // ══ Workflow 7 ════════════════════════════════════════════════════════════
  section('7 · Credit sale → payment → ledger → outstanding');
  {
    await call('PUT', `/api/customers/${wf1.customer.customer_id}/credit`, { token: owner.token,
      body: { credit_allowed: true, credit_limit: 50000 } });
    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', customer_id: wf1.customer.customer_id,
              lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 20 }] } });
    const payable = draft.body.totals.payable;
    const inv = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, { token: cashier.token,
      body: { payments: [{ method: 'CREDIT', amount: payable }] } });
    check('a credit sale goes through under the limit', inv.status === 200, inv.body.invoice_number ?? JSON.stringify(inv.body).slice(0, 70));

    const bal1 = Number((await q('SELECT balance_after FROM customer_credit_ledger WHERE customer_id=$1 ORDER BY created_at DESC, entry_id DESC LIMIT 1', [wf1.customer.customer_id]))[0].balance_after);
    check('the customer ledger records what is owed', money(bal1) === money(payable), `₹${bal1} vs ₹${payable}`);

    const half = money(payable / 2);
    const pay = await call('POST', `/api/customers/${wf1.customer.customer_id}/payments`, { token: cashier.token,
      body: { amount: half, method: 'CASH' } });
    check('a part payment is accepted', pay.status === 200, JSON.stringify(pay.body).slice(0, 70));
    const bal2 = Number((await q('SELECT balance_after FROM customer_credit_ledger WHERE customer_id=$1 ORDER BY created_at DESC, entry_id DESC LIMIT 1', [wf1.customer.customer_id]))[0].balance_after);
    check('the balance falls by the payment', money(bal2) === money(payable - half), `₹${bal1} → ₹${bal2}`);

    const out = (await call('GET', '/api/customers/outstanding/list', { token: accountant.token })).body;
    const mine = out.find((c) => c.customer_id === wf1.customer.customer_id);
    check('the outstanding report agrees with the ledger',
      mine && money(mine.balance_owed) === money(bal2), `report ₹${mine?.balance_owed} vs ledger ₹${bal2}`);

    const over = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { invoice_type: 'GST', customer_id: wf1.customer.customer_id,
              lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 5 }],
              payments: [{ method: 'CREDIT', amount: 999999 }] } });
    check('a sale beyond the limit is refused', over.status >= 400, String(over.body.error).slice(0, 70));
  }

  // ══ Workflow 8 ════════════════════════════════════════════════════════════
  section('8 · Quotation → approve → reserve stock → convert → invoice');
  {
    await call('PUT', '/api/admin/settings/enable_quotations_module', { token: owner.token, body: { value: true } });
    await call('PUT', '/api/admin/settings/quotation_stock_reservation', { token: owner.token, body: { value: true } });

    const qt = await call('POST', '/api/quotations', { token: mgr.token,
      body: { customer_id: wf1.customer.customer_id, price_type: 'TAX_EXCLUSIVE',
              lines: [{ product_id: wf1.product.product_id, qty_base_unit: 5, rate: 45 }] } });
    check('a quotation is created', qt.status === 200, qt.body.quotation_number ?? JSON.stringify(qt.body).slice(0, 70));

    const reservedBefore = Number((await q('SELECT COALESCE(reserved_qty,0) r FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].r);
    const ap = await call('POST', `/api/quotations/${qt.body.quotation_id}/approve`, { token: mgr.token, body: { reserve_stock: true } });
    check('approving it reserves stock', ap.status === 200 && ap.body.stock_reserved === true, JSON.stringify(ap.body).slice(0, 70));
    const reservedAfter = Number((await q('SELECT COALESCE(reserved_qty,0) r FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].r);
    check('the reservation shows in branch stock', reservedAfter - reservedBefore === 5, `${reservedBefore} → ${reservedAfter}`);

    const doc = await pdfText(`/api/quotations/${qt.body.quotation_id}/pdf`, mgr.token);
    check('the estimate prints and says it is not a tax invoice',
      doc.ok && /ESTIMATE|QUOTATION/i.test(doc.text) && /not a tax invoice/i.test(doc.text),
      `${doc.status}, ${doc.bytes} bytes`);

    // Converting opens a DRAFT bill carrying the estimate's lines and rates; the
    // bill is then finalised through the ordinary billing path.
    const convDraft = await call('POST', `/api/quotations/${qt.body.quotation_id}/convert`, { token: mgr.token });
    check('it opens as a draft bill', convDraft.status === 200 && convDraft.body.draft?.status === 'DRAFT',
      convDraft.status === 200 ? convDraft.body.draft_invoice_id : String(convDraft.body.error).slice(0, 80));
    const stillHeld = Number((await q('SELECT COALESCE(reserved_qty,0) r FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].r);
    check('the stock stays reserved while the bill is only a draft', stillHeld === reservedAfter, `${reservedAfter} → ${stillHeld}`);
    const conv = convDraft.status === 200 ? await call('POST', `/api/billing/drafts/${convDraft.body.draft_invoice_id}/finalize`, {
      token: mgr.token, body: { payments: [{ method: 'CASH', amount: convDraft.body.draft.totals.payable }] } }) : convDraft;
    check('it converts to an invoice', conv.status === 200,
      conv.status === 200 ? conv.body.invoice_number : String(conv.body.error).slice(0, 80));
    const qAfter = (await q('SELECT status, converted_invoice_id FROM quotations WHERE quotation_id = $1', [qt.body.quotation_id]))[0];
    check('the estimate is marked converted only once the bill is final',
      qAfter.status === 'CONVERTED' && qAfter.converted_invoice_id === conv.body.invoice_id, qAfter.status);
    if (conv.status === 200) {
      const reservedFinal = Number((await q('SELECT COALESCE(reserved_qty,0) r FROM branch_stock WHERE branch_id=$1 AND product_id=$2', [B1, wf1.product.product_id]))[0].r);
      check('and the reservation is consumed, not left hanging', reservedFinal <= reservedBefore,
        `${reservedAfter} → ${reservedFinal}`);
    }
    await call('PUT', '/api/admin/settings/quotation_stock_reservation', { token: owner.token, body: { value: false } });
  }

  // ══ Workflow 9 ════════════════════════════════════════════════════════════
  section('9 · Till open → cash sale → cash drop → petty expense → close');
  {
    const till = await call('POST', '/api/billing/till-sessions', { token: cashier.token,
      body: { counter_id: `WF9-${stamp}`, opening_float: 2000 } });
    const T = till.body.session_id;
    check('a till session opens with a float', till.status === 200, `₹${till.body.opening_float}`);

    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 4 }] } });
    const sale = draft.body.totals.payable;
    await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, { token: cashier.token,
      body: { till_session_id: T, payments: [{ method: 'CASH', amount: sale }] } });

    // A cash drop needs a manager's PIN — a cashier cannot acknowledge their own.
    const noPin = await call('POST', `/api/billing/till-sessions/${T}/events`, { token: cashier.token,
      body: { event_type: 'CASH_DROP', amount: 500, note: 'to the safe' } });
    check('a cashier cannot acknowledge their own cash drop', noPin.status === 403, String(noPin.body.error).slice(0, 70));

    const drop = await call('POST', `/api/billing/till-sessions/${T}/events`, { token: mgr.token,
      body: { event_type: 'CASH_DROP', amount: 500, note: 'to the safe' } });
    check('a manager can', drop.status === 200, String(drop.status));

    const cat = (await call('GET', '/api/expenses/categories', { token: mgr.token })).body[0];
    const petty = await call('POST', `/api/billing/till-sessions/${T}/events`, { token: cashier.token,
      body: { event_type: 'PETTY_EXPENSE_PAYOUT', amount: 150, category_id: cat.category_id, note: 'auto rickshaw' } });
    check('a petty payout comes out of the drawer', petty.status === 200, String(petty.status));

    const rec = await call('GET', `/api/billing/till-sessions/${T}/reconcile`, { token: cashier.token });
    const expected = money(2000 + sale - 500 - 150);
    check('expected drawer = float + cash sales − drops − petty (3.3.1)',
      money(rec.body.expected_drawer_cash) === expected,
      `${rec.body.expected_drawer_cash} vs ${expected}`);

    const close = await call('POST', `/api/billing/till-sessions/${T}/close`, { token: cashier.token,
      body: { closing_counted_cash: money(expected - 20) } });
    check('closing reports only the variance, not the whole difference',
      money(close.body.variance) === -20, `variance ₹${close.body.variance}`);

    const linkedExpense = await q(`SELECT amount FROM expenses WHERE paid_from_till_session_id=$1`, [T]);
    check('the petty payout became a real expense row', linkedExpense.length === 1 && money(linkedExpense[0].amount) === 150,
      linkedExpense.map((e) => e.amount).join(','));
  }

  // ══ Workflow 10 ═══════════════════════════════════════════════════════════
  section('10 · Owner changes a setting → a branch operation actually changes');
  {
    // Discount ceiling: tighten it and watch the same bill flip from allowed to refused.
    await call('PUT', '/api/admin/settings/staff_discount_limit_pct', { token: owner.token, body: { value: 20 } });
    const generous = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: 40 }],
              payments: [{ method: 'CASH', amount: 40 }] } });
    check('an 11% discount is allowed while the ceiling is 20%', generous.status === 200,
      generous.body.invoice_number ?? String(generous.body.error).slice(0, 70));

    await call('PUT', '/api/admin/settings/staff_discount_limit_pct', { token: owner.token, body: { value: 2 } });
    const refused = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: 40 }],
              payments: [{ method: 'CASH', amount: 40 }] } });
    check('the same bill is refused once the ceiling drops to 2%', refused.status === 403,
      String(refused.body.error).slice(0, 80));
    await call('PUT', '/api/admin/settings/staff_discount_limit_pct', { token: owner.token, body: { value: 5 } });

    // Negative stock: the toggle has to reach the database trigger, not just the UI.
    const empty = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: wf1.product.product_id, qty_in_sale_unit: 100000 }],
              payments: [{ method: 'CASH', amount: 1 }] } });
    check('overselling is blocked while negative stock is off', empty.status === 409, String(empty.body.error).slice(0, 60));

    // Barcode requirement: off by default, and turning it on changes billing.
    await call('PUT', '/api/admin/settings/require_barcode_at_billing', { token: owner.token, body: { value: true, branch_id: B1 } });
    const eff = await call('GET', '/api/admin/settings/effective', { token: cashier.token });
    check('a branch-scoped setting reaches that branch\'s effective settings',
      eff.body.require_barcode_at_billing === true, String(eff.body.require_barcode_at_billing));
    await call('PUT', '/api/admin/settings/require_barcode_at_billing', { token: owner.token, body: { value: false, branch_id: B1 } });

    const byStaff = await call('PUT', '/api/admin/settings/staff_discount_limit_pct', { token: cashier.token, body: { value: 90 } });
    check('a cashier cannot change settings at all', byStaff.status === 403, String(byStaff.status));
  }
} finally {
  await pool.end();
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) {
  console.log(`\n${C.r}Failures:${C.x}`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`${C.g}All ten workflows complete, and every subsystem agrees on the numbers.${C.x}`);
