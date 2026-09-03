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
  allowedHeaders: ['Authorization', 'Content-Type'],
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
app.setErrorHandler((err, req, reply) => {
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
  const pgCode = (err as any).code;
  if (pgCode === '23505') return reply.code(409).send({ error: 'That record already exists.' });
  if (pgCode === '23503') return reply.code(400).send({ error: 'Referenced record does not exist.' });
  if (pgCode === '23514') return reply.code(400).send({ error: 'That change is not allowed by a data rule.' });
  if (typeof err.message === 'string' && err.message.includes('Negative stock blocked')) {
    return reply.code(409).send({
      error: 'Not enough stock at this branch. Enable "Allow negative stock" in Admin Settings, or adjust the quantity.',
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
      const released = await sql<{ quotation_id: string }>`
        WITH lapsed AS (
          UPDATE quotations SET stock_reserved = FALSE, status = 'EXPIRED'
           WHERE stock_reserved AND reservation_hold_until < now() AND status = 'APPROVED'
          RETURNING quotation_id, branch_id
        ), freed AS (
          UPDATE branch_stock bs
             SET reserved_qty = GREATEST(bs.reserved_qty - ql.qty_base_unit, 0), updated_at = now()
            FROM quotation_lines ql JOIN lapsed l ON l.quotation_id = ql.quotation_id
           WHERE bs.product_id = ql.product_id AND bs.branch_id = l.branch_id
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
