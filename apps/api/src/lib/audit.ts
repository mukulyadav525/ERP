// 7.3 — "every sensitive action logged with who/when".
import { sql } from 'kysely';
import type { Tx } from './db.js';
import type { Session } from './session.js';

export type AuditAction =
  | 'PRICE_CHANGE' | 'DISCOUNT_OVERRIDE' | 'STOCK_ADJUSTMENT' | 'REFUND'
  | 'CREDIT_NOTE_ISSUED' | 'DEBIT_NOTE_ISSUED' | 'WRITE_OFF' | 'TRANSFER_DISPATCH'
  | 'TRANSFER_RECEIVE' | 'TRANSFER_DISCREPANCY_RESOLVED' | 'SETTING_CHANGE'
  | 'USER_CREATED' | 'USER_UPDATED' | 'ROLE_CHANGE' | 'CREDIT_LIMIT_CHANGE'
  | 'EXPENSE_APPROVED' | 'EXPENSE_REJECTED' | 'INVOICE_VOIDED' | 'CUSTOMER_MERGED'
  | 'LOYALTY_ADJUSTMENT' | 'NEGATIVE_STOCK_OVERRIDE' | 'BACKUP_RESTORED'
  | 'PII_EXPORTED' | 'REGISTRATION_APPROVED' | 'REGISTRATION_REJECTED'
  | 'STOCK_CONFLICT_RESOLVED' | 'PIN_RESET' | 'PASSWORD_RESET' | 'WARRANTY_CLAIM_UPDATED'
  // Draft billing (3.x, editable-before-final). A draft is a working document, so
  // only the transitions that change what the customer is asked to pay are logged:
  // the edit itself, the discard, and the moment it becomes a commercial document.
  | 'INVOICE_DRAFT_CREATED' | 'INVOICE_DRAFT_UPDATED' | 'INVOICE_DRAFT_DISCARDED'
  | 'INVOICE_FINALIZED'
  // Master data and parties (Sections 9, 13, 25, 27, 60).
  | 'PRODUCT_CREATED' | 'PRODUCT_UPDATED' | 'PRODUCT_IMPORTED' | 'MASTER_DATA_CHANGE'
  | 'CUSTOMER_CREATED' | 'CUSTOMER_UPDATED' | 'VENDOR_CREATED' | 'VENDOR_UPDATED'
  | 'BRANCH_ACCESS_CHANGE'
  // Money in and out (Sections 24, 26, 27, 36, 37).
  | 'CUSTOMER_PAYMENT' | 'VENDOR_PAYMENT' | 'PAYMENT_CANCELLED' | 'OPENING_BALANCE'
  | 'EXPENSE_CREATED' | 'TILL_OPENED' | 'TILL_CLOSED' | 'CASH_DROP' | 'PETTY_CASH'
  // Procurement and stock (Sections 28–32).
  | 'PURCHASE_ORDER_CREATED' | 'PURCHASE_ORDER_CANCELLED' | 'GRN_CREATED'
  | 'TRANSFER_CREATED' | 'TRANSFER_CANCELLED'
  // Estimates (Section 21).
  | 'QUOTATION_CREATED' | 'QUOTATION_UPDATED' | 'QUOTATION_APPROVED'
  | 'QUOTATION_CANCELLED' | 'QUOTATION_CONVERTED';

export async function audit(
  trx: Tx,
  session: Pick<Session, 'user_id' | 'branch_id'> & { active_branch_id?: string | null },
  action: AuditAction,
  entityType: string,
  entityId: string | null,
  change?: { before?: unknown; after?: unknown },
  opts: { branchId?: string | null } = {},
): Promise<void> {
  // Written inside the caller's transaction on purpose: if the action rolls back,
  // so does its audit entry, and the log never claims something happened that
  // didn't. The branch recorded is where the action happened — for an Owner that
  // is the branch they acted at, not "chain-wide".
  const branchId = opts.branchId !== undefined ? opts.branchId : (session.branch_id ?? session.active_branch_id ?? null);
  await sql`
    INSERT INTO audit_log (user_id, branch_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (${session.user_id}, ${branchId}, ${action}, ${entityType},
            ${entityId}, ${change?.before ? JSON.stringify(change.before) : null}::jsonb,
            ${change?.after ? JSON.stringify(change.after) : null}::jsonb)
  `.execute(trx);
}
