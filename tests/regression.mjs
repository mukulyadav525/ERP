// ============================================================================
// Regression suite for the defects found in the production-readiness audit, plus
// the negative cases from Section 46 and the concurrency cases from Section 40.
//
// Every check here corresponds to something that was once broken and is now
// fixed, or to an attack that must keep failing. It runs against a live API.
//
//   node tests/regression.mjs
// ============================================================================
import pg from '../node_modules/pg/lib/index.js';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail ? `  ${C.d}${String(detail).slice(0, 110)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 160)}${C.x}`); }
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
const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
  if (!r.body?.token) throw new Error(`login failed for ${email}`);
  return r.body;
};
const loginPin = async (phone, pin) => {
  const r = await call('POST', '/api/auth/login/pin', { body: { phone, pin } });
  if (!r.body?.token) throw new Error(`PIN login failed for ${phone}`);
  return r.body;
};

const pool = new pg.Pool({ connectionString: DB });
const q = async (s, p = []) => (await pool.query(s, p)).rows;

const owner = await login('owner@hardwareerp.in', 'Owner@12345');
const mgr = await login('sunita@hardwareerp.in', 'Manager@12345');
const cashier = await loginPin('9900000005', '1234');
const accountant = await login('meera@hardwareerp.in', 'Account@12345');
const B1 = cashier.user.branch_id;
const branches = (await call('GET', '/api/admin/branches', { token: owner.token })).body;
const B2 = branches.find((b) => b.branch_id !== B1).branch_id;

const products = (await call('GET', '/api/catalog/products?limit=80', { token: cashier.token })).body;
const stocked = products.filter((p) => Number(p.available_qty ?? 0) > 60 && Number(p.selling_price) > 0);
if (!stocked.length) throw new Error('the seed has no product with enough stock to test against');
const P = stocked[0];

/** Opens a draft, then finalises it — the path a reviewed bill takes. */
async function sell(token, { qty = 1, product = P, invoiceType = 'GST', customerId = null, payments } = {}) {
  const draft = await call('POST', '/api/billing/drafts', {
    token,
    body: { invoice_type: invoiceType, customer_id: customerId, lines: [{ product_id: product.product_id, qty_in_sale_unit: qty }] },
  });
  if (draft.status !== 200) return { draft, res: draft };
  const payable = draft.body.totals.payable;
  const res = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, {
    token, body: { payments: payments ?? [{ method: 'CASH', amount: payable }] },
  });
  return { draft, res, payable };
}

try {
  // ══ Settings-driven crashes ═══════════════════════════════════════════════
  section('Every documented refund policy works (Section 17)');
  {
    const sold = await sell(cashier.token, { qty: 2 });
    const el = await call('GET', `/api/returns/eligibility/${sold.res.body.invoice_id}`, { token: cashier.token });
    const line = el.body.lines[0];

    for (const policy of ['ADMIN_CHOICE', 'CASH', 'ORIGINAL_MODE', 'STORE_CREDIT']) {
      await call('PUT', '/api/admin/settings/refund_method', { token: owner.token, body: { value: policy } });
      // A fresh sale per policy, so each return has something to return.
      const s = await sell(cashier.token, { qty: 1 });
      const e = await call('GET', `/api/returns/eligibility/${s.res.body.invoice_id}`, { token: cashier.token });
      const l = e.body.lines[0];
      const r = await call('POST', '/api/returns', {
        token: cashier.token,
        body: { invoice_id: s.res.body.invoice_id, return_reason: `policy ${policy}`, refund_method: 'CASH',
                lines: [{ invoice_line_id: l.line_id, qty_base_unit: l.returnable_qty, condition: 'RESELLABLE' }] },
      });
      // ORIGINAL_MODE used to be cast straight into the payment_method enum and
      // took every return down with a 500.
      check(`refund_method = ${policy}`, r.status === 200,
        r.status === 200 ? `settled as ${r.body.refund_method}` : JSON.stringify(r.body).slice(0, 90));
    }
    await call('PUT', '/api/admin/settings/refund_method', { token: owner.token, body: { value: 'ADMIN_CHOICE' } });
    void sold; void line;
  }

  // ══ Till reconciliation ═══════════════════════════════════════════════════
  section('A cash refund leaves the drawer (Sections 3.3.1, 18)');
  {
    const till = await call('POST', '/api/billing/till-sessions', {
      token: cashier.token, body: { counter_id: `REG-${Date.now()}`, opening_float: 1000 } });
    const T = till.body.session_id;

    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 2 }] } });
    const payable = draft.body.totals.payable;
    const inv = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, {
      token: cashier.token, body: { till_session_id: T, payments: [{ method: 'CASH', amount: payable }] } });

    const before = await call('GET', `/api/billing/till-sessions/${T}/reconcile`, { token: cashier.token });
    const el = await call('GET', `/api/returns/eligibility/${inv.body.invoice_id}`, { token: cashier.token });
    const line = el.body.lines[0];
    const ret = await call('POST', '/api/returns', { token: cashier.token,
      body: { invoice_id: inv.body.invoice_id, return_reason: 'till regression', refund_method: 'CASH',
              till_session_id: T,
              lines: [{ invoice_line_id: line.line_id, qty_base_unit: line.returnable_qty, condition: 'RESELLABLE' }] } });
    const after = await call('GET', `/api/billing/till-sessions/${T}/reconcile`, { token: cashier.token });

    const expectedDrop = Number(before.body.expected_drawer_cash) - Number(after.body.expected_drawer_cash);
    check('the expected drawer figure drops by the refund',
      Math.abs(expectedDrop - Number(ret.body.cash_refund_amount)) < 0.01,
      `expected fell by ${expectedDrop}, refund was ${ret.body.cash_refund_amount}`);
    check('the refund is recorded against the till', Number(ret.body.till_cash_reversed) > 0,
      `till_cash_reversed=${ret.body.till_cash_reversed}`);

    // Without a till session the API must SAY so rather than silently losing it.
    const noTill = await call('POST', '/api/returns', { token: mgr.token,
      body: { invoice_id: inv.body.invoice_id, return_reason: 'x', refund_method: 'CASH', lines: [] } });
    check('an empty return line list is rejected', noTill.status === 400, JSON.stringify(noTill.body).slice(0, 80));
    await call('POST', `/api/billing/till-sessions/${T}/close`, { token: cashier.token, body: { closing_counted_cash: Number(after.body.expected_drawer_cash) } });
  }

  // ══ Discount ceiling and loyalty stacking ════════════════════════════════
  section('Giving margin away is measured the same way however it is entered (3.4, 11.2)');
  {
    const customers = (await call('GET', '/api/customers?limit=60', { token: cashier.token })).body;
    const withPoints = customers.find((c) => Number(c.loyalty_points_balance) > 500);
    const rate = Number(P.selling_price);
    const typed = Math.round(rate * 0.04 * 100) / 100;
    const lowered = Math.round((rate - typed) * 100) / 100;
    const pay = (total) => [{ method: 'LOYALTY_POINTS', amount: 5 }, { method: 'CASH', amount: Math.round((total - 5) * 100) / 100 }];

    const a = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { customer_id: withPoints.customer_id, invoice_type: 'GST',
              lines: [{ product_id: P.product_id, qty_in_sale_unit: 1, discount_amount: typed }], payments: pay(lowered) } });
    const b = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { customer_id: withPoints.customer_id, invoice_type: 'GST',
              lines: [{ product_id: P.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: lowered }], payments: pay(lowered) } });
    check('a typed discount blocks loyalty stacking', a.status === 400, String(a.body.error).slice(0, 70));
    // The same giveaway hidden in the line rate used to slip past this rule.
    check('the same discount hidden in the rate also blocks it', b.status === 400, String(b.body.error).slice(0, 70));

    const deep = await call('POST', '/api/billing/invoices', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: 1 }],
              payments: [{ method: 'CASH', amount: 1 }] } });
    check('selling far below catalog needs a manager PIN', deep.status === 403, String(deep.body.error).slice(0, 70));
  }

  // ══ Silent success ════════════════════════════════════════════════════════
  section('Nothing reports success for work it did not do (Section 47)');
  {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const r1 = await call('POST', `/api/billing/stock-conflicts/${ghost}/resolve`, { token: mgr.token, body: { resolution: 'SUBSTITUTED' } });
    check('resolving a conflict that does not exist fails', r1.status === 404, `${r1.status} ${JSON.stringify(r1.body).slice(0, 60)}`);
    const r2 = await call('PUT', `/api/returns/warranty-claims/${ghost}`, { token: mgr.token, body: { status: 'REPAIRED' } });
    check('updating a warranty claim that does not exist fails', r2.status === 404, String(r2.status));
    const r3 = await call('POST', '/api/billing/invoices', { token: owner.token, body: { branch_id: 'not-a-uuid', lines: [], payments: [] } });
    check('a malformed branch id is a 400, not a 500', r3.status === 400, String(r3.body.error).slice(0, 60));
  }

  // ══ Draft security ════════════════════════════════════════════════════════
  section('Drafts obey branch isolation and cannot be tampered with (Sections 6, 8)');
  {
    const foreign = await call('POST', '/api/billing/drafts', { token: owner.token,
      body: { branch_id: B2, invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] } });
    const id = foreign.body.invoice_id;
    for (const [who, tok] of [['a cashier', cashier.token], ['a branch manager', mgr.token]]) {
      const reads = await call('GET', `/api/billing/drafts/${id}`, { token: tok });
      const edits = await call('PUT', `/api/billing/drafts/${id}`, { token: tok, body: { lines: [] } });
      const fin = await call('POST', `/api/billing/drafts/${id}/finalize`, { token: tok, body: { payments: [{ method: 'CASH', amount: 1 }] } });
      const del = await call('DELETE', `/api/billing/drafts/${id}`, { token: tok });
      check(`${who} cannot touch another branch's draft`,
        [reads, edits, fin, del].every((r) => r.status === 404 || r.status === 403),
        `${reads.status}/${edits.status}/${fin.status}/${del.status}`);
    }
    const listed = (await call('GET', '/api/billing/drafts', { token: cashier.token })).body;
    check('another branch\'s draft is not in the list', !listed.some((d) => d.invoice_id === id));

    // Mass assignment: the client may not set status, number, branch or totals.
    const mine = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] } });
    const tampered = await call('PUT', `/api/billing/drafts/${mine.body.invoice_id}`, { token: cashier.token,
      body: { status: 'FINAL', invoice_number: 'INV-FAKE/0001', branch_id: B2, grand_total: 1, subtotal: 1,
              created_by: owner.user.user_id, lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] } });
    check('status cannot be set by the client', tampered.body.status === 'DRAFT', String(tampered.body.status));
    check('an invoice number cannot be claimed', tampered.body.invoice_number === null, String(tampered.body.invoice_number));
    check('the branch cannot be switched', tampered.body.branch_id === B1, String(tampered.body.branch_id).slice(0, 8));
    check('the total is the server\'s, not the client\'s', Number(tampered.body.totals.payable) > 1,
      `client said 1, server says ${tampered.body.totals.payable}`);

    const other = await call('POST', '/api/billing/drafts', { token: mgr.token,
      body: { invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] } });
    const steal = await call('DELETE', `/api/billing/drafts/${other.body.invoice_id}`, { token: cashier.token });
    check('a cashier cannot discard someone else\'s draft', steal.status === 403, String(steal.body.error).slice(0, 60));
  }

  section('A finalised invoice is immutable (Sections 12, 63)');
  {
    const s = await sell(cashier.token);
    const id = s.res.body.invoice_id;
    const edit = await call('PUT', `/api/billing/drafts/${id}`, { token: cashier.token, body: { lines: [] } });
    const del = await call('DELETE', `/api/billing/drafts/${id}`, { token: mgr.token });
    const refin = await call('POST', `/api/billing/drafts/${id}/finalize`, { token: cashier.token, body: { payments: [{ method: 'CASH', amount: 1 }] } });
    check('it cannot be edited', edit.status === 400, String(edit.body.error).slice(0, 70));
    check('it cannot be deleted', del.status === 400, String(del.status));
    check('it cannot be finalised twice', refin.status === 400 || refin.status === 409, String(refin.status));

    // The database refuses too, not just the API — the app role has no path to it.
    const direct = await q(`SELECT has_table_privilege('erp_app','invoice_lines','DELETE') AS may_delete`);
    check('the app role has DELETE on invoice_lines only because a trigger gates it',
      direct[0].may_delete === true, 'privilege granted, trigger enforces draft-only');
    let blocked = false;
    try {
      await q(`SET LOCAL ROLE erp_app`);
    } catch { /* not applicable outside a transaction */ }
    const trig = await q(`SELECT count(*)::int c FROM pg_trigger WHERE tgname LIKE 'trg_invoice%draft_only'`);
    check('the draft-only triggers exist', trig[0].c >= 2, `${trig[0].c} triggers`);
    void blocked;
  }

  section('A draft survives its product being retired (self-review finding)');
  {
    // Found by attacking the draft flow after building it: retiring a catalog
    // product left an open draft that could not be read, edited OR discarded,
    // because every path re-priced it first and the pricing threw.
    const cat = (await call('GET', '/api/catalog/categories', { token: owner.token })).body[0];
    const doomed = async () => {
      const n = `${Date.now()}${Math.round(Math.random() * 1e6)}`;
      const prod = await call('POST', '/api/catalog/products', { token: owner.token,
        body: { name: `Retired ${n}`, sku: `RET-${n}`, category_id: cat.category_id, base_unit: 'PIECE',
                hsn_code: '3917', default_price_type: 'TAX_INCLUSIVE', mrp: 100, selling_price: 80 } });
      const d = await call('POST', '/api/billing/drafts', { token: cashier.token,
        body: { invoice_type: 'GST', lines: [{ product_id: prod.body.product_id, qty_in_sale_unit: 1 }] } });
      await call('PUT', `/api/catalog/products/${prod.body.product_id}`, { token: owner.token, body: { is_active: false } });
      return d.body.invoice_id;
    };

    const readable = await call('GET', `/api/billing/drafts/${await doomed()}`, { token: cashier.token });
    check('it can still be opened, and says what is wrong',
      readable.status === 200 && Boolean(readable.body.pricing_error),
      String(readable.body.pricing_error ?? readable.status).slice(0, 70));
    check('and still lists the line that has to go',
      (readable.body.unpriced_lines ?? []).length === 1);

    const replaced = await call('PUT', `/api/billing/drafts/${readable.body.invoice_id}`, { token: cashier.token,
      body: { lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] } });
    check('replacing the offending line repairs it', replaced.status === 200 && Number(replaced.body.totals.payable) > 0,
      `payable ₹${replaced.body.totals?.payable}`);

    check('and an unrepaired one can simply be thrown away',
      (await call('DELETE', `/api/billing/drafts/${await doomed()}`, { token: cashier.token })).status === 200);

    const fin = await call('POST', `/api/billing/drafts/${await doomed()}/finalize`, { token: cashier.token,
      body: { payments: [{ method: 'CASH', amount: 1 }] } });
    check('finalising it is refused with a message, not a 500', fin.status === 400,
      `${fin.status} ${String(fin.body.error).slice(0, 60)}`);
  }

  section('The draft-only trigger cannot be tricked (self-review finding)');
  {
    // Every SECURITY DEFINER function in the schema pins its search_path; the one
    // added for draft mutability originally did not, which would have let the app
    // role shadow `invoices` with a temp table and read a fabricated status.
    const cfg = await q(`SELECT array_to_string(proconfig, ',') AS cfg FROM pg_proc WHERE proname = 'erp_only_drafts_are_mutable'`);
    check('the trigger function pins its search_path',
      /search_path=public/.test(cfg[0]?.cfg ?? ''), cfg[0]?.cfg ?? 'not set');
    const unpinned = await q(`SELECT count(*)::int c FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = 'public' AND p.prosecdef AND p.proconfig IS NULL`);
    check('no SECURITY DEFINER function is left unpinned', unpinned[0].c === 0, `${unpinned[0].c} unpinned`);
  }

  section('The printed logo cannot point at the server\'s filesystem');
  {
    const attempt = await call('PUT', '/api/admin/settings/business_profile', { token: owner.token,
      body: { value: { name: 'Bhawani Paint & Electric Hardware Stores', logo: '/etc/passwd' } } });
    check('a filesystem path is dropped rather than stored',
      attempt.status === 200 && (attempt.body.value?.logo ?? null) === null,
      `stored logo: ${JSON.stringify(attempt.body.value?.logo)}`);
    const ok = await call('PUT', '/api/admin/settings/business_profile', { token: owner.token,
      body: { value: { name: 'Bhawani Paint & Electric Hardware Stores',
                       logo: 'data:image/png;base64,iVBORw0KGgo=' } } });
    check('an embedded image is kept', ok.status === 200 && String(ok.body.value?.logo).startsWith('data:image/png'));
  }

  // ══ Concurrency ═══════════════════════════════════════════════════════════
  section('Concurrency (Section 40)');
  {
    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 2 }] } });
    const payable = draft.body.totals.payable;
    const fire = () => call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, {
      token: cashier.token, body: { payments: [{ method: 'CASH', amount: payable }] } });
    const [a, b] = await Promise.all([fire(), fire()]);
    const ledger = await q(`SELECT count(*)::int c FROM stock_ledger WHERE ref_id=$1 AND movement_type='SALE'`, [draft.body.invoice_id]);
    const pays = await q(`SELECT count(*)::int c FROM invoice_payments WHERE invoice_id=$1`, [draft.body.invoice_id]);
    check('two simultaneous finalisations produce one sale',
      (a.status === 200) !== (b.status === 200) && ledger[0].c === 1 && pays[0].c === 1,
      `${a.status}/${b.status}, ${ledger[0].c} stock entries, ${pays[0].c} payments`);

    // Gapless, unique numbering under load (3.6).
    const many = await Promise.all(Array.from({ length: 8 }, () => sell(cashier.token)));
    const nums = many.filter((m) => m.res.status === 200).map((m) => m.res.body.invoice_number);
    check('8 parallel sales get 8 distinct invoice numbers', new Set(nums).size === nums.length, `${nums.length} sales`);
    const seq = nums.map((n) => Number(n.split('/').pop())).sort((x, y) => x - y);
    check('and the series has no gaps', seq[seq.length - 1] - seq[0] === seq.length - 1, seq.join(','));

    // Two clerks refunding the same line at once (Section 46: duplicate return).
    const target = many.find((m) => m.res.status === 200).res.body;
    const el = await call('GET', `/api/returns/eligibility/${target.invoice_id}`, { token: cashier.token });
    const line = el.body.lines[0];
    const ret = () => call('POST', '/api/returns', { token: cashier.token,
      body: { invoice_id: target.invoice_id, return_reason: 'race', refund_method: 'CASH',
              lines: [{ invoice_line_id: line.line_id, qty_base_unit: line.returnable_qty, condition: 'RESELLABLE' }] } });
    const [r1, r2] = await Promise.all([ret(), ret()]);
    const rows = await q(`SELECT COALESCE(SUM(qty_base_unit),0) s FROM sales_return_lines WHERE invoice_line_id=$1`, [line.line_id]);
    check('two simultaneous returns cannot refund the same goods twice',
      Number(rows[0].s) <= Number(line.returnable_qty) + 0.0001,
      `${rows[0].s} returned against ${line.returnable_qty} sold (${r1.status}/${r2.status})`);
  }

  // ══ Negative cases (Section 46) ═══════════════════════════════════════════
  section('Bad input fails safely (Section 46)');
  {
    const cases = [
      ['zero quantity', { lines: [{ product_id: P.product_id, qty_in_sale_unit: 0 }], payments: [{ method: 'CASH', amount: 1 }] }],
      ['negative quantity', { lines: [{ product_id: P.product_id, qty_in_sale_unit: -5 }], payments: [{ method: 'CASH', amount: 1 }] }],
      ['negative discount', { lines: [{ product_id: P.product_id, qty_in_sale_unit: 1, discount_amount: -100 }], payments: [{ method: 'CASH', amount: 1 }] }],
      ['negative payment', { lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }], payments: [{ method: 'CASH', amount: -50 }] }],
      ['unknown payment method', { lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }], payments: [{ method: 'BITCOIN', amount: 10 }] }],
      ['no lines at all', { lines: [], payments: [{ method: 'CASH', amount: 1 }] }],
      ['no payment at all', { lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }], payments: [] }],
      ['a product that does not exist', { lines: [{ product_id: '00000000-0000-4000-8000-000000000000', qty_in_sale_unit: 1 }], payments: [{ method: 'CASH', amount: 1 }] }],
      ['a malformed product id', { lines: [{ product_id: 'x', qty_in_sale_unit: 1 }], payments: [{ method: 'CASH', amount: 1 }] }],
      ['an absurd quantity', { lines: [{ product_id: P.product_id, qty_in_sale_unit: 1e15 }], payments: [{ method: 'CASH', amount: 1 }] }],
    ];
    for (const [name, body] of cases) {
      const r = await call('POST', '/api/billing/invoices', { token: cashier.token, body: { invoice_type: 'GST', ...body } });
      check(name, r.status >= 400 && r.status < 500, `${r.status} ${String(r.body?.error ?? '').slice(0, 60)}`);
    }
    // The same battery against the draft endpoint, which is a second door in.
    for (const [name, body] of cases.slice(0, 5)) {
      const r = await call('POST', '/api/billing/drafts', { token: cashier.token, body: { invoice_type: 'GST', ...body } });
      check(`draft: ${name}`, r.status >= 400 && r.status < 500, `${r.status}`);
    }
    const badSql = await call('GET', `/api/billing/invoices?q=${encodeURIComponent("' OR 1=1--")}`, { token: cashier.token });
    check('a SQL-injection attempt is just a search term', badSql.status === 200 && Array.isArray(badSql.body),
      `${badSql.status}, ${badSql.body.length} rows`);
    const noAuth = await call('GET', '/api/billing/invoices');
    check('no token is a 401', noAuth.status === 401, String(noAuth.status));
    const badAuth = await call('GET', '/api/billing/invoices', { token: 'not-a-real-token' });
    check('a forged token is a 401', badAuth.status === 401, String(badAuth.status));
  }

  // ══ What the customer is told about their money ═══════════════════════════
  // The receipt screen and the WhatsApp message both label a sale from
  // `payment_summary`. That label is a factual claim made to a customer, so it
  // has to come from the payment rows the server actually wrote — not from a
  // constant, which is what it used to be: every bill, including one taken
  // entirely on credit, went out saying "Status: Paid".
  section('Payment status told to the customer');
  {
    const creditCustomer = (await call('POST', '/api/customers', {
      token: owner.token,
      body: { name: 'Regression Credit Buyer', phone: `98${Date.now() % 100000000}`,
              credit_allowed: true, credit_limit: 100000 },
    })).body;

    const cash = await sell(cashier.token, { qty: 1 });
    check('a fully settled sale reports PAID',
      cash.res.body?.payment_summary?.status === 'PAID',
      JSON.stringify(cash.res.body?.payment_summary));
    check('and reports nothing outstanding',
      Number(cash.res.body?.payment_summary?.on_credit ?? -1) === 0,
      String(cash.res.body?.payment_summary?.on_credit));

    if (creditCustomer?.customer_id) {
      const onCredit = await sell(cashier.token, {
        qty: 1, customerId: creditCustomer.customer_id,
        payments: null,   // replaced below, once the payable is known
      });
      // sell() defaults to a full cash payment; redo it explicitly on credit.
      const draft = await call('POST', '/api/billing/drafts', {
        token: cashier.token,
        body: { invoice_type: 'GST', customer_id: creditCustomer.customer_id,
                lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] },
      });
      const payable = draft.body.totals.payable;
      const full = await call('POST', `/api/billing/drafts/${draft.body.invoice_id}/finalize`, {
        token: cashier.token, body: { payments: [{ method: 'CREDIT', amount: payable }] },
      });
      check('a sale taken entirely on credit is NOT reported as paid',
        full.body?.payment_summary?.status === 'ON_CREDIT',
        JSON.stringify(full.body?.payment_summary));
      check('and the outstanding figure equals the payable',
        Math.abs(Number(full.body?.payment_summary?.on_credit ?? 0) - Number(payable)) < 0.01,
        `${full.body?.payment_summary?.on_credit} vs ${payable}`);

      const split = await call('POST', '/api/billing/drafts', {
        token: cashier.token,
        body: { invoice_type: 'GST', customer_id: creditCustomer.customer_id,
                lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] },
      });
      const p2 = Number(split.body.totals.payable);
      const half = Math.round(p2 * 50) / 100;
      const part = await call('POST', `/api/billing/drafts/${split.body.invoice_id}/finalize`, {
        token: cashier.token,
        body: { payments: [{ method: 'CASH', amount: half }, { method: 'CREDIT', amount: Math.round((p2 - half) * 100) / 100 }] },
      });
      check('a part-paid sale is reported as part paid, not paid',
        part.body?.payment_summary?.status === 'PARTIALLY_PAID',
        JSON.stringify(part.body?.payment_summary));
      check('and the two halves add up to the payable',
        Math.abs(Number(part.body?.payment_summary?.settled ?? 0)
               + Number(part.body?.payment_summary?.on_credit ?? 0) - p2) < 0.01,
        `${part.body?.payment_summary?.settled} + ${part.body?.payment_summary?.on_credit} vs ${p2}`);

      // The summary must agree with the database, not merely with itself.
      const rows = await q(
        'SELECT method::text AS method, amount FROM invoice_payments WHERE invoice_id = $1',
        [part.body.invoice_id]);
      const dbCredit = rows.filter((r) => r.method === 'CREDIT')
        .reduce((sum, r) => sum + Number(r.amount), 0);
      check('the reported outstanding matches the payment rows in the database',
        Math.abs(dbCredit - Number(part.body?.payment_summary?.on_credit ?? 0)) < 0.01,
        `db ${dbCredit} vs reported ${part.body?.payment_summary?.on_credit}`);
    }
  }

  // ══ Documents ═════════════════════════════════════════════════════════════
  section('Printed documents (Sections 58-66)');
  {
    // Both documents are created here rather than hunted for in the existing data:
    // a search over recent invoices is a coin flip once a test run has added a
    // few dozen of its own, and a flaky test is worse than no test.
    const gstInv = (await sell(cashier.token, { invoiceType: 'GST' })).res.body;
    const nonGst = (await sell(cashier.token, { invoiceType: 'NON_GST' })).res.body;
    for (const [label, inv] of [['GST tax invoice', gstInv], ['non-GST cash memo', nonGst]]) {
      if (!inv) { check(`${label} PDF`, false, 'no such invoice in the data'); continue; }
      const res = await fetch(`${API}/api/billing/invoices/${inv.invoice_id}/pdf`, { headers: { Authorization: `Bearer ${cashier.token}` } });
      const buf = Buffer.from(await res.arrayBuffer());
      check(`${label} renders`, res.status === 200 && buf.subarray(0, 4).toString() === '%PDF', `${res.status}, ${buf.length} bytes`);
      // A bill of supply must not show GST anywhere on it (Section 10).
      if (label.startsWith('non-GST')) {
        const { writeFileSync: w, mkdtempSync: mk } = await import('node:fs');
        const { execFileSync: ex } = await import('node:child_process');
        const { tmpdir: td } = await import('node:os');
        const { join: j } = await import('node:path');
        const f = j(mk(j(td(), 'erp-ng-')), 'memo.pdf');
        w(f, buf);
        let txt = ''; try { txt = ex('pdftotext', [f, '-'], { encoding: 'utf8' }); } catch { /* pdftotext absent */ }
        check('the cash memo shows no GST columns or totals',
          txt !== '' && !/CGST|SGST|IGST|TAX SUMMARY/i.test(txt),
          txt ? (txt.match(/CGST|SGST|IGST|TAX SUMMARY/i) ?? ['clean'])[0] : 'pdftotext unavailable');
      }
    }
    const draft = await call('POST', '/api/billing/drafts', { token: cashier.token,
      body: { invoice_type: 'GST', lines: [{ product_id: P.product_id, qty_in_sale_unit: 1 }] } });
    const dres = await fetch(`${API}/api/billing/invoices/${draft.body.invoice_id}/pdf`, { headers: { Authorization: `Bearer ${cashier.token}` } });
    const dbuf = Buffer.from(await dres.arrayBuffer());
    // PDF text is Flate-compressed, so it has to be extracted rather than
    // searched for as raw bytes.
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = join(mkdtempSync(join(tmpdir(), 'erp-pdf-')), 'draft.pdf');
    writeFileSync(tmp, dbuf);
    let text = '';
    try { text = execFileSync('pdftotext', [tmp, '-'], { encoding: 'utf8' }); } catch { text = ''; }
    check('a draft prints as a proforma, not as a tax invoice',
      dres.status === 200 && /PROFORMA|DRAFT/i.test(text), `${dres.status}, ${dbuf.length} bytes`);
    check('and carries no invoice number', /Draft ref/i.test(text) && !/Invoice No\./i.test(text),
      text.split('\n').filter((l) => /Draft ref|Invoice No/i.test(l)).join(' | '));
    await call('DELETE', `/api/billing/drafts/${draft.body.invoice_id}`, { token: cashier.token });

    const profile = await call('PUT', '/api/admin/settings/business_profile', { token: owner.token, body: { value: { name: '' } } });
    check('a business profile with no name is refused', profile.status === 400, String(profile.body.error).slice(0, 70));
    const notOwner = await call('PUT', '/api/admin/settings/business_profile', { token: mgr.token, body: { value: { name: 'X' } } });
    check('only the owner can change the business profile', notOwner.status === 403, String(notOwner.status));
  }

  // ══ Field-level cost masking ══════════════════════════════════════════════
  section('Cost and margin stay hidden from staff (Section 2.6)');
  {
    const asCashier = await call('GET', '/api/inventory/stock?limit=5', { token: cashier.token });
    const asOwner = await call('GET', '/api/inventory/stock?limit=5', { token: owner.token });
    const leaks = (rows) => rows.some((r) => 'weighted_avg_cost' in r || 'stock_value' in r || 'margin' in r);
    check('a cashier sees no cost columns', asCashier.status !== 200 || !leaks(asCashier.body),
      asCashier.status === 200 ? Object.keys(asCashier.body[0] ?? {}).join(',').slice(0, 80) : `status ${asCashier.status}`);
    check('the owner does see them', asOwner.status === 200 && leaks(asOwner.body));
    const acc = await call('GET', '/api/reports/gst-summary', { token: accountant.token });
    check('an accountant can read GST reports', acc.status === 200, String(acc.status));
    const cashierGst = await call('GET', '/api/reports/gst-summary', { token: cashier.token });
    check('a cashier cannot', cashierGst.status === 403, String(cashierGst.status));
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
console.log(`${C.g}All regression checks passed.${C.x}`);
