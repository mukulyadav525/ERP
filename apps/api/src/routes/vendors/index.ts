// ============================================================================
// Section 8 — Vendor / Procurement Management (spec §27)
// The payables ledger is the mirror image of the customer credit ledger, and
// vendor performance analytics answer the two questions that actually change
// buying decisions: do they deliver on time, and is their price drifting?
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, bool, oneOf, limit as clampLimit, writeBranch,
} from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { loadSettings, canSeeCost } from '../../lib/settings.js';
import { postVendor, vendorBalance } from '../../lib/ledger.js';
import { nextNumber } from '../../lib/numbering.js';
import { round2 } from '../../lib/tax.js';
import { GST_STATES, optionalGstin, optionalStateCode } from '../../lib/units.js';
import { addDays, businessToday } from '../../lib/dates.js';

const PAY_METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optionalDateStr(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(new Date(s).getTime())) throw badRequest(`${field} must be a date.`);
  return s;
}

function vendorFields(body: Record<string, unknown>) {
  const stateCode = optionalStateCode(body.state_code, 'State');
  const gstin = optionalGstin(body.gstin);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) {
    throw badRequest(`The GSTIN is registered in state ${gstin.slice(0, 2)}, but the state chosen is ${stateCode}.`);
  }
  const phone = body.phone === undefined ? undefined : optionalStr(body.phone, 'Phone', { max: 20 });
  if (phone && !/^[0-9+\-\s]{8,20}$/.test(phone)) throw badRequest('Please enter a valid phone number.');
  const email = body.email === undefined ? undefined : optionalStr(body.email, 'Email', { max: 254 });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Please enter a valid email address.');
  const ifsc = body.bank_ifsc === undefined ? undefined : optionalStr(body.bank_ifsc, 'IFSC', { max: 11 });
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(ifsc)) throw badRequest('An IFSC code is 11 characters, e.g. HDFC0001234.');
  return {
    name: body.name === undefined ? undefined : str(body.name, 'Vendor name', { max: 150 }),
    contact_person: body.contact_person === undefined ? undefined : optionalStr(body.contact_person, 'Contact person', { max: 120 }),
    gstin: body.gstin === undefined ? undefined : gstin,
    phone, email: email === undefined ? undefined : (email ? email.toLowerCase() : null),
    address: body.address === undefined ? undefined : optionalStr(body.address, 'Address', { max: 500 }),
    state_code: body.state_code === undefined ? (gstin ? gstin.slice(0, 2) : undefined) : (stateCode ?? (gstin ? gstin.slice(0, 2) : null)),
    payment_terms_days: body.payment_terms_days === undefined ? undefined
      : body.payment_terms_days === null || body.payment_terms_days === '' ? null
      : num(body.payment_terms_days, 'Payment terms (days)', { min: 0, max: 365 }),
    bank_name: body.bank_name === undefined ? undefined : optionalStr(body.bank_name, 'Bank name', { max: 120 }),
    bank_account_no: body.bank_account_no === undefined ? undefined : optionalStr(body.bank_account_no, 'Account number', { max: 30 }),
    bank_ifsc: ifsc === undefined ? undefined : (ifsc ? ifsc.toUpperCase() : null),
    upi_id: body.upi_id === undefined ? undefined : optionalStr(body.upi_id, 'UPI ID', { max: 80 }),
    notes: body.notes === undefined ? undefined : optionalStr(body.notes, 'Notes', { max: 1000 }),
  };
}

export default async function vendorsRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_vendors', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const search = q.q?.trim().slice(0, 60);
    const digits = search?.replace(/\D/g, '') ?? '';
    // The payable is commercial detail: inventory staff see vendor names for a
    // goods receipt, but not what the shop owes them.
    const showMoney = ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'].includes(session.role);
    const rows = (await sql<any>`
      SELECT v.*, COALESCE(bal.balance_after, 0) AS balance_owed,
             (SELECT count(*) FROM grn WHERE vendor_id = v.vendor_id) AS grn_count,
             (SELECT max(received_at) FROM grn WHERE vendor_id = v.vendor_id) AS last_purchase_at
        FROM vendors v
        LEFT JOIN LATERAL (
            SELECT balance_after FROM vendor_ledger WHERE vendor_id = v.vendor_id
             ORDER BY created_at DESC, entry_id DESC LIMIT 1
        ) bal ON TRUE
       WHERE ${q.include_inactive === 'true' || q.status === 'all' ? sql`TRUE` : q.status === 'inactive' ? sql`NOT v.is_active` : sql`v.is_active`}
         ${search ? sql`AND (v.name ILIKE ${'%' + search + '%'} OR v.contact_person ILIKE ${'%' + search + '%'}
                             OR v.gstin ILIKE ${'%' + search + '%'}
                             ${digits.length >= 3 ? sql`OR v.phone LIKE ${'%' + digits + '%'}` : sql``})` : sql``}
         ${q.has_balance === 'true' ? sql`AND COALESCE(bal.balance_after, 0) > 0` : sql``}
       ORDER BY ${q.sort === 'balance' ? sql`COALESCE(bal.balance_after, 0) DESC,` : sql``} v.name
       LIMIT ${clampLimit(q.limit, 100, 300)}
    `.execute(trx)).rows;
    return showMoney ? rows : rows.map(({ balance_owed, opening_balance, ...r }: any) => r);
  }));

  app.get('/:id', guarded('view_vendors', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const settings = await loadSettings(trx, session.branch_id);
    const vendor = (await sql<any>`SELECT * FROM vendors WHERE vendor_id = ${id}`.execute(trx)).rows[0];
    if (!vendor) throw notFound('Vendor not found.');
    const showMoney = ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'].includes(session.role);
    const showCost = canSeeCost(session.role, settings);

    const [ledger, grns, products, payments, returns] = await Promise.all([
      showMoney ? sql<any>`
        SELECT vl.*, b.name AS branch_name,
               COALESCE(g.grn_number, vp.payment_number, dn.debit_note_number) AS reference
          FROM vendor_ledger vl
          LEFT JOIN branches b ON b.branch_id = vl.branch_id
          LEFT JOIN grn g ON vl.ref_table = 'grn' AND g.grn_id = vl.ref_id
          LEFT JOIN vendor_payments vp ON vl.ref_table = 'vendor_payments' AND vp.payment_id = vl.ref_id
          LEFT JOIN vendor_debit_notes dn ON vl.ref_table = 'vendor_debit_notes' AND dn.debit_note_id = vl.ref_id
         WHERE vl.vendor_id = ${id} ORDER BY vl.created_at DESC, vl.entry_id DESC LIMIT 200
      `.execute(trx) : Promise.resolve({ rows: [] as any[] }),
      sql<any>`
        SELECT g.grn_id, g.grn_number, g.vendor_invoice_no, g.vendor_invoice_date, g.received_at,
               g.grand_total, b.name AS branch_name,
               round(g.grand_total - d.net_amount, 2) AS returned_value,
               d.paid_direct AS paid_against, d.paid_on_account, d.amount_due
          FROM grn g JOIN branches b ON b.branch_id = g.branch_id
          JOIN erp_vendor_bill_dues(${id}) d ON d.grn_id = g.grn_id
         WHERE g.vendor_id = ${id} ORDER BY g.received_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT vpm.*, p.name AS product_name, p.sku FROM vendor_product_map vpm
          JOIN products p ON p.product_id = vpm.product_id WHERE vpm.vendor_id = ${id}
         ORDER BY p.name
      `.execute(trx),
      showMoney ? sql<any>`
        SELECT vp.*, b.name AS branch_name, u.full_name AS paid_by, g.grn_number, g.vendor_invoice_no
          FROM vendor_payments vp JOIN branches b ON b.branch_id = vp.branch_id
          LEFT JOIN users u ON u.user_id = vp.created_by
          LEFT JOIN grn g ON g.grn_id = vp.grn_id
         WHERE vp.vendor_id = ${id} ORDER BY vp.created_at DESC LIMIT 100
      `.execute(trx) : Promise.resolve({ rows: [] as any[] }),
      sql<any>`
        SELECT dn.debit_note_id, dn.debit_note_number, dn.reason, dn.total_amount, dn.created_at, g.grn_number
          FROM vendor_debit_notes dn JOIN grn g ON g.grn_id = dn.grn_id
         WHERE dn.vendor_id = ${id} ORDER BY dn.created_at DESC LIMIT 100
      `.execute(trx),
    ]);

    return {
      ...vendor,
      state_name: vendor.state_code ? GST_STATES[vendor.state_code] ?? null : null,
      balance_owed: showMoney ? Number(ledger.rows[0]?.balance_after ?? 0) : undefined,
      ledger: ledger.rows,
      // What is still due on each bill: its total, less debit notes, less payments
      // against it, less on-account payments applied oldest bill first.
      grns: showCost || showMoney ? grns.rows.map((g: any) => {
        const due = Number(g.amount_due);
        const paid = Number(g.paid_against) + Number(g.paid_on_account);
        return { ...g, amount_due: due, payment_status: due <= 0.005 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID' };
      }) : grns.rows.map(({ grand_total, paid_against, paid_on_account, returned_value, amount_due, ...r }: any) => r),
      products: showCost ? products.rows : products.rows.map(({ last_purchase_rate, ...r }: any) => r),
      payments: payments.rows,
      returns: showMoney ? returns.rows : returns.rows.map(({ total_amount, ...r }: any) => r),
    };
  }));

  app.post('/', guarded('edit_vendor', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const f = vendorFields(body);
    if (!f.name) throw badRequest('Vendor name is required.');
    const dup = (await sql<any>`SELECT name FROM vendors WHERE lower(btrim(name)) = lower(btrim(${f.name})) AND is_active`.execute(trx)).rows[0];
    if (dup) throw badRequest(`A vendor called "${dup.name}" already exists.`);
    if (f.gstin) {
      const g = (await sql<any>`SELECT name FROM vendors WHERE gstin = ${f.gstin}`.execute(trx)).rows[0];
      if (g) throw badRequest(`GSTIN ${f.gstin} is already on vendor "${g.name}".`);
    }
    const opening = body.opening_balance === undefined || body.opening_balance === '' || body.opening_balance === null
      ? 0 : num(body.opening_balance, 'Opening balance', { min: -100_000_000, max: 100_000_000 });
    if (opening !== 0 && !['OWNER_ADMIN', 'ACCOUNTANT', 'BRANCH_MANAGER'].includes(session.role)) {
      throw forbidden('Only a manager, the accountant or the owner can bring forward an opening balance.');
    }

    const row = (await sql<any>`
      INSERT INTO vendors (name, contact_person, gstin, phone, email, address, state, state_code, payment_terms_days,
                           bank_name, bank_account_no, bank_ifsc, upi_id, notes, opening_balance)
      VALUES (${f.name}, ${f.contact_person ?? null}, ${f.gstin ?? null}, ${f.phone ?? null}, ${f.email ?? null},
              ${f.address ?? null}, ${f.state_code ? GST_STATES[f.state_code] : null}, ${f.state_code ?? null},
              ${f.payment_terms_days ?? null}, ${f.bank_name ?? null}, ${f.bank_account_no ?? null},
              ${f.bank_ifsc ?? null}, ${f.upi_id ?? null}, ${f.notes ?? null}, ${opening})
      RETURNING *
    `.execute(trx)).rows[0];

    if (opening !== 0) {
      await postVendor(trx, {
        vendorId: row.vendor_id, branchId: session.branch_id ?? session.active_branch_id ?? null,
        entryType: 'OPENING_BALANCE', amount: round2(opening), refTable: 'vendors', refId: row.vendor_id,
      });
      await audit(trx, session, 'OPENING_BALANCE', 'vendors', row.vendor_id, { after: { opening_balance: opening } });
    }
    await audit(trx, session, 'VENDOR_CREATED', 'vendors', row.vendor_id, { after: { name: row.name, gstin: row.gstin } });
    return row;
  }));

  app.put('/:id', guarded('edit_vendor', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM vendors WHERE vendor_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw notFound('Vendor not found.');
    const f = vendorFields(body);
    const pick = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
    const stateCode = pick(f.state_code, before.state_code);
    await sql`
      UPDATE vendors SET
        name = ${pick(f.name, before.name)}, contact_person = ${pick(f.contact_person, before.contact_person)},
        gstin = ${pick(f.gstin, before.gstin)}, phone = ${pick(f.phone, before.phone)},
        email = ${pick(f.email, before.email)}, address = ${pick(f.address, before.address)},
        state_code = ${stateCode}, state = ${stateCode ? GST_STATES[stateCode] ?? before.state : null},
        payment_terms_days = ${pick(f.payment_terms_days, before.payment_terms_days)},
        bank_name = ${pick(f.bank_name, before.bank_name)}, bank_account_no = ${pick(f.bank_account_no, before.bank_account_no)},
        bank_ifsc = ${pick(f.bank_ifsc, before.bank_ifsc)}, upi_id = ${pick(f.upi_id, before.upi_id)},
        notes = ${pick(f.notes, before.notes)},
        is_active = ${body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active')}
      WHERE vendor_id = ${id}
    `.execute(trx);
    const changed = Object.fromEntries(Object.keys(body).map((k) => [k, before[k]]));
    await audit(trx, session, 'VENDOR_UPDATED', 'vendors', id, { before: changed, after: body });
    return { ok: true };
  }));

  // The payables ledger is commercial detail, chain-wide. `view_vendors` includes
  // inventory staff, who need vendor names for a goods receipt and nothing more —
  // so the money lives behind the financial permission instead.
  app.get('/:id/ledger', guarded('view_financial_reports', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    return (await sql<any>`
      SELECT vl.*, b.name AS branch_name,
             COALESCE(g.grn_number, vp.payment_number, dn.debit_note_number) AS reference
        FROM vendor_ledger vl
        LEFT JOIN branches b ON b.branch_id = vl.branch_id
        LEFT JOIN grn g ON vl.ref_table = 'grn' AND g.grn_id = vl.ref_id
        LEFT JOIN vendor_payments vp ON vl.ref_table = 'vendor_payments' AND vp.payment_id = vl.ref_id
        LEFT JOIN vendor_debit_notes dn ON vl.ref_table = 'vendor_debit_notes' AND dn.debit_note_id = vl.ref_id
       WHERE vl.vendor_id = ${id} ORDER BY vl.created_at DESC, vl.entry_id DESC LIMIT 500
    `.execute(trx)).rows;
  }));

  /** Section 27 — the vendor statement: brought forward, entries, carried forward. */
  app.get('/:id/statement', guarded('view_financial_reports', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const to = optionalDateStr(q.to, 'To date') ?? businessToday();
    const from = optionalDateStr(q.from, 'From date') ?? addDays(to, -90);
    if (from > to) throw badRequest('The start date is after the end date.');
    const vendor = (await sql<any>`SELECT vendor_id, name, gstin, phone, payment_terms_days FROM vendors WHERE vendor_id = ${id}`.execute(trx)).rows[0];
    if (!vendor) throw notFound('Vendor not found.');
    const opening = Number((await sql<{ b: string }>`
      SELECT balance_after AS b FROM vendor_ledger WHERE vendor_id = ${id} AND created_at < ${from}::date
       ORDER BY created_at DESC, entry_id DESC LIMIT 1
    `.execute(trx)).rows[0]?.b ?? 0);
    const entries = (await sql<any>`
      SELECT vl.entry_id, vl.entry_type, vl.amount, vl.balance_after, vl.created_at, b.name AS branch_name,
             COALESCE(g.grn_number || COALESCE(' / ' || g.vendor_invoice_no, ''), vp.payment_number, dn.debit_note_number) AS reference,
             vp.method AS payment_method, vp.reference AS payment_reference
        FROM vendor_ledger vl
        LEFT JOIN branches b ON b.branch_id = vl.branch_id
        LEFT JOIN grn g ON vl.ref_table = 'grn' AND g.grn_id = vl.ref_id
        LEFT JOIN vendor_payments vp ON vl.ref_table = 'vendor_payments' AND vp.payment_id = vl.ref_id
        LEFT JOIN vendor_debit_notes dn ON vl.ref_table = 'vendor_debit_notes' AND dn.debit_note_id = vl.ref_id
       WHERE vl.vendor_id = ${id} AND vl.created_at >= ${from}::date AND vl.created_at < (${to}::date + 1)
       ORDER BY vl.created_at, vl.entry_id LIMIT 2000
    `.execute(trx)).rows;
    const closing = entries.length ? Number(entries[entries.length - 1].balance_after) : opening;
    const sumOf = (t: string[]) => round2(entries.filter((e: any) => t.includes(e.entry_type)).reduce((s: number, e: any) => s + Number(e.amount), 0));
    return {
      vendor, from, to,
      opening_balance: round2(opening),
      purchases: sumOf(['GRN_PAYABLE']),
      payments: round2(-sumOf(['PAYMENT_MADE'])),
      debit_notes: round2(-sumOf(['DEBIT_NOTE'])),
      closing_balance: round2(closing),
      entries,
      reconciles: Math.abs(round2(opening + entries.reduce((s: number, e: any) => s + Number(e.amount), 0)) - round2(closing)) < 0.01,
    };
  }));

  /**
   * Money paid to a vendor. A voucher with its own number, the method and bank
   * reference, and optionally the supplier bill it settles; posted to the payables
   * ledger under the vendor row lock. A double-submitted form records one payment.
   */
  app.post('/:id/payments', guarded('record_vendor_payment', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = round2(num(body.amount, 'Amount', { min: 0.01, max: 100_000_000 }));
    const method = oneOf(body.method ?? 'BANK_TRANSFER', 'Payment method', PAY_METHODS);
    const reference = optionalStr(body.reference, 'Reference', { max: 80 });
    if ((method === 'BANK_TRANSFER' || method === 'CHEQUE') && !reference) {
      throw badRequest(method === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the bank transfer reference (UTR).');
    }
    const branchId = writeBranch(session, body.branch_id as string);
    const clientTxnId = optionalUuid(body.client_txn_id, 'client_txn_id');
    const grnId = optionalUuid(body.grn_id, 'Bill');
    const paidOn = optionalDateStr(body.paid_on, 'Payment date') ?? businessToday();
    if (paidOn > businessToday()) throw badRequest('A payment cannot be dated in the future.');

    if (clientTxnId) {
      const dup = (await sql<any>`SELECT * FROM vendor_payments WHERE client_txn_id = ${clientTxnId}`.execute(trx)).rows[0];
      if (dup) return { ...dup, duplicate: true, balance_after: await vendorBalance(trx, id) };
    }
    const vendor = (await sql<any>`SELECT vendor_id, name FROM vendors WHERE vendor_id = ${id}`.execute(trx)).rows[0];
    if (!vendor) throw notFound('Vendor not found.');

    const current = await vendorBalance(trx, id);
    if (amount > round2(current) + 0.005) {
      throw badRequest(`Only ₹${current.toFixed(2)} is payable to ${vendor.name}. A payment cannot be more than what is owed.`);
    }
    if (grnId) {
      const grn = (await sql<any>`
        SELECT g.grn_id, g.grn_number, d.amount_due
          FROM grn g JOIN erp_vendor_bill_dues(${id}) d ON d.grn_id = g.grn_id
         WHERE g.grn_id = ${grnId} AND g.vendor_id = ${id}
      `.execute(trx)).rows[0];
      if (!grn) throw badRequest('That bill is not from this vendor.');
      const due = Number(grn.amount_due);
      if (amount > due + 0.005) throw badRequest(`Only ₹${due.toFixed(2)} is still due on ${grn.grn_number}.`);
    }

    const number = await nextNumber(trx, branchId, 'VENDOR_PAYMENT');
    const payment = (await sql<any>`
      INSERT INTO vendor_payments (payment_number, vendor_id, branch_id, grn_id, amount, method, reference, notes,
                                   paid_on, client_txn_id, created_by)
      VALUES (${number}, ${id}, ${branchId}, ${grnId}, ${amount}, ${method}, ${reference},
              ${optionalStr(body.notes, 'Notes', { max: 300 })}, ${paidOn}::date, ${clientTxnId}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];
    const posted = await postVendor(trx, {
      vendorId: id, branchId, entryType: 'PAYMENT_MADE', amount: -amount,
      refTable: 'vendor_payments', refId: payment.payment_id,
    });
    await audit(trx, session, 'VENDOR_PAYMENT', 'vendors', id, {
      before: { balance: current },
      after: { payment_number: number, amount, method, reference, grn_id: grnId, balance: posted.balance_after },
    }, { branchId });
    return { ...payment, entry_id: posted.entry_id, amount, balance_after: posted.balance_after };
  }));

  app.get('/outstanding/list', guarded('view_financial_reports', async ({ db: trx }) =>
    (await sql<any>`
      WITH latest AS (
        SELECT DISTINCT ON (vendor_id) vendor_id, balance_after, created_at AS last_activity
          FROM vendor_ledger ORDER BY vendor_id, created_at DESC, entry_id DESC
      ), oldest_bill AS (
        -- The oldest bill still open once payments are applied oldest-first: the
        -- bill whose payment terms decide whether the account is overdue.
        SELECT d.vendor_id, MIN(d.received_at) AS oldest_open
          FROM erp_vendor_bill_dues() d WHERE d.amount_due > 0.005
         GROUP BY d.vendor_id
      )
      SELECT v.vendor_id, v.name, v.phone, v.payment_terms_days,
             l.balance_after AS balance_owed, l.last_activity,
             (CURRENT_DATE - l.last_activity::date) AS days_since_activity,
             (CURRENT_DATE - ob.oldest_open::date) AS oldest_bill_days,
             CASE WHEN v.payment_terms_days IS NOT NULL AND ob.oldest_open IS NOT NULL
                       AND (CURRENT_DATE - ob.oldest_open::date) > v.payment_terms_days
                  THEN TRUE ELSE FALSE END AS is_overdue
        FROM latest l JOIN vendors v ON v.vendor_id = l.vendor_id
        LEFT JOIN oldest_bill ob ON ob.vendor_id = v.vendor_id
       WHERE l.balance_after > 0
       ORDER BY l.balance_after DESC
    `.execute(trx)).rows));

  /** Section 8 — vendor performance: price trend and receipt cadence per month. */
  app.get('/:id/performance', guarded('view_vendors', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const settings = await loadSettings(trx, session.branch_id);
    if (!canSeeCost(session.role, settings)) {
      throw forbidden('Vendor price analytics include purchase cost, which your role cannot view.');
    }
    const [trend, monthly] = await Promise.all([
      sql<any>`
        SELECT p.name AS product_name, to_char(g.received_at, 'YYYY-MM') AS month,
               AVG(gl.rate) AS avg_rate, SUM(gl.qty_base_unit) AS qty
          FROM grn_lines gl JOIN grn g ON g.grn_id = gl.grn_id
          JOIN products p ON p.product_id = gl.product_id
         WHERE g.vendor_id = ${id} AND g.received_at >= now() - interval '12 months'
         GROUP BY 1, 2 ORDER BY 1, 2
      `.execute(trx),
      sql<any>`
        SELECT to_char(g.received_at, 'YYYY-MM') AS month, COUNT(DISTINCT g.grn_id) AS grn_count,
               SUM(g.grand_total) AS purchase_value,
               COUNT(DISTINCT dn.debit_note_id) AS return_count
          FROM grn g
          LEFT JOIN vendor_debit_notes dn ON dn.grn_id = g.grn_id
         WHERE g.vendor_id = ${id} AND g.received_at >= now() - interval '12 months'
         GROUP BY 1 ORDER BY 1
      `.execute(trx),
    ]);
    return { price_trend: trend.rows, monthly: monthly.rows };
  }));

  app.post('/:id/products', guarded('edit_vendor', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const productId = uuid(body.product_id, 'Product');
    await sql`
      INSERT INTO vendor_product_map (vendor_id, product_id, vendor_sku, last_purchase_rate, is_preferred)
      VALUES (${id}, ${productId}, ${optionalStr(body.vendor_sku, 'Vendor SKU', { max: 80 })},
              ${body.last_purchase_rate === undefined ? null : num(body.last_purchase_rate, 'Rate', { min: 0 })},
              ${Boolean(body.is_preferred)})
      ON CONFLICT (vendor_id, product_id) DO UPDATE
        SET vendor_sku = EXCLUDED.vendor_sku, is_preferred = EXCLUDED.is_preferred
    `.execute(trx);
    // Only one preferred vendor per item, or the reorder suggestion has no answer.
    if (body.is_preferred) {
      await sql`
        UPDATE vendor_product_map SET is_preferred = FALSE
         WHERE product_id = ${productId} AND vendor_id <> ${id}
      `.execute(trx);
    }
    return { ok: true };
  }));
}
