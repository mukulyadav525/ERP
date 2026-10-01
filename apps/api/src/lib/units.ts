// ============================================================================
// Units of measure (Section 10 / 11, requirement 2.2.1).
//
// Every quantity the system stores is in the product's BASE unit: stock, cost and
// price all live there. A sale unit is only ever a stated multiple of it, and this
// file is the one place that multiple is worked out.
//
// Two units of the same measured dimension convert by arithmetic on the units
// master — 100G against a KG base is 100 g ÷ 1000 g = 0.1 KG, 1 KG against a
// GRAM base is 1000 — so "100 G" is not a special case anywhere in the code; it
// is a row in the `units` table. Pack units (BOX, REEL, SET) have no fixed size,
// so how many base units one holds is stated per product and cannot be derived.
// ============================================================================
import { sql } from 'kysely';
import type { Tx } from './db.js';
import { badRequest } from './errors.js';

export interface UnitRow {
  unit_code: string;
  name: string;
  print_label: string;
  dimension: 'COUNT' | 'MASS' | 'LENGTH' | 'VOLUME' | 'AREA' | 'PACK';
  to_dimension_base: string | null;
  allows_fraction: boolean;
  is_system: boolean;
  is_active: boolean;
}

export const DIMENSIONS = ['COUNT', 'MASS', 'LENGTH', 'VOLUME', 'AREA', 'PACK'] as const;

export async function loadUnits(trx: Tx, codes: string[]): Promise<Map<string, UnitRow>> {
  if (!codes.length) return new Map();
  const rows = (await sql<UnitRow>`
    SELECT * FROM units WHERE unit_code = ANY(${codes}::text[])
  `.execute(trx)).rows;
  return new Map(rows.map((r) => [r.unit_code, r]));
}

export async function requireUnit(trx: Tx, code: string, label = 'Unit'): Promise<UnitRow> {
  const unit = (await loadUnits(trx, [code])).get(code);
  if (!unit) throw badRequest(`${label} "${code}" is not in the units list. Add it under Catalog → Units first.`);
  if (!unit.is_active) throw badRequest(`${label} "${unit.name}" has been deactivated.`);
  return unit;
}

/**
 * How many BASE units one SALE unit is, when the units master alone can say.
 * Returns null when it cannot — a pack unit, or two different dimensions (a BOX
 * of PIECES) — in which case the size must be stated for the product.
 */
export function derivedMultiplier(base: UnitRow, sale: UnitRow): number | null {
  if (base.unit_code === sale.unit_code) return 1;
  if (base.dimension === 'PACK' || sale.dimension === 'PACK') return null;
  if (base.dimension !== sale.dimension) return null;
  const b = Number(base.to_dimension_base);
  const s = Number(sale.to_dimension_base);
  if (!(b > 0) || !(s > 0)) return null;
  return roundMultiplier(s / b);
}

/** product_units.multiplier_to_base is NUMERIC(14,6). */
export function roundMultiplier(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Resolves the multiplier for adding `sale` as a unit of a product whose base is
 * `base`. A measured conversion is DERIVED and a conflicting typed value is
 * refused — 1 KG is 1000 G whatever anyone types — while a pack size must be
 * given, because nothing else can know how many screws are in this box.
 */
export function resolveMultiplier(base: UnitRow, sale: UnitRow, typed: number | null | undefined): number {
  const derived = derivedMultiplier(base, sale);
  if (derived !== null) {
    if (typed != null && Math.abs(typed - derived) > 1e-6 * Math.max(1, derived)) {
      throw badRequest(
        `1 ${sale.print_label} is always ${formatQty(derived)} ${base.print_label} — the conversion cannot be set to ${formatQty(typed)}.`,
      );
    }
    return derived;
  }
  if (base.dimension !== 'PACK' && sale.dimension !== 'PACK' && base.dimension !== sale.dimension) {
    // Mass against length, volume against count: no physical relationship. Such a
    // unit can still be a PACK of the product, but it has to be a pack unit.
    if (typed == null) {
      throw badRequest(`${sale.name} (${sale.dimension.toLowerCase()}) cannot be converted to ${base.name} (${base.dimension.toLowerCase()}). State how many ${base.print_label} one ${sale.print_label} holds.`);
    }
  }
  if (typed == null || !(typed > 0)) {
    throw badRequest(`State how many ${base.print_label} one ${sale.print_label} holds (for example 1 BOX = 100 PCS).`);
  }
  return roundMultiplier(typed);
}

/**
 * A quantity typed in a unit that cannot be split (a box, a piece) must be whole.
 * Selling 1.5 boxes is a data-entry mistake, not a sale.
 */
export function assertQuantityAllowed(qty: number, unit: Pick<UnitRow, 'allows_fraction' | 'name' | 'print_label'>, productName?: string): void {
  if (!(qty > 0)) {
    throw badRequest(`Quantity${productName ? ` for "${productName}"` : ''} must be greater than zero.`);
  }
  if (!unit.allows_fraction && Math.abs(qty - Math.round(qty)) > 1e-9) {
    throw badRequest(
      `${productName ? `"${productName}": ` : ''}${unit.name} (${unit.print_label}) is sold in whole numbers — ${formatQty(qty)} is not allowed.`,
    );
  }
}

export function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 10000) / 10000);
}

// ── Indian GST state codes (Section 19) ─────────────────────────────────────
// Place of supply is compared as a 2-digit code, so a customer in "27" and a
// branch in "27" is intra-state (CGST + SGST) and "29" against "27" is IGST.
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory',
};

/** Validates an optional state code; returns it normalised to two digits, or null. */
export function optionalStateCode(value: unknown, field = 'State'): string | null {
  if (value === undefined || value === null || value === '') return null;
  const code = String(value).trim().padStart(2, '0');
  if (!GST_STATES[code]) throw badRequest(`${field} code "${String(value)}" is not a valid GST state code.`);
  return code;
}

/** GSTIN format: 2-digit state + 10-char PAN + entity + Z + checksum. */
export function optionalGstin(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const g = String(value).trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) {
    throw badRequest(`"${g}" is not a valid GSTIN. It has 15 characters, e.g. 27ABCDE1234F1Z5.`);
  }
  if (!GST_STATES[g.slice(0, 2)]) throw badRequest(`GSTIN ${g} starts with an unknown state code.`);
  return g;
}
