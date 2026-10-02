// Requirement #4 / Sections 6.2, 11.1, 14 — WhatsApp delivery.
//
// Nothing is sent inline from a request. Messages are queued into
// whatsapp_message_log in the same transaction as the thing they describe, and a
// background worker drains the queue. That is what makes 3.5 true: billing keeps
// working during an outage because sending was never on the critical path.
import { sql } from 'kysely';
import type { Tx } from './db.js';
import { db, withSystemScope } from './db.js';
import { env } from './env.js';
import { mailEnabled, sendEmail } from './mailer.js';

// Note the absence of 'OTP' here. Verification codes and reset tokens do NOT go
// through this log — it is readable by ordinary staff, so a secret in a message
// body would be a secret handed to every user. They use queueAuthMessage below,
// which writes to a table the application role cannot read at all.
export type MessageType =
  | 'INVOICE_PDF' | 'DUE_REMINDER' | 'BIRTHDAY' | 'CAMPAIGN'
  | 'ADMIN_DIGEST' | 'QUOTATION' | 'CREDIT_NOTE';

export async function queueMessage(trx: Tx, msg: {
  to_phone: string;
  message_type: MessageType;
  body: string;
  customer_id?: string | null;
  invoice_id?: string | null;
  campaign_id?: string | null;
}): Promise<void> {
  if (!msg.to_phone) return;
  await sql`
    INSERT INTO whatsapp_message_log (customer_id, invoice_id, campaign_id, to_phone, message_type, body, status)
    VALUES (${msg.customer_id ?? null}, ${msg.invoice_id ?? null}, ${msg.campaign_id ?? null},
            ${msg.to_phone}, ${msg.message_type}, ${msg.body}, 'QUEUED')
  `.execute(trx);
}

/**
 * Queues a message that CONTAINS A SECRET (an OTP or a reset code). It goes to
 * auth_message_outbox via a SECURITY DEFINER function; RLS on that table has no
 * policy for the app role, so nothing else in the system — no endpoint, no
 * report, no export — can read the body back out.
 */
export async function queueAuthMessage(msg: {
  channel?: 'WHATSAPP' | 'EMAIL';
  to_phone?: string | null;
  to_email?: string | null;
  purpose: 'OTP' | 'PASSWORD_RESET' | 'PIN_RESET';
  /** For WhatsApp: the whole message. For email: the plain-text body. */
  body: string;
  /** Email only: subject and HTML, kept with the message so the drain needs nothing else. */
  subject?: string;
  html?: string;
}): Promise<void> {
  const channel = msg.channel ?? 'WHATSAPP';
  if (channel === 'WHATSAPP' && !msg.to_phone) return;
  if (channel === 'EMAIL' && !msg.to_email) return;
  // An email is stored as a small JSON envelope so subject and HTML survive the queue.
  const body = channel === 'EMAIL' ? JSON.stringify({ subject: msg.subject ?? 'Your code', text: msg.body, html: msg.html }) : msg.body;
  await sql`SELECT auth_queue_message(${msg.to_phone ?? null}, ${msg.purpose}, ${body}, ${msg.to_email ?? null}, ${channel})`
    .execute(db);
  kickAuthOutbox();
}

// Codes are wanted NOW, not at the next 30-second timer tick: a queued code
// triggers a drain right after the request that queued it has committed.
let kickTimer: NodeJS.Timeout | null = null;
export function kickAuthOutbox(): void {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    drainAuthOutbox().catch(() => { /* the timer retries; bodies are never logged */ });
  }, 300);
}

async function deliver(toPhone: string, body: string): Promise<void> {
  if (!env.whatsapp.enabled) {
    // Without credentials configured there is nothing to call. Throwing here
    // instead would retry forever and fill the log with noise.
    return;
  }
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${env.whatsapp.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body } }),
    },
  );
  if (!res.ok) throw new Error(`WhatsApp API responded ${res.status}`);
}

/** Drains the auth outbox. Bodies are read through the definer function and are
 *  never logged, even on failure. */
export async function drainAuthOutbox(batchSize = 25): Promise<number> {
  const pending = await sql<{ id: string; channel: string; to_phone: string | null; to_email: string | null; body: string }>`
    SELECT * FROM auth_outbox_take(${batchSize})
  `.execute(db);

  for (const msg of pending.rows) {
    // No channel set up: closed as NOT_CONFIGURED. It used to be marked SENT,
    // and the person waited for a code that was never going to arrive.
    const configured = msg.channel === 'EMAIL' ? mailEnabled() : env.whatsapp.enabled;
    if (!configured) {
      await sql`SELECT auth_outbox_result(${msg.id}, FALSE, ${`${msg.channel} is not configured; nothing was sent.`}, TRUE)`.execute(db);
      continue;
    }
    try {
      if (msg.channel === 'EMAIL') {
        const mail = JSON.parse(msg.body) as { subject: string; text: string; html?: string };
        await sendEmail({ to: msg.to_email!, subject: mail.subject, text: mail.text, html: mail.html });
      } else {
        await deliver(msg.to_phone!, msg.body);
      }
      await sql`SELECT auth_outbox_result(${msg.id}, TRUE, NULL)`.execute(db);
    } catch (err) {
      // Deliberately generic: the message body is a credential.
      const message = err instanceof Error ? err.message : 'delivery failed';
      await sql`SELECT auth_outbox_result(${msg.id}, FALSE, ${message})`.execute(db);
    }
  }
  return pending.rows.length;
}

/**
 * One drain pass over the customer message queue.
 *
 * Runs inside withSystemScope: whatsapp_message_log is behind RLS, and a timer
 * has no request session, so without an explicit scope every SELECT here returns
 * nothing and the queue never moves.
 *
 * The batch is CLAIMED, not merely read, so two API instances running the same
 * timer cannot both send the same invoice to the same customer.
 */
export async function drainQueue(batchSize = 25): Promise<number> {
  const claimed = await withSystemScope(async (trx) => {
    const rows = await sql<{ id: string; to_phone: string; body: string }>`
      UPDATE whatsapp_message_log m SET status = 'SENDING'
       WHERE m.id IN (
         SELECT c.id FROM whatsapp_message_log c
          WHERE c.status = 'QUEUED' AND c.attempts < 5
          ORDER BY c.queued_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
       )
      RETURNING m.id, m.to_phone, m.body
    `.execute(trx);
    return rows.rows;
  });

  for (const msg of claimed) {
    let ok = false;
    let error: string | null = null;
    if (!env.whatsapp.enabled) {
      // With no credentials configured there is nothing to call. The message is
      // closed as NOT_CONFIGURED — never SENT — so no screen or report can claim a
      // delivery that did not happen, and it is not retried forever.
      await withSystemScope(async (trx) => {
        await sql`
          UPDATE whatsapp_message_log SET status = 'NOT_CONFIGURED', attempts = attempts + 1,
                 last_error = 'WhatsApp Business API is not configured; nothing was sent.'
           WHERE id = ${msg.id}
        `.execute(trx);
      });
      continue;
    }
    try {
      await deliver(msg.to_phone, msg.body ?? '');
      ok = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    await withSystemScope(async (trx) => {
      await sql`
        UPDATE whatsapp_message_log
           SET attempts = attempts + 1, last_error = ${error},
               status = CASE WHEN ${ok} THEN 'SENT'
                             WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'QUEUED' END,
               sent_at = CASE WHEN ${ok} THEN now() ELSE sent_at END
         WHERE id = ${msg.id}
      `.execute(trx);
    });
  }
  return claimed.length;
}
