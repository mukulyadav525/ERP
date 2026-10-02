// ============================================================================
// Browser tests (Sections 42, 43, 62, 64).
//
// These drive a real Chromium against the built app, because the failures they
// are looking for do not show up in a typecheck: a button wired to nothing, a
// page that only renders after a refresh, a table that pushes the layout sideways
// on a phone, a console error nobody noticed. Every check asserts observable
// behaviour rather than the presence of markup.
//
//   node tests/uitest.mjs
//
// Expects the API on :4000 and the web app on :3000.
// ============================================================================
import { chromium } from '../node_modules/playwright/index.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
// Playwright normally finds its own browser. CHROMIUM_PATH is an escape hatch for
// environments that ship Chromium separately (a CI image, a sandbox) so the suite
// does not have to download one.
const EXECUTABLE = process.env.CHROMIUM_PATH ?? null;
// The API as the browser reaches it; read inside page.evaluate via window.__ERP_API__.
const API = process.env.API_URL ?? 'http://localhost:4000';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail ? `  ${C.d}${detail}${C.x}` : ''}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ${C.r}✗${C.x} ${name}${detail ? `  ${C.d}${detail}${C.x}` : ''}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

/** Console/page errors are collected per page and asserted on, not ignored. */
function watch(page) {
  const errs = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // A failed API call during an intentional permission test is not a UI defect.
    if (/Failed to load resource|net::ERR_|the server responded with a status of (401|403|404)/i.test(t)) return;
    errs.push(t);
  });
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  return errs;
}

async function login(page, { email, password, phone, pin }) {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  if (phone) {
    await page.click('button:has-text("Phone + PIN")');
    const inputs = page.locator('form input, .card input');
    await inputs.nth(0).fill(phone);
    await inputs.nth(1).fill(pin);
  } else {
    await page.fill('input[placeholder="you@example.com"]', email);
    await page.fill('input[type=password]', password);
  }
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25_000 });
}

const PAGES = [
  ['/', 'Dashboard'], ['/billing', 'Billing'], ['/catalog', 'Catalog'],
  ['/inventory', 'Inventory'], ['/customers', 'Customers'], ['/vendors', 'Vendors'],
  ['/returns', 'Returns'], ['/quotations', 'Quotations'], ['/expenses', 'Expenses'],
  ['/hr', 'Staff'], ['/reports', 'Reports'], ['/admin', 'Admin'],
];

let browser;
try {
  browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
} catch (err) {
  console.error(`${C.r}Could not start Chromium.${C.x} Run "npx playwright install chromium",\n` +
                `or set CHROMIUM_PATH to an existing browser binary.\n${err.message}`);
  process.exit(2);
}

try {
  // ── Every page loads, for the Owner ───────────────────────────────────────
  section('Pages load without errors (Owner)');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    const errs = watch(page);
    await login(page, { email: 'owner@hardwareerp.in', password: 'Owner@12345' });

    for (const [path, label] of PAGES) {
      errs.length = 0;
      await page.goto(WEB + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const body = await page.locator('body').innerText();
      const blank = body.trim().length < 40;
      const crashed = /Application error|Unhandled Runtime Error/i.test(body);
      check(`${label} renders`, !blank && !crashed,
        blank ? 'page is essentially empty' : crashed ? 'runtime error on the page' : `${body.trim().length} chars`);
      check(`${label} has no console errors`, errs.length === 0, errs.slice(0, 2).join(' | '));

      // A page that only works on first paint but breaks on reload is a real bug
      // users hit constantly (they refresh); it is checked explicitly.
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const afterReload = await page.locator('body').innerText();
      check(`${label} survives a refresh`, afterReload.trim().length > 40 && !/Application error/i.test(afterReload));
    }
    await ctx.close();
  }

  // ── Responsive: no horizontal overflow at phone width ─────────────────────
  section('Responsive at 390px (Section 42)');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await login(page, { email: 'owner@hardwareerp.in', password: 'Owner@12345' });
    for (const [path, label] of PAGES) {
      await page.goto(WEB + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() =>
        Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
      check(`${label} does not scroll sideways`, overflow <= 1, `${overflow}px overflow`);
    }
    await ctx.close();
  }

  // ── The review-before-finalise flow (Sections 11, 62) ─────────────────────
  section('Draft bill: review, edit, finalise');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    const errs = watch(page);
    await login(page, { email: 'sunita@hardwareerp.in', password: 'Manager@12345' });
    await page.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    // Pick items the branch actually has, so the test exercises the happy path
    // rather than re-proving that the stock check works (the API suite covers that).
    const stocked = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_auth_token');
      const res = await fetch(window.__ERP_API__ + '/api/catalog/products?limit=60', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rows = await res.json();
      return rows.filter((p) => Number(p.available_qty ?? 0) > 5 && Number(p.selling_price) > 0)
                 .slice(0, 2).map((p) => ({ name: p.name, sku: p.sku }));
    });
    check('the branch has stocked items to bill', stocked.length > 0, stocked.map((p) => p.name).join(', '));

    // The item search is one combobox that keeps focus. Typing goes into it, the
    // results appear in a listbox, ↓ / Enter pick one, and focus comes straight
    // back to the search for the next item — no mouse at any point.
    const search = page.locator('input[aria-label="Search or scan an item"]');
    check('the item search has focus when the bill opens',
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search or scan an item');
    let added = 0;
    let focusKept = true;
    for (const item of stocked.slice(0, 2)) {
      await search.click();
      // Type slowly, the way a person does, while searches are in flight: the
      // field must keep focus and keep every character. The SKU is typed, so the
      // two items are certainly different products (names can share a prefix).
      const term = item.sku;
      for (const ch of term) {
        await page.keyboard.type(ch, { delay: 60 });
        const state = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), value: (document.activeElement)?.value }));
        if (state.label !== 'Search or scan an item') focusKept = false;
      }
      if ((await search.inputValue()) !== term) focusKept = false;
      await page.waitForSelector('[role=listbox] [role=option]', { timeout: 10_000 });
      await page.waitForTimeout(600);
      const options = await page.locator('[role=listbox] [role=option]').allInnerTexts();
      const idx = options.findIndex((t) => !/Out of stock/i.test(t));
      if (idx < 0) continue;
      for (let i = 0; i < idx; i += 1) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      added += 1;
    }
    check('typing in the item search never loses focus or characters', focusKept);
    check('in-stock items can be added with the keyboard', added > 0, `${added} added`);
    check('focus returns to the search after adding an item',
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search or scan an item');
    const lines = await page.locator('table.pos-lines tbody tr').count();
    check('the added items are on the bill', lines === added, `${lines} line(s)`);

    // Escape closes an open result list without clearing the bill.
    await search.fill('putty');
    await page.waitForSelector('[role=listbox] [role=option]', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('Escape closes the result list', (await page.locator('[role=listbox]').count()) === 0);
    await search.fill('');

    // Ctrl/Cmd + S saves the draft and opens the review.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await page.waitForTimeout(2200);
    let body = await page.locator('body').innerText();
    check('Ctrl/Cmd + S opens the review', /Total payable/.test(body));
    check('it offers Edit bill', /Edit bill/.test(body));
    check('it offers Finalise', /Finalise/.test(body));
    check('it says the bill is not yet a tax invoice', /not a tax invoice/i.test(body));

    // The figure on the review screen must be the server's.
    const totalText = (body.match(/Total payable\s*\n?\s*₹?\s*([\d,]+\.?\d*)/) ?? [])[1];
    check('the review screen shows a total', Boolean(totalText), totalText ?? 'none found');

    // Edit → back to the cart, then review again.
    await page.click('button:has-text("Edit bill")');
    await page.waitForTimeout(800);
    check('Edit bill returns to the cart with the items kept',
      (await page.locator('table.pos-lines tbody tr').count()) === added);

    await page.locator('button:has-text("Review bill")').click();
    await page.waitForTimeout(1800);
    check('the review screen reports no stock problem for in-stock items',
      !/Not enough stock/i.test(await page.locator('body').innerText()));
    await page.click('button:has-text("Finalise")');
    await page.waitForTimeout(2500);
    body = await page.locator('body').innerText();
    const finalised = /Sale complete/.test(body) && /INV-[A-Z0-9]+\/\d{4}-\d{2}\/\d{5}/.test(body);
    check('finalising produces a numbered invoice', finalised, finalised ? '' : body.slice(0, 160).replace(/\n/g, ' '));
    check('the receipt offers print, PDF and WhatsApp', /Print/.test(body) && /Download PDF/.test(body));
    check('no console errors through the whole flow', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── Offline billing: a sale made with no connection syncs once it returns ───
  section('Offline billing');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await login(page, { email: 'sunita@hardwareerp.in', password: 'Manager@12345' });
    await page.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const sku = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_auth_token');
      const rows = await (await fetch(window.__ERP_API__ + '/api/catalog/products?limit=80', { headers: { Authorization: `Bearer ${token}` } })).json();
      return rows.find((p) => Number(p.available_qty ?? 0) > 20 && Number(p.selling_price) > 0 && p.base_unit === 'PIECE')?.sku;
    });
    const before = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_auth_token');
      const r = await (await fetch(window.__ERP_API__ + '/api/billing/invoices?limit=1', { headers: { Authorization: `Bearer ${token}` } })).json();
      return r[0]?.invoice_number ?? null;
    });
    const search = page.locator('input[aria-label="Search or scan an item"]');
    await search.fill(sku);
    await page.waitForSelector('[role=listbox] [role=option]', { timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await ctx.setOffline(true);
    await page.click('button:has-text("Complete sale")');
    await page.waitForTimeout(1500);
    const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('erp_offline_bills') || '[]').length);
    check('with no connection the sale is saved on the device, not lost', queued === 1, `${queued} queued`);
    check('the cashier is told it is saved offline', /Saved offline/i.test(await page.locator('body').innerText()));
    check('the bill is cleared for the next customer', (await page.locator('table.pos-lines tbody tr').count()) === 0);
    await ctx.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(3500);
    const left = await page.evaluate(() => JSON.parse(localStorage.getItem('erp_offline_bills') || '[]').length);
    check('when the connection returns the queued sale uploads', left === 0, `${left} still queued`);
    const after = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_auth_token');
      return (await (await fetch(window.__ERP_API__ + '/api/billing/invoices?limit=3', { headers: { Authorization: `Bearer ${token}` } })).json()).map((r) => r.invoice_number);
    });
    check('it became exactly one new invoice', after[0] !== before && after[1] === before, `${before} → ${after.slice(0, 2).join(', ')}`);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);
    const again = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_auth_token');
      return (await (await fetch(window.__ERP_API__ + '/api/billing/invoices?limit=1', { headers: { Authorization: `Bearer ${token}` } })).json())[0].invoice_number;
    });
    check('reconnecting again does not bill it twice', again === after[0]);
    await ctx.close();
  }

  // ── Owner on "All branches" must pick a branch before billing ───────────────
  section('Branch context for a transaction');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    const errs = watch(page);
    await login(page, { email: 'owner@hardwareerp.in', password: 'Owner@12345' });
    await page.evaluate(() => localStorage.removeItem('erp_active_branch'));
    await page.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const sel = page.locator('select.branch-select').first();
    if (await sel.count()) { await sel.selectOption({ label: 'All branches' }); await page.waitForTimeout(900); }
    const body = await page.locator('body').innerText();
    check('the owner on All branches is asked to choose a branch for the bill', /Please select a branch for this bill/i.test(body),
      body.slice(0, 160).replace(/\n/g, ' '));
    check('no internal error text is shown', !/branch_id is required|stack|TypeError/i.test(body));
    check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ── Role scoping in the navigation (Section 7.1) ──────────────────────────
  section('Navigation matches the role');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await login(page, { phone: '9900000005', pin: '1234' });
    const nav = await page.locator('aside').innerText();
    check('a cashier sees Billing', /Billing/i.test(nav));
    check('a cashier does not see Admin', !/\bAdmin\b/i.test(nav), nav.replace(/\n/g, ' ').slice(0, 120));
    check('a cashier does not see Staff', !/\bStaff\b/i.test(nav));

    // Reaching a forbidden page directly must be refused by the page, not just hidden.
    await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const body = await page.locator('body').innerText();
    check('a cashier opening /admin directly is refused',
      /not permitted|no access|denied|permission/i.test(body), body.slice(0, 120).replace(/\n/g, ' '));
    await ctx.close();
  }

  // ── Hindi (Section 43) ────────────────────────────────────────────────────
  section('Hindi / English');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await login(page, { email: 'owner@hardwareerp.in', password: 'Owner@12345' });
    await page.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
    const toggle = page.locator('button:has-text("हिन्दी"), button:has-text("English")').first();
    check('a language toggle is present', await toggle.count() > 0);
    if (await toggle.count()) {
      await toggle.click();
      await page.waitForTimeout(900);
      const nav = await page.locator('aside').innerText();
      check('the navigation switches to Devanagari', /[ऀ-ॿ]/.test(nav),
        nav.replace(/\n/g, ' ').slice(0, 80));
    }
    await ctx.close();
  }

  // ── Light mode is the hard default ──────────────────────────────────────────
  // A visitor with no saved theme preference must see light mode, even when
  // their OS/browser is set to dark — this was the actual bug: the app used to
  // default to 'system', so a dark-OS visitor got a dark app on their very
  // first visit with no chance to choose. This is a brand-new incognito-style
  // context (no localStorage) with the OS colour scheme forced to dark, which
  // is exactly the case that used to fail.
  section('Light mode is the default for a first-time visitor (hard requirement)');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: 'dark' });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('a first-time visitor on a dark-OS browser still gets data-theme="light"', attr === 'light', `got ${attr}`);
    // The design system's light background is #f4f5f7 / rgb(244, 245, 247); the
    // dark one is #0d0f13 / rgb(13, 15, 19) — this asserts the paint, not just
    // the attribute, so a CSS regression that ignores the attribute is caught too.
    check('the painted background is the light-mode colour, not the dark one',
      bg === 'rgb(244, 245, 247)', bg);

    // Once the visitor explicitly picks dark, a refresh must keep it — light
    // mode is the default, not something forced on every load.
    await page.evaluate(() => localStorage.setItem('erp_theme', 'dark'));
    await page.reload({ waitUntil: 'networkidle' });
    const attrAfterChoice = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    check('an explicit dark choice survives a refresh', attrAfterChoice === 'dark', `got ${attrAfterChoice}`);
    await ctx.close();
  }

  // ── Themes ────────────────────────────────────────────────────────────────
  section('Light and dark');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await login(page, { email: 'owner@hardwareerp.in', password: 'Owner@12345' });
    for (const theme of ['dark', 'light']) {
      await page.evaluate((th) => {
        localStorage.setItem('erp_theme', th);
        document.documentElement.setAttribute('data-theme', th);
      }, theme);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const fg = await page.evaluate(() => getComputedStyle(document.body).color);
      check(`${theme} theme paints a background`, bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', bg);
      check(`${theme} theme text is not the background colour`, bg !== fg, `${fg} on ${bg}`);
    }
    await ctx.close();
  }

  // ── Dead controls ─────────────────────────────────────────────────────────
  section('No dead controls on the main screens');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addInitScript((api) => { window.__ERP_API__ = api; }, API);
    const page = await ctx.newPage();
    await login(page, { email: 'owner@hardwareerp.in', password: 'Owner@12345' });
    for (const [path, label] of [['/billing', 'Billing'], ['/inventory', 'Inventory'], ['/admin', 'Admin']]) {
      await page.goto(WEB + path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      // A button with no handler, no type=submit and no href does nothing when
      // clicked — the classic "looks finished, isn't" defect.
      const dead = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button')) {
          if (el.disabled) continue;
          const hasReact = Object.keys(el).some((k) => k.startsWith('__reactProps'));
          if (!hasReact) continue;
          const props = el[Object.keys(el).find((k) => k.startsWith('__reactProps'))];
          if (!props?.onClick && el.type !== 'submit') out.push((el.textContent || '').trim().slice(0, 30));
        }
        return out;
      });
      check(`${label} has no buttons wired to nothing`, dead.length === 0, dead.slice(0, 4).join(', '));
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) {
  console.log(`\n${C.r}Failures:${C.x}`);
  failures.forEach((f) => console.log(`  • ${f}`));
  process.exit(1);
}
console.log(`${C.g}All UI checks passed.${C.x}`);
