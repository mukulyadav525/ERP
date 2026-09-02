// ============================================================================
// Section 4 — Inventory & Procurement
//   4.1  every movement lands in stock_ledger with a reason
//   4.2  batch tracking for shelf-life-sensitive categories
//   4.3  reorder thresholds and auto-suggested POs
//   4.4  transfer request -> dispatch -> receive, with 4.4.1 discrepancy state
//   4.5  PO -> GRN -> stock-in -> vendor payable, plus 4.5.1 vendor debit notes
//   4.6  physical stock audit with variance
//   4.7  wastage / damage write-off
//   4.8  weighted-average cost, recalculated only here (4.8.1)
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, oneOf,
  writeBranch, resolveBranchScope, limit as clampLimit, arrayOf,
} from '../../lib/http.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { loadSettings, canSeeCost, maskCost } from '../../lib/settings.js';
import { newWeightedAvgCost, round2, roundTo } from '../../lib/tax.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import type { Tx } from '../../lib/db.js';
import { postVendor } from '../../lib/ledger.js';

/**
 * 4.8.1 — the ONLY function that moves stock. Everything (GRN, transfer, return,
 * write-off, audit correction) goes through here, so branch_stock, the weighted
 * average cost and the ledger can never disagree about how the number got there.
 */
async function applyMovement(trx: Tx, opts: {
  branchId: string; productId: string;
  qtyChange: number;                 // signed, in base units
  movementType: 'PURCHASE' | 'SALE' | 'SALE_RETURN' | 'TRANSFER_OUT' | 'TRANSFER_IN'
              | 'PURCHASE_RETURN' | 'WRITE_OFF' | 'COUNT_ADJUSTMENT';
  refTable: string; refId: string;
  reasonCode?: string | null;
  userId: string;
  /** Supplied for stock-IN movements that carry a cost (GRN, transfer-in). */
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

export default async function inventoryRoutes(app: FastifyInstance) {
  // ── Current stock ─────────────────────────────────────────────────────────
  app.get('/stock', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);

    const rows = await sql<any>`
      SELECT bs.branch_id, b.name AS branch_name, bs.product_id, p.name, p.sku, p.base_unit,
             c.name AS category_name, br.name AS brand_name,
             bs.base_unit_qty, bs.reserved_qty,
             bs.base_unit_qty - bs.reserved_qty AS available_qty,
             bs.weighted_avg_cost, bs.reorder_min, bs.reorder_max, bs.updated_at,
             bs.base_unit_qty * bs.weighted_avg_cost AS stock_value,
             (bs.base_unit_qty <= COALESCE(bs.reorder_min, 0)) AS is_low
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id
        JOIN branches b ON b.branch_id = bs.branch_id
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN brands br ON br.brand_id = p.brand_id
       WHERE p.is_active
         ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
         ${q.low_stock_only === 'true' ? sql`AND bs.base_unit_qty <= COALESCE(bs.reorder_min, 0)` : sql``}
         ${q.q ? sql`AND (p.name ILIKE ${'%' + q.q + '%'} OR p.sku ILIKE ${'%' + q.q + '%'})` : sql``}
       ORDER BY ${q.low_stock_only === 'true' ? sql`bs.base_unit_qty ASC,` : sql``} p.name
       LIMIT ${clampLimit(q.limit, 300, 1000)}
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
    await sql`
      INSERT INTO branch_stock (branch_id, product_id, reorder_min, reorder_max)
      VALUES (${branchId}, ${productId}, ${num(body.reorder_min, 'Reorder minimum', { min: 0 })},
              ${body.reorder_max === undefined ? null : num(body.reorder_max, 'Reorder maximum', { min: 0 })})
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
    const rows = await sql<any>`
      SELECT sl.ledger_id, sl.branch_id, b.name AS branch_name, sl.product_id, p.name AS product_name,
             p.sku, sl.movement_type, sl.base_unit_qty_change, sl.cost_at_movement,
             sl.ref_table, sl.ref_id, sl.reason_code, sl.created_at, u.full_name AS created_by_name
        FROM stock_ledger sl
        JOIN products p ON p.product_id = sl.product_id
        JOIN branches b ON b.branch_id = sl.branch_id
        LEFT JOIN users u ON u.user_id = sl.created_by
       WHERE 1=1
         ${branchId ? sql`AND sl.branch_id = ${branchId}` : sql``}
         ${q.product_id ? sql`AND sl.product_id = ${uuid(q.product_id, 'product_id')}` : sql``}
         ${q.movement_type ? sql`AND sl.movement_type = ${q.movement_type}::stock_movement_type` : sql``}
       ORDER BY sl.created_at DESC
       LIMIT ${clampLimit(q.limit, 100, 500)}
    `.execute(trx);
    return maskCost(rows.rows, canSeeCost(session.role, settings));
  }));

  // ── Purchase orders (4.5) ─────────────────────────────────────────────────
  app.get('/purchase-orders', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const rows = await sql<any>`
      SELECT po.*, v.name AS vendor_name, b.name AS branch_name, u.full_name AS created_by_name,
             (SELECT COALESCE(SUM(qty_base_unit * rate), 0) FROM purchase_order_lines WHERE po_id = po.po_id) AS total_value,
             (SELECT count(*) FROM purchase_order_lines WHERE po_id = po.po_id) AS line_count
        FROM purchase_orders po
        JOIN vendors v ON v.vendor_id = po.vendor_id
        JOIN branches b ON b.branch_id = po.branch_id
        LEFT JOIN users u ON u.user_id = po.created_by
       WHERE 1=1 ${branchId ? sql`AND po.branch_id = ${branchId}` : sql``}
         ${q.status ? sql`AND po.status = ${q.status}::po_status` : sql``}
       ORDER BY po.created_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx);
    return rows.rows;
  }));

  app.get('/purchase-orders/:id', guarded('view_inventory', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'po_id');
    const po = (await sql<any>`
      SELECT po.*, v.name AS vendor_name, v.phone AS vendor_phone, b.name AS branch_name
        FROM purchase_orders po JOIN vendors v ON v.vendor_id = po.vendor_id
        JOIN branches b ON b.branch_id = po.branch_id WHERE po.po_id = ${id}
    `.execute(trx)).rows[0];
    if (!po) throw notFound('Purchase order not found.');
    const lines = (await sql<any>`
      SELECT pol.*, p.name AS product_name, p.sku, p.base_unit
        FROM purchase_order_lines pol JOIN products p ON p.product_id = pol.product_id
       WHERE pol.po_id = ${id}
    `.execute(trx)).rows;
    return { ...po, lines };
  }));

  /** 4.3 — the auto-suggested PO: everything at or below its reorder point, grouped
   *  by the preferred vendor for that item (4.9 vendor-item mapping). */
  app.get('/reorder-suggestions', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id) ?? session.branch_id;
    if (!branchId) throw badRequest('Choose a branch to see reorder suggestions for.');
    const rows = await sql<any>`
      SELECT bs.product_id, p.name AS product_name, p.sku, p.base_unit,
             bs.base_unit_qty, bs.reorder_min, bs.reorder_max,
             GREATEST(COALESCE(bs.reorder_max, bs.reorder_min * 3) - bs.base_unit_qty, 0) AS suggested_qty,
             vpm.vendor_id, v.name AS vendor_name,
             COALESCE(vpm.last_purchase_rate, p.reference_purchase_price) AS expected_rate
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id AND p.is_active
        LEFT JOIN LATERAL (
            SELECT vendor_id, last_purchase_rate FROM vendor_product_map
             WHERE product_id = bs.product_id ORDER BY is_preferred DESC LIMIT 1
        ) vpm ON TRUE
        LEFT JOIN vendors v ON v.vendor_id = vpm.vendor_id
       WHERE bs.branch_id = ${branchId} AND bs.base_unit_qty <= COALESCE(bs.reorder_min, 0)
       ORDER BY v.name NULLS LAST, p.name
    `.execute(trx);
    return rows.rows;
  }));

  app.post('/purchase-orders', guarded('create_purchase_order', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const vendorId = uuid(body.vendor_id, 'Vendor');
    const lines = arrayOf(body.lines, 'lines', (l) => ({
      product_id: uuid(l.product_id, 'lines[].product_id'),
      qty_base_unit: num(l.qty_base_unit, 'lines[].qty_base_unit', { min: 0.0001 }),
      rate: num(l.rate, 'lines[].rate', { min: 0 }),
    }));

    const poNumber = await nextNumber(trx, branchId, 'PO');
    const po = (await sql<any>`
      INSERT INTO purchase_orders (branch_id, vendor_id, po_number, status, created_by)
      VALUES (${branchId}, ${vendorId}, ${poNumber}, 'SENT', ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      await sql`
        INSERT INTO purchase_order_lines (po_id, product_id, qty_base_unit, rate)
        VALUES (${po.po_id}, ${l.product_id}, ${l.qty_base_unit}, ${l.rate})
      `.execute(trx);
    }
    return po;
  }));

  // ── GRN / stock-in (4.5, 4.8.1) ───────────────────────────────────────────
  app.get('/grn', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const settings = await loadSettings(trx, session.branch_id);
    const rows = await sql<any>`
      SELECT g.grn_id, g.grn_number, g.branch_id, b.name AS branch_name, g.po_id,
             v.vendor_id, v.name AS vendor_name, g.received_at, u.full_name AS created_by_name,
             (SELECT COALESCE(SUM(qty_base_unit * rate), 0) FROM grn_lines WHERE grn_id = g.grn_id) AS total_value,
             (SELECT count(*) FROM grn_lines WHERE grn_id = g.grn_id) AS line_count
        FROM grn g
        JOIN vendors v ON v.vendor_id = g.vendor_id
        JOIN branches b ON b.branch_id = g.branch_id
        LEFT JOIN users u ON u.user_id = g.created_by
       WHERE 1=1 ${branchId ? sql`AND g.branch_id = ${branchId}` : sql``}
       ORDER BY g.received_at DESC LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx);
    // total_value is purchase cost — masked for anyone without cost visibility (2.6).
    return canSeeCost(session.role, settings)
      ? rows.rows
      : rows.rows.map(({ total_value, ...rest }: any) => rest);
  }));

  app.get('/grn/:id', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'grn_id');
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const grn = (await sql<any>`
      SELECT g.*, v.name AS vendor_name, v.gstin AS vendor_gstin, b.name AS branch_name
        FROM grn g JOIN vendors v ON v.vendor_id = g.vendor_id
        JOIN branches b ON b.branch_id = g.branch_id WHERE g.grn_id = ${id}
    `.execute(trx)).rows[0];
    if (!grn) throw notFound('Goods receipt not found.');
    const lines = (await sql<any>`
      SELECT gl.*, p.name AS product_name, p.sku, p.base_unit, sb.batch_number, sb.expiry_date,
             COALESCE((SELECT SUM(qty_base_unit) FROM vendor_debit_note_lines WHERE grn_line_id = gl.grn_line_id), 0) AS returned_qty
        FROM grn_lines gl JOIN products p ON p.product_id = gl.product_id
        LEFT JOIN stock_batches sb ON sb.batch_id = gl.batch_id
       WHERE gl.grn_id = ${id}
    `.execute(trx)).rows;
    return { ...grn, lines: maskCost(lines, showCost) };
  }));

  app.post('/grn', guarded('create_grn', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const vendorId = uuid(body.vendor_id, 'Vendor');
    const poId = optionalUuid(body.po_id, 'po_id');
    const settings = await loadSettings(trx, branchId);

    const lines = arrayOf(body.lines, 'lines', (l) => ({
      product_id: uuid(l.product_id, 'lines[].product_id'),
      qty_base_unit: num(l.qty_base_unit, 'lines[].qty_base_unit', { min: 0.0001 }),
      rate: num(l.rate, 'lines[].rate', { min: 0 }),
      batch_number: optionalStr(l.batch_number, 'lines[].batch_number', { max: 60 }),
      mfg_date: optionalStr(l.mfg_date, 'lines[].mfg_date', { max: 20 }),
      expiry_date: optionalStr(l.expiry_date, 'lines[].expiry_date', { max: 20 }),
      serial_numbers: Array.isArray(l.serial_numbers) ? l.serial_numbers.map(String) : [],
    }));

    const grnNumber = await nextNumber(trx, branchId, 'GRN');
    const grn = (await sql<any>`
      INSERT INTO grn (po_id, branch_id, vendor_id, grn_number, created_by)
      VALUES (${poId}, ${branchId}, ${vendorId}, ${grnNumber}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    let total = 0;
    for (const l of lines) {
      const product = (await sql<any>`
        SELECT product_id, name, batch_tracked, serial_tracked FROM products WHERE product_id = ${l.product_id}
      `.execute(trx)).rows[0];
      if (!product) throw badRequest('One of the received items is not in the catalog.');

      // 4.2 — a batch-tracked item must arrive with a batch, or expiry reporting
      // silently becomes fiction the first time someone skips the field.
      let batchId: string | null = null;
      if (product.batch_tracked && settings.enable_batch_tracking) {
        if (!l.batch_number) {
          throw badRequest(`"${product.name}" is batch-tracked — enter the batch number from the carton.`);
        }
        batchId = (await sql<any>`
          INSERT INTO stock_batches (branch_id, product_id, batch_number, mfg_date, expiry_date, qty_remaining)
          VALUES (${branchId}, ${l.product_id}, ${l.batch_number}, ${l.mfg_date}::date, ${l.expiry_date}::date, ${l.qty_base_unit})
          RETURNING batch_id
        `.execute(trx)).rows[0].batch_id;
      }

      await sql`
        INSERT INTO grn_lines (grn_id, product_id, qty_base_unit, rate, batch_id)
        VALUES (${grn.grn_id}, ${l.product_id}, ${l.qty_base_unit}, ${l.rate}, ${batchId})
      `.execute(trx);

      await applyMovement(trx, {
        branchId, productId: l.product_id, qtyChange: l.qty_base_unit,
        movementType: 'PURCHASE', refTable: 'grn', refId: grn.grn_id,
        userId: session.user_id, inboundRate: l.rate,
      });

      for (const serial of l.serial_numbers) {
        await sql`
          INSERT INTO stock_serials (branch_id, product_id, serial_number, status)
          VALUES (${branchId}, ${l.product_id}, ${serial}, 'IN_STOCK')
          ON CONFLICT (product_id, serial_number) DO UPDATE SET status = 'IN_STOCK', branch_id = ${branchId}
        `.execute(trx);
      }

      // 4.9 — remember what this vendor last charged, which feeds the next PO.
      await sql`
        INSERT INTO vendor_product_map (vendor_id, product_id, last_purchase_rate)
        VALUES (${vendorId}, ${l.product_id}, ${l.rate})
        ON CONFLICT (vendor_id, product_id) DO UPDATE SET last_purchase_rate = ${l.rate}
      `.execute(trx);

      total = round2(total + l.qty_base_unit * l.rate);
    }

    // Section 8 — the payable ledger mirrors the customer credit ledger, with a
    // running balance rather than a bare list of amounts.
    await postVendor(trx, {
      vendorId, branchId, entryType: 'GRN_PAYABLE', amount: total,
      refTable: 'grn', refId: grn.grn_id,
    });

    if (poId) {
      await sql`UPDATE purchase_orders SET status = 'RECEIVED' WHERE po_id = ${poId}`.execute(trx);
    }
    return { ...grn, total_value: total };
  }));

  /**
   * 4.5.1 — purchase return. This is not just "take the stock back": ITC was
   * claimed on the original GRN, so a formal vendor debit note (its own number
   * series) is what actually reverses it. A return without one does not
   * reconcile against GSTR-2B.
   */
  app.post('/purchase-returns', guarded('create_purchase_return', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const grnId = uuid(body.grn_id, 'GRN');
    const reason = str(body.reason, 'Reason', { max: 300 });

    const grn = (await sql<any>`SELECT * FROM grn WHERE grn_id = ${grnId}`.execute(trx)).rows[0];
    if (!grn) throw notFound('That goods receipt was not found at your branch.');

    const lines = arrayOf(body.lines, 'lines', (l) => ({
      grn_line_id: uuid(l.grn_line_id, 'lines[].grn_line_id'),
      qty_base_unit: num(l.qty_base_unit, 'lines[].qty_base_unit', { min: 0.0001 }),
    }));

    const debitNoteNumber = await nextNumber(trx, grn.branch_id, 'DEBIT_NOTE');
    const dn = (await sql<any>`
      INSERT INTO vendor_debit_notes (debit_note_number, grn_id, vendor_id, branch_id, reason, total_amount, created_by)
      VALUES (${debitNoteNumber}, ${grnId}, ${grn.vendor_id}, ${grn.branch_id}, ${reason}, 0, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    let total = 0;
    for (const l of lines) {
      const grnLine = (await sql<any>`
        SELECT gl.*, p.name AS product_name,
               COALESCE((SELECT SUM(qty_base_unit) FROM vendor_debit_note_lines WHERE grn_line_id = gl.grn_line_id), 0) AS already_returned
          FROM grn_lines gl JOIN products p ON p.product_id = gl.product_id
         WHERE gl.grn_line_id = ${l.grn_line_id} AND gl.grn_id = ${grnId}
      `.execute(trx)).rows[0];
      if (!grnLine) throw badRequest('One of the return lines does not belong to that goods receipt.');

      const remaining = Number(grnLine.qty_base_unit) - Number(grnLine.already_returned);
      if (l.qty_base_unit > remaining + 0.0001) {
        throw badRequest(`Only ${remaining} of "${grnLine.product_name}" is left to return on this receipt.`);
      }

      await sql`
        INSERT INTO vendor_debit_note_lines (debit_note_id, grn_line_id, qty_base_unit, rate)
        VALUES (${dn.debit_note_id}, ${l.grn_line_id}, ${l.qty_base_unit}, ${grnLine.rate})
      `.execute(trx);

      // Stock leaves at the ORIGINAL GRN's cost, not today's average — otherwise
      // returning goods would silently move the valuation of what stays behind.
      await applyMovement(trx, {
        branchId: grn.branch_id, productId: grnLine.product_id, qtyChange: -l.qty_base_unit,
        movementType: 'PURCHASE_RETURN', refTable: 'vendor_debit_notes', refId: dn.debit_note_id,
        reasonCode: reason, userId: session.user_id, inboundRate: Number(grnLine.rate),
      });
      total = round2(total + l.qty_base_unit * Number(grnLine.rate));
    }

    await sql`UPDATE vendor_debit_notes SET total_amount = ${total} WHERE debit_note_id = ${dn.debit_note_id}`.execute(trx);

    await postVendor(trx, {
      vendorId: grn.vendor_id, branchId: grn.branch_id, entryType: 'DEBIT_NOTE', amount: -total,
      refTable: 'vendor_debit_notes', refId: dn.debit_note_id,
    });

    await audit(trx, session, 'DEBIT_NOTE_ISSUED', 'vendor_debit_notes', dn.debit_note_id,
      { after: { debit_note_number: debitNoteNumber, total, grn_id: grnId } });
    return { ...dn, total_amount: total, itc_reversal_note: 'Report this debit note for ITC reversal in the period it was issued.' };
  }));

  app.get('/purchase-returns', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT dn.*, v.name AS vendor_name, g.grn_number, b.name AS branch_name
        FROM vendor_debit_notes dn
        JOIN vendors v ON v.vendor_id = dn.vendor_id
        JOIN grn g ON g.grn_id = dn.grn_id
        JOIN branches b ON b.branch_id = dn.branch_id
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
             (SELECT COALESCE(SUM(discrepancy_qty), 0) FROM stock_transfer_lines WHERE transfer_id = t.transfer_id) AS total_discrepancy
        FROM stock_transfers t
        JOIN branches fb ON fb.branch_id = t.from_branch_id
        JOIN branches tb ON tb.branch_id = t.to_branch_id
        LEFT JOIN users u ON u.user_id = t.requested_by
       WHERE 1=1 ${q.status ? sql`AND t.status = ${q.status}::transfer_status` : sql``}
       ORDER BY COALESCE(t.dispatched_at, t.received_at, now()) DESC
       LIMIT ${clampLimit(q.limit, 50, 200)}
    `.execute(trx)).rows;
  }));

  app.get('/transfers/:id', guarded('view_inventory', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const t = (await sql<any>`
      SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name
        FROM stock_transfers t JOIN branches fb ON fb.branch_id = t.from_branch_id
        JOIN branches tb ON tb.branch_id = t.to_branch_id WHERE t.transfer_id = ${id}
    `.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    const lines = (await sql<any>`
      SELECT stl.*, p.name AS product_name, p.sku, p.base_unit
        FROM stock_transfer_lines stl JOIN products p ON p.product_id = stl.product_id
       WHERE stl.transfer_id = ${id}
    `.execute(trx)).rows;
    return { ...t, lines };
  }));

  app.post('/transfers', guarded('create_transfer', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const fromBranch = writeBranch(session, body.from_branch_id);
    const toBranch = uuid(body.to_branch_id, 'Destination branch');
    if (fromBranch === toBranch) throw badRequest('The sending and receiving branches must be different.');

    const dest = (await sql<any>`SELECT branch_id, state_code FROM branches WHERE branch_id = ${toBranch}`.execute(trx)).rows[0];
    const src = (await sql<any>`SELECT branch_id, state_code FROM branches WHERE branch_id = ${fromBranch}`.execute(trx)).rows[0];
    if (!dest) throw notFound('Destination branch not found.');

    const lines = arrayOf(body.lines, 'lines', (l) => ({
      product_id: uuid(l.product_id, 'lines[].product_id'),
      qty: num(l.dispatched_qty ?? l.qty_base_unit, 'lines[].dispatched_qty', { min: 0.0001 }),
    }));

    const transfer = (await sql<any>`
      INSERT INTO stock_transfers (from_branch_id, to_branch_id, status, transfer_doc_type, driver_ref, requested_by)
      VALUES (${fromBranch}, ${toBranch}, 'REQUESTED',
              ${src?.state_code === dest.state_code ? 'INTRASTATE' : 'INTERSTATE'},
              ${optionalStr(body.driver_ref, 'Driver reference', { max: 80 })}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    for (const l of lines) {
      await sql`
        INSERT INTO stock_transfer_lines (transfer_id, product_id, dispatched_qty)
        VALUES (${transfer.transfer_id}, ${l.product_id}, ${l.qty})
      `.execute(trx);
    }
    return transfer;
  }));

  app.post('/transfers/:id/dispatch', guarded('create_transfer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id}`.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'REQUESTED') throw badRequest('That transfer has already been dispatched.');
    if (session.role !== 'OWNER_ADMIN' && t.from_branch_id !== session.branch_id) {
      throw forbidden('Only the sending branch can dispatch a transfer.');
    }

    const lines = (await sql<any>`
      SELECT stl.*, p.name AS product_name FROM stock_transfer_lines stl
        JOIN products p ON p.product_id = stl.product_id WHERE stl.transfer_id = ${id}
    `.execute(trx)).rows;

    for (const l of lines) {
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
      UPDATE stock_transfers SET status = 'DISPATCHED', dispatched_at = now(),
             driver_ref = COALESCE(${optionalStr((req.body as any)?.driver_ref, 'Driver reference', { max: 80 })}, driver_ref)
       WHERE transfer_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'TRANSFER_DISPATCH', 'stock_transfers', id, { after: { lines: lines.length } });
    return { ok: true };
  }));

  /** 4.4.1 — receiving is where the discrepancy case lives. */
  app.post('/transfers/:id/receive', guarded('receive_transfer', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'transfer_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id}`.execute(trx)).rows[0];
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'DISPATCHED') throw badRequest('That transfer is not currently in transit.');
    if (session.role !== 'OWNER_ADMIN' && t.to_branch_id !== session.branch_id) {
      throw forbidden('Only the receiving branch can mark a transfer as received.');
    }

    const received = arrayOf(body.lines, 'lines', (l) => ({
      line_id: uuid(l.line_id, 'lines[].line_id'),
      received_qty: num(l.received_qty, 'lines[].received_qty', { min: 0 }),
    }));

    let anyDiscrepancy = false;
    for (const r of received) {
      const line = (await sql<any>`
        SELECT * FROM stock_transfer_lines WHERE line_id = ${r.line_id} AND transfer_id = ${id}
      `.execute(trx)).rows[0];
      if (!line) throw badRequest('One of the lines does not belong to this transfer.');

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
      UPDATE stock_transfers SET status = ${status}::transfer_status, received_at = now()
       WHERE transfer_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'TRANSFER_RECEIVE', 'stock_transfers', id, { after: { status, discrepancy: anyDiscrepancy } });

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

    const t = (await sql<any>`SELECT * FROM stock_transfers WHERE transfer_id = ${id}`.execute(trx)).rows[0];
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
        // The loss is booked against whichever branch is held responsible, and it
        // shows up as a write-off like any other shrinkage (4.7).
        await sql`
          INSERT INTO stock_writeoffs (branch_id, product_id, qty_base_unit, reason_code, ref_transfer_line_id, created_by)
          VALUES (${responsibleBranch}, ${line.product_id}, ${variance}, 'TRANSFER_LOSS', ${line.line_id}, ${session.user_id})
        `.execute(trx);
        if (responsibleBranch === t.to_branch_id) {
          await applyMovement(trx, {
            branchId: responsibleBranch, productId: line.product_id, qtyChange: -variance,
            movementType: 'WRITE_OFF', refTable: 'stock_transfers', refId: id,
            reasonCode: 'TRANSFER_LOSS', userId: session.user_id,
          });
        }
      } else {
        // A counting error: the goods did arrive, so the receiver's count is corrected.
        await applyMovement(trx, {
          branchId: t.to_branch_id, productId: line.product_id, qtyChange: variance,
          movementType: 'COUNT_ADJUSTMENT', refTable: 'stock_transfers', refId: id,
          reasonCode: 'TRANSFER_COUNT_CORRECTION', userId: session.user_id,
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
      SELECT sal.*, p.name AS product_name, p.sku, p.base_unit
        FROM stock_audit_lines sal JOIN products p ON p.product_id = sal.product_id
       WHERE sal.audit_id = ${id} ORDER BY abs(sal.variance_qty) DESC
    `.execute(trx)).rows;
    return { ...audit_, lines };
  }));

  app.post('/stock-audits', guarded('run_stock_audit', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const branchId = writeBranch(session, body.branch_id);
    const row = (await sql<any>`
      INSERT INTO stock_audits (branch_id, created_by) VALUES (${branchId}, ${session.user_id}) RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  app.post('/stock-audits/:id/complete', guarded('run_stock_audit', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'audit_id');
    const body = (req.body ?? {}) as Record<string, any>;
    const counts = arrayOf(body.counts, 'counts', (c) => ({
      product_id: uuid(c.product_id, 'counts[].product_id'),
      counted_qty: num(c.counted_qty, 'counts[].counted_qty', { min: 0 }) }), { min: 1, max: 5000,
    });

    const a = (await sql<any>`SELECT * FROM stock_audits WHERE audit_id = ${id}`.execute(trx)).rows[0];
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
      { after: { counted: counts.length, variance_lines: varianceLines } });
    return { ok: true, counted: counts.length, variance_lines: varianceLines };
  }));

  // ── Write-offs (4.7) ──────────────────────────────────────────────────────
  app.get('/write-offs', guarded('view_inventory', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    return (await sql<any>`
      SELECT sw.*, p.name AS product_name, p.sku, b.name AS branch_name, u.full_name AS created_by_name
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
    const qty = num(body.qty_base_unit, 'Quantity', { min: 0.0001 });
    const reason = oneOf(body.reason_code, 'Reason',
      ['DAMAGED', 'EXPIRED', 'TRANSFER_LOSS', 'THEFT', 'SAMPLE', 'OTHER'] as const);

    const row = (await sql<any>`
      INSERT INTO stock_writeoffs (branch_id, product_id, qty_base_unit, reason_code, created_by)
      VALUES (${branchId}, ${productId}, ${qty}, ${reason}, ${session.user_id})
      RETURNING *
    `.execute(trx)).rows[0];

    await applyMovement(trx, {
      branchId, productId, qtyChange: -qty, movementType: 'WRITE_OFF',
      refTable: 'stock_writeoffs', refId: row.writeoff_id, reasonCode: reason, userId: session.user_id,
    });
    await audit(trx, session, 'WRITE_OFF', 'stock_writeoffs', row.writeoff_id, { after: { productId, qty, reason } });
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
         ${q.status ? sql`AND ss.status = ${q.status}::serial_status` : sql``}
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
