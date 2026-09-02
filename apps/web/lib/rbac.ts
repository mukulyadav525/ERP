// ============================================================================
// RBAC — the client's copy of the role matrix (Section 7.1).
//
// This file is kept byte-identical in intent to apps/api/src/lib/rbac.ts. It
// exists so the sidebar can hide what a user cannot reach; it is NOT a security
// boundary. The server checks the same matrix on every request, and RLS in the
// database checks branch scope underneath that.
// ============================================================================

export type UserRole =
  | 'OWNER_ADMIN' | 'BRANCH_MANAGER' | 'CASHIER' | 'INVENTORY_STAFF' | 'ACCOUNTANT';

export const PERMISSIONS: Record<string, UserRole[]> = {
  view_dashboard:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'],
  view_billing:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  view_catalog:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF'],
  view_inventory:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  view_quotations:           ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  view_returns:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'ACCOUNTANT'],
  view_customers:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  view_vendors:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF', 'ACCOUNTANT'],
  view_expenses:             ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  view_hr:                   ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  view_reports:              ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  view_admin:                ['OWNER_ADMIN'],

  edit_catalog:              ['OWNER_ADMIN'],
  edit_pricing:              ['OWNER_ADMIN'],
  view_cost_price:           ['OWNER_ADMIN'],

  create_invoice:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  void_invoice:              ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  approve_discount_override: ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  manage_till:               ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  acknowledge_cash_drop:     ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  resolve_stock_conflict:    ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  process_return:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  manage_warranty_claim:     ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],

  create_grn:                ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  create_purchase_order:     ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  create_purchase_return:    ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  create_transfer:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  receive_transfer:          ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  resolve_transfer_discrepancy: ['OWNER_ADMIN'],
  run_stock_audit:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_STAFF'],
  approve_write_off:         ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  edit_customer:             ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER'],
  set_credit_limit:          ['OWNER_ADMIN'],
  record_customer_payment:   ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'ACCOUNTANT'],
  view_customer_outstanding: ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'ACCOUNTANT'],
  merge_customers:           ['OWNER_ADMIN'],
  export_customer_pii:       ['OWNER_ADMIN'],

  edit_vendor:               ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  record_vendor_payment:     ['OWNER_ADMIN', 'ACCOUNTANT'],

  create_quotation:          ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  approve_quotation:         ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  convert_quotation:         ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  create_expense:            ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  approve_expense:           ['OWNER_ADMIN', 'BRANCH_MANAGER'],

  manage_staff:              ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  mark_attendance:           ['OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'],
  approve_leave:             ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  run_payroll:               ['OWNER_ADMIN'],

  manage_campaigns:          ['OWNER_ADMIN', 'BRANCH_MANAGER'],
  adjust_loyalty:            ['OWNER_ADMIN'],

  view_financial_reports:    ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'],
  view_chain_reports:        ['OWNER_ADMIN'],
  view_gst_reports:          ['OWNER_ADMIN', 'ACCOUNTANT'],
  export_accounting:         ['OWNER_ADMIN', 'ACCOUNTANT'],

  manage_users:              ['OWNER_ADMIN'],
  manage_settings:           ['OWNER_ADMIN'],
  view_audit_log:            ['OWNER_ADMIN'],
  cross_branch_lookup:       ['OWNER_ADMIN'],
  cloud_backup_restore:      ['OWNER_ADMIN'],
};

export function canAccess(role: UserRole | string | null | undefined, permission: string): boolean {
  if (!role) return false;
  const allowed = PERMISSIONS[permission];
  if (!allowed) return role === 'OWNER_ADMIN';
  return allowed.includes(role as UserRole);
}

export const ROLE_META: Record<UserRole, { label: string; labelHi: string; color: string }> = {
  OWNER_ADMIN:     { label: 'Owner / Admin',   labelHi: 'मालिक / एडमिन',   color: '#7c3aed' },
  BRANCH_MANAGER:  { label: 'Branch Manager',  labelHi: 'शाखा प्रबंधक',     color: '#0ea5e9' },
  CASHIER:         { label: 'Cashier',         labelHi: 'कैशियर',           color: '#10b981' },
  INVENTORY_STAFF: { label: 'Inventory Staff', labelHi: 'इन्वेंटरी स्टाफ', color: '#f59e0b' },
  ACCOUNTANT:      { label: 'Accountant',      labelHi: 'लेखाकार',         color: '#e11d48' },
};

export interface NavItem { href: string; labelKey: string; permission: string; icon: string; }
export interface NavSection { sectionKey: string; items: NavItem[]; }

export const NAV_CONFIG: NavSection[] = [
  { sectionKey: 'navOverview', items: [
    { href: '/',        labelKey: 'navDashboard', permission: 'view_dashboard', icon: '◧' },
    { href: '/reports', labelKey: 'navAnalytics', permission: 'view_reports',   icon: '◔' },
  ]},
  { sectionKey: 'navOperations', items: [
    { href: '/billing',    labelKey: 'navBilling',    permission: 'view_billing',    icon: '🧾' },
    { href: '/catalog',    labelKey: 'navCatalog',    permission: 'view_catalog',    icon: '📦' },
    { href: '/inventory',  labelKey: 'navInventory',  permission: 'view_inventory',  icon: '🏭' },
    { href: '/quotations', labelKey: 'navQuotations', permission: 'view_quotations', icon: '📋' },
    { href: '/returns',    labelKey: 'navReturns',    permission: 'view_returns',    icon: '↩' },
  ]},
  { sectionKey: 'navRelationships', items: [
    { href: '/customers', labelKey: 'navCustomers', permission: 'view_customers', icon: '👥' },
    { href: '/vendors',   labelKey: 'navVendors',   permission: 'view_vendors',   icon: '🏪' },
  ]},
  { sectionKey: 'navBackOffice', items: [
    { href: '/expenses', labelKey: 'navExpenses', permission: 'view_expenses', icon: '💰' },
    { href: '/hr',       labelKey: 'navHR',       permission: 'view_hr',       icon: '👤' },
  ]},
  { sectionKey: 'navSystem', items: [
    { href: '/admin', labelKey: 'navAdmin', permission: 'view_admin', icon: '⚙' },
  ]},
];
