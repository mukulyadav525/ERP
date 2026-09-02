// Section 17 — the consolidated settings table, resolved consistently everywhere.
//
// Resolution order is always: branch-specific row → chain-wide row → the code
// default below. The defaults here are exactly the ones the requirements document
// specifies, so a fresh database with no admin_settings rows still behaves as
// documented rather than as undefined behaviour.
import { sql } from 'kysely';
import type { Tx } from './db.js';

export const SETTING_DEFAULTS = {
  // Catalog & pricing (Section 2)
  multi_unit_sale_per_item:        true,
  enable_tinting_records:          true,
  enable_bundles:                  false,
  allow_branch_price_override:     false,
  branch_manager_cost_visibility:  false,
  default_item_price_type:         'TAX_INCLUSIVE',
  fractional_unit_rounding_dp:     2,
  // Billing / POS (Section 3)
  staff_discount_limit_pct:        5,
  allow_negative_stock:            false,
  require_barcode_at_billing:      false,
  offline_sync_conflict_rule:      'FIRST_TO_CLOUD_WINS',   // | 'BLOCK_ALL_CONFLICTS'
  // Inventory (Section 4)
  enable_batch_tracking:           true,
  valuation_method:                'WEIGHTED_AVERAGE',      // | 'FIFO'
  // Quotations (Section 5)
  enable_quotations_module:        false,
  quotation_stock_reservation:     false,
  quotation_hold_days:             3,
  // Credit (Section 6)
  allow_offline_credit_sales:      'CAP_50_PCT',            // | 'HARD_BLOCK'
  // Auth & security (Section 7)
  login_method_by_role: {
    OWNER_ADMIN: 'GOOGLE', BRANCH_MANAGER: 'GOOGLE',
    CASHIER: 'PHONE_PIN', INVENTORY_STAFF: 'PHONE_PIN', ACCOUNTANT: 'GOOGLE',
  } as Record<string, string>,
  otp_expiry_minutes:              5,
  pin_max_attempts:                3,
  lockout_minutes:                 15,
  session_timeout_minutes:         720,
  // Loyalty & CRM (Section 11)
  allow_loyalty_discount_stacking: false,
  loyalty_earn_points_per_100:     1,
  loyalty_point_value_rupees:      1,
  loyalty_point_expiry_days:       365,
  enable_birthday_greetings:       true,
  // Returns (Section 12)
  refund_method:                   'ADMIN_CHOICE',          // | 'CASH' | 'ORIGINAL_MODE' | 'STORE_CREDIT'
  return_window_days:              7,
  // Expenses & HR (Sections 9, 10)
  expense_approval_threshold:      5000,
  attendance_method:               'APP_CHECKIN',           // | 'BIOMETRIC' | 'MANUAL'
  enable_payroll_module:           false,
  // Compliance (Section 15)
  backup_frequency_hours:          24,
  einvoice_enabled:                false,
  // Printed documents (Section 65). The full shape and its defaults live in
  // lib/pdf/business-profile.ts, which is what the renderer reads; this entry
  // exists so the key is a known setting and shows up in the admin panel.
  business_profile:                {} as Record<string, unknown>,
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/**
 * The full effective settings map for a branch, in one query. Routes that need
 * several settings should call this rather than resolveSetting repeatedly — the
 * billing path alone reads six of them.
 */
export async function loadSettings(trx: Tx, branchId: string | null): Promise<typeof SETTING_DEFAULTS> {
  const rows = await sql<{ setting_key: string; branch_id: string | null; value: unknown }>`
    SELECT setting_key, branch_id, value FROM admin_settings
     WHERE branch_id IS NULL ${branchId ? sql`OR branch_id = ${branchId}` : sql``}
  `.execute(trx);

  const chainWide: Record<string, unknown> = {};
  const branchLevel: Record<string, unknown> = {};
  for (const r of rows.rows) {
    (r.branch_id ? branchLevel : chainWide)[r.setting_key] = r.value;
  }
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (key in branchLevel) out[key] = branchLevel[key];
    else if (key in chainWide) out[key] = chainWide[key];
  }
  return out as typeof SETTING_DEFAULTS;
}

export async function resolveSetting<K extends SettingKey>(
  trx: Tx, key: K, branchId: string | null,
): Promise<typeof SETTING_DEFAULTS[K]> {
  const all = await loadSettings(trx, branchId);
  return all[key];
}

/**
 * 2.6 — cost visibility is a *field*-level permission, and it is not purely a
 * function of the role: the Owner can grant a Branch Manager sight of their own
 * branch's cost data via a setting. This is the one place that decision is made.
 */
export function canSeeCost(role: string, settings: typeof SETTING_DEFAULTS): boolean {
  if (role === 'OWNER_ADMIN') return true;
  if (role === 'BRANCH_MANAGER') return Boolean(settings.branch_manager_cost_visibility);
  return false;
}

// Derived columns count too: a "stock value" column is purchase cost multiplied
// by quantity, so masking the cost while leaving the total visible would give the
// cost away to anyone with a calculator.
const COST_FIELDS = [
  'purchase_price', 'weighted_avg_cost', 'reference_purchase_price',
  'expected_purchase_price', 'margin', 'margin_pct', 'margin_amount',
  'cost', 'cost_at_movement', 'grn_rate', 'total_cost', 'cogs', 'rate',
  'stock_value', 'tied_up_value', 'purchase_value', 'total_value',
  'est_cost', 'expected_cost', 'actual_cost', 'cost_variance', 'last_purchase_rate',
];

/**
 * Strips cost/margin columns from a payload for roles that may not see them
 * (2.6: "staff-visible inventory reports and exports must mask cost/margin
 * columns"). `keepRate` exists because on a GRN screen `rate` is the purchase
 * price, but on a sales report `rate` is the selling price — the caller knows
 * which one it is holding.
 */
export function maskCost<T extends Record<string, any>>(
  rows: T[], allowed: boolean, opts: { keepRate?: boolean } = {},
): T[] {
  if (allowed) return rows;
  const fields = opts.keepRate ? COST_FIELDS.filter((f) => f !== 'rate') : COST_FIELDS;
  return rows.map((row) => {
    const copy: Record<string, any> = { ...row };
    for (const f of fields) if (f in copy) delete copy[f];
    return copy as T;
  });
}

export function maskCostOne<T extends Record<string, any>>(
  row: T, allowed: boolean, opts: { keepRate?: boolean } = {},
): T {
  return maskCost([row], allowed, opts)[0];
}
