// ============================================================================
// Section 8 — Vendor / Procurement Management
// The payables ledger is the mirror image of the customer credit ledger, and
// vendor performance analytics answer the two questions that actually change
// buying decisions: do they deliver on time, and is their price drifting?
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, str, optionalStr, num, limit as clampLimit, writeBranch } from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import {} from '../../lib/tax.js';
import { audit } from '../../lib/audit.js';
import { loadSettings, canSeeCost } from '../../lib/settings.js';
import { postVendor } from '../../lib/ledger.js';

export default async function vendorsRoutes(app: FastifyInstance) {
  app.get('/', guarded('view_vendors', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT v.*, COALESCE(bal.balance_after, 0) AS balance_owed,
             (SELECT count(*) FROM grn WHERE vendor_id = v.vendor_id) AS grn_count
        FROM vendors v
        LEFT JOIN LATERAL (
            SELECT balance_after FROM vendor_ledger WHERE vendor_id = v.vendor_id
             ORDER BY created_at DESC, entry_id DESC LIMIT 1
        ) bal ON TRUE
       WHERE ${q.include_inactive === 'true' ? sql`TRUE` : sql`v.is_active`}
         ${q.q ? sql`AND v.name ILIKE ${'%' + q.q + '%'}` : sql``}
       ORDER BY v.name LIMIT ${clampLimit(q.limit, 100, 300)}
    `.execute(trx)).rows;
  }));

  app.get('/:id', guarded('view_vendors', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const settings = await loadSettings(trx, session.branch_id);
    const vendor = (await sql<any>`SELECT * FROM vendors WHERE vendor_id = ${id}`.execute(trx)).rows[0];
    if (!vendor) throw notFound('Vendor not found.');

    const [ledger, grns, products] = await Promise.all([
      sql<any>`
        SELECT vl.*, b.name AS branch_name FROM vendor_ledger vl
          LEFT JOIN branches b ON b.branch_id = vl.branch_id
         WHERE vl.vendor_id = ${id} ORDER BY vl.created_at DESC LIMIT 200
      `.execute(trx),
      sql<any>`
        SELECT g.grn_id, g.grn_number, g.received_at, b.name AS branch_name,
               (SELECT COALESCE(SUM(qty_base_unit * rate), 0) FROM grn_lines WHERE grn_id = g.grn_id) AS total_value
          FROM grn g JOIN branches b ON b.branch_id = g.branch_id
         WHERE g.vendor_id = ${id} ORDER BY g.received_at DESC LIMIT 100
      `.execute(trx),
      sql<any>`
        SELECT vpm.*, p.name AS product_name, p.sku FROM vendor_product_map vpm
          JOIN products p ON p.product_id = vpm.product_id WHERE vpm.vendor_id = ${id}
         ORDER BY p.name
      `.execute(trx),
    ]);

    const showCost = canSeeCost(session.role, settings);
    return {
      ...vendor,
      balance_owed: Number(ledger.rows[0]?.balance_after ?? 0),
      ledger: ledger.rows,
      grns: showCost ? grns.rows : grns.rows.map(({ total_value, ...r }: any) => r),
      products: showCost ? products.rows : products.rows.map(({ last_purchase_rate, ...r }: any) => r) };
  }));

  app.post('/', guarded('edit_vendor', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return (await sql<any>`
      INSERT INTO vendors (name, gstin, phone, address, payment_terms_days)
      VALUES (${str(body.name, 'Vendor name', { max: 150 })},
              ${optionalStr(body.gstin, 'GSTIN', { max: 20 })},
              ${optionalStr(body.phone, 'Phone', { max: 20 })},
              ${optionalStr(body.address, 'Address', { max: 500 })},
              ${body.payment_terms_days === undefined ? null : num(body.payment_terms_days, 'Payment terms (days)', { min: 0, max: 365 })})
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  app.put('/:id', guarded('edit_vendor', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM vendors WHERE vendor_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Vendor not found.');
    await sql`
      UPDATE vendors SET
        name = ${optionalStr(body.name, 'Vendor name', { max: 150 }) ?? before.name},
        gstin = ${body.gstin === undefined ? before.gstin : optionalStr(body.gstin, 'GSTIN', { max: 20 })},
        phone = ${body.phone === undefined ? before.phone : optionalStr(body.phone, 'Phone', { max: 20 })},
        address = ${body.address === undefined ? before.address : optionalStr(body.address, 'Address', { max: 500 })},
        payment_terms_days = ${body.payment_terms_days === undefined ? before.payment_terms_days : num(body.payment_terms_days, 'Payment terms (days)', { min: 0, max: 365 })},
        is_active = ${body.is_active === undefined ? before.is_active : Boolean(body.is_active)}
      WHERE vendor_id = ${id}
    `.execute(trx);
    return { ok: true };
  }));

  // The payables ledger is commercial detail, chain-wide. `view_vendors` includes
  // inventory staff, who need vendor names for a goods receipt and nothing more —
  // so the money lives behind the financial permission instead.
  app.get('/:id/ledger', guarded('view_financial_reports', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    return (await sql<any>`
      SELECT vl.*, b.name AS branch_name FROM vendor_ledger vl
        LEFT JOIN branches b ON b.branch_id = vl.branch_id
       WHERE vl.vendor_id = ${id} ORDER BY vl.created_at DESC LIMIT 500
    `.execute(trx)).rows;
  }));

  app.post('/:id/payments', guarded('record_vendor_payment', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'vendor_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const amount = num(body.amount, 'Amount', { min: 0.01 });
    const branchId = writeBranch(session, body.branch_id as string);

    const current = Number((await sql<any>`
      SELECT balance_after FROM vendor_ledger WHERE vendor_id = ${id}
       ORDER BY created_at DESC, entry_id DESC LIMIT 1
    `.execute(trx)).rows[0]?.balance_after ?? 0);
    if (amount > current + 0.01) throw badRequest(`Only ₹${current.toFixed(2)} is payable to this vendor.`);

    const posted = await postVendor(trx, {
      vendorId: id, branchId, entryType: 'PAYMENT_MADE', amount: -amount, refTable: 'manual' });
    await audit(trx, session, 'EXPENSE_APPROVED', 'vendor_ledger', posted.entry_id,
      { after: { vendor_id: id, amount, balance_after: posted.balance_after } });
    return { entry_id: posted.entry_id, amount: -amount, balance_after: posted.balance_after };
  }));

  app.get('/outstanding/list', guarded('view_financial_reports', async ({ db: trx }) =>
    (await sql<any>`
      WITH latest AS (
        SELECT DISTINCT ON (vendor_id) vendor_id, balance_after, created_at AS last_activity
          FROM vendor_ledger ORDER BY vendor_id, created_at DESC, entry_id DESC
      )
      SELECT v.vendor_id, v.name, v.phone, v.payment_terms_days,
             l.balance_after AS balance_owed, l.last_activity,
             (CURRENT_DATE - l.last_activity::date) AS days_since_activity,
             CASE WHEN v.payment_terms_days IS NOT NULL
                       AND (CURRENT_DATE - l.last_activity::date) > v.payment_terms_days
                  THEN TRUE ELSE FALSE END AS is_overdue
        FROM latest l JOIN vendors v ON v.vendor_id = l.vendor_id
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
        SELECT to_char(g.received_at, 'YYYY-MM') AS month, COUNT(*) AS grn_count,
               SUM(gl.qty_base_unit * gl.rate) AS purchase_value,
               COUNT(DISTINCT dn.debit_note_id) AS return_count
          FROM grn g
          JOIN grn_lines gl ON gl.grn_id = g.grn_id
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
