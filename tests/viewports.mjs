// ============================================================================
// Responsive sweep — every major route at every supported width, in both themes.
//
// The assertion that matters is `documentElement.scrollWidth <=
// clientWidth + 1`: if the page itself scrolls sideways, something is wider than
// the screen and the user has to drag the whole app around to read it. A table
// that scrolls inside its own container is fine and expected; the page must not.
//
// It also names the widest offending element, because "overflow at 320px" is not
// actionable and "the invoice table at 320px" is.
//
//   node tests/viewports.mjs
// Expects the API on :4000 and the web app on :3000.
// ============================================================================
import { chromium } from '../node_modules/playwright/index.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const EXECUTABLE = process.env.CHROMIUM_PATH ?? undefined;

const WIDTHS = [320, 375, 390, 414, 480, 768, 820, 1024, 1280, 1440, 1920, 2560];
const ROUTES = ['/', '/billing', '/catalog', '/inventory', '/customers', '/vendors',
                '/quotations', '/returns', '/expenses', '/hr', '/reports', '/admin'];

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0; const failures = [];
const ok = (n, d = '') => { passed++; console.log(`  ${C.g}✓${C.x} ${n}${d ? `  ${C.d}${d}${C.x}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ${C.r}✗${C.x} ${n}  ${C.d}${d}${C.x}`); };

/** The page's own horizontal overflow, plus whatever is causing it. */
/**
 * What this measures, and why it is two things rather than one.
 *
 *  · `over` — the page's own horizontal scroll. If the document is wider than the
 *    window, the user drags the whole application sideways to read it.
 *  · `clipped` — controls sitting outside the window that produce NO page
 *    overflow, because an ancestor with `overflow: hidden` swallowed them. This
 *    is the failure a scrollWidth check alone cannot see, and it is worse than
 *    overflow: the control is not merely awkward to reach, it is invisible. It is
 *    exactly how the counter screen hid its own scan box on a phone.
 *
 * Anything inside a deliberately scrollable container (a wide data table, a tab
 * strip) is excluded from both — that scrolling is the intended solution, not a
 * defect.
 */
const MEASURE = `(() => {
  const de = document.documentElement;
  const scrollable = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  // The mobile navigation drawer lives off-screen by design when closed.
  const offstage = (el) => Boolean(el.closest('.sidebar')) && !el.closest('.sidebar.open');

  const over = de.scrollWidth - de.clientWidth;
  let culprit = null;
  if (over > 1) {
    let worst = 0;
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || offstage(el) || scrollable(el)) continue;
      const style = getComputedStyle(el);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
      const spill = r.right - de.clientWidth;
      if (spill > worst) {
        worst = spill;
        culprit = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
          ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '');
      }
    }
  }

  const clipped = [];
  for (const el of document.querySelectorAll('input, select, textarea, button, a.btn')) {
    if (offstage(el) || scrollable(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < -1 || r.right > de.clientWidth + 1) {
      clipped.push((el.getAttribute('placeholder') || el.textContent || el.tagName).trim().slice(0, 34)
        + \` @\${Math.round(r.left)}..\${Math.round(r.right)}\`);
    }
  }

  // A control smaller than this is hard to hit with a thumb.
  const tiny = [...document.querySelectorAll('button, a.btn, .nav-item, .tab, .pill')]
    .filter((el) => { const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 24; }).length;
  return { over, culprit, clipped: clipped.slice(0, 4), tiny, navReachable:
    Boolean(document.querySelector('.sidebar')) || Boolean(document.querySelector('.menu-toggle')) };
})()`;

async function login(page) {
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder="you@example.com"]', 'owner@hardwareerp.in');
  await page.fill('input[type=password]', 'Owner@12345');
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await login(page);

for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => { localStorage.setItem('erp_theme', t); }, theme);
  console.log(`\n${C.b}${theme === 'light' ? 'Light' : 'Dark'} mode${C.x}`);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 500 ? 720 : 900 });
    const problems = [];
    let tinyTotal = 0;
    for (const route of ROUTES) {
      await page.goto(`${WEB}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(220);
      const m = await page.evaluate(MEASURE);
      if (m.over > 1) problems.push(`${route} scrolls +${m.over}px (${m.culprit ?? 'unknown'})`);
      if (m.clipped.length) problems.push(`${route} hides ${m.clipped.length} control(s): ${m.clipped.join(', ')}`);
      if (!m.navReachable) problems.push(`${route} has no reachable navigation`);
      tinyTotal += m.tiny;
    }
    if (problems.length) bad(`${width}px — no page overflow and no clipped controls`, problems.join('; '));
    else ok(`${width}px — ${ROUTES.length} routes, nothing overflowing or clipped`,
      tinyTotal ? `${tinyTotal} control(s) under 24px tall` : 'touch targets ≥ 24px');
  }
}

// The billing screen is the one a cashier uses standing up, so it gets its own
// check: every control of the sale must be reachable without sideways scrolling.
console.log(`\n${C.b}Billing on a phone${C.x}`);
await page.setViewportSize({ width: 375, height: 720 });
await page.goto(`${WEB}/billing`, { waitUntil: 'networkidle' });
// A bill is made at one branch: the owner picks one first (on "All branches" the
// screen asks for a branch instead of showing the bill).
const branchSel = page.locator('select.branch-select').first();
if (await branchSel.count()) await branchSel.selectOption({ index: 1 });
await page.waitForTimeout(900);
for (const [label, sel] of [
  ['the item scan box', '.content input[aria-label="Search or scan an item"]'],
  ['the GST / non-GST selector', '.content .segmented'],
  ['a primary action', '.content .btn.primary, .content button.btn'],
]) {
  const box = await page.locator(sel).first().boundingBox().catch(() => null);
  if (!box) bad(`${label} is present at 375px`, 'not found');
  else if (box.x < -1 || box.x + box.width > 376) bad(`${label} fits the screen at 375px`, `x=${Math.round(box.x)} w=${Math.round(box.width)}`);
  else ok(`${label} fits the screen at 375px`, `${Math.round(box.width)}px wide`);
}

// The command palette is new, so its own responsiveness is asserted rather than assumed.
console.log(`\n${C.b}Command palette${C.x}`);
for (const width of [375, 1280]) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  const visible = await page.locator('.palette').isVisible().catch(() => false);
  if (!visible) { bad(`Ctrl+K opens search at ${width}px`, 'palette did not appear'); continue; }
  ok(`Ctrl+K opens search at ${width}px`);
  await page.fill('.palette-input input', 'pipe');
  await page.waitForTimeout(900);
  const rows = await page.locator('.palette-row').count();
  if (rows > 0) ok(`typing returns results at ${width}px`, `${rows} row(s)`);
  else bad(`typing returns results at ${width}px`, '0 rows');
  const m = await page.evaluate(MEASURE);
  if (m.over > 1) bad(`the open palette causes no page overflow at ${width}px`, `+${m.over}px`);
  else ok(`the open palette causes no page overflow at ${width}px`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const gone = !(await page.locator('.palette').isVisible().catch(() => false));
  gone ? ok(`Escape closes it at ${width}px`) : bad(`Escape closes it at ${width}px`, 'still visible');
}

await browser.close();
console.log(`\n${'─'.repeat(70)}`);
console.log(`${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) { failures.forEach((f) => console.log(`  • ${f}`)); process.exit(1); }
console.log(`${C.g}Responsive across every tested viewport.${C.x}`);
