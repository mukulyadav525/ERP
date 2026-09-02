// ============================================================================
// Ledger posting.
//
// The customer credit ledger and the vendor payables ledger both keep a running
// `balance_after`, and both are chain-wide: one customer, one balance, however
// many branches they shop at. That makes a read-then-insert unsafe — two branches
// can read the same prior balance and write over each other, and a credit limit
// checked before the lock is a limit that can be raced.
//
// These wrappers call the SECURITY DEFINER functions that take a row lock on the
// customer (or vendor) first. No route should write to either ledger directly.
// ============================================================================
import { sql } from 'kysely';
import type { Tx } from './db.js';

export type CreditEntryType = 'SALE_ON_CREDIT' | 'PAYMENT_RECEIVED' | 'REFUND_ADJUSTMENT';

export interface CreditPostResult {
  entry_id: string | null;
  balance_after: number;
  credit_limit: number;
  over_limit: boolean;
}

/**
 * Posts to the customer credit ledger under a lock.
 *
 * With `enforceLimit`, the limit is evaluated under the same lock that writes the
 * row, so the answer cannot go stale in between. A refusal comes back as
 * `over_limit: true` rather than as an exception, because the caller usually wants
 * to offer a manager override rather than abort.
 */
export async function postCredit(trx: Tx, opts: {
  customerId: string;
  branchId: string | null;
  entryType: CreditEntryType;
  amount: number;              // signed: positive increases what is owed
  refTable?: string | null;
  refId?: string | null;
  enforceLimit?: boolean;
}): Promise<CreditPostResult> {
  const res = await sql<CreditPostResult>`
    SELECT * FROM customer_credit_post(
      ${opts.customerId}, ${opts.branchId}, ${opts.entryType}::credit_ledger_entry_type,
      ${opts.amount}, ${opts.refTable ?? null}, ${opts.refId ?? null}, ${opts.enforceLimit ?? false})
  `.execute(trx);
  const row = res.rows[0];
  return {
    entry_id: row.entry_id,
    balance_after: Number(row.balance_after),
    credit_limit: Number(row.credit_limit),
    over_limit: row.over_limit,
  };
}

export type VendorEntryType = 'GRN_PAYABLE' | 'PAYMENT_MADE' | 'DEBIT_NOTE';

export async function postVendor(trx: Tx, opts: {
  vendorId: string;
  branchId: string | null;
  entryType: VendorEntryType;
  amount: number;              // signed: positive increases the payable
  refTable?: string | null;
  refId?: string | null;
}): Promise<{ entry_id: string; balance_after: number }> {
  const res = await sql<{ entry_id: string; balance_after: string }>`
    SELECT * FROM vendor_ledger_post(
      ${opts.vendorId}, ${opts.branchId}, ${opts.entryType}::vendor_ledger_entry_type,
      ${opts.amount}, ${opts.refTable ?? null}, ${opts.refId ?? null})
  `.execute(trx);
  return { entry_id: res.rows[0].entry_id, balance_after: Number(res.rows[0].balance_after) };
}

/** The current chain-wide balance, for a read-only check. */
export async function creditBalance(trx: Tx, customerId: string): Promise<number> {
  const row = await sql<{ balance_after: string }>`
    SELECT balance_after FROM customer_credit_ledger
     WHERE customer_id = ${customerId} ORDER BY created_at DESC, entry_id DESC LIMIT 1
  `.execute(trx);
  return Number(row.rows[0]?.balance_after ?? 0);
}
