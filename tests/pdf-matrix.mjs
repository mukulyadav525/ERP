// Renders the whole document matrix from §64 straight out of the renderer, so
// the layout can be inspected without having to build a matching sale for every
// permutation. Each case is written to /tmp/pdfmatrix.
import { renderDocument } from '../apps/api/dist/lib/pdf/renderer.js';
import { DEFAULT_BUSINESS_PROFILE } from '../apps/api/dist/lib/pdf/business-profile.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '/tmp/pdfmatrix';
mkdirSync(OUT, { recursive: true });

const business = {
  ...DEFAULT_BUSINESS_PROFILE,
  name: 'Bhawani Paint & Electric Hardware Stores',
  legal_name: 'Bhawani Paint & Electric Hardware Stores',
  dealing_in: 'Asian Paints • G.I. Pipe & Fittings • Water Tanks • Aluminium Section • Anchor Electricals',
  address: 'Denish Bldg., Shop No. 9, "B" Wing, Savarkar Nagar',
  city_state: 'Thane (W) 400 606, Maharashtra',
  phone: '7208365092', alt_phone: '8652593821',
  email: 'bhawani.hardware@example.in',
  gstin: '27AJSPP6572D1ZO', state: 'Maharashtra', state_code: '27',
  bank_name: 'GP Parsik Bank', bank_branch: 'Vartak Nagar Branch, Thane',
  bank_account_no: '062011300000022', bank_ifsc: 'PJSB0000058',
  upi_id: 'bhawanihardware@upi',
  jurisdiction: 'Thane',
};

const PRODUCTS = [
  ['G.I. 1/2" Pipe — heavy duty, ISI marked', '7306', 'FT', 45],
  ['G.I. 1/2" Elbow', '7307', 'PC', 30],
  ['G.I. 1/2" Coupling', '7307', 'PC', 30],
  ['G.I. 1/2" Bend', '7307', 'PC', 65],
  ['Asian Paints Apcolite Premium Gloss Enamel 4 Litre — Brilliant White', '3208', 'TIN', 1240],
  ['1.5 mm Extension Nipple Brass', '7412', 'PC', 50],
  ['3/4" Green Dhaga Pipe (30 metre roll)', '3917', 'ROLL', 720],
  ['25 mm Black Coupling', '3917', 'PC', 5],
];

function mkLines(n, { discount = false, huge = false, decimal = false } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const [name, hsn, unit, rate0] = PRODUCTS[i % PRODUCTS.length];
    const rate = huge && i === 0 ? 1875450.5 : rate0;
    const q = decimal && i % 3 === 1 ? 2.75 : (huge && i === 0 ? 1250 : (i % 7) + 1);
    const gross = Math.round(q * rate * 100) / 100;
    const disc = discount && i % 2 === 0 ? Math.round(gross * 0.05 * 100) / 100 : 0;
    const net = Math.round((gross - disc) * 100) / 100;
    const gst = [5, 12, 18, 28][i % 4];
    const taxable = Math.round((net / (1 + gst / 100)) * 100) / 100;
    const half = Math.round(((taxable * gst) / 200) * 100) / 100;
    out.push({
      description: `${name}${i === 0 && n > 1 ? '' : ''}`,
      sku: `SKU-${1000 + i}`, hsn_code: hsn, unit_label: unit,
      qty: q, rate, discount_amount: disc, taxable_value: taxable,
      gst_rate_pct: gst, cgst_amount: half, sgst_amount: half, igst_amount: 0,
      line_total: Math.round((taxable + half * 2) * 100) / 100,
      note: i === 0 && name.includes('Asian') ? 'Tint: Base W / 2Y-14 4B-6' : null,
    });
  }
  return out;
}

function totalsOf(lines, interstate = false) {
  const sum = (f) => Math.round(lines.reduce((s, l) => s + Number(l[f] ?? 0), 0) * 100) / 100;
  const taxable = sum('taxable_value');
  const cgst = interstate ? 0 : sum('cgst_amount');
  const sgst = interstate ? 0 : sum('sgst_amount');
  const igst = interstate ? sum('igst_amount') : 0;
  return {
    gross: Math.round((taxable + sum('discount_amount')) * 100) / 100,
    discount_total: sum('discount_amount'), taxable_total: taxable,
    cgst_total: cgst, sgst_total: sgst, igst_total: igst, round_off: 0,
    grand_total: Math.round((taxable + cgst + sgst + igst) * 100) / 100,
  };
}

const buyer = {
  name: 'Shri Bhanu Construction', company: 'Shri Bhanu Construction Pvt. Ltd.',
  address: 'Plot 14, J. K. Gram Road No. 1, Thane (W) 400 606',
  phone: '9372558724', gstin: '27AAAFP2676D1ZD', state: 'Maharashtra', state_code: '27',
};
const longBuyer = {
  ...buyer,
  name: 'Maharashtra Infrastructure & Allied Construction Services Private Limited (Thane Division)',
  company: 'Maharashtra Infrastructure & Allied Construction Services Private Limited',
};

const meta = (n) => ([
  ['Invoice No.', n], ['Date', '21 Aug 2026, 04:15 pm'],
  ['Order No.', 'PO-4471'], ['Challan No.', 'DC-0091'],
  ['Vehicle No.', 'MH-04-CD-8823'], ['Place of Supply', '27'],
  ['Supply Type', 'Intra-state (CGST + SGST)'],
]);

const cases = [];
for (const n of [1, 5, 10, 20, 50]) {
  const lines = mkLines(n);
  cases.push([`invoice-gst-${n}-items`, {
    kind: 'TAX_INVOICE', business, billTo: buyer, meta: meta(`INV-BHW/2026-27/00${100 + n}`),
    lines, totals: totalsOf(lines), interstate: false, showTax: true,
    payments: [{ method: 'CASH', amount: 500 }, { method: 'UPI', amount: 250, ref_no: 'UPI/4471' }],
  }]);
}
{
  const lines = mkLines(6, { discount: true });
  cases.push(['invoice-gst-discounts', {
    kind: 'TAX_INVOICE', business, billTo: buyer, meta: meta('INV-BHW/2026-27/00201'),
    lines, totals: totalsOf(lines), interstate: false, showTax: true,
    payments: [{ method: 'CASH', amount: 1000 }, { method: 'CREDIT', amount: 2000 }],
  }]);
}
{
  const lines = mkLines(4).map((l) => ({ ...l, igst_amount: Math.round((l.cgst_amount + l.sgst_amount) * 100) / 100, cgst_amount: 0, sgst_amount: 0 }));
  cases.push(['invoice-igst-interstate', {
    kind: 'TAX_INVOICE', business, billTo: { ...buyer, state: 'Gujarat', state_code: '24' },
    meta: [['Invoice No.', 'INV-BHW/2026-27/00202'], ['Date', '21 Aug 2026'], ['Place of Supply', '24'], ['Supply Type', 'Inter-state (IGST)']],
    lines, totals: totalsOf(lines, true), interstate: true, showTax: true,
  }]);
}
{
  const lines = mkLines(5).map((l) => ({ ...l, taxable_value: l.line_total, gst_rate_pct: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }));
  cases.push(['cashmemo-nongst', {
    kind: 'CASH_MEMO', title: 'CASH MEMO / BILL OF SUPPLY', business, billTo: null,
    meta: [['Bill No.', 'NG-BHW/2026-27/0041'], ['Date', '21 Aug 2026, 11:02 am']],
    lines, totals: totalsOf(lines), interstate: false, showTax: false,
    payments: [{ method: 'CASH', amount: 2000 }],
  }]);
}
{
  const lines = mkLines(4);
  cases.push(['estimate', {
    kind: 'ESTIMATE', business, billTo: buyer,
    meta: [['Estimate No.', 'EST-BHW/2026-27/0007'], ['Date', '21 Aug 2026'], ['Valid Until', '28 Aug 2026'], ['Status', 'APPROVED']],
    lines, totals: totalsOf(lines), interstate: false, showTax: true,
    notes: 'Delivery to site within 3 working days of order confirmation.',
  }]);
}
{
  const lines = mkLines(3, { huge: true, decimal: true });
  cases.push(['invoice-large-values-decimals', {
    kind: 'TAX_INVOICE', business, billTo: longBuyer, meta: meta('INV-BHW/2026-27/00777'),
    lines, totals: { ...totalsOf(lines), round_off: 0.37 }, interstate: false, showTax: true,
    payments: [{ method: 'CARD', amount: 1000000, ref_no: 'XXXX-4412' }, { method: 'CREDIT', amount: 1500000 }],
    balance_due: 12500,
  }]);
}
{
  const lines = mkLines(2);
  cases.push(['invoice-void', {
    kind: 'TAX_INVOICE', business, billTo: buyer, meta: meta('INV-BHW/2026-27/00099'),
    lines, totals: totalsOf(lines), interstate: false, showTax: true, watermark: 'VOID',
  }]);
  cases.push(['invoice-draft-proforma', {
    kind: 'TAX_INVOICE', title: 'PROFORMA — DRAFT', business, billTo: buyer,
    meta: [['Draft ref', 'A1B2C3D4'], ['Date', '02 Sept 2026']],
    lines, totals: totalsOf(lines), interstate: false, showTax: true,
    watermark: 'DRAFT — NOT A TAX INVOICE',
    extraTerms: ['This draft has no invoice number and is not a valid tax document until it is finalised.'],
  }]);
}
{
  const lines = mkLines(3).map((l, i) => ({
    ...l,
    description: ['जी.आई. आधा इंच पाइप — भारी', 'एशियन पेंट्स एपकोलाइट ग्लॉस एनामेल ४ लीटर', 'पीतल का निपल एक्सटेंशन'][i],
  }));
  cases.push(['invoice-hindi', {
    kind: 'TAX_INVOICE', business: { ...business, name: 'भवानी पेंट एंड इलेक्ट्रिक हार्डवेयर स्टोर्स',
      declaration: 'हम घोषणा करते हैं कि यह बीजक वस्तुओं का वास्तविक मूल्य दर्शाता है।',
      terms: ['बेचा गया माल वापस नहीं लिया जाएगा।', 'देय तिथि के बाद ब्याज लागू होगा।'] },
    billTo: { ...buyer, name: 'श्री भानु कंस्ट्रक्शन' },
    meta: [['बीजक सं.', 'INV-BHW/2026-27/00311'], ['दिनांक', '21 Aug 2026']],
    lines, totals: totalsOf(lines), interstate: false, showTax: true,
  }]);
}

let failures = 0;
for (const [name, model] of cases) {
  try {
    const buf = await renderDocument(model);
    writeFileSync(`${OUT}/${name}.pdf`, buf);
    console.log(`  ok  ${name.padEnd(32)} ${String(buf.length).padStart(7)} bytes`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}
console.log(failures ? `\n${failures} case(s) failed` : `\nAll ${cases.length} document cases rendered.`);
process.exit(failures ? 1 : 0);
