// ============================================================================
// The counter, driven like a cashier drives it — in a real browser.
//
//   typing        a search box keeps focus and every character while results
//                 arrive: a, as, asi, asia, asian — no click in between
//   keyboard      search → ↓ → Enter adds the item, focus comes back to search
//   undo          a removed line comes back with Undo
//   refresh       an unfinished bill survives a refresh and is offered back
//   double click  two clicks on Complete sale make ONE bill
//   offline       a sale made with the network down is queued, survives a server
//                 error (502) during upload, then uploads exactly once
//   refused       a queued sale the server refuses is shown, never discarded
//   dark mode     the main screens render without console errors
//
//   WEB_URL=http://localhost:3000 API_URL=http://localhost:4000 node tests/ui-audit.mjs
// ============================================================================
import { chromium } from 'playwright';
import pg from '../node_modules/pg/lib/index.js';
import { randomUUID } from 'node:crypto';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? null;

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail !== '' ? `  ${C.d}${String(detail).slice(0, 110)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 220)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
const consoleErrors = [];
async function freshPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_|status of (401|403|404|409|502)/i.test(m.text())) consoleErrors.push(m.text());
  });
  return { ctx, page };
}
async function login(page, email, password) {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="you@example.com"]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}
const searchBox = (page) => page.getByRole('combobox', { name: 'Search or scan an item' });
const activeLabel = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
const cartLines = (page) => page.locator('button[aria-label^="Remove "]').count();
const queue = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('erp_offline_bills') || '[]'));
async function addItem(page, text) {
  const box = searchBox(page);
  await box.click();
  await box.fill('');
  await page.keyboard.type(text, { delay: 30 });
  await page.getByRole('listbox').getByRole('option').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}
/** A plain counted item with plenty of stock at the manager's branch. */
const plainItem = await one(`
  SELECT p.name FROM products p
    JOIN product_units pu ON pu.product_id = p.product_id AND pu.is_default_sale_unit AND pu.multiplier_to_base = 1
    JOIN branch_stock bs ON bs.product_id = p.product_id
    JOIN users u ON u.branch_id = bs.branch_id AND u.email = 'sunita@hardwareerp.in'
   WHERE p.is_active AND NOT p.batch_tracked AND NOT p.serial_tracked AND p.base_unit = 'PIECE'
     AND bs.base_unit_qty - bs.reserved_qty > 50
   ORDER BY bs.base_unit_qty DESC LIMIT 1`);
const firstWord = plainItem.name.split(/\s+/)[0].toLowerCase();

try {
  const { ctx, page } = await freshPage();
  await login(page, 'sunita@hardwareerp.in', 'Manager@12345');
  await page.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.removeItem('erp_offline_bills'); localStorage.removeItem('erp_offline_refused');
    for (const k of Object.keys(localStorage)) if (k.startsWith('erp_pos_wip:')) localStorage.removeItem(k); });
  await page.reload({ waitUntil: 'networkidle' });

  // ── Typing ───────────────────────────────────────────────────────────────
  section('Typing fast into the item search, without clicking again');
  const box = searchBox(page);
  await box.click();
  let lostAt = null;
  const word = 'asian';
  for (let i = 0; i < word.length; i++) {
    await page.keyboard.type(word[i]);
    await page.waitForTimeout(i % 2 ? 15 : 120);      // results land between some keystrokes, not others
    const state = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), value: document.activeElement?.value }));
    if (state.label !== 'Search or scan an item' || state.value !== word.slice(0, i + 1)) { lostAt = `${word.slice(0, i + 1)} → ${JSON.stringify(state)}`; break; }
  }
  check('focus and every character survive a, as, asi, asia, asian', !lostAt, lostAt ?? '');
  await page.getByRole('listbox').getByRole('option').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const asianHit = await page.getByRole('listbox').getByRole('option').filter({ hasText: /asian/i }).count();
  check('…and the results match what was typed', asianHit > 0, `${asianHit} option(s)`);
  await page.keyboard.press('Escape');
  await box.fill('');

  // ── Keyboard ─────────────────────────────────────────────────────────────
  section('Keyboard only: type, arrow, Enter');
  await addItem(page, firstWord);
  check('↓ + Enter puts the item on the bill', await cartLines(page) === 1);
  check('…and focus is back in the search box for the next scan', await activeLabel(page) === 'Search or scan an item', await activeLabel(page));
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('/');
  check('"/" from anywhere jumps back to the search', await activeLabel(page) === 'Search or scan an item', await activeLabel(page));
  await addItem(page, firstWord);
  const lines2 = await cartLines(page);
  check('scanning the same item again does not lose the first line', lines2 >= 1, `${lines2} line(s)`);

  // ── Undo ─────────────────────────────────────────────────────────────────
  section('A line removed by mistake');
  const before = await cartLines(page);
  await page.locator('button[aria-label^="Remove "]').first().click();
  check('the line goes', await cartLines(page) === before - 1);
  await page.getByRole('button', { name: 'Undo' }).click();
  check('Undo brings it back', await cartLines(page) === before, `${await cartLines(page)} vs ${before}`);

  // ── Refresh ──────────────────────────────────────────────────────────────
  section('Refreshing in the middle of a bill');
  const linesBeforeReload = await cartLines(page);
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  const offer = page.getByText('Continue the bill you were making?');
  check('the unfinished bill is offered back', await offer.isVisible().catch(() => false));
  check('…and nothing was billed by the refresh', await cartLines(page) === 0);
  await page.getByRole('button', { name: 'Continue this bill' }).click();
  check('Continue restores every line', await cartLines(page) === linesBeforeReload, `${await cartLines(page)} vs ${linesBeforeReload}`);

  // ── Double click ─────────────────────────────────────────────────────────
  section('Two clicks on Complete sale');
  const mgr = await one(`SELECT user_id FROM users WHERE email = 'sunita@hardwareerp.in'`);
  const n0 = (await one(`SELECT count(*)::int AS n FROM invoices WHERE created_by = $1 AND status = 'FINAL'`, [mgr.user_id])).n;
  await page.getByRole('button', { name: /complete sale/i }).dblclick();
  await page.waitForTimeout(2500);
  const n1 = (await one(`SELECT count(*)::int AS n FROM invoices WHERE created_by = $1 AND status = 'FINAL'`, [mgr.user_id])).n;
  check('exactly one bill is made', n1 - n0 === 1, `${n1 - n0} bill(s)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  check('after a finished sale, no "continue the bill" is offered', !(await page.getByText('Continue the bill you were making?').isVisible().catch(() => false)));

  // ── Offline ──────────────────────────────────────────────────────────────
  section('The network goes down at the counter');
  await addItem(page, firstWord);
  await ctx.setOffline(true);
  await page.getByRole('button', { name: /complete sale/i }).click();
  await page.waitForTimeout(800);
  let q = await queue(page);
  check('the sale is queued in the browser', q.length === 1, `${q.length} queued`);
  check('…remembering the branch it was made at', q[0] && '_branch' in q[0]);
  const queuedTxn = q[0]?.client_txn_id;
  check('the bill is cleared for the next customer', await cartLines(page) === 0);
  // The connection comes back while the server is mid-restart.
  await page.route('**/api/billing/invoices', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Bad gateway"}' }) : route.continue());
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1500);
  q = await queue(page);
  check('a 502 during upload keeps the sale queued (it used to be deleted)', q.length === 1, `${q.length} queued`);
  check('…and nothing was recorded yet', !(await one(`SELECT 1 AS x FROM invoices WHERE client_txn_id = $1`, [queuedTxn])));
  await page.unroute('**/api/billing/invoices');
  await page.getByRole('button', { name: 'Try uploading now' }).click();
  await page.waitForTimeout(2500);
  q = await queue(page);
  check('the server back: the sale uploads and leaves the queue', q.length === 0, `${q.length} queued`);
  const uploaded = await one(`SELECT count(*)::int AS n FROM invoices WHERE client_txn_id = $1`, [queuedTxn]);
  check('…recorded exactly once', uploaded.n === 1, `${uploaded.n}`);

  // ── Refused ──────────────────────────────────────────────────────────────
  section('A queued sale the server refuses');
  await page.evaluate((txn) => {
    localStorage.setItem('erp_offline_bills', JSON.stringify([{
      invoice_type: 'GST', customer_id: '00000000-0000-4000-8000-000000000000', client_txn_id: txn,
      lines: [], payments: [{ method: 'CASH', amount: 1 }], device_created_at: new Date().toISOString(),
      _branch: null, _summary: 'Test customer · 1 item(s) · ₹1.00', _queued_at: new Date().toISOString() }]));
  }, randomUUID());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const refused = await page.evaluate(() => JSON.parse(localStorage.getItem('erp_offline_refused') || '[]'));
  check('it is kept in a refused list, not thrown away', refused.length === 1, `${refused.length}`);
  check('…and the cashier is told to bill it again', await page.getByText(/were refused — bill them again/).isVisible().catch(() => false));
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Billed again — remove' }).click();
  await page.waitForTimeout(300);
  check('once re-billed, it can be cleared', (await page.evaluate(() => JSON.parse(localStorage.getItem('erp_offline_refused') || '[]'))).length === 0);

  // ── Global search ────────────────────────────────────────────────────────
  section('Ctrl+K search, typed fast');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Search BHAWANI ONE' }).waitFor();
  await page.keyboard.type('putty', { delay: 25 });
  await page.waitForTimeout(700);
  const pal = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), value: document.activeElement?.value }));
  check('the palette keeps focus and the whole word', pal.label === 'Search' && pal.value === 'putty', JSON.stringify(pal));
  await page.keyboard.press('Escape');
  await ctx.close();

  // ── Dark mode ────────────────────────────────────────────────────────────
  section('Dark mode, main screens');
  // Light is the deliberate first-visit default; dark is what the theme button
  // stores. Set it the way the button does.
  const dark = await freshPage({ colorScheme: 'dark' });
  await dark.ctx.addInitScript(() => { try { localStorage.setItem('erp_theme', 'dark'); } catch { /* ignore */ } });
  await login(dark.page, 'owner@hardwareerp.in', 'Owner@12345');
  const before2 = consoleErrors.length;
  for (const path of ['/', '/billing', '/catalog', '/inventory', '/customers', '/vendors', '/reports', '/admin', '/hr', '/expenses']) {
    await dark.page.goto(WEB + path, { waitUntil: 'networkidle' });
  }
  const bg = await dark.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('the page background is dark', /rgb\((\d+), (\d+), (\d+)\)/.test(bg) && bg.match(/\d+/g).slice(0, 3).every((n) => Number(n) < 80), bg);
  check('no console errors across ten screens', consoleErrors.length === before2, consoleErrors.slice(before2).join(' | '));
  await dark.ctx.close();
} catch (err) {
  failures.push(`suite crashed: ${err.stack ?? err}`);
  console.log(`${C.r}suite crashed:${C.x}`, err);
} finally {
  await browser.close();
  await db.end();
}

check('no page errors anywhere in the run', consoleErrors.length === 0, consoleErrors.join(' | '));
console.log(`\n${'─'.repeat(70)}\n${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) {
  console.log(`${C.r}Failures:${C.x}`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`${C.g}The counter holds up to fast typing, refreshes, double clicks and outages.${C.x}`);
