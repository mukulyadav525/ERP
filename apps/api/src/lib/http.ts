// The single place every authenticated endpoint goes through.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { db, withScope, type Tx } from './db.js';
import { bearerFrom, hashToken, looksValid, type Session } from './session.js';
import { canAccess } from './rbac.js';
import { forbidden, unauthorized, badRequest, HttpError } from './errors.js';

export interface Ctx {
  session: Session;
  /** RLS-scoped transaction. Use this for every query in a route body. */
  db: Tx;
  req: FastifyRequest;
  reply: FastifyReply;
}

/** Resolves a bearer token to a live session, or null. */
export async function resolveSession(req: FastifyRequest): Promise<Session | null> {
  const token = bearerFrom(req as any);
  if (!token || !looksValid(token)) return null;

  const rows = await sql<{
    session_id: string; user_id: string; role: string; branch_id: string | null;
    full_name: string; email: string | null; phone: string | null;
    language_pref: string; must_change_password: boolean; expires_at: Date;
  }>`SELECT * FROM auth_session_resolve(${hashToken(token)})`.execute(db);

  const row = rows.rows[0];
  if (!row) return null;
  return { ...row, role: row.role as Session['role'] };
}

/** The branches a user may act at, straight from the database (auth_user_branches). */
export async function authorisedBranches(userId: string): Promise<Array<{ branch_id: string; name: string; code: string; is_home: boolean }>> {
  const rows = await sql<{ branch_id: string; name: string; code: string; is_home: boolean }>`
    SELECT * FROM auth_user_branches(${userId})
  `.execute(db);
  return rows.rows;
}

/**
 * Section 0/3 — which branch this request acts at.
 *
 * The browser sends the branch the user picked in the top bar as `X-Branch-Id`.
 * That header is a REQUEST, never a fact: for a branch user it is honoured only
 * if auth_user_branches() lists the branch, and otherwise the call is refused.
 * The chosen branch then becomes the RLS GUC for the whole transaction, so every
 * policy in the schema confines the request to it exactly as before.
 *
 * An Owner keeps chain-wide visibility (branch_id null); their pick is recorded
 * as `active_branch_id` and is what a write lands on when the body names none.
 */
async function applyActiveBranch(session: Session, req: FastifyRequest): Promise<Session> {
  const raw = req.headers['x-branch-id'];
  const requested = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  const withHome: Session = { ...session, home_branch_id: session.branch_id };
  if (!requested) return withHome;
  if (!UUID_RE.test(requested)) throw badRequest('The selected branch is not valid. Pick a branch again.');

  // Checked through auth_user_branches(), a SECURITY DEFINER function: this runs
  // before the request's RLS scope exists, so a plain SELECT on branches would
  // see nothing and refuse every branch.
  if (session.role !== 'OWNER_ADMIN' && requested === session.branch_id) return withHome;
  const allowed = await authorisedBranches(session.user_id);
  if (session.role === 'OWNER_ADMIN') {
    if (!allowed.some((b) => b.branch_id === requested)) {
      throw badRequest('The selected branch no longer exists or has been deactivated.');
    }
    return { ...withHome, active_branch_id: requested };
  }
  if (!allowed.some((b) => b.branch_id === requested)) {
    throw forbidden('You do not have access to that branch.');
  }
  return { ...withHome, branch_id: requested };
}

/**
 * Wraps a route handler with: authentication, the role check, and an RLS-scoped
 * transaction. Pass `null` as the permission for endpoints that only require a
 * valid session (e.g. /me). The transaction commits when the handler resolves and
 * rolls back if it throws, so a half-written invoice can never be left behind.
 */
export function guarded<T>(
  permission: string | null,
  handler: (ctx: Ctx) => Promise<T>,
) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<T | undefined> => {
    const resolved = await resolveSession(req);
    if (!resolved) throw unauthorized();
    if (permission && !canAccess(resolved.role, permission)) {
      throw forbidden(`Your role does not allow you to ${permission.replace(/_/g, ' ')}. Ask the owner if you need this.`);
    }
    const session = await applyActiveBranch(resolved, req);
    return withScope(session, (trx) => handler({ session, db: trx, req, reply }));
  };
}

/** Endpoints that are reachable without a session (login, signup, reset). */
export function open<T>(handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>) {
  return handler;
}

// ── Branch resolution (Section 0) ───────────────────────────────────────────
/**
 * Decides which branch a request operates on.
 *
 * For every role except OWNER_ADMIN the answer is always the user's own branch,
 * whatever the query string says — a branch user passing ?branch_id=<other> gets
 * their own branch back, not a 403, because RLS would return nothing anyway and a
 * silent scope-down is the friendlier behaviour for a shared bookmark.
 *
 * OWNER_ADMIN may pass an explicit branch, or omit it for a chain-wide view.
 */
export function resolveBranchScope(session: Session, requested?: string | null): string | null {
  // The admin's value is validated rather than passed through: an unparseable
  // branch_id reached Postgres as a uuid cast and came back as a 500 with no clue
  // what was wrong. A malformed id is a client error and should say so.
  if (session.role === 'OWNER_ADMIN') {
    if (requested === 'all') return null;
    const pick = requested || session.active_branch_id || null;
    return pick ? uuid(pick, 'branch_id') : null;
  }
  return session.branch_id;
}

/** What the UI keys on to open its branch picker rather than show an error. */
export const BRANCH_REQUIRED = 'BRANCH_REQUIRED';

/**
 * For WRITES, a physical transaction always happens at ONE real branch.
 *
 * "All branches" is a way of LOOKING at the chain, never a place a sale, a
 * receipt or a payment can happen. So:
 *   - a branch user's write lands on the branch this request is acting at (their
 *     home branch, or another they are authorised for — resolved in guarded());
 *     naming any other branch is refused.
 *   - an Owner's write lands on the branch named in the body, else the branch
 *     picked in the top bar; with neither, the request is refused with a plain
 *     instruction and a code the screen uses to ask for a branch.
 */
export function writeBranch(session: Session, requested?: string | null): string {
  if (session.role === 'OWNER_ADMIN') {
    const pick = requested || session.active_branch_id;
    if (!pick) throw new HttpError(400, 'Please select a branch for this transaction.', { code: BRANCH_REQUIRED });
    return uuid(pick, 'branch_id');
  }
  if (!session.branch_id) throw forbidden('Your account is not assigned to a branch. Ask the owner to assign one.');
  // A branch user's write always lands on the branch they are acting at; anything
  // else is a client bug or an attempt, and either way must not be honoured.
  if (requested && requested !== session.branch_id) {
    throw forbidden('You can only record transactions for the branch you are working at.');
  }
  return session.branch_id;
}

// ── Validation helpers ──────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw badRequest(`${field} must be a valid id.`);
  }
  return value;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, field);
}

export function str(value: unknown, field: string, { max = 500, min = 1 } = {}): string {
  if (typeof value !== 'string') throw badRequest(`${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw badRequest(`${field} is required.`);
  if (trimmed.length > max) throw badRequest(`${field} must be at most ${max} characters.`);
  return trimmed;
}

export function optionalStr(value: unknown, field: string, opts?: { max?: number }): string | null {
  if (value === undefined || value === null || value === '') return null;
  return str(value, field, { ...opts, min: 1 });
}

export function num(value: unknown, field: string, { min = -Infinity, max = Infinity } = {}): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw badRequest(`${field} must be a number.`);
  if (n < min) throw badRequest(`${field} must be at least ${min}.`);
  if (n > max) throw badRequest(`${field} must be at most ${max}.`);
  return n;
}

export function bool(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${field} is required.`);
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`${field} must be true or false.`);
}

export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function arrayOf<T>(value: unknown, field: string, mapper: (item: any, index: number) => T, { min = 1, max = 500 } = {}): T[] {
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list.`);
  if (value.length < min) throw badRequest(`${field} must contain at least ${min} item(s).`);
  if (value.length > max) throw badRequest(`${field} cannot contain more than ${max} items.`);
  return value.map(mapper);
}

/** Clamped list limit — stops a client asking for a million rows. */
export function limit(value: unknown, fallback = 50, max = 500): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

export { HttpError };
