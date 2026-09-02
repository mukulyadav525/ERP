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
  | 'STOCK_CONFLICT_RESOLVED' | 'PIN_RESET' | 'WARRANTY_CLAIM_UPDATED'
  // Draft billing (3.x, editable-before-final). A draft is a working document, so
  // only the transitions that change what the customer is asked to pay are logged:
  // the edit itself, the discard, and the moment it becomes a commercial document.
  | 'INVOICE_DRAFT_CREATED' | 'INVOICE_DRAFT_UPDATED' | 'INVOICE_DRAFT_DISCARDED'
  | 'INVOICE_FINALIZED';

export async function audit(
  trx: Tx,
  session: Pick<Session, 'user_id' | 'branch_id'>,
  action: AuditAction,
  entityType: string,
  entityId: string | null,
  change?: { before?: unknown; after?: unknown },
): Promise<void> {
  // Written inside the caller's transaction on purpose: if the action rolls back,
  // so does its audit entry, and the log never claims something happened that
  // didn't.
  await sql`
    INSERT INTO audit_log (user_id, branch_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (${session.user_id}, ${session.branch_id}, ${action}, ${entityType},
            ${entityId}, ${change?.before ? JSON.stringify(change.before) : null}::jsonb,
            ${change?.after ? JSON.stringify(change.after) : null}::jsonb)
  `.execute(trx);
}
