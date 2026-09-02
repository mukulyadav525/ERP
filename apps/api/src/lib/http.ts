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
    const session = await resolveSession(req);
    if (!session) throw unauthorized();
    if (permission && !canAccess(session.role, permission)) {
      throw forbidden(`Your role (${session.role}) is not permitted to ${permission.replace(/_/g, ' ')}.`);
    }
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
  if (session.role === 'OWNER_ADMIN') return requested ? uuid(requested, 'branch_id') : null;
  return session.branch_id;
}

/**
 * For WRITES, the branch is never taken from the request body. A cashier creating
 * an invoice creates it at their own branch, full stop. An admin must name the
 * branch explicitly because they have no default one.
 */
export function writeBranch(session: Session, requested?: string | null): string {
  if (session.role === 'OWNER_ADMIN') {
    if (!requested) throw badRequest('branch_id is required when acting as Owner/Admin, which has no default branch.');
    return uuid(requested, 'branch_id');
  }
  if (!session.branch_id) throw forbidden('Your account is not assigned to a branch.');
  // A branch user's write always lands on their own branch; anything else is a
  // client bug or an attempt, and either way must not be honoured.
  if (requested && requested !== session.branch_id) {
    throw forbidden('You can only create records for your own branch.');
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
