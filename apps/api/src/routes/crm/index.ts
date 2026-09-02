// ============================================================================
// Section 11 — CRM, Marketing & Loyalty
//   11.1 birthday/anniversary greetings, festival broadcasts to a segment,
//        chain-wide purchase history at the counter
//   11.2 loyalty points: earn rate, redemption, expiry
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, str, optionalStr, num, oneOf, limit as clampLimit } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { loadSettings } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { queueMessage } from '../../lib/whatsapp.js';

export default async function crmRoutes(app: FastifyInstance) {
  // ── Loyalty (11.2) ────────────────────────────────────────────────────────
  app.get('/loyalty/:customer_id', guarded('view_customers', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).customer_id, 'customer_id');
    const customer = (await sql<any>`
      SELECT customer_id, name, phone, loyalty_points_balance FROM customers WHERE customer_id = ${id}
    `.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');
    const txns = (await sql<any>`
      SELECT lt.*, i.invoice_number FROM loyalty_transactions lt
        LEFT JOIN invoices i ON i.invoice_id = lt.invoice_id
       WHERE lt.customer_id = ${id} ORDER BY lt.created_at DESC LIMIT 200
    `.execute(trx)).rows;
    return { ...customer, transactions: txns };
  }));

  app.post('/loyalty/:customer_id/adjust', guarded('adjust_loyalty', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).customer_id, 'customer_id');
    const points = num((req.body as any)?.points, 'Points', { min: -100000, max: 100000 });
    const reason = str((req.body as any)?.reason, 'Reason', { max: 300 });
    if (points === 0) throw badRequest('Enter a non-zero adjustment.');

    const customer = (await sql<any>`SELECT * FROM customers WHERE customer_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!customer) throw notFound('Customer not found.');
    const balance = Number(customer.loyalty_points_balance) + points;
    if (balance < 0) throw badRequest(`That would take the balance below zero (currently ${customer.loyalty_points_balance}).`);

    await sql`UPDATE customers SET loyalty_points_balance = ${balance} WHERE customer_id = ${id}`.execute(trx);
    await sql`
      INSERT INTO loyalty_transactions (customer_id, txn_type, points, balance_after)
      VALUES (${id}, ${points > 0 ? 'RESTORE' : 'REVOKE'}::loyalty_txn_type, ${points}, ${balance})
    `.execute(trx);
    await audit(trx, session, 'LOYALTY_ADJUSTMENT', 'customers', id, { after: { points, reason, balance } });
    return { ok: true, balance_after: balance };
  }));

  /** 11.2 point expiry — points older than the configured window lapse. */
  app.post('/loyalty/expire-stale', guarded('adjust_loyalty', async ({ session, db: trx }) => {
    const settings = await loadSettings(trx, session.branch_id);
    const days = Number(settings.loyalty_point_expiry_days);
    const stale = (await sql<any>`
      SELECT c.customer_id, c.name, c.loyalty_points_balance
        FROM customers c
       WHERE c.loyalty_points_balance > 0
         AND NOT EXISTS (
           SELECT 1 FROM loyalty_transactions lt
            WHERE lt.customer_id = c.customer_id
              AND lt.created_at > now() - make_interval(days => ${days})
         )
    `.execute(trx)).rows;

    for (const c of stale) {
      await sql`UPDATE customers SET loyalty_points_balance = 0 WHERE customer_id = ${c.customer_id}`.execute(trx);
      await sql`
        INSERT INTO loyalty_transactions (customer_id, txn_type, points, balance_after)
        VALUES (${c.customer_id}, 'EXPIRE', ${-Number(c.loyalty_points_balance)}, 0)
      `.execute(trx);
    }
    return { ok: true, customers_expired: stale.length, expiry_days: days };
  }));

  // ── Campaigns (11.1) ──────────────────────────────────────────────────────
  app.get('/campaigns', guarded('view_customers', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT mc.*, u.full_name AS created_by_name,
             (SELECT count(*) FROM whatsapp_message_log WHERE campaign_id = mc.campaign_id) AS messages_sent
        FROM marketing_campaigns mc LEFT JOIN users u ON u.user_id = mc.created_by
       ORDER BY mc.scheduled_at DESC NULLS LAST LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.post('/campaigns', guarded('manage_campaigns', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return (await sql<any>`
      INSERT INTO marketing_campaigns (name, campaign_type, segment_query, message_template, scheduled_at, created_by)
      VALUES (${str(body.name, 'Campaign name', { max: 150 })},
              ${oneOf(body.campaign_type, 'Campaign type', ['BIRTHDAY', 'FESTIVAL', 'WINBACK', 'ANNIVERSARY'] as const)},
              ${body.segment_query ? JSON.stringify(body.segment_query) : null}::jsonb,
              ${str(body.message_template, 'Message', { max: 1000 })},
              ${optionalStr(body.scheduled_at, 'Scheduled at', { max: 40 })}::timestamptz,
              ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  /**
   * Sends a campaign to a segment. The segment is built here rather than accepted
   * from the client, so a broadcast can never be aimed at an arbitrary phone list.
   * {{name}} and {{points}} are substituted per recipient.
   */
  app.post('/campaigns/:id/send', guarded('manage_campaigns', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'campaign_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const campaign = (await sql<any>`SELECT * FROM marketing_campaigns WHERE campaign_id = ${id}`.execute(trx)).rows[0];
    if (!campaign) throw notFound('Campaign not found.');

    const segment = oneOf(body.segment ?? 'ALL', 'Segment',
      ['ALL', 'B2B_CONTRACTOR', 'RETAIL', 'WITH_BALANCE', 'LAPSED_90D', 'BIRTHDAY_TODAY'] as const);

    const recipients = (await sql<any>`
      SELECT c.customer_id, c.name, c.phone, c.loyalty_points_balance
        FROM customers c
       WHERE c.phone IS NOT NULL AND c.phone NOT LIKE 'MERGED-%'
         ${segment === 'B2B_CONTRACTOR' ? sql`AND c.customer_type = 'B2B_CONTRACTOR'` : sql``}
         ${segment === 'RETAIL' ? sql`AND c.customer_type = 'RETAIL'` : sql``}
         ${segment === 'BIRTHDAY_TODAY' ? sql`AND c.dob IS NOT NULL
              AND EXTRACT(MONTH FROM c.dob) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(DAY FROM c.dob) = EXTRACT(DAY FROM CURRENT_DATE)` : sql``}
         ${segment === 'WITH_BALANCE' ? sql`AND COALESCE((SELECT balance_after FROM customer_credit_ledger
              WHERE customer_id = c.customer_id ORDER BY created_at DESC LIMIT 1), 0) > 0` : sql``}
         ${segment === 'LAPSED_90D' ? sql`AND NOT EXISTS (SELECT 1 FROM invoices i
              WHERE i.customer_id = c.customer_id AND i.server_received_at > now() - interval '90 days')` : sql``}
       LIMIT 5000
    `.execute(trx)).rows;

    for (const r of recipients) {
      const message = String(campaign.message_template)
        .replace(/\{\{\s*name\s*\}\}/g, r.name)
        .replace(/\{\{\s*points\s*\}\}/g, String(r.loyalty_points_balance ?? 0))
        .replace(/\{\{\s*date\s*\}\}/g, new Date().toLocaleDateString('en-IN'));
      await queueMessage(trx, {
        to_phone: r.phone, customer_id: r.customer_id, campaign_id: id,
        message_type: 'CAMPAIGN', body: message });
    }
    return { ok: true, queued: recipients.length, segment };
  }));

  /** 11.1 — today's birthdays, and the greeting run that goes with them. */
  app.get('/birthdays', guarded('view_customers', async ({ db: trx, req }) => {
    const withinDays = Math.min(Math.max(Number((req.query as any)?.within_days ?? 7), 0), 60);
    return (await sql<any>`
      SELECT customer_id, name, phone, dob, loyalty_points_balance,
             (DATE (EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' || to_char(dob, 'MM-DD'))) AS this_year_birthday,
             CASE WHEN to_char(dob, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD') THEN TRUE ELSE FALSE END AS is_today
        FROM customers
       WHERE dob IS NOT NULL
         AND (
           to_char(dob, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
           OR to_char(dob, 'MM-DD') BETWEEN to_char(CURRENT_DATE, 'MM-DD')
                                        AND to_char(CURRENT_DATE + ${withinDays}::int, 'MM-DD')
         )
       ORDER BY is_today DESC, to_char(dob, 'MM-DD') LIMIT 200
    `.execute(trx)).rows;
  }));

  app.post('/birthdays/send-greetings', guarded('manage_campaigns', async ({ session, db: trx }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!settings.enable_birthday_greetings) {
      throw badRequest('Birthday greetings are switched off in Admin Settings.');
    }
    const campaign = (await sql<any>`
      SELECT * FROM marketing_campaigns WHERE campaign_type = 'BIRTHDAY' ORDER BY name LIMIT 1
    `.execute(trx)).rows[0];

    const todays = (await sql<any>`
      SELECT customer_id, name, phone FROM customers
       WHERE dob IS NOT NULL AND phone IS NOT NULL
         AND to_char(dob, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
         -- Never greet the same person twice in one day, even if this runs twice.
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_message_log w
            WHERE w.customer_id = customers.customer_id AND w.message_type = 'BIRTHDAY'
              AND w.queued_at::date = CURRENT_DATE
         )
    `.execute(trx)).rows;

    const template = campaign?.message_template
      ?? 'Happy birthday {{name}}! Enjoy a special discount at any of our branches this week.';
    for (const c of todays) {
      await queueMessage(trx, {
        to_phone: c.phone, customer_id: c.customer_id, campaign_id: campaign?.campaign_id ?? null,
        message_type: 'BIRTHDAY',
        body: template.replace(/\{\{\s*name\s*\}\}/g, c.name) });
    }
    return { ok: true, queued: todays.length };
  }));

  // ── Message log / queue health ────────────────────────────────────────────
  //
  // Two deliberate narrowings versus the obvious implementation:
  //   * `manage_campaigns`, not `view_customers` — a cashier has no reason to read
  //     the chain's outbound message history, and this table is not branch-scoped.
  //   * an explicit column list, never `w.*` — so a column added later cannot
  //     silently start being exposed here.
  // Verification codes and reset tokens are not in this table at all; they live in
  // auth_message_outbox, which the application role cannot read.
  app.get('/messages', guarded('manage_campaigns', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT w.id, w.message_type, w.status, w.attempts, w.queued_at, w.sent_at,
             w.last_error, w.body,
             c.name AS customer_name, i.invoice_number
        FROM whatsapp_message_log w
        LEFT JOIN customers c ON c.customer_id = w.customer_id
        LEFT JOIN invoices i ON i.invoice_id = w.invoice_id
       WHERE 1=1 ${q.status ? sql`AND w.status = ${q.status}` : sql``}
         ${q.message_type ? sql`AND w.message_type = ${q.message_type}` : sql``}
       ORDER BY w.queued_at DESC LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
  }));

  app.get('/messages/stats', guarded('manage_campaigns', async ({ db: trx }) =>
    (await sql<any>`
      SELECT status, message_type, count(*) AS count
        FROM whatsapp_message_log
       WHERE queued_at >= now() - interval '30 days'
       GROUP BY status, message_type ORDER BY count DESC
    `.execute(trx)).rows));
}
