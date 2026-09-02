// ============================================================================
// Money, units and GST. Every rupee figure in the system passes through here, so
// billing (3.1), quotations (5) and credit notes (12.1.1) cannot disagree.
// ============================================================================

/**
 * 3.1.1 — half-up rounding to 2 decimals, done on integers.
 *
 * `Math.round(x * 100) / 100` is subtly wrong for money: 1.005 is stored as
 * 1.00499999999999989, so it rounds DOWN, and a GST auditor reconciling GSTR-1
 * sees a one-paisa mismatch. Rounding the decimal string instead removes the
 * binary-representation problem entirely.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const negative = value < 0;
  const n = Math.abs(value);
  // toFixed already rounds half-away-from-zero on the decimal representation.
  const r = Number(n.toFixed(2));
  // Guard the rare case where toFixed itself hit a representation edge.
  const scaled = Math.round(Number((n * 100).toFixed(6)));
  const result = Math.abs(r * 100 - scaled) > 0.5 ? scaled / 100 : r;
  return negative ? -result : result;
}

export function roundTo(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(Number((value * f).toFixed(6))) / f;
}

export interface LineInput {
  qty_in_sale_unit: number;
  /** 2.2.1 — how many base units one sale unit is worth. 1 for the base unit itself. */
  multiplier_to_base: number;
  /** Catalog price PER BASE UNIT, snapshotted when the line was scanned (3.10). */
  rate_per_base_unit: number;
  gst_rate_pct: number;
  price_type: 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';
  discount_amount?: number;
  /** True when buyer and seller are in different states (12.1.1 / 15). */
  interstate?: boolean;
}

export interface ComputedLine {
  base_unit_qty: number;
  gross: number;
  discount_amount: number;
  taxable_value: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  line_total: number;
}

/**
 * 2.2.1 — the whole point of the base-unit rule: 3 screws out of a 100-piece box
 * must evaluate as 3 × (box_price ÷ 100), never as a separately typed price. We
 * therefore convert the cashier's quantity into base units FIRST and price off
 * the per-base-unit rate, rather than pricing the sale unit directly.
 *
 * 3.1.1 — tax is computed on the line's taxable value AFTER any line discount,
 * and each component is rounded half-up to 2dp at the line. The invoice total is
 * the sum of already-rounded line taxes, never a re-round of the grand total.
 */
export function computeLine(input: LineInput, roundingDp = 2): ComputedLine {
  const multiplier = input.multiplier_to_base > 0 ? input.multiplier_to_base : 1;
  const baseQty = roundTo(input.qty_in_sale_unit * multiplier, Math.max(roundingDp, 4));
  const gross = round2(baseQty * input.rate_per_base_unit);
  const discount = round2(Math.min(Math.max(input.discount_amount ?? 0, 0), gross));
  const net = round2(gross - discount);
  const rate = Math.max(input.gst_rate_pct ?? 0, 0);

  // A tax-inclusive price already contains the GST, so the taxable value has to be
  // extracted out of it rather than added on top. Getting this backwards is one of
  // the most expensive billing bugs there is (2.8), which is why price_type is
  // stored per line and never inferred.
  const taxable = rate > 0 && input.price_type === 'TAX_INCLUSIVE'
    ? round2(net / (1 + rate / 100))
    : net;

  let cgst = 0, sgst = 0, igst = 0;
  if (rate > 0) {
    if (input.interstate) {
      igst = round2((taxable * rate) / 100);
    } else {
      cgst = round2((taxable * (rate / 2)) / 100);
      sgst = cgst;   // CGST and SGST are always equal halves; deriving avoids drift
    }

    // On a TAX-INCLUSIVE line the customer pays the marked price, so the parts
    // must add back up to exactly that. Rounding the extracted taxable value and
    // then rounding each half of the tax independently can leave the line a paisa
    // over the sticker (Rs.100 at 18% -> 84.75 + 7.63 + 7.63 = 100.01). The last
    // paisa is absorbed into SGST/IGST, which is where a GST auditor expects a
    // rounding difference to sit.
    if (input.price_type === 'TAX_INCLUSIVE') {
      const drift = round2(net - (taxable + cgst + sgst + igst));
      if (drift !== 0) {
        if (input.interstate) igst = round2(igst + drift);
        else sgst = round2(sgst + drift);
      }
    }
  }

  return {
    base_unit_qty: baseQty,
    gross,
    discount_amount: discount,
    taxable_value: taxable,
    cgst_amount: cgst,
    sgst_amount: sgst,
    igst_amount: igst,
    line_total: round2(taxable + cgst + sgst + igst),
  };
}

export interface InvoiceTotals {
  subtotal: number;
  discount_total: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  tax_total: number;
  grand_total: number;
  round_off: number;
  payable: number;
}

/** Sums already-rounded line figures — the invoice total is never re-rounded (3.1.1). */
export function totalInvoice(lines: ComputedLine[], applyCashRounding = false): InvoiceTotals {
  const subtotal = round2(lines.reduce((s, l) => s + l.taxable_value, 0));
  const discount_total = round2(lines.reduce((s, l) => s + l.discount_amount, 0));
  const cgst_total = round2(lines.reduce((s, l) => s + l.cgst_amount, 0));
  const sgst_total = round2(lines.reduce((s, l) => s + l.sgst_amount, 0));
  const igst_total = round2(lines.reduce((s, l) => s + l.igst_amount, 0));
  const grand_total = round2(subtotal + cgst_total + sgst_total + igst_total);

  // Cash rounding to the nearest rupee is kept as its own explicit figure so the
  // GST-reported total and the amount collected stay separately reconcilable.
  const payable = applyCashRounding ? Math.round(grand_total) : grand_total;
  return {
    subtotal, discount_total, cgst_total, sgst_total, igst_total,
    tax_total: round2(cgst_total + sgst_total + igst_total),
    grand_total, round_off: round2(payable - grand_total), payable,
  };
}

/**
 * 12.1.1 / credit notes — a partial return's tax is derived PROPORTIONALLY from
 * the original line rather than recomputed from scratch, so a 1-of-3 return of a
 * discounted line cannot drift from the original invoice by rounding paise.
 */
export function computeReturnLine(
  original: {
    qty_in_sale_unit: number; base_unit_qty: number; taxable_value: number;
    cgst_amount: number; sgst_amount: number; igst_amount: number;
  },
  returnedBaseQty: number,
): { taxable_value: number; cgst_amount: number; sgst_amount: number; igst_amount: number; line_total: number } {
  const originalQty = Number(original.base_unit_qty) || 1;
  const ratio = Math.min(Math.max(returnedBaseQty / originalQty, 0), 1);
  const taxable = round2(Number(original.taxable_value) * ratio);
  const cgst = round2(Number(original.cgst_amount) * ratio);
  const sgst = round2(Number(original.sgst_amount) * ratio);
  const igst = round2(Number(original.igst_amount) * ratio);
  return { taxable_value: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst,
           line_total: round2(taxable + cgst + sgst + igst),
         };
}

/** Indian fiscal year, matching the SQL erp_fiscal_year() used for numbering. */
export function fiscalYear(at: Date = new Date()): string {
  const y = at.getFullYear();
  const startYear = at.getMonth() >= 3 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** 4.8.1 — weighted average, the only way branch_stock.weighted_avg_cost changes. */
export function newWeightedAvgCost(
  currentQty: number, currentCost: number, inQty: number, inRate: number,
): number {
  const total = currentQty + inQty;
  if (total <= 0) return roundTo(inRate, 4);
  // Negative existing stock would produce a nonsense average; treat it as zero.
  const safeQty = Math.max(currentQty, 0);
  const denom = safeQty + inQty;
  if (denom <= 0) return roundTo(inRate, 4);
  return roundTo((safeQty * currentCost + inQty * inRate) / denom, 4);
}
