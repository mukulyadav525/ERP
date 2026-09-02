// ============================================================================
// The look of every printed document (Sections 58–68).
//
// One set of tokens, three documents. The estimate, the tax invoice and the cash
// memo are the same page with different fields, which is the point: a customer
// who gets a quote and then an invoice should see the same shop, not two
// different pieces of software.
//
// The palette is deliberately restrained and print-first. These pages get
// photocopied, faxed to a CA, and printed on a cheap inkjet in a shop, so the
// design carries on ink weight and alignment rather than on colour: one navy
// (which is what the shop's existing rubber-stamped letterhead already looks
// like), one warm accent used only to distinguish a non-binding estimate, and
// greys. Nothing here relies on a colour being reproduced accurately to stay
// readable in black and white.
// ============================================================================

export const COLORS = {
  ink: '#16202b',        // body text
  inkSoft: '#3d4b5a',    // secondary text
  muted: '#6b7885',      // labels, captions
  faint: '#98a4b0',      // the least important thing on the page

  primary: '#123a63',    // headings, the grand-total bar, the header rule
  primarySoft: '#e9eff5', // table header fill, party-box fill

  accent: '#9a5b17',     // ESTIMATE only — a quote must not look like a bill
  accentSoft: '#faf1e6',

  danger: '#a51c1c',     // VOID / CANCELLED

  rule: '#cfd8e2',       // table and box borders
  ruleSoft: '#e6ecf2',   // row separators
  zebra: '#f7f9fb',      // alternating row tint
  paper: '#ffffff',
} as const;

/** A4 in points, with the margins the layout is built around. */
export const PAGE = {
  size: 'A4' as const,
  width: 595.28,
  height: 841.89,
  margin: 34,
  get left() { return this.margin; },
  get right() { return this.width - this.margin; },
  get contentWidth() { return this.width - this.margin * 2; },
  /** Everything above this line; the footer band lives below it. */
  get bodyBottom() { return this.height - 92; },
  get footerTop() { return this.height - 86; },
} as const;

export const TYPE = {
  businessName: 17,
  docTitle: 15,
  sectionLabel: 7.5,
  body: 8.5,
  bodySmall: 7.5,
  tableHeader: 7.5,
  tableCell: 8,
  totalLabel: 9,
  grandTotal: 12,
  micro: 6.8,
} as const;

/**
 * Devanagari needs a font that actually has the glyphs; the built-in Helvetica
 * does not. Latin text keeps Helvetica because Lohit's Latin digits are loosely
 * spaced and money columns have to line up. `pickFont` below chooses per string,
 * so a Hindi label and a rupee figure on the same row each get the right one.
 */
export const FONTS = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  oblique: 'Helvetica-Oblique',
  deva: 'Deva',
  devaBold: 'Deva',
} as const;

const DEVANAGARI = /[ऀ-ॿ]/;

export function hasDevanagari(text: unknown): boolean {
  return typeof text === 'string' && DEVANAGARI.test(text);
}

/** The font to draw `text` in, given whether the caller wanted bold. */
export function pickFont(text: unknown, bold = false, devaAvailable = true): string {
  if (devaAvailable && hasDevanagari(text)) return bold ? FONTS.devaBold : FONTS.deva;
  return bold ? FONTS.bold : FONTS.regular;
}

/** Indian digit grouping — 12,34,567.00, not 1,234,567.00. */
export function money(value: unknown, { blankZero = false } = {}): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  if (blankZero && n === 0) return '';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Quantities print without trailing noise: 3, not 3.0000; 0.5 stays 0.5. */
export function qty(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(3)).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

export function dateOnly(value: unknown): string {
  if (!value) return '—';
  const d = new Date(value as string);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(value: unknown): string {
  if (!value) return '—';
  const d = new Date(value as string);
  if (!Number.isFinite(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}, ` +
         `${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Amount in words, Indian numbering — a tax invoice is expected to carry it, and
 * it is the line a shopkeeper checks when a printed figure looks wrong.
 */
export function amountInWords(amount: number, currency = 'Rupees'): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number): string =>
    n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
  const three = (n: number): string =>
    n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n);

  const negative = amount < 0;
  const abs = Math.abs(Number(amount) || 0);
  const rupees = Math.floor(abs);
  // Rounded, not truncated: 0.005 short of a paisa should read as the paisa the
  // total column shows, not as one less.
  const paise = Math.round((abs - rupees) * 100);
  // A rounded 100 paise is a whole rupee.
  const carried = paise === 100 ? rupees + 1 : rupees;
  const realPaise = paise === 100 ? 0 : paise;

  if (carried === 0 && realPaise === 0) return `Zero ${currency} Only`;

  const parts: string[] = [];
  const crore = Math.floor(carried / 10_000_000);
  const lakh = Math.floor((carried % 10_000_000) / 100_000);
  const thousand = Math.floor((carried % 100_000) / 1000);
  const rest = carried % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${three(lakh)} Lakh`);
  if (thousand) parts.push(`${three(thousand)} Thousand`);
  if (rest) parts.push(three(rest));

  let out = parts.length ? `${parts.join(' ')} ${currency}` : `Zero ${currency}`;
  if (realPaise) out += ` and ${two(realPaise)} Paise`;
  return `${negative ? 'Minus ' : ''}${out} Only`;
}
