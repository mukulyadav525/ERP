// Gapless document numbers (3.6). Always called inside the transaction that
// finalises the document, so a rollback returns the number to the pool.
import { sql } from 'kysely';
import type { Tx } from './db.js';
import { fiscalYear } from './tax.js';

export type Series =
  | 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'QUOTATION'
  | 'GRN' | 'CHALLAN' | 'TRANSFER' | 'PO' | 'RMA';

const PREFIX: Record<Series, string> = {
  INVOICE: 'INV', CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN', QUOTATION: 'QT',
  GRN: 'GRN', CHALLAN: 'DC', TRANSFER: 'TR', PO: 'PO', RMA: 'RMA',
};

export async function nextNumber(
  trx: Tx, branchId: string, series: Series, at: Date = new Date(),
): Promise<string> {
  const fy = fiscalYear(at);
  const rows = await sql<{ next_document_number: string }>`
    SELECT next_document_number(${branchId}, ${series}, ${fy}, ${PREFIX[series]})
  `.execute(trx);
  return rows.rows[0].next_document_number;
}
