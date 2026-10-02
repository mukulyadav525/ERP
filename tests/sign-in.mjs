// ============================================================================
// Sign-in options, end to end: what the server offers, codes by email, reset by
// email link, two-step sign-in (authenticator + recovery codes), devices, history,
// and the Owner's controls. Email is captured by a fake mail server started here.
//
// The API must run with:
//   BREVO_API_KEY=test MAIL_FROM="Test Shop <shop@example.com>" MAIL_API_URL=http://127.0.0.1:4199
//   node tests/sign-in.mjs     (seeded demo database)
// ============================================================================
import http from 'node:http';
import { createHmac } from 'node:crypto';
import pg from '../node_modules/pg/lib/index.js';

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const DB = process.env.MIGRATION_DATABASE_URL ?? 'postgres://erp:erp_dev_password@127.0.0.1:5432/erp';
const MAIL_PORT = 4199;

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ${C.g}✓${C.x} ${name}${detail !== '' ? `  ${C.d}${String(detail).slice(0, 110)}${C.x}` : ''}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  ${C.r}✗${C.x} ${name}  ${C.d}${String(detail).slice(0, 220)}${C.x}`); }
}
const section = (t) => console.log(`\n${C.b}${t}${C.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake mail server (speaks the Brevo API) ──────────────────────────────────
const inbox = [];
const mailServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const j = JSON.parse(body);
      inbox.push({ to: j.to?.[0]?.email, subject: j.subject, text: j.textContent, html: j.htmlContent, key: req.headers['api-key'], path: req.url });
    } catch { /* ignore */ }
    res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"messageId":"x"}');
  });
});
await new Promise((r) => mailServer.listen(MAIL_PORT, '127.0.0.1', r));
async function waitForMail(to, sinceCount, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = inbox.slice(sinceCount).find((m) => m.to === to);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function loginPassword(identifier, password) {
  for (let i = 0; i < 6; i += 1) {
    const r = await call('POST', '/api/auth/login/password', { body: { identifier, password } });
    if (r.status !== 429) return r;
    await sleep(15000);
  }
  return { status: 429, body: {} };
}

/** RFC 6238 TOTP, as an authenticator app computes it. */
function base32Decode(s) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/\s/g, '').toUpperCase()) {
    value = (value << 5) | a.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(key, offsetSteps = 0) {
  const step = BigInt(Math.floor(Date.now() / 1000 / 30) + offsetSteps);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(step);
  const h = createHmac('sha1', base32Decode(key)).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, '0');
}

const db = new pg.Client({ connectionString: DB });
await db.connect();
const one = async (q, p = []) => (await db.query(q, p)).rows[0];

try {
  // ── What is offered ──────────────────────────────────────────────────────
  section('What the sign-in screen is told it can offer');
  let r = await call('GET', '/api/auth/methods');
  check('email codes and password reset are offered (email is set up)', r.body.email_codes === true && r.body.password_reset === true, JSON.stringify(r.body));
  check('phone codes are not (no WhatsApp set up)', r.body.phone_codes === false);
  check('no Google button without a client ID', r.body.google_client_id === null);

  // ── Code by email ────────────────────────────────────────────────────────
  section('Signing in with a code sent by email');
  let n = inbox.length;
  r = await call('POST', '/api/auth/email-code/request', { body: { email: 'owner@hardwareerp.in' } });
  check('a code is requested', r.status === 200, r.body.message);
  check('…and the response does not contain it', !JSON.stringify(r.body).match(/\b\d{6}\b/));
  const mail = await waitForMail('owner@hardwareerp.in', n);
  check('the email arrives within seconds (not at the next 30 s tick)', Boolean(mail), mail?.subject);
  check('…sent with the configured key', mail?.key === 'test');
  const code = mail?.text?.match(/Code: (\d{6})/)?.[1];
  check('…carrying a 6-digit code', Boolean(code));
  const stored = await one(`SELECT status, channel FROM auth_message_outbox ORDER BY queued_at DESC LIMIT 1`);
  check('the outbox records it as SENT by EMAIL', stored.status === 'SENT' && stored.channel === 'EMAIL', JSON.stringify(stored));
  r = await call('POST', '/api/auth/login/email-code', { body: { email: 'owner@hardwareerp.in', code: code === '000000' ? '111111' : '000000' } });
  check('a wrong code is refused', r.status === 401);
  r = await call('POST', '/api/auth/login/email-code', { body: { email: 'OWNER@hardwareerp.in', code } });
  check('the right code signs in (email case does not matter)', r.status === 200 && Boolean(r.body.token), r.body.error ?? '');
  const ownerToken = r.body.token;
  r = await call('POST', '/api/auth/login/email-code', { body: { email: 'owner@hardwareerp.in', code } });
  check('the same code cannot be used twice', r.status === 401);
  n = inbox.length;
  r = await call('POST', '/api/auth/email-code/request', { body: { email: 'nobody@nowhere.example' } });
  check('an unknown email gets the same answer', r.status === 200);
  await sleep(1200);
  check('…and no email is sent', !inbox.slice(n).some((m) => m.to === 'nobody@nowhere.example'));
  n = inbox.length;
  await call('POST', '/api/auth/email-code/request', { body: { email: 'owner@hardwareerp.in' } });
  await sleep(1200);
  check('a second request within a minute sends nothing new', !inbox.slice(n).some((m) => m.to === 'owner@hardwareerp.in'));

  // ── Forgot password by email ─────────────────────────────────────────────
  section('Forgot password, by email link');
  n = inbox.length;
  r = await call('POST', '/api/auth/forgot', { body: { identifier: 'meera@hardwareerp.in', kind: 'PASSWORD' } });
  check('a reset is requested', r.status === 200);
  const resetMail = await waitForMail('meera@hardwareerp.in', n);
  const link = resetMail?.text?.match(/(https?:\/\/\S+\/login\?reset=\S+)/)?.[1];
  check('the email carries a reset link to the web app', Boolean(link), link ?? resetMail?.text);
  const token = link ? decodeURIComponent(new URL(link).searchParams.get('reset')) : '';
  r = await call('POST', '/api/auth/reset', { body: { token, new_secret: 'Account@55555' } });
  check('the link sets a new password', r.status === 200, r.body.error ?? '');
  r = await loginPassword('meera@hardwareerp.in', 'Account@55555');
  check('…which signs in', r.status === 200);
  r = await call('POST', '/api/auth/reset', { body: { token, new_secret: 'Account@66666' } });
  check('the link works only once', r.status !== 200);
  await call('POST', '/api/auth/change-password', { token: (await loginPassword('meera@hardwareerp.in', 'Account@55555')).body.token, body: { current_password: 'Account@55555', new_password: 'Account@12345' } });

  // ── Two-step ─────────────────────────────────────────────────────────────
  section('Two-step sign-in with an authenticator app');
  let s = await loginPassword('sunita@hardwareerp.in', 'Manager@12345');
  const sunita = s.body.token;
  r = await call('POST', '/api/auth/two-step/begin', { token: sunita, body: {} });
  check('setup gives a key and an otpauth link', r.status === 200 && /^otpauth:\/\/totp\//.test(r.body.otpauth_url), r.body.error ?? '');
  const key = r.body.key;
  r = await call('POST', '/api/auth/two-step/enable', { token: sunita, body: { code: '123456' === totp(key) ? '654321' : '123456' } });
  check('a wrong code does not turn it on', r.status === 400);
  r = await call('POST', '/api/auth/two-step/enable', { token: sunita, body: { code: totp(key) } });
  check('the app code turns it on and returns 10 recovery codes', r.status === 200 && r.body.recovery_codes?.length === 10, r.body.error ?? '');
  const recovery = r.body.recovery_codes ?? [];
  const secretRow = await one(`SELECT has_table_privilege('erp_app', 'user_mfa', 'SELECT') AS can_read`);
  check('the app role cannot read the secrets table', secretRow.can_read === false);

  s = await loginPassword('sunita@hardwareerp.in', 'Manager@12345');
  check('the password alone now asks for the second step', s.status === 200 && s.body.mfa_required === true && !s.body.token, JSON.stringify(s.body).slice(0, 80));
  const ticket = s.body.mfa_token;
  r = await call('GET', '/api/auth/me', { token: ticket });
  check('the half-signed-in ticket opens nothing', r.status === 401);
  r = await call('POST', '/api/auth/login/two-step', { body: { mfa_token: ticket, code: '000000' === totp(key) ? '111111' : '000000' } });
  check('a wrong second-step code is refused', r.status === 401);
  r = await call('POST', '/api/auth/login/two-step', { body: { mfa_token: ticket, code: recovery[0] } });
  check('a recovery code completes the sign-in', r.status === 200 && r.body.token === ticket, r.body.error ?? '');
  r = await call('GET', '/api/auth/me', { token: ticket });
  check('…and the session now works', r.status === 200);
  s = await loginPassword('sunita@hardwareerp.in', 'Manager@12345');
  r = await call('POST', '/api/auth/login/two-step', { body: { mfa_token: s.body.mfa_token, code: recovery[0] } });
  check('a recovery code works only once', r.status === 401);
  r = await call('POST', '/api/auth/login/two-step', { body: { mfa_token: s.body.mfa_token, code: recovery[1].replace('-', '').toLowerCase() } });
  check('recovery codes are accepted without the dash, any case', r.status === 200, r.body.error ?? '');
  r = await call('GET', '/api/auth/two-step', { token: sunita });
  check('status shows on, with 8 recovery codes left', r.body.enabled === true && r.body.recovery_codes_left === 8, JSON.stringify(r.body));
  const pin = await call('POST', '/api/auth/login/pin', { body: { phone: '9900000002', pin: '1111' } });
  check('two-step applies to PIN sign-in too', pin.status === 200 && pin.body.mfa_required === true, JSON.stringify(pin.body).slice(0, 80));

  // ── Devices and history ──────────────────────────────────────────────────
  section('Signed-in devices and sign-in history');
  r = await call('GET', '/api/auth/sessions', { token: sunita });
  check('your devices are listed, this one marked', r.status === 200 && r.body.some((x) => x.is_current), `${r.body.length} session(s)`);
  check('half-finished two-step sign-ins are not listed as devices', r.body.every((x) => x.login_method));
  r = await call('POST', '/api/auth/sessions/revoke-others', { token: sunita, body: {} });
  check('"sign out other devices" ends the others', r.status === 200 && r.body.signed_out >= 1, JSON.stringify(r.body));
  r = await call('GET', '/api/auth/me', { token: ticket });
  check('…including the one signed in a moment ago', r.status === 401);
  r = await call('GET', '/api/auth/me', { token: sunita });
  check('…but not this one', r.status === 200);
  r = await call('GET', '/api/auth/sign-in-history', { token: sunita });
  check('history shows successes and the failed second step', r.status === 200 && r.body.some((h) => h.succeeded) && r.body.some((h) => !h.succeeded), `${r.body.length} entries`);

  // ── Owner controls ───────────────────────────────────────────────────────
  section("The Owner looking after someone's sign-in");
  const sunitaId = (await one(`SELECT user_id FROM users WHERE email = 'sunita@hardwareerp.in'`)).user_id;
  r = await call('GET', `/api/auth/users/${sunitaId}/security`, { token: ownerToken });
  check('the Owner sees two-step on and the device count', r.status === 200 && r.body.two_step === true && r.body.active_sessions >= 1, JSON.stringify(r.body).slice(0, 100));
  r = await call('GET', `/api/auth/users/${sunitaId}/security`, { token: sunita });
  check('a manager cannot see another user’s security', r.status === 403);
  r = await call('POST', `/api/auth/users/${sunitaId}/two-step/reset`, { token: ownerToken, body: {} });
  check('the Owner turns two-step off (lost phone)', r.status === 200);
  r = await call('GET', '/api/auth/me', { token: sunita });
  check('…which signs them out everywhere', r.status === 401);
  s = await loginPassword('sunita@hardwareerp.in', 'Manager@12345');
  check('…and the password alone works again', s.status === 200 && Boolean(s.body.token));
  const audits = await one(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action IN ('TWO_STEP_ENABLED','TWO_STEP_RESET')`, [sunitaId]);
  check('turning it on and resetting it are in the audit trail', audits.n >= 2, `${audits.n}`);

  // ── Google sign-in, the database half ───────────────────────────────────
  // The API checks Google's signature before this runs, and that cannot be faked
  // offline — so this calls the function the API calls, with an already-verified
  // identity. (It once failed on the very first sign-in with "user_id is ambiguous".)
  section('Google sign-in: matching a verified Google account to a user');
  const gTok = (n) => `${n}`.padEnd(64, 'a');
  await db.query(`UPDATE users SET google_sub = NULL WHERE lower(email) = 'owner@hardwareerp.in'`);
  let g = await one(`SELECT * FROM auth_login_google('Owner@HardwareERP.in', 'google-sub-1', $1, '127.0.0.1'::inet, 'test', NULL, 60)`, [gTok('g1')]);
  check('a registered email signs in on the first Google sign-in', g?.status === 'OK' && Boolean(g.user_id), JSON.stringify(g));
  const bound = await one(`SELECT google_sub FROM users WHERE lower(email) = 'owner@hardwareerp.in'`);
  check('…and the Google account id is remembered', bound?.google_sub === 'google-sub-1', bound?.google_sub);
  g = await one(`SELECT * FROM auth_login_google('owner@hardwareerp.in', 'google-sub-1', $1, '127.0.0.1'::inet, 'test', NULL, 60)`, [gTok('g2')]);
  check('the next sign-in works too', g?.status === 'OK', g?.status);
  g = await one(`SELECT * FROM auth_login_google('someone.else@example.com', 'google-sub-9', $1, '127.0.0.1'::inet, 'test', NULL, 60)`, [gTok('g3')]);
  check('an account nobody added is turned away, not created', g?.status === 'UNKNOWN_ACCOUNT', g?.status);
  const stranger = await one(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'someone.else@example.com'`);
  check('…and no user was created for it', stranger.n === 0);
  await db.query(`UPDATE users SET google_sub = NULL WHERE lower(email) = 'owner@hardwareerp.in'`);

  // ── Nothing claims a delivery that did not happen ────────────────────────
  section('A code with no way to send it');
  r = await call('POST', '/api/auth/otp/request', { body: { phone: '9900000005', purpose: 'LOGIN' } });
  await sleep(1500);
  const wa = await one(`SELECT status, last_error FROM auth_message_outbox WHERE channel = 'WHATSAPP' ORDER BY queued_at DESC LIMIT 1`);
  check('a WhatsApp code with WhatsApp not set up is NOT_CONFIGURED, never SENT', wa?.status === 'NOT_CONFIGURED', JSON.stringify(wa));
} catch (err) {
  failures.push(`suite crashed: ${err.stack ?? err}`);
  console.log(`${C.r}suite crashed:${C.x}`, err);
} finally {
  await db.end();
  mailServer.close();
}

console.log(`\n${'─'.repeat(70)}\n${C.b}${passed} passed, ${failures.length} failed${C.x}`);
if (failures.length) {
  console.log(`${C.r}Failures:${C.x}`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`${C.g}Every sign-in option works, and none claims what it did not do.${C.x}`);
