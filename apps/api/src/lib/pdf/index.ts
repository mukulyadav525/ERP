// ============================================================================
// The three documents the shop actually hands over (Sections 58–68, 61).
//
//   TEMPLATE A — Estimate / Quotation   (buildEstimatePdf)
//   TEMPLATE B — GST Tax Invoice        (buildInvoicePdf, showTax: true)
//   TEMPLATE C — Non-GST Cash Memo      (buildInvoicePdf, showTax: false)
//
// They share one renderer and one visual system; what differs is the title, the
// fields, and whether tax columns exist at all. A non-GST bill must not show GST
// figures — not zeroed ones, not blank ones, none — because a bill of supply
// carrying a tax column reads as a tax invoice to anyone glancing at it.
//
// Everything printed is read from the finalised rows in the database by the
// caller and passed in here (§63). The renderer never re-derives a total, so the
// paper, the screen and the ledger cannot disagree.
// ============================================================================
import type { Tx } from '../db.js';
import { round2 } from '../tax.js';
import { loadBusinessProfile } from './business-profile.js';
import {
  renderDocument, type DocumentLine, type DocumentModel, type DocumentParty,
} from './renderer.js';
import { dateOnly, dateTime } from './theme.js';

export { loadBusinessProfile, normaliseProfile, DEFAULT_BUSINESS_PROFILE, BUSINESS_PROFILE_SETTING }
  from './business-profile.js';
export type { BusinessProfile, DocumentModel } from './renderer.js';
export { renderDocument } from './renderer.js';
export { amountInWords } from './theme.js';

const asNum = (v: unknown) => Number(v ?? 0);

function customerParty(row: Record<string, any>): DocumentParty | null {
  if (!row.customer_name && !row.customer_phone) return null;
  return {
    name: row.customer_name ?? 'Walk-in customer',
    company: row.customer_company ?? null,
    address: row.customer_address ?? null,
    phone: row.customer_phone ?? null,
    gstin: row.customer_gstin ?? null,
    state: row.customer_state ?? null,
    state_code: row.customer_state_code ?? row.place_of_supply_state_code ?? null,
  };
}

function toLines(rows: Array<Record<string, any>>): DocumentLine[] {
  return rows.map((l) => {
    const notes: string[] = [];
    if (l.base_shade || l.tint_formula) {
      notes.push(`Tint: ${[l.base_shade, l.tint_formula].filter(Boolean).join(' / ')}`);
    }
    if (l.batch_number) notes.push(`Batch ${l.batch_number}`);
    if (l.serial_numbers) notes.push(`Sr. ${l.serial_numbers}`);
    return {
      description: l.product_name ?? 'Item',
      sku: l.sku ?? null,
      hsn_code: l.hsn_code ?? null,
      unit_label: l.unit_label ?? null,
      qty: asNum(l.qty_in_sale_unit),
      rate: asNum(l.rate_locked_at_scan ?? l.rate),
      discount_amount: asNum(l.discount_amount),
      taxable_value: asNum(l.taxable_value),
      gst_rate_pct: l.gst_rate_pct === undefined || l.gst_rate_pct === null
        ? undefined
        : asNum(l.gst_rate_pct),
      cgst_amount: asNum(l.cgst_amount),
      sgst_amount: asNum(l.sgst_amount),
      igst_amount: asNum(l.igst_amount),
      line_total: asNum(l.line_total ??
        (asNum(l.taxable_value) + asNum(l.cgst_amount) + asNum(l.sgst_amount) + asNum(l.igst_amount))),
      note: notes.length ? notes.join('  •  ') : null,
    };
  });
}

/**
 * Templates B and C — the GST tax invoice and the non-GST cash memo.
 *
 * A DRAFT prints as a proforma: watermarked, titled so nobody can mistake it for
 * a bill, and explicitly carrying no document number, because a draft has not
 * drawn one from the gapless series and must not look as though it has (3.6).
 */
export async function buildInvoicePdf(
  trx: Tx,
  invoice: Record<string, any>,
  lineRows: Array<Record<string, any>>,
  payments: Array<Record<string, any>> = [],
): Promise<Buffer> {
  const business = await loadBusinessProfile(trx, invoice.branch_id, {
    name: invoice.branch_name,
    address: invoice.branch_address,
    phone: invoice.branch_phone,
    gstin: invoice.branch_gstin,
    state_code: invoice.branch_state_code,
  });

  const isGst = invoice.invoice_type === 'GST';
  const isDraft = invoice.status === 'DRAFT';
  const interstate = asNum(invoice.igst_total) > 0
    || Boolean(invoice.place_of_supply_state_code && invoice.branch_state_code
               && invoice.place_of_supply_state_code !== invoice.branch_state_code);

  const lines = toLines(lineRows);
  const paid = payments.reduce((s, p) => s + asNum(p.amount), 0);
  const grandTotal = round2(asNum(invoice.grand_total) + asNum(invoice.round_off));

  const meta: Array<[string, string]> = [];
  meta.push([isDraft ? 'Draft ref' : 'Invoice No.',
             isDraft ? String(invoice.invoice_id).slice(0, 8).toUpperCase() : (invoice.invoice_number ?? '—')]);
  meta.push(['Date', dateTime(invoice.server_received_at)]);
  if (invoice.order_no) meta.push(['Order No.', String(invoice.order_no)]);
  if (invoice.challan_no) meta.push(['Challan No.', String(invoice.challan_no)]);
  if (invoice.challan_date) meta.push(['Challan Date', dateOnly(invoice.challan_date)]);
  if (invoice.vehicle_no) meta.push(['Vehicle No.', String(invoice.vehicle_no)]);
  if (invoice.due_date) meta.push(['Due Date', dateOnly(invoice.due_date)]);
  if (isGst && invoice.place_of_supply_state_code) {
    meta.push(['Place of Supply', String(invoice.place_of_supply_state_code)]);
  }
  meta.push(['Supply Type', interstate ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)']);
  if (invoice.sold_by_name) meta.push(['Served by', String(invoice.sold_by_name)]);

  const model: DocumentModel = {
    kind: isGst ? 'TAX_INVOICE' : 'CASH_MEMO',
    title: isDraft
      ? (isGst ? 'PROFORMA — DRAFT' : 'DRAFT BILL')
      : (isGst ? 'TAX INVOICE' : 'CASH MEMO / BILL OF SUPPLY'),
    business,
    billTo: customerParty(invoice),
    meta,
    lines,
    totals: {
      // Gross is reconstructed so the totals column adds up on the page: the
      // stored `subtotal` is already net of discount, so printing it under a
      // "Taxable value" label and then a separate "Discount" line made the
      // arithmetic on the paper wrong by exactly the discount.
      gross: round2(asNum(invoice.subtotal) + asNum(invoice.discount_total)),
      discount_total: asNum(invoice.discount_total),
      taxable_total: asNum(invoice.subtotal),
      cgst_total: asNum(invoice.cgst_total),
      sgst_total: asNum(invoice.sgst_total),
      igst_total: asNum(invoice.igst_total),
      round_off: asNum(invoice.round_off),
      grand_total: grandTotal,
    },
    payments: payments.map((p) => ({ method: p.method, amount: asNum(p.amount), ref_no: p.ref_no ?? null })),
    amount_paid: paid,
    balance_due: isDraft ? null : round2(grandTotal - paid),
    interstate,
    showTax: isGst,
    watermark: invoice.status === 'VOID' ? 'VOID'
             : isDraft ? 'DRAFT — NOT A TAX INVOICE'
             : null,
    notes: invoice.notes ?? null,
    extraTerms: isDraft
      ? ['This draft has no invoice number and is not a valid tax document until it is finalised.']
      : [],
  };

  return renderDocument(model);
}

/** Template A — the estimate / quotation (Section 58.1). */
export async function buildEstimatePdf(
  trx: Tx,
  quotation: Record<string, any>,
  lineRows: Array<Record<string, any>>,
): Promise<Buffer> {
  const business = await loadBusinessProfile(trx, quotation.branch_id, {
    name: quotation.branch_name,
    address: quotation.branch_address,
    phone: quotation.branch_phone,
    gstin: quotation.branch_gstin,
    state_code: quotation.branch_state_code,
  });

  const withGst = quotation.with_gst !== false && asNum(quotation.tax_total) >= 0
    && (quotation.with_gst === true || asNum(quotation.cgst_total) + asNum(quotation.sgst_total) + asNum(quotation.igst_total) > 0);
  const interstate = asNum(quotation.igst_total) > 0;
  const lines = toLines(lineRows);
  const grandTotal = round2(asNum(quotation.grand_total));

  const meta: Array<[string, string]> = [
    ['Estimate No.', quotation.quotation_number ?? '—'],
    ['Date', dateOnly(quotation.created_at)],
  ];
  if (quotation.valid_until) meta.push(['Valid Until', dateOnly(quotation.valid_until)]);
  if (quotation.status) meta.push(['Status', String(quotation.status)]);
  if (quotation.stock_reserved) meta.push(['Stock', 'Reserved']);
  if (quotation.created_by_name) meta.push(['Prepared by', String(quotation.created_by_name)]);

  const model: DocumentModel = {
    kind: 'ESTIMATE',
    business,
    billTo: customerParty(quotation),
    meta,
    lines,
    totals: {
      gross: round2(asNum(quotation.subtotal) + asNum(quotation.discount_total)),
      discount_total: asNum(quotation.discount_total),
      taxable_total: asNum(quotation.subtotal),
      cgst_total: asNum(quotation.cgst_total),
      sgst_total: asNum(quotation.sgst_total),
      igst_total: asNum(quotation.igst_total),
      round_off: 0,
      grand_total: grandTotal,
    },
    interstate,
    showTax: withGst,
    watermark: ['CANCELLED', 'EXPIRED', 'REJECTED'].includes(String(quotation.status)) ? String(quotation.status) : null,
    notes: quotation.notes ?? null,
    extraTerms: [
      quotation.valid_until
        ? `This estimate is valid until ${dateOnly(quotation.valid_until)}.`
        : 'This estimate is valid for 7 days unless stated otherwise.',
      'Prices are subject to stock availability at the time of order confirmation.',
      withGst ? 'GST is included as shown above.' : 'GST will be charged extra as applicable.',
    ],
  };

  return renderDocument(model);
}

/**
 * Kept so existing callers keep working. New code should call buildInvoicePdf,
 * which can read the configured business profile.
 */
export async function generateInvoicePdf(
  trx: Tx, invoice: Record<string, any>, lines: Array<Record<string, any>>, payments: Array<Record<string, any>> = [],
): Promise<Buffer> {
  return buildInvoicePdf(trx, invoice, lines, payments);
}
