// ============================================================================
// Property tests for the tax engine (Sections 3.1.1, 2.2.1, 2.8, 13).
//
// Worked examples prove a formula on the cases someone thought of. These assert
// the invariants that have to hold for EVERY combination, over tens of thousands
// of randomly generated lines — which is where the paisa-level disagreements
// that a GST auditor flags actually live.
//
//   node tests/tax-properties.mjs
// ============================================================================
import { computeLine, totalInvoice, computeReturnLine, round2, roundTo, newWeightedAvgCost }
  from '../apps/api/dist/lib/tax.js';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail ? `  ${C.d}${detail}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${detail}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);

// A small deterministic PRNG, so a failure is reproducible rather than a
// once-in-a-thousand-runs mystery.
let seed = 0x2f6e2b1;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e9) / 1e9; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const GST_RATES = [0, 5, 12, 18, 28];
const MULTIPLIERS = [1, 12, 90, 100, 0.5, 2.5];

section('Rounding (3.1.1 — half-up on the decimal, not the float)');
{
  const cases = [
    [1.005, 1.01], [2.675, 2.68], [0.125, 0.13], [1.045, 1.05],
    [-1.005, -1.01], [0, 0], [1.004, 1.0], [1234.565, 1234.57],
  ];
  let bad = [];
  for (const [input, want] of cases) if (round2(input) !== want) bad.push(`${input} -> ${round2(input)} want ${want}`);
  check('half-up at the 2nd decimal, both signs', bad.length === 0, bad.join('; '));
  check('Math.round would have got these wrong',
    Math.round(1.005 * 100) / 100 !== 1.01, 'confirming the naive form really is broken');
}

section('Line arithmetic — 40,000 random lines');
{
  let taxableMismatch = 0, inclusiveDrift = 0, halvesUnequal = 0, negative = 0, worstDrift = 0;
  const N = 40_000;
  for (let i = 0; i < N; i += 1) {
    const rate = pick(GST_RATES);
    const priceType = pick(['TAX_INCLUSIVE', 'TAX_EXCLUSIVE']);
    const interstate = rnd() < 0.3;
    const multiplier = pick(MULTIPLIERS);
    const qty = roundTo(rnd() * 40 + 0.001, 3);
    const ratePerBase = roundTo(rnd() * 5000 + 0.5, 2);
    const gross = round2(roundTo(qty * multiplier, 4) * ratePerBase);
    const discount = rnd() < 0.35 ? round2(gross * rnd() * 0.4) : 0;

    const l = computeLine({
      qty_in_sale_unit: qty, multiplier_to_base: multiplier, rate_per_base_unit: ratePerBase,
      gst_rate_pct: rate, price_type: priceType, discount_amount: discount, interstate,
    });

    // The line total is always taxable + the tax parts.
    if (round2(l.taxable_value + l.cgst_amount + l.sgst_amount + l.igst_amount) !== l.line_total) taxableMismatch += 1;
    // Only one of the two schemes is ever used on a line.
    if (interstate && (l.cgst_amount !== 0 || l.sgst_amount !== 0)) halvesUnequal += 1;
    if (!interstate && l.igst_amount !== 0) halvesUnequal += 1;
    // CGST and SGST are equal halves, to within the single paisa the engine
    // deliberately absorbs into SGST so that a tax-inclusive line adds back up to
    // exactly the marked price. Anything larger than that is a real split error.
    if (!interstate && Math.abs(round2(l.cgst_amount - l.sgst_amount)) > 0.01) halvesUnequal += 1;
    if (!interstate && priceType === 'TAX_EXCLUSIVE' && l.cgst_amount !== l.sgst_amount) halvesUnequal += 1;
    // A tax-inclusive line must add back up to exactly the marked price (2.8).
    if (priceType === 'TAX_INCLUSIVE') {
      const net = round2(l.gross - l.discount_amount);
      const drift = Math.abs(round2(l.line_total - net));
      worstDrift = Math.max(worstDrift, drift);
      if (drift > 0.001) inclusiveDrift += 1;
    }
    if (l.taxable_value < -0.001 || l.cgst_amount < -0.001 || l.line_total < -0.001) negative += 1;
  }
  check(`line total = taxable + taxes, ${N} lines`, taxableMismatch === 0, `${taxableMismatch} mismatches`);
  check('CGST/SGST vs IGST are mutually exclusive; halves equal within the 1p inclusive drift',
    halvesUnequal === 0, `${halvesUnequal} bad`);
  check('a tax-inclusive line sums back to the marked price', inclusiveDrift === 0,
    `${inclusiveDrift} drifted, worst ${worstDrift.toFixed(4)}`);
  check('nothing goes negative', negative === 0, `${negative} negative`);
}

section('Invoice totals are the sum of already-rounded lines (3.1.1)');
{
  let bad = 0, worst = 0;
  for (let t = 0; t < 4000; t += 1) {
    const lines = [];
    const n = 1 + Math.floor(rnd() * 25);
    for (let i = 0; i < n; i += 1) {
      lines.push(computeLine({
        qty_in_sale_unit: roundTo(rnd() * 20 + 0.01, 3),
        multiplier_to_base: pick(MULTIPLIERS),
        rate_per_base_unit: roundTo(rnd() * 3000 + 1, 2),
        gst_rate_pct: pick(GST_RATES),
        price_type: pick(['TAX_INCLUSIVE', 'TAX_EXCLUSIVE']),
        discount_amount: rnd() < 0.3 ? roundTo(rnd() * 50, 2) : 0,
        interstate: false,
      }));
    }
    const tot = totalInvoice(lines);
    const sumLines = round2(lines.reduce((s, l) => s + l.line_total, 0));
    const diff = Math.abs(round2(tot.grand_total - sumLines));
    worst = Math.max(worst, diff);
    if (diff > 0.001) bad += 1;
    // The invoice tax must equal the sum of the rounded line taxes, never a
    // re-rounding of the invoice total — this is the GSTR-1 reconciliation rule.
    const sumTax = round2(lines.reduce((s, l) => s + l.cgst_amount + l.sgst_amount + l.igst_amount, 0));
    if (Math.abs(round2(tot.tax_total - sumTax)) > 0.001) bad += 1;
  }
  check('grand total equals the sum of the line totals, 4,000 invoices', bad === 0,
    `${bad} mismatches, worst ${worst.toFixed(4)}`);
}

section('Base-unit conversion (2.2.1)');
{
  // The documented example: 3 screws out of a 100-piece box must price as
  // 3 × (box price ÷ 100), not as a separately typed rate.
  const boxPrice = 450;
  const perPiece = boxPrice / 100;
  const three = computeLine({
    qty_in_sale_unit: 3, multiplier_to_base: 1, rate_per_base_unit: perPiece,
    gst_rate_pct: 18, price_type: 'TAX_EXCLUSIVE',
  });
  const oneBox = computeLine({
    qty_in_sale_unit: 1, multiplier_to_base: 100, rate_per_base_unit: perPiece,
    gst_rate_pct: 18, price_type: 'TAX_EXCLUSIVE',
  });
  check('3 pieces price as 3 × (box ÷ 100)', round2(three.taxable_value) === round2(3 * perPiece),
    `${three.taxable_value} vs ${round2(3 * perPiece)}`);
  check('1 box equals 100 pieces', round2(oneBox.taxable_value) === round2(boxPrice),
    `${oneBox.taxable_value} vs ${boxPrice}`);

  // 1 reel = 90 metres; selling 90 metres loose must equal selling one reel.
  const perMetre = 8;
  const reel = computeLine({ qty_in_sale_unit: 1, multiplier_to_base: 90, rate_per_base_unit: perMetre, gst_rate_pct: 18, price_type: 'TAX_INCLUSIVE' });
  const metres = computeLine({ qty_in_sale_unit: 90, multiplier_to_base: 1, rate_per_base_unit: perMetre, gst_rate_pct: 18, price_type: 'TAX_INCLUSIVE' });
  check('1 reel equals 90 metres, to the paisa', reel.line_total === metres.line_total,
    `${reel.line_total} vs ${metres.line_total}`);

  // A fractional length must not be rounded up into a whole unit.
  const half = computeLine({ qty_in_sale_unit: 0.5, multiplier_to_base: 1, rate_per_base_unit: 100, gst_rate_pct: 18, price_type: 'TAX_EXCLUSIVE' });
  check('half a metre bills as half', half.taxable_value === 50, String(half.taxable_value));
}

section('NON-GST bills carry no tax at all (Section 10)');
{
  let leaked = 0;
  for (let i = 0; i < 5000; i += 1) {
    const l = computeLine({
      qty_in_sale_unit: roundTo(rnd() * 30 + 0.01, 3), multiplier_to_base: pick(MULTIPLIERS),
      rate_per_base_unit: roundTo(rnd() * 2000 + 1, 2),
      gst_rate_pct: 0,                                  // what a NON_GST invoice forces
      price_type: pick(['TAX_INCLUSIVE', 'TAX_EXCLUSIVE']),
      discount_amount: rnd() < 0.3 ? roundTo(rnd() * 40, 2) : 0,
      interstate: rnd() < 0.5,
    });
    if (l.cgst_amount || l.sgst_amount || l.igst_amount) leaked += 1;
    if (round2(l.taxable_value) !== round2(l.gross - l.discount_amount)) leaked += 1;
  }
  check('no GST appears on a zero-rated line, 5,000 lines', leaked === 0, `${leaked} leaked`);
}

section('Partial returns stay proportional (12.1.1)');
{
  let bad = 0, overRefund = 0;
  for (let i = 0; i < 5000; i += 1) {
    const qty = 1 + Math.floor(rnd() * 20);
    const line = computeLine({
      qty_in_sale_unit: qty, multiplier_to_base: 1,
      rate_per_base_unit: roundTo(rnd() * 900 + 1, 2),
      gst_rate_pct: pick(GST_RATES.filter((r) => r > 0)),
      price_type: pick(['TAX_INCLUSIVE', 'TAX_EXCLUSIVE']),
      discount_amount: rnd() < 0.3 ? roundTo(rnd() * 30, 2) : 0,
    });
    const original = { qty_in_sale_unit: qty, base_unit_qty: line.base_unit_qty, ...line };
    const part = 1 + Math.floor(rnd() * qty);
    const r = computeReturnLine(original, part);
    // A return can never exceed the original line.
    if (r.line_total > line.line_total + 0.011) overRefund += 1;
    // Returning everything must give the whole line back.
    const full = computeReturnLine(original, line.base_unit_qty);
    if (Math.abs(full.line_total - line.line_total) > 0.011) bad += 1;
  }
  check('a partial return never exceeds the original line', overRefund === 0, `${overRefund} over-refunds`);
  check('a full return returns the whole line', bad === 0, `${bad} mismatches`);
}

section('Weighted-average cost (4.8.1)');
{
  const c1 = newWeightedAvgCost(0, 0, 100, 50);
  check('first receipt sets the cost', c1 === 50, String(c1));
  const c2 = newWeightedAvgCost(100, 50, 100, 70);
  check('equal quantities average the two rates', c2 === 60, String(c2));
  const c3 = newWeightedAvgCost(-20, 50, 10, 80);
  check('negative existing stock does not produce a nonsense average', c3 === 80, String(c3));
  const c4 = newWeightedAvgCost(3, 33.333333, 7, 12.5);
  check('kept to 4 decimals', String(c4).split('.')[1]?.length <= 4, String(c4));

  // Receiving at the same rate must never move the cost, however many times.
  let cost = 42.5, qty = 10, drifted = false;
  for (let i = 0; i < 500; i += 1) { cost = newWeightedAvgCost(qty, cost, 7, 42.5); qty += 7; if (Math.abs(cost - 42.5) > 0.0001) drifted = true; }
  check('500 receipts at one rate do not drift the cost', !drifted, `ended at ${cost}`);
}

section('Cash rounding is separable (3.1.1)');
{
  let bad = 0;
  for (let i = 0; i < 3000; i += 1) {
    const lines = [computeLine({
      qty_in_sale_unit: roundTo(rnd() * 9 + 0.1, 3), multiplier_to_base: 1,
      rate_per_base_unit: roundTo(rnd() * 700 + 1, 2), gst_rate_pct: pick(GST_RATES),
      price_type: 'TAX_INCLUSIVE',
    })];
    const t = totalInvoice(lines, true);
    // The reported GST total and the amount collected stay reconcilable: the
    // rounding is its own figure, never folded into the tax.
    if (round2(t.grand_total + t.round_off) !== t.payable) bad += 1;
    if (Math.abs(t.round_off) > 0.5) bad += 1;
    if (t.payable !== Math.round(t.payable)) bad += 1;
  }
  check('payable = grand total + an explicit round-off, 3,000 invoices', bad === 0, `${bad} bad`);
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) { failures.forEach((f) => console.log(`  • ${f}`)); process.exit(1); }
console.log(`${C.g}All tax properties hold.${C.x}`);
