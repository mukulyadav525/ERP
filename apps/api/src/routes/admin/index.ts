// ============================================================================
// Section 17 — Admin Control Panel
// Every ⚙ setting from the requirements' consolidated table, chain-wide or
// per-branch, plus the audit log (7.3), backups (15) and training journals (16).
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, oneOf, limit as clampLimit,
} from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { SETTING_DEFAULTS, loadSettings } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { BUSINESS_PROFILE_SETTING, normaliseProfile } from '../../lib/pdf/index.js';
import { GST_STATES, optionalGstin, optionalStateCode } from '../../lib/units.js';

function branchCode(v: unknown): string {
  const code = str(v, 'Branch code', { max: 6 }).toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code)) throw badRequest('A branch code is 2–6 capital letters or digits, e.g. AND or PUN1. It appears in every document number.');
  return code;
}

/**
 * The catalogue the Admin Settings screen renders from. Keeping the labels, types
 * and allowed values here — rather than hard-coded in the UI — means adding a
 * setting is a one-file change and the form cannot drift from what the API accepts.
 */
const SETTING_META: Record<string, {
  label: string; group: string; type: 'boolean' | 'number' | 'select' | 'json';
  options?: { value: string; label: string }[];
  help: string; per_branch: boolean; min?: number; max?: number;
}> = {
  multi_unit_sale_per_item:   { label: 'Multi-unit sale per item', group: 'Catalog', type: 'boolean', per_branch: false,
    help: 'Allow selling in boxes, reels or cut lengths as well as the base unit.',
  },
  enable_tinting_records:     { label: 'Paint tinting records', group: 'Catalog', type: 'boolean', per_branch: false,
    help: 'Record the base shade and tint formula on a paint sale so the colour can be reproduced later.',
  },
  enable_bundles:             { label: 'Product bundles / kits', group: 'Catalog', type: 'boolean', per_branch: false,
    help: 'Sell pre-defined kits (plumbing repair kit, tool set) as a single line.',
  },
  allow_branch_price_override:{ label: 'Branch price override', group: 'Catalog', type: 'boolean', per_branch: true,
    help: 'Off means one price chain-wide. On lets a branch set its own price, falling back to the chain price when unset.',
  },
  branch_manager_cost_visibility: { label: 'Branch Manager sees cost', group: 'Catalog', type: 'boolean', per_branch: true,
    help: 'Purchase cost and margin are Owner-only by default. Turn on to let a Branch Manager see their own branch\'s costs.',
  },
  default_item_price_type:    { label: 'Default price type', group: 'Catalog', type: 'select', per_branch: false,
    options: [{ value: 'TAX_INCLUSIVE', label: 'Tax inclusive (retail)' }, { value: 'TAX_EXCLUSIVE', label: 'Tax exclusive (B2B)' }],
    help: 'Whether a catalog price already contains GST. Retail counter prices normally do; quoted B2B rates normally do not.',
  },
  fractional_unit_rounding_dp:{ label: 'Fractional unit rounding (dp)', group: 'Catalog', type: 'number', per_branch: false, min: 0, max: 4,
    help: 'Decimal places for cut-to-length quantities. Fixed at 2 to match the GST rounding rule.',
  },

  staff_discount_limit_pct:   { label: 'Staff discount limit (%)', group: 'Billing', type: 'number', per_branch: true, min: 0, max: 100,
    help: 'Above this, a bill needs a manager PIN to approve.',
  },
  allow_negative_stock:       { label: 'Allow negative stock', group: 'Billing', type: 'boolean', per_branch: true,
    help: 'Off blocks a sale when system stock is zero. On lets it through with a manager PIN when the shelf disagrees with the system.',
  },
  require_barcode_at_billing: { label: 'Require barcode at billing', group: 'Billing', type: 'boolean', per_branch: true,
    help: 'Off keeps fuzzy catalog search as the default lookup. Turning this on is not recommended — it defeats the search.',
  },
  offline_sync_conflict_rule: { label: 'Offline conflict rule', group: 'Billing', type: 'select', per_branch: false,
    options: [{ value: 'FIRST_TO_CLOUD_WINS', label: 'First to reach the cloud wins; later ones are flagged' },
              { value: 'BLOCK_ALL_CONFLICTS', label: 'Block and require manual reconciliation' }],
    help: 'What happens when two branches sell the same last unit while one is offline.',
  },

  enable_batch_tracking:      { label: 'Batch tracking', group: 'Inventory', type: 'boolean', per_branch: false,
    help: 'Track batch numbers and expiry for shelf-life-sensitive stock (paint, adhesives, chemicals, batteries).',
  },
  valuation_method:           { label: 'Stock valuation', group: 'Inventory', type: 'select', per_branch: false,
    options: [{ value: 'WEIGHTED_AVERAGE', label: 'Weighted average' }, { value: 'FIFO', label: 'FIFO' }],
    help: 'Weighted average is simpler when the same item is restocked at different prices. Existing stock keeps its current cost if you switch.',
  },

  enable_quotations_module:   { label: 'Quotations module', group: 'Quotations', type: 'boolean', per_branch: true,
    help: 'Turns the quotations and delivery challan screens on.',
  },
  quotation_stock_reservation:{ label: 'Reserve stock on quotes', group: 'Quotations', type: 'boolean', per_branch: true,
    help: 'Off keeps a quote a pure estimate. On holds the quoted quantity when a quote is approved.',
  },
  quotation_hold_days:        { label: 'Reservation hold (days)', group: 'Quotations', type: 'number', per_branch: true, min: 1, max: 90,
    help: 'How long reserved stock is held before it releases back to sellable.',
  },

  allow_offline_credit_sales: { label: 'Offline credit sales', group: 'Credit', type: 'select', per_branch: false,
    options: [{ value: 'CAP_50_PCT', label: 'Cap at 50% of last-known available limit' },
              { value: 'HARD_BLOCK', label: 'Block credit sales while offline' }],
    help: 'An offline till cannot confirm a live balance, so credit is drawn conservatively against the cached figure.',
  },

  business_profile:           { label: 'Business profile (printed documents)', group: 'Documents', type: 'json', per_branch: true,
    help: 'Name, logo, address, GSTIN, bank and UPI details, declaration, terms and signature label printed on invoices, cash memos and estimates. A branch may override the chain-wide profile with its own letterhead and bank account.',
  },
  login_method_by_role:       { label: 'Login method by role', group: 'Security', type: 'json', per_branch: false,
    help: 'Google for Owner/Manager and phone+PIN for shop-floor staff by default.',
  },
  otp_expiry_minutes:         { label: 'OTP expiry (minutes)', group: 'Security', type: 'number', per_branch: false, min: 1, max: 60,
    help: 'How long a one-time code stays valid.',
  },
  pin_max_attempts:           { label: 'Failed attempts before lockout', group: 'Security', type: 'number', per_branch: false, min: 1, max: 10,
    help: 'Consecutive wrong password/PIN/OTP entries before the account locks.',
  },
  lockout_minutes:            { label: 'Lockout duration (minutes)', group: 'Security', type: 'number', per_branch: false, min: 1, max: 1440,
    help: 'How long an account stays locked after too many failed attempts.',
  },
  session_timeout_minutes:    { label: 'Session timeout (minutes)', group: 'Security', type: 'number', per_branch: false, min: 15, max: 10080,
    help: 'How long a login lasts before the user must sign in again.',
  },

  allow_loyalty_discount_stacking: { label: 'Stack loyalty with discount', group: 'Loyalty', type: 'boolean', per_branch: false,
    help: 'Off means a customer uses points OR a discount, not both, which keeps margin predictable.',
  },
  loyalty_earn_points_per_100:{ label: 'Points earned per ₹100', group: 'Loyalty', type: 'number', per_branch: false, min: 0, max: 100,
    help: 'Points added for every ₹100 actually paid in money (points spent do not earn points).',
  },
  loyalty_point_value_rupees: { label: 'Value of 1 point (₹)', group: 'Loyalty', type: 'number', per_branch: false, min: 0, max: 100,
    help: 'What one point is worth when redeemed.',
  },
  loyalty_point_expiry_days:  { label: 'Point expiry (days)', group: 'Loyalty', type: 'number', per_branch: false, min: 30, max: 3650,
    help: 'Points lapse after this long with no activity.',
  },
  enable_birthday_greetings:  { label: 'Birthday greetings', group: 'Loyalty', type: 'boolean', per_branch: false,
    help: 'Allow the "send birthday greetings" action for customers whose date of birth is on file. Messages go only when someone runs it.',
  },
  auto_whatsapp_documents:    { label: 'Queue bills and credit notes for WhatsApp automatically', group: 'Loyalty', type: 'boolean', per_branch: true,
    help: 'Off: bills are shared from the screen by the cashier. On: every finalised bill and credit note for a customer with a phone number is queued for the WhatsApp Business API — which must be configured, or nothing is sent.',
  },

  refund_method:              { label: 'Refund method', group: 'Returns', type: 'select', per_branch: false,
    options: [{ value: 'ADMIN_CHOICE', label: 'Decide per transaction' }, { value: 'CASH', label: 'Always cash' },
              { value: 'ORIGINAL_MODE', label: 'Always the original payment mode' }, { value: 'STORE_CREDIT', label: 'Always store credit' }],
    help: 'How a refund is paid back. Points are always returned as points first, whatever this is set to.',
  },
  return_window_days:         { label: 'Return window (days)', group: 'Returns', type: 'number', per_branch: false, min: 0, max: 365,
    help: 'Chain-wide default. Individual categories can override it.',
  },

  expense_approval_threshold: { label: 'Expense approval threshold (₹)', group: 'Expenses', type: 'number', per_branch: true, min: 0,
    help: 'Expenses at or below this, entered by a manager, are approved automatically.',
  },
  attendance_method:          { label: 'Attendance method', group: 'HR', type: 'select', per_branch: true,
    options: [{ value: 'APP_CHECKIN', label: 'In-app check-in' }, { value: 'BIOMETRIC', label: 'Biometric device' },
              { value: 'MANUAL', label: 'Manual manager entry' }],
    help: 'How staff attendance is captured at this branch.',
  },
  enable_payroll_module:      { label: 'Payroll module', group: 'HR', type: 'boolean', per_branch: false,
    help: 'A simple salary register tied to attendance. Off in Phase 1.',
  },

  backup_frequency_hours:     { label: 'Backup frequency (hours)', group: 'Compliance', type: 'number', per_branch: false, min: 1, max: 168,
    help: 'How often an automatic cloud backup is taken.',
  },
  einvoice_enabled:           { label: 'E-invoicing (IRN)', group: 'Compliance', type: 'boolean', per_branch: false,
    help: 'Turn on once turnover crosses the e-invoicing threshold. Invoices then carry an IRN.' },
  };

export default async function adminRoutes(app: FastifyInstance) {
  /** The whole settings screen in one call: definition, default, and the effective
   *  value at chain level and (optionally) at one branch. */
  app.get('/settings', guarded('view_admin', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = q.branch_id ? uuid(q.branch_id, 'branch_id') : null;

    const rows = (await sql<any>`
      SELECT s.setting_key, s.branch_id, s.value, s.updated_at, u.full_name AS updated_by_name
        FROM admin_settings s LEFT JOIN users u ON u.user_id = s.updated_by
       WHERE s.branch_id IS NULL ${branchId ? sql`OR s.branch_id = ${branchId}` : sql``}
    `.execute(trx)).rows;

    const chain = new Map(rows.filter((r: any) => !r.branch_id).map((r: any) => [r.setting_key, r]));
    const branch = new Map(rows.filter((r: any) => r.branch_id).map((r: any) => [r.setting_key, r]));

    return Object.entries(SETTING_META).map(([key, meta]) => {
      const chainRow = chain.get(key);
      const branchRow = branch.get(key);
      return {
        key, ...meta,
        default_value: (SETTING_DEFAULTS as any)[key],
        chain_value: chainRow ? chainRow.value : (SETTING_DEFAULTS as any)[key],
        branch_value: branchRow ? branchRow.value : null,
        // What actually applies right now, after the branch → chain → default cascade.
        effective_value: branchRow ? branchRow.value
                        : chainRow ? chainRow.value
                        : (SETTING_DEFAULTS as any)[key],
        is_overridden_at_branch: Boolean(branchRow),
        updated_at: (branchRow ?? chainRow)?.updated_at ?? null,
        updated_by_name: (branchRow ?? chainRow)?.updated_by_name ?? null,
      };
    });
  }));

  /** The resolved values any screen can read — no admin permission needed, since
   *  a cashier's billing screen has to know the discount limit to enforce it. */
  app.get('/settings/effective', guarded(null, async ({ session, db: trx, req }) => {
    const branchId = optionalUuid((req.query as any)?.branch_id, 'branch_id') ?? session.branch_id;
    return loadSettings(trx, branchId);
  }));

  app.put('/settings/:key', guarded('manage_settings', async ({ session, db: trx, req }) => {
    const key = str((req.params as any).key, 'Setting key', { max: 80 });
    const meta = SETTING_META[key];
    if (!meta) throw badRequest(`"${key}" is not a known setting.`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = optionalUuid(body.branch_id, 'branch_id');
    if (branchId && !meta.per_branch) {
      throw badRequest(`"${meta.label}" is a chain-wide setting and cannot be overridden per branch.`);
    }

    // Validate against the setting's own declared type, so a typo cannot write a
    // string into a numeric setting and break billing at some later moment.
    let value = body.value;
    switch (meta.type) {
      case 'boolean':
        if (typeof value !== 'boolean') throw badRequest(`"${meta.label}" must be true or false.`);
        break;
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) throw badRequest(`"${meta.label}" must be a number.`);
        if (meta.min !== undefined && n < meta.min) throw badRequest(`"${meta.label}" must be at least ${meta.min}.`);
        if (meta.max !== undefined && n > meta.max) throw badRequest(`"${meta.label}" must be at most ${meta.max}.`);
        value = n;
        break;
      }
      case 'select': {
        const allowed = (meta.options ?? []).map((o) => o.value);
        if (typeof value !== 'string' || !allowed.includes(value)) {
          throw badRequest(`"${meta.label}" must be one of: ${allowed.join(', ')}.`);
        }
        break;
      }
      case 'json':
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw badRequest(`"${meta.label}" must be an object.`);
        }
        if (key === BUSINESS_PROFILE_SETTING) {
          // The name is checked on the RAW input, before normalising. Normalising
          // substitutes a default for a blank name — correct when rendering a
          // document, wrong here, where it would quietly accept a profile the
          // admin thought they had filled in and replace the shop's identity with
          // placeholder text on every future invoice.
          const raw = value as Record<string, unknown>;
          if (!('name' in raw) || typeof raw.name !== 'string' || !raw.name.trim()) {
            throw badRequest('The business profile needs a name — it is printed at the top of every document.');
          }
          // This is a whole-document replace, like every other setting, so the
          // client must send the complete profile rather than a patch.
          value = normaliseProfile(value) as unknown as Record<string, unknown>;
        }
        break;
    }

    const before = (await sql<any>`
      SELECT value FROM admin_settings WHERE setting_key = ${key}
        AND branch_id IS NOT DISTINCT FROM ${branchId}
    `.execute(trx)).rows[0];

    await sql`
      INSERT INTO admin_settings (setting_key, branch_id, value, updated_by)
      VALUES (${key}, ${branchId}, ${JSON.stringify(value)}::jsonb, ${session.user_id})
      ON CONFLICT (setting_key, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
      DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
    `.execute(trx);

    await audit(trx, session, 'SETTING_CHANGE', 'admin_settings', null,
      { before: { key, value: before?.value }, after: { key, value, branch_id: branchId } });
    return { ok: true, key, value, branch_id: branchId };
  }));

  /** Removes a branch override so the branch falls back to the chain-wide value. */
  app.delete('/settings/:key', guarded('manage_settings', async ({ session, db: trx, req }) => {
    const key = str((req.params as any).key, 'Setting key', { max: 80 });
    const branchId = uuid((req.query as any)?.branch_id, 'branch_id');
    await sql`DELETE FROM admin_settings WHERE setting_key = ${key} AND branch_id = ${branchId}`.execute(trx);
    await audit(trx, session, 'SETTING_CHANGE', 'admin_settings', null, { after: { key, branch_id: branchId, removed: true } });
    return { ok: true };
  }));

  // ── Audit log (7.3) ───────────────────────────────────────────────────────
  app.get('/audit-log', guarded('view_audit_log', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const dateOk = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
    return (await sql<any>`
      SELECT a.*, u.full_name AS user_name, u.role AS user_role, b.name AS branch_name
        FROM audit_log a
        LEFT JOIN users u ON u.user_id = a.user_id
        LEFT JOIN branches b ON b.branch_id = a.branch_id
       WHERE 1=1
         ${q.action ? sql`AND a.action = ${str(q.action, 'action', { max: 60 })}` : sql``}
         ${q.entity_type ? sql`AND a.entity_type = ${str(q.entity_type, 'entity_type', { max: 60 })}` : sql``}
         ${q.entity_id ? sql`AND a.entity_id = ${uuid(q.entity_id, 'entity_id')}` : sql``}
         ${q.user_id ? sql`AND a.user_id = ${uuid(q.user_id, 'user_id')}` : sql``}
         ${q.branch_id ? sql`AND a.branch_id = ${uuid(q.branch_id, 'branch_id')}` : sql``}
         ${dateOk(q.from) ? sql`AND a.created_at >= ${q.from}::date` : sql``}
         ${dateOk(q.to) ? sql`AND a.created_at < (${q.to}::date + 1)` : sql``}
       ORDER BY a.created_at DESC LIMIT ${clampLimit(q.limit, 100, 5000)}
    `.execute(trx)).rows;
  }));

  app.get('/audit-log/actions', guarded('view_audit_log', async ({ db: trx }) =>
    (await sql<any>`
      SELECT action, COUNT(*) AS count FROM audit_log
       WHERE created_at >= now() - interval '90 days' GROUP BY action ORDER BY count DESC
    `.execute(trx)).rows));

  // ── Overview tiles ────────────────────────────────────────────────────────
  app.get('/overview', guarded('view_admin', async ({ db: trx }) => {
    const [counts, pending] = await Promise.all([
      sql<any>`
        SELECT
          (SELECT count(*) FROM branches WHERE is_active) AS branch_count,
          (SELECT count(*) FROM users WHERE is_active) AS active_user_count,
          (SELECT count(*) FROM products WHERE is_active) AS active_product_count,
          (SELECT count(*) FROM customers) AS customer_count,
          (SELECT count(*) FROM vendors WHERE is_active) AS vendor_count,
          (SELECT count(*) FROM till_sessions WHERE status = 'OPEN') AS open_till_sessions
      `.execute(trx),
      sql<any>`
        SELECT
          (SELECT count(*) FROM registration_requests WHERE status = 'PENDING') AS pending_registrations,
          (SELECT count(*) FROM expenses WHERE status = 'PENDING') AS pending_expenses,
          (SELECT count(*) FROM stock_transfers WHERE status = 'TRANSFER_DISCREPANCY') AS transfer_discrepancies,
          (SELECT count(*) FROM stock_conflicts WHERE status = 'OPEN') AS open_stock_conflicts,
          (SELECT count(*) FROM leave_requests WHERE status = 'PENDING') AS pending_leave,
          (SELECT count(*) FROM whatsapp_message_log WHERE status = 'FAILED') AS failed_messages
      `.execute(trx),
    ]);
    return { ...counts.rows[0], ...pending.rows[0] };
  }));

  // ── Branches ──────────────────────────────────────────────────────────────
  app.get('/branches', guarded('view_admin', async ({ db: trx }) =>
    (await sql<any>`
      SELECT b.*,
             (SELECT count(*) FROM users WHERE branch_id = b.branch_id AND is_active) AS staff_count,
             (SELECT count(*) FROM branch_stock WHERE branch_id = b.branch_id) AS sku_count
        FROM branches b ORDER BY b.name
    `.execute(trx)).rows));

  app.post('/branches', guarded('manage_settings', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stateCode = optionalStateCode(body.state_code, 'State');
    if (!stateCode) throw badRequest('Choose the state the branch is in — it decides CGST+SGST against IGST.');
    const gstin = optionalGstin(body.gstin);
    if (gstin && gstin.slice(0, 2) !== stateCode) throw badRequest('The GSTIN belongs to a different state than the one chosen.');
    const code = branchCode(body.code);
    const dup = (await sql<any>`SELECT name FROM branches WHERE code = ${code}`.execute(trx)).rows[0];
    if (dup) throw badRequest(`Branch code ${code} is already used by ${dup.name}.`);
    const row = (await sql<any>`
      INSERT INTO branches (code, name, address, state, state_code, gstin, phone, email)
      VALUES (${code}, ${str(body.name, 'Branch name', { max: 120 })},
              ${optionalStr(body.address, 'Address', { max: 500 })},
              ${GST_STATES[stateCode]}, ${stateCode}, ${gstin},
              ${optionalStr(body.phone, 'Phone', { max: 20 })},
              ${optionalStr(body.email, 'Email', { max: 254 })})
      RETURNING *
    `.execute(trx)).rows[0];
    await audit(trx, session, 'SETTING_CHANGE', 'branches', row.branch_id, { after: row });
    return row;
  }));

  app.put('/branches/:id', guarded('manage_settings', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'branch_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM branches WHERE branch_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Branch not found.');
    const stateCode = body.state_code === undefined ? before.state_code : (optionalStateCode(body.state_code, 'State') ?? before.state_code);
    const gstin = body.gstin === undefined ? before.gstin : optionalGstin(body.gstin);
    if (gstin && /^[0-9]{2}$/.test(stateCode) && gstin.slice(0, 2) !== stateCode) {
      throw badRequest('The GSTIN belongs to a different state than the branch.');
    }
    // The code is printed on every document the branch has ever issued; changing it
    // would make new numbers look like a different branch's. Set once.
    if (body.code !== undefined && branchCode(body.code) !== before.code) {
      throw badRequest('A branch code cannot be changed once set — it is part of every document number the branch has issued.');
    }
    if (body.is_active === false && before.is_active) {
      const open = (await sql<{ n: string }>`
        SELECT (SELECT count(*) FROM till_sessions WHERE branch_id = ${id} AND status = 'OPEN')
             + (SELECT count(*) FROM stock_transfers WHERE (from_branch_id = ${id} OR to_branch_id = ${id})
                                                     AND status IN ('REQUESTED', 'DISPATCHED', 'TRANSFER_DISCREPANCY')) AS n
      `.execute(trx)).rows[0];
      if (Number(open.n) > 0) throw badRequest('Close the branch\'s open tills and settle its transfers before deactivating it.');
    }
    await sql`
      UPDATE branches SET
        name = ${optionalStr(body.name, 'Branch name', { max: 120 }) ?? before.name},
        address = ${body.address === undefined ? before.address : optionalStr(body.address, 'Address', { max: 500 })},
        state_code = ${stateCode}, state = ${GST_STATES[stateCode] ?? before.state},
        gstin = ${gstin},
        phone = ${body.phone === undefined ? before.phone : optionalStr(body.phone, 'Phone', { max: 20 })},
        email = ${body.email === undefined ? before.email : optionalStr(body.email, 'Email', { max: 254 })},
        is_active = ${body.is_active === undefined ? before.is_active : Boolean(body.is_active)}
      WHERE branch_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'SETTING_CHANGE', 'branches', id, { before, after: body });
    return { ok: true };
  }));

  // ── Backups (15) ──────────────────────────────────────────────────────────
  /**
   * Backup STATUS, read-only. Backups and restore tests are performed by the
   * scripts in apps/api/scripts (backup.mjs / restore-test.mjs), which run
   * pg_dump / pg_restore and record only what they verified. There is no endpoint
   * that can claim a backup was taken, because a claimed backup is not a backup.
   */
  app.get('/backups', guarded('cloud_backup_restore', async ({ session, db: trx, req }) => {
    const rows = (await sql<any>`
      SELECT * FROM backups ORDER BY taken_at DESC LIMIT ${clampLimit((req.query as any)?.limit, 50, 200)}
    `.execute(trx)).rows;
    const settings = await loadSettings(trx, session.branch_id);
    const everyHours = Number(settings.backup_frequency_hours) || 24;
    const lastOk = rows.find((r: any) => r.status === 'COMPLETED');
    const lastTested = rows.find((r: any) => r.restore_tested_at);
    const ageHours = lastOk ? (Date.now() - new Date(lastOk.taken_at).getTime()) / 3_600_000 : null;
    return {
      backups: rows,
      configured: Boolean(lastOk),
      status: !lastOk ? 'NOT_CONFIGURED' : ageHours! > everyHours * 2 ? 'OVERDUE' : 'OK',
      expected_every_hours: everyHours,
      last_backup_at: lastOk?.taken_at ?? null,
      last_backup_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      last_restore_test_at: lastTested?.restore_tested_at ?? null,
      // 15 asks for a *documented* disaster-recovery test, not just backups that
      // exist — an untested backup is a guess, so this is surfaced, not buried.
      restore_test_overdue: !lastTested
        || (Date.now() - new Date(lastTested.restore_tested_at).getTime()) > 90 * 86_400_000,
      how_to: 'Schedule `npm run backup` (daily) and `npm run backup:restore-test` (monthly) on the server. See docs/OPERATIONS.md.',
    };
  }));

  // ── Training journals (16) ────────────────────────────────────────────────
  app.get('/training-journals', guarded(null, async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    // Staff see the staff journal; only the Owner sees the admin one.
    const type = q.journal_type
      ? oneOf(q.journal_type, 'journal_type', ['ADMIN', 'STAFF'] as const)
      : (session.role === 'OWNER_ADMIN' ? null : 'STAFF');
    return (await sql<any>`
      SELECT * FROM training_journals
       WHERE 1=1
         ${type ? sql`AND journal_type = ${type}` : sql``}
         ${session.role === 'OWNER_ADMIN' ? sql`` : sql`AND journal_type = 'STAFF'`}
         AND language = COALESCE(${q.language ?? null}, ${session.language_pref ?? 'en'})
       ORDER BY journal_type, version DESC
    `.execute(trx)).rows;
  }));

  app.post('/training-journals', guarded('manage_settings', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = oneOf(body.journal_type, 'Journal type', ['ADMIN', 'STAFF'] as const);
    const language = oneOf(body.language, 'Language', ['en', 'hi'] as const);
    // Versioned, never overwritten, so the two journals stay in step with the
    // features they describe (16).
    const next = Number((await sql<any>`
      SELECT COALESCE(MAX(version), 0) + 1 AS v FROM training_journals
       WHERE journal_type = ${type} AND language = ${language}
    `.execute(trx)).rows[0].v);
    // A link every staff member will click: only a path on this site or an https
    // address — never javascript:, data: or the like.
    const url = str(body.content_url, 'Content URL', { max: 500 });
    if (!/^\/(?!\/)[\w\-./]+$/.test(url) && !/^https:\/\/[^\s"'<>]+$/i.test(url)) {
      throw badRequest('The guide link must be a path on this site (e.g. /docs/guide.md) or an https:// address.');
    }
    return (await sql<any>`
      INSERT INTO training_journals (journal_type, language, version, content_url)
      VALUES (${type}, ${language}, ${next}, ${url})
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  // ── Category return windows (12.3) ────────────────────────────────────────
  app.put('/return-windows/:categoryId', guarded('manage_settings', async ({ db: trx, req }) => {
    const categoryId = uuid((req.params as any).categoryId, 'category_id');
    const dayCount = Number((req.body as any)?.window_days);
    if (!Number.isInteger(dayCount) || dayCount < 0 || dayCount > 365) {
      throw badRequest('The return window must be a whole number of days between 0 and 365.');
    }
    await sql`
      INSERT INTO return_windows (category_id, window_days) VALUES (${categoryId}, ${dayCount})
      ON CONFLICT (category_id) DO UPDATE SET window_days = EXCLUDED.window_days
    `.execute(trx);
    return { ok: true };
  }));

  // ── Warranty terms (12.2) ─────────────────────────────────────────────────
  app.get('/warranties', guarded('view_admin', async ({ db: trx }) =>
    (await sql<any>`
      SELECT w.*, p.name AS product_name, c.name AS category_name
        FROM warranties w
        LEFT JOIN products p ON p.product_id = w.product_id
        LEFT JOIN categories c ON c.category_id = w.category_id
       ORDER BY c.name NULLS LAST, p.name NULLS LAST
    `.execute(trx)).rows));

  app.post('/warranties', guarded('manage_settings', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const productId = optionalUuid(body.product_id, 'product_id');
    const categoryId = optionalUuid(body.category_id, 'category_id');
    if (!productId && !categoryId) throw badRequest('Choose a product or a category for this warranty term.');
    const months = Number(body.duration_months);
    if (!Number.isInteger(months) || months < 1 || months > 600) {
      throw badRequest('The warranty period must be a whole number of months.');
    }
    return (await sql<any>`
      INSERT INTO warranties (product_id, category_id, duration_months)
      VALUES (${productId}, ${categoryId}, ${months}) RETURNING *
    `.execute(trx)).rows[0];
  }));
}
