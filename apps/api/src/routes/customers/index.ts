// ============================================================================
// Section 6 — Customers & Credit Ledger
// Customer identity is CHAIN-WIDE (Section 0): the same person buying at two
// branches is one record, deduplicated on phone number, so their credit balance,
// loyalty points and purchase history stay correct wherever they shop.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, str, optionalStr, num, bool, oneOf, limit as clampLimit, writeBranch,
} from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { round2 } from '../../lib/tax.js';
import { audit } from '../../lib/audit.js';
import { queueMessage } from '../../lib/whatsapp.js';
import { creditBalance, postCredit } from '../../lib/ledger.js';

export default async function customersRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_customers', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const search = q.q?.trim();
    return (await sql<any>`
      SELECT c.customer_id, c.phone, c.name, c.email, c.dob, c.gstin, c.customer_type,
             c.credit_allowed, c.credit_limit, c.loyalty_points_balance, c.created_at,
             COALESCE(bal.balance_after, 0) AS balance_owed,
             GREATEST(c.credit_limit - COALESCE(bal.balance_after, 0), 0) AS credit_available
        FROM customers c
        LEFT JOIN LATERAL (
            SELECT balance_after FROM customer_credit_ledger
             WHERE customer_id = c.customer_id ORDER BY created_at DESC, entry_id DESC LIMIT 1
        ) bal ON TRUE
       WHERE 1=1
         ${search ? sql`AND (c.name ILIKE ${'%' + search + '%'} OR c.phone ILIKE ${'%' + search + '%'}
                             OR c.name % ${search})` : sql``}
         ${q.customer_type ? sql`AND c.customer_type = ${q.customer_type}::customer_type` : sql``}
         ${q.credit_only === 'true' ? sql`AND c.credit_allowed` : sql``}
       ORDER BY ${search ? sql`similarity(c.name, ${search}) DESC,` : sql``} c.created_at DESC
       LIMIT ${clampLimit(q.limit, 50, 300)}
    `.execute(trx)).rows;
  }));

  /** Chain-wide history at the counter (11.1) — what this customer has bought
   *  anywhere in the chain, not just at the branch they happen to be standing in. */
  app.get('/:id', guarded('view_customers', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');

    const [ledger, invoices, loyalty] = await Promise.all([
      // The BALANCE has to be chain-wide or a single credit limit is meaningless.
      // The detail does not: a cashier needs to know the customer owes money and
      // roughly how old it is, not which invoice another branch raised. Rows from
      // elsewhere are therefore labelled rather than itemised.
      sql<any>`
        SELECT l.entry_id, l.entry_type, l.amount, l.balance_after, l.created_at,
               (l.branch_id IS NOT DISTINCT FROM ${session.branch_id}) AS is_own_branch,
               CASE WHEN ${session.role === 'OWNER_ADMIN'}
                      OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN b.name ELSE 'Another branch' END AS branch_name,
               CASE WHEN ${session.role === 'OWNER_ADMIN'}
                      OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN l.ref_table END AS ref_table,
               CASE WHEN ${session.role === 'OWNER_ADMIN'}
                      OR l.branch_id IS NOT DISTINCT FROM ${session.branch_id}
                    THEN l.ref_id END AS ref_id
          FROM customer_credit_ledger l
          LEFT JOIN branches b ON b.branch_id = l.branch_id
         WHERE l.customer_id = ${id} ORDER BY l.created_at DESC LIMIT 200
      `.execute(trx),
      sql<any>`
        SELECT i.invoice_id, i.invoice_number, i.grand_total, i.status, i.server_received_at,
               b.name AS branch_name
          FROM invoices i JOIN branches b ON b.branch_id = i.branch_id
         WHERE i.customer_id = ${id} ORDER BY i.server_received_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT * FROM loyalty_transactions WHERE customer_id = ${id}
         ORDER BY created_at DESC LIMIT 100
      `.execute(trx),
    ]);

    const balance = Number(ledger.rows[0]?.balance_after ?? 0);
    return {
      ...customer,
      balance_owed: balance,
      credit_available: Math.max(Number(customer.credit_limit) - balance, 0),
      ledger: ledger.rows,
      invoices: invoices.rows,
      loyalty: loyalty.rows,
      lifetime_value: round2(invoices.rows
        .filter((i: any) => i.status === 'FINAL')
        .reduce((s: number, i: any) => s + Number(i.grand_total), 0)),
    };
  }));

  app.post('/', guarded('edit_customer', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const phone = str(body.phone, 'Phone number', { max: 20 });
    if (!/^[0-9+\-\s]{8,20}$/.test(phone)) throw badRequest('Please enter a valid phone number.');

    // Section 0 — dedup on phone. Rather than erroring, hand back the record that
    // already exists so the cashier just continues with the right customer.
    const existing = (await sql<any>`SELECT * FROM customers WHERE phone = ${phone}`.execute(trx)).rows[0];
    if (existing) return { ...existing, already_existed: true };

    // Only an Admin sets credit terms (6.1); a cashier creating a walk-in cannot
    // hand out a credit line.
    const creditAllowed = session.role === 'OWNER_ADMIN' ? bool(body.credit_allowed, 'credit_allowed', false) : false;
    const creditLimit = creditAllowed ? num(body.credit_limit ?? 0, 'Credit limit', { min: 0 }) : 0;

    return (await sql<any>`
      INSERT INTO customers (phone, name, email, dob, gstin, customer_type, credit_allowed, credit_limit)
      VALUES (${phone}, ${str(body.name, 'Customer name', { max: 150 })},
              ${optionalStr(body.email, 'Email', { max: 254 })},
              ${optionalStr(body.dob, 'Date of birth', { max: 20 })}::date,
              ${optionalStr(body.gstin, 'GSTIN', { max: 20 })},
              ${oneOf(body.customer_type ?? 'RETAIL', 'Customer type', ['RETAIL', 'B2B_CONTRACTOR'] as const)}::customer_type,
              ${creditAllowed}, ${creditLimit})
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  app.put('/:id', guarded('edit_customer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Customer not found.');

    await sql`
      UPDATE customers SET
        name = ${optionalStr(body.name, 'Customer name', { max: 150 }) ?? before.name},
        email = ${body.email === undefined ? before.email : optionalStr(body.email, 'Email', { max: 254 })},
        dob = ${body.dob === undefined ? before.dob : optionalStr(body.dob, 'Date of birth', { max: 20 })}::date,
        gstin = ${body.gstin === undefined ? before.gstin : optionalStr(body.gstin, 'GSTIN', { max: 20 })},
        customer_type = ${body.customer_type ? oneOf(body.customer_type, 'Customer type', ['RETAIL', 'B2B_CONTRACTOR'] as const) : before.customer_type}::customer_type
      WHERE customer_id = ${id}
    `.execute(trx);
    return { ok: true };
  }));

  /** 6.1 — the credit limit is set by Admin only, and the change is audited. */
  app.put('/:id/credit', guarded('set_credit_limit', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = bool(body.credit_allowed, 'credit_allowed');
    const limitValue = allowed ? num(body.credit_limit, 'Credit limit', { min: 0 }) : 0;

    const before = (await sql<any>`SELECT credit_allowed, credit_limit FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Customer not found.');

    await sql`
      UPDATE customers SET credit_allowed = ${allowed}, credit_limit = ${limitValue} WHERE customer_id = ${id}
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

  /** 6.3 — partial payments against the running chain-wide balance. */
  app.post('/:id/payments', guarded('record_customer_payment', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'customer_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = num(body.amount, 'Amount', { min: 0.01 });
    const branchId = writeBranch(session, body.branch_id as string);

    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id}`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');

    const current = await creditBalance(trx, id);
    if (amount > current + 0.01) {
      throw badRequest(`${customer.name} owes ₹${current.toFixed(2)}. A payment cannot exceed the outstanding balance.`);
    }

    // Posted under a lock on the customer, so a payment taken at one branch while
    // a credit sale is being rung up at another cannot overwrite it.
    const posted = await postCredit(trx, {
      customerId: id, branchId, entryType: 'PAYMENT_RECEIVED',
      amount: -amount, refTable: 'manual',
    });
    const balanceAfter = posted.balance_after;
    const entry = { entry_id: posted.entry_id, amount: -amount, balance_after: balanceAfter };

    if (customer.phone) {
      await queueMessage(trx, {
        to_phone: customer.phone, customer_id: id, message_type: 'DUE_REMINDER',
        body: `Payment of ₹${amount.toFixed(2)} received. Your outstanding balance is now ₹${balanceAfter.toFixed(2)}. Thank you.`,
      });
    }
    return { ...entry, balance_owed: balanceAfter };
  }));

  /** 6.2 — outstanding list with ageing, which is what the reminders run off. */
  app.get('/outstanding/list', guarded('view_customers', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      WITH latest AS (
        SELECT DISTINCT ON (customer_id) customer_id, balance_after, created_at AS last_activity
          FROM customer_credit_ledger ORDER BY customer_id, created_at DESC, entry_id DESC
      ), oldest_unpaid AS (
        SELECT customer_id, MIN(created_at) AS oldest_sale
          FROM customer_credit_ledger WHERE entry_type = 'SALE_ON_CREDIT' GROUP BY customer_id
      )
      SELECT c.customer_id, c.name, c.phone, c.credit_limit, c.customer_type,
             l.balance_after AS balance_owed, l.last_activity,
             (CURRENT_DATE - o.oldest_sale::date) AS days_outstanding,
             CASE
               WHEN (CURRENT_DATE - o.oldest_sale::date) > 90 THEN '90+'
               WHEN (CURRENT_DATE - o.oldest_sale::date) > 60 THEN '61-90'
               WHEN (CURRENT_DATE - o.oldest_sale::date) > 30 THEN '31-60'
               ELSE '0-30' END AS ageing_bucket
        FROM latest l
        JOIN customers c ON c.customer_id = l.customer_id
        LEFT JOIN oldest_unpaid o ON o.customer_id = c.customer_id
       WHERE l.balance_after > 0
       ORDER BY l.balance_after DESC
       LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
  }));

  /** 6.2 — queue reminders for everyone carrying a balance past the given age. */
  app.post('/outstanding/send-reminders', guarded('record_customer_payment', async ({ db: trx, req }) => {
    const minDays = Math.max(Number((req.body as any)?.min_days_outstanding ?? 15), 0);
    const rows = (await sql<any>`
      WITH latest AS (
        SELECT DISTINCT ON (customer_id) customer_id, balance_after
          FROM customer_credit_ledger ORDER BY customer_id, created_at DESC, entry_id DESC
      ), oldest AS (
        SELECT customer_id, MIN(created_at) AS oldest_sale
          FROM customer_credit_ledger WHERE entry_type = 'SALE_ON_CREDIT' GROUP BY customer_id
      )
      SELECT c.customer_id, c.name, c.phone, l.balance_after
        FROM latest l JOIN customers c ON c.customer_id = l.customer_id
        LEFT JOIN oldest o ON o.customer_id = c.customer_id
       WHERE l.balance_after > 0 AND c.phone IS NOT NULL
         AND COALESCE(CURRENT_DATE - o.oldest_sale::date, 0) >= ${minDays}
    `.execute(trx)).rows;

    for (const c of rows) {
      await queueMessage(trx, {
        to_phone: c.phone, customer_id: c.customer_id, message_type: 'DUE_REMINDER',
        body: `Namaste ${c.name}, a balance of ₹${Number(c.balance_after).toFixed(2)} is outstanding on your account. Please settle it at your convenience. Thank you.`,
      });
    }
    return { ok: true, queued: rows.length };
  }));

  /** Section 0 — the manual merge tool for an accidental double registration. */
  app.post('/merge', guarded('merge_customers', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const primaryId = uuid(body.primary_customer_id, 'Primary customer');
    const duplicateId = uuid(body.duplicate_customer_id, 'Duplicate customer');
    if (primaryId === duplicateId) throw badRequest('Pick two different customer records to merge.');

    const [primary, duplicate] = await Promise.all([
      sql<any>`SELECT * FROM customers WHERE customer_id = ${primaryId}`.execute(trx),
      sql<any>`SELECT * FROM customers WHERE customer_id = ${duplicateId}`.execute(trx),
    ]);
    if (!primary.rows[0] || !duplicate.rows[0]) throw notFound('One of those customers no longer exists.');

    // Everything moves to the surviving record: invoices, ledger, loyalty and
    // messages, so the merged history is complete rather than merely relabelled.
    await sql`UPDATE invoices SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE customer_credit_ledger SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE loyalty_transactions SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE whatsapp_message_log SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);
    await sql`UPDATE quotations SET customer_id = ${primaryId} WHERE customer_id = ${duplicateId}`.execute(trx);

    const points = Number(primary.rows[0].loyalty_points_balance) + Number(duplicate.rows[0].loyalty_points_balance);
    await sql`UPDATE customers SET loyalty_points_balance = ${points} WHERE customer_id = ${primaryId}`.execute(trx);

    // The duplicate is retired, not deleted — its phone is freed with a marker so
    // the row can still be found if the merge later turns out to be wrong.
    await sql`
      UPDATE customers SET phone = ${'MERGED-' + duplicate.rows[0].phone},
             name = ${duplicate.rows[0].name + ' (merged)'}, credit_allowed = FALSE, credit_limit = 0
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
      SELECT invoice_number, grand_total, server_received_at FROM invoices WHERE customer_id = ${id}
    `.execute(trx)).rows;
    const ledger = (await sql<any>`SELECT * FROM customer_credit_ledger WHERE customer_id = ${id}`.execute(trx)).rows;
    await audit(trx, session, 'PII_EXPORTED', 'customers', id);
    return { customer, invoices, ledger, exported_at: new Date().toISOString(), exported_by: session.full_name };
  }));
}
