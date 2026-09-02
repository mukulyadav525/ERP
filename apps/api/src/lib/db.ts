import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import type { DB } from './db.types.js';
import { env } from './env.js';
import type { Session } from './session.js';

export type Database = DB;
export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // A pooled connection dying in the background must not take the process with it.
  console.error('[db] idle client error', err.message);
});

export const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

export async function checkDbConnection(): Promise<boolean> {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

/**
 * Runs `fn` inside a transaction whose row-level-security context is set to this
 * session. Everything the callback reads or writes is filtered by the policies in
 * db/schema.sql, so a branch user's query cannot return another branch's rows even
 * if the query itself forgets a WHERE clause. `set_config(..., true)` scopes the
 * settings to the transaction, so a pooled connection can never leak one request's
 * identity into the next.
 */
export async function withScope<T>(session: Session, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT
      set_config('erp.user_id',   ${session.user_id}, true),
      set_config('erp.role',      ${session.role},    true),
      set_config('erp.branch_id', ${session.branch_id ?? ''}, true)
    `.execute(trx);
    return fn(trx);
  });
}

/**
 * Same as withScope but for the small number of genuinely chain-wide reads an
 * OWNER_ADMIN is entitled to (cross-branch stock lookup, chain reports). Callers
 * must have already checked the `cross_branch_lookup` / `view_chain_reports`
 * permission — this only relaxes the SQL-level filter, never the role check.
 */
export async function withAdminScope<T>(session: Session, fn: (trx: Tx) => Promise<T>): Promise<T> {
  if (session.role !== 'OWNER_ADMIN') throw new Error('withAdminScope called for a non-admin session');
  return withScope({ ...session, branch_id: null }, fn);
}

/**
 * A transaction scoped for a BACKGROUND worker.
 *
 * This matters more than it looks. Row-level security is keyed on GUCs that the
 * request path sets per request; a timer that runs raw SQL on the pool has no
 * session at all, so `erp_authenticated()` is false and every policy denies —
 * the worker's queries return zero rows and it silently does nothing forever.
 * That is exactly what had happened to the message queue and the reservation
 * sweeper: no errors, no work.
 *
 * The system context is deliberately explicit and confined to this helper, so
 * "runs as the whole chain" is a decision visible at the call site rather than an
 * accident of a missing GUC.
 */
export async function withSystemScope<T>(fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT
      set_config('erp.user_id',   '', true),
      set_config('erp.role',      'OWNER_ADMIN', true),
      set_config('erp.branch_id', '', true)
    `.execute(trx);
    return fn(trx);
  });
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}

export { sql };
