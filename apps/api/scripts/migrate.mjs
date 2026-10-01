#!/usr/bin/env node
// ============================================================================
// npm run db:upgrade — brings an EXISTING database up to date.
//
// db/schema.sql builds a fresh database with everything. A database that already
// holds a shop's data is upgraded instead with the files in db/migrations, in
// name order, each exactly once. Applied versions are recorded in
// schema_migrations; each file runs in its own transaction, so a failure leaves
// that migration (and everything after it) unapplied, never half-applied.
//
//   npm run db:upgrade               apply what is missing
//   npm run db:upgrade -- --dry-run  list what would be applied
//
// Take a backup first (npm run backup). Environment: MIGRATION_DATABASE_URL.
// ============================================================================
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.error('MIGRATION_DATABASE_URL is not set.'); process.exit(1); }
const dryRun = process.argv.includes('--dry-run');
const dir = join(root, 'db', 'migrations');
const files = readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // Names are schema-qualified and search_path is set INSIDE each transaction:
  // a connection pooler (Supabase's) starts sessions with an empty search_path
  // and may hand each transaction a different server session, so a session-level
  // SET would not survive to the next statement.
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  // Readable by the app, written only here (default privileges would grant more).
  await client.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
      REVOKE INSERT, UPDATE, DELETE ON public.schema_migrations FROM erp_app;
    END IF; END $$`);
  const applied = new Set((await client.query('SELECT version FROM public.schema_migrations')).rows.map((r) => r.version));
  const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, '')));
  if (!pending.length) { console.log('✓ Database is up to date.'); process.exit(0); }
  console.log(`${pending.length} migration(s) to apply:\n${pending.map((f) => `  · ${f}`).join('\n')}`);
  if (dryRun) process.exit(0);
  for (const f of pending) {
    const version = f.replace(/\.sql$/, '');
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL search_path = public, extensions, pg_temp');
      await client.query(readFileSync(join(dir, f), 'utf8'));
      await client.query('INSERT INTO public.schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      console.log(`✓ ${version}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ ${version} failed and was rolled back: ${err.message}`);
      process.exit(1);
    }
  }
  console.log('✓ Database is up to date.');
} finally {
  await client.end();
}
