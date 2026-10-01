// ============================================================================
// Section 7 — Access, Auth & Security
//
// Every login path below ends in the same place: a SECURITY DEFINER function in
// the database checks the credential and issues a session row. This process never
// sees a password, PIN or OTP hash.
//
// Paths supported (7.2):
//   POST /login/google        Google OAuth ID token (verified against Google's keys)
//   POST /login/password      email or phone + password
//   POST /login/pin           phone + 4-6 digit quick-access PIN
//   POST /otp/request         phone -> OTP issued
//   POST /login/otp           phone + OTP
//   POST /register            self-service signup -> pending admin approval
//   POST /forgot              request a password or PIN reset
//   POST /reset               consume the reset token, set the new secret
//   POST /change-password     while logged in
//   POST /verify-override-pin manager PIN for an in-session override (3.4/3.8)
// ============================================================================
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { sql } from 'kysely';
import { db } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import {
  guarded, uuid, str, optionalStr, oneOf, limit as clampLimit, authorisedBranches,
} from '../../lib/http.js';
import type { Tx } from '../../lib/db.js';

/**
 * Replaces the extra branches a staff member may act at (beyond their home
 * branch). Owner-only by the route's permission; the home branch is implicit and
 * never stored here, so it cannot be "revoked" by accident.
 */
async function setBranchAccess(trx: Tx, userId: string, homeBranch: string | null, grantedBy: string, raw: unknown) {
  if (raw === undefined) return false;
  if (!Array.isArray(raw)) throw badRequest('Branch access must be a list of branches.');
  const ids = [...new Set(raw.map((v, i) => uuid(v, `Branch ${i + 1}`)))].filter((b) => b !== homeBranch);
  await sql`DELETE FROM user_branch_access WHERE user_id = ${userId}`.execute(trx);
  for (const b of ids) {
    await sql`INSERT INTO user_branch_access (user_id, branch_id, granted_by) VALUES (${userId}, ${b}, ${grantedBy})`.execute(trx);
  }
  return true;
}
import { badRequest, forbidden, tooMany, unauthorized, notFound } from '../../lib/errors.js';
import {
  issueToken, hashToken, issueResetToken, hashResetToken, generateOtp, bearerFrom,
} from '../../lib/session.js';
import { ALL_ROLES, ROLE_META } from '../../lib/rbac.js';
import { audit } from '../../lib/audit.js';
import { queueAuthMessage } from '../../lib/whatsapp.js';
import { chainDisplayName } from '../../lib/pdf/business-profile.js';

const googleClient = new OAuth2Client(env.googleClientId);

async function branchNameFor(branchId: string | null): Promise<string | null> {
  if (!branchId) return null;
  const rows = await sql<{ name: string }>`SELECT name FROM branches WHERE branch_id = ${branchId}`.execute(db);
  return rows.rows[0]?.name ?? null;
}

interface AuthRow {
  status: string; user_id: string | null; role: string | null; branch_id: string | null;
  full_name: string | null; email: string | null; phone: string | null;
  language_pref: string | null; must_change_password: boolean | null; expires_at: Date | null;
}

function clientIp(req: FastifyRequest): string | null {
  return req.ip || null;
}

/** Turns a status row from the database into either a 200 payload or the right
 *  error. Messages are deliberately identical for "no such user" and "wrong
 *  password" so the endpoint cannot be used to discover which accounts exist. */
function finishLogin(row: AuthRow | undefined, token: string, branchName?: string | null) {
  if (!row) throw unauthorized('Incorrect credentials. Please check and try again.');
  switch (row.status) {
    case 'OK':
      return {
        token,
        expires_at: row.expires_at,
        user: {
          user_id: row.user_id, role: row.role, branch_id: row.branch_id,
          // Included so the client can label the session's branch immediately
          // rather than showing a placeholder until a second request lands.
          branch_name: branchName ?? null,
          full_name: row.full_name, email: row.email, phone: row.phone,
          language_pref: row.language_pref ?? 'en',
          must_change_password: row.must_change_password ?? false },
        };
    case 'LOCKED':
      throw tooMany('Too many failed attempts. This account is locked for a short while — ask your manager to reset it, or try again later.');
    case 'INACTIVE':
      throw forbidden('This account has been deactivated. Please contact your administrator.');
    case 'UNKNOWN_ACCOUNT':
      throw unauthorized('That Google account is not registered here. Ask an administrator to add you first.');
    default:
      throw unauthorized('Incorrect credentials. Please check and try again.');
  }
}

export default async function authRoutes(app: FastifyInstance) {
  // Login endpoints get a much tighter rate limit than the rest of the API.
  // This is the second layer, on top of the per-account lockout in the database:
  // it also throttles an attacker spraying one guess each across many accounts,
  // which per-account counters alone would never notice.
  // Two layers, deliberately different in what they catch:
  //   * this one throttles a single IP hammering the login endpoints
  //   * the per-account lockout in the database (7.4) catches an attacker
  //     spread across many IPs guessing one account
  // Neither is sufficient alone, which is why both exist.
  const authLimit = {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } } } as const;

  // ── Google OAuth (7.2 default for Owner/Admin and Branch Manager) ─────────
  app.post('/login/google', authLimit, async (req) => {
    const body = (req.body ?? {}) as { id_token?: string };
    const idToken = str(body.id_token, 'id_token', { max: 4096 });

    if (!env.googleClientId) {
      throw badRequest('Google sign-in is not configured on this server. Set GOOGLE_OAUTH_CLIENT_ID, or use email + password.');
    }

    // The signature check is the whole security boundary here. An unverified
    // token is just a base64 string anybody can write, so accepting a bare email
    // (as an earlier revision of this file did) is equivalent to no auth at all.
    let email: string | undefined;
    let sub: string | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: env.googleClientId });
      const payload = ticket.getPayload();
      email = payload?.email;
      sub = payload?.sub;
      if (!payload?.email_verified) throw new Error('email not verified by Google');
    } catch {
      throw unauthorized('That Google sign-in could not be verified. Please try again.');
    }
    if (!email) throw unauthorized('Google did not return an email address for this account.');

    const { token, tokenHash } = issueToken();
    const res = await sql<AuthRow>`
      SELECT * FROM auth_login_google(${email}, ${sub ?? null}, ${tokenHash},
        ${clientIp(req)}::inet, ${req.headers['user-agent'] ?? null}, NULL, ${env.sessionTtlMinutes})
    `.execute(db);
    return finishLogin(res.rows[0], token, await branchNameFor(res.rows[0]?.branch_id ?? null));
  });

  // ── Email / phone + password ──────────────────────────────────────────────
  app.post('/login/password', authLimit, async (req) => {
    const body = (req.body ?? {}) as { identifier?: string; email?: string; password?: string };
    const identifier = str(body.identifier ?? body.email, 'Email or phone', { max: 254 });
    const password = str(body.password, 'Password', { max: 256 });

    const { token, tokenHash } = issueToken();
    const res = await sql<AuthRow>`
      SELECT * FROM auth_login_password(${identifier}, ${password}, ${tokenHash},
        ${clientIp(req)}::inet, ${req.headers['user-agent'] ?? null}, NULL, ${env.sessionTtlMinutes})
    `.execute(db);
    return finishLogin(res.rows[0], token, await branchNameFor(res.rows[0]?.branch_id ?? null));
  });

  // ── Phone + PIN (7.2 default for shop-floor staff) ────────────────────────
  app.post('/login/pin', authLimit, async (req) => {
    const body = (req.body ?? {}) as { phone?: string; pin?: string };
    const phone = str(body.phone, 'Phone number', { max: 20 });
    const pin = str(body.pin, 'PIN', { max: 6, min: 4 });
    if (!/^[0-9]{4,6}$/.test(pin)) throw badRequest('A PIN is 4 to 6 digits.');

    const { token, tokenHash } = issueToken();
    const res = await sql<AuthRow>`
      SELECT * FROM auth_login_pin(${phone}, ${pin}, ${tokenHash},
        ${clientIp(req)}::inet, ${req.headers['user-agent'] ?? null}, NULL, ${env.sessionTtlMinutes})
    `.execute(db);
    return finishLogin(res.rows[0], token, await branchNameFor(res.rows[0]?.branch_id ?? null));
  });

  // ── Phone + OTP ───────────────────────────────────────────────────────────
  app.post('/otp/request', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (req) => {
    const body = (req.body ?? {}) as { phone?: string; purpose?: string };
    const phone = str(body.phone, 'Phone number', { max: 20 });
    const purpose = oneOf(body.purpose ?? 'LOGIN', 'purpose', ['LOGIN', 'RESET_PIN', 'RESET_PASSWORD'] as const);
    const otp = generateOtp(6);

    const res = await sql<{ auth_otp_issue: boolean }>`
      SELECT auth_otp_issue(${phone}, ${purpose}, ${otp}, ${env.otpExpiryMinutes})
    `.execute(db);
    const issued = res.rows[0]?.auth_otp_issue === true;

    if (issued) {
      // Queued rather than sent inline, so a slow gateway cannot hold the request
      // open — but into the sealed auth outbox, not the staff-readable message log.
      // The business name comes from the configured profile, so a chain that has
      // set its own name does not send codes branded as something else.
      const brand = await chainDisplayName();
      await queueAuthMessage({
        to_phone: phone,
        purpose: 'OTP',
        body: `Your ${brand} verification code is ${otp}. It expires in ${env.otpExpiryMinutes} minutes. Do not share it with anyone.` });
    }

    // The same response either way — an attacker cannot use this to find out
    // which phone numbers are registered.
    return {
      ok: true,
      message: `If that number is registered, a code has been sent. It expires in ${env.otpExpiryMinutes} minutes.`,
      // Development convenience, behind an explicit opt-in rather than a guess at
      // the environment: a deploy that merely forgot NODE_ENV would otherwise hand
      // out live verification codes in the HTTP response.
      ...(env.exposeDevOtp && issued ? { dev_otp: otp } : {}),
    };
  });

  app.post('/login/otp', authLimit, async (req) => {
    const body = (req.body ?? {}) as { phone?: string; otp?: string };
    const phone = str(body.phone, 'Phone number', { max: 20 });
    const otp = str(body.otp, 'Verification code', { max: 8, min: 4 });

    const { token, tokenHash } = issueToken();
    const res = await sql<AuthRow>`
      SELECT * FROM auth_otp_verify(${phone}, ${otp}, ${tokenHash},
        ${clientIp(req)}::inet, ${req.headers['user-agent'] ?? null}, NULL, ${env.sessionTtlMinutes})
    `.execute(db);
    if (res.rows[0]?.status !== 'OK') {
      throw unauthorized('That code is not valid or has expired. Request a new one.');
    }
    return finishLogin(res.rows[0], token, await branchNameFor(res.rows[0]?.branch_id ?? null));
  });

  // ── Registration (7.2) ────────────────────────────────────────────────────
  // A signup never produces a working account by itself. It produces a request an
  // Owner/Admin approves — which is the only sane default for a system where an
  // account grants access to a branch's money and stock.
  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fullName = str(body.full_name, 'Full name', { max: 120 });
    const phone = str(body.phone, 'Phone number', { max: 20 });
    if (!/^[0-9+\-\s]{8,20}$/.test(phone)) throw badRequest('Please enter a valid phone number.');
    const email = optionalStr(body.email, 'Email', { max: 254 });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Please enter a valid email address.');
    const role = oneOf(body.requested_role ?? 'CASHIER', 'Role',
      ['BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'] as const);
    const branchId = body.branch_id ? uuid(body.branch_id, 'Branch') : null;
    const password = optionalStr(body.password, 'Password', { max: 256 });
    if (password && password.length < 8) throw badRequest('Choose a password of at least 8 characters.');

    const res = await sql<{ auth_register: string }>`
      SELECT auth_register(${fullName}, ${email}, ${phone}, ${role}, ${branchId}, ${password})
    `.execute(db);

    switch (res.rows[0]?.auth_register) {
      case 'ALREADY_REGISTERED':
        // Same wording as success: registration must not confirm who already has
        // an account here.
        return { ok: true, status: 'PENDING', message: 'Thanks — your request has been sent to the administrator for approval.' };
      case 'ALREADY_PENDING':
        return { ok: true, status: 'PENDING', message: 'A request for this number is already awaiting approval.' };
      case 'ROLE_NOT_ALLOWED':
        throw forbidden('That role cannot be requested through signup.');
      default:
        return { ok: true, status: 'PENDING', message: 'Thanks — your request has been sent to the administrator for approval.' };
    }
  });

  app.get('/branches/public', async () => {
    // The signup form needs branch names to pick from; nothing else is exposed.
    const rows = await sql<{ branch_id: string; name: string }>`
      SELECT branch_id, name FROM branches WHERE is_active ORDER BY name
    `.execute(db);
    return rows.rows;
  });

  app.get('/roles', async () => ALL_ROLES.map((r) => ({ role: r, ...ROLE_META[r] })));

  // ── Forgot password / PIN ─────────────────────────────────────────────────
  app.post('/forgot', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const body = (req.body ?? {}) as { identifier?: string; kind?: string };
    const identifier = str(body.identifier, 'Email or phone', { max: 254 });
    const kind = oneOf(body.kind ?? 'PASSWORD', 'kind', ['PASSWORD', 'PIN'] as const);

    const { token, tokenHash } = issueResetToken();
    const res = await sql<{ issued: boolean; user_id: string | null; email: string | null; phone: string | null }>`
      SELECT * FROM auth_request_reset(${identifier}, ${kind}, ${tokenHash}, ${env.resetExpiryMinutes})
    `.execute(db);
    const row = res.rows[0];

    if (row?.issued && row.phone) {
      const brand = await chainDisplayName();
      await queueAuthMessage({
        to_phone: row.phone,
        to_email: row.email,
        purpose: kind === 'PIN' ? 'PIN_RESET' : 'PASSWORD_RESET',
        body: kind === 'PIN'
          ? `Reset your ${brand} PIN with this code: ${token}. It expires in ${env.resetExpiryMinutes} minutes.`
          : `Reset your ${brand} password with this code: ${token}. It expires in ${env.resetExpiryMinutes} minutes.` });
    }

    return {
      ok: true,
      message: 'If that account exists, reset instructions have been sent to the registered phone or email.',
      ...(env.exposeDevOtp && row?.issued ? { dev_reset_token: token } : {}),
    };
  });

  app.post('/reset', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const body = (req.body ?? {}) as { token?: string; new_secret?: string; new_password?: string };
    const token = str(body.token, 'Reset code', { max: 200 });
    const secret = str(body.new_secret ?? body.new_password, 'New password or PIN', { max: 256 });

    const res = await sql<{ auth_perform_reset: string }>`
      SELECT auth_perform_reset(${hashResetToken(token)}, ${secret})
    `.execute(db);
    const status = res.rows[0]?.auth_perform_reset;
    if (status === 'INVALID_OR_EXPIRED') throw badRequest('That reset code is not valid or has expired. Request a new one.');
    if (status === 'WEAK') throw badRequest('Choose a password of at least 8 characters, or a PIN of 4 to 6 digits.');
    return { ok: true, message: 'Your credentials have been updated. Please sign in again.' };
  });

  // ── Session-bound endpoints ───────────────────────────────────────────────
  app.get('/me', guarded(null, async ({ session, db: trx }) => {
    const home = session.home_branch_id ?? session.branch_id;
    const branch = home
      ? (await sql<{ name: string; state_code: string; gstin: string | null }>`
          SELECT name, state_code, gstin FROM branches WHERE branch_id = ${home}
        `.execute(trx)).rows[0]
      : null;
    const branches = await authorisedBranches(session.user_id);
    return {
      user_id: session.user_id, role: session.role, branch_id: home,
      // The branches this person may switch between. An Owner may also pick
      // "All branches" for viewing; nobody may transact at "all branches".
      branches,
      branch_name: branch?.name ?? null, full_name: session.full_name,
      email: session.email ?? null, phone: session.phone ?? null,
      language_pref: session.language_pref ?? 'en',
      must_change_password: session.must_change_password ?? false,
      expires_at: session.expires_at,
    };
  }));

  app.post('/logout', async (req) => {
    const token = bearerFrom(req as any);
    if (token) await sql`SELECT auth_logout(${hashToken(token)})`.execute(db);
    return { ok: true };
  });

  app.post('/change-password', guarded(null, async ({ session, req }) => {
    const body = (req.body ?? {}) as { current_password?: string; new_password?: string };
    const current = str(body.current_password, 'Current password', { max: 256 });
    const next = str(body.new_password, 'New password', { max: 256 });
    if (next.length < 8) throw badRequest('Choose a new password of at least 8 characters.');
    if (next === current) throw badRequest('The new password must be different from the current one.');

    const res = await sql<{ auth_change_password: string }>`
      SELECT auth_change_password(${session.user_id}, ${current}, ${next})
    `.execute(db);
    const status = res.rows[0]?.auth_change_password;
    if (status === 'INVALID') throw unauthorized('Your current password is not correct.');
    if (status === 'WEAK') throw badRequest('Choose a new password of at least 8 characters.');
    return { ok: true, message: 'Password updated.' };
  }));

  app.post('/set-pin', guarded(null, async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as { pin?: string; user_id?: string };
    const pin = str(body.pin, 'PIN', { max: 6, min: 4 });
    const targetId = body.user_id ? uuid(body.user_id, 'user_id') : session.user_id;

    // The authority check lives inside auth_set_pin, which is SECURITY DEFINER and
    // takes a target user id — exactly the shape that must not depend on the
    // caller having remembered to check. It runs on the request transaction so a
    // failure rolls the PIN change back together with its audit entry.
    const res = await sql<{ auth_set_pin: string }>`
      SELECT auth_set_pin(${targetId}, ${pin}, ${session.user_id})
    `.execute(trx);
    const status = res.rows[0]?.auth_set_pin;
    if (status === 'WEAK') throw badRequest('A PIN must be 4 to 6 digits.');
    if (status === 'FORBIDDEN') throw forbidden('You cannot set that user\'s PIN.');

    if (targetId !== session.user_id) {
      await audit(trx, session, 'PIN_RESET', 'users', targetId);
    }
    return { ok: true, message: 'PIN updated.' };
  }));

  /**
   * 3.4 / 3.8 / 6.1.1 — an override PIN check. The cashier stays logged in; a
   * manager taps their PIN to authorise this one action.
   *
   * It returns an approval_id, not the manager's user id. That distinction is the
   * whole point: a user id is a permanent value, so passing one back as "proof"
   * meant anybody who ever saw a manager's id could self-approve for good. An
   * approval_id is single-use, expires in minutes, and is bound to this purpose,
   * this branch and this cashier.
   */
  app.post('/verify-override-pin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    guarded(null, async ({ session, req }) => {
      const body = (req.body ?? {}) as { pin?: string; purpose?: string };
      const pin = str(body.pin, 'PIN', { max: 6, min: 4 });
      const purpose = oneOf(body.purpose ?? 'DISCOUNT', 'purpose',
        ['DISCOUNT', 'NEGATIVE_STOCK', 'CREDIT_LIMIT', 'RETURN_WINDOW', 'CASH_DROP'] as const);
      const branchId = session.branch_id;
      if (!branchId) throw badRequest('An override is always approved at a branch, and your account has none.');

      // Verification and issuance are a single database call, so a grant cannot
      // exist without a PIN having been checked for it.
      const res = await sql<{ status: string; approval_id: string | null; approver_name: string | null }>`
        SELECT * FROM auth_request_override(
          ${pin}, ${purpose}, ${branchId}, ${session.user_id}, ${clientIp(req)}::inet, 10)
      `.execute(db);
      const row = res.rows[0];

      if (row?.status === 'LOCKED') {
        throw tooMany('Too many incorrect override PINs. Wait a few minutes before trying again.');
      }
      if (row?.status !== 'OK') throw unauthorized('That override PIN was not recognised.');

      return {
        ok: true,
        approval_id: row.approval_id,
        approver_name: row.approver_name,
        expires_in_minutes: 10,
      };
    }));

  // ── Active sessions (7.2 device-level login audit) ────────────────────────
  app.get('/sessions', guarded(null, async ({ session, db: trx }) => {
    const rows = await sql<any>`
      SELECT session_id, login_method, ip_address, user_agent, created_at, last_seen_at, expires_at
        FROM user_sessions
       WHERE user_id = ${session.user_id} AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_seen_at DESC
    `.execute(trx);
    return rows.rows;
  }));

  app.post('/sessions/revoke-all', guarded(null, async ({ session }) => {
    await sql`SELECT auth_revoke_user_sessions(${session.user_id})`.execute(db);
    return { ok: true, message: 'All of your other sessions have been signed out.' };
  }));

  // ── Branch list for authenticated users ───────────────────────────────────
  app.get('/branches', guarded(null, async ({ session, db: trx }) => {
    // Exactly the branches this person may act at: every branch for the Owner,
    // the home branch plus any granted ones for everyone else.
    const allowed = (await authorisedBranches(session.user_id)).map((b) => b.branch_id);
    const rows = await sql<any>`
      SELECT branch_id, code, name, address, state, state_code, gstin, phone,
             (branch_id IS NOT DISTINCT FROM ${session.home_branch_id ?? null}) AS is_home
        FROM branches
       WHERE is_active AND branch_id = ANY(${allowed}::uuid[])
       ORDER BY (branch_id IS NOT DISTINCT FROM ${session.home_branch_id ?? null}) DESC, name
    `.execute(trx);
    return rows.rows;
  }));

  /**
   * Every active branch by name — the destinations a transfer can be sent to.
   * Listing a branch grants nothing: acting at it still needs the access above.
   */
  app.get('/branch-directory', guarded(null, async ({ db: trx }) => (await sql<any>`
      SELECT branch_id, code, name, state_code FROM branches WHERE is_active ORDER BY name
    `.execute(trx)).rows));

  // ── User management (7.1) ─────────────────────────────────────────────────
  app.get('/users', guarded('manage_staff', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as { limit?: string };
    const rows = await sql<any>`
      SELECT u.user_id, u.branch_id, b.name AS branch_name, u.role, u.full_name, u.phone, u.email,
             u.language_pref, u.is_active, u.last_login_at,
             (u.pin_hash IS NOT NULL) AS has_pin, (u.password_hash IS NOT NULL) AS has_password,
             (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('branch_id', a.branch_id, 'name', ab.name) ORDER BY ab.name)
                         FROM user_branch_access a JOIN branches ab ON ab.branch_id = a.branch_id
                        WHERE a.user_id = u.user_id), '[]'::jsonb) AS extra_branches
        FROM users u LEFT JOIN branches b ON b.branch_id = u.branch_id
       ORDER BY u.full_name
       LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx);
    return rows.rows;
  }));

  app.post('/users', guarded('manage_users', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fullName = str(body.full_name, 'Full name', { max: 120 });
    const role = oneOf(body.role, 'Role', ALL_ROLES);
    const branchId = role === 'OWNER_ADMIN' ? null : uuid(body.branch_id, 'Branch');
    const phone = str(body.phone, 'Phone number', { max: 20 });
    const email = optionalStr(body.email, 'Email', { max: 254 });
    const password = optionalStr(body.password, 'Password', { max: 256 });
    const pin = optionalStr(body.pin, 'PIN', { max: 6 });
    if (password && password.length < 8) throw badRequest('Choose a password of at least 8 characters.');
    if (pin && !/^[0-9]{4,6}$/.test(pin)) throw badRequest('A PIN must be 4 to 6 digits.');

    const inserted = await sql<{ user_id: string }>`
      INSERT INTO users (branch_id, role, full_name, phone, email, language_pref,
                         password_hash, pin_hash, must_change_password)
      VALUES (${branchId}, ${role}::user_role, ${fullName}, ${phone}, ${email},
              ${optionalStr(body.language_pref, 'language') ?? 'en'},
              ${password ? sql`crypt(${password}, gen_salt('bf', 12))` : null},
              ${pin ? sql`crypt(${pin}, gen_salt('bf', 12))` : null},
              ${!password})
      RETURNING user_id
    `.execute(trx);
    const userId = inserted.rows[0].user_id;
    if (role !== 'OWNER_ADMIN') await setBranchAccess(trx, userId, branchId, session.user_id, body.extra_branch_ids);

    // Every non-admin user is also an employee record, so attendance, shifts and
    // sales attribution have something to hang off from day one.
    if (branchId) {
      await sql`
        INSERT INTO employees (user_id, branch_id, designation)
        VALUES (${userId}, ${branchId}, ${optionalStr(body.designation, 'designation') ?? role})
      `.execute(trx);
    }
    await audit(trx, session, 'USER_CREATED', 'users', userId, { after: { role, branch_id: branchId, full_name: fullName } });
    return { ok: true, user_id: userId };
  }));

  app.put('/users/:id', guarded('manage_users', async ({ session, db: trx, req }) => {
    const { id } = req.params as { id: string };
    const userId = uuid(id, 'user_id');
    const body = (req.body ?? {}) as Record<string, unknown>;

    const before = (await sql<any>`SELECT user_id, role, branch_id, is_active, full_name FROM users WHERE user_id = ${userId}`.execute(trx)).rows[0];
    if (!before) throw notFound('User not found.');

    const role = body.role === undefined ? before.role : oneOf(body.role, 'Role', ALL_ROLES);
    const branchId = role === 'OWNER_ADMIN'
      ? null
      : (body.branch_id === undefined ? before.branch_id : uuid(body.branch_id, 'Branch'));
    if (role !== 'OWNER_ADMIN' && !branchId) throw badRequest('A branch role must be assigned to a branch.');
    const isActive = body.is_active === undefined ? before.is_active : Boolean(body.is_active);

    // The last active Owner must not be able to demote or disable themselves and
    // lock everybody out of the system.
    if (before.role === 'OWNER_ADMIN' && (role !== 'OWNER_ADMIN' || !isActive)) {
      const others = await sql<{ count: string }>`
        SELECT count(*) FROM users WHERE role = 'OWNER_ADMIN' AND is_active AND user_id <> ${userId}
      `.execute(trx);
      if (Number(others.rows[0].count) === 0) {
        throw badRequest('This is the only active Owner account — promote another Owner before changing this one.');
      }
    }

    await sql`
      UPDATE users SET role = ${role}::user_role, branch_id = ${branchId}, is_active = ${isActive},
             full_name = ${optionalStr(body.full_name, 'Full name', { max: 120 }) ?? before.full_name},
             locked_until = ${body.unlock ? null : sql`locked_until`},
             failed_attempts = ${body.unlock ? 0 : sql`failed_attempts`}
       WHERE user_id = ${userId}
    `.execute(trx);

    // Keep the employee record's branch in step, or a transferred user keeps
    // showing up on their old branch's roster.
    if (branchId) {
      await sql`
        INSERT INTO employees (user_id, branch_id, designation) VALUES (${userId}, ${branchId}, ${role})
        ON CONFLICT DO NOTHING
      `.execute(trx);
      await sql`UPDATE employees SET branch_id = ${branchId} WHERE user_id = ${userId}`.execute(trx);
    }

    const accessChanged = role === 'OWNER_ADMIN'
      ? (await sql`DELETE FROM user_branch_access WHERE user_id = ${userId}`.execute(trx), false)
      : await setBranchAccess(trx, userId, branchId, session.user_id, body.extra_branch_ids);
    if (accessChanged) {
      await audit(trx, session, 'BRANCH_ACCESS_CHANGE', 'users', userId,
        { after: { extra_branch_ids: body.extra_branch_ids } });
    }

    // A deactivated or re-roled user must not keep an open session with their old
    // privileges until it happens to expire — nor one scoped to a branch they lost.
    if (!isActive || role !== before.role || branchId !== before.branch_id || accessChanged) {
      await sql`SELECT auth_revoke_user_sessions(${userId})`.execute(trx);
    }

    await audit(trx, session, role !== before.role ? 'ROLE_CHANGE' : 'USER_UPDATED', 'users', userId,
      { before, after: { role, branch_id: branchId, is_active: isActive } });
    return { ok: true };
  }));

  // ── Registration queue (admin) ────────────────────────────────────────────
  app.get('/registration-requests', guarded('manage_users', async ({ db: trx }) => {
    const rows = await sql<any>`
      SELECT r.request_id, r.full_name, r.email, r.phone, r.requested_role,
             r.requested_branch_id, b.name AS requested_branch_name, r.status, r.created_at
        FROM registration_requests r
        LEFT JOIN branches b ON b.branch_id = r.requested_branch_id
       WHERE r.status = 'PENDING'
       ORDER BY r.created_at ASC
    `.execute(trx);
    return rows.rows;
  }));

  app.post('/registration-requests/:id/approve', guarded('manage_users', async ({ session, db: trx, req }) => {
    const { id } = req.params as { id: string };
    const requestId = uuid(id, 'request_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = oneOf(body.role, 'Role', ALL_ROLES);
    const branchId = role === 'OWNER_ADMIN' ? null : uuid(body.branch_id, 'Branch');

    const res = await sql<{ auth_approve_registration: string }>`
      SELECT auth_approve_registration(${requestId}, ${session.user_id}, ${role}, ${branchId})
    `.execute(trx);
    const newUserId = res.rows[0].auth_approve_registration;

    if (branchId) {
      await sql`INSERT INTO employees (user_id, branch_id, designation) VALUES (${newUserId}, ${branchId}, ${role}) ON CONFLICT DO NOTHING`.execute(trx);
    }
    await audit(trx, session, 'REGISTRATION_APPROVED', 'registration_requests', requestId, { after: { user_id: newUserId, role } });
    return { ok: true, user_id: newUserId };
  }));

  app.post('/registration-requests/:id/reject', guarded('manage_users', async ({ session, db: trx, req }) => {
    const { id } = req.params as { id: string };
    const requestId = uuid(id, 'request_id');
    const reason = optionalStr((req.body as any)?.reason, 'Reason', { max: 500 });
    await sql`
      UPDATE registration_requests
         SET status = 'REJECTED', reviewed_by = ${session.user_id}, reviewed_at = now(), reject_reason = ${reason}
       WHERE request_id = ${requestId} AND status = 'PENDING'
    `.execute(trx);
    await audit(trx, session, 'REGISTRATION_REJECTED', 'registration_requests', requestId, { after: { reason } });
    return { ok: true };
  }));
}
