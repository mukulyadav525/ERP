// ============================================================================
// Thermal receipt — the same document model as the A4 bill, laid out for a
// 58 mm or 80 mm roll printer.
//
// The page is exactly the paper's width and exactly as tall as the receipt, so
// a roll printer cuts it where it ends. It is drawn twice: once to measure the
// height, once for real. Black only — thermal printers have no grey.
//
// Printing: open the PDF and print to the thermal printer at "Actual size"
// (not "Fit to page"), with the printer's paper set to the roll width.
// ============================================================================
import PDFDocument from 'pdfkit';
import type { DocumentModel } from './renderer.js';
import { devanagariFontPath } from './renderer.js';
import { FONTS, amountInWords, money, pickFont, qty } from './theme.js';

type Doc = InstanceType<typeof PDFDocument>;
export type ThermalWidth = 58 | 80;

const MM = 72 / 25.4;

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CREDIT: 'On credit', LOYALTY_POINTS: 'Points', BANK_TRANSFER: 'Bank transfer',
};

function sizes(widthMm: ThermalWidth) {
  return widthMm === 58
    ? { pad: 6, body: 7, small: 6.2, title: 9, name: 11, total: 10 }
    : { pad: 9, body: 8.2, small: 7.2, title: 10.5, name: 13, total: 11.5 };
}

/** Draws the receipt from y = pad and returns where it ended. */
function draw(doc: Doc, deva: boolean, model: DocumentModel, widthMm: ThermalWidth): number {
  const s = sizes(widthMm);
  const pageWidth = widthMm * MM;
  const x = s.pad;
  const w = pageWidth - s.pad * 2;
  let y = s.pad;

  const font = (value: string, bold: boolean) => pickFont(value, bold, deva);
  const line = (value: string, o: { bold?: boolean; size?: number; align?: 'left' | 'center' | 'right'; gap?: number } = {}) => {
    if (!value) return;
    doc.font(font(value, Boolean(o.bold))).fontSize(o.size ?? s.body).fillColor('#000000');
    doc.text(value, x, y, { width: w, align: o.align ?? 'left', lineGap: 0.5 });
    y = doc.y + (o.gap ?? 1);
  };
  /** Label on the left, figure on the right, on one row. */
  const pair = (left: string, right: string, o: { bold?: boolean; size?: number } = {}) => {
    const size = o.size ?? s.body;
    doc.font(font(right, Boolean(o.bold))).fontSize(size);
    const rw = Math.min(doc.widthOfString(right) + 1, w * 0.55);
    doc.font(font(left, Boolean(o.bold))).fontSize(size).fillColor('#000000');
    const lh = doc.heightOfString(left || ' ', { width: w - rw - 4 });
    doc.text(left, x, y, { width: w - rw - 4 });
    doc.font(font(right, Boolean(o.bold))).fontSize(size);
    doc.text(right, x + w - rw, y, { width: rw, align: 'right' });
    y += Math.max(lh, doc.heightOfString(right, { width: rw })) + 1;
  };
  const rule = (gap = 3) => {
    y += gap;
    doc.save().moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).dash(1.6, { space: 1.4 }).strokeColor('#000000').stroke().undash().restore();
    y += gap + 1;
  };

  const b = model.business;
  if (model.watermark) line(`*** ${model.watermark} ***`, { bold: true, align: 'center', size: s.title, gap: 3 });
  line(b.name, { bold: true, align: 'center', size: s.name, gap: 2 });
  line([b.address, b.city_state].filter(Boolean).join(', '), { align: 'center', size: s.small });
  line([b.phone, b.alt_phone].filter(Boolean).join(' / ') ? `Ph: ${[b.phone, b.alt_phone].filter(Boolean).join(' / ')}` : '', { align: 'center', size: s.small });
  if (b.gstin) line(`GSTIN: ${b.gstin}`, { align: 'center', size: s.small, bold: true });

  rule();
  line(model.title ?? model.kind.replace('_', ' '), { bold: true, align: 'center', size: s.title, gap: 3 });
  for (const [label, value] of model.meta) pair(label, value, { size: s.small });

  if (model.billTo) {
    rule(2);
    line(`To: ${model.billTo.company ? `${model.billTo.company} (${model.billTo.name})` : model.billTo.name}`, { bold: true });
    if (model.billTo.phone) line(`Ph: ${model.billTo.phone}`, { size: s.small });
    if (model.showTax && model.billTo.gstin) line(`GSTIN: ${model.billTo.gstin}`, { size: s.small });
  }

  rule();
  pair('Item', 'Amount', { bold: true, size: s.small });
  rule(1.5);
  for (const l of model.lines) {
    line(l.description, { bold: true, gap: 0.5 });
    const detail = `${qty(l.qty)}${l.unit_label ? ` ${l.unit_label}` : ''} x ${money(l.rate)}`
      + (model.showTax && l.gst_rate_pct !== undefined ? `  GST ${l.gst_rate_pct}%` : '')
      + (model.showTax && l.hsn_code ? `  HSN ${l.hsn_code}` : '');
    pair(detail, money(l.line_total), { size: s.small });
    if (l.discount_amount && l.discount_amount > 0) pair('  Discount', `-${money(l.discount_amount)}`, { size: s.small });
    if (l.note) line(l.note, { size: s.small });
    y += 1.5;
  }

  rule();
  const t = model.totals;
  if (t.discount_total > 0 && t.gross !== undefined) {
    pair('Gross', money(t.gross));
    pair('Discount', `-${money(t.discount_total)}`);
  }
  if (model.showTax) {
    pair('Taxable value', money(t.taxable_total));
    if (model.interstate) pair('IGST', money(t.igst_total));
    else { pair('CGST', money(t.cgst_total)); pair('SGST', money(t.sgst_total)); }
  }
  if (t.round_off) pair('Round off', money(t.round_off));
  y += 1;
  pair('TOTAL', `Rs. ${money(t.grand_total)}`, { bold: true, size: s.total });

  if (model.showTax) {
    const byRate = new Map<number, { taxable: number; tax: number }>();
    for (const l of model.lines) {
      const r = Number(l.gst_rate_pct ?? 0);
      const row = byRate.get(r) ?? { taxable: 0, tax: 0 };
      row.taxable += l.taxable_value;
      row.tax += (l.cgst_amount ?? 0) + (l.sgst_amount ?? 0) + (l.igst_amount ?? 0);
      byRate.set(r, row);
    }
    if (byRate.size) {
      rule(2);
      pair('GST rate / taxable', 'Tax', { bold: true, size: s.small });
      for (const [r, v] of [...byRate.entries()].sort((a, c) => a[0] - c[0])) {
        pair(`${r}% on ${money(v.taxable)}`, money(v.tax), { size: s.small });
      }
    }
  }

  if (model.payments?.length) {
    rule(2);
    for (const p of model.payments) {
      pair(`${METHOD_LABEL[p.method] ?? p.method}${p.ref_no ? ` (${p.ref_no})` : ''}`, money(p.amount), { size: s.small });
    }
  }
  if (model.balance_due !== null && model.balance_due !== undefined && Math.abs(model.balance_due) >= 0.01) {
    pair(model.balance_due > 0 ? 'Balance due' : 'Change / excess', money(Math.abs(model.balance_due)), { bold: true });
  }

  y += 2;
  line(amountInWords(t.grand_total), { size: s.small });
  if (model.notes) line(model.notes, { size: s.small });
  for (const term of model.extraTerms ?? []) line(term, { size: s.small });
  rule(2);
  line(b.footer_note || 'Thank you! Please visit again.', { align: 'center', size: s.small, bold: true });
  return y + s.pad;
}

function newDoc(width: number, height: number, title: string): { doc: Doc; deva: boolean } {
  const doc: Doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: true, info: { Title: title } });
  const fontPath = devanagariFontPath();
  let deva = false;
  if (fontPath) {
    try { doc.registerFont(FONTS.deva, fontPath); deva = true; } catch { deva = false; }
  }
  return { doc, deva };
}

export function renderThermal(model: DocumentModel, widthMm: ThermalWidth = 80): Promise<Buffer> {
  const width = widthMm * MM;
  const title = model.title ?? 'Receipt';
  // Pass 1: measure on a very tall scratch page.
  const probe = newDoc(width, 14_400, title);
  const height = Math.ceil(draw(probe.doc, probe.deva, model, widthMm));
  probe.doc.end();

  return new Promise((resolvePromise, reject) => {
    try {
      const { doc, deva } = newDoc(width, Math.max(height, 120), title);
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
      doc.on('error', reject);
      draw(doc, deva, model, widthMm);
      doc.end();
    } catch (err) { reject(err); }
  });
}
