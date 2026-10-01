#!/usr/bin/env node
// ============================================================================
// npm run create-owner — creates the first Owner account on a new installation.
//
// A production database is built from db/schema.sql alone (no demo seed), so it
// has no users. This creates the one Owner who then sets up branches, staff,
// the catalog and the business profile from the Admin screens.
//
//   npm run create-owner -- --name "Rohan Mehta" --email owner@shop.in --phone 9876543210
//
// The password is asked for on the terminal (never passed on the command line,
// where it would land in shell history), or read from OWNER_PASSWORD for an
// unattended install. It is hashed inside the database with bcrypt (pgcrypto),
// exactly like every other password.
//
// Refuses to run if an active Owner already exists.
// Environment: MIGRATION_DATABASE_URL (the database owner connection).
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(resolve(here, '../../..'), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** Reads a line without echoing it (falls back to a visible prompt where the terminal cannot hide input). */
function askHidden(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => { if (s.includes(question)) write?.(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); res(answer); });
  });
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set.');
  const name = arg('name')?.trim();
  const email = arg('email')?.trim().toLowerCase();
  const phone = arg('phone')?.replace(/\s+/g, '');
  if (!name || !email || !phone) {
    throw new Error('Usage: npm run create-owner -- --name "Full Name" --email you@example.com --phone 9876543210');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email address does not look valid.');
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Enter a 10-digit mobile number.');

  let password = process.env.OWNER_PASSWORD;
  if (!password) {
    password = await askHidden('Password for the Owner account (at least 10 characters): ');
    const again = await askHidden('Type it again: ');
    if (password !== again) throw new Error('The two passwords did not match.');
  }
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Use at least 10 characters, with letters and digits.');
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT full_name FROM users WHERE role = 'OWNER_ADMIN' AND is_active LIMIT 1");
    if (existing.rows[0]) throw new Error(`An Owner already exists (${existing.rows[0].full_name}). Sign in as them and add users from Admin → Users.`);
    const clash = await client.query('SELECT full_name FROM users WHERE email = $1 OR phone = $2', [email, phone]);
    if (clash.rows[0]) throw new Error(`That email or phone already belongs to ${clash.rows[0].full_name}.`);
    const row = (await client.query(`
      INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, language_pref)
      VALUES (NULL, 'OWNER_ADMIN', $1, $2, $3, crypt($4, gen_salt('bf', 12)), 'en')
      RETURNING user_id`, [name, phone, email, password])).rows[0];
    await client.query(`
      INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
      VALUES ($1, 'ROLE_CHANGE', 'users', $1, $2::jsonb)`,
      [row.user_id, JSON.stringify({ created_by: 'create-owner script', role: 'OWNER_ADMIN', email, phone })]);
    await client.query('COMMIT');
    console.log(`✓ Owner account created for ${name} (${email}).`);
    console.log('  Sign in with that email and password, then: Admin → Branches (add your shops),');
    console.log('  Admin → Settings → Business profile (name, GSTIN, address on bills), Admin → Users (staff).');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { await client.end(); }
}

main().catch((err) => { console.error(`✗ ${err?.message ?? err}`); process.exitCode = 1; });
