// ============================================================================
// The business identity that appears on every printed document (Section 65).
//
// Nothing here is hard-coded to one shop. The name, logo, GSTIN, bank details,
// declaration, terms and signature label all come from the admin settings, which
// means the same binary prints correct documents for every branch of the chain —
// and a wrong GSTIN on a tax invoice is a compliance problem, not a cosmetic one.
//
// It lives in `admin_settings` rather than in its own table on purpose: that
// table is already branch-overridable, already permission-gated behind
// `manage_settings`, and already audited on change. A branch that has its own
// letterhead and bank account overrides the chain-wide profile; one that does
// not inherits it.
// ============================================================================
import { sql } from 'kysely';
import type { Tx } from '../db.js';
import type { BusinessProfile } from './renderer.js';

export const BUSINESS_PROFILE_SETTING = 'business_profile';

/**
 * The shipped default. Written to be obviously a placeholder in the fields that
 * MUST be the shop's own (GSTIN, bank) rather than quietly plausible, so an
 * unconfigured install cannot print a document that looks official and isn't.
 */
export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  name: 'BHAWANI ONE',
  legal_name: null,
  tagline: 'Smart Business Management System',
  dealing_in: 'Paints • Plumbing • Electrical • Hardware • Sanitaryware • Tools',
  address: null,
  city_state: null,
  phone: null,
  alt_phone: null,
  email: null,
  website: null,
  gstin: null,
  state: null,
  state_code: null,
  logo: null,
  bank_name: null,
  bank_branch: null,
  bank_account_no: null,
  bank_ifsc: null,
  upi_id: null,
  declaration:
    'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
  terms: [
    'Goods once sold will not be taken back or exchanged after the return window.',
    'Interest is chargeable on bills not settled within the agreed credit period.',
    'Warranty, where applicable, is as offered by the manufacturer.',
  ],
  signature_label: 'Authorised Signatory',
  footer_note: null,
  jurisdiction: null,
};

/** Fields a caller is allowed to set. Anything else in the JSON is ignored. */
const STRING_FIELDS = [
  'name', 'legal_name', 'tagline', 'dealing_in', 'address', 'city_state', 'phone', 'alt_phone',
  'email', 'website', 'gstin', 'state', 'state_code', 'logo', 'bank_name', 'bank_branch',
  'bank_account_no', 'bank_ifsc', 'upi_id', 'declaration', 'signature_label', 'footer_note',
  'jurisdiction',
] as const;

/**
 * Normalises whatever is stored into a profile the renderer can trust.
 *
 * Settings are JSON, so the stored value can be anything a previous version — or
 * a mistaken PUT — left behind. Rather than letting a malformed profile turn
 * every invoice into a 500, unknown keys are dropped, non-strings are coerced or
 * discarded, and anything missing falls back to the default.
 */
export function normaliseProfile(raw: unknown): BusinessProfile {
  const out: BusinessProfile = { ...DEFAULT_BUSINESS_PROFILE };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;

  for (const key of STRING_FIELDS) {
    const v = src[key];
    if (typeof v === 'string' && v.trim()) {
      (out as unknown as Record<string, unknown>)[key] = v.trim();
    } else if (v === null) {
      (out as unknown as Record<string, unknown>)[key] = null;
    }
  }
  if (Array.isArray(src.terms)) {
    const terms = src.terms.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim()).slice(0, 8);
    out.terms = terms.length ? terms : DEFAULT_BUSINESS_PROFILE.terms;
  }
  // A name is the one field a document cannot be printed without.
  if (!out.name) out.name = DEFAULT_BUSINESS_PROFILE.name;

  // The logo is embedded, never read off the server's filesystem by path. A
  // stored path would make the setting a file-read primitive pointed at whatever
  // the API process can reach — a small thing, but there is no reason to hand it
  // out, and a data: URI is what the admin screen produces anyway.
  if (out.logo && !/^data:image\/(png|jpe?g);base64,/i.test(out.logo)) {
    out.logo = null;
  }
  return out;
}

/**
 * The effective profile for a branch: the branch override if it has one, else the
 * chain-wide row, else the shipped default — the same resolution order every
 * other setting uses.
 *
 * The branch's own address, phone, GSTIN and state are layered on top unless the
 * profile explicitly sets them, because those already live on the `branches` row
 * and having to retype them into a settings blob is how they end up disagreeing.
 */
export async function loadBusinessProfile(
  trx: Tx, branchId: string | null, branch?: Record<string, any> | null,
): Promise<BusinessProfile> {
  const rows = await sql<{ branch_id: string | null; value: unknown }>`
    SELECT branch_id, value FROM admin_settings
     WHERE setting_key = ${BUSINESS_PROFILE_SETTING}
       AND (branch_id IS NULL ${branchId ? sql`OR branch_id = ${branchId}` : sql``})
  `.execute(trx);

  const chain = rows.rows.find((r) => r.branch_id === null)?.value;
  const perBranch = rows.rows.find((r) => r.branch_id !== null)?.value;
  const profile = normaliseProfile({
    ...(chain && typeof chain === 'object' ? chain : {}),
    ...(perBranch && typeof perBranch === 'object' ? perBranch : {}),
  });

  if (branch) {
    // The branch row wins for the things it is authoritative about, so a document
    // always carries the GSTIN of the branch that actually issued it.
    profile.address = profile.address ?? branch.address ?? null;
    profile.phone = profile.phone ?? branch.phone ?? null;
    // GSTIN stays branch-first: a document must carry the GSTIN of the branch that
    // actually issued it, and a chain-wide profile cannot know which that is.
    profile.gstin = branch.gstin ?? profile.gstin ?? null;
    // The printed state code follows the profile when the admin has set one. The
    // branches table stores whatever the operator typed there ("MH"), which is
    // fine for deciding intra- vs inter-state, but a tax invoice is expected to
    // show the numeric GST state code ("27") — so an explicit setting wins.
    profile.state_code = profile.state_code ?? branch.state_code ?? null;
    // The branch name is the trading name customers know ("Andheri West"), so it
    // is shown as the location line rather than replacing the business name.
    if (branch.name && !profile.city_state) profile.city_state = branch.name;
  }
  return profile;
}

// ── The name to use in a message sent before there is a session ─────────────
/**
 * OTP and reset messages are sent to someone who is *not* signed in, so there is
 * no scoped transaction to read settings through, and no branch to resolve
 * against. They still must not carry a hard-coded product name: the whole point
 * of the configurable profile is that a shop's customers and staff see the shop's
 * name. This reads the chain-wide profile through the system scope (the same
 * mechanism the background workers use, for the same reason — RLS would otherwise
 * return nothing to a caller with no session) and falls back to the shipped name.
 *
 * Cached for a minute so a burst of sign-ins is one query, not one each.
 */
let nameCache: { value: string; at: number } | null = null;
/** The read in flight, shared so a burst of sign-ins makes one query rather than
 *  one per request — and so the cache is only ever written by the single
 *  resolution below, never by whichever caller happens to finish awaiting last. */
let namePending: Promise<string> | null = null;

export function chainDisplayName(): Promise<string> {
  const cached = nameCache;
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.value);
  if (namePending) return namePending;

  namePending = (async () => {
    const { withSystemScope } = await import('../db.js');
    const rows = await withSystemScope((trx) => sql<{ value: unknown }>`
      SELECT value FROM admin_settings
       WHERE setting_key = ${BUSINESS_PROFILE_SETTING} AND branch_id IS NULL
       LIMIT 1
    `.execute(trx));
    return normaliseProfile(rows.rows[0]?.value).name;
  })()
    .then((value) => {
      nameCache = { value, at: Date.now() };
      return value;
    })
    // A settings read must never be the reason a verification code is not sent.
    .catch(() => DEFAULT_BUSINESS_PROFILE.name)
    .finally(() => { namePending = null; });

  return namePending;
}
