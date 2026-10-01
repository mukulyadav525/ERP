// ============================================================================
// Section 4 — Inventory & Procurement (spec §28–§34)
//   4.1  every movement lands in stock_ledger with a reason
//   4.2  batch tracking for shelf-life-sensitive categories
//   4.3  reorder thresholds and auto-suggested POs
//   4.4  transfer request -> dispatch -> receive, with 4.4.1 discrepancy state
//   4.5  PO -> GRN (the purchase bill, with GST) -> stock-in -> vendor payable,
//        plus 4.5.1 vendor debit notes
//   4.6  physical stock audit with variance
//   4.7  wastage / damage write-off; manual adjustments with a reason
//   4.8  weighted-average cost, recalculated only here (4.8.1)
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, oneOf,
  writeBranch, resolveBranchScope, limit as clampLimit, arrayOf,
} from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings, canSeeCost, maskCost } from '../../lib/settings.js';
import { newWeightedAvgCost, round2, roundTo } from '../../lib/tax.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import type { Tx } from '../../lib/db.js';
import { postVendor, vendorBalance } from '../../lib/ledger.js';
import { assertQuantityAllowed } from '../../lib/units.js';
import { businessToday } from '../../lib/dates.js';
import { canAccess } from '../../lib/rbac.js';

type MovementType = 'PURCHASE' | 'SALE' | 'SALE_RETURN' | 'TRANSFER_OUT' | 'TRANSFER_IN'
  | 'PURCHASE_RETURN' | 'WRITE_OFF' | 'COUNT_ADJUSTMENT' | 'OPENING_STOCK' | 'ADJUSTMENT';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function optionalDate(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(new Date(s).getTime())) throw badRequest(`${field} must be a date.`);
  return s;
}

/**
 * 4.8.1 — the ONLY function that moves stock. Everything (GRN, transfer, return,
 * write-off, audit correction, adjustment) goes through here, so branch_stock,
 * the weighted average cost and the ledger can never disagree about how the
 * number got there.
 */
export async function applyMovement(trx: Tx, opts: {
  branchId: string; productId: string;
  qtyChange: number;                 // signed, in base units
  movementType: MovementType;
  refTable: string; refId: string;
  reasonCode?: string | null;
  userId: string;
  /** Supplied for stock-IN movements that carry a cost (GRN, transfer-in, opening stock). */
  inboundRate?: number | null;
}): Promise<{ weighted_avg_cost: number }> {
  const existing = (await sql<any>`
    SELECT base_unit_qty, weighted_avg_cost FROM branch_stock
     WHERE branch_id = ${opts.branchId} AND product_id = ${opts.productId}
     FOR UPDATE
  `.execute(trx)).rows[0];

  const currentQty = Number(existing?.base_unit_qty ?? 0);
  const currentCost = Number(existing?.weighted_avg_cost ?? 0);

  // Cost only ever changes on an inbound movement with a known rate. A sale or a
  // write-off leaves the average untouched — that is what makes it an *average
  // cost of what is on the shelf* rather than a number that drifts on every sale.
  const nextCost = opts.qtyChange > 0 && opts.inboundRate != null
    ? newWeightedAvgCost(currentQty, currentCost, opts.qtyChange, opts.inboundRate)
    : (existing ? currentCost : Math.max(opts.inboundRate ?? 0, 0));

  if (!existing) {
    await sql`
      INSERT INTO branch_stock (branch_id, product_id, base_unit_qty, weighted_avg_cost)
      VALUES (${opts.branchId}, ${opts.productId}, ${opts.qtyChange}, ${nextCost})
    `.execute(trx);
  } else {
    await sql`
      UPDATE branch_stock
         SET base_unit_qty = base_unit_qty + ${opts.qtyChange},
             weighted_avg_cost = ${nextCost}, updated_at = now()
       WHERE branch_id = ${opts.branchId} AND product_id = ${opts.productId}
    `.execute(trx);
  }

  await sql`
    INSERT INTO stock_ledger (branch_id, product_id, movement_type, base_unit_qty_change,
                              cost_at_movement, ref_table, ref_id, reason_code, created_by)
    VALUES (${opts.branchId}, ${opts.productId}, ${opts.movementType}::stock_movement_type,
            ${opts.qtyChange}, ${opts.inboundRate ?? currentCost}, ${opts.refTable}, ${opts.refId},
            ${opts.reasonCode ?? null}, ${opts.userId})
  `.execute(trx);

  return { weighted_avg_cost: nextCost };
}

/** Resolves a (product, optional unit, qty in that unit) into base units, validating the unit. */
async function toBaseQty(trx: Tx, productId: string, productUnitId: string | null, qtyInUnit: number, label: string) {
  const row = (await sql<any>`
    SELECT p.product_id, p.name, p.base_unit, p.is_active, p.batch_tracked, p.serial_tracked, p.hsn_code,
           pu.product_unit_id, COALESCE(pu.multiplier_to_base, 1) AS multiplier,
           u.allows_fraction, u.name AS unit_name, u.print_label
      FROM products p
      LEFT JOIN product_units pu ON pu.product_id = p.product_id
           AND (pu.product_unit_id = ${productUnitId} OR (${productUnitId}::uuid IS NULL AND pu.unit_label = p.base_unit))
      LEFT JOIN units u ON u.unit_code = COALESCE(pu.unit_label, p.base_unit)
     WHERE p.product_id = ${productId}
  `.execute(trx)).rows[0];
  if (!row) throw badRequest(`${label}: that product is not in the catalog.`);
  if (productUnitId && !row.product_unit_id) throw badRequest(`${label}: that unit is not set up for "${row.name}".`);
  assertQuantityAllowed(qtyInUnit, { allows_fraction: row.allows_fraction ?? true, name: row.unit_name ?? row.base_unit, print_label: row.print_label ?? row.base_unit }, row.name);
  return {
    product: row,
    productUnitId: row.product_unit_id as string | null,
    multiplier: Number(row.multiplier),
    baseQty: roundTo(qtyInUnit * Number(row.multiplier), 4),
  };
}

export default async function inventoryRoutes(app: FastifyInstance) {
  // ── Current stock ─────────────────────────────────────────────────────────
  /**
   * For one branch this lists EVERY active product, including those it has never
   * stocked — an item at zero that was never received is exactly the one a
   * reorder check has to see. "All branches" lists branch-by-branch positions.
   */
  app.get('/stock', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const search = q.q?.trim().slice(0, 60);
    const filter = q.low_stock_only === 'true' ? 'low' : q.filter === 'out' ? 'out' : q.filter === 'low' ? 'low' : 'all';

    const rows = await sql<any>`
      SELECT * FROM (
        SELECT b.branch_id, b.name AS branch_name, p.product_id, p.name, p.sku, p.base_unit,
               u.print_label AS base_unit_label,
               c.category_id, c.name AS category_name, br.name AS brand_name,
               COALESCE(bs.base_unit_qty, 0) AS base_unit_qty, COALESCE(bs.reserved_qty, 0) AS reserved_qty,
               COALESCE(bs.base_unit_qty, 0) - COALESCE(bs.reserved_qty, 0) AS available_qty,
               COALESCE(bs.weighted_avg_cost, 0) AS weighted_avg_cost,
               COALESCE(bs.reorder_min, p.reorder_level) AS reorder_min,
               bs.reorder_min IS NOT NULL AS reorder_is_branch_specific,
               bs.reorder_max, bs.updated_at,
               COALESCE(bs.base_unit_qty, 0) * COALESCE(bs.weighted_avg_cost, 0) AS stock_value,
               (COALESCE(bs.base_unit_qty, 0) <= COALESCE(bs.reorder_min, p.reorder_level, 0)) AS is_low,
               (COALESCE(bs.base_unit_qty, 0) <= 0) AS is_out
          FROM products p
          JOIN units u ON u.unit_code = p.base_unit
          ${branchId
            ? sql`JOIN branches b ON b.branch_id = ${branchId}
                  LEFT JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = b.branch_id`
            : sql`JOIN branch_stock bs ON bs.product_id = p.product_id
                  JOIN branches b ON b.branch_id = bs.branch_id`}
          LEFT JOIN categories c ON c.category_id = p.category_id
          LEFT JOIN brands br ON br.brand_id = p.brand_id
         WHERE p.is_active
           ${q.category_id ? sql`AND p.category_id = ${uuid(q.category_id, 'category_id')}` : sql``}
           ${search ? sql`AND (p.name ILIKE ${'%' + search + '%'} OR p.sku ILIKE ${'%' + search + '%'})` : sql``}
      ) x
      WHERE ${filter === 'low' ? sql`x.is_low` : filter === 'out' ? sql`x.is_out` : sql`TRUE`}
      ORDER BY ${filter !== 'all' ? sql`x.base_unit_qty ASC,` : sql``} x.name, x.branch_name
      LIMIT ${clampLimit(q.limit, 300, 2000)}
    `.execute(trx);
    return maskCost(rows.rows, showCost);
  }));

  /**
   * Section 0 — cross-branch lookup: "does Branch B have this item in stock?"
   * Owner-only, and it deliberately runs with the chain-wide scope rather than
   * the caller's branch scope. Staff never reach this endpoint.
   */
  app.get('/stock/cross-branch', guarded('cross_branch_lookup', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const search = q.q?.trim();
    const rows = await sql<any>`
      SELECT p.product_id, p.name, p.sku, p.base_unit,
             (SELECT print_label FROM units WHERE unit_code = p.base_unit) AS base_unit_label,
             jsonb_agg(jsonb_build_object(
               'branch_id', b.branch_id, 'branch_name', b.name,
               'qty', bs.base_unit_qty, 'reserved', bs.reserved_qty,
               'available', bs.base_unit_qty - bs.reserved_qty
             ) ORDER BY b.name) AS branches,
             SUM(bs.base_unit_qty) AS chain_total
        FROM products p
        JOIN branch_stock bs ON bs.product_id = p.product_id
        JOIN branches b ON b.branch_id = bs.branch_id
       WHERE p.is_active
         ${search ? sql`AND (p.name ILIKE ${'%' + search + '%'} OR p.sku ILIKE ${'%' + search + '%'} OR p.name % ${search})` : sql``}
         ${q.product_id ? sql`AND p.product_id = ${uuid(q.product_id, 'product_id')}` : sql``}
       GROUP BY p.product_id, p.name, p.sku, p.base_unit
       ORDER BY p.name LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx);
    return rows.rows;
  }));

  app.put('/stock/:productId/reorder', guarded('create_grn', async ({ session, db: trx, req }) => {
    const productId = uuid((req.params as any).productId, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    const min = body.reorder_min === null || body.reorder_min === '' ? null : num(body.reorder_min, 'Reorder level', { min: 0, max: 1e9 });
    const max = body.reorder_max === undefined || body.reorder_max === null || body.reorder_max === ''
      ? null : num(body.reorder_max, 'Maximum stock', { min: 0, max: 1e9 });
    if (min !== null && max !== null && max < min) throw badRequest('The maximum stock level cannot be below the reorder level.');
    await sql`
      INSERT INTO branch_stock (branch_id, product_id, reorder_min, reorder_max)
      VALUES (${branchId}, ${productId}, ${min}, ${max})
      ON CONFLICT (branch_id, product_id) DO UPDATE
        SET reorder_min = EXCLUDED.reorder_min, reorder_max = EXCLUDED.reorder_max, updated_at = now()
    `.execute(trx);
    return { ok: true };
  }));

  // ── Stock ledger (4.1) ────────────────────────────────────────────────────
  app.get('/stock-ledger', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const from = optionalDate(q.from, 'From date');
    const to = optionalDate(q.to, 'To date');
    const rows = await sql<any>`
      SELECT sl.ledger_id, sl.branch_id, b.name AS branch_name, sl.product_id, p.name AS product_name,
             p.sku, p.base_unit, bu.print_label AS base_unit_label, sl.movement_type, sl.base_unit_qty_change, sl.cost_at_movement,
             sl.ref_table, sl.ref_id, sl.reason_code, sl.created_at, u.full_name AS created_by_name,
             COALESCE(i.invoice_number, g.grn_number, t.transfer_number, sa.adjustment_number, dn.debit_note_number) AS reference
        FROM stock_ledger sl
        JOIN products p ON p.product_id = sl.product_id
        JOIN units bu ON bu.unit_code = p.base_unit
        JOIN branches b ON b.branch_id = sl.branch_id
        LEFT JOIN users u ON u.user_id = sl.created_by
        LEFT JOIN invoices i ON sl.ref_table = 'invoices' AND i.invoice_id = sl.ref_id
        LEFT JOIN grn g ON sl.ref_table = 'grn' AND g.grn_id = sl.ref_id
        LEFT JOIN stock_transfers t ON sl.ref_table = 'stock_transfers' AND t.transfer_id = sl.ref_id
        LEFT JOIN stock_adjustments sa ON sl.ref_table = 'stock_adjustments' AND sa.adjustment_id = sl.ref_id
        LEFT JOIN vendor_debit_notes dn ON sl.ref_table = 'vendor_debit_notes' AND dn.debit_note_id = sl.ref_id
       WHERE sl.movement_type NOT IN ('RESERVATION', 'RESERVATION_RELEASE')
         ${branchId ? sql`AND sl.branch_id = ${branchId}` : sql``}
         ${q.product_id ? sql`AND sl.product_id = ${uuid(q.product_id, 'product_id')}` : sql``}
         ${q.movement_type ? sql`AND sl.movement_type = ${oneOf(q.movement_type, 'Movement type',
           ['PURCHASE', 'SALE', 'SALE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'PURCHASE_RETURN', 'WRITE_OFF',
            'COUNT_ADJUSTMENT', 'OPENING_STOCK', 'ADJUSTMENT'] as const)}::stock_movement_type` : sql``}
         ${from ? sql`AND sl.created_at >= ${from}::date` : sql``}
         ${to ? sql`AND sl.created_at < (${to}::date + 1)` : sql``}
       ORDER BY sl.created_at DESC
       LIMIT ${clampLimit(q.limit, 100, 1000)}
    `.execute(trx);
    return maskCost(rows.rows, canSeeCost(session.role, settings));
  }));

  // ── Stock adjustments (4.1 / spec §30) ───────────────────────────────────
  /**
   * Opening stock for a new product, stock found on a shelf, a counting correction,
   * goods used by the shop. Each is a numbered document with a reason, posted
   * through the one movement function — never an edit of the stock figure.
   * Stock coming IN needs a unit cost so it is valued; OPENING_STOCK requires it.
   */
  app.post('/stock-adjustments', guarded('adjust_stock', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const branchId = writeBranch(session, body.branch_id as string);
    const productId = uuid(body.product_id, 'Product');
    const reason = oneOf(body.reason_code, 'Reason',
      ['OPENING_STOCK', 'FOUND', 'COUNT_CORRECTION', 'DAMAGED', 'LOST', 'EXPIRED', 'INTERNAL_USE', 'OTHER'] as const);
    const direction = oneOf(body.direction ?? (reason === 'OPENING_STOCK' || reason === 'FOUND' ? 'IN' : 'OUT'),
      'Direction', ['IN', 'OUT'] as const);
    if (reason === 'OPENING_STOCK' && direction !== 'IN') throw badRequest('Opening stock can only be added, not removed.');
    const qtyInUnit = num(body.quantity, 'Quantity', { min: 0.0001, max: 1e9 });
    const { product, baseQty } = await toBaseQty(trx, productId, optionalUuid(body.product_unit_id, 'Unit'), qtyInUnit, 'Adjustment');
    const notes = optionalStr(body.notes, 'Notes', { max: 500 });
    if (reason === 'OTHER' && !notes) throw badRequest('Explain the adjustment in the notes when the reason is "Other".');

    let unitCost: number | null = null;
    if (direction === 'IN') {
      if (body.unit_cost === undefined || body.unit_cost === null || body.unit_cost === '') {
        if (reason === 'OPENING_STOCK') throw badRequest('Enter the cost per unit for opening stock, so it is valued correctly.');
      } else {
        // Typed per UNIT the quantity was given in; stored per base unit.
        const perUnit = num(body.unit_cost, 'Cost per unit', { min: 0, max: 10_000_000 });
        unitCost = roundTo(perUnit / (baseQty / qtyInUnit), 4);
      }
    }
    const signed = direction === 'IN' ? baseQty : -baseQty;
    const number = await nextNumber(trx, branchId, 'ADJUSTMENT');
    const row = (await sql<any>`
      INSERT INTO stock_adjustments (adjustment_number, branch_id, product_id, qty_change, unit_cost, reason_code, notes, created_by)
      VALUES (${number}, ${branchId}, ${productId}, ${signed}, ${unitCost}, ${reason}, ${notes}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];
    await applyMovement(trx, {
      branchId, productId, qtyChange: signed,
      movementType: reason === 'OPENING_STOCK' ? 'OPENING_STOCK' : 'ADJUSTMENT',
      refTable: 'stock_adjustments', refId: row.adjustment_id, reasonCode: reason,
      userId: session.user_id, inboundRate: unitCost,
    });
    await audit(trx, session, 'STOCK_ADJUSTMENT', 'stock_adjustments', row.adjustment_id,
      { after: { adjustment_number: number, product: product.name, qty_change: signed, reason, unit_cost: unitCost, notes } },
      { branchId });
    return row;
  }));

  app.get('/stock-adjustments', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const rows = (await sql<any>`
      SELECT sa.*, p.name AS product_name, p.sku, p.base_unit, bu.print_label AS base_unit_label,
             b.name AS branch_name, u.full_name AS created_by_name
        FROM stock_adjustments sa JOIN products p ON p.product_id = sa.product_id
        JOIN units bu ON bu.unit_code = p.base_unit
        JOIN branches b ON b.branch_id = sa.branch_id
        LEFT JOIN users u ON u.user_id = sa.created_by
       WHERE 1=1 ${branchId ? sql`AND sa.branch_id = ${branchId}` : sql``}
       ORDER BY sa.created_at DESC LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx)).rows;
    return canSeeCost(session.role, settings) ? rows : rows.map(({ unit_cost, ...r }: any) => r);
  }));

  // ── Purchase orders (4.5) ─────────────────────────────────────────────────
  app.get('/purchase-orders', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const rows = (await sql<any>`
      SELECT po.*, v.name AS vendor_name, b.name AS branch_name, u.full_name AS created_by_name,
             (SELECT COALESCE(SUM(qty_base_unit * rate), 0) FROM purchase_order_lines WHERE po_id = po.po_id) AS total_value,
             (SELECT count(*) FROM purchase_order_lines WHERE po_id = po.po_id) AS line_count
        FROM purchase_orders po
        JOIN vendors v ON v.vendor_id = po.vendor_id
        JOIN branches b ON b.branch_id = po.branch_id
        LEFT JOIN users u ON u.user_id = po.created_by
       WHERE 1=1 ${branchId ? sql`AND po.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND po.status = ${oneOf(q.status, 'status', ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as const)}::po_status` : sql``}
         ${q.open === 'true' ? sql`AND po.status IN ('SENT', 'PARTIALLY_RECEIVED')` : sql``}
         ${q.vendor_id ? sql`AND po.vendor_id = ${uuid(q.vendor_id, 'vendor_id')}` : sql``}
       ORDER BY po.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
    return canSeeCost(session.role, settings) ? rows : rows.map(({ total_value, ...r }: any) => r);
  }));

  app.get('/purchase-orders/:id', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'po_id');
    const settings = await loadSettings(trx, session.branch_id);
    const po = (await sql<any>`
      SELECT po.*, v.name AS vendor_name, v.phone AS vendor_phone, v.state_code AS vendor_state_code,
             b.name AS branch_name, b.state_code AS branch_state_code
        FROM purchase_orders po JOIN vendors v ON v.vendor_id = po.vendor_id
        JOIN branches b ON b.branch_id = po.branch_id WHERE po.po_id = ${id}
    `.execute(trx)).rows[0];
    if (!po) throw notFound('Purchase order not found.');
    // Received so far is summed from the receipts against each line, which is what
    // makes a partial delivery visible rather than closing the order on the first box.
    const lines = (await sql<any>`
      SELECT pol.*, p.name AS product_name, p.sku, p.base_unit, u.print_label AS base_unit_label,
             COALESCE(htr.gst_rate_pct, 0) AS gst_rate_pct,
             COALESCE((SELECT SUM(gl.qty_base_unit) FROM grn_lines gl WHERE gl.po_line_id = pol.po_line_id), 0) AS received_qty
        FROM purchase_order_lines pol JOIN products p ON p.product_id = pol.product_id
        JOIN units u ON u.unit_code = p.base_unit
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
       WHERE pol.po_id = ${id} ORDER BY p.name
    `.execute(trx)).rows.map((l: any) => ({
      ...l, pending_qty: Math.max(roundTo(Number(l.qty_base_unit) - Number(l.received_qty), 4), 0),
    }));
    return { ...po, lines: maskCost(lines, canSeeCost(session.role, settings)) };
  }));

  /** 4.3 — the auto-suggested PO: everything at or below its reorder point, grouped
   *  by the preferred vendor for that item (4.9 vendor-item mapping). A suggestion
   *  only: nothing is ordered until a person raises the PO. */
  app.get('/reorder-suggestions', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id) ?? session.branch_id;
    if (!branchId) throw badRequest('Please select a branch to see what it needs to reorder.');
    const settings = await loadSettings(trx, branchId);
    const rows = (await sql<any>`
      SELECT p.product_id, p.name AS product_name, p.sku, p.base_unit,
             (SELECT print_label FROM units WHERE unit_code = p.base_unit) AS base_unit_label,
             COALESCE(bs.base_unit_qty, 0) AS base_unit_qty,
             COALESCE(bs.reorder_min, p.reorder_level) AS reorder_min, bs.reorder_max,
             GREATEST(COALESCE(bs.reorder_max, COALESCE(bs.reorder_min, p.reorder_level) * 3)
                      - COALESCE(bs.base_unit_qty, 0), 0) AS suggested_qty,
             vpm.vendor_id, v.name AS vendor_name,
             COALESCE(vpm.last_purchase_rate, p.reference_purchase_price) AS expected_rate
        FROM products p
        LEFT JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = ${branchId}
        LEFT JOIN LATERAL (
            SELECT vendor_id, last_purchase_rate FROM vendor_product_map
             WHERE product_id = p.product_id ORDER BY is_preferred DESC LIMIT 1
        ) vpm ON TRUE
        LEFT JOIN vendors v ON v.vendor_id = vpm.vendor_id
       WHERE p.is_active
         AND COALESCE(bs.reorder_min, p.reorder_level) IS NOT NULL
         AND COALESCE(bs.base_unit_qty, 0) <= COALESCE(bs.reorder_min, p.reorder_level)
       ORDER BY v.name NULLS LAST, p.name
    `.execute(trx)).rows;
    return canSeeCost(session.role, settings) ? rows : rows.map(({ expected_rate, ...r }: any) => r);
  }));

  app.post('/purchase-orders', guarded('create_purchase_order', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const vendorId = uuid(body.vendor_id, 'Vendor');
    const vendor = (await sql<any>`SELECT vendor_id, name, is_active FROM vendors WHERE vendor_id = ${vendorId}`.execute(trx)).rows[0];
    if (!vendor) throw notFound('Vendor not found.');
    if (!vendor.is_active) throw badRequest(`${vendor.name} is marked inactive.`);
    const lines = arrayOf(body.lines, 'Items', (l, i) => ({
      product_id: uuid(l.product_id, `Item ${i + 1}`),
      qty_base_unit: num(l.qty_base_unit, `Quantity (item ${i + 1})`, { min: 0.0001, max: 1e9 }),
      rate: num(l.rate ?? 0, `Rate (item ${i + 1})`, { min: 0, max: 10_000_000 }),
    }), { min: 1, max: 300 });

    const poNumber = await nextNumber(trx, branchId, 'PO');
    const po = (await sql<any>`
      INSERT INTO purchase_orders (branch_id, vendor_id, po_number, status, expected_date, notes, created_by)
      VALUES (${branchId}, ${vendorId}, ${poNumber}, 'SENT', ${optionalDate(body.expected_date, 'Expected date')},
              ${optionalStr(body.notes, 'Notes', { max: 500 })}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      await sql`
        INSERT INTO purchase_order_lines (po_id, product_id, qty_base_unit, rate)
        VALUES (${po.po_id}, ${l.product_id}, ${l.qty_base_unit}, ${l.rate})
      `.execute(trx);
    }
    await audit(trx, session, 'PURCHASE_ORDER_CREATED', 'purchase_orders', po.po_id,
      { after: { po_number: poNumber, vendor: vendor.name, lines: lines.length } }, { branchId });
    return po;
  }));

  app.post('/purchase-orders/:id/cancel', guarded('create_purchase_order', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'po_id');
    const po = (await sql<any>`SELECT * FROM purchase_orders WHERE po_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!po) throw notFound('Purchase order not found.');
    if (po.status === 'RECEIVED' || po.status === 'CANCELLED') {
      throw badRequest(`This purchase order is already ${po.status.toLowerCase()}.`);
    }
    // A partly received order is closed off, not undone: the goods that arrived stay received.
    await sql`UPDATE purchase_orders SET status = ${po.status === 'PARTIALLY_RECEIVED' ? 'RECEIVED' : 'CANCELLED'}::po_status
               WHERE po_id = ${id}`.execute(trx);
    await audit(trx, session, 'PURCHASE_ORDER_CANCELLED', 'purchase_orders', id,
      { before: { status: po.status }, after: { reason: optionalStr((req.body as any)?.reason, 'Reason', { max: 300 }) } },
      { branchId: po.branch_id });
    return { ok: true, status: po.status === 'PARTIALLY_RECEIVED' ? 'RECEIVED' : 'CANCELLED' };
  }));

  // ── GRN / purchase entry (4.5, 4.8.1) ─────────────────────────────────────
  app.get('/grn', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const from = optionalDate(q.from, 'From date');
    const to = optionalDate(q.to, 'To date');
    const rows = await sql<any>`
      SELECT g.grn_id, g.grn_number, g.branch_id, b.name AS branch_name, g.po_id, po.po_number,
             v.vendor_id, v.name AS vendor_name, g.vendor_invoice_no, g.vendor_invoice_date,
             g.received_at, u.full_name AS created_by_name,
             g.taxable_total, g.cgst_total + g.sgst_total + g.igst_total AS tax_total, g.grand_total,
             g.grand_total AS total_value,
             d.paid_direct AS paid_against, d.paid_on_account, d.amount_due AS fifo_due,
             round(g.grand_total - d.net_amount, 2) AS returned_value,
             (SELECT count(*) FROM grn_lines WHERE grn_id = g.grn_id) AS line_count,
             EXISTS (SELECT 1 FROM vendor_debit_notes dn WHERE dn.grn_id = g.grn_id) AS has_returns
        FROM grn g
        JOIN vendors v ON v.vendor_id = g.vendor_id
        JOIN branches b ON b.branch_id = g.branch_id
        JOIN erp_vendor_bill_dues(${q.vendor_id ? uuid(q.vendor_id, 'vendor_id') : null}) d ON d.grn_id = g.grn_id
        LEFT JOIN purchase_orders po ON po.po_id = g.po_id
        LEFT JOIN users u ON u.user_id = g.created_by
       WHERE 1=1 ${branchId ? sql`AND g.branch_id = ${branchId}` : sql``}
         ${q.vendor_id ? sql`AND g.vendor_id = ${uuid(q.vendor_id, 'vendor_id')}` : sql``}
         ${from ? sql`AND g.received_at >= ${from}::date` : sql``}
         ${to ? sql`AND g.received_at < (${to}::date + 1)` : sql``}
         ${q.q ? sql`AND (g.grn_number ILIKE ${'%' + q.q.trim() + '%'} OR g.vendor_invoice_no ILIKE ${'%' + q.q.trim() + '%'} OR v.name ILIKE ${'%' + q.q.trim() + '%'})` : sql``}
       ORDER BY g.received_at DESC LIMIT ${clampLimit(q.limit, 50, 300)}
    `.execute(trx);
    const out = rows.rows.map(({ fifo_due, ...r }: any) => {
      const due = Number(fifo_due);
      const paid = Number(r.paid_against) + Number(r.paid_on_account);
      return { ...r, amount_due: due, payment_status: due <= 0.005 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID' };
    });
    // Purchase value is cost — masked for anyone without cost visibility (2.6).
    return canSeeCost(session.role, settings) || ['ACCOUNTANT'].includes(session.role)
      ? out
      : out.map(({ total_value, taxable_total, tax_total, grand_total, paid_against, paid_on_account, returned_value, amount_due, ...rest }: any) => rest);
  }));

  app.get('/grn/:id', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'grn_id');
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings) || session.role === 'ACCOUNTANT';
    const grn = (await sql<any>`
      SELECT g.*, v.name AS vendor_name, v.gstin AS vendor_gstin, b.name AS branch_name, po.po_number,
             u.full_name AS created_by_name,
             (SELECT d.paid_direct FROM erp_vendor_bill_dues(g.vendor_id) d WHERE d.grn_id = g.grn_id) AS paid_against,
             (SELECT d.paid_on_account FROM erp_vendor_bill_dues(g.vendor_id) d WHERE d.grn_id = g.grn_id) AS paid_on_account,
             (SELECT d.amount_due FROM erp_vendor_bill_dues(g.vendor_id) d WHERE d.grn_id = g.grn_id) AS amount_due,
             COALESCE((SELECT SUM(dn.total_amount) FROM vendor_debit_notes dn WHERE dn.grn_id = g.grn_id), 0) AS returned_value
        FROM grn g JOIN vendors v ON v.vendor_id = g.vendor_id
        JOIN branches b ON b.branch_id = g.branch_id
        LEFT JOIN purchase_orders po ON po.po_id = g.po_id
        LEFT JOIN users u ON u.user_id = g.created_by
       WHERE g.grn_id = ${id}
    `.execute(trx)).rows[0];
    if (!grn) throw notFound('Goods receipt not found.');
    const lines = (await sql<any>`
      SELECT gl.*, p.name AS product_name, p.sku, p.base_unit, bu.print_label AS base_unit_label,
             pu.unit_label, COALESCE(u.print_label, bu.print_label) AS unit_print_label,
             COALESCE(pu.multiplier_to_base, 1) AS multiplier_to_base,
             sb.batch_number, sb.expiry_date,
             COALESCE((SELECT SUM(qty_base_unit) FROM vendor_debit_note_lines WHERE grn_line_id = gl.grn_line_id), 0) AS returned_qty
        FROM grn_lines gl JOIN products p ON p.product_id = gl.product_id
        JOIN units bu ON bu.unit_code = p.base_unit
        LEFT JOIN product_units pu ON pu.product_unit_id = gl.product_unit_id
        LEFT JOIN units u ON u.unit_code = pu.unit_label
        LEFT JOIN stock_batches sb ON sb.batch_id = gl.batch_id
       WHERE gl.grn_id = ${id} ORDER BY p.name
    `.execute(trx)).rows;
    const debitNotes = (await sql<any>`
      SELECT debit_note_id, debit_note_number, reason, total_amount, created_at FROM vendor_debit_notes
       WHERE grn_id = ${id} ORDER BY created_at
    `.execute(trx)).rows;
    return showCost
      ? { ...grn, lines, debit_notes: debitNotes }
      : {
          ...Object.fromEntries(Object.entries(grn).filter(([k]) => !/total|round_off|paid_against|paid_on_account|amount_due|returned_value/.test(k))),
          lines: maskCost(lines, false).map(({ taxable_value, cgst_amount, sgst_amount, igst_amount, line_total, discount_amount, ...r }: any) => r),
          debit_notes: debitNotes.map(({ total_amount, ...r }: any) => r),
        };
  }));

  /**
   * The purchase bill. Quantities may be entered in the unit the supplier billed
   * in (a BAG of 25 KG, a BOX of 100); rates are per that unit, ex-GST. The GST
   * charged is CGST + SGST for an in-state supplier and IGST for an out-of-state
   * one. Stock is costed at the discounted ex-GST rate (the GST is claimed back
   * as ITC), and the vendor is owed the bill's grand total.
   */
  app.post('/grn', guarded('create_grn', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const vendorId = uuid(body.vendor_id, 'Vendor');
    const poId = optionalUuid(body.po_id, 'Purchase order');
    const settings = await loadSettings(trx, branchId);
    const clientTxnId = optionalUuid(body.client_txn_id, 'client_txn_id');

    // A double-clicked Save must not receive the goods twice.
    if (clientTxnId) {
      const dup = (await sql<any>`SELECT * FROM grn WHERE client_txn_id = ${clientTxnId}`.execute(trx)).rows[0];
      if (dup) return { ...dup, total_value: dup.grand_total, duplicate: true };
    }

    const vendor = (await sql<any>`SELECT * FROM vendors WHERE vendor_id = ${vendorId}`.execute(trx)).rows[0];
    if (!vendor) throw notFound('Vendor not found.');
    const branch = (await sql<any>`SELECT state_code FROM branches WHERE branch_id = ${branchId}`.execute(trx)).rows[0];
    const interstate = Boolean(vendor.state_code && branch?.state_code && vendor.state_code !== branch.state_code);
    const vendorInvoiceNo = optionalStr(body.vendor_invoice_no, 'Supplier bill number', { max: 40 });
    const vendorInvoiceDate = optionalDate(body.vendor_invoice_date, 'Supplier bill date');
    if (vendorInvoiceDate && vendorInvoiceDate > businessToday()) {
      throw badRequest('The supplier bill date cannot be in the future.');
    }

    let po: any = null;
    let poLines = new Map<string, any>();
    if (poId) {
      po = (await sql<any>`SELECT * FROM purchase_orders WHERE po_id = ${poId} FOR UPDATE`.execute(trx)).rows[0];
      if (!po) throw notFound('Purchase order not found.');
      if (po.vendor_id !== vendorId) throw badRequest('That purchase order is for a different vendor.');
      if (po.branch_id !== branchId) throw badRequest('That purchase order is for a different branch.');
      if (po.status === 'RECEIVED' || po.status === 'CANCELLED') {
        throw badRequest(`Purchase order ${po.po_number} is already ${po.status.toLowerCase()}.`);
      }
      poLines = new Map((await sql<any>`
        SELECT pol.*, COALESCE((SELECT SUM(gl.qty_base_unit) FROM grn_lines gl WHERE gl.po_line_id = pol.po_line_id), 0) AS received
          FROM purchase_order_lines pol WHERE pol.po_id = ${poId}
      `.execute(trx)).rows.map((r: any) => [r.po_line_id, r]));
    }

    const rawLines = arrayOf(body.lines, 'Items', (l) => l, { min: 1, max: 300 });
    const lines: any[] = [];
    for (const [i, l] of rawLines.entries()) {
      const label = `Item ${i + 1}`;
      const productId = uuid(l.product_id, label);
      // `qty` + optional unit, or the older `qty_base_unit` in base units.
      const qtyInUnit = num(l.qty ?? l.qty_base_unit, `Quantity (${label.toLowerCase()})`, { min: 0.0001, max: 1e9 });
      const { product, productUnitId, multiplier, baseQty } = await toBaseQty(
        trx, productId, l.qty === undefined ? null : optionalUuid(l.product_unit_id, 'Unit'), qtyInUnit, label);
      // The rate is per the unit the quantity is in; stored per base unit.
      const unitRate = num(l.rate, `Rate for "${product.name}"`, { min: 0, max: 10_000_000 });
      const ratePerBase = roundTo(unitRate / multiplier, 4);
      const gross = round2(qtyInUnit * unitRate);
      const discount = l.discount_amount === undefined || l.discount_amount === null || l.discount_amount === ''
        ? 0 : num(l.discount_amount, `Discount on "${product.name}"`, { min: 0, max: 10_000_000 });
      if (discount > gross + 0.001) throw badRequest(`The discount on "${product.name}" is more than its value.`);
      const taxable = round2(gross - discount);
      const gstRate = l.gst_rate_pct === undefined || l.gst_rate_pct === null || l.gst_rate_pct === ''
        ? Number((await sql<any>`SELECT gst_rate_pct FROM hsn_tax_rates WHERE hsn_code = ${product.hsn_code}
                                   AND effective_to IS NULL LIMIT 1`.execute(trx)).rows[0]?.gst_rate_pct ?? 0)
        : num(l.gst_rate_pct, `GST rate for "${product.name}"`, { min: 0, max: 40 });
      let cgst = 0, sgst = 0, igst = 0;
      if (interstate) igst = round2(taxable * gstRate / 100);
      else { cgst = round2(taxable * gstRate / 200); sgst = cgst; }

      const poLineId = optionalUuid(l.po_line_id, 'Order line');
      if (poLineId) {
        const pol = poLines.get(poLineId);
        if (!pol) throw badRequest(`${label} is not on purchase order ${po?.po_number ?? ''}.`);
        if (pol.product_id !== productId) throw badRequest(`${label}: that order line is for a different product.`);
      }
      lines.push({
        product, productId, productUnitId, qtyInUnit, baseQty, ratePerBase, discount, gstRate,
        taxable, cgst, sgst, igst, poLineId,
        batch_number: optionalStr(l.batch_number, 'Batch number', { max: 60 }),
        mfg_date: optionalDate(l.mfg_date, 'Manufacturing date'),
        expiry_date: optionalDate(l.expiry_date, 'Expiry date'),
        serial_numbers: Array.isArray(l.serial_numbers) ? l.serial_numbers.map((s: unknown) => String(s).trim()).filter(Boolean) : [],
      });
    }

    const grossTotal = round2(lines.reduce((s, l) => s + l.taxable + l.discount, 0));
    const discountTotal = round2(lines.reduce((s, l) => s + l.discount, 0));
    const taxableTotal = round2(lines.reduce((s, l) => s + l.taxable, 0));
    const cgstTotal = round2(lines.reduce((s, l) => s + l.cgst, 0));
    const sgstTotal = round2(lines.reduce((s, l) => s + l.sgst, 0));
    const igstTotal = round2(lines.reduce((s, l) => s + l.igst, 0));
    const exact = round2(taxableTotal + cgstTotal + sgstTotal + igstTotal);
    // The supplier's bill may round to the rupee; entered so the payable matches their paper.
    const roundOff = body.round_off === undefined || body.round_off === null || body.round_off === ''
      ? 0 : num(body.round_off, 'Round off', { min: -1, max: 1 });
    const grandTotal = round2(exact + roundOff);

    const grnNumber = await nextNumber(trx, branchId, 'GRN');
    const grn = (await sql<any>`
      INSERT INTO grn (po_id, branch_id, vendor_id, grn_number, vendor_invoice_no, vendor_invoice_date, notes,
                       interstate, gross_total, discount_total, taxable_total, cgst_total, sgst_total, igst_total,
                       round_off, grand_total, client_txn_id, created_by)
      VALUES (${poId}, ${branchId}, ${vendorId}, ${grnNumber}, ${vendorInvoiceNo}, ${vendorInvoiceDate},
              ${optionalStr(body.notes, 'Notes', { max: 500 })}, ${interstate}, ${grossTotal}, ${discountTotal},
              ${taxableTotal}, ${cgstTotal}, ${sgstTotal}, ${igstTotal}, ${roundOff}, ${grandTotal},
              ${clientTxnId}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      // 4.2 — a batch-tracked item must arrive with a batch, or expiry reporting
      // silently becomes fiction the first time someone skips the field.
      let batchId: string | null = null;
      if (l.product.batch_tracked && settings.enable_batch_tracking) {
        if (!l.batch_number) {
          throw badRequest(`"${l.product.name}" is batch-tracked — enter the batch number from the carton.`);
        }
        batchId = (await sql<any>`
          INSERT INTO stock_batches (branch_id, product_id, batch_number, mfg_date, expiry_date, qty_remaining)
          VALUES (${branchId}, ${l.productId}, ${l.batch_number}, ${l.mfg_date}::date, ${l.expiry_date}::date, ${l.baseQty})
          RETURNING batch_id
        `.execute(trx)).rows[0].batch_id;
      }
      if (l.product.serial_tracked && l.serial_numbers.length && l.serial_numbers.length !== l.baseQty) {
        throw badRequest(`"${l.product.name}": ${l.baseQty} received but ${l.serial_numbers.length} serial numbers entered.`);
      }

      await sql`
        INSERT INTO grn_lines (grn_id, po_line_id, product_id, product_unit_id, qty_in_unit, qty_base_unit, rate,
                               discount_amount, gst_rate_pct, taxable_value, cgst_amount, sgst_amount, igst_amount, batch_id)
        VALUES (${grn.grn_id}, ${l.poLineId}, ${l.productId}, ${l.productUnitId}, ${l.qtyInUnit}, ${l.baseQty},
                ${l.ratePerBase}, ${l.discount}, ${l.gstRate}, ${l.taxable}, ${l.cgst}, ${l.sgst}, ${l.igst}, ${batchId})
      `.execute(trx);

      // Landed cost per base unit: net of the supplier's discount, excluding GST.
      const landedCost = roundTo(l.taxable / l.baseQty, 4);
      await applyMovement(trx, {
        branchId, productId: l.productId, qtyChange: l.baseQty,
        movementType: 'PURCHASE', refTable: 'grn', refId: grn.grn_id,
        userId: session.user_id, inboundRate: landedCost,
      });

      for (const serial of l.serial_numbers) {
        await sql`
          INSERT INTO stock_serials (branch_id, product_id, serial_number, status)
          VALUES (${branchId}, ${l.productId}, ${serial}, 'IN_STOCK')
          ON CONFLICT (product_id, serial_number) DO UPDATE SET status = 'IN_STOCK', branch_id = ${branchId}
        `.execute(trx);
      }

      // 4.9 — remember what this vendor last charged, which feeds the next PO.
      await sql`
        INSERT INTO vendor_product_map (vendor_id, product_id, last_purchase_rate)
        VALUES (${vendorId}, ${l.productId}, ${landedCost})
        ON CONFLICT (vendor_id, product_id) DO UPDATE SET last_purchase_rate = ${landedCost}
      `.execute(trx);
    }

    // Section 8 — the payable ledger mirrors the customer credit ledger, with a
    // running balance rather than a bare list of amounts.
    await postVendor(trx, {
      vendorId, branchId, entryType: 'GRN_PAYABLE', amount: grandTotal,
      refTable: 'grn', refId: grn.grn_id,
    });

    // Paid on delivery (common for small local suppliers): a payment voucher
    // against this bill, in the same transaction.
    let paidNow: any = null;
    if (body.paid_amount !== undefined && body.paid_amount !== null && Number(body.paid_amount) > 0) {
      const amount = round2(num(body.paid_amount, 'Amount paid', { min: 0.01, max: grandTotal }));
      const method = oneOf(body.paid_method ?? 'CASH', 'Payment method', ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'] as const);
      const reference = optionalStr(body.paid_reference, 'Payment reference', { max: 80 });
      if ((method === 'BANK_TRANSFER' || method === 'CHEQUE') && !reference) {
        throw badRequest(method === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the bank transfer reference (UTR).');
      }
      // The same people who may record any vendor payment (record_vendor_payment).
      if (!canAccess(session.role, 'record_vendor_payment')) {
        throw forbidden('Only the accountant or the owner can record a payment to a vendor. Save the purchase unpaid; they can pay it from the vendor screen.');
      }
      const number = await nextNumber(trx, branchId, 'VENDOR_PAYMENT');
      paidNow = (await sql<any>`
        INSERT INTO vendor_payments (payment_number, vendor_id, branch_id, grn_id, amount, method, reference, created_by)
        VALUES (${number}, ${vendorId}, ${branchId}, ${grn.grn_id}, ${amount}, ${method}, ${reference}, ${session.user_id})
        RETURNING *
      `.execute(trx)).rows[0];
      await postVendor(trx, {
        vendorId, branchId, entryType: 'PAYMENT_MADE', amount: -amount,
        refTable: 'vendor_payments', refId: paidNow.payment_id,
      });
      await audit(trx, session, 'VENDOR_PAYMENT', 'vendors', vendorId,
        { after: { payment_number: number, amount, method, grn_number: grnNumber } }, { branchId });
    }

    // A partial delivery keeps the order open; it is RECEIVED only when every line is.
    if (po) {
      const pending = (await sql<{ n: string }>`
        SELECT count(*) AS n FROM purchase_order_lines pol
         WHERE pol.po_id = ${poId}
           AND pol.qty_base_unit > COALESCE((SELECT SUM(gl.qty_base_unit) FROM grn_lines gl WHERE gl.po_line_id = pol.po_line_id), 0) + 0.0001
      `.execute(trx)).rows[0];
      const received = (await sql<{ n: string }>`
        SELECT count(*) AS n FROM grn_lines gl JOIN purchase_order_lines pol ON pol.po_line_id = gl.po_line_id
         WHERE pol.po_id = ${poId}
      `.execute(trx)).rows[0];
      // A receipt against the order with no lines tied to order lines is treated as
      // receiving the whole order, which is how the older client posted it.
      const status = Number(received.n) === 0 || Number(pending.n) === 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
      await sql`UPDATE purchase_orders SET status = ${status}::po_status WHERE po_id = ${poId}`.execute(trx);
    }

    await audit(trx, session, 'GRN_CREATED', 'grn', grn.grn_id, {
      after: { grn_number: grnNumber, vendor: vendor.name, vendor_invoice_no: vendorInvoiceNo,
               grand_total: grandTotal, lines: lines.length, po_id: poId },
    }, { branchId });
    return { ...grn, total_value: grandTotal, payment: paidNow, vendor_balance: await vendorBalance(trx, vendorId) };
  }));

  /**
   * 4.5.1 — purchase return. This is not just "take the stock back": ITC was
   * claimed on the original GRN, so a formal vendor debit note (its own number
   * series) is what actually reverses it — including the GST — and it comes off
   * the payable at the bill's own rate and tax.
   */
  app.post('/purchase-returns', guarded('create_purchase_return', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const grnId = uuid(body.grn_id, 'Goods receipt');
    const reason = str(body.reason, 'Reason', { max: 300 });

    const grn = (await sql<any>`SELECT * FROM grn WHERE grn_id = ${grnId} FOR UPDATE`.execute(trx)).rows[0];
    if (!grn) throw notFound('That goods receipt was not found at your branch.');

    const lines = arrayOf(body.lines, 'Items', (l, i) => ({
      grn_line_id: uuid(l.grn_line_id, `Item ${i + 1}`),
      qty_base_unit: num(l.qty_base_unit, `Quantity (item ${i + 1})`, { min: 0.0001, max: 1e9 }),
    }));

    const debitNoteNumber = await nextNumber(trx, grn.branch_id, 'DEBIT_NOTE');
    const dn = (await sql<any>`
      INSERT INTO vendor_debit_notes (debit_note_number, grn_id, vendor_id, branch_id, reason, total_amount, created_by)
      VALUES (${debitNoteNumber}, ${grnId}, ${grn.vendor_id}, ${grn.branch_id}, ${reason}, 0, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    let taxableTotal = 0, taxTotal = 0;
    const claimed = new Map<string, number>();
    for (const l of lines) {
      const grnLine = (await sql<any>`
        SELECT gl.*, p.name AS product_name,
               COALESCE((SELECT SUM(qty_base_unit) FROM vendor_debit_note_lines WHERE grn_line_id = gl.grn_line_id), 0) AS already_returned
          FROM grn_lines gl JOIN products p ON p.product_id = gl.product_id
         WHERE gl.grn_line_id = ${l.grn_line_id} AND gl.grn_id = ${grnId}
      `.execute(trx)).rows[0];
      if (!grnLine) throw badRequest('One of the return lines does not belong to that goods receipt.');

      const inThis = claimed.get(l.grn_line_id) ?? 0;
      const remaining = roundTo(Number(grnLine.qty_base_unit) - Number(grnLine.already_returned) - inThis, 4);
      if (l.qty_base_unit > remaining + 0.0001) {
        throw badRequest(`Only ${remaining} of "${grnLine.product_name}" is left to return on this receipt.`);
      }
      claimed.set(l.grn_line_id, inThis + l.qty_base_unit);

      // Proportional to the original line, so the debit note's taxable value and
      // GST exactly mirror what was charged — including any discount — for the
      // share being returned.
      const share = l.qty_base_unit / Number(grnLine.qty_base_unit);
      const taxable = round2(Number(grnLine.taxable_value || Number(grnLine.qty_base_unit) * Number(grnLine.rate)) * share);
      const tax = round2((Number(grnLine.cgst_amount) + Number(grnLine.sgst_amount) + Number(grnLine.igst_amount)) * share);
      taxableTotal = round2(taxableTotal + taxable);
      taxTotal = round2(taxTotal + tax);

      await sql`
        INSERT INTO vendor_debit_note_lines (debit_note_id, grn_line_id, qty_base_unit, rate, taxable_value, tax_amount)
        VALUES (${dn.debit_note_id}, ${l.grn_line_id}, ${l.qty_base_unit}, ${grnLine.rate}, ${taxable}, ${tax})
      `.execute(trx);

      // Stock leaves at the ORIGINAL receipt's landed cost, not today's average —
      // otherwise returning goods would silently move the valuation of what stays.
      await applyMovement(trx, {
        branchId: grn.branch_id, productId: grnLine.product_id, qtyChange: -l.qty_base_unit,
        movementType: 'PURCHASE_RETURN', refTable: 'vendor_debit_notes', refId: dn.debit_note_id,
        reasonCode: reason, userId: session.user_id,
        inboundRate: roundTo(taxable / l.qty_base_unit, 4),
      });
      if (grnLine.batch_id) {
        await sql`UPDATE stock_batches SET qty_remaining = GREATEST(qty_remaining - ${l.qty_base_unit}, 0)
                   WHERE batch_id = ${grnLine.batch_id}`.execute(trx);
      }
    }
    const total = round2(taxableTotal + taxTotal);

    await sql`UPDATE vendor_debit_notes SET taxable_total = ${taxableTotal}, tax_total = ${taxTotal}, total_amount = ${total}
               WHERE debit_note_id = ${dn.debit_note_id}`.execute(trx);

    await postVendor(trx, {
      vendorId: grn.vendor_id, branchId: grn.branch_id, entryType: 'DEBIT_NOTE', amount: -total,
      refTable: 'vendor_debit_notes', refId: dn.debit_note_id,
    });

    await audit(trx, session, 'DEBIT_NOTE_ISSUED', 'vendor_debit_notes', dn.debit_note_id,
      { after: { debit_note_number: debitNoteNumber, total, taxable: taxableTotal, tax: taxTotal, grn_id: grnId } },
      { branchId: grn.branch_id });
    return {
      ...dn, taxable_total: taxableTotal, tax_total: taxTotal, total_amount: total,
      itc_reversal_note: 'Report this debit note for ITC reversal in the period it was issued.',
    };
  }));

  app.get('/purchase-returns', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT dn.*, v.name AS vendor_name, g.grn_number, g.vendor_invoice_no, b.name AS branch_name,
             u.full_name AS created_by_name
        FROM vendor_debit_notes dn
        JOIN vendors v ON v.vendor_id = dn.vendor_id
        JOIN grn g ON g.grn_id = dn.grn_id
        JOIN branches b ON b.branch_id = dn.branch_id
        LEFT JOIN users u ON u.user_id = dn.created_by
       WHERE 1=1 ${branchId ? sql`AND dn.branch_id = ${branchId}` : sql``}
       ORDER BY dn.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  // ── Inter-branch transfers (4.4, 4.4.1) ───────────────────────────────────
  app.get('/transfers', guarded('view_inventory', async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    // RLS already limits a branch user to transfers where they are the sender or
    // the receiver, so no extra WHERE is needed here.
    return (await sql<any>`
      SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
             u.full_name AS requested_by_name,
             (SELECT count(*) FROM stock_transfer_lines WHERE transfer_id = t.transfer_id) AS line_count,
             (SELECT COALESCE(SUM(discrepancy_qty) FILTER (WHERE received_qty IS NOT NULL), 0)
                FROM stock_transfer_lines WHERE transfer_id = t.transfer_id) AS total_discrepancy
        FROM stock_transfers t
        JOIN branches fb ON fb.branch_id = t.from_branch_id
        JOIN branches tb ON tb.branch_id = t.to_branch_id
        LEFT JOIN users u ON u.user_id = t.requested_by
       WHERE 1=1 ${q.status ? sql`AND t.status = ${oneOf(q.status, 'status',
         ['REQUESTED', 'DISPATCHED', 'RECEIVED', 'TRANSFER_DISCREPANCY', 'CLOSED', 'CANCELLED'] as const)}::transfer_status` : sql``}
       ORDER BY t.created_at DESC
       LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.get('/transfers/:id', guarded('view_inventory', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const t = (await sql<any>`
      SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name,
             ru.full_name AS requested_by_name, du.full_name AS dispatched_by_name,
             rcu.full_name AS received_by_name, cu.full_name AS cancelled_by_name
        FROM stock_transfers t JOIN branches fb ON fb.branch_id = t.from_branch_id
        JOIN branches tb ON tb.branch_id = t.to_branch_id
        LEFT JOIN users ru ON ru.user_id = t.requested_by
        LEFT JOIN users du ON du.user_id = t.dispatched_by
        LEFT JOIN users rcu ON rcu.user_id = t.received_by
        LEFT JOIN users cu ON cu.user_id = t.cancelled_by
       WHERE t.transfer_id = ${id}
    `.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    const lines = (await sql<any>`
      SELECT stl.*, p.name AS product_name, p.sku, p.base_unit, u.print_label AS base_unit_label
        FROM stock_transfer_lines stl JOIN products p ON p.product_id = stl.product_id
        JOIN units u ON u.unit_code = p.base_unit
       WHERE stl.transfer_id = ${id} ORDER BY p.name
    `.execute(trx)).rows;
    return { ...t, lines };
  }));

  app.post('/transfers', guarded('create_transfer', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const fromBranch = writeBranch(session, body.from_branch_id);
    const toBranch = uuid(body.to_branch_id, 'Destination branch');
    if (fromBranch === toBranch) throw badRequest('The sending and receiving branches must be different.');

    // The destination is read through the system catalog of branches, which every
    // session may see; the transfer itself stays visible to both ends by RLS.
    const dest = (await sql<any>`SELECT branch_id, state_code, is_active, name FROM branches WHERE branch_id = ${toBranch}`.execute(trx)).rows[0];
    const src = (await sql<any>`SELECT branch_id, state_code FROM branches WHERE branch_id = ${fromBranch}`.execute(trx)).rows[0];
    if (!dest || !dest.is_active) throw notFound('Destination branch not found.');

    const lines = arrayOf(body.lines, 'Items', (l, i) => ({
      product_id: uuid(l.product_id, `Item ${i + 1}`),
      qty: num(l.dispatched_qty ?? l.qty_base_unit ?? l.qty, `Quantity (item ${i + 1})`, { min: 0.0001, max: 1e9 }),
    }), { min: 1, max: 300 });
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.product_id)) throw badRequest('A product appears twice on this transfer. Combine the quantities.');
      seen.add(l.product_id);
    }

    const number = await nextNumber(trx, fromBranch, 'TRANSFER');
    const transfer = (await sql<any>`
      INSERT INTO stock_transfers (transfer_number, from_branch_id, to_branch_id, status, transfer_doc_type,
                                   driver_ref, notes, requested_by)
      VALUES (${number}, ${fromBranch}, ${toBranch}, 'REQUESTED',
              ${src?.state_code === dest.state_code ? 'INTRASTATE' : 'INTERSTATE'},
              ${optionalStr(body.driver_ref, 'Vehicle / driver reference', { max: 80 })},
              ${optionalStr(body.notes, 'Notes', { max: 500 })}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      await sql`
        INSERT INTO stock_transfer_lines (transfer_id, product_id, dispatched_qty)
        VALUES (${transfer.transfer_id}, ${l.product_id}, ${l.qty})
      `.execute(trx);
    }
    await audit(trx, session, 'TRANSFER_CREATED', 'stock_transfers', transfer.transfer_id,
      { after: { transfer_number: number, to: dest.name, lines: lines.length } }, { branchId: fromBranch });
    return transfer;
  }));

  app.post('/transfers/:id/dispatch', guarded('create_transfer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'REQUESTED') throw badRequest(`This transfer is already ${t.status.toLowerCase().replace(/_/g, ' ')}.`);
    if (session.role !== 'OWNER_ADMIN' && t.from_branch_id !== session.branch_id) {
      throw forbidden('Only the sending branch can dispatch a transfer.');
    }

    const lines = (await sql<any>`
      SELECT stl.*, p.name AS product_name FROM stock_transfer_lines stl
        JOIN products p ON p.product_id = stl.product_id WHERE stl.transfer_id = ${id}
       ORDER BY stl.product_id
    `.execute(trx)).rows;

    for (const l of lines) {
      // Checked here with a readable message; the database trigger would refuse it
      // anyway, but "not enough Havells wire at Andheri" beats a generic error.
      const stock = (await sql<any>`
        SELECT base_unit_qty - reserved_qty AS available FROM branch_stock
         WHERE branch_id = ${t.from_branch_id} AND product_id = ${l.product_id}
      `.execute(trx)).rows[0];
      if (Number(stock?.available ?? 0) + 1e-9 < Number(l.dispatched_qty)) {
        throw conflict(`Not enough "${l.product_name}" to send: ${Number(l.dispatched_qty)} requested, ${Math.max(Number(stock?.available ?? 0), 0)} available.`);
      }
      // 4.8.1 — capture the sending branch's cost ON THE LINE at dispatch.
      //
      // The receiving branch cannot read it later: branch_stock is strictly
      // branch-scoped by RLS, so a lookup against the sender from the receiver's
      // session returns nothing, and the goods would arrive valued at zero.
      // Moving stock around the chain must not invent or destroy margin.
      const senderCost = (await sql<any>`
        SELECT weighted_avg_cost FROM branch_stock
         WHERE branch_id = ${t.from_branch_id} AND product_id = ${l.product_id}
      `.execute(trx)).rows[0]?.weighted_avg_cost;

      await sql`
        UPDATE stock_transfer_lines SET dispatch_cost = ${senderCost ?? null} WHERE line_id = ${l.line_id}
      `.execute(trx);

      // Stock leaves the sender NOW; it does not arrive anywhere until it is
      // received, so in-transit inventory is visible as exactly that rather than
      // being counted twice or vanishing.
      await applyMovement(trx, {
        branchId: t.from_branch_id, productId: l.product_id, qtyChange: -Number(l.dispatched_qty),
        movementType: 'TRANSFER_OUT', refTable: 'stock_transfers', refId: id, userId: session.user_id,
      });
    }

    await sql`
      UPDATE stock_transfers SET status = 'DISPATCHED', dispatched_at = now(), dispatched_by = ${session.user_id},
             driver_ref = COALESCE(${optionalStr((req.body as any)?.driver_ref, 'Driver reference', { max: 80 })}, driver_ref)
       WHERE transfer_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'TRANSFER_DISPATCH', 'stock_transfers', id,
      { after: { transfer_number: t.transfer_number, lines: lines.length } }, { branchId: t.from_branch_id });
    return { ok: true };
  }));

  /** Only a transfer that has not left can be cancelled — nothing has moved yet. */
  app.post('/transfers/:id/cancel', guarded('create_transfer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'REQUESTED') {
      throw badRequest(t.status === 'CANCELLED' ? 'This transfer is already cancelled.'
        : 'Only a transfer that has not been dispatched can be cancelled. Once goods are in transit, receive them (short if needed).');
    }
    if (session.role !== 'OWNER_ADMIN' && t.from_branch_id !== session.branch_id) {
      throw forbidden('Only the sending branch can cancel a transfer.');
    }
    await sql`UPDATE stock_transfers SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = ${session.user_id}
               WHERE transfer_id = ${id}`.execute(trx);
    await audit(trx, session, 'TRANSFER_CANCELLED', 'stock_transfers', id,
      { after: { transfer_number: t.transfer_number, reason: optionalStr((req.body as any)?.reason, 'Reason', { max: 300 }) } },
      { branchId: t.from_branch_id });
    return { ok: true };
  }));

  /** 4.4.1 — receiving is where the discrepancy case lives. */
  app.post('/transfers/:id/receive', guarded('receive_transfer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'DISPATCHED') throw badRequest('That transfer is not currently in transit.');
    if (session.role !== 'OWNER_ADMIN' && t.to_branch_id !== session.branch_id) {
      throw forbidden('Only the receiving branch can mark a transfer as received.');
    }

    const received = arrayOf(body.lines, 'lines', (l) => ({
      line_id: uuid(l.line_id, 'Transfer line'),
      received_qty: num(l.received_qty, 'Received quantity', { min: 0, max: 1e9 }),
    }));
    const allLines = (await sql<any>`SELECT line_id FROM stock_transfer_lines WHERE transfer_id = ${id}`.execute(trx)).rows;
    if (received.length !== allLines.length || !allLines.every((l: any) => received.some((r) => r.line_id === l.line_id))) {
      throw badRequest('Enter the received quantity for every line on the transfer (0 if it did not arrive).');
    }

    let anyDiscrepancy = false;
    for (const r of received) {
      const line = (await sql<any>`
        SELECT * FROM stock_transfer_lines WHERE line_id = ${r.line_id} AND transfer_id = ${id}
      `.execute(trx)).rows[0];
      if (!line) throw badRequest('One of the lines does not belong to this transfer.');
      if (r.received_qty > Number(line.dispatched_qty) + 0.0001) {
        throw badRequest('More cannot arrive than was dispatched. Record the extra as a separate stock adjustment.');
      }

      await sql`UPDATE stock_transfer_lines SET received_qty = ${r.received_qty} WHERE line_id = ${r.line_id}`.execute(trx);

      // Only what actually arrived is added. The system does NOT quietly adjust
      // either side to force the numbers to match (4.4.1) — the shortfall stays
      // visible as a variance until an admin adjudicates it.
      if (r.received_qty > 0) {
        await applyMovement(trx, {
          branchId: t.to_branch_id, productId: line.product_id, qtyChange: r.received_qty,
          movementType: 'TRANSFER_IN', refTable: 'stock_transfers', refId: id,
          userId: session.user_id,
          // 4.8.1 — the cost travels with the goods, recorded on the line at
          // dispatch, because the receiver's session cannot see the sender's stock.
          inboundRate: line.dispatch_cost != null ? Number(line.dispatch_cost) : null,
        });
      }
      if (Math.abs(Number(line.dispatched_qty) - r.received_qty) > 0.0001) anyDiscrepancy = true;
    }

    const status = anyDiscrepancy ? 'TRANSFER_DISCREPANCY' : 'RECEIVED';
    await sql`
      UPDATE stock_transfers SET status = ${status}::transfer_status, received_at = now(), received_by = ${session.user_id}
       WHERE transfer_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'TRANSFER_RECEIVE', 'stock_transfers', id,
      { after: { transfer_number: t.transfer_number, status, discrepancy: anyDiscrepancy } }, { branchId: t.to_branch_id });

    return {
      ok: true, status,
      message: anyDiscrepancy
        ? 'Quantities did not match what was dispatched. This transfer is held for the owner to resolve as a write-off or a counting correction.'
        : 'Transfer received in full.',
      };
  }));

  /** 4.4.1 — the Admin adjudication step: write it off, or correct the count. */
  app.post('/transfers/:id/resolve', guarded('resolve_transfer_discrepancy', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const resolution = oneOf(body.resolution, 'Resolution', ['WRITE_OFF', 'COUNT_CORRECTION'] as const);
    const responsibleBranch = uuid(body.responsible_branch_id, 'Responsible branch');

    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'TRANSFER_DISCREPANCY') throw badRequest('That transfer has no open discrepancy.');
    if (![t.from_branch_id, t.to_branch_id].includes(responsibleBranch)) {
      throw badRequest('The responsible branch must be one of the two branches on this transfer.');
    }

    const lines = (await sql<any>`
      SELECT * FROM stock_transfer_lines WHERE transfer_id = ${id} AND discrepancy_qty <> 0
    `.execute(trx)).rows;

    for (const line of lines) {
      const variance = Number(line.discrepancy_qty);
      if (resolution === 'WRITE_OFF') {
        // The goods that never arrived are a loss. They have already left the
        // sender's stock (at dispatch) and never entered the receiver's, so the
        // loss is RECORDED against the responsible branch as a write-off for the
        // shrinkage report — without moving stock a second time.
        await sql`
          INSERT INTO stock_writeoffs (branch_id, product_id, qty_base_unit, reason_code, ref_transfer_line_id, created_by)
          VALUES (${responsibleBranch}, ${line.product_id}, ${variance}, 'TRANSFER_LOSS', ${line.line_id}, ${session.user_id})
        `.execute(trx);
      } else {
        // A counting error: the goods did arrive, so the receiver's count is corrected.
        await applyMovement(trx, {
          branchId: t.to_branch_id, productId: line.product_id, qtyChange: variance,
          movementType: 'COUNT_ADJUSTMENT', refTable: 'stock_transfers', refId: id,
          reasonCode: 'TRANSFER_COUNT_CORRECTION', userId: session.user_id,
          inboundRate: line.dispatch_cost != null ? Number(line.dispatch_cost) : null,
        });
      }
      await sql`
        UPDATE stock_transfer_lines SET resolution = ${resolution}, resolved_by = ${session.user_id}, resolved_at = now()
         WHERE line_id = ${line.line_id}
      `.execute(trx);
    }

    await sql`UPDATE stock_transfers SET status = 'CLOSED', closed_at = now() WHERE transfer_id = ${id}`.execute(trx);
    await audit(trx, session, 'TRANSFER_DISCREPANCY_RESOLVED', 'stock_transfers', id,
      { after: { resolution, responsible_branch_id: responsibleBranch, lines: lines.length } });
    return { ok: true };
  }));

  // ── Stock audit (4.6) ─────────────────────────────────────────────────────
  app.get('/stock-audits', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT sa.*, b.name AS branch_name, u.full_name AS created_by_name,
             (SELECT count(*) FROM stock_audit_lines WHERE audit_id = sa.audit_id) AS line_count,
             (SELECT count(*) FROM stock_audit_lines WHERE audit_id = sa.audit_id AND variance_qty <> 0) AS variance_count
        FROM stock_audits sa JOIN branches b ON b.branch_id = sa.branch_id
        LEFT JOIN users u ON u.user_id = sa.created_by
       WHERE 1=1 ${branchId ? sql`AND sa.branch_id = ${branchId}` : sql``}
       ORDER BY sa.started_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.get('/stock-audits/:id', guarded('view_inventory', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'audit_id');
    const audit_ = (await sql<any>`
      SELECT sa.*, b.name AS branch_name FROM stock_audits sa
        JOIN branches b ON b.branch_id = sa.branch_id WHERE sa.audit_id = ${id}
    `.execute(trx)).rows[0];
    if (!audit_) throw notFound('Stock audit not found.');
    const lines = (await sql<any>`
      SELECT sal.*, p.name AS product_name, p.sku, p.base_unit,
             (SELECT print_label FROM units WHERE unit_code = p.base_unit) AS base_unit_label
        FROM stock_audit_lines sal JOIN products p ON p.product_id = sal.product_id
       WHERE sal.audit_id = ${id} ORDER BY abs(sal.variance_qty) DESC
    `.execute(trx)).rows;
    return { ...audit_, lines };
  }));

  app.post('/stock-audits', guarded('run_stock_audit', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const open = (await sql<any>`
      SELECT audit_id FROM stock_audits WHERE branch_id = ${branchId} AND status = 'IN_PROGRESS'
    `.execute(trx)).rows[0];
    if (open) return (await sql<any>`SELECT * FROM stock_audits WHERE audit_id = ${open.audit_id}`.execute(trx)).rows[0];
    const row = (await sql<any>`
      INSERT INTO stock_audits (branch_id, created_by) VALUES (${branchId}, ${session.user_id}) RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  app.post('/stock-audits/:id/complete', guarded('run_stock_audit', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'audit_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const counts = arrayOf(body.counts, 'counts', (c) => ({
      product_id: uuid(c.product_id, 'Product'),
      counted_qty: num(c.counted_qty, 'Counted quantity', { min: 0, max: 1e9 }) }), { min: 1, max: 5000,
    });

    const a = (await sql<any>`SELECT * FROM stock_audits WHERE audit_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!a) throw notFound('Stock audit not found.');
    if (a.status === 'COMPLETED') throw badRequest('That audit has already been completed.');

    let varianceLines = 0;
    for (const c of counts) {
      const systemQty = Number((await sql<any>`
        SELECT base_unit_qty FROM branch_stock WHERE branch_id = ${a.branch_id} AND product_id = ${c.product_id}
      `.execute(trx)).rows[0]?.base_unit_qty ?? 0);

      await sql`
        INSERT INTO stock_audit_lines (audit_id, product_id, system_qty, counted_qty)
        VALUES (${id}, ${c.product_id}, ${systemQty}, ${c.counted_qty})
      `.execute(trx);

      const variance = roundTo(c.counted_qty - systemQty, 4);
      if (Math.abs(variance) > 0.0001) {
        varianceLines++;
        // The correction goes through the ledger with a COUNT_ADJUSTMENT reason,
        // so shrinkage is traceable rather than the balance silently changing.
        await applyMovement(trx, {
          branchId: a.branch_id, productId: c.product_id, qtyChange: variance,
          movementType: 'COUNT_ADJUSTMENT', refTable: 'stock_audits', refId: id,
          reasonCode: 'PHYSICAL_COUNT', userId: session.user_id,
        });
      }
    }

    await sql`UPDATE stock_audits SET status = 'COMPLETED', completed_at = now() WHERE audit_id = ${id}`.execute(trx);
    await audit(trx, session, 'STOCK_ADJUSTMENT', 'stock_audits', id,
      { after: { counted: counts.length, variance_lines: varianceLines } }, { branchId: a.branch_id });
    return { ok: true, counted: counts.length, variance_lines: varianceLines };
  }));

  // ── Write-offs (4.7) ──────────────────────────────────────────────────────
  app.get('/write-offs', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT sw.*, p.name AS product_name, p.sku, p.base_unit,
             (SELECT print_label FROM units WHERE unit_code = p.base_unit) AS base_unit_label,
             b.name AS branch_name, u.full_name AS created_by_name
        FROM stock_writeoffs sw JOIN products p ON p.product_id = sw.product_id
        JOIN branches b ON b.branch_id = sw.branch_id
        LEFT JOIN users u ON u.user_id = sw.created_by
       WHERE 1=1 ${branchId ? sql`AND sw.branch_id = ${branchId}` : sql``}
       ORDER BY sw.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.post('/write-offs', guarded('approve_write_off', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const productId = uuid(body.product_id, 'Product');
    const reason = oneOf(body.reason_code, 'Reason',
      ['DAMAGED', 'EXPIRED', 'TRANSFER_LOSS', 'THEFT', 'SAMPLE', 'OTHER'] as const);
    const qtyInUnit = num(body.qty ?? body.qty_base_unit, 'Quantity', { min: 0.0001, max: 1e9 });
    const { product, baseQty } = await toBaseQty(trx, productId,
      body.qty === undefined ? null : optionalUuid(body.product_unit_id, 'Unit'), qtyInUnit, 'Write-off');

    const row = (await sql<any>`
      INSERT INTO stock_writeoffs (branch_id, product_id, qty_base_unit, reason_code, created_by)
      VALUES (${branchId}, ${productId}, ${baseQty}, ${reason}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    await applyMovement(trx, {
      branchId, productId, qtyChange: -baseQty, movementType: 'WRITE_OFF',
      refTable: 'stock_writeoffs', refId: row.writeoff_id, reasonCode: reason, userId: session.user_id,
    });
    await audit(trx, session, 'WRITE_OFF', 'stock_writeoffs', row.writeoff_id,
      { after: { product: product.name, qty: baseQty, reason } }, { branchId });
    return row;
  }));

  // ── Batches & expiry (4.2) ────────────────────────────────────────────────
  app.get('/batches', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT sb.*, p.name AS product_name, p.sku, b.name AS branch_name,
             (sb.expiry_date - CURRENT_DATE) AS days_to_expiry
        FROM stock_batches sb JOIN products p ON p.product_id = sb.product_id
        JOIN branches b ON b.branch_id = sb.branch_id
       WHERE sb.qty_remaining > 0
         ${branchId ? sql`AND sb.branch_id = ${branchId}` : sql``}
         ${q.product_id ? sql`AND sb.product_id = ${uuid(q.product_id, 'product_id')}` : sql``}
         ${q.expiring_soon === 'true' ? sql`AND sb.expiry_date IS NOT NULL AND sb.expiry_date <= CURRENT_DATE + 90` : sql``}
       ORDER BY sb.expiry_date NULLS LAST LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx)).rows;
  }));

  app.get('/serials', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT ss.*, p.name AS product_name, b.name AS branch_name
        FROM stock_serials ss JOIN products p ON p.product_id = ss.product_id
        JOIN branches b ON b.branch_id = ss.branch_id
       WHERE 1=1 ${branchId ? sql`AND ss.branch_id = ${branchId}` : sql``}
         ${q.product_id ? sql`AND ss.product_id = ${uuid(q.product_id, 'product_id')}` : sql``}
         ${q.status ? sql`AND ss.status = ${oneOf(q.status, 'status', ['IN_STOCK', 'SOLD', 'RETURNED', 'WARRANTY_CLAIM', 'WRITTEN_OFF'] as const)}::serial_status` : sql``}
       ORDER BY p.name, ss.serial_number LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx)).rows;
  }));

  // ── Dead / slow-moving stock (4.9) ────────────────────────────────────────
  app.get('/dead-stock', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const days = Math.min(Math.max(Number(q.days) || 60, 7), 365);
    const settings = await loadSettings(trx, session.branch_id);

    const rows = await sql<any>`
      SELECT bs.product_id, p.name AS product_name, p.sku, bs.branch_id, b.name AS branch_name,
             bs.base_unit_qty, bs.weighted_avg_cost,
             bs.base_unit_qty * bs.weighted_avg_cost AS tied_up_value,
             ls.last_sale,
             CASE WHEN ls.last_sale IS NULL THEN NULL
                  ELSE (CURRENT_DATE - ls.last_sale::date) END AS days_since_sale
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id AND p.is_active
        JOIN branches b ON b.branch_id = bs.branch_id
        LEFT JOIN LATERAL (
            SELECT MAX(created_at) AS last_sale FROM stock_ledger sl
             WHERE sl.product_id = bs.product_id AND sl.branch_id = bs.branch_id
               AND sl.movement_type = 'SALE'
        ) ls ON TRUE
       WHERE bs.base_unit_qty > 0
         ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
         AND (ls.last_sale IS NULL OR ls.last_sale < now() - (${days} || ' days')::interval)
       ORDER BY tied_up_value DESC NULLS LAST
       LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx);
    return maskCost(rows.rows, canSeeCost(session.role, settings));
  }));
}
