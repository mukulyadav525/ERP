// ============================================================================
// Optional HSN, contractor loyalty scale, thermal receipt, combined bill.
//   node tests/new-features.mjs     (seeded demo database, API running)
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

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function login(email, password) {
  for (let i = 0; i < 6; i += 1) {
    const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
    if (r.status === 200) return r.body.token;
    if (r.status !== 429) throw new Error(`login ${email}: ${r.status}`);
    await new Promise((res) => setTimeout(res, 15000));
  }
  throw new Error(`login ${email}: still rate-limited`);
}
/** Page width in points, from the first MediaBox. */
const pageWidth = (buf) => {
  const m = buf.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

try {
  const manager = await login('sunita@hardwareerp.in', 'Manager@12345');
  const owner = await login('owner@hardwareerp.in', 'Owner@12345');
  const andheri = (await one(`SELECT branch_id FROM users WHERE email = 'sunita@hardwareerp.in'`)).branch_id;
  const tag = randomUUID().slice(0, 6).toUpperCase();

  // ── Optional HSN ──────────────────────────────────────────────────────────
  section('HSN is optional; the GST rate is not');
  const base = { base_unit: 'PIECE', selling_price: 118, default_price_type: 'TAX_INCLUSIVE' };
  let r = await call('POST', '/api/catalog/products', { token: owner, body: { ...base, name: `No HSN no rate ${tag}` } });
  check('no HSN and no GST rate is refused', r.status === 400 && /GST rate/i.test(r.body.error), `${r.status} ${r.body.error}`);
  r = await call('POST', '/api/catalog/products', { token: owner, body: { ...base, name: `No HSN ${tag}`, gst_rate_pct: 18 } });
  check('no HSN with a GST rate is created', r.status === 200 && r.body.hsn_code === null && Number(r.body.gst_rate_pct) === 18, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const noHsn = r.body;
  r = await call('POST', '/api/catalog/products', { token: owner, body: { ...base, name: `Unknown HSN ${tag}`, hsn_code: '99887766' } });
  check('an HSN with no rate on file and no rate given is refused', r.status === 400, r.body.error);
  r = await call('POST', '/api/catalog/products', { token: owner, body: { ...base, name: `Unknown HSN rate ${tag}`, hsn_code: '99887766', gst_rate_pct: 12 } });
  check('…but accepted with the product\'s own rate', r.status === 200 && Number(r.body.gst_rate_pct) === 12, `${r.status}`);
  const knownHsn = (await one(`SELECT hsn_code, gst_rate_pct FROM hsn_tax_rates WHERE effective_to IS NULL LIMIT 1`));
  r = await call('POST', '/api/catalog/products', { token: owner, body: { ...base, name: `Known HSN ${tag}`, hsn_code: knownHsn.hsn_code, gst_rate_pct: 5 } });
  check('an HSN with a rate on file uses that rate (own rate not stored)', r.status === 200 && r.body.gst_rate_pct === null, JSON.stringify(r.body.gst_rate_pct));
  r = await call('POST', '/api/catalog/products', { token: owner, body: { ...base, name: `Bad HSN ${tag}`, hsn_code: '12', gst_rate_pct: 5 } });
  check('a malformed HSN is refused', r.status === 400, r.body.error);

  const pu = (await one(`SELECT product_unit_id FROM product_units WHERE product_id = $1`, [noHsn.product_id])).product_unit_id;
  r = await call('POST', '/api/billing/drafts', { token: manager, body: { invoice_type: 'GST', lines: [{ product_id: noHsn.product_id, product_unit_id: pu, qty_in_sale_unit: 1 }] } });
  const draftLine = r.body.lines?.[0];
  check('a GST bill of the HSN-less product charges its own 18%', r.status === 200 && Number(draftLine?.gst_rate_pct) === 18 && Math.abs(Number(r.body.totals.payable) - 118) < 0.02,
    `${r.status} rate=${draftLine?.gst_rate_pct} payable=${r.body.totals?.payable} ${r.body.error ?? ''}`);
  if (r.body.invoice_id) await call('DELETE', `/api/billing/drafts/${r.body.invoice_id}`, { token: manager });
  const detail = await call('GET', `/api/catalog/products/${noHsn.product_id}`, { token: owner });
  check('the product shows its own rate for editing', Number(detail.body.own_gst_rate_pct) === 18);
  r = await call('PUT', `/api/catalog/products/${noHsn.product_id}`, { token: owner, body: { gst_rate_pct: 5 } });
  check('the own rate can be changed', r.status === 200 && Number((await one(`SELECT gst_rate_pct FROM products WHERE product_id = $1`, [noHsn.product_id])).gst_rate_pct) === 5, `${r.status} ${r.body.error ?? ''}`);
  r = await call('POST', '/api/catalog/products/bulk-import', { token: owner, body: { dry_run: true, rows: [
    { sku: `IMP-${tag}-1`, name: `Imported no HSN ${tag}`, selling_price: 50, gst_rate_pct: 18 },
    { sku: `IMP-${tag}-2`, name: `Imported neither ${tag}`, selling_price: 50 },
  ] } });
  const importErrors = Array.isArray(r.body.details) ? r.body.details : [];
  check('CSV import: only the row with neither HSN nor GST rate is reported', r.status === 400 && importErrors.length === 1 && importErrors[0].row === 2,
    JSON.stringify(r.body).slice(0, 200));

  // ── Contractor loyalty ────────────────────────────────────────────────────
  section('Contractors earn on their own loyalty scale');
  const mk = async (name, type) => (await call('POST', '/api/customers', { token: owner,
    body: { name: `${name} ${tag}`, phone: `9${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 900 + 100)}`, customer_type: type } })).body;
  const retail = await mk('Retail', 'RETAIL');
  const contractor = await mk('Contractor', 'B2B_CONTRACTOR');
  check('a retail and a contractor customer exist', Boolean(retail.customer_id && contractor.customer_id), JSON.stringify(contractor).slice(0, 120));
  const item = await one(`
    SELECT p.product_id, pu.product_unit_id FROM products p
      JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit AND pu.multiplier_to_base = 1
      JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = $1
     WHERE p.is_active AND NOT p.batch_tracked AND NOT p.serial_tracked AND bs.base_unit_qty - bs.reserved_qty > 50
     ORDER BY bs.base_unit_qty DESC LIMIT 1`, [andheri]);
  const sell = async (customerId, qty, type = 'GST') => {
    const d = await call('POST', '/api/billing/drafts', { token: manager,
      body: { invoice_type: type, customer_id: customerId, lines: [{ product_id: item.product_id, product_unit_id: item.product_unit_id, qty_in_sale_unit: qty }] } });
    const payable = Number(d.body.totals.payable);
    await call('DELETE', `/api/billing/drafts/${d.body.invoice_id}`, { token: manager });
    const s = await call('POST', '/api/billing/invoices', { token: manager, body: {
      invoice_type: type, customer_id: customerId, client_txn_id: randomUUID(),
      lines: [{ product_id: item.product_id, product_unit_id: item.product_unit_id, qty_in_sale_unit: qty }],
      payments: [{ method: 'UPI', amount: payable, ref_no: 'T' }] } });
    return { ...s, payable };
  };
  const rs = await sell(retail.customer_id, 4);
  const cs = await sell(contractor.customer_id, 4);
  check('both sales go through', rs.status === 200 && cs.status === 200, `${rs.status} ${cs.status} ${JSON.stringify(cs.body).slice(0, 120)}`);
  const pts = async (id) => Number((await one(`SELECT loyalty_points_balance FROM customers WHERE customer_id = $1`, [id])).loyalty_points_balance);
  const retailPts = await pts(retail.customer_id), contractorPts = await pts(contractor.customer_id);
  check('retail earns 1 point per ₹100 (default)', retailPts === Math.floor(rs.payable / 100 * 1), `${retailPts} on ₹${rs.payable}`);
  check('the contractor earns 0.5 per ₹100 (default contractor scale)', contractorPts === Math.floor(cs.payable / 100 * 0.5), `${contractorPts} on ₹${cs.payable}`);
  r = await call('PUT', '/api/admin/settings/loyalty_contractor_earn_points_per_100', { token: owner, body: { value: 2 } });
  check('the contractor rate is an admin setting', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  const cs2 = await sell(contractor.customer_id, 2);
  const after = await pts(contractor.customer_id);
  check('…and a changed contractor rate applies to the next bill', after - contractorPts === Math.floor(cs2.payable / 100 * 2), `${after - contractorPts} on ₹${cs2.payable}`);
  const retailAfter = await sell(retail.customer_id, 2);
  check('…without touching the retail rate', (await pts(retail.customer_id)) - retailPts === Math.floor(retailAfter.payable / 100 * 1));

  // ── Thermal receipt ───────────────────────────────────────────────────────
  section('Thermal receipt');
  const invId = cs.body.invoice_id;
  r = await call('GET', `/api/billing/invoices/${invId}/thermal`, { token: manager, raw: true });
  const w80 = pageWidth(r.buf);
  check('80 mm receipt is a PDF 80 mm wide', r.status === 200 && r.headers.get('content-type') === 'application/pdf' && w80 && Math.abs(w80.w - 226.77) < 1, `${r.status} ${JSON.stringify(w80)}`);
  check('…and only as tall as its content', w80 && w80.h > 200 && w80.h < 2000, JSON.stringify(w80));
  r = await call('GET', `/api/billing/invoices/${invId}/thermal?width=58`, { token: manager, raw: true });
  check('58 mm on request', r.status === 200 && Math.abs(pageWidth(r.buf).w - 164.4) < 1, JSON.stringify(pageWidth(r.buf)));

  // ── Combined bill ─────────────────────────────────────────────────────────
  section('Combined bill for a customer');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const from = `${today.slice(0, 7)}-01`;
  const qs = `customer_id=${contractor.customer_id}&type=GST&from=${from}&to=${today}`;
  r = await call('GET', `/api/billing/combined-bill?${qs}`, { token: manager });
  check('the preview lists the contractor\'s two GST bills', r.status === 200 && r.body.count === 2, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const expected = Number((await one(`SELECT SUM(grand_total + round_off) AS t FROM invoices WHERE customer_id = $1 AND status = 'FINAL'`, [contractor.customer_id])).t);
  check('…with their stored total', Math.abs(r.body.total - expected) < 0.01, `${r.body.total} vs ${expected}`);
  const numbers0 = Number((await one(`SELECT count(*) AS n FROM invoices`)).n);
  r = await call('GET', `/api/billing/combined-bill?${qs}&format=pdf`, { token: manager, raw: true });
  check('A4 PDF', r.status === 200 && r.buf.subarray(0, 4).toString() === '%PDF' && Math.abs(pageWidth(r.buf).w - 595.28) < 1, `${r.status}`);
  r = await call('GET', `/api/billing/combined-bill?${qs}&format=pdf&group=item`, { token: manager, raw: true });
  check('A4 PDF, items merged', r.status === 200 && r.buf.subarray(0, 4).toString() === '%PDF');
  r = await call('GET', `/api/billing/combined-bill?${qs}&format=thermal`, { token: manager, raw: true });
  check('thermal PDF', r.status === 200 && r.buf.subarray(0, 4).toString() === '%PDF');
  check('making the combined bill creates no invoice', Number((await one(`SELECT count(*) AS n FROM invoices`)).n) === numbers0);
  r = await call('GET', `/api/billing/combined-bill?customer_id=${contractor.customer_id}&type=NON_GST&from=${from}&to=${today}&format=pdf`, { token: manager });
  check('no non-GST bills → a clear message, not an empty PDF', r.status === 400 && /no non-GST bills/i.test(r.body.error), r.body.error);
  r = await call('GET', `/api/billing/combined-bill?customer_id=${contractor.customer_id}&type=GST&from=${today}&to=${from}`, { token: manager });
  check('dates the wrong way round are refused', r.status === 400 || from === today, r.body.error);
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
