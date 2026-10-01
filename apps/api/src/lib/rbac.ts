// ============================================================================
// RBAC — role matrix (Section 7.1). Mirrors apps/web/lib/rbac.ts exactly; the two
// files are kept identical on purpose so the sidebar a user sees and the endpoints
// they can call can never disagree. The server copy is the one that's binding.
// ============================================================================

export type UserRole =
  | 'OWNER_ADMIN'
  | 'BRANCH_MANAGER'
  | 'CASHIER'
  | 'INVENTORY_STAFF'
  | 'ACCOUNTANT';

export const ALL_ROLES: UserRole[] = [
  'OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT',
];

export const PERMISSIONS: Record<string, UserRole[]> = {
  // ── Page-level ────────────────────────────────────────────────────────────
  view_dashboard:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'],
  view_billing:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  view_catalog:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF'],
  view_inventory:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  view_quotations:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  view_returns:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'ACCOUNTANT'],
  view_customers:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  view_vendors:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF', 'ACCOUNTANT'],
  view_expenses:             ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  view_hr:                   ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  view_reports:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  view_admin:                ['OWNER_ADMIN'],

  // ── Catalog / pricing ─────────────────────────────────────────────────────
  edit_catalog:              ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  edit_pricing:              ['OWNER_ADMIN'],
  manage_master_data:        ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  view_cost_price:           ['OWNER_ADMIN'],   // field-level, 2.6 — Branch Manager
                                                // is granted this dynamically when the
                                                // "branch_manager_cost_visibility"
                                                // setting is on (see settings.ts).

  // ── Billing ───────────────────────────────────────────────────────────────
  create_invoice:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  void_invoice:              ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  approve_discount_override: ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  manage_till:               ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  acknowledge_cash_drop:     ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  resolve_stock_conflict:    ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  // ── Returns / warranty ────────────────────────────────────────────────────
  process_return:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  manage_warranty_claim:     ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],

  // ── Inventory ─────────────────────────────────────────────────────────────
  create_grn:                ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  create_purchase_order:     ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  create_purchase_return:    ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  create_transfer:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  receive_transfer:          ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  resolve_transfer_discrepancy: ['OWNER_ADMIN'],           // 4.4.1: Admin adjudicates
  run_stock_audit:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  approve_write_off:         ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  adjust_stock:              ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  // ── Customers / credit ────────────────────────────────────────────────────
  edit_customer:             ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  set_credit_limit:          ['OWNER_ADMIN'],              // 6.1: limit set by Admin
  record_customer_payment:   ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'ACCOUNTANT'],
  cancel_customer_payment:   ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  // Receivables are the accountant's job, and the vendor payables list is already
  // theirs. Leaving the customer side behind `view_customers` meant an accountant
  // could RECORD a payment against a customer but could not list who owed
  // anything — the one screen collections actually starts from.
  view_customer_outstanding: ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'ACCOUNTANT'],
  merge_customers:           ['OWNER_ADMIN'],
  export_customer_pii:       ['OWNER_ADMIN'],              // 15: PII export is Admin-only

  // ── Vendors ───────────────────────────────────────────────────────────────
  edit_vendor:               ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  record_vendor_payment:     ['OWNER_ADMIN', 'ACCOUNTANT'],

  // ── Quotations ────────────────────────────────────────────────────────────
  create_quotation:          ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  approve_quotation:         ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  convert_quotation:         ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],

  // ── Expenses ──────────────────────────────────────────────────────────────
  create_expense:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  approve_expense:           ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  // ── HR ────────────────────────────────────────────────────────────────────
  manage_staff:              ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  mark_attendance:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'],
  approve_leave:             ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  run_payroll:               ['OWNER_ADMIN'],

  // ── CRM ───────────────────────────────────────────────────────────────────
  manage_campaigns:          ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  adjust_loyalty:            ['OWNER_ADMIN'],

  // ── Reports ───────────────────────────────────────────────────────────────
  view_financial_reports:    ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  view_chain_reports:        ['OWNER_ADMIN'],
  view_gst_reports:          ['OWNER_ADMIN', 'ACCOUNTANT'],
  export_accounting:         ['OWNER_ADMIN', 'ACCOUNTANT'],

  // ── Admin / system ────────────────────────────────────────────────────────
  manage_users:              ['OWNER_ADMIN'],
  manage_settings:           ['OWNER_ADMIN'],
  view_audit_log:            ['OWNER_ADMIN'],
  cross_branch_lookup:       ['OWNER_ADMIN'],
  cloud_backup_restore:      ['OWNER_ADMIN'],
};

/**
 * Unknown permission names deliberately resolve to OWNER_ADMIN-only rather than
 * to "allowed". A typo in a route should lock people out loudly, not quietly open
 * a door.
 */
export function canAccess(role: string | null | undefined, permission: string): boolean {
  if (!role) return false;
  const allowed = PERMISSIONS[permission];
  if (!allowed) return role === 'OWNER_ADMIN';
  return allowed.includes(role as UserRole);
}

export const ROLE_META: Record<UserRole, { label: string; labelHi: string; color: string }> = {
  OWNER_ADMIN:     { label: 'Owner / Admin',   labelHi: 'मालिक / एडमिन',    color: '#7c3aed' },
  BRANCH_MANAGER:  { label: 'Branch Manager',  labelHi: 'शाखा प्रबंधक',      color: '#0ea5e9' },
  CASHIER:         { label: 'Cashier',         labelHi: 'कैशियर',            color: '#10b981' },
  INVENTORY_STAFF: { label: 'Inventory Staff', labelHi: 'इन्वेंटरी स्टाफ',  color: '#f59e0b' },
  ACCOUNTANT:      { label: 'Accountant',      labelHi: 'लेखाकार',          color: '#e11d48' },
};
