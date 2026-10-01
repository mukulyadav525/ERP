import { env } from './lib/env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { checkDbConnection, closeDb, db, sql, withSystemScope } from './lib/db.js';
import { HttpError } from './lib/errors.js';
import { drainAuthOutbox, drainQueue } from './lib/whatsapp.js';

import authRoutes from './routes/auth/index.js';
import catalogRoutes from './routes/catalog/index.js';
import billingRoutes from './routes/billing/index.js';
import inventoryRoutes from './routes/inventory/index.js';
import quotationsRoutes from './routes/quotations/index.js';
import customersRoutes from './routes/customers/index.js';
import vendorsRoutes from './routes/vendors/index.js';
import expensesRoutes from './routes/expenses/index.js';
import hrRoutes from './routes/hr/index.js';
import crmRoutes from './routes/crm/index.js';
import returnsRoutes from './routes/returns/index.js';
import reportsRoutes from './routes/reports/index.js';
import adminRoutes from './routes/admin/index.js';
import searchRoutes from './routes/search/index.js';

/** Unique-constraint names → what the person at the screen should be told. */
const UNIQUE_MESSAGES: Record<string, string> = {
  products_sku_key: 'That SKU is already used by another product.',
  product_barcodes_barcode_key: 'That barcode is already assigned to another product.',
  product_units_product_id_unit_label_key: 'This product already has that unit.',
  ux_product_units_default: 'A product can have only one default sale unit.',
  ux_brands_name: 'A brand with that name already exists.',
  ux_categories_name: 'A category with that name already exists here.',
  units_pkey: 'A unit with that code already exists.',
  customers_phone_key: 'A customer with this phone number already exists.',
  users_phone_key: 'A user with this phone number already exists.',
  users_email_key: 'A user with this email already exists.',
  branches_code_key: 'Another branch already uses that branch code.',
  ux_grn_vendor_invoice: 'This supplier bill number has already been entered for this vendor at this branch.',
  ux_till_sessions_open_counter: 'That counter already has an open till. Close it before opening a new one.',
  // Idempotency keys: a second submit of the same form lands here when the first
  // is still committing. The first one is the record; nothing was duplicated.
  invoices_client_txn_id_key: 'This bill was already saved — it was not recorded twice. Refresh to see it.',
  customer_payments_client_txn_id_key: 'This payment was already recorded — it was not taken twice.',
  vendor_payments_client_txn_id_key: 'This payment was already recorded — it was not paid twice.',
  grn_client_txn_id_key: 'This goods receipt was already saved — the stock was not received twice.',
  hsn_tax_rates_hsn_code_effective_from_key: 'A rate for that HSN already starts on that date.',
};

/** Check-constraint names → plain explanations. */
const CHECK_MESSAGES: Record<string, string> = {
  chk_product_prices_values: 'The MRP cannot be lower than the selling price, and neither can be negative.',
  chk_product_unit_multiplier: 'A unit conversion must be greater than zero.',
  chk_unit_factor: 'A measured unit needs its size; a pack unit (box, set, reel) must not have one.',
  chk_unit_code: 'A unit code may only use capital letters, digits and underscores (max 20).',
  chk_branch_code: 'A branch code is 2–6 capital letters or digits, e.g. AND or PUN1.',
  chk_transfer_branches: 'The sending and receiving branches must be different.',
  chk_users_branch_scope: 'Every staff account other than the owner must be assigned to a branch.',
  chk_stock_adjustment_reason: 'Choose a reason for the stock adjustment.',
};

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Credentials must never reach the log, even at debug level.
    redact: ['req.headers.authorization', 'req.headers.cookie',
             'req.body.password', 'req.body.pin', 'req.body.otp',
             'req.body.new_password', 'req.body.current_password', 'req.body.id_token'],
  },
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
});

// A POST with a JSON content type and no body (an action button with nothing to
// send) is an empty object, not an error. Anything that is not valid JSON is a
// 400 with a plain message.
// Fastify's default parser is kept for everything else, because it is the one
// that refuses __proto__ / constructor.prototype keys (prototype poisoning).
const secureJsonParser = app.getDefaultJsonParser('error', 'error');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return done(null, {});
  // Callback-style: it reports through `done`; its return value carries nothing.
  void secureJsonParser(req, text, done);
});

await app.register(helmet, {
  // The API serves JSON and PDFs, never HTML, so the strictest CSP is free here.
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// An explicit origin allowlist, not `origin: true` — reflecting any origin back
// with credentials enabled is what makes a CSRF-style cross-site read possible.
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);          // curl / server-to-server
    cb(null, env.corsOrigins.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // X-Branch-Id carries the branch picked in the top bar; the server verifies it.
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Branch-Id'],
  maxAge: 86400,
});

await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: '1 minute',
  keyGenerator: (req) => `${req.ip}:${(req.headers['authorization'] || '').slice(-16)}`,
  // No errorResponseBuilder here on purpose: returning a bare object from it made
  // the plugin throw something with no statusCode, which the error handler below
  // could not recognise and turned every throttle into a confusing 500. Letting
  // the plugin raise its own typed error keeps the 429 a 429; the wording is set
  // in one place, in that handler.
});

// ── Uniform error handling ──────────────────────────────────────────────────
// Everything a route throws lands here. Known errors keep their message; anything
// else becomes a generic 500 so a driver error or SQL fragment never reaches a
// client (and never hints at the schema to someone probing it).
app.setErrorHandler((thrown, req, reply) => {
  // Fastify 5 types a thrown value as unknown; everything below inspects it defensively.
  const err = (thrown instanceof Error ? thrown : new Error(String(thrown))) as Error & Record<string, any>;
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send({ error: err.message, details: err.details });
  }
  // @fastify/rate-limit raises FST_ERR_RATE_LIMIT. Match on both, because the
  // shape has differed between versions and a throttle showing up as a 500 is
  // both alarming and unactionable.
  if ((err as any).statusCode === 429 || (err as any).code === 'FST_ERR_RATE_LIMIT'
      || /rate limit/i.test(String((err as any).message ?? ''))) {
    return reply.code(429).send({
      error: 'Too many attempts in a short time. Please wait a moment and try again.',
    });
  }
  if ((err as any).validation) {
    return reply.code(400).send({ error: 'Invalid request body.' });
  }
  // Fastify's own client errors (malformed JSON, unsupported media type, body too
  // large) carry a 4xx status. Reporting them as a 500 blamed the server for a bad
  // request and hid the actual problem from whoever sent it.
  const status = Number((err as any).statusCode);
  if (status >= 400 && status < 500) {
    const message = status === 413 ? 'That request is too large.'
      : status === 415 ? 'Send the request as JSON.'
      : 'The request could not be read. Please try again.';
    return reply.code(status).send({ error: message });
  }
  const pgCode = (err as any).code;
  const constraint = String((err as any).constraint ?? '');
  if (pgCode === '23505') {
    return reply.code(409).send({ error: UNIQUE_MESSAGES[constraint] ?? 'That record already exists.' });
  }
  if (pgCode === '23503') return reply.code(400).send({ error: 'One of the selected records no longer exists. Refresh and try again.' });
  if (pgCode === '23514') {
    return reply.code(400).send({ error: CHECK_MESSAGES[constraint] ?? 'That change is not allowed by a data rule.' });
  }
  if (pgCode === '42501') return reply.code(403).send({ error: 'Your role is not allowed to make that change.' });
  if (pgCode === '23P01') return reply.code(409).send({ error: 'That overlaps an existing record for the same dates.' });
  if (pgCode === '23502') return reply.code(400).send({ error: 'A required value is missing.' });
  if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22008') {
    return reply.code(400).send({ error: 'One of the values entered is not in a valid format.' });
  }
  if (pgCode === '22003') return reply.code(400).send({ error: 'A number entered is too large.' });
  // Raised by the finalised-invoice guard in the schema. Its message is written
  // for a person ("Invoice X is FINAL and cannot be altered..."), so it is kept.
  if (pgCode === '23001') return reply.code(409).send({ error: String(err.message) });
  if (typeof err.message === 'string' && err.message.includes('Negative stock blocked')) {
    return reply.code(409).send({
      error: 'Not enough stock at this branch for that quantity. Reduce the quantity, receive stock first, or ask a manager to approve it.',
    });
  }

  req.log.error({ err }, 'unhandled error');
  return reply.code(500).send({ error: 'Something went wrong on our side. Please try again.' });
});

app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Endpoint not found.' }));

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', async (_req, reply) => {
  try {
    const dbOk = await checkDbConnection();
    // Deliberately NOT "SELECT count(*) FROM branches": the API connects as a role
    // that row-level security applies to, and a health check has no session, so
    // that query correctly returns zero and would look like an empty database.
    // Counting tables in the catalog proves the schema is applied without needing
    // to defeat RLS to do it.
    const tables = await sql<{ count: string }>`
      SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
    `.execute(db);
    return reply.send({
      status: dbOk ? 'ok' : 'db_unreachable',
      schema_reachable: dbOk,
      table_count: Number(tables.rows[0]?.count ?? 0),
      version: '1.0.0',
    });
  } catch (err) {
    return reply.code(503).send({ status: 'db_unreachable', schema_reachable: false });
  }
});

await app.register(authRoutes,       { prefix: '/api/auth' });
await app.register(catalogRoutes,    { prefix: '/api/catalog' });
await app.register(billingRoutes,    { prefix: '/api/billing' });
await app.register(inventoryRoutes,  { prefix: '/api/inventory' });
await app.register(quotationsRoutes, { prefix: '/api/quotations' });
await app.register(customersRoutes,  { prefix: '/api/customers' });
await app.register(vendorsRoutes,    { prefix: '/api/vendors' });
await app.register(expensesRoutes,   { prefix: '/api/expenses' });
await app.register(hrRoutes,         { prefix: '/api/hr' });
await app.register(crmRoutes,        { prefix: '/api/crm' });
await app.register(returnsRoutes,    { prefix: '/api/returns' });
await app.register(reportsRoutes,    { prefix: '/api/reports' });
await app.register(adminRoutes,      { prefix: '/api/admin' });
await app.register(searchRoutes,     { prefix: '/api/search' });

// ── Background workers ──────────────────────────────────────────────────────
// Deliberately simple in-process timers. The requirements call for a job queue
// (BullMQ/Redis) at scale; this keeps the same seam — everything enqueues to the
// database and a worker drains it — so swapping the runner later touches one file.
const workers: NodeJS.Timeout[] = [];
if (process.env.DISABLE_WORKERS !== 'true') {
  workers.push(setInterval(() => {
    drainQueue().catch((err) => app.log.error({ err }, 'whatsapp queue drain failed'));
    // Verification codes and reset links are time-critical, so the sealed auth
    // outbox drains on the same tick rather than waiting for a slower schedule.
    drainAuthOutbox().catch((err) => app.log.error({ err }, 'auth outbox drain failed'));
  }, 30_000));

  // Expired quotation reservations release themselves back to sellable stock (5.1).
  // withSystemScope for the same reason as the message queue: quotations and
  // branch_stock are both behind RLS, and a timer has no session, so without a
  // scope this UPDATE matches nothing and holds never expire.
  workers.push(setInterval(() => {
    withSystemScope(async (trx) => {
      // An estimate lapses when its hold runs out OR when its printed validity date
      // has passed — the customer was told the price held until then, not after.
      // One with a bill already being prepared from it is left alone.
      const released = await sql<{ quotation_id: string }>`
        WITH target AS (
          -- Read BEFORE the update: UPDATE ... RETURNING reports the new values,
          -- and only an estimate that was actually holding stock may give any back.
          SELECT q.quotation_id, q.branch_id, q.stock_reserved AS was_reserved
            FROM quotations q
           WHERE q.status IN ('DRAFT', 'APPROVED')
             AND ((q.stock_reserved AND q.reservation_hold_until < now())
                  OR (q.valid_until IS NOT NULL AND q.valid_until < CURRENT_DATE))
             AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.source_quotation_id = q.quotation_id AND i.status = 'DRAFT')
           FOR UPDATE OF q SKIP LOCKED
        ), lapsed AS (
          UPDATE quotations q SET stock_reserved = FALSE, reservation_hold_until = NULL,
                 status = 'EXPIRED', updated_at = now()
            FROM target t WHERE q.quotation_id = t.quotation_id
          RETURNING q.quotation_id
        ), freed AS (
          UPDATE branch_stock bs
             SET reserved_qty = GREATEST(bs.reserved_qty - ql.qty, 0), updated_at = now()
            FROM (SELECT t.branch_id, ql.product_id, SUM(ql.qty_base_unit) AS qty
                    FROM quotation_lines ql JOIN target t ON t.quotation_id = ql.quotation_id AND t.was_reserved
                   GROUP BY t.branch_id, ql.product_id) ql
           WHERE bs.product_id = ql.product_id AND bs.branch_id = ql.branch_id
          RETURNING bs.product_id
        )
        SELECT quotation_id FROM lapsed
      `.execute(trx);
      if (released.rows.length) {
        app.log.info({ count: released.rows.length }, 'released lapsed quotation reservations');
      }
    }).catch((err) => app.log.error({ err }, 'reservation release failed'));
  }, 300_000));

  // Anything a dead worker left claimed goes back on the queue.
  workers.push(setInterval(() => {
    sql`SELECT auth_outbox_requeue_stale(5)`.execute(db)
      .catch((err) => app.log.error({ err }, 'outbox requeue failed'));
  }, 300_000));
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  workers.forEach(clearInterval);
  await app.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.port, host: env.host });
app.log.info(`ERP API listening on :${env.port}`);
