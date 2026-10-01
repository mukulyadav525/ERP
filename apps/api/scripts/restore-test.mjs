#!/usr/bin/env node
// ============================================================================
// npm run backup:restore-test — proves the latest backup can actually be restored.
//
//   1. Takes the newest COMPLETED backup (or a dump file given as an argument)
//   2. Checks the file is there and its SHA-256 matches what was recorded
//   3. Restores it into a NEW scratch database
//   4. Checks the restored data: every table present, the key tables readable,
//      stock on hand equal to the stock ledger, customer balances equal to their
//      ledgers, invoice numbers unique
//   5. Drops the scratch database
//   6. Records the result on the backup (restore_tested_at + what was checked)
//
// The live database is never touched except to record the result.
//
// Environment (shell, or the project's .env):
//   MIGRATION_DATABASE_URL  owner connection to the live database
//   RESTORE_ADMIN_URL       a connection allowed to CREATE/DROP DATABASE
//                           (default: MIGRATION_DATABASE_URL with database "postgres")
//   PG_BIN                  directory of pg_restore if not on PATH
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
if (existsSync(join(repoRoot, '.env'))) {
  for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const liveUrl = process.env.MIGRATION_DATABASE_URL;
const bin = (name) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);
const withDb = (u, db) => { const x = new URL(u); x.pathname = `/${db}`; return x.toString(); };

function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}
async function query(url, text, params = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(text, params)).rows; } finally { await c.end(); }
}

async function main() {
  if (!liveUrl) throw new Error('MIGRATION_DATABASE_URL is not set.');
  const adminUrl = process.env.RESTORE_ADMIN_URL || withDb(liveUrl, 'postgres');

  // 1–2. Which backup, and is it intact?
  let backup;
  if (process.argv[2]) {
    backup = { storage_ref: resolve(process.argv[2]), checksum_sha256: null, table_count: null, backup_id: null };
    const rows = await query(liveUrl, 'SELECT * FROM backups WHERE storage_ref = $1 ORDER BY taken_at DESC LIMIT 1', [backup.storage_ref]);
    if (rows[0]) backup = rows[0];
  } else {
    backup = (await query(liveUrl, "SELECT * FROM backups WHERE status = 'COMPLETED' ORDER BY taken_at DESC LIMIT 1"))[0];
    if (!backup) throw new Error('No completed backup is recorded. Run `npm run backup` first.');
  }
  const file = backup.storage_ref;
  console.log(`Restore test of ${file}`);
  if (!existsSync(file)) throw new Error(`The dump file is missing: ${file}`);
  const actual = await sha256(file);
  if (backup.checksum_sha256 && actual !== backup.checksum_sha256) {
    throw new Error(`Checksum mismatch — the file has changed since it was backed up (recorded ${backup.checksum_sha256.slice(0, 12)}…, now ${actual.slice(0, 12)}…).`);
  }
  console.log(`  ✓ checksum ${actual.slice(0, 16)}…${backup.checksum_sha256 ? ' matches the record' : ''}`);

  // 3. Restore into a scratch database.
  const scratch = `bhawani_restore_test_${Date.now().toString(36)}`;
  const owner = decodeURIComponent(new URL(liveUrl).username);
  try {
    // Owned by the live database's owner role, so the restore runs exactly as it would for real.
    await query(adminUrl, `CREATE DATABASE ${scratch} OWNER "${owner.replace(/"/g, '""')}"`);
  } catch (err) {
    throw new Error(`Could not create a scratch database (${err.message}). Set RESTORE_ADMIN_URL to a connection with CREATEDB rights `
      + `that can grant ownership to "${owner}" (for example the postgres superuser).`);
  }
  const notes = [];
  let ok = false;
  try {
    const scratchUrl = withDb(liveUrl, scratch);
    const restore = spawnSync(bin('pg_restore'), ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${scratchUrl}`, file],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (restore.status !== 0) throw new Error(`pg_restore failed: ${(restore.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
    console.log(`  ✓ restored into ${scratch}`);

    // 4. Check what came back.
    const [{ n: tables }] = await query(scratchUrl, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    notes.push(`${tables} tables restored`);
    if (backup.table_count && tables < Number(backup.table_count)) throw new Error(`Only ${tables} of ${backup.table_count} tables came back.`);
    const counts = await query(scratchUrl, `
      SELECT (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM products)::int AS products,
             (SELECT count(*) FROM customers)::int AS customers, (SELECT count(*) FROM stock_ledger)::int AS movements,
             (SELECT count(*) FROM users)::int AS users`);
    notes.push(Object.entries(counts[0]).map(([k, v]) => `${v} ${k}`).join(', '));
    const [{ n: stockDiff }] = await query(scratchUrl, `
      SELECT count(*)::int AS n FROM branch_stock bs
       WHERE bs.base_unit_qty <> COALESCE((SELECT sum(base_unit_qty_change) FROM stock_ledger sl
                                            WHERE sl.branch_id = bs.branch_id AND sl.product_id = bs.product_id
                                              AND sl.movement_type NOT IN ('RESERVATION', 'RESERVATION_RELEASE')), 0)`);
    const [{ n: creditDiff }] = await query(scratchUrl, `
      SELECT count(*)::int AS n FROM (
        SELECT customer_id, sum(amount) AS total,
               (array_agg(balance_after ORDER BY created_at DESC, entry_id DESC))[1] AS latest
          FROM customer_credit_ledger GROUP BY customer_id) x
       WHERE abs(total - latest) > 0.005`);
    const [{ n: dupInvoices }] = await query(scratchUrl, `
      SELECT count(*)::int AS n FROM (SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL
                                       GROUP BY invoice_number HAVING count(*) > 1) d`);
    notes.push(`stock vs ledger mismatches: ${stockDiff}`, `customer balance mismatches: ${creditDiff}`, `duplicate invoice numbers: ${dupInvoices}`);
    for (const n of notes) console.log(`  · ${n}`);
    if (stockDiff || creditDiff || dupInvoices) throw new Error('The restored data failed an integrity check (see above).');
    ok = true;
  } finally {
    // 5. Never leave the scratch database behind.
    await query(adminUrl, `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch((e) => console.error(`  ! could not drop ${scratch}: ${e.message}`));
  }

  // 6. Record the result on the backup.
  if (ok && backup.backup_id) {
    await query(liveUrl, 'UPDATE backups SET restore_tested_at = now(), restore_test_notes = $2 WHERE backup_id = $1',
      [backup.backup_id, notes.join('; ')]);
    console.log(`✓ Restore test passed and recorded on backup ${backup.backup_id}.`);
  } else if (ok) {
    console.log('✓ Restore test passed. (This file is not in the backups table, so nothing was recorded.)');
  }
}

main().catch((err) => { console.error(`\n✗ ${err?.message ?? err}`); process.exitCode = 1; });
