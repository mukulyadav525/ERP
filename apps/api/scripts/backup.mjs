#!/usr/bin/env node
// ============================================================================
// npm run backup — takes a verified backup of the database.
//
//   1. pg_dump in custom format to BACKUP_DIR (default ./backups)
//   2. VERIFY the file: non-empty, readable by pg_restore --list, tables counted
//   3. SHA-256 of the file, written beside it as <file>.sha256
//   4. Record it in the `backups` table — only now, after it has been verified
//   5. Keep the newest BACKUP_KEEP dump files (default 14); older FILES are
//      removed, the history rows stay
//
// A dump that fails is recorded as FAILED, so the Admin screen shows the failure
// rather than an old success. Nothing is recorded as a backup unless it was
// actually taken and read back.
//
// Environment (read from the shell, or from the project's .env):
//   MIGRATION_DATABASE_URL  connection as the database OWNER (reads every table,
//                           and may write the backups table; the app role cannot)
//   BACKUP_DIR              where dumps go           (default: <repo>/backups)
//   BACKUP_KEEP             how many dump files to keep (default: 14)
//   PG_BIN                  directory of pg_dump/pg_restore if not on PATH
//
// Schedule it daily (cron, systemd timer, Task Scheduler) — see docs/OPERATIONS.md.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
loadDotEnv(join(repoRoot, '.env'));

const url = process.env.MIGRATION_DATABASE_URL;
const backupDir = resolve(process.env.BACKUP_DIR || join(repoRoot, 'backups'));
const keep = Math.max(Number(process.env.BACKUP_KEEP) || 14, 1);
const bin = (name) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  // A minimal KEY=VALUE reader: values already in the environment win.
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function fail(message) { console.error(`\n✗ ${message}`); process.exitCode = 1; }
function sha256(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

async function record(row) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO backups (storage_ref, status, size_bytes, checksum_sha256, table_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING backup_id, taken_at`,
      [row.storage_ref, row.status, row.size_bytes ?? null, row.checksum ?? null, row.table_count ?? null]);
    return r.rows[0];
  } finally { await client.end(); }
}

async function main() {
  if (!url) { fail('MIGRATION_DATABASE_URL is not set. It must connect as the database owner.'); return; }
  const version = spawnSync(bin('pg_dump'), ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) { fail('pg_dump was not found. Install the PostgreSQL client tools or set PG_BIN.'); return; }
  mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = join(backupDir, `bhawani_one-${stamp}.dump`);
  console.log(`Backing up to ${file}`);
  console.log(`  ${version.stdout.trim()}`);

  const dump = spawnSync(bin('pg_dump'), ['--format=custom', '--compress=6', '--no-password', `--file=${file}`, url],
    { encoding: 'utf8' });
  if (dump.status !== 0) {
    await record({ storage_ref: file, status: 'FAILED' }).catch(() => {});
    fail(`pg_dump failed: ${(dump.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
    return;
  }

  // Verify by reading the archive back.
  const size = existsSync(file) ? statSync(file).size : 0;
  const list = spawnSync(bin('pg_restore'), ['--list', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tables = list.status === 0 ? (list.stdout.match(/^\d+;.*\bTABLE public \S+ \S+$/gm) ?? []).length : 0;
  if (size === 0 || list.status !== 0 || tables === 0) {
    await record({ storage_ref: file, status: 'FAILED', size_bytes: size }).catch(() => {});
    fail(`The dump could not be verified (size ${size} bytes, ${tables} tables listed). It was recorded as FAILED.`);
    return;
  }
  const checksum = await sha256(file);
  writeFileSync(`${file}.sha256`, `${checksum}  ${file.split('/').pop()}\n`);

  const row = await record({ storage_ref: file, status: 'COMPLETED', size_bytes: size, checksum, table_count: tables });
  console.log(`✓ Verified: ${(size / 1048576).toFixed(2)} MB, ${tables} tables, sha256 ${checksum.slice(0, 16)}…`);
  console.log(`✓ Recorded as backup ${row.backup_id} at ${new Date(row.taken_at).toISOString()}`);

  // Retention: dump files only — the history rows stay as the audit of what was taken.
  const dumps = readdirSync(backupDir).filter((f) => /^bhawani_one-\d{8}-\d{6}\.dump$/.test(f)).sort().reverse();
  for (const old of dumps.slice(keep)) {
    unlinkSync(join(backupDir, old));
    if (existsSync(join(backupDir, `${old}.sha256`))) unlinkSync(join(backupDir, `${old}.sha256`));
    console.log(`  removed old dump ${old}`);
  }
  console.log('\nCopy the backups folder off this machine as well (another disk, or cloud storage): a backup on the same disk does not survive the disk.');
}

main().catch((err) => fail(err?.message ?? String(err)));
