// Session tokens (Section 7.2).
//
// A token is 32 bytes of CSPRNG randomness plus an HMAC tag over that randomness.
// The tag lets the server reject a garbage token without touching the database,
// and the database stores only sha256(token) — so neither a log line nor a stolen
// database dump yields anything replayable.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import type { UserRole } from './rbac.js';

export interface Session {
  session_id?: string;
  user_id: string;
  role: UserRole;
  /**
   * The branch this REQUEST runs at — what the RLS GUC is set to. For a branch
   * user it is their home branch unless they asked (X-Branch-Id) for another
   * branch they are authorised for. For an Owner it stays null (chain-wide
   * visibility) and the chosen branch travels in `active_branch_id` instead.
   */
  branch_id: string | null;
  /** The user's own branch, whatever branch this request is acting at. */
  home_branch_id?: string | null;
  /** Owner only: the branch picked in the top bar, used as the default for writes and filters. */
  active_branch_id?: string | null;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  language_pref?: string;
  must_change_password?: boolean;
  expires_at?: Date;
}

function tag(raw: string): string {
  return createHmac('sha256', env.sessionSecret).update(raw).digest('base64url').slice(0, 32);
}

export function issueToken(): { token: string; tokenHash: string } {
  const raw = randomBytes(32).toString('base64url');
  const token = `${raw}.${tag(raw)}`;
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap structural check before we spend a database round-trip on a token. */
export function looksValid(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expected = Buffer.from(tag(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function bearerFrom(req: { headers: Record<string, any> }): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

/** Single-use tokens for password/PIN resets — same construction, longer body. */
export function issueResetToken(): { token: string; tokenHash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { token: raw, tokenHash: createHash('sha256').update(raw).digest('hex') };
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Numeric OTP, uniformly distributed (no modulo bias). */
export function generateOtp(digits = 6): string {
  const max = 10 ** digits;
  let n: number;
  do {
    n = randomBytes(4).readUInt32BE(0);
  } while (n >= Math.floor(0xffffffff / max) * max);
  return String(n % max).padStart(digits, '0');
}
