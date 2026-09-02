// ============================================================================
// The billing engine — one pricing path, shared by every route that can produce
// a priced basket.
//
// Why this file exists: a bill can now be built two ways — posted straight to
// FINAL (the fast counter sale, and the offline replay), or prepared as a DRAFT,
// reviewed, edited, and then finalised. Those are two entry points to the *same*
// arithmetic, and if each one carried its own copy of it they would drift, which
// is precisely the failure the requirements document keeps warning about: a
// quotation, a preview and an invoice that disagree about the same basket.
//
// So the rule enforced here is: the client never supplies a computed figure.
// It supplies product ids, quantities, a locked rate and a discount; the server
// looks up the catalog, the unit multiplier and the GST rate that applied on the
// billing date, and computes everything else. Re-pricing a draft on every edit
// runs this exact function again, so a total shown on a review screen is a total
// the server produced, not one the browser added up.
// ============================================================================
import { sql } from 'kysely';
import type { Tx } from './db.js';
import { badRequest } from './errors.js';
import { num, oneOf, optionalUuid, uuid } from './http.js';
import { computeLine, round2, totalInvoice, type ComputedLine, type InvoiceTotals } from './tax.js';
import type { SETTING_DEFAULTS } from './settings.js';

export const PRICE_TYPES = ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const;
export const INVOICE_TYPES = ['GST', 'NON_GST'] as const;
export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'CREDIT', 'LOYALTY_POINTS'] as const;

export type InvoiceType = (typeof INVOICE_TYPES)[number];
export type PriceType = (typeof PRICE_TYPES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PreparedLine {
  product_id: string;
  product_unit_id: string | null;
  qty_in_sale_unit: number;
  computed: ComputedLine;
  price_type: PriceType;
  rate_locked_at_scan: number;
  catalog_rate: number;
  implied_discount: number;
  batch_id: string | null;
  tint: { base_shade?: string | null; tint_formula?: string | null } | null;
  serials: string[];
  product_name: string;
  hsn_code: string | null;
  gst_rate_pct: number;
  unit_label: string | null;
}

export interface PricedBasket {
  lines: PreparedLine[];
  totals: InvoiceTotals;
  /** Catalog value of the basket, the denominator for the 3.4 discount ceiling. */
  catalog_value: number;
  /** Everything given away — typed discounts AND rate reductions (3.4 / 3.10). */
  given_away: number;
  discount_pct: number;
  interstate: boolean;
  place_of_supply_state_code: string | null;
}

export interface RawLineInput {
  product_id: unknown;
  qty_in_sale_unit: unknown;
  product_unit_id?: unknown;
  rate_locked_at_scan?: unknown;
  price_type?: unknown;
  discount_amount?: unknown;
  batch_id?: unknown;
  scanned_barcode?: unknown;
  serial_numbers?: unknown;
  tint?: { base_shade?: string | null; tint_formula?: string | null } | null;
}

/**
 * Prices a basket against the catalog.
 *
 * `asOf` is the date the GST rate is resolved against (2.7 tax-rate versioning) —
 * always the server's clock, never the till's, so a device with a wrong date
 * cannot pull a superseded rate.
 *
 * `repriceFromCatalog` distinguishes the two things a caller can mean by an edit:
 *   false (the default) — keep the rate locked into the cart at scan time (3.10),
 *          which is what an ordinary edit does: change a quantity, not the price.
 *   true  — the explicit "refresh prices" action, the ONLY sanctioned way a line
 *          re-reads the catalog, per 3.10.
 */
export async function priceBasket(trx: Tx, opts: {
  branchId: string;
  invoiceType: InvoiceType;
  rawLines: RawLineInput[];
  settings: typeof SETTING_DEFAULTS;
  branchStateCode: string | null;
  placeOfSupplyStateCode?: string | null;
  applyCashRounding?: boolean;
  asOf?: Date;
  repriceFromCatalog?: boolean;
}): Promise<PricedBasket> {
  const {
    branchId, invoiceType, rawLines, settings, branchStateCode,
    applyCashRounding = false, repriceFromCatalog = false,
  } = opts;

  const placeOfSupply = opts.placeOfSupplyStateCode ?? branchStateCode ?? null;
  const interstate = Boolean(placeOfSupply && branchStateCode && placeOfSupply !== branchStateCode);
  const asOf = opts.asOf ?? new Date();

  const prepared: PreparedLine[] = [];

  for (const raw of rawLines) {
    const productId = uuid(raw.product_id, 'lines[].product_id');
    // The ceiling is an overflow guard tied to the column width — base_unit_qty is
    // NUMERIC(14,4), so a quantity times its unit multiplier has to stay inside
    // that or the insert dies with a numeric-overflow 500 instead of a useful
    // message. It is deliberately far above any real basket, so that an ordinary
    // "more than we have" quantity still reaches the stock check and gets the
    // answer a cashier can act on ("not enough stock") rather than a range error.
    const qty = num(raw.qty_in_sale_unit, 'lines[].qty_in_sale_unit', { min: 0.0001, max: 1e9 });
    const productUnitId = optionalUuid(raw.product_unit_id, 'lines[].product_unit_id');

    const product = (await sql<any>`
      SELECT p.product_id, p.name, p.base_unit, p.hsn_code, p.default_price_type,
             p.batch_tracked, p.serial_tracked,
             COALESCE(pu.multiplier_to_base, 1) AS multiplier_to_base,
             COALESCE(pu.product_unit_id, defu.product_unit_id) AS resolved_unit_id,
             COALESCE(pu.unit_label, defu.unit_label, p.base_unit::text) AS unit_label,
             pp.selling_price,
             COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct
        FROM products p
        LEFT JOIN product_units pu ON pu.product_unit_id = ${productUnitId} AND pu.product_id = p.product_id
        LEFT JOIN product_units defu ON defu.product_id = p.product_id AND defu.is_default_sale_unit
        LEFT JOIN LATERAL (
            SELECT selling_price FROM product_prices
             WHERE product_id = p.product_id AND effective_to IS NULL
             ORDER BY (branch_id = ${branchId}) DESC NULLS LAST LIMIT 1
        ) pp ON TRUE
        LEFT JOIN LATERAL (
            SELECT gst_rate_pct FROM hsn_tax_rates
             WHERE hsn_code = p.hsn_code
               AND daterange(effective_from, effective_to, '[)') @> ${asOf}::date
             LIMIT 1
        ) htr ON TRUE
       WHERE p.product_id = ${productId} AND p.is_active
    `.execute(trx)).rows[0];
    if (!product) throw badRequest('One of the items is no longer in the catalog. Remove it and try again.');

    // 3.9 — a barcode is a speed option, never mandatory, unless the owner turned
    // that on for this branch.
    if (settings.require_barcode_at_billing && !raw.scanned_barcode) {
      const hasBarcode = (await sql<any>`
        SELECT 1 FROM product_barcodes WHERE product_id = ${productId} LIMIT 1
      `.execute(trx)).rows[0];
      if (hasBarcode) throw badRequest(`"${product.name}" must be scanned — barcode entry is required at this branch.`);
    }

    const catalogRate = Number(product.selling_price ?? 0);
    if (!catalogRate) throw badRequest(`"${product.name}" has no selling price set. Add one in the catalog first.`);

    // 3.10 — the price locked into the cart at scan time wins, because a price that
    // moves under a customer mid-sale is worse than a few minutes of staleness.
    // "The client said so" cannot be the end of it though: a rate below the catalog
    // price is a discount by another name, and if it were not counted as one,
    // posting rate: 1 would bypass the 3.4 ceiling entirely and leave no audit
    // trail. The shortfall is folded into the line's implied discount below.
    const lockedRate = repriceFromCatalog || raw.rate_locked_at_scan === undefined
      ? catalogRate
      : num(raw.rate_locked_at_scan, 'lines[].rate_locked_at_scan', { min: 0, max: 10_000_000 });

    const priceType = oneOf(raw.price_type ?? product.default_price_type, 'lines[].price_type', PRICE_TYPES);
    // A NON_GST invoice charges no GST even when the product carries a rate — a
    // bill of supply that shows tax is a compliance problem, not a rounding one.
    const gstRate = invoiceType === 'NON_GST' ? 0 : Number(product.gst_rate_pct);

    const computed = computeLine({
      qty_in_sale_unit: qty,
      multiplier_to_base: Number(product.multiplier_to_base),
      rate_per_base_unit: lockedRate,
      gst_rate_pct: gstRate,
      price_type: priceType,
      discount_amount: raw.discount_amount === undefined
        ? 0
        : num(raw.discount_amount, 'lines[].discount_amount', { min: 0, max: 10_000_000 }),
      interstate,
    }, Number(settings.fractional_unit_rounding_dp));

    prepared.push({
      product_id: productId,
      product_unit_id: product.resolved_unit_id ?? null,
      qty_in_sale_unit: qty,
      computed,
      price_type: priceType,
      rate_locked_at_scan: lockedRate,
      catalog_rate: catalogRate,
      implied_discount: round2(
        Math.max(catalogRate - lockedRate, 0) * computed.base_unit_qty + computed.discount_amount,
      ),
      batch_id: optionalUuid(raw.batch_id, 'lines[].batch_id'),
      tint: (raw.tint as PreparedLine['tint']) ?? null,
      serials: Array.isArray(raw.serial_numbers) ? raw.serial_numbers.map(String) : [],
      product_name: product.name,
      hsn_code: product.hsn_code ?? null,
      gst_rate_pct: gstRate,
      unit_label: product.unit_label ?? null,
    });
  }

  const totals = totalInvoice(prepared.map((p) => p.computed), applyCashRounding);
  const catalogValue = round2(prepared.reduce((s, p) => s + p.catalog_rate * p.computed.base_unit_qty, 0));
  const givenAway = round2(prepared.reduce((s, p) => s + p.implied_discount, 0));

  return {
    lines: prepared,
    totals,
    catalog_value: catalogValue,
    given_away: givenAway,
    discount_pct: catalogValue > 0 ? (givenAway / catalogValue) * 100 : 0,
    interstate,
    place_of_supply_state_code: placeOfSupply,
  };
}

/**
 * Turns stored invoice_lines back into the raw shape priceBasket accepts.
 *
 * This is what makes finalisation trustworthy: a draft is re-priced from the rows
 * in the database rather than from whatever the browser last held, so a client
 * that edits its local copy of the totals and posts "finalize" changes nothing.
 */
export function rawLinesFromStored(rows: Array<Record<string, any>>): RawLineInput[] {
  return rows.map((r) => ({
    product_id: r.product_id,
    product_unit_id: r.product_unit_id ?? undefined,
    qty_in_sale_unit: Number(r.qty_in_sale_unit),
    rate_locked_at_scan: Number(r.rate_locked_at_scan),
    price_type: r.price_type,
    discount_amount: Number(r.discount_amount ?? 0),
    batch_id: r.batch_id ?? undefined,
    // Stored lines were already accepted once; re-checking the barcode rule on
    // finalisation would reject a legitimately keyed-in line at the last step.
    scanned_barcode: true,
  }));
}

export interface ParsedPayment {
  method: PaymentMethod;
  amount: number;
  ref_no: string | null;
}

/**
 * 3.2 — the payment split has to settle the bill exactly.
 *
 * Deliberately strict in both directions: an underpayment leaves an invoice that
 * looks settled and isn't, and an overpayment quietly turns the difference into
 * money the shop cannot account for. Change given back to a customer is a
 * counter-level matter, not an invoice-level one.
 */
export function assertPaymentsSettle(payments: ParsedPayment[], payable: number): void {
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  if (Math.abs(paid - payable) > 0.01) {
    throw badRequest(
      `Payments total ₹${paid.toFixed(2)} but the bill is ₹${payable.toFixed(2)}. They must match.`,
    );
  }
}
