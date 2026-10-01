/**
 * End-to-end smoke test.
 *
 * Logs in as each of the five roles and exercises every endpoint, asserting both
 * that the right people can do things AND that the wrong people cannot — a test
 * that only checks the happy path would pass just as happily with the whole
 * permission system deleted.
 *
 *   node scripts/smoke-test.mjs [http://localhost:4000]
 */
const BASE = process.argv[2] || process.env.API_URL || 'http://localhost:4000';

let passed = 0, failed = 0;
const failures = [];

function ok(name, detail = '') {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function fail(name, detail) {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`);
}
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** Asserts a call returns the expected status. */
async function expectStatus(name, expected, method, path, opts = {}) {
  const r = await call(method, path, opts);
  const list = Array.isArray(expected) ? expected : [expected];
  if (list.includes(r.status)) {
    ok(name, `${r.status}`);
    return r.body;
  }
  fail(name, `expected ${list.join('/')}, got ${r.status} — ${JSON.stringify(r.body).slice(0, 300)}`);
  return null;
}

let skipped = 0;
function skip(name, why) {
  skipped++;
  console.log(`  \x1b[33m~\x1b[0m ${name}  \x1b[90m${why}\x1b[0m`);
}

/** For endpoints that are rate limited by design: a 429 is a pass, and anything
 *  downstream of the response body is skipped rather than failed. */
async function throttleAware(name, method, path, opts = {}) {
  const r = await call(method, path, opts);
  if (r.status === 429) { skip(name, 'throttled — the limit is deliberate'); return null; }
  if (r.status === 200) { ok(name, '200'); return r.body; }
  fail(name, `expected 200 or 429, got ${r.status} — ${JSON.stringify(r.body).slice(0, 200)}`);
  return null;
}

function assert(name, condition, detail = '') {
  if (condition) ok(name, detail); else fail(name, detail || 'assertion failed');
}

const tokens = {};
const ids = {};

async function login(label, path, body) {
  let r = await call('POST', path, { body });
  // The login endpoints are rate limited on purpose; a test that logs in a dozen
  // times in two seconds is exactly the traffic shape they exist to slow down.
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, 61_000));
    r = await call('POST', path, { body });
  }
  if (r.status !== 200 || !r.body?.token) {
    fail(`login ${label}`, `${r.status} — ${JSON.stringify(r.body).slice(0, 200)}`);
    return null;
  }
  tokens[label] = r.body.token;
  ok(`login ${label}`, `${r.body.user.role}${r.body.user.branch_id ? ' @ branch' : ' (chain-wide)'}`);
  return r.body.user;
}

// ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\x1b[1mERP smoke test → ${BASE}\x1b[0m`);

  section('Health');
  const health = await expectStatus('GET /health', 200, 'GET', '/health');
  assert('schema is applied', (health?.table_count ?? 0) > 60, `${health?.table_count} tables`);

  // ── Authentication ───────────────────────────────────────────────────────
  section('Authentication (Section 7.2)');
  const owner = await login('owner', '/api/auth/login/password',
    { identifier: 'owner@hardwareerp.in', password: 'Owner@12345' });
  const mgr1 = await login('manager1', '/api/auth/login/password',
    { identifier: 'sunita@hardwareerp.in', password: 'Manager@12345' });
  const mgr2 = await login('manager2', '/api/auth/login/password',
    { identifier: 'vikas@hardwareerp.in', password: 'Manager@12345' });
  const acct = await login('accountant', '/api/auth/login/password',
    { identifier: 'meera@hardwareerp.in', password: 'Account@12345' });
  const cashier = await login('cashier', '/api/auth/login/pin', { phone: '9900000005', pin: '1234' });
  const invStaff = await login('inventory', '/api/auth/login/pin', { phone: '9900000008', pin: '1234' });

  ids.branch1 = mgr1?.branch_id;
  ids.branch2 = mgr2?.branch_id;

  await expectStatus('wrong password is rejected', 401, 'POST', '/api/auth/login/password',
    { body: { identifier: 'owner@hardwareerp.in', password: 'not-the-password' } });
  await expectStatus('unknown user is rejected the same way', 401, 'POST', '/api/auth/login/password',
    { body: { identifier: 'nobody@nowhere.example', password: 'whatever12345' } });
  await expectStatus('wrong PIN is rejected', 401, 'POST', '/api/auth/login/pin',
    { body: { phone: '9900000006', pin: '9999' } });
  await expectStatus('no token is 401', 401, 'GET', '/api/catalog/products');
  await expectStatus('forged token is 401', 401, 'GET', '/api/catalog/products',
    { token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });

  const me = await expectStatus('GET /api/auth/me', 200, 'GET', '/api/auth/me', { token: tokens.cashier });
  assert('cashier session is pinned to a branch', Boolean(me?.branch_id), me?.branch_name ?? '');

  section('Registration, OTP and password reset');
  const reg = await throttleAware('POST /api/auth/register', 'POST', '/api/auth/register',
    { body: { full_name: 'Smoke Test Applicant', phone: '9812345670', email: 'smoke@example.com',
              requested_role: 'CASHIER', password: 'Applicant@123' } });
  if (reg) assert('signup creates a pending request, not a live login', reg.status === 'PENDING');
  await expectStatus('signup cannot request OWNER_ADMIN', [400, 403, 429], 'POST', '/api/auth/register',
    { body: { full_name: 'Sneaky', phone: '9812345671', requested_role: 'OWNER_ADMIN', password: 'Sneaky@12345' } });
  const queue = await expectStatus('admin sees the signup queue', 200, 'GET', '/api/auth/registration-requests',
    { token: tokens.owner });
  if (reg) {
    assert('the new request is in the queue', Array.isArray(queue) && queue.some((r) => r.phone === '9812345670'));
  }
  await expectStatus('a manager cannot see the signup queue', 403, 'GET', '/api/auth/registration-requests',
    { token: tokens.manager1 });

  // 429 is a pass here: OTP issuance is deliberately capped at a few per five
  // minutes, so running this suite twice in a row is meant to be throttled.
  const otp = await throttleAware('POST /api/auth/otp/request', 'POST', '/api/auth/otp/request',
    { body: { phone: '9900000005' } });
  if (otp?.dev_otp) {
    await expectStatus('login with OTP', 200, 'POST', '/api/auth/login/otp',
      { body: { phone: '9900000005', otp: otp.dev_otp } });
    await expectStatus('the same OTP cannot be reused', 401, 'POST', '/api/auth/login/otp',
      { body: { phone: '9900000005', otp: otp.dev_otp } });
  }
  const unknownOtp = await throttleAware('OTP for an unknown number is answered the same way',
    'POST', '/api/auth/otp/request', { body: { phone: '9000000000' } });
  if (unknownOtp) assert('…but issues nothing (no user enumeration)', !unknownOtp.dev_otp);

  const forgot = await throttleAware('POST /api/auth/forgot', 'POST', '/api/auth/forgot',
    { body: { identifier: 'vikas@hardwareerp.in', kind: 'PASSWORD' } });
  if (forgot?.dev_reset_token) {
    await expectStatus('weak password is refused on reset', 400, 'POST', '/api/auth/reset',
      { body: { token: forgot.dev_reset_token, new_secret: 'short' } });
    await expectStatus('password reset succeeds', 200, 'POST', '/api/auth/reset',
      { body: { token: forgot.dev_reset_token, new_secret: 'Manager@12345' } });
    await expectStatus('a reset token is single-use', 400, 'POST', '/api/auth/reset',
      { body: { token: forgot.dev_reset_token, new_secret: 'Manager@12345' } });
    await login('manager2', '/api/auth/login/password',
      { identifier: 'vikas@hardwareerp.in', password: 'Manager@12345' });
  }

  // ── Row-level branch isolation (requirement 6) ────────────────────────────
  section('Branch isolation (Section 0 / requirement 6)');
  const b1Invoices = await call('GET', '/api/billing/invoices?limit=200', { token: tokens.manager1 });
  const b2Invoices = await call('GET', '/api/billing/invoices?limit=200', { token: tokens.manager2 });
  const allInvoices = await call('GET', '/api/billing/invoices?limit=200', { token: tokens.owner });

  const b1Branches = new Set((b1Invoices.body ?? []).map((i) => i.branch_id));
  const b2Branches = new Set((b2Invoices.body ?? []).map((i) => i.branch_id));
  const ownerBranches = new Set((allInvoices.body ?? []).map((i) => i.branch_id));

  assert('branch 1 manager sees exactly one branch', b1Branches.size === 1 && b1Branches.has(ids.branch1),
    [...b1Branches].join(','));
  assert('branch 2 manager sees exactly one branch', b2Branches.size === 1 && b2Branches.has(ids.branch2),
    [...b2Branches].join(','));
  assert('the two managers see different branches', ids.branch1 !== ids.branch2);
  assert('the owner sees more than one branch', ownerBranches.size > 1, `${ownerBranches.size} branches`);

  // The important one: asking for another branch explicitly must not work.
  const crossAttempt = await call('GET', `/api/billing/invoices?branch_id=${ids.branch2}&limit=50`,
    { token: tokens.manager1 });
  const leaked = (crossAttempt.body ?? []).filter((i) => i.branch_id === ids.branch2);
  assert('a branch user passing another branch_id gets nothing from it', leaked.length === 0,
    `${leaked.length} leaked rows`);

  const b1Stock = await call('GET', '/api/inventory/stock?limit=500', { token: tokens.inventory });
  const stockBranches = new Set((b1Stock.body ?? []).map((s) => s.branch_id));
  assert('inventory staff stock is single-branch', stockBranches.size <= 1, [...stockBranches].join(','));

  const b1Expenses = await call('GET', '/api/expenses?limit=200', { token: tokens.manager1 });
  const expBranches = new Set((b1Expenses.body ?? []).map((e) => e.branch_id));
  assert('expenses are branch-scoped too', expBranches.size <= 1);

  // ── Role matrix (Section 7.1) ────────────────────────────────────────────
  section('Role matrix (Section 7.1)');
  await expectStatus('cashier cannot open Admin settings', 403, 'GET', '/api/admin/settings', { token: tokens.cashier });
  await expectStatus('manager cannot open Admin settings', 403, 'GET', '/api/admin/settings', { token: tokens.manager1 });
  await expectStatus('owner can open Admin settings', 200, 'GET', '/api/admin/settings', { token: tokens.owner });
  await expectStatus('cashier cannot edit the catalog', 403, 'POST', '/api/catalog/products',
    { token: tokens.cashier, body: { sku: 'X', name: 'X', base_unit: 'PIECE', hsn_code: '7318', selling_price: 1 } });
  await expectStatus('inventory staff cannot bill', 403, 'GET', '/api/billing/invoices', { token: tokens.inventory });
  await expectStatus('cashier cannot see inventory', 403, 'GET', '/api/inventory/stock', { token: tokens.cashier });
  await expectStatus('accountant cannot bill', 403, 'GET', '/api/billing/invoices', { token: tokens.accountant });
  await expectStatus('accountant can see financial reports', 200, 'GET', '/api/reports/expense-vs-revenue', { token: tokens.accountant });
  await expectStatus('manager cannot run cross-branch lookup', 403, 'GET', '/api/inventory/stock/cross-branch', { token: tokens.manager1 });
  await expectStatus('owner can run cross-branch lookup', 200, 'GET', '/api/inventory/stock/cross-branch?limit=5', { token: tokens.owner });
  await expectStatus('manager cannot see chain comparison', 403, 'GET', '/api/reports/branch-comparison', { token: tokens.manager1 });
  await expectStatus('owner can see chain comparison', 200, 'GET', '/api/reports/branch-comparison', { token: tokens.owner });
  await expectStatus('cashier cannot set a credit limit', 403, 'PUT', '/api/customers/00000000-0000-0000-0000-000000000000/credit',
    { token: tokens.cashier, body: { credit_allowed: true, credit_limit: 999999 } });

  // ── Cost masking (2.6) ───────────────────────────────────────────────────
  section('Cost / margin field masking (2.6)');
  const ownerStock = await call('GET', '/api/inventory/stock?limit=5', { token: tokens.owner });
  const staffStock = await call('GET', '/api/inventory/stock?limit=5', { token: tokens.inventory });
  assert('owner sees weighted_avg_cost', 'weighted_avg_cost' in (ownerStock.body?.[0] ?? {}));
  assert('inventory staff does NOT see weighted_avg_cost', !('weighted_avg_cost' in (staffStock.body?.[0] ?? {})));
  assert('inventory staff does NOT see stock_value', !('stock_value' in (staffStock.body?.[0] ?? {})));
  await expectStatus('only the owner can open the margin report', 403, 'GET', '/api/catalog/margins', { token: tokens.manager1 });
  await expectStatus('owner can open the margin report', 200, 'GET', '/api/catalog/margins?limit=5', { token: tokens.owner });

  // ── Catalog ──────────────────────────────────────────────────────────────
  section('Catalog (Section 2)');
  const products = await expectStatus('GET /api/catalog/products', 200, 'GET', '/api/catalog/products?limit=10',
    { token: tokens.cashier });
  ids.product = products?.[0]?.product_id;
  assert('products come back with a price and a GST rate',
    products?.[0]?.selling_price != null && products?.[0]?.gst_rate_pct != null);

  const fuzzy = await call('GET', '/api/catalog/products?q=havels%20wire', { token: tokens.cashier });
  assert('fuzzy search survives a misspelling', (fuzzy.body ?? []).length > 0,
    `${(fuzzy.body ?? []).length} hits for "havels wire"`);

  await expectStatus('GET /api/catalog/categories', 200, 'GET', '/api/catalog/categories', { token: tokens.cashier });
  await expectStatus('GET /api/catalog/brands', 200, 'GET', '/api/catalog/brands', { token: tokens.cashier });
  await expectStatus('GET /api/catalog/hsn-rates', 200, 'GET', '/api/catalog/hsn-rates', { token: tokens.cashier });
  const detail = await expectStatus('GET /api/catalog/products/:id', 200, 'GET',
    `/api/catalog/products/${ids.product}`, { token: tokens.owner });
  assert('tax-rate history is returned (2.7)', Array.isArray(detail?.tax_rates) && detail.tax_rates.length > 0);
  assert('sale units are returned (2.2.1)', Array.isArray(detail?.units) && detail.units.length > 0);

  await expectStatus('a product with an unknown HSN is refused', 400, 'POST', '/api/catalog/products',
    { token: tokens.owner, body: { sku: `SMOKE-${Date.now()}`, name: 'Bad HSN', base_unit: 'PIECE',
                                   hsn_code: '999999', selling_price: 100 } });

  const created = await expectStatus('owner can create a product', 200, 'POST', '/api/catalog/products',
    { token: tokens.owner, body: { sku: `SMOKE-${Date.now()}`, name: 'Smoke Test Widget', base_unit: 'PIECE',
                                   hsn_code: '7318', selling_price: 100, mrp: 120,
                                   units: [{ unit_code: 'BOX', multiplier_to_base: 10 }] } });
  ids.newProduct = created?.product_id;

  // ── Billing (Section 3) ──────────────────────────────────────────────────
  section('Billing / POS (Section 3)');
  const till = await expectStatus('open a till session', 200, 'POST', '/api/billing/till-sessions',
    { token: tokens.cashier, body: { counter_id: `SMOKE-${Date.now()}`, opening_float: 2000 } });
  ids.till = till?.session_id;

  await expectStatus('a second till on the same counter is refused', 409, 'POST', '/api/billing/till-sessions',
    { token: tokens.cashier, body: { counter_id: till?.counter_id, opening_float: 1000 } });

  // Find something with stock at the cashier's branch to actually sell.
  const sellable = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.cashier })).body ?? [];
  const item = sellable.find((p) => Number(p.available_qty ?? 0) > 5 && Number(p.selling_price) > 0);
  assert('found an in-stock item to sell', Boolean(item), item?.name ?? 'none');

  if (item) {
    const rate = Number(item.selling_price);
    const gross = Number((rate * 2).toFixed(2));
    const inv = await expectStatus('create an invoice', 200, 'POST', '/api/billing/invoices', {
      token: tokens.cashier,
      body: {
        invoice_type: 'GST', till_session_id: ids.till,
        lines: [{ product_id: item.product_id, qty_in_sale_unit: 2, rate_locked_at_scan: rate,
                  price_type: 'TAX_INCLUSIVE' }],
        payments: [{ method: 'CASH', amount: gross }],
      },
    });
    ids.invoice = inv?.invoice_id;
    assert('invoice number was assigned on finalisation (3.6)', Boolean(inv?.invoice_number), inv?.invoice_number);
    assert('invoice number is branch + fiscal-year scoped',
      /^INV-[A-Z]{2,4}\/\d{4}-\d{2}\/\d{5}$/.test(inv?.invoice_number ?? ''), inv?.invoice_number);

    const t = inv?.totals;
    if (t) {
      // 3.1.1: the invoice tax must equal the SUM of already-rounded line taxes.
      const recomputed = Number((t.subtotal + t.cgst_total + t.sgst_total + t.igst_total).toFixed(2));
      assert('invoice total = subtotal + summed line taxes (3.1.1)',
        Math.abs(recomputed - t.grand_total) < 0.005, `${recomputed} vs ${t.grand_total}`);
      // Tax-inclusive: the customer pays the sticker price, tax extracted from it.
      assert('tax-inclusive pricing extracts GST rather than adding it (2.8)',
        Math.abs(t.grand_total - gross) < 0.05, `paid ${gross}, invoice ${t.grand_total}`);
    }

    // 3.5 idempotency
    const txn = crypto.randomUUID();
    const first = await call('POST', '/api/billing/invoices', {
      token: tokens.cashier,
      body: { invoice_type: 'GST', client_txn_id: txn, device_created_at: new Date().toISOString(),
              lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate, price_type: 'TAX_INCLUSIVE' }],
              payments: [{ method: 'UPI', amount: Number(rate.toFixed(2)) }] },
    });
    const replay = await call('POST', '/api/billing/invoices', {
      token: tokens.cashier,
      body: { invoice_type: 'GST', client_txn_id: txn, device_created_at: new Date().toISOString(),
              lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate, price_type: 'TAX_INCLUSIVE' }],
              payments: [{ method: 'UPI', amount: Number(rate.toFixed(2)) }] },
    });
    assert('an offline sale replayed with the same client_txn_id is not billed twice (3.5)',
      replay.body?.duplicate_of_client_txn === true && replay.body?.invoice_id === first.body?.invoice_id);

    // Payments must reconcile with the bill.
    await expectStatus('a bill whose payments do not add up is refused', 400, 'POST', '/api/billing/invoices', {
      token: tokens.cashier,
      body: { invoice_type: 'GST',
              lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate, price_type: 'TAX_INCLUSIVE' }],
              payments: [{ method: 'CASH', amount: 1 }] },
    });

    // 3.8 negative stock is blocked by default.
    // The stock check runs before payment reconciliation, so the error a cashier
    // sees is the useful one ("not enough stock") rather than a payment mismatch.
    await expectStatus('overselling is blocked when negative stock is off (3.8)', 409, 'POST', '/api/billing/invoices', {
      token: tokens.cashier,
      body: { invoice_type: 'GST',
              lines: [{ product_id: item.product_id, qty_in_sale_unit: 9_999_999, rate_locked_at_scan: rate, price_type: 'TAX_INCLUSIVE' }],
              payments: [{ method: 'CASH', amount: 1 }] },
    });

    // 3.4 discount ceiling
    await expectStatus('a discount above the staff limit needs approval (3.4)', 403, 'POST', '/api/billing/invoices', {
      token: tokens.cashier,
      body: { invoice_type: 'GST',
              lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate,
                        price_type: 'TAX_INCLUSIVE', discount_amount: Number((rate * 0.5).toFixed(2)) }],
              payments: [{ method: 'CASH', amount: Number((rate * 0.5).toFixed(2)) }] },
    });

    await expectStatus('GET an invoice', 200, 'GET', `/api/billing/invoices/${ids.invoice}`, { token: tokens.cashier });
    const pdf = await call('GET', `/api/billing/invoices/${ids.invoice}/pdf`, { token: tokens.cashier });
    assert('invoice PDF renders', pdf.status === 200, `${pdf.status}`);

    // A branch user must not be able to read another branch's invoice by id.
    const otherInvoice = (allInvoices.body ?? []).find((i) => i.branch_id === ids.branch2);
    if (otherInvoice) {
      await expectStatus('a manager cannot open another branch\'s invoice by id', 404, 'GET',
        `/api/billing/invoices/${otherInvoice.invoice_id}`, { token: tokens.manager1 });
    }
  }

  section('Till reconciliation (3.3.1)');
  await expectStatus('record a cash drop', 200, 'POST', `/api/billing/till-sessions/${ids.till}/events`,
    { token: tokens.manager1, body: { event_type: 'CASH_DROP', amount: 500, note: 'Owner pickup' } });
  const recon = await expectStatus('reconcile the till', 200, 'GET',
    `/api/billing/till-sessions/${ids.till}/reconcile`, { token: tokens.cashier });
  if (recon) {
    const expected = Number((recon.opening_float + recon.cash_sales - recon.cash_drops - recon.petty_expenses).toFixed(2));
    assert('expected drawer cash follows the 3.3.1 formula',
      Math.abs(expected - recon.expected_drawer_cash) < 0.01,
      `float ${recon.opening_float} + sales ${recon.cash_sales} - drops ${recon.cash_drops} - petty ${recon.petty_expenses} = ${recon.expected_drawer_cash}`);
    assert('a cash drop does not make the till look short',
      recon.cash_drops > 0 && recon.expected_drawer_cash < recon.opening_float + recon.cash_sales);
  }
  await expectStatus('a cashier cannot self-acknowledge a cash drop', 403, 'POST',
    `/api/billing/till-sessions/${ids.till}/events`,
    { token: tokens.cashier, body: { event_type: 'CASH_DROP', amount: 100 } });
  await expectStatus('close the till', 200, 'POST', `/api/billing/till-sessions/${ids.till}/close`,
    { token: tokens.cashier, body: { closing_counted_cash: recon?.expected_drawer_cash ?? 0 } });

  // ── Inventory ────────────────────────────────────────────────────────────
  section('Inventory & procurement (Section 4)');
  await expectStatus('GET stock', 200, 'GET', '/api/inventory/stock?limit=10', { token: tokens.inventory });
  await expectStatus('GET stock ledger', 200, 'GET', '/api/inventory/stock-ledger?limit=10', { token: tokens.inventory });
  await expectStatus('GET reorder suggestions', 200, 'GET', '/api/inventory/reorder-suggestions', { token: tokens.inventory });
  await expectStatus('GET dead stock', 200, 'GET', '/api/inventory/dead-stock?limit=10', { token: tokens.inventory });
  await expectStatus('GET batches', 200, 'GET', '/api/inventory/batches?limit=10', { token: tokens.inventory });
  await expectStatus('GET serials', 200, 'GET', '/api/inventory/serials?limit=10', { token: tokens.inventory });
  await expectStatus('GET transfers', 200, 'GET', '/api/inventory/transfers', { token: tokens.inventory });
  await expectStatus('GET purchase orders', 200, 'GET', '/api/inventory/purchase-orders', { token: tokens.inventory });
  await expectStatus('GET stock audits', 200, 'GET', '/api/inventory/stock-audits', { token: tokens.inventory });
  await expectStatus('GET write-offs', 200, 'GET', '/api/inventory/write-offs', { token: tokens.manager1 });
  await expectStatus('GET purchase returns', 200, 'GET', '/api/inventory/purchase-returns', { token: tokens.inventory });

  const vendors = (await call('GET', '/api/vendors', { token: tokens.manager1 })).body ?? [];
  ids.vendor = vendors[0]?.vendor_id;

  // Pick a plain (non-batch, non-serial) item with stock for the GRN and transfer
  // flows — batch-tracked goods legitimately refuse a receipt with no batch number,
  // which is a separate assertion below rather than something to work around here.
  const plain = ((await call('GET', '/api/catalog/products?limit=200', { token: tokens.inventory })).body ?? [])
    // Nothing reserved either: the stock audit below counts it down to 42, and a
    // seeded estimate hold larger than that would leave nothing to reserve in 5.1.
    .filter((p) => !p.batch_tracked && !p.serial_tracked && Number(p.available_qty ?? 0) > 30
      && Number(p.reserved_qty ?? 0) === 0)
    .sort((a, b) => Number(b.available_qty) - Number(a.available_qty))[0];
  ids.plainProduct = plain?.product_id;
  assert('found a plain in-stock item for procurement tests', Boolean(ids.plainProduct), plain?.name ?? 'none');

  // GRN → weighted average cost (4.8.1)
  if (ids.vendor && ids.plainProduct) {
    // 4.2 — a batch-tracked item cannot be received without its batch number.
    const batched = ((await call('GET', '/api/catalog/products?limit=100', { token: tokens.inventory })).body ?? [])
      .find((p) => p.batch_tracked);
    if (batched) {
      await expectStatus('a batch-tracked item cannot be received without a batch number (4.2)', 400, 'POST',
        '/api/inventory/grn', { token: tokens.inventory,
          body: { vendor_id: ids.vendor, lines: [{ product_id: batched.product_id, qty_base_unit: 10, rate: 100 }] } });
      await expectStatus('…and is accepted with one', 200, 'POST', '/api/inventory/grn',
        { token: tokens.inventory,
          body: { vendor_id: ids.vendor, lines: [{ product_id: batched.product_id, qty_base_unit: 10, rate: 100,
                                                   batch_number: `SMOKE-${Date.now()}`, expiry_date: '2028-01-01' }] } });
    }

    const before = ((await call('GET', `/api/inventory/stock?limit=500`, { token: tokens.owner })).body ?? [])
      .find((s) => s.product_id === ids.plainProduct && s.branch_id === ids.branch1);
    const grn = await expectStatus('create a GRN', 200, 'POST', '/api/inventory/grn', {
      token: tokens.inventory,
      body: { vendor_id: ids.vendor, lines: [{ product_id: ids.plainProduct, qty_base_unit: 100, rate: 999 }] },
    });
    ids.grn = grn?.grn_id;
    const after = ((await call('GET', `/api/inventory/stock?limit=500`, { token: tokens.owner })).body ?? [])
      .find((s) => s.product_id === ids.plainProduct && s.branch_id === ids.branch1);

    if (before && after) {
      const expectedCost = ((Number(before.base_unit_qty) * Number(before.weighted_avg_cost)) + 100 * 999)
                         / (Number(before.base_unit_qty) + 100);
      assert('weighted average cost recalculates on stock-in (4.8.1)',
        Math.abs(Number(after.weighted_avg_cost) - expectedCost) < 0.01,
        `expected ${expectedCost.toFixed(4)}, got ${after.weighted_avg_cost}`);
      assert('stock increased by the received quantity',
        Math.abs(Number(after.base_unit_qty) - Number(before.base_unit_qty) - 100) < 0.01);
    }

    // 4.5.1 purchase return must produce a vendor debit note
    const grnDetail = (await call('GET', `/api/inventory/grn/${ids.grn}`, { token: tokens.inventory })).body;
    const dn = await expectStatus('purchase return issues a vendor debit note (4.5.1)', 200, 'POST',
      '/api/inventory/purchase-returns', {
        token: tokens.inventory,
        body: { grn_id: ids.grn, reason: 'Damaged in transit',
                lines: [{ grn_line_id: grnDetail?.lines?.[0]?.grn_line_id, qty_base_unit: 10 }] },
      });
    // Own series, and the branch code in it: every *_number is unique chain-wide.
    assert('the debit note has its own number series', /^DN-[A-Z0-9]+\//.test(dn?.debit_note_number ?? ''), dn?.debit_note_number);
    await expectStatus('returning more than was received is refused', 400, 'POST', '/api/inventory/purchase-returns', {
      token: tokens.inventory,
      body: { grn_id: ids.grn, reason: 'Too much',
              lines: [{ grn_line_id: grnDetail?.lines?.[0]?.grn_line_id, qty_base_unit: 100000 }] },
    });
  }

  // 4.4 / 4.4.1 transfer with a discrepancy
  if (ids.branch1 && ids.branch2 && ids.plainProduct) {
    const transfer = await expectStatus('request a transfer', 200, 'POST', '/api/inventory/transfers', {
      token: tokens.inventory,
      body: { to_branch_id: ids.branch2, driver_ref: 'SMOKE-TRUCK-1',
              lines: [{ product_id: ids.plainProduct, dispatched_qty: 20 }] },
    });
    ids.transfer = transfer?.transfer_id;
    await expectStatus('dispatch it', 200, 'POST', `/api/inventory/transfers/${ids.transfer}/dispatch`,
      { token: tokens.inventory });
    await expectStatus('the sending branch cannot also receive it', [400, 403], 'POST',
      `/api/inventory/transfers/${ids.transfer}/receive`,
      { token: tokens.inventory, body: { lines: [] } });

    const asOwner = (await call('GET', `/api/inventory/transfers/${ids.transfer}`, { token: tokens.owner })).body;
    const recv = await expectStatus('receive it short', 200, 'POST',
      `/api/inventory/transfers/${ids.transfer}/receive`, {
        token: tokens.owner,
        body: { lines: [{ line_id: asOwner?.lines?.[0]?.line_id, received_qty: 17 }] },
      });
    assert('a short receipt raises TRANSFER_DISCREPANCY (4.4.1)', recv?.status === 'TRANSFER_DISCREPANCY', recv?.status);
    await expectStatus('a manager cannot adjudicate a discrepancy', 403, 'POST',
      `/api/inventory/transfers/${ids.transfer}/resolve`,
      { token: tokens.manager1, body: { resolution: 'WRITE_OFF', responsible_branch_id: ids.branch1 } });
    await expectStatus('the owner resolves it as a write-off', 200, 'POST',
      `/api/inventory/transfers/${ids.transfer}/resolve`,
      { token: tokens.owner, body: { resolution: 'WRITE_OFF', responsible_branch_id: ids.branch1 } });
  }

  // 4.6 stock audit
  const audit = await expectStatus('start a stock audit', 200, 'POST', '/api/inventory/stock-audits',
    { token: tokens.inventory, body: {} });
  if (audit && ids.plainProduct) {
    await expectStatus('complete it with a variance', 200, 'POST',
      `/api/inventory/stock-audits/${audit.audit_id}/complete`,
      { token: tokens.inventory, body: { counts: [{ product_id: ids.plainProduct, counted_qty: 42 }] } });
  }

  // ── Customers & credit ───────────────────────────────────────────────────
  section('Customers & credit (Section 6)');
  const custs = await expectStatus('GET customers', 200, 'GET', '/api/customers?limit=50', { token: tokens.cashier });
  // Pick one with no outstanding balance, so a later conversion test is not
  // tripped up by a fixture some earlier test left at its credit ceiling.
  ids.customer = (custs ?? []).find((c) => Number(c.balance_owed ?? 0) === 0)?.customer_id
    ?? custs?.[0]?.customer_id;
  await expectStatus('GET a customer', 200, 'GET', `/api/customers/${ids.customer}`, { token: tokens.cashier });
  await expectStatus('GET outstanding list', 200, 'GET', '/api/customers/outstanding/list', { token: tokens.manager1 });

  const dupPhone = `98${Date.now().toString().slice(-8)}`;
  const c1 = await expectStatus('create a customer', 200, 'POST', '/api/customers',
    { token: tokens.cashier, body: { phone: dupPhone, name: 'Smoke Test Customer' } });
  const c2 = await call('POST', '/api/customers', { token: tokens.cashier, body: { phone: dupPhone, name: 'Same Person Again' } });
  assert('the same phone returns the existing record, not a duplicate (Section 0)',
    c2.body?.already_existed === true && c2.body?.customer_id === c1?.customer_id);

  const cashierCredit = await call('POST', '/api/customers',
    { token: tokens.cashier, body: { phone: `97${Date.now().toString().slice(-8)}`, name: 'Credit Grab',
                                      credit_allowed: true, credit_limit: 500000 } });
  assert('a cashier cannot grant credit while creating a customer',
    cashierCredit.body?.credit_allowed === false, `credit_allowed=${cashierCredit.body?.credit_allowed}`);

  await expectStatus('owner sets a credit limit', 200, 'PUT', `/api/customers/${c1?.customer_id}/credit`,
    { token: tokens.owner, body: { credit_allowed: true, credit_limit: 1000 } });
  await expectStatus('a payment cannot exceed the balance owed', 400, 'POST',
    `/api/customers/${c1?.customer_id}/payments`,
    { token: tokens.cashier, body: { amount: 99999 } });
  await expectStatus('PII export is Owner-only', 403, 'GET', `/api/customers/${ids.customer}/export`,
    { token: tokens.manager1 });
  await expectStatus('owner can export PII', 200, 'GET', `/api/customers/${ids.customer}/export`,
    { token: tokens.owner });

  // ── Returns ──────────────────────────────────────────────────────────────
  section('Returns, credit notes & loyalty (Section 12 / 11.2.1)');
  if (ids.invoice) {
    const elig = await expectStatus('check return eligibility', 200, 'GET',
      `/api/returns/eligibility/${ids.invoice}`, { token: tokens.cashier });
    const line = elig?.lines?.[0];
    if (line?.returnable_qty > 0) {
      const ret = await expectStatus('process a partial return', 200, 'POST', '/api/returns', {
        token: tokens.cashier,
        body: { invoice_id: ids.invoice, return_reason: 'Smoke test return', refund_method: 'CASH',
                lines: [{ invoice_line_id: line.line_id, qty_base_unit: 1, condition: 'RESELLABLE' }] },
      });
      assert('a GST return issues a credit note (12.1.1)', Boolean(ret?.credit_note_number), ret?.credit_note_number);
      assert('the credit note has its own number series', /^CN-[A-Z0-9]+\//.test(ret?.credit_note_number ?? ''), ret?.credit_note_number);
      assert('refund hierarchy fields are reported (11.2.1)',
        ret && 'points_earned_reversed' in ret && 'points_redeemed_restored' in ret && 'cash_refund_amount' in ret);

      await expectStatus('returning more than was sold is refused', 400, 'POST', '/api/returns', {
        token: tokens.cashier,
        body: { invoice_id: ids.invoice, return_reason: 'Too much',
                lines: [{ invoice_line_id: line.line_id, qty_base_unit: 9999, condition: 'RESELLABLE' }] },
      });
    }
  }
  await expectStatus('GET returns', 200, 'GET', '/api/returns?limit=10', { token: tokens.manager1 });
  await expectStatus('GET credit notes', 200, 'GET', '/api/returns/credit-notes?limit=10', { token: tokens.accountant });
  await expectStatus('GET warranty claims', 200, 'GET', '/api/returns/warranty-claims?limit=10', { token: tokens.manager1 });

  // ── Quotations ───────────────────────────────────────────────────────────
  section('Quotations (Section 5)');
  const quotes = await expectStatus('GET quotations', 200, 'GET', '/api/quotations?limit=10', { token: tokens.manager1 });
  // Estimates are a counter task (spec §21): a cashier may raise and read them,
  // but approving one (the price agreement, and any stock hold) stays a manager's.
  await expectStatus('a cashier can see estimates', 200, 'GET', '/api/quotations', { token: tokens.cashier });
  await expectStatus('an inventory clerk cannot', 403, 'GET', '/api/quotations', { token: tokens.inventory });
  if (ids.customer && ids.plainProduct) {
    const q = await expectStatus('create a quotation', 200, 'POST', '/api/quotations', {
      token: tokens.manager1,
      body: { customer_id: ids.customer, lines: [{ product_id: ids.plainProduct, qty_base_unit: 5, rate: 90 }] },
    });
    ids.quotation = q?.quotation_id;
    assert('quotations default to tax-exclusive (2.8)', q?.price_type === 'TAX_EXCLUSIVE', q?.price_type);
    await expectStatus('approve it with a stock reservation (5.1)', 200, 'POST',
      `/api/quotations/${ids.quotation}/approve`,
      { token: tokens.manager1, body: { reserve_stock: true, hold_days: 3 } });
    const detail2 = await call('GET', `/api/quotations/${ids.quotation}`, { token: tokens.manager1 });
    assert('the quotation now holds stock', detail2.body?.stock_reserved === true);
    // Converting opens a DRAFT bill — nothing is billed, numbered or moved yet.
    const conv = await expectStatus('convert it to a draft bill', 200, 'POST', `/api/quotations/${ids.quotation}/convert`,
      { token: tokens.manager1 });
    assert('conversion opens a draft, not a finalised invoice', conv?.draft?.status === 'DRAFT' && !conv?.draft?.invoice_number,
      conv?.draft?.status);
    const again = await expectStatus('converting again returns the same draft', 200, 'POST',
      `/api/quotations/${ids.quotation}/convert`, { token: tokens.manager1 });
    assert('…so a double click cannot open two bills', again?.draft_invoice_id === conv?.draft_invoice_id);
    ids.quoteDraft = conv?.draft_invoice_id;
  }
  await expectStatus('GET challans', 200, 'GET', '/api/quotations/challans', { token: tokens.manager1 });

  // ── Expenses ─────────────────────────────────────────────────────────────
  section('Expenses (Section 9)');
  const cats = await expectStatus('GET expense categories', 200, 'GET', '/api/expenses/categories', { token: tokens.manager1 });
  const catId = cats?.[0]?.category_id;
  const small = await expectStatus('a small expense is auto-approved', 200, 'POST', '/api/expenses',
    { token: tokens.manager1, body: { category_id: catId, amount: 100, description: 'Smoke test small' } });
  assert('…and does not need approval', small?.requires_approval === false);
  const big = await expectStatus('a large expense needs approval', 200, 'POST', '/api/expenses',
    { token: tokens.manager1, body: { category_id: catId, amount: 50000, description: 'Smoke test large' } });
  assert('…and is flagged as such', big?.requires_approval === true);
  await expectStatus('you cannot approve your own expense', 403, 'POST', `/api/expenses/${big?.expense_id}/approve`,
    { token: tokens.manager1 });
  await expectStatus('the owner can approve it', 200, 'POST', `/api/expenses/${big?.expense_id}/approve`,
    { token: tokens.owner });
  await expectStatus('GET expense summary', 200, 'GET', '/api/expenses/summary', { token: tokens.accountant });

  // ── HR ───────────────────────────────────────────────────────────────────
  section('HR (Section 10)');
  await expectStatus('GET employees', 200, 'GET', '/api/hr/employees', { token: tokens.manager1 });
  await expectStatus('check in', 200, 'POST', '/api/hr/attendance/check-in', { token: tokens.cashier, body: {} });
  await expectStatus('check out', 200, 'POST', '/api/hr/attendance/check-out', { token: tokens.cashier, body: {} });
  await expectStatus('GET attendance', 200, 'GET', '/api/hr/attendance?limit=10', { token: tokens.manager1 });
  await expectStatus('request leave', 200, 'POST', '/api/hr/leave-requests',
    { token: tokens.cashier, body: { from_date: '2026-12-01', to_date: '2026-12-03' } });
  await expectStatus('GET leave requests', 200, 'GET', '/api/hr/leave-requests', { token: tokens.manager1 });
  await expectStatus('a cashier cannot approve leave', 403, 'POST',
    '/api/hr/leave-requests/00000000-0000-0000-0000-000000000000/decide',
    { token: tokens.cashier, body: { status: 'APPROVED' } });
  await expectStatus('GET shifts', 200, 'GET', '/api/hr/shifts', { token: tokens.manager1 });
  await expectStatus('GET performance', 200, 'GET', '/api/hr/performance', { token: tokens.manager1 });
  await expectStatus('payroll is off in Phase 1', 403, 'GET', '/api/hr/payroll', { token: tokens.owner });

  // ── CRM ──────────────────────────────────────────────────────────────────
  section('CRM & loyalty (Section 11)');
  await expectStatus('GET campaigns', 200, 'GET', '/api/crm/campaigns', { token: tokens.manager1 });
  await expectStatus('GET birthdays', 200, 'GET', '/api/crm/birthdays', { token: tokens.manager1 });
  await expectStatus('GET loyalty for a customer', 200, 'GET', `/api/crm/loyalty/${ids.customer}`, { token: tokens.cashier });
  await expectStatus('a manager cannot adjust points by hand', 403, 'POST', `/api/crm/loyalty/${ids.customer}/adjust`,
    { token: tokens.manager1, body: { points: 1000, reason: 'nope' } });
  await expectStatus('GET message queue', 200, 'GET', '/api/crm/messages?limit=10', { token: tokens.manager1 });
  await expectStatus('GET message stats', 200, 'GET', '/api/crm/messages/stats', { token: tokens.manager1 });

  // ── Vendors ──────────────────────────────────────────────────────────────
  section('Vendors (Section 8)');
  await expectStatus('GET vendors', 200, 'GET', '/api/vendors', { token: tokens.manager1 });
  await expectStatus('GET a vendor', 200, 'GET', `/api/vendors/${ids.vendor}`, { token: tokens.manager1 });
  await expectStatus('GET vendor ledger', 200, 'GET', `/api/vendors/${ids.vendor}/ledger`, { token: tokens.accountant });
  await expectStatus('GET payables', 200, 'GET', '/api/vendors/outstanding/list', { token: tokens.accountant });
  await expectStatus('vendor price analytics need cost visibility', 403, 'GET',
    `/api/vendors/${ids.vendor}/performance`, { token: tokens.manager1 });
  await expectStatus('owner sees vendor price analytics', 200, 'GET',
    `/api/vendors/${ids.vendor}/performance`, { token: tokens.owner });

  // ── Reports ──────────────────────────────────────────────────────────────
  section('Reports (Section 13 / 14)');
  await expectStatus('dashboard', 200, 'GET', '/api/reports/dashboard', { token: tokens.manager1 });
  await expectStatus('sales trend', 200, 'GET', '/api/reports/sales-trend?days=30', { token: tokens.manager1 });
  await expectStatus('category breakdown', 200, 'GET', '/api/reports/category-breakdown', { token: tokens.manager1 });
  await expectStatus('payment split', 200, 'GET', '/api/reports/payment-mode-split', { token: tokens.manager1 });
  await expectStatus('top products', 200, 'GET', '/api/reports/top-products', { token: tokens.manager1 });
  await expectStatus('slow moving', 200, 'GET', '/api/reports/slow-moving', { token: tokens.manager1 });
  await expectStatus('margin is cost-gated', 403, 'GET', '/api/reports/margin', { token: tokens.manager1 });
  await expectStatus('owner sees margin', 200, 'GET', '/api/reports/margin', { token: tokens.owner });
  await expectStatus('stock value is cost-gated', 403, 'GET', '/api/reports/stock-value', { token: tokens.manager1 });
  await expectStatus('attendance summary', 200, 'GET', '/api/reports/attendance-summary', { token: tokens.manager1 });
  await expectStatus('sales by employee', 200, 'GET', '/api/reports/sales-by-employee', { token: tokens.manager1 });
  await expectStatus('daily digest', 200, 'GET', '/api/reports/daily-digest', { token: tokens.manager1 });

  const gst = await expectStatus('GST summary', 200, 'GET', '/api/reports/gst-summary', { token: tokens.accountant });
  assert('GSTR-1 separates B2B from B2C',
    (gst?.outward_supplies ?? []).some((r) => r.supply_type === 'B2B' || r.supply_type === 'B2C'));
  assert('credit notes are reported separately', Array.isArray(gst?.credit_notes));
  assert('HSN summary is present (15 mandatory HSN)', (gst?.hsn_summary ?? []).length > 0);
  await expectStatus('a manager cannot pull GST returns data', 403, 'GET', '/api/reports/gst-summary', { token: tokens.manager1 });
  await expectStatus('ITC summary', 200, 'GET', '/api/reports/itc-summary', { token: tokens.accountant });
  await expectStatus('accounting export needs a date range', 400, 'GET', '/api/reports/accounting-export', { token: tokens.accountant });
  await expectStatus('accounting export (sales)', 200, 'GET',
    '/api/reports/accounting-export?kind=sales&from=2026-01-01&to=2026-12-31', { token: tokens.accountant });
  await expectStatus('accounting export (credit notes)', 200, 'GET',
    '/api/reports/accounting-export?kind=credit_notes&from=2026-01-01&to=2026-12-31', { token: tokens.accountant });

  // ── Admin ────────────────────────────────────────────────────────────────
  section('Admin control panel (Section 17)');
  const settings = await expectStatus('GET settings', 200, 'GET', '/api/admin/settings', { token: tokens.owner });
  assert('every documented setting is exposed', (settings ?? []).length >= 30, `${settings?.length} settings`);
  assert('settings carry labels, help and defaults for the UI',
    Boolean(settings?.[0]?.label && settings?.[0]?.help && 'default_value' in (settings?.[0] ?? {})));
  const numericSetting = (settings ?? []).find((s) => s.type === 'number');
  const selectSetting = (settings ?? []).find((s) => s.type === 'select');
  assert('numeric settings exist and are editable, not view-only', Boolean(numericSetting), numericSetting?.key);
  assert('select settings exist with their options', (selectSetting?.options ?? []).length > 0, selectSetting?.key);

  await expectStatus('write a boolean setting', 200, 'PUT', '/api/admin/settings/enable_bundles',
    { token: tokens.owner, body: { value: true } });
  await expectStatus('write a numeric setting', 200, 'PUT', '/api/admin/settings/return_window_days',
    { token: tokens.owner, body: { value: 10 } });
  await expectStatus('write a select setting', 200, 'PUT', '/api/admin/settings/refund_method',
    { token: tokens.owner, body: { value: 'ADMIN_CHOICE' } });
  await expectStatus('a wrongly-typed value is refused', 400, 'PUT', '/api/admin/settings/return_window_days',
    { token: tokens.owner, body: { value: 'ten' } });
  await expectStatus('an out-of-range value is refused', 400, 'PUT', '/api/admin/settings/staff_discount_limit_pct',
    { token: tokens.owner, body: { value: 900 } });
  await expectStatus('an unknown setting is refused', 400, 'PUT', '/api/admin/settings/not_a_setting',
    { token: tokens.owner, body: { value: 1 } });
  await expectStatus('a chain-wide setting cannot be branch-overridden', 400, 'PUT', '/api/admin/settings/valuation_method',
    { token: tokens.owner, body: { value: 'FIFO', branch_id: ids.branch1 } });
  await expectStatus('a per-branch setting can be overridden', 200, 'PUT', '/api/admin/settings/staff_discount_limit_pct',
    { token: tokens.owner, body: { value: 7, branch_id: ids.branch1 } });
  const eff = await expectStatus('effective settings are readable by staff', 200, 'GET',
    '/api/admin/settings/effective', { token: tokens.cashier });
  assert('the branch override wins over the chain value', Number(eff?.staff_discount_limit_pct) === 7,
    `staff_discount_limit_pct=${eff?.staff_discount_limit_pct}`);
  await expectStatus('remove the branch override', 200, 'DELETE',
    `/api/admin/settings/staff_discount_limit_pct?branch_id=${ids.branch1}`, { token: tokens.owner });
  await expectStatus('restore the return window', 200, 'PUT', '/api/admin/settings/return_window_days',
    { token: tokens.owner, body: { value: 7 } });

  const log = await expectStatus('GET audit log', 200, 'GET', '/api/admin/audit-log?limit=50', { token: tokens.owner });
  assert('the audit log recorded this run\'s sensitive actions', (log ?? []).length > 0, `${log?.length} entries`);
  assert('audit entries name who did it', Boolean(log?.[0]?.user_name));
  await expectStatus('a manager cannot read the audit log', 403, 'GET', '/api/admin/audit-log', { token: tokens.manager1 });
  await expectStatus('GET admin overview', 200, 'GET', '/api/admin/overview', { token: tokens.owner });
  await expectStatus('GET branches', 200, 'GET', '/api/admin/branches', { token: tokens.owner });
  const backups = await expectStatus('GET backups', 200, 'GET', '/api/admin/backups', { token: tokens.owner });
  assert('backup health reports whether a restore test is overdue (15)',
    backups && 'restore_test_overdue' in backups);
  await expectStatus('GET training journals', 200, 'GET', '/api/admin/training-journals', { token: tokens.cashier });
  await expectStatus('GET warranties', 200, 'GET', '/api/admin/warranties', { token: tokens.owner });

  // ── Input validation & injection ─────────────────────────────────────────
  section('Input validation');
  await expectStatus('a non-uuid path param is a clean 400', 400, 'GET', '/api/catalog/products/not-a-uuid',
    { token: tokens.owner });
  await expectStatus('SQL in a search box is treated as text', 200, 'GET',
    `/api/catalog/products?q=${encodeURIComponent("'; DROP TABLE products; --")}`, { token: tokens.cashier });
  const stillThere = await call('GET', '/api/catalog/products?limit=1', { token: tokens.cashier });
  assert('…and the products table still exists', (stillThere.body ?? []).length > 0);
  await expectStatus('a negative quantity is refused', 400, 'POST', '/api/billing/invoices',
    { token: tokens.cashier, body: { invoice_type: 'GST',
        lines: [{ product_id: ids.product, qty_in_sale_unit: -5, rate_locked_at_scan: 10, price_type: 'TAX_INCLUSIVE' }],
        payments: [{ method: 'CASH', amount: 1 }] } });
  await expectStatus('an empty invoice is refused', 400, 'POST', '/api/billing/invoices',
    { token: tokens.cashier, body: { invoice_type: 'GST', lines: [], payments: [] } });
  await expectStatus('an unknown endpoint is a clean 404', 404, 'GET', '/api/nope', { token: tokens.owner });


  // ── Security regressions ─────────────────────────────────────────────────
  // Each of these covers a specific hole found in review. They are worth more
  // than the happy-path checks above: a happy path breaks loudly, a hole does not.
  section('Security regressions');

  // A staff member must not be able to read verification codes or reset tokens
  // out of the outbound message log. This was a one-request path from the lowest
  // privileged account to an Owner password reset.
  {
    await call('POST', '/api/auth/forgot',
      { body: { identifier: 'owner@hardwareerp.in', kind: 'PASSWORD' } });
    await call('POST', '/api/auth/otp/request', { body: { phone: '9900000001' } });

    const asCashier = await call('GET', '/api/crm/messages?limit=200', { token: tokens.cashier });
    assert('a cashier cannot read the outbound message log at all', asCashier.status === 403,
      `got ${asCashier.status}`);

    const asManager = await call('GET', '/api/crm/messages?limit=200', { token: tokens.manager1 });
    const bodies = JSON.stringify(asManager.body ?? []);
    assert('no verification code appears in the message log', !/verification code is \d{6}/i.test(bodies));
    // Matched on the message SHAPE, not on a brand name: the business name is
    // configurable, so pinning the assertion to one would quietly stop testing
    // anything the moment a shop set its own.
    assert('no reset token appears in the message log',
      !/Reset your .{1,60}?(PIN|password) with this code/i.test(bodies));
    const types = new Set((asManager.body ?? []).map((m) => m.message_type));
    assert('the log carries no OTP-type messages at all', !types.has('OTP'),
      [...types].join(', ') || 'empty');
  }

  // A lowered line rate is a discount by another name; if it were not counted as
  // one, posting rate: 1 would bypass the staff discount ceiling with no trace.
  {
    const item = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.cashier })).body
      ?.find((p) => Number(p.available_qty ?? 0) > 5 && Number(p.selling_price) > 100);
    if (item) {
      const r = await call('POST', '/api/billing/invoices', {
        token: tokens.cashier,
        body: { invoice_type: 'GST',
          lines: [{ product_id: item.product_id, qty_in_sale_unit: 1,
                    rate_locked_at_scan: 1, price_type: 'TAX_INCLUSIVE' }],
          payments: [{ method: 'CASH', amount: 1 }] },
      });
      assert('selling far below the catalog price hits the discount ceiling', r.status === 403,
        `got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }

  // An override must be a single-use grant, not a manager's user id — a user id
  // never expires, so anyone who saw one could self-approve forever.
  {
    const managerId = (await call('GET', '/api/auth/users?limit=100', { token: tokens.owner })).body
      ?.find((u) => u.role === 'BRANCH_MANAGER')?.user_id;
    const item = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.cashier })).body
      ?.find((p) => Number(p.available_qty ?? 0) > 2);
    if (managerId && item) {
      const r = await call('POST', '/api/billing/invoices', {
        token: tokens.cashier,
        body: { invoice_type: 'GST',
          discount_approval_id: managerId,          // a real manager id, but not a grant
          negative_stock_approval_id: managerId,
          lines: [{ product_id: item.product_id, qty_in_sale_unit: 999999,
                    rate_locked_at_scan: Number(item.selling_price), price_type: 'TAX_INCLUSIVE' }],
          payments: [{ method: 'CASH', amount: 1 }] },
      });
      assert('a manager user id is not accepted as an override', r.status === 409 || r.status === 403,
        `got ${r.status}`);
    }

    const bad = await call('POST', '/api/auth/verify-override-pin',
      { token: tokens.cashier, body: { pin: '0000', purpose: 'DISCOUNT' } });
    assert('a wrong override PIN is refused', bad.status === 401 || bad.status === 429, `got ${bad.status}`);

    const good = await call('POST', '/api/auth/verify-override-pin',
      { token: tokens.cashier, body: { pin: '1111', purpose: 'DISCOUNT' } });
    if (good.status === 200) {
      assert('a correct override PIN returns a grant, not a user id',
        Boolean(good.body.approval_id) && !good.body.approver_id);
      ids.grant = good.body.approval_id;
    } else {
      // The lockout from the wrong guess above is itself the thing being tested.
      assert('repeated wrong override PINs lock the attempt out', good.status === 429, `got ${good.status}`);
    }
  }

  // The till's clock must not choose the invoice's fiscal-year series.
  {
    const item = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.cashier })).body
      ?.find((p) => Number(p.available_qty ?? 0) > 2 && Number(p.selling_price) > 0);
    if (item) {
      const rate = Number(item.selling_price);
      const r = await call('POST', '/api/billing/invoices', {
        token: tokens.cashier,
        body: { invoice_type: 'GST', client_txn_id: crypto.randomUUID(),
          device_created_at: '2019-06-01T10:00:00.000Z',       // a wildly wrong device clock
          lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate,
                    price_type: 'TAX_INCLUSIVE' }],
          payments: [{ method: 'CASH', amount: Number(rate.toFixed(2)) }] },
      });
      const fy = new Date().getMonth() >= 3
        ? `${new Date().getFullYear()}-${String((new Date().getFullYear() + 1) % 100).padStart(2, '0')}`
        : `${new Date().getFullYear() - 1}-${String(new Date().getFullYear() % 100).padStart(2, '0')}`;
      assert('a wrong device clock cannot draw a number from a closed year',
        r.status === 200 && String(r.body.invoice_number).includes(fy),
        `${r.status} ${r.body?.invoice_number}`);
      ids.voidable = r.body?.invoice_id;
    }
  }

  // Voiding must unwind the money, not only the stock.
  if (ids.voidable) {
    const r = await call('POST', `/api/billing/invoices/${ids.voidable}/void`,
      { token: tokens.manager1, body: { reason: 'Smoke test void' } });
    assert('voiding an invoice reports what it reversed', r.status === 200
      && 'credit_reversed' in (r.body ?? {}) && 'cash_reversed' in (r.body ?? {}),
      JSON.stringify(r.body).slice(0, 120));
  }

  // A salesperson tag must belong to this branch.
  {
    const otherBranchEmployee = (await call('GET',
      `/api/hr/employees?branch_id=${ids.branch2}`, { token: tokens.owner })).body?.[0]?.employee_id;
    const item = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.cashier })).body
      ?.find((p) => Number(p.available_qty ?? 0) > 2 && Number(p.selling_price) > 0);
    if (otherBranchEmployee && item) {
      const rate = Number(item.selling_price);
      const r = await call('POST', '/api/billing/invoices', {
        token: tokens.cashier,
        body: { invoice_type: 'GST', sold_by_employee_id: otherBranchEmployee,
          lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate,
                    price_type: 'TAX_INCLUSIVE' }],
          payments: [{ method: 'CASH', amount: Number(rate.toFixed(2)) }] },
      });
      assert('a sale cannot be credited to another branch\'s staff', r.status === 400, `got ${r.status}`);
    }
  }

  // A GST report that silently covers one branch is a compliance problem.
  {
    const asAccountant = await call('GET', '/api/reports/gst-summary', { token: tokens.accountant });
    const asOwner = await call('GET', '/api/reports/gst-summary', { token: tokens.owner });
    assert('a branch-scoped GST report says so', asAccountant.body?.scope === 'SINGLE_BRANCH',
      String(asAccountant.body?.scope));
    assert('the owner\'s GST report is marked chain-wide', asOwner.body?.scope === 'CHAIN_WIDE');
  }

  // Bulk import must apply the same "HSN needs a tax rate" gate as the form, or
  // imported products silently bill at 0% GST.
  {
    const r = await call('POST', '/api/catalog/products/bulk-import', {
      token: tokens.owner,
      body: { rows: [{ sku: `BULK-${Date.now()}`, name: 'Unknown HSN item',
                       base_unit: 'PIECE', hsn_code: '999999', selling_price: 100 }] },
    });
    assert('bulk import rejects a product whose HSN has no GST rate', r.status === 400, `got ${r.status}`);
    assert('and explains which row and why',
      JSON.stringify(r.body?.details ?? '').includes('999999'),
      JSON.stringify(r.body?.details ?? '').slice(0, 120));
  }

  // The offline sync endpoint must not pretend to accept invoices it discards.
  {
    const r = await call('POST', '/api/billing/sync/status',
      { token: tokens.cashier, body: { client_txn_ids: [crypto.randomUUID()] } });
    assert('sync status reports what the server actually has', r.status === 200
      && Array.isArray(r.body?.still_pending) && r.body.still_pending.length === 1);
  }

  // Setting someone else's PIN is a staff-management action.
  {
    const otherUser = (await call('GET', '/api/auth/users?limit=100', { token: tokens.owner })).body
      ?.find((u) => u.role === 'OWNER_ADMIN')?.user_id;
    if (otherUser) {
      const r = await call('POST', '/api/auth/set-pin',
        { token: tokens.cashier, body: { user_id: otherUser, pin: '9999' } });
      assert('a cashier cannot set the owner\'s PIN', r.status === 403, `got ${r.status}`);
    }
    const own = await call('POST', '/api/auth/set-pin', { token: tokens.cashier, body: { pin: '1234' } });
    assert('but can set their own', own.status === 200, `got ${own.status}`);
  }

  // Credit is chain-wide: a customer's balance must read the same from any branch.
  {
    const withBalance = (await call('GET', '/api/customers/outstanding/list?limit=5',
      { token: tokens.owner })).body?.[0];
    if (withBalance) {
      const a = await call('GET', `/api/customers/${withBalance.customer_id}`, { token: tokens.manager1 });
      const b = await call('GET', `/api/customers/${withBalance.customer_id}`, { token: tokens.manager2 });
      assert('a customer balance is the same from either branch',
        Number(a.body?.balance_owed) === Number(b.body?.balance_owed),
        `${a.body?.balance_owed} vs ${b.body?.balance_owed}`);
    }
  }

  // A quotation must be approved before it can become a tax invoice.
  {
    const draft = (await call('GET', '/api/quotations?status=DRAFT&limit=1', { token: tokens.manager1 })).body?.[0];
    if (draft) {
      const r = await call('POST', `/api/quotations/${draft.quotation_id}/convert`, { token: tokens.manager1 });
      // It becomes a DRAFT bill that still has to pass review, payment and the
      // discount ceiling — it is never converted straight into a tax invoice.
      assert('a quotation is never converted straight to a finalised invoice',
        r.status === 400 || (r.status === 200 && r.body?.draft?.status === 'DRAFT' && !r.body?.draft?.invoice_number), `got ${r.status}`);
    }
  }


  // ── Concurrency and worker liveness ──────────────────────────────────────
  section('Concurrency & background work');

  // A chain-wide credit limit is only meaningful if two branches cannot both
  // spend it. This fires two credit sales at the same customer simultaneously.
  {
    const cust = await call('POST', '/api/customers', {
      token: tokens.owner,
      body: { phone: `96${Date.now().toString().slice(-8)}`, name: 'Race Test Contractor' },
    });
    if (cust.body?.customer_id) {
      await call('PUT', `/api/customers/${cust.body.customer_id}/credit`,
        { token: tokens.owner, body: { credit_allowed: true, credit_limit: 1000 } });

      const item = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.cashier })).body
        ?.find((p) => Number(p.available_qty ?? 0) > 10 && Number(p.selling_price) > 0);

      if (item) {
        // Price the bill so that ONE fits inside the limit and TWO do not.
        const rate = Number(item.selling_price);
        const limit = Math.floor(rate * 1.5);
        await call('PUT', `/api/customers/${cust.body.customer_id}/credit`,
          { token: tokens.owner, body: { credit_allowed: true, credit_limit: limit } });

        const bill = () => call('POST', '/api/billing/invoices', {
          token: tokens.owner,
          body: { invoice_type: 'GST', customer_id: cust.body.customer_id, branch_id: ids.branch1,
            lines: [{ product_id: item.product_id, qty_in_sale_unit: 1, rate_locked_at_scan: rate,
                      price_type: 'TAX_INCLUSIVE' }],
            payments: [{ method: 'CREDIT', amount: Number(rate.toFixed(2)) }] },
        });

        const [a, b] = await Promise.all([bill(), bill()]);
        const okCount = [a, b].filter((r) => r.status === 200).length;
        assert('exactly one of two simultaneous credit sales goes through',
          okCount === 1,
          `${okCount} of 2 succeeded (${a.status}/${b.status}) — ${JSON.stringify(a.body).slice(0, 90)}`);

        const after = await call('GET', `/api/customers/${cust.body.customer_id}`, { token: tokens.owner });
        assert('and the balance never exceeds the limit',
          Number(after.body?.balance_owed) <= limit,
          `balance ${after.body?.balance_owed} against a ${limit} limit`);

        // Leave the fixture harmless: a customer wedged at their credit ceiling
        // would fail unrelated tests on the next run against the same database.
        await call('PUT', `/api/customers/${cust.body.customer_id}/credit`,
          { token: tokens.owner, body: { credit_allowed: false, credit_limit: 0 } });
      }
    }
  }

  // A manager override on a short-stock sale has to actually get past the
  // database trigger, not merely past the API's own check.
  {
    const grant = await call('POST', '/api/auth/verify-override-pin',
      { token: tokens.manager1, body: { pin: '1111', purpose: 'NEGATIVE_STOCK' } });
    const item = (await call('GET', '/api/catalog/products?limit=50', { token: tokens.manager1 })).body?.[0];
    if (grant.status === 200 && item) {
      const rate = Number(item.selling_price) || 100;
      const qty = Math.max(Number(item.available_qty ?? 0), 0) + 25;   // deliberately more than exists
      const r = await call('POST', '/api/billing/invoices', {
        token: tokens.manager1,
        body: { invoice_type: 'GST',
          negative_stock_approval_id: grant.body.approval_id,
          lines: [{ product_id: item.product_id, qty_in_sale_unit: qty, rate_locked_at_scan: rate,
                    price_type: 'TAX_INCLUSIVE' }],
          payments: [{ method: 'CASH', amount: Number((rate * qty).toFixed(2)) }] },
      });
      assert('an approved override actually sells into negative stock',
        r.status === 200, `${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`);
      assert('a grant is single-use', (await call('POST', '/api/billing/invoices', {
        token: tokens.manager1,
        body: { invoice_type: 'GST', negative_stock_approval_id: grant.body.approval_id,
          lines: [{ product_id: item.product_id, qty_in_sale_unit: qty, rate_locked_at_scan: rate,
                    price_type: 'TAX_INCLUSIVE' }],
          payments: [{ method: 'CASH', amount: Number((rate * qty).toFixed(2)) }] },
      })).status === 409);
    }
  }

  // The message queue worker runs without a request session; if it has no RLS
  // context its queries silently return nothing and nothing is ever delivered.
  {
    const before = await call('GET', '/api/crm/messages?status=QUEUED&limit=200', { token: tokens.manager1 });
    const queuedBefore = (before.body ?? []).length;
    // The worker ticks every 30s; give it one pass.
    await new Promise((res) => setTimeout(res, 32_000));
    const after = await call('GET', '/api/crm/messages?status=QUEUED&limit=200', { token: tokens.manager1 });
    const queuedAfter = (after.body ?? []).length;
    assert('the message queue worker actually drains the queue',
      queuedBefore === 0 || queuedAfter < queuedBefore,
      `${queuedBefore} queued -> ${queuedAfter}`);
  }

  // Payables are money, so inventory staff must not reach them even though they
  // legitimately need vendor names for a goods receipt.
  {
    await expectStatus('inventory staff can see vendor names', 200, 'GET', '/api/vendors',
      { token: tokens.inventory });
    await expectStatus('but not the payables ledger', 403, 'GET',
      `/api/vendors/${ids.vendor}/ledger`, { token: tokens.inventory });
    await expectStatus('nor the outstanding list', 403, 'GET', '/api/vendors/outstanding/list',
      { token: tokens.inventory });
    await expectStatus('an accountant can', 200, 'GET', '/api/vendors/outstanding/list',
      { token: tokens.accountant });
  }

  // ── Global search (Ctrl/Cmd+K) ───────────────────────────────────────────
  // Search reaches across every record type at once, which makes it the single
  // most likely place for a branch or a role boundary to be lost. These assert
  // the boundary from BOTH sides: the person who should find a record does, and
  // the person who should not, does not.
  section('Global search — scope and permissions');
  {
    const search = async (token, q, extra = '') =>
      (await call('GET', `/api/search?q=${encodeURIComponent(q)}${extra}`, { token })).body?.results ?? [];

    await expectStatus('search needs a session', 401, 'GET', '/api/search?q=INV');

    const ownerHits = await search(tokens.owner, 'INV');
    assert('an owner finds invoices chain-wide', ownerHits.some((r) => r.type === 'invoice'),
      `${ownerHits.length} hit(s)`);

    // Branch 2's invoice numbers carry its own prefix, so they make an exact probe.
    const mgr2Invoices = await search(tokens.manager2, 'INV');
    const prefix = mgr2Invoices.find((r) => r.type === 'invoice')?.title?.split('/')[0];
    if (prefix) {
      const own = await search(tokens.manager2, prefix);
      assert('a branch manager finds their own branch\'s bills by number',
        own.some((r) => r.type === 'invoice'), prefix);

      const other = await search(tokens.cashier, prefix);
      assert('another branch\'s cashier finds none of them',
        !other.some((r) => r.type === 'invoice'),
        `${other.filter((r) => r.type === 'invoice').length} leaked`);

      // The branch_id parameter is a filter for an admin, never a way for a branch
      // user to widen their own scope.
      const forced = await search(tokens.cashier, prefix, `&branch_id=${ids.branch2}`);
      assert('and cannot reach them by passing another branch_id',
        !forced.some((r) => r.type === 'invoice'),
        `${forced.filter((r) => r.type === 'invoice').length} leaked`);
    }

    // Result types follow the role matrix: a cashier has no vendor screen, so
    // vendors must not appear in their results either. The probe is a term the
    // owner demonstrably DOES get a vendor for, so a pass cannot come from the
    // query simply matching nothing.
    const vendorName = (await search(tokens.owner, 'a')).find((r) => r.type === 'vendor')?.title
      ?? (await call('GET', '/api/vendors?limit=1', { token: tokens.owner })).body?.[0]?.name;
    if (vendorName) {
      const probe = vendorName.slice(0, 6);
      const ownerSees = await search(tokens.owner, probe);
      assert('an owner finds a vendor by name', ownerSees.some((r) => r.type === 'vendor'), probe);
      const cashierSees = await search(tokens.cashier, probe);
      assert('a cashier gets no vendor rows for the same term',
        !cashierSees.some((r) => r.type === 'vendor'), probe);
    }

    const acctTypes = new Set((await search(tokens.accountant, 'INV')).map((r) => r.type));
    assert('an accountant sees no invoices in search results', !acctTypes.has('invoice'),
      [...acctTypes].join(', ') || 'no hits');

    // A one-character query would match most of the database for no benefit.
    const tooShort = await call('GET', '/api/search?q=a', { token: tokens.owner });
    assert('a single character returns nothing rather than everything',
      (tooShort.body?.results ?? []).length === 0);

    // A wildcard typed by a user is data, not syntax.
    const wild = await search(tokens.owner, '%%');
    assert('LIKE wildcards in the query do not match everything', wild.length === 0,
      `${wild.length} hit(s)`);

    const products = await search(tokens.cashier, 'pipe');
    assert('products are searchable by name', products.some((r) => r.type === 'product'));
  }

  section('Logout');
  await expectStatus('logout', 200, 'POST', '/api/auth/logout', { token: tokens.inventory });
  await expectStatus('the token stops working immediately', 401, 'GET', '/api/auth/me', { token: tokens.inventory });

  // ── Result ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`\x1b[1m${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped (rate limited)` : ''}\x1b[0m`);
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  • ${f}`));
    process.exit(1);
  }
  console.log('\x1b[32mAll checks passed.\x1b[0m');
}

main().catch((err) => { console.error(err); process.exit(1); });
