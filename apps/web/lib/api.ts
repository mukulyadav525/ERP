// ============================================================================
// The single HTTP layer. Every request in the app goes through here so that
// authentication, error shape and session expiry are handled in exactly one place.
// ============================================================================
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

const TOKEN_KEY = 'erp_auth_token';
const SESSION_KEY = 'erp_user_session';

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setStoredSession(token: string, user: unknown): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch { /* private browsing — the session simply won't survive a reload */ }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}

export function readStoredSession<T = any>(): { token: string; user: T } | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(SESSION_KEY);
    if (!token || !raw) return null;
    return { token, user: JSON.parse(raw) as T };
  } catch { return null; }
}

/** An API error that carries the server's own message, which is written to be
 *  shown to a user as-is rather than being a stack trace. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The branch picked in the top bar. Sent on every request as X-Branch-Id so a
 * write lands where the user is working without each screen having to remember
 * to add branch_id to its body. It is a REQUEST: the server checks it against the
 * branches this user is authorised for before it scopes anything to it.
 */
let activeBranchHeader: string | null = null;
export function setActiveBranchHeader(branchId: string | null) { activeBranchHeader = branchId; }
export function getActiveBranchHeader(): string | null { return activeBranchHeader; }

/** A fresh idempotency key for one submission of a form that moves money or stock. */
export function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for very old browsers: RFC 4122 v4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** True when the server refused a write because no specific branch was chosen. */
export function isBranchRequired(err: unknown): boolean {
  return err instanceof ApiError && (err.details as any)?.code === 'BRANCH_REQUIRED';
}

let onUnauthorized: (() => void) | null = null;
/** AuthContext registers a handler so a 401 anywhere signs the user out cleanly
 *  instead of each call site inventing its own redirect. */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        ...(activeBranchHeader ? { 'X-Branch-Id': activeBranchHeader } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A network failure is not a server error, and saying so matters: during an
    // outage the cashier needs to know the till is offline, not that something broke.
    throw new ApiError(0, 'Cannot reach the server. Check your connection — billing keeps working offline and will sync when you reconnect.');
  }

  // A 401 from a login attempt means "those credentials are wrong", not "your
  // session expired" — treating them the same replaced the server's useful
  // message with a misleading one and bounced the user off the sign-in page.
  const isAuthAttempt = /^\/api\/auth\/(login|register|forgot|reset|otp)/.test(path);
  if (res.status === 401 && !isAuthAttempt) {
    clearStoredSession();
    onUnauthorized?.();
    throw new ApiError(401, 'Your session has ended. Please sign in again.');
  }

  const text = await res.text();
  let payload: any = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = text; } }

  if (!res.ok) {
    const message = (payload && typeof payload === 'object' && payload.error)
      ? payload.error
      : res.status >= 500 ? 'Something went wrong on our side. Please try again.'
      : res.status === 404 ? 'That was not found.'
      : 'That request could not be completed.';
    throw new ApiError(res.status, message, payload?.details);
  }
  return payload as T;
}

export const apiGet    = <T = any>(path: string) => request<T>('GET', path);
export const apiPost   = <T = any>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
export const apiPut    = <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {});
export const apiDelete = <T = any>(path: string) => request<T>('DELETE', path);

/** SWR fetcher. */
export const fetcher = <T = any>(path: string) => apiGet<T>(path);

/** Appends a branch filter when one is active, so pages don't hand-build query strings. */
export function withBranch(path: string, branchId: string | null): string {
  if (!branchId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}branch_id=${branchId}`;
}

/** Authenticated download (invoice PDFs). A plain <a href> cannot carry the
 *  bearer token, so the file is fetched and handed to the browser as a blob. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(activeBranchHeader ? { 'X-Branch-Id': activeBranchHeader } : {}),
    },
  });
  if (res.status === 401) { clearStoredSession(); onUnauthorized?.(); throw new ApiError(401, 'Your session has ended.'); }
  if (!res.ok) {
    let message = 'Could not download that file.';
    try { message = (await res.json()).error ?? message; } catch { /* keep default */ }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Opens an authenticated PDF in a new tab so the browser's own viewer handles
 *  preview and print — a plain <a href> can't carry the bearer token, same as
 *  downloadFile above. Used for "Print" actions rather than triggering a blind
 *  window.print(), so the cashier sees the document before committing paper. */
export async function printFile(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(activeBranchHeader ? { 'X-Branch-Id': activeBranchHeader } : {}),
    },
  });
  if (res.status === 401) { clearStoredSession(); onUnauthorized?.(); throw new ApiError(401, 'Your session has ended.'); }
  if (!res.ok) {
    let message = 'Could not open that document.';
    try { message = (await res.json()).error ?? message; } catch { /* keep default */ }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  // Some browsers block window.open from an async callback; falling back to a
  // download keeps the action useful rather than silently doing nothing.
  if (!win) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Builds a wa.me link that opens WhatsApp (web or app) with a pre-filled
 * message — the safe fallback the spec calls for when the WhatsApp Business
 * API isn't configured with live credentials. This never sends anything on
 * its own: it only opens WhatsApp for the user to press send themselves, and
 * it carries no PDF attachment (wa.me cannot attach files) — the message
 * points the recipient at what was actually finalized, nothing is claimed
 * beyond that.
 */
export function whatsappShareUrl(phone: string | null | undefined, message: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 8) return null;
  // Indian mobile numbers are stored as 10 digits without a country code;
  // wa.me needs the full international number.
  const withCountry = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(message)}`;
}

/** A monetary amount in words is printed server-side; this formats a quantity with its unit. */
export function qtyWithUnit(qty: number | string | null | undefined, unit: string | null | undefined): string {
  const n = Number(qty ?? 0);
  const shown = Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 4 }) : '0';
  return unit ? `${shown} ${unit}` : shown;
}

/** Turns rows into a CSV download, used by every export button. */
export function downloadCsv(rows: Record<string, unknown>[], filename: string): void {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Spreadsheet formula injection: a cell that starts with = + @ (or a tab/CR,
    // or a "-" that is not a number) would run as a formula when the file is
    // opened in Excel. Such text is prefixed with an apostrophe; numbers are left alone.
    if (typeof v !== 'number' && (/^[=+@\t\r]/.test(s) || /^-(?![\d.])/.test(s))) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ── Formatting helpers, shared so every screen renders money the same way ────
export function inr(value: number | string | null | undefined, opts: { decimals?: boolean } = {}): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  const digits = opts.decimals ? 2 : 0;
  const body = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // The sign goes before the currency symbol (−₹20.00), and a value that rounds to
  // zero is never shown as "−₹0".
  return (n < 0 && Number(body.replace(/,/g, '')) !== 0 ? '−₹' : '₹') + body;
}

/** Compact money for chart axes and tiles: ₹1.2L, ₹3.4Cr — the units Indian
 *  retail actually reads, rather than ₹120,000. */
export function inrCompact(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1e3) return `₹${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `₹${Math.round(n)}`;
}

export function num(value: number | string | null | undefined, dp = 2): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-IN', { maximumFractionDigits: dp });
}

/**
 * Dates are shown in the BUSINESS timezone, not the browser's: a bill made at
 * 11:45 pm in Mumbai belongs to that day on every screen, including the owner's
 * laptop abroad. Configurable for a business outside India.
 */
export const BUSINESS_TIMEZONE = process.env.NEXT_PUBLIC_BUSINESS_TIMEZONE || 'Asia/Kolkata';

/** A calendar date ("2026-10-01") is not an instant; parsing it as one shifts it a day west of UTC. */
function asInstant(value: string | Date): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00Z`);
  return new Date(value);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = asInstant(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: BUSINESS_TIMEZONE });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = asInstant(value);
  if (Number.isNaN(d.getTime())) return '—';
  const yearOf = (x: Date) => x.toLocaleDateString('en-IN', { year: 'numeric', timeZone: BUSINESS_TIMEZONE });
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TIMEZONE,
    // The year only when it is not this year — "12 Mar, 4:10 pm" is ambiguous a year later.
    ...(yearOf(d) !== yearOf(new Date()) ? { year: 'numeric' as const } : {}),
  });
}

/** Today's date in the business timezone, as YYYY-MM-DD (for date inputs and defaults). */
export function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const dys = Math.round(hours / 24);
  if (dys < 30) return `${dys}d ago`;
  return formatDate(value);
}
