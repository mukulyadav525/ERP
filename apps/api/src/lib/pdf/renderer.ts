// ============================================================================
// The document renderer (Sections 58–68).
//
// One layout engine. The GST tax invoice, the non-GST cash memo and the
// estimate/quotation are the same page description with different fields and a
// different title — not three copies of a PDF builder that will drift apart the
// first time someone changes a column width.
//
// What the layout has to survive, and what each piece here is for:
//   * 1 item and 60 items. The table measures every row and breaks pages itself,
//     repeating the column headings, so a long bill never runs into the footer
//     and a short one never leaves a lake of white space above the totals.
//   * A closing block that must not be orphaned. Totals, amount in words, bank
//     details and the signature are measured as one unit and moved to a fresh
//     page together if they will not fit.
//   * Names that are too long. Every cell is width-bounded and either wraps
//     (the description) or ellipsises (everything else), so nothing overlaps
//     its neighbour.
//   * Page numbers that can only be written once the page count is known, which
//     is why the document is rendered with buffered pages and stamped at the end.
// ============================================================================
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  COLORS, PAGE, TYPE, FONTS, amountInWords, money, pickFont, qty,
} from './theme.js';

// ── The document model ──────────────────────────────────────────────────────
// Everything the renderer needs, already resolved. No database access, no
// settings lookups, no defaulting: whatever is on this object is what prints.
// That keeps the PDF a pure function of finalised data (§63) — a preview and a
// reprint of the same invoice cannot differ.

export interface BusinessProfile {
  name: string;
  legal_name?: string | null;
  tagline?: string | null;
  /** Categories line, as on the shop's existing letterhead. */
  dealing_in?: string | null;
  address?: string | null;
  city_state?: string | null;
  phone?: string | null;
  alt_phone?: string | null;
  email?: string | null;
  website?: string | null;
  gstin?: string | null;
  state?: string | null;
  state_code?: string | null;
  /** data: URI or absolute path; anything unreadable degrades to the monogram. */
  logo?: string | null;
  bank_name?: string | null;
  bank_branch?: string | null;
  bank_account_no?: string | null;
  bank_ifsc?: string | null;
  upi_id?: string | null;
  declaration?: string | null;
  terms?: string[] | null;
  signature_label?: string | null;
  footer_note?: string | null;
  jurisdiction?: string | null;
}

export interface DocumentParty {
  name: string;
  company?: string | null;
  address?: string | null;
  phone?: string | null;
  gstin?: string | null;
  state?: string | null;
  state_code?: string | null;
}

export interface DocumentLine {
  description: string;
  sku?: string | null;
  hsn_code?: string | null;
  unit_label?: string | null;
  qty: number;
  rate: number;
  discount_amount?: number;
  taxable_value: number;
  gst_rate_pct?: number;
  cgst_amount?: number;
  sgst_amount?: number;
  igst_amount?: number;
  line_total: number;
  /** Printed under the description — tint formula, batch, serials. */
  note?: string | null;
}

export interface DocumentPayment {
  method: string;
  amount: number;
  ref_no?: string | null;
}

export type DocumentKind = 'TAX_INVOICE' | 'CASH_MEMO' | 'ESTIMATE' | 'CREDIT_NOTE';

export interface DocumentModel {
  kind: DocumentKind;
  /** Overrides the default title for the kind (e.g. "BILL OF SUPPLY"). */
  title?: string;
  business: BusinessProfile;
  billTo: DocumentParty | null;
  shipTo?: DocumentParty | null;
  /** Left-hand metadata rows, in order: [label, value]. */
  meta: Array<[string, string]>;
  lines: DocumentLine[];
  totals: {
    gross?: number;
    discount_total: number;
    taxable_total: number;
    cgst_total: number;
    sgst_total: number;
    igst_total: number;
    round_off: number;
    grand_total: number;
  };
  payments?: DocumentPayment[];
  amount_paid?: number | null;
  balance_due?: number | null;
  interstate: boolean;
  /** True for a GST document: shows the tax columns and the HSN summary. */
  showTax: boolean;
  /** Diagonal stamp — VOID, CANCELLED, DRAFT / NOT A TAX INVOICE. */
  watermark?: string | null;
  notes?: string | null;
  /** Extra terms for this document on top of the business-wide ones. */
  extraTerms?: string[];
}

// ── Font resolution ─────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
// dist/lib/pdf/renderer.js and src/lib/pdf/renderer.ts sit at different depths,
// so the asset directory is probed rather than assumed.
const FONT_CANDIDATES = [
  resolve(HERE, '../../../assets/fonts/Lohit-Devanagari.ttf'),
  resolve(HERE, '../../../../assets/fonts/Lohit-Devanagari.ttf'),
  resolve(process.cwd(), 'apps/api/assets/fonts/Lohit-Devanagari.ttf'),
  resolve(process.cwd(), 'assets/fonts/Lohit-Devanagari.ttf'),
];

function devanagariFontPath(): string | null {
  for (const p of FONT_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

// ── Small drawing helpers ───────────────────────────────────────────────────

type Doc = InstanceType<typeof PDFDocument>;

interface Ctx {
  doc: Doc;
  deva: boolean;
}

function text(
  ctx: Ctx, value: string, x: number, y: number,
  opts: { width?: number; size?: number; bold?: boolean; color?: string;
          align?: 'left' | 'right' | 'center'; lineGap?: number; oblique?: boolean } = {},
): void {
  const { doc } = ctx;
  const size = opts.size ?? TYPE.body;
  const font = opts.oblique && !/[ऀ-ॿ]/.test(value)
    ? FONTS.oblique
    : pickFont(value, opts.bold, ctx.deva);
  doc.font(font).fontSize(size).fillColor(opts.color ?? COLORS.ink);
  doc.text(value, x, y, {
    width: opts.width,
    align: opts.align ?? 'left',
    lineGap: opts.lineGap ?? 0,
    lineBreak: opts.width !== undefined,
  });
}

function heightOf(ctx: Ctx, value: string, width: number, size: number, bold = false): number {
  ctx.doc.font(pickFont(value, bold, ctx.deva)).fontSize(size);
  return ctx.doc.heightOfString(value, { width });
}

/** Shortens to fit `width`, appending an ellipsis. Used for every single-line cell. */
function clip(ctx: Ctx, value: string, width: number, size: number, bold = false): string {
  const { doc } = ctx;
  doc.font(pickFont(value, bold, ctx.deva)).fontSize(size);
  if (doc.widthOfString(value) <= width) return value;
  let out = value;
  while (out.length > 1 && doc.widthOfString(out + '…') > width) out = out.slice(0, -1);
  return out + '…';
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, color: string = COLORS.rule, w = 0.6): void {
  ctx.doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(w).strokeColor(color).stroke();
}

function box(ctx: Ctx, x: number, y: number, w: number, h: number,
             { fill, stroke = COLORS.rule as string, lineWidth = 0.6, radius = 0 }:
             { fill?: string; stroke?: string | null; lineWidth?: number; radius?: number } = {}): void {
  const { doc } = ctx;
  if (radius > 0) doc.roundedRect(x, y, w, h, radius);
  else doc.rect(x, y, w, h);
  if (fill && stroke) doc.fillColor(fill).strokeColor(stroke).lineWidth(lineWidth).fillAndStroke();
  else if (fill) doc.fillColor(fill).fill();
  else if (stroke) doc.strokeColor(stroke).lineWidth(lineWidth).stroke();
}

const TITLES: Record<DocumentKind, string> = {
  TAX_INVOICE: 'TAX INVOICE',
  CASH_MEMO: 'CASH MEMO',
  ESTIMATE: 'ESTIMATE / QUOTATION',
  CREDIT_NOTE: 'CREDIT NOTE',
};

// ── Column layout ───────────────────────────────────────────────────────────
interface Column {
  key: string;
  label: string;
  width: number;
  align: 'left' | 'right' | 'center';
  /** The description column wraps; everything else is clipped to one line. */
  wrap?: boolean;
}

/**
 * Columns are chosen from what the document actually contains, not from a fixed
 * template: a non-GST memo has no tax columns to show, an intrastate bill splits
 * CGST/SGST where an interstate one shows a single IGST, and a discount column
 * only earns its width if some line carries a discount. The leftover width goes
 * to the description, which is the column that benefits from it.
 */
function buildColumns(model: DocumentModel): Column[] {
  const anyDiscount = model.lines.some((l) => Number(l.discount_amount ?? 0) > 0);
  const cols: Column[] = [
    { key: 'sr', label: '#', width: 18, align: 'right' },
    { key: 'desc', label: 'Particulars', width: 0, align: 'left', wrap: true },
  ];
  if (model.showTax) cols.push({ key: 'hsn', label: 'HSN', width: 40, align: 'left' });
  cols.push({ key: 'qty', label: 'Qty', width: 34, align: 'right' });
  cols.push({ key: 'unit', label: 'Unit', width: 30, align: 'left' });
  cols.push({ key: 'rate', label: 'Rate', width: 50, align: 'right' });
  if (anyDiscount) cols.push({ key: 'disc', label: 'Disc.', width: 42, align: 'right' });
  if (model.showTax) {
    cols.push({ key: 'taxable', label: 'Taxable', width: 56, align: 'right' });
    if (model.interstate) {
      cols.push({ key: 'igst', label: 'IGST', width: 32, align: 'right' });
      cols.push({ key: 'igsta', label: 'IGST Amt', width: 52, align: 'right' });
    } else {
      cols.push({ key: 'gstpct', label: 'GST%', width: 30, align: 'right' });
      cols.push({ key: 'cgst', label: 'CGST', width: 45, align: 'right' });
      cols.push({ key: 'sgst', label: 'SGST', width: 45, align: 'right' });
    }
  }
  cols.push({ key: 'total', label: 'Amount', width: 62, align: 'right' });

  const fixed = cols.reduce((s, c) => s + c.width, 0);
  const desc = cols.find((c) => c.key === 'desc')!;
  desc.width = Math.max(PAGE.contentWidth - fixed - 8, 90);
  return cols;
}

function cellValue(col: Column, l: DocumentLine, index: number): string {
  switch (col.key) {
    case 'sr':      return String(index + 1);
    case 'desc':    return l.description;
    case 'hsn':     return l.hsn_code ?? '—';
    case 'qty':     return qty(l.qty);
    case 'unit':    return l.unit_label ?? '';
    case 'rate':    return money(l.rate);
    case 'disc':    return money(l.discount_amount ?? 0, { blankZero: true });
    case 'taxable': return money(l.taxable_value);
    case 'gstpct':  return `${Number(l.gst_rate_pct ?? 0)}%`;
    case 'igst':    return `${Number(l.gst_rate_pct ?? 0)}%`;
    case 'igsta':   return money(l.igst_amount ?? 0);
    case 'cgst':    return money(l.cgst_amount ?? 0);
    case 'sgst':    return money(l.sgst_amount ?? 0);
    case 'total':   return money(l.line_total);
    default:        return '';
  }
}

// ── The renderer ────────────────────────────────────────────────────────────

export async function renderDocument(model: DocumentModel): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    try {
      const doc: Doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        // Page numbering cannot be written until the total is known, so pages are
        // buffered and the footer stamped in a second pass at the end.
        bufferPages: true,
        info: {
          Title: `${model.title ?? TITLES[model.kind]} ${model.meta.find(([k]) => /no\.?$/i.test(k))?.[1] ?? ''}`.trim(),
          Author: model.business.name,
          Creator: 'BHAWANI ONE',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fontPath = devanagariFontPath();
      let deva = false;
      if (fontPath) {
        try { doc.registerFont(FONTS.deva, fontPath); deva = true; } catch { deva = false; }
      }
      const ctx: Ctx = { doc, deva };

      const accent = model.kind === 'ESTIMATE' ? COLORS.accent : COLORS.primary;
      const accentSoft = model.kind === 'ESTIMATE' ? COLORS.accentSoft : COLORS.primarySoft;

      // ── Header ───────────────────────────────────────────────────────────
      const drawHeader = (continued: boolean): number => {
        let y = PAGE.margin;
        const b = model.business;

        // Identity block. A logo if one is configured and readable, otherwise a
        // monogram tile — a shop without an uploaded logo should still get a
        // document that looks designed rather than one with a hole in it.
        let identityX = PAGE.left;
        const logoSize = 44;
        let logoDrawn = false;
        if (b.logo) {
          try {
            const src = b.logo.startsWith('data:')
              ? Buffer.from(b.logo.slice(b.logo.indexOf(',') + 1), 'base64')
              : b.logo;
            doc.image(src, PAGE.left, y, { fit: [logoSize, logoSize] });
            logoDrawn = true;
          } catch {
            // An unreadable logo must never take the whole document down with it.
            logoDrawn = false;
          }
        }
        if (!logoDrawn) {
          box(ctx, PAGE.left, y, logoSize, logoSize, { fill: accent, stroke: null, radius: 4 });
          const monogram = (b.name || 'B').trim().split(/\s+/).slice(0, 2)
            .map((w) => w[0]).join('').toUpperCase();
          text(ctx, monogram, PAGE.left, y + 14, {
            width: logoSize, align: 'center', size: 17, bold: true, color: '#ffffff',
          });
        }
        identityX = PAGE.left + logoSize + 10;

        const identityWidth = 300;
        let iy = y - 1;
        text(ctx, b.name, identityX, iy, { size: TYPE.businessName, bold: true, color: COLORS.primary, width: identityWidth });
        iy = doc.y + 1;
        if (b.dealing_in) {
          text(ctx, b.dealing_in, identityX, iy, { size: TYPE.bodySmall, color: COLORS.muted, width: identityWidth, lineGap: 0.5 });
          iy = doc.y + 1;
        }
        const addressBits = [b.address, b.city_state].filter(Boolean).join(', ');
        if (addressBits) {
          text(ctx, addressBits, identityX, iy, { size: TYPE.bodySmall, color: COLORS.inkSoft, width: identityWidth, lineGap: 0.5 });
          iy = doc.y + 1;
        }
        const contact = [
          b.phone && `Ph: ${b.phone}${b.alt_phone ? ', ' + b.alt_phone : ''}`,
          b.email, b.website,
        ].filter(Boolean).join('  •  ');
        if (contact) {
          text(ctx, contact, identityX, iy, { size: TYPE.bodySmall, color: COLORS.inkSoft, width: identityWidth });
          iy = doc.y;
        }

        // Document title block, right-aligned.
        const titleW = 180;
        const titleX = PAGE.right - titleW;
        const title = model.title ?? TITLES[model.kind];
        box(ctx, titleX, y, titleW, 26, { fill: accent, stroke: null, radius: 3 });
        text(ctx, title, titleX, y + 8, { width: titleW, align: 'center', size: 11, bold: true, color: '#ffffff' });
        let ty = y + 31;
        if (model.showTax && b.gstin) {
          text(ctx, `GSTIN  ${b.gstin}`, titleX, ty, { width: titleW, align: 'right', size: TYPE.bodySmall, bold: true, color: COLORS.ink });
          ty = doc.y + 1;
        }
        const stateLine = [b.state, b.state_code && `Code ${b.state_code}`].filter(Boolean).join('  •  ');
        if (stateLine) {
          text(ctx, stateLine, titleX, ty, { width: titleW, align: 'right', size: TYPE.bodySmall, color: COLORS.muted });
          ty = doc.y;
        }

        y = Math.max(iy, ty, y + logoSize) + 8;
        line(ctx, PAGE.left, y, PAGE.right, y, accent, 1.4);
        y += 10;

        if (continued) {
          text(ctx, 'continued', PAGE.left, y, { size: TYPE.micro, color: COLORS.faint, width: PAGE.contentWidth, align: 'right' });
          y += 10;
        }
        return y;
      };

      // ── Parties + metadata ───────────────────────────────────────────────
      const drawParties = (startY: number): number => {
        const gap = 10;
        const colW = (PAGE.contentWidth - gap * 2) / 3;
        const boxes: Array<{ label: string; lines: Array<[string, string] | string> }> = [];

        const partyLines = (p: DocumentParty | null): Array<[string, string] | string> => {
          if (!p) return ['Walk-in customer'];
          const out: Array<[string, string] | string> = [];
          if (p.company) out.push(p.company);
          out.push(p.name);
          if (p.address) out.push(p.address);
          if (p.phone) out.push(`Ph: ${p.phone}`);
          if (p.gstin) out.push(['GSTIN', p.gstin]);
          const st = [p.state, p.state_code && `Code ${p.state_code}`].filter(Boolean).join(' • ');
          if (st) out.push(['State', st]);
          return out;
        };

        boxes.push({ label: model.kind === 'ESTIMATE' ? 'Estimate For' : 'Bill To', lines: partyLines(model.billTo) });
        if (model.shipTo) boxes.push({ label: 'Ship To / Place of Delivery', lines: partyLines(model.shipTo) });
        boxes.push({ label: 'Details', lines: model.meta.map(([k, v]) => [k, v] as [string, string]) });

        // Every box is drawn to the same height so the row reads as one band.
        const measure = (bx: typeof boxes[number], width: number): number => {
          let h = 14;
          for (const l of bx.lines) {
            if (Array.isArray(l)) h += 10;
            else h += heightOf(ctx, l, width - 14, TYPE.bodySmall) + 1;
          }
          return h + 8;
        };
        const widths = boxes.length === 3
          ? [colW, colW, colW]
          : [(PAGE.contentWidth - gap) * 0.55, (PAGE.contentWidth - gap) * 0.45];
        const boxH = Math.max(...boxes.map((b, i) => measure(b, widths[i])), 62);

        let x = PAGE.left;
        boxes.forEach((bx, i) => {
          const w = widths[i];
          box(ctx, x, startY, w, boxH, { fill: i === boxes.length - 1 ? accentSoft : COLORS.paper, stroke: COLORS.rule, radius: 3 });
          text(ctx, bx.label.toUpperCase(), x + 7, startY + 6, {
            size: TYPE.sectionLabel, bold: true, color: accent, width: w - 14,
          });
          let ly = startY + 17;
          for (const l of bx.lines) {
            if (Array.isArray(l)) {
              const [k, v] = l;
              text(ctx, k, x + 7, ly, { size: TYPE.bodySmall, color: COLORS.muted, width: (w - 14) * 0.42 });
              text(ctx, clip(ctx, v, (w - 14) * 0.58, TYPE.bodySmall, true), x + 7 + (w - 14) * 0.42, ly, {
                size: TYPE.bodySmall, bold: true, color: COLORS.ink, width: (w - 14) * 0.58, align: 'right',
              });
              ly += 10;
            } else {
              text(ctx, l, x + 7, ly, { size: TYPE.bodySmall, color: COLORS.inkSoft, width: w - 14, lineGap: 0.5 });
              ly = doc.y + 1;
            }
          }
          x += w + gap;
        });
        return startY + boxH + 12;
      };

      // ── Items table ──────────────────────────────────────────────────────
      const cols = buildColumns(model);
      const colX: number[] = [];
      {
        let x = PAGE.left;
        for (const c of cols) { colX.push(x); x += c.width; }
      }
      let tableRight = colX[colX.length - 1] + cols[cols.length - 1].width;

      const drawTableHead = (y: number): number => {
        const h = 17;
        box(ctx, PAGE.left, y, tableRight - PAGE.left, h, { fill: accent, stroke: null });
        cols.forEach((c, i) => {
          text(ctx, c.label, colX[i] + 3, y + 5, {
            width: c.width - 6, align: c.align, size: TYPE.tableHeader, bold: true, color: '#ffffff',
          });
        });
        return y + h;
      };

      const measureRow = (l: DocumentLine): number => {
        const descCol = cols.find((c) => c.key === 'desc')!;
        let h = heightOf(ctx, l.description, descCol.width - 6, cellSize);
        if (l.sku) h += 8;
        if (l.note) h += heightOf(ctx, l.note, descCol.width - 6, TYPE.micro) + 1;
        return Math.max(h + 8, 20);
      };

      // ── Closing block (totals → signature), measured as one unit ─────────
      const summaryRows: Array<[string, string, boolean?]> = [];
      if (model.totals.gross !== undefined && Number(model.totals.gross) !== model.totals.taxable_total) {
        summaryRows.push(['Gross value', money(model.totals.gross)]);
      }
      if (Number(model.totals.discount_total) > 0) {
        summaryRows.push(['Less: discount', `(-) ${money(model.totals.discount_total)}`]);
      }
      summaryRows.push([model.showTax ? 'Taxable value' : 'Subtotal', money(model.totals.taxable_total)]);
      if (model.showTax) {
        if (model.interstate) {
          summaryRows.push(['IGST', money(model.totals.igst_total)]);
        } else {
          summaryRows.push(['CGST', money(model.totals.cgst_total)]);
          summaryRows.push(['SGST', money(model.totals.sgst_total)]);
        }
      }
      if (Number(model.totals.round_off) !== 0) {
        summaryRows.push(['Round off', `${Number(model.totals.round_off) > 0 ? '(+) ' : '(-) '}${money(Math.abs(Number(model.totals.round_off)))}`]);
      }

      // HSN-wise tax summary — what a GST return is actually reconciled against.
      const hsnSummary = (() => {
        if (!model.showTax) return [];
        const map = new Map<string, { hsn: string; rate: number; taxable: number; cgst: number; sgst: number; igst: number }>();
        for (const l of model.lines) {
          const key = `${l.hsn_code ?? '—'}|${Number(l.gst_rate_pct ?? 0)}`;
          const row = map.get(key) ?? { hsn: l.hsn_code ?? '—', rate: Number(l.gst_rate_pct ?? 0), taxable: 0, cgst: 0, sgst: 0, igst: 0 };
          row.taxable += Number(l.taxable_value);
          row.cgst += Number(l.cgst_amount ?? 0);
          row.sgst += Number(l.sgst_amount ?? 0);
          row.igst += Number(l.igst_amount ?? 0);
          map.set(key, row);
        }
        return [...map.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
      })();

      const terms = [...(model.business.terms ?? []), ...(model.extraTerms ?? [])].filter(Boolean);

      const drawClosing = (startY: number): number => {
        let y = startY;
        const rightW = 210;
        const rightX = PAGE.right - rightW;
        const leftW = PAGE.contentWidth - rightW - 12;

        // ── HSN / tax summary (left) ─────────────────────────────────────
        let leftY = y;
        if (hsnSummary.length) {
          text(ctx, 'TAX SUMMARY', PAGE.left, leftY, { size: TYPE.sectionLabel, bold: true, color: accent });
          leftY += 11;
          const w = leftW;
          const sc = model.interstate
            ? [{ l: 'HSN', w: w * 0.26, a: 'left' as const }, { l: 'Rate', w: w * 0.14, a: 'right' as const },
               { l: 'Taxable', w: w * 0.30, a: 'right' as const }, { l: 'IGST', w: w * 0.30, a: 'right' as const }]
            : [{ l: 'HSN', w: w * 0.24, a: 'left' as const }, { l: 'Rate', w: w * 0.12, a: 'right' as const },
               { l: 'Taxable', w: w * 0.26, a: 'right' as const }, { l: 'CGST', w: w * 0.19, a: 'right' as const },
               { l: 'SGST', w: w * 0.19, a: 'right' as const }];
          box(ctx, PAGE.left, leftY, w, 14, { fill: COLORS.primarySoft, stroke: COLORS.rule });
          let sx = PAGE.left;
          sc.forEach((c) => {
            text(ctx, c.l, sx + 3, leftY + 4, { width: c.w - 6, align: c.a, size: TYPE.micro, bold: true, color: COLORS.primary });
            sx += c.w;
          });
          leftY += 14;
          for (const r of hsnSummary) {
            const vals = model.interstate
              ? [r.hsn, `${r.rate}%`, money(r.taxable), money(r.igst)]
              : [r.hsn, `${r.rate}%`, money(r.taxable), money(r.cgst), money(r.sgst)];
            sx = PAGE.left;
            sc.forEach((c, i) => {
              text(ctx, clip(ctx, vals[i], c.w - 6, TYPE.micro), sx + 3, leftY + 3.5, {
                width: c.w - 6, align: c.a, size: TYPE.micro, color: COLORS.inkSoft,
              });
              sx += c.w;
            });
            leftY += 12;
            line(ctx, PAGE.left, leftY - 1, PAGE.left + w, leftY - 1, COLORS.ruleSoft, 0.4);
          }
          leftY += 6;
        }

        // ── Totals (right) ────────────────────────────────────────────────
        let ry = y;
        box(ctx, rightX, ry, rightW, summaryRows.length * 13 + 8, { fill: COLORS.paper, stroke: COLORS.rule, radius: 3 });
        ry += 5;
        for (const [label, value] of summaryRows) {
          text(ctx, label, rightX + 8, ry, { size: TYPE.bodySmall, color: COLORS.inkSoft, width: rightW * 0.55 });
          text(ctx, value, rightX + rightW * 0.55 - 8, ry, {
            size: TYPE.bodySmall, color: COLORS.ink, width: rightW * 0.45, align: 'right',
          });
          ry += 13;
        }
        ry += 3;
        box(ctx, rightX, ry, rightW, 24, { fill: accent, stroke: null, radius: 3 });
        text(ctx, model.kind === 'ESTIMATE' ? 'Estimated Total' : model.kind === 'CREDIT_NOTE' ? 'Credit Total' : 'Grand Total', rightX + 8, ry + 7.5, {
          size: TYPE.totalLabel, bold: true, color: '#ffffff', width: rightW * 0.5,
        });
        text(ctx, `Rs. ${money(model.totals.grand_total)}`, rightX + rightW * 0.5 - 8, ry + 6, {
          size: TYPE.grandTotal, bold: true, color: '#ffffff', width: rightW * 0.5, align: 'right',
        });
        ry += 28;

        if (model.payments?.length) {
          text(ctx, 'PAYMENT', rightX, ry, { size: TYPE.sectionLabel, bold: true, color: accent });
          ry += 10;
          for (const p of model.payments) {
            const label = `${p.method.replace(/_/g, ' ')}${p.ref_no ? ` · ${p.ref_no}` : ''}`;
            text(ctx, clip(ctx, label, rightW * 0.6, TYPE.bodySmall), rightX, ry, { size: TYPE.bodySmall, color: COLORS.inkSoft, width: rightW * 0.6 });
            text(ctx, money(p.amount), rightX + rightW * 0.6, ry, { size: TYPE.bodySmall, color: COLORS.ink, width: rightW * 0.4, align: 'right' });
            ry += 11;
          }
        }
        if (model.balance_due !== null && model.balance_due !== undefined && Number(model.balance_due) > 0) {
          ry += 2;
          text(ctx, 'Balance due', rightX, ry, { size: TYPE.bodySmall, bold: true, color: COLORS.danger, width: rightW * 0.6 });
          text(ctx, money(model.balance_due), rightX + rightW * 0.6, ry, {
            size: TYPE.bodySmall, bold: true, color: COLORS.danger, width: rightW * 0.4, align: 'right',
          });
          ry += 12;
        }

        y = Math.max(leftY, ry) + 4;

        // ── Amount in words ───────────────────────────────────────────────
        const words = amountInWords(Number(model.totals.grand_total));
        const wordsH = heightOf(ctx, words, PAGE.contentWidth - 90, TYPE.bodySmall, true) + 12;
        box(ctx, PAGE.left, y, PAGE.contentWidth, wordsH, { fill: COLORS.primarySoft, stroke: COLORS.rule, radius: 3 });
        text(ctx, 'Amount in words', PAGE.left + 8, y + 5, { size: TYPE.micro, color: COLORS.muted, width: 80 });
        text(ctx, words, PAGE.left + 88, y + 4, { size: TYPE.bodySmall, bold: true, color: COLORS.ink, width: PAGE.contentWidth - 96 });
        y += wordsH + 8;

        // ── Notes ─────────────────────────────────────────────────────────
        if (model.notes) {
          text(ctx, 'Note', PAGE.left, y, { size: TYPE.micro, bold: true, color: COLORS.muted });
          text(ctx, model.notes, PAGE.left + 30, y, { size: TYPE.bodySmall, color: COLORS.inkSoft, width: PAGE.contentWidth - 30 });
          y = doc.y + 6;
        }

        // ── Bank / UPI, terms, signature ──────────────────────────────────
        const b = model.business;
        const bankBits: Array<[string, string]> = [];
        if (b.bank_name) bankBits.push(['Bank', [b.bank_name, b.bank_branch].filter(Boolean).join(', ')]);
        if (b.bank_account_no) bankBits.push(['A/c No.', b.bank_account_no]);
        if (b.bank_ifsc) bankBits.push(['IFSC', b.bank_ifsc]);
        if (b.upi_id) bankBits.push(['UPI', b.upi_id]);

        const sigW = 170;
        const sigX = PAGE.right - sigW;
        const leftColW = PAGE.contentWidth - sigW - 14;
        let ly = y;

        if (bankBits.length) {
          text(ctx, 'BANK / PAYMENT DETAILS', PAGE.left, ly, { size: TYPE.sectionLabel, bold: true, color: accent });
          ly += 10;
          for (const [k, v] of bankBits) {
            text(ctx, k, PAGE.left, ly, { size: TYPE.bodySmall, color: COLORS.muted, width: 52 });
            text(ctx, clip(ctx, v, leftColW - 56, TYPE.bodySmall, true), PAGE.left + 54, ly, {
              size: TYPE.bodySmall, bold: true, color: COLORS.ink, width: leftColW - 56,
            });
            ly += 10;
          }
          ly += 3;
        }
        if (terms.length) {
          text(ctx, 'TERMS & CONDITIONS', PAGE.left, ly, { size: TYPE.sectionLabel, bold: true, color: accent });
          ly += 10;
          terms.slice(0, 6).forEach((t, i) => {
            text(ctx, `${i + 1}. ${t}`, PAGE.left, ly, { size: TYPE.micro, color: COLORS.inkSoft, width: leftColW, lineGap: 0.5 });
            ly = doc.y + 1;
          });
          ly += 3;
        }
        if (b.declaration) {
          text(ctx, 'DECLARATION', PAGE.left, ly, { size: TYPE.sectionLabel, bold: true, color: accent });
          ly += 10;
          text(ctx, b.declaration, PAGE.left, ly, { size: TYPE.micro, color: COLORS.inkSoft, width: leftColW, lineGap: 0.5 });
          ly = doc.y + 4;
        }

        // Signature panel, aligned to the top of the same band.
        const sigTop = y;
        text(ctx, `For ${b.legal_name || b.name}`, sigX, sigTop, {
          size: TYPE.bodySmall, bold: true, color: COLORS.ink, width: sigW, align: 'right',
        });
        const sigLineY = Math.max(doc.y + 34, sigTop + 46);
        line(ctx, sigX, sigLineY, PAGE.right, sigLineY, COLORS.rule, 0.6);
        text(ctx, b.signature_label || 'Authorised Signatory', sigX, sigLineY + 4, {
          size: TYPE.bodySmall, color: COLORS.muted, width: sigW, align: 'right',
        });

        return Math.max(ly, sigLineY + 18);
      };

      const measureClosing = (): number => {
        // A generous estimate is the right kind of wrong here: over-reserving
        // pushes the closing block to a clean page, while under-reserving would
        // let the signature collide with the footer.
        let h = summaryRows.length * 13 + 8 + 28 + 12;
        if (hsnSummary.length) h = Math.max(h, hsnSummary.length * 12 + 30);
        if (model.payments?.length) h += model.payments.length * 11 + 12;
        h += 34; // amount in words
        if (model.notes) h += 22;
        const bankCount = [model.business.bank_name, model.business.bank_account_no,
                           model.business.bank_ifsc, model.business.upi_id].filter(Boolean).length;
        if (bankCount) h += bankCount * 10 + 14;
        if (terms.length) h += Math.min(terms.length, 6) * 12 + 14;
        if (model.business.declaration) h += 30;
        return h + 16;
      };

      // ── Watermark ────────────────────────────────────────────────────────
      const drawWatermark = () => {
        if (!model.watermark) return;
        doc.save();
        doc.rotate(-32, { origin: [PAGE.width / 2, PAGE.height / 2] });
        doc.font(FONTS.bold).fontSize(58).fillColor(COLORS.danger).opacity(0.1);
        doc.text(model.watermark, 0, PAGE.height / 2 - 40, { width: PAGE.width, align: 'center' });
        doc.opacity(1).restore();
      };

      const footTotals: Record<string, string> = {
        qty: qty(model.lines.reduce((s, l) => s + Number(l.qty), 0)),
        disc: money(model.lines.reduce((s, l) => s + Number(l.discount_amount ?? 0), 0), { blankZero: true }),
        taxable: money(model.totals.taxable_total),
        cgst: money(model.totals.cgst_total),
        sgst: money(model.totals.sgst_total),
        igsta: money(model.totals.igst_total),
        total: money(model.lines.reduce((s, l) => s + Number(l.line_total), 0)),
      };
      const footTotalFor = (key: string): string | undefined => footTotals[key];

      // ── Fit the money columns to the actual figures ──────────────────────
      // Column widths cannot be fixed constants: a shop billing ₹45 pipe fittings
      // and a shop billing an ₹18,75,450 consignment need different amounts of
      // room, and a fixed width turns the second one into "18,75,450…" — a
      // clipped figure on a tax invoice, which is worse than an ugly one.
      //
      // Every column is measured against its header, every cell it will hold, and
      // its own total row, then grown to fit. The slack comes out of the
      // description column, which wraps and can afford it; if even that runs out,
      // the table steps down a point size rather than truncating a number.
      const fitColumns = (): number => {
        const base = cols.map((c) => c.width);
        const MIN_DESC = 100;
        const budget = PAGE.contentWidth - 4;

        const grow = (size: number): number => {
          cols.forEach((c, i) => { c.width = base[i]; });
          for (const c of cols) {
            if (c.key === 'desc') continue;
            doc.font(FONTS.bold).fontSize(TYPE.tableHeader);
            let needed = doc.widthOfString(c.label);
            // The totals row is bold at the cell size, not the header size.
            doc.font(FONTS.bold).fontSize(size);
            const foot = footTotalFor(c.key);
            if (foot) needed = Math.max(needed, doc.widthOfString(foot));
            doc.font(FONTS.regular).fontSize(size);
            model.lines.forEach((l, i) => {
              needed = Math.max(needed, doc.widthOfString(cellValue(c, l, i)));
            });
            c.width = Math.max(c.width, Math.ceil(needed) + 8);
          }
          return cols.filter((c) => c.key !== 'desc').reduce((sum, c) => sum + c.width, 0);
        };

        const desc = cols.find((c) => c.key === 'desc')!;
        for (const size of [TYPE.tableCell, 7.5, 7, 6.5, 6]) {
          const fixed = grow(size);
          if (budget - fixed >= MIN_DESC) {
            desc.width = budget - fixed;
            return size;
          }
        }

        // Genuinely more digits than an A4 page has room for. The table must still
        // fit the page — a column running off the right edge is the one outcome
        // that is never acceptable — so the money columns are scaled back
        // proportionally and their contents ellipsised. The figures stay readable
        // in the totals block and the tax summary, which are not width-bound.
        const fixed = grow(6);
        const overflow = fixed + MIN_DESC - budget;
        const shrinkable = cols.filter((c) => c.key !== 'desc' && c.width > 30);
        const totalShrinkable = shrinkable.reduce((sum, c) => sum + c.width, 0);
        for (const c of shrinkable) {
          c.width = Math.max(30, c.width - (overflow * (c.width / totalShrinkable)));
        }
        desc.width = Math.max(
          MIN_DESC,
          budget - cols.filter((c) => c.key !== 'desc').reduce((sum, c) => sum + c.width, 0),
        );
        return 6;
      };

      const cellSize = fitColumns();
      {
        let x = PAGE.left;
        colX.length = 0;
        for (const c of cols) { colX.push(x); x += c.width; }
      }
      tableRight = colX[colX.length - 1] + cols[cols.length - 1].width;

      // ── Compose ──────────────────────────────────────────────────────────
      drawWatermark();
      let y = drawHeader(false);
      y = drawParties(y);
      y = drawTableHead(y);

      const closingH = measureClosing();
      let rowIndex = 0;
      let zebra = false;
      const descCol = cols.find((c) => c.key === 'desc')!;
      const descIdx = cols.indexOf(descCol);

      for (const l of model.lines) {
        const rowH = measureRow(l);
        if (y + rowH > PAGE.bodyBottom) {
          doc.addPage();
          drawWatermark();
          y = drawHeader(true);
          y = drawTableHead(y);
          zebra = false;
        }
        if (zebra) box(ctx, PAGE.left, y, tableRight - PAGE.left, rowH, { fill: COLORS.zebra, stroke: null });
        zebra = !zebra;

        cols.forEach((c, i) => {
          if (i === descIdx) return;
          text(ctx, clip(ctx, cellValue(c, l, rowIndex), c.width - 6, cellSize), colX[i] + 3, y + 5, {
            width: c.width - 6, align: c.align, size: cellSize, color: COLORS.ink,
          });
        });
        // The description wraps, and carries its SKU and any note beneath it.
        text(ctx, l.description, colX[descIdx] + 3, y + 5, {
          width: descCol.width - 6, size: cellSize, color: COLORS.ink, lineGap: 0.5,
        });
        let dy = doc.y;
        if (l.sku) {
          text(ctx, l.sku, colX[descIdx] + 3, dy, { width: descCol.width - 6, size: TYPE.micro, color: COLORS.faint });
          dy = doc.y;
        }
        if (l.note) {
          text(ctx, l.note, colX[descIdx] + 3, dy, { width: descCol.width - 6, size: TYPE.micro, color: COLORS.muted, oblique: true });
        }

        y += rowH;
        line(ctx, PAGE.left, y, tableRight, y, COLORS.ruleSoft, 0.4);
        rowIndex += 1;
      }

      if (!model.lines.length) {
        text(ctx, 'No items on this document.', PAGE.left, y + 10, {
          width: PAGE.contentWidth, align: 'center', size: TYPE.bodySmall, color: COLORS.faint,
        });
        y += 26;
      }

      // ── Fill the rest of the table body ─────────────────────────────────
      // A three-line bill on an A4 page otherwise leaves a lake of white between
      // the last item and the totals, which reads as a broken document rather
      // than a short one. The shop's existing bill book solves this with ruled
      // empty rows, and that is what this is: the table is extended with blank
      // ruled rows down to where the closing block begins, so a 1-item bill and
      // a 20-item bill have their totals in the same place on the page.
      // Reserve what still has to fit below the fill: the column-totals row (18),
      // the rule and gap after it (12), and the whole closing block. Getting this
      // arithmetic wrong does not look like a rounding error — it pushes the
      // totals onto a second page and turns a one-page bill into "Page 1 of 2".
      const FOOT_ROW_H = 18;
      const bodyFloor = PAGE.bodyBottom - closingH - FOOT_ROW_H - 12;
      if (y < bodyFloor) {
        const blankH = 15;
        while (y + blankH <= bodyFloor) {
          if (zebra) box(ctx, PAGE.left, y, tableRight - PAGE.left, blankH, { fill: COLORS.zebra, stroke: null });
          zebra = !zebra;
          y += blankH;
          line(ctx, PAGE.left, y, tableRight, y, COLORS.ruleSoft, 0.4);
        }
      }

      // ── Column totals ───────────────────────────────────────────────────
      // The figures at the foot of each money column, so a reader can see the
      // table add up to the grand total rather than having to take it on trust.
      const footH = FOOT_ROW_H;
      if (y + footH > PAGE.bodyBottom) {
        doc.addPage();
        drawWatermark();
        y = drawHeader(true);
        y = drawTableHead(y);
      }
      box(ctx, PAGE.left, y, tableRight - PAGE.left, footH, { fill: COLORS.primarySoft, stroke: null });
      cols.forEach((c, i) => {
        if (c.key === 'desc') {
          text(ctx, 'Total', colX[i] + 3, y + 5.5, {
            width: c.width - 6, size: cellSize, bold: true, color: COLORS.primary,
          });
          return;
        }
        const v = footTotalFor(c.key);
        if (!v) return;
        // Clipped and drawn at the fitted cell size: the totals row is bold, so
        // at a larger size it needs more room than the column was fitted for and
        // wraps onto a second line, splitting a figure across two rows.
        text(ctx, clip(ctx, v, c.width - 6, cellSize, true), colX[i] + 3, y + 5.5, {
          width: c.width - 6, align: c.align, size: cellSize, bold: true, color: COLORS.primary,
        });
      });
      y += footH;
      line(ctx, PAGE.left, y, tableRight, y, COLORS.rule, 0.8);
      y += 12;

      if (y + closingH > PAGE.bodyBottom) {
        doc.addPage();
        drawWatermark();
        y = drawHeader(true);
      }
      drawClosing(y);

      // ── Footer, stamped once the page count is known ─────────────────────
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        const fy = PAGE.footerTop;
        line(ctx, PAGE.left, fy, PAGE.right, fy, COLORS.rule, 0.6);
        const note = model.business.footer_note
          ?? (model.kind === 'ESTIMATE'
            ? 'This is an estimate, not a tax invoice. Prices are subject to change until the order is confirmed.'
            : model.kind === 'CREDIT_NOTE'
              ? 'Credit note against the invoice shown above, for goods returned. Computer-generated.'
            : model.showTax
              ? 'Computer-generated tax invoice. GST is computed per line and rounded to two decimals (half-up).'
              : 'Computer-generated bill. No GST has been charged on this transaction.');
        text(ctx, note, PAGE.left, fy + 6, {
          width: PAGE.contentWidth - 90, size: TYPE.micro, color: COLORS.muted, lineGap: 0.5,
        });
        if (model.business.jurisdiction) {
          text(ctx, `Subject to ${model.business.jurisdiction} jurisdiction`, PAGE.left, fy + 6 + 16, {
            width: PAGE.contentWidth - 90, size: TYPE.micro, color: COLORS.faint,
          });
        }
        text(ctx, `Page ${i + 1} of ${range.count}`, PAGE.right - 90, fy + 6, {
          width: 90, align: 'right', size: TYPE.micro, color: COLORS.muted,
        });
      }
      // Leaving the cursor on a buffered page and calling end() can append a blank
      // page; flushing explicitly is what stops that.
      doc.flushPages();
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
