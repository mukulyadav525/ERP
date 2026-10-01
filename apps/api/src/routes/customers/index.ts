// ============================================================================
// Section 6 — Customers & Credit Ledger (spec §25, §26)
// Customer identity is CHAIN-WIDE (Section 0): the same person buying at two
// branches is one record, deduplicated on phone number, so their credit balance,
// loyalty points and purchase history stay correct wherever they shop.
//
// The credit ledger is the ONLY balance. Opening balances, credit sales,
// receipts, returns and adjustments are all entries in it, so the statement a
// customer is shown always adds up to the balance the counter sees.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, bool, oneOf, limit as clampLimit, writeBranch,
} from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { round2 } from '../../lib/tax.js';
import { audit } from '../../lib/audit.js';
import { queueMessage } from '../../lib/whatsapp.js';
import { creditBalance, postCredit } from '../../lib/ledger.js';
import { nextNumber } from '../../lib/numbering.js';
import { GST_STATES, optionalGstin, optionalStateCode } from '../../lib/units.js';
import type { Tx } from '../../lib/db.js';
import { addDays, businessToday } from '../../lib/dates.js';

const RECEIPT_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const;
const PHONE_RE = /^[0-9+\-\s]{8,20}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function phoneValue(v: unknown, field = 'Phone number'): string {
  const phone = str(v, field, { max: 20 }).replace(/\s+/g, '');
  if (!PHONE_RE.test(phone) || phone.replace(/\D/g, '').length < 8) throw badRequest(`Please enter a valid ${field.toLowerCase()}.`);
  return phone;
}
function optionalPhone(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  return phoneValue(v, field);
}
function optionalEmail(v: unknown): string | null {
  const e = optionalStr(v, 'Email', { max: 254 });
  if (e && !EMAIL_RE.test(e)) throw badRequest('Please enter a valid email address.');
  return e ? e.toLowerCase() : null;
}
function optionalDateStr(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(new Date(s).getTime())) throw badRequest(`${field} must be a date.`);
  return s;
}

/** Everything a customer record may be edited with, validated once for create and update. */
function profileFields(body: Record<string, unknown>) {
  const stateCode = optionalStateCode(body.state_code, 'State');
  const gstin = optionalGstin(body.gstin);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) {
    throw badRequest(`The GSTIN is registered in state ${gstin.slice(0, 2)}, but the state chosen is ${stateCode}.`);
  }
  return {
    name: body.name === undefined ? undefined : str(body.name, 'Customer name', { max: 150 }),
    company_name: body.company_name === undefined ? undefined : optionalStr(body.company_name, 'Company', { max: 150 }),
    email: body.email === undefined ? undefined : optionalEmail(body.email),
    whatsapp: body.whatsapp === undefined ? undefined : optionalPhone(body.whatsapp, 'WhatsApp number'),
    dob: body.dob === undefined ? undefined : optionalDateStr(body.dob, 'Date of birth'),
    gstin: body.gstin === undefined ? undefined : gstin,
    address: body.address === undefined ? undefined : optionalStr(body.address, 'Address', { max: 500 }),
    // A GSTIN names its state; when only the GSTIN was given, the state follows it.
    state_code: body.state_code === undefined ? (gstin ? gstin.slice(0, 2) : undefined) : (stateCode ?? (gstin ? gstin.slice(0, 2) : null)),
    notes: body.notes === undefined ? undefined : optionalStr(body.notes, 'Notes', { max: 1000 }),
    customer_type: body.customer_type === undefined ? undefined
      : oneOf(body.customer_type, 'Customer type', ['RETAIL', 'B2B_CONTRACTOR'] as const),
  };
}

const BALANCE_SQL = sql`
  COALESCE((SELECT l.balance_after FROM customer_credit_ledger l
             WHERE l.customer_id = c.customer_id
             ORDER BY l.created_at DESC, l.entry_id DESC LIMIT 1), 0)`;

/** Can this session put money on a customer's account that no sale created? */
function mayPostOpeningBalance(role: string) {
  return role === 'OWNER_ADMIN' || role === 'BRANCH_MANAGER' || role === 'ACCOUNTANT';
}

async function findTill(trx: Tx, branchId: string, userId: string, requested: string | null) {
  if (requested) {
    const till = (await sql<any>`SELECT session_id, status, branch_id FROM till_sessions WHERE session_id = ${requested}`.execute(trx)).rows[0];
    if (!till) throw notFound('That till session does not exist.');
    if (till.branch_id !== branchId) throw badRequest('That till belongs to a different branch.');
    if (till.status !== 'OPEN') throw badRequest('That till is closed.');
    return till.session_id as string;
  }
  return (await sql<{ session_id: string }>`
    SELECT session_id FROM till_sessions
     WHERE branch_id = ${branchId} AND cashier_user_id = ${userId} AND status = 'OPEN'
     ORDER BY opened_at DESC LIMIT 1
  `.execute(trx)).rows[0]?.session_id ?? null;
}

export default async function customersRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_customers', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const search = q.q?.trim().slice(0, 60);
    const digits = search?.replace(/\D/g, '') ?? '';
    const status = q.status === 'inactive' ? 'inactive' : q.status === 'all' ? 'all' : 'active';
    const sort = q.sort === 'balance' ? 'balance' : q.sort === 'name' ? 'name' : 'recent';
    return (await sql<any>`
      SELECT * FROM (
        SELECT c.customer_id, c.phone, c.whatsapp, c.name, c.company_name, c.email, c.dob, c.gstin,
               c.address, c.state, c.state_code, c.customer_type, c.notes, c.is_active,
               c.credit_allowed, c.credit_limit, c.loyalty_points_balance, c.created_at,
               ${BALANCE_SQL} AS balance_owed
          FROM customers c
         WHERE ${status === 'active' ? sql`c.is_active` : status === 'inactive' ? sql`NOT c.is_active` : sql`TRUE`}
           ${search ? sql`AND (c.name ILIKE ${'%' + search + '%'} OR c.company_name ILIKE ${'%' + search + '%'}
                               OR c.gstin ILIKE ${'%' + search + '%'}
                               ${digits.length >= 3 ? sql`OR c.phone LIKE ${'%' + digits + '%'} OR c.whatsapp LIKE ${'%' + digits + '%'}` : sql``}
                               OR c.name % ${search})` : sql``}
           ${q.customer_type ? sql`AND c.customer_type = ${oneOf(q.customer_type, 'Customer type', ['RETAIL', 'B2B_CONTRACTOR'] as const)}::customer_type` : sql``}
           ${q.credit_only === 'true' ? sql`AND c.credit_allowed` : sql``}
      ) x
      WHERE ${q.has_balance === 'true' ? sql`x.balance_owed > 0` : sql`TRUE`}
      ORDER BY ${search ? sql`(x.phone = ${digits || search}) DESC, similarity(x.name, ${search}) DESC,`
                 : sort === 'balance' ? sql`x.balance_owed DESC,` : sort === 'name' ? sql`x.name,` : sql``} x.created_at DESC
      LIMIT ${clampLimit(q.limit, 50, 300)} OFFSET ${Math.max(Number(q.offset) || 0, 0)}
    `.execute(trx)).rows.map((r: any) => ({
      ...r,
      credit_available: Math.max(Number(r.credit_limit) - Number(r.balance_owed), 0),
    }));
  }));

  /** Chain-wide history at the counter (11.1) — what this customer has bought
   *  anywhere in the chain, not just at the branch they happen to be standing in. */
  app.get('/:id', guarded('view_customers', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');

    const own = session.role === 'OWNER_ADMIN';
    const [ledger, invoices, loyalty, payments, returns, summary] = await Promise.all([
      // The BALANCE has to be chain-wide or a single credit limit is meaningless.
      // The detail does not: a cashier needs to know the customer owes money and
      // roughly how old it is, not which invoice another branch raised. Rows from
      // elsewhere are therefore labelled rather than itemised.
      sql<any>`
        SELECT l.entry_id, l.entry_type, l.amount, l.balance_after, l.created_at,
               (l.branch_id IS NOT DISTINCT FROM ${session.branch_id}) AS is_own_branch,
               CASE WHEN ${own} OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN b.name ELSE 'Another branch' END AS branch_name,
               CASE WHEN ${own} OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN l.ref_table END AS ref_table,
               CASE WHEN ${own} OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN l.ref_id END AS ref_id,
               CASE WHEN ${own} OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN COALESCE(i.invoice_number, cp.receipt_number, cn.credit_note_number) END AS reference
          FROM customer_credit_ledger l
          LEFT JOIN branches b ON b.branch_id = l.branch_id
          LEFT JOIN invoices i ON l.ref_table = 'invoices' AND i.invoice_id = l.ref_id
          LEFT JOIN customer_payments cp ON l.ref_table = 'customer_payments' AND cp.payment_id = l.ref_id
          LEFT JOIN sales_returns sr ON l.ref_table = 'sales_returns' AND sr.return_id = l.ref_id
          LEFT JOIN credit_notes cn ON cn.credit_note_id = sr.credit_note_id
         WHERE l.customer_id = ${id} ORDER BY l.created_at DESC, l.entry_id DESC LIMIT 200
      `.execute(trx),
      sql<any>`
        SELECT i.invoice_id, i.invoice_number, round(i.grand_total + i.round_off, 2) AS amount, i.grand_total,
               i.status, i.invoice_type, i.server_received_at, b.name AS branch_name,
               (SELECT SUM(ip.amount) FROM invoice_payments ip WHERE ip.invoice_id = i.invoice_id AND ip.method = 'CREDIT') AS on_credit
          FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
         WHERE i.customer_id = ${id} AND i.status <> 'DRAFT'
         ORDER BY i.server_received_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT * FROM loyalty_transactions WHERE customer_id = ${id}
         ORDER BY created_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT cp.payment_id, cp.receipt_number, cp.amount, cp.method, cp.reference, cp.notes, cp.created_at,
               b.name AS branch_name, u.full_name AS received_by,
               pc.cancelled_at, pc.reason AS cancel_reason
          FROM customer_payments cp JOIN branches b ON b.branch_id = cp.branch_id
          LEFT JOIN users u ON u.user_id = cp.created_by
          LEFT JOIN payment_cancellations pc ON pc.payment_table = 'customer_payments' AND pc.payment_id = cp.payment_id
         WHERE cp.customer_id = ${id} ORDER BY cp.created_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT r.return_id, r.created_at, r.refund_total, r.store_credit_total, r.refund_method, r.return_reason,
               i.invoice_number, cn.credit_note_number, cn.total_amount AS credit_note_total
          FROM sales_returns r JOIN invoices i ON i.invoice_id = r.invoice_id
          LEFT JOIN credit_notes cn ON cn.credit_note_id = r.credit_note_id
         WHERE i.customer_id = ${id} ORDER BY r.created_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT COUNT(*) FILTER (WHERE i.status = 'FINAL') AS invoice_count,
               COALESCE(SUM(i.grand_total + i.round_off) FILTER (WHERE i.status = 'FINAL'), 0) AS gross_sales,
               MAX(i.server_received_at) FILTER (WHERE i.status = 'FINAL') AS last_purchase_at,
               COALESCE((SELECT SUM(r.refund_total + r.store_credit_total) FROM sales_returns r
                          JOIN invoices ri ON ri.invoice_id = r.invoice_id WHERE ri.customer_id = ${id}), 0) AS returns_value
          FROM invoices i WHERE i.customer_id = ${id}
      `.execute(trx),
    ]);

    const balance = Number(ledger.rows[0]?.balance_after ?? 0);
    const s = summary.rows[0];
    return {
      ...customer,
      state_name: customer.state_code ? GST_STATES[customer.state_code] ?? null : null,
      balance_owed: balance,
      credit_available: Math.max(Number(customer.credit_limit) - balance, 0),
      ledger: ledger.rows,
      invoices: invoices.rows,
      loyalty: loyalty.rows,
      payments: payments.rows,
      returns: returns.rows,
      summary: {
        invoice_count: Number(s.invoice_count),
        gross_sales: round2(Number(s.gross_sales)),
        returns_value: round2(Number(s.returns_value)),
        net_sales: round2(Number(s.gross_sales) - Number(s.returns_value)),
        last_purchase_at: s.last_purchase_at,
      },
      lifetime_value: round2(Number(s.gross_sales) - Number(s.returns_value)),
    };
  }));

  /**
   * Section 26 — the customer's statement for a period: the balance brought
   * forward, every entry in the period with its running balance, and the closing
   * balance. It is computed from the ledger alone, so it cannot disagree with the
   * balance the billing counter enforces the credit limit against.
   */
  app.get('/:id/statement', guarded('view_customer_outstanding', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const to = optionalDateStr(q.to, 'To date') ?? businessToday();
    const from = optionalDateStr(q.from, 'From date') ?? addDays(to, -90);
    if (from > to) throw badRequest('The start date is after the end date.');
    const customer = (await sql<any>`
      SELECT customer_id, name, company_name, phone, gstin, address, credit_limit FROM customers WHERE customer_id = ${id}
    `.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');

    const opening = Number((await sql<{ b: string }>`
      SELECT balance_after AS b FROM customer_credit_ledger
       WHERE customer_id = ${id} AND created_at < ${from}::date
       ORDER BY created_at DESC, entry_id DESC LIMIT 1
    `.execute(trx)).rows[0]?.b ?? 0);
    const own = session.role === 'OWNER_ADMIN';
    const entries = (await sql<any>`
      SELECT l.entry_id, l.entry_type, l.amount, l.balance_after, l.created_at,
             CASE WHEN ${own} OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                  THEN b.name ELSE 'Another branch' END AS branch_name,
             CASE WHEN ${own} OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                  THEN COALESCE(i.invoice_number, cp.receipt_number, cn.credit_note_number) END AS reference,
             l.ref_table, cp.method AS payment_method
        FROM customer_credit_ledger l
        LEFT JOIN branches b ON b.branch_id = l.branch_id
        LEFT JOIN invoices i ON l.ref_table = 'invoices' AND i.invoice_id = l.ref_id
        LEFT JOIN customer_payments cp ON l.ref_table = 'customer_payments' AND cp.payment_id = l.ref_id
        LEFT JOIN sales_returns sr ON l.ref_table = 'sales_returns' AND sr.return_id = l.ref_id
        LEFT JOIN credit_notes cn ON cn.credit_note_id = sr.credit_note_id
       WHERE l.customer_id = ${id} AND l.created_at >= ${from}::date AND l.created_at < (${to}::date + 1)
       ORDER BY l.created_at, l.entry_id
       LIMIT 2000
    `.execute(trx)).rows;

    const sumOf = (types: string[]) => round2(entries.filter((e: any) => types.includes(e.entry_type))
      .reduce((s: number, e: any) => s + Number(e.amount), 0));
    const closing = entries.length ? Number(entries[entries.length - 1].balance_after) : opening;
    return {
      customer, from, to,
      opening_balance: round2(opening),
      sales_on_credit: sumOf(['SALE_ON_CREDIT']),
      payments: round2(-sumOf(['PAYMENT_RECEIVED'])),
      returns_and_adjustments: round2(-sumOf(['REFUND_ADJUSTMENT', 'ADJUSTMENT'])),
      opening_entries: sumOf(['OPENING_BALANCE']),
      closing_balance: round2(closing),
      entries,
      // A statement that does not add up is worse than none: say so if it ever doesn't.
      reconciles: Math.abs(round2(opening + entries.reduce((s: number, e: any) => s + Number(e.amount), 0)) - round2(closing)) < 0.01,
    };
  }));

  app.post('/', guarded('edit_customer', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const phone = phoneValue(body.phone);

    // Section 0 — dedup on phone. Rather than erroring, hand back the record that
    // already exists so the cashier just continues with the right customer.
    const existing = (await sql<any>`SELECT * FROM customers WHERE phone = ${phone}`.execute(trx)).rows[0];
    if (existing) return { ...existing, already_existed: true };

    const f = profileFields(body);
    if (!f.name) throw badRequest('Customer name is required.');

    // Only an Admin sets credit terms (6.1); a cashier creating a walk-in cannot
    // hand out a credit line.
    const creditAllowed = session.role === 'OWNER_ADMIN' ? bool(body.credit_allowed, 'credit_allowed', false) : false;
    const creditLimit = creditAllowed ? num(body.credit_limit ?? 0, 'Credit limit', { min: 0, max: 100_000_000 }) : 0;

    const opening = body.opening_balance === undefined || body.opening_balance === '' || body.opening_balance === null
      ? 0 : num(body.opening_balance, 'Opening balance', { min: -100_000_000, max: 100_000_000 });
    if (opening !== 0 && !mayPostOpeningBalance(session.role)) {
      throw forbidden('Only a manager, the accountant or the owner can bring forward an opening balance.');
    }

    const row = (await sql<any>`
      INSERT INTO customers (phone, name, company_name, email, whatsapp, dob, gstin, address, state, state_code,
                             notes, customer_type, credit_allowed, credit_limit, opening_balance)
      VALUES (${phone}, ${f.name}, ${f.company_name ?? null}, ${f.email ?? null}, ${f.whatsapp ?? null},
              ${f.dob ?? null}::date, ${f.gstin ?? null}, ${f.address ?? null},
              ${f.state_code ? GST_STATES[f.state_code] : null}, ${f.state_code ?? null},
              ${f.notes ?? null}, ${f.customer_type ?? 'RETAIL'}::customer_type,
              ${creditAllowed}, ${creditLimit}, ${opening})
      RETURNING *
    `.execute(trx)).rows[0];

    // The opening balance is a ledger entry, not just a number on the record, so
    // the statement and the credit check both see it.
    if (opening !== 0) {
      await postCredit(trx, {
        customerId: row.customer_id, branchId: session.branch_id ?? session.active_branch_id ?? null,
        entryType: 'OPENING_BALANCE', amount: round2(opening), refTable: 'customers', refId: row.customer_id,
      });
      await audit(trx, session, 'OPENING_BALANCE', 'customers', row.customer_id, { after: { opening_balance: opening } });
    }
    await audit(trx, session, 'CUSTOMER_CREATED', 'customers', row.customer_id,
      { after: { name: row.name, phone, gstin: row.gstin, credit_limit: creditLimit } });
    return row;
  }));

  app.put('/:id', guarded('edit_customer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw notFound('Customer not found.');

    let phone = before.phone as string;
    if (body.phone !== undefined && body.phone !== before.phone) {
      phone = phoneValue(body.phone);
      const clash = (await sql<any>`SELECT name FROM customers WHERE phone = ${phone} AND customer_id <> ${id}`.execute(trx)).rows[0];
      if (clash) throw conflict(`${phone} already belongs to ${clash.name}. Use Merge if they are the same person.`);
    }
    const f = profileFields(body);
    const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
    const stateCode = pick(f.state_code, before.state_code);
    const isActive = body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active');
    if (!isActive && before.is_active && session.role === 'CASHIER') {
      throw forbidden('A cashier cannot deactivate a customer account.');
    }

    await sql`
      UPDATE customers SET
        phone = ${phone},
        name = ${pick(f.name, before.name)},
        company_name = ${pick(f.company_name, before.company_name)},
        email = ${pick(f.email, before.email)},
        whatsapp = ${pick(f.whatsapp, before.whatsapp)},
        dob = ${pick(f.dob, before.dob)}::date,
        gstin = ${pick(f.gstin, before.gstin)},
        address = ${pick(f.address, before.address)},
        state_code = ${stateCode},
        state = ${stateCode ? GST_STATES[stateCode] ?? before.state : null},
        notes = ${pick(f.notes, before.notes)},
        customer_type = ${pick(f.customer_type, before.customer_type)}::customer_type,
        is_active = ${isActive},
        updated_at = now()
      WHERE customer_id = ${id}
    `.execute(trx);
    const changed = Object.fromEntries(Object.keys(body).map((k) => [k, before[k]]));
    await audit(trx, session, 'CUSTOMER_UPDATED', 'customers', id, { before: changed, after: body });
    return { ok: true };
  }));

  /** 6.1 — the credit limit is set by Admin only, and the change is audited. */
  app.put('/:id/credit', guarded('set_credit_limit', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = bool(body.credit_allowed, 'credit_allowed');
    const limitValue = allowed ? num(body.credit_limit, 'Credit limit', { min: 0, max: 100_000_000 }) : 0;

    const before = (await sql<any>`SELECT credit_allowed, credit_limit FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Customer not found.');

    await sql`
      UPDATE customers SET credit_allowed = ${allowed}, credit_limit = ${limitValue}, updated_at = now() WHERE customer_id = ${id}
    `.execute(trx);
    // 6.1.1 — keep the offline cache in step, so a till that goes offline carries
    // the new limit rather than the old one.
    await sql`
      INSERT INTO customer_credit_cache (customer_id, cached_credit_limit, cached_balance_owed, cached_at)
      VALUES (${id}, ${limitValue},
              COALESCE((SELECT balance_after FROM customer_credit_ledger WHERE customer_id = ${id}
                         ORDER BY created_at DESC, entry_id DESC LIMIT 1), 0), now())
      ON CONFLICT (customer_id) DO UPDATE
        SET cached_credit_limit = EXCLUDED.cached_credit_limit, cached_at = now()
    `.execute(trx);

    await audit(trx, session, 'CREDIT_LIMIT_CHANGE', 'customers', id,
      { before, after: { credit_allowed: allowed, credit_limit: limitValue } });
    return { ok: true };
  }));

  /**
   * 6.3 — a customer paying against their account. It is a RECEIPT: its own
   * number, how it was paid, a reference, and — when it is cash — the drawer it
   * went into, so the close-of-day count expects it. Posted to the ledger under
   * the customer row lock, so it cannot race a credit sale at another branch.
   */
  app.post('/:id/payments', guarded('record_customer_payment', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = round2(num(body.amount, 'Amount', { min: 0.01, max: 100_000_000 }));
    const method = oneOf(body.method ?? 'CASH', 'Payment method', RECEIPT_METHODS);
    const reference = optionalStr(body.reference, 'Reference', { max: 80 });
    if ((method === 'BANK_TRANSFER' || method === 'CHEQUE') && !reference) {
      throw badRequest(method === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the bank transfer reference (UTR).');
    }
    const branchId = writeBranch(session, body.branch_id as string);
    const clientTxnId = optionalUuid(body.client_txn_id, 'client_txn_id');

    // Idempotent: the same form submitted twice records one receipt.
    if (clientTxnId) {
      const dup = (await sql<any>`SELECT * FROM customer_payments WHERE client_txn_id = ${clientTxnId}`.execute(trx)).rows[0];
      if (dup) {
        return { ...dup, duplicate: true, balance_owed: await creditBalance(trx, id) };
      }
    }

    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');

    // An overpayment is refused unless it is explicitly taken as an ADVANCE —
    // otherwise a slipped digit turns into money the shop owes back.
    const current = await creditBalance(trx, id);
    const asAdvance = body.allow_advance === true;
    if (amount > round2(current) + 0.005 && !asAdvance) {
      throw badRequest(current > 0
        ? `${customer.name} owes ₹${current.toFixed(2)}. A payment cannot be more than the outstanding balance unless it is taken as an advance.`
        : `${customer.name} has nothing outstanding. Take this as an advance if they are paying ahead.`);
    }

    const tillSessionId = method === 'CASH'
      ? await findTill(trx, branchId, session.user_id, optionalUuid(body.till_session_id, 'Till session'))
      : null;

    const receiptNumber = await nextNumber(trx, branchId, 'RECEIPT');
    const payment = (await sql<any>`
      INSERT INTO customer_payments (receipt_number, customer_id, branch_id, amount, method, reference, notes,
                                     till_session_id, client_txn_id, created_by)
      VALUES (${receiptNumber}, ${id}, ${branchId}, ${amount}, ${method}, ${reference},
              ${optionalStr(body.notes, 'Notes', { max: 300 })}, ${tillSessionId}, ${clientTxnId}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    const posted = await postCredit(trx, {
      customerId: id, branchId, entryType: 'PAYMENT_RECEIVED',
      amount: -amount, refTable: 'customer_payments', refId: payment.payment_id,
    });

    if (tillSessionId) {
      await sql`
        INSERT INTO till_events (session_id, event_type, amount, ref_table, ref_id, note)
        VALUES (${tillSessionId}, 'CASH_RECEIPT', ${amount}, 'customer_payments', ${payment.payment_id},
                ${'Receipt ' + receiptNumber + ' — ' + customer.name})
      `.execute(trx);
    }

    await audit(trx, session, 'CUSTOMER_PAYMENT', 'customers', id, {
      before: { balance: current },
      after: { receipt_number: receiptNumber, amount, method, reference, balance: posted.balance_after,
               advance: asAdvance && amount > current },
    }, { branchId });

    return {
      ...payment,
      balance_owed: posted.balance_after,
      till_session_id: tillSessionId,
      till_note: method === 'CASH' && !tillSessionId
        ? 'No till was open for you, so this cash is not in any drawer count.' : null,
    };
  }));

  /**
   * Cancel a receipt recorded by mistake. The receipt stays on file marked
   * cancelled; the customer's balance goes back up by the amount, and cash taken
   * into a till that is still open comes back out of the expected drawer cash.
   */
  app.post('/payments/:paymentId/cancel', guarded('cancel_customer_payment', async ({ session, db: trx, req }) => {
    const paymentId = uuid((req.params as any).paymentId, 'payment_id');
    const reason = str((req.body as any)?.reason, 'Reason', { max: 300 });
    const payment = (await sql<any>`
      SELECT cp.*, c.name AS customer_name FROM customer_payments cp JOIN customers c ON c.customer_id = cp.customer_id
       WHERE cp.payment_id = ${paymentId}
    `.execute(trx)).rows[0];
    if (!payment) throw notFound('Receipt not found.');
    const done = (await sql<any>`
      SELECT 1 FROM payment_cancellations WHERE payment_table = 'customer_payments' AND payment_id = ${paymentId}
    `.execute(trx)).rows[0];
    if (done) throw conflict(`Receipt ${payment.receipt_number} is already cancelled.`);

    const cancellation = (await sql<any>`
      INSERT INTO payment_cancellations (payment_table, payment_id, branch_id, reason, cancelled_by)
      VALUES ('customer_payments', ${paymentId}, ${payment.branch_id}, ${reason}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];
    const amount = Number(payment.amount);
    const posted = await postCredit(trx, {
      customerId: payment.customer_id, branchId: payment.branch_id, entryType: 'ADJUSTMENT',
      amount, refTable: 'customer_payments', refId: paymentId,
    });

    let tillNote: string | null = null;
    if (payment.till_session_id) {
      const till = (await sql<any>`SELECT status FROM till_sessions WHERE session_id = ${payment.till_session_id}`.execute(trx)).rows[0];
      if (till && till.status === 'OPEN') {
        await sql`
          INSERT INTO till_events (session_id, event_type, amount, ref_table, ref_id, note)
          VALUES (${payment.till_session_id}, 'CASH_RECEIPT', ${-amount}, 'payment_cancellations', ${cancellation.cancellation_id},
                  ${'Receipt ' + payment.receipt_number + ' cancelled'})
        `.execute(trx);
      } else {
        tillNote = 'That till is already closed, so its cash count is not changed. Hand the cash back or record it separately.';
      }
    }

    await audit(trx, session, 'PAYMENT_CANCELLED', 'customer_payments', paymentId, {
      before: { receipt_number: payment.receipt_number, amount, method: payment.method },
      after: { reason, balance: posted.balance_after },
    }, { branchId: payment.branch_id });
    return { ok: true, balance_owed: posted.balance_after, till_note: tillNote };
  }));

  /** 6.2 — outstanding list with ageing, which is what the reminders run off. */
  app.get('/outstanding/list', guarded('view_customer_outstanding', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      -- Ageing runs from the oldest charge still unpaid once payments are applied
      -- oldest-first (erp_customer_dues), not from the first credit sale ever made.
      SELECT c.customer_id, c.name, c.company_name, c.phone, c.whatsapp, c.credit_limit, c.customer_type,
             d.balance AS balance_owed, d.last_activity, d.oldest_unpaid_at,
             (CURRENT_DATE - d.oldest_unpaid_at::date) AS days_outstanding,
             CASE
               WHEN (CURRENT_DATE - d.oldest_unpaid_at::date) > 90 THEN '90+'
               WHEN (CURRENT_DATE - d.oldest_unpaid_at::date) > 60 THEN '61-90'
               WHEN (CURRENT_DATE - d.oldest_unpaid_at::date) > 30 THEN '31-60'
               ELSE '0-30' END AS ageing_bucket
        FROM erp_customer_dues() d
        JOIN customers c ON c.customer_id = d.customer_id
       WHERE d.balance > 0
       ORDER BY d.balance DESC
       LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
  }));

  /** 6.2 — queue reminders for everyone carrying a balance past the given age.
   *  An explicit action by a person, never automatic. */
  app.post('/outstanding/send-reminders', guarded('record_customer_payment', async ({ session, db: trx, req }) => {
    const minDays = Math.min(Math.max(Number((req.body as any)?.min_days_outstanding ?? 15), 0), 3650);
    const rows = (await sql<any>`
      SELECT c.customer_id, c.name, COALESCE(c.whatsapp, c.phone) AS phone, d.balance AS balance_after
        FROM erp_customer_dues() d JOIN customers c ON c.customer_id = d.customer_id AND c.is_active
       WHERE d.balance > 0 AND c.phone IS NOT NULL
         AND COALESCE(CURRENT_DATE - d.oldest_unpaid_at::date, 0) >= ${minDays}
    `.execute(trx)).rows;

    for (const c of rows) {
      await queueMessage(trx, {
        to_phone: c.phone, customer_id: c.customer_id, message_type: 'DUE_REMINDER',
        body: `Namaste ${c.name}, a balance of ₹${Number(c.balance_after).toFixed(2)} is outstanding on your account. Please settle it at your convenience. Thank you.` });
    }
    await audit(trx, session, 'SETTING_CHANGE', 'whatsapp_message_log', null,
      { after: { due_reminders_queued: rows.length, min_days_outstanding: minDays } });
    return { ok: true, queued: rows.length };
  }));

  /** Section 0 — the manual merge tool for an accidental double registration. */
  app.post('/merge', guarded('merge_customers', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const primaryId = uuid(body.primary_customer_id, 'Primary customer');
    const duplicateId = uuid(body.duplicate_customer_id, 'Duplicate customer');
    if (primaryId === duplicateId) throw badRequest('Pick two different customer records to merge.');

    const [primary, duplicate] = await Promise.all([
      sql<any>`SELECT * FROM customers WHERE customer_id = ${primaryId} FOR UPDATE`.execute(trx),
      sql<any>`SELECT * FROM customers WHERE customer_id = ${duplicateId} FOR UPDATE`.execute(trx),
    ]);
    if (!primary.rows[0] || !duplicate.rows[0]) throw notFound('One of those customers no longer exists.');

    // A finalised invoice's buyer is otherwise frozen by the database; this is the
    // one sanctioned path that may re-point it, and only for this transaction.
    await sql`SELECT set_config('erp.customer_merge', 'on', true)`.execute(trx);

    // Everything moves to the surviving record: invoices, ledger, loyalty and
    // messages, so the merged history is complete rather than merely relabelled.
    await sql`UPDATE invoices SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE customer_credit_ledger SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE customer_payments SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE loyalty_transactions SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE whatsapp_message_log SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE quotations SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);

    // The two ledgers were each a running balance; merged, the running balance has
    // to be recomputed over the combined history in date order or the statement
    // would jump between the two customers' figures.
    await sql`
      WITH ordered AS (
        SELECT entry_id, SUM(amount) OVER (ORDER BY created_at, entry_id) AS running
          FROM customer_credit_ledger WHERE customer_id = ${primaryId}
      )
      UPDATE customer_credit_ledger l SET balance_after = o.running FROM ordered o WHERE l.entry_id = o.entry_id
    `.execute(trx);

    const points = Number(primary.rows[0].loyalty_points_balance) + Number(duplicate.rows[0].loyalty_points_balance);
    await sql`UPDATE customers SET loyalty_points_balance = ${points}, updated_at = now() WHERE customer_id = ${primaryId}`.execute(trx);

    // The duplicate is retired, not deleted — its phone is freed with a marker so
    // the row can still be found if the merge later turns out to be wrong.
    await sql`
      UPDATE customers SET phone = ${'MERGED-' + duplicate.rows[0].phone},
             name = ${duplicate.rows[0].name + ' (merged)'}, credit_allowed = FALSE, credit_limit = 0,
             is_active = FALSE, updated_at = now()
       WHERE customer_id = ${duplicateId}
    `.execute(trx);
    await sql`
      INSERT INTO customer_merge_log (primary_customer_id, merged_customer_id, merged_by)
      VALUES (${primaryId}, ${duplicateId}, ${session.user_id})
    `.execute(trx);

    await audit(trx, session, 'CUSTOMER_MERGED', 'customers', primaryId, { after: { merged: duplicateId } });
    return { ok: true, merged_points_balance: points };
  }));

  /** 15 — customer personal-data export is restricted to Admin, and the export
   *  itself is recorded, because "who pulled the customer list" is exactly the
   *  question a data-protection review asks. */
  app.get('/:id/export', guarded('export_customer_pii', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');
    const invoices = (await sql<any>`
      SELECT invoice_number, grand_total, round_off, server_received_at FROM invoices WHERE customer_id = ${id} AND status <> 'DRAFT'
    `.execute(trx)).rows;
    const ledger = (await sql<any>`SELECT * FROM customer_credit_ledger WHERE customer_id = ${id} ORDER BY created_at`.execute(trx)).rows;
    await audit(trx, session, 'PII_EXPORTED', 'customers', id);
    return { customer, invoices, ledger, exported_at: new Date().toISOString(), exported_by: session.full_name };
  }));
}
