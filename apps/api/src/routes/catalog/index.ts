// ============================================================================
// Section 2 — Catalog & Product Master
// Master data is chain-wide (Section 0), so these rows are visible to every
// authenticated user; what changes by role is who may EDIT them (7.1) and who
// may see cost/margin columns (2.6).
// ============================================================================
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import {
  guarded, uuid, optionalUuid, str, optionalStr, num, bool, oneOf,
  resolveBranchScope, limit as clampLimit,
} from '../../lib/http.js';
import { badRequest, forbidden, notFound, conflict } from '../../lib/errors.js';
import { loadSettings, canSeeCost, maskCost, maskCostOne } from '../../lib/settings.js';
import { audit } from '../../lib/audit.js';
import { round2 } from '../../lib/tax.js';
import type { Tx } from '../../lib/db.js';
import {
  DIMENSIONS, loadUnits, requireUnit, resolveMultiplier, type UnitRow,
} from '../../lib/units.js';

const PRICE_TYPES = ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const;

/**
 * The sale units of a set of products, joined to the units master, in the shape
 * every screen that sells, buys or quotes needs: what to call the unit, how many
 * base units it is, and whether it may be fractional.
 */
const UNITS_JSON = sql`
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'product_unit_id', pu.product_unit_id,
             'unit_code', pu.unit_label,
             'name', um.name,
             'print_label', um.print_label,
             'dimension', um.dimension,
             'multiplier_to_base', pu.multiplier_to_base,
             'allows_fraction', um.allows_fraction,
             'is_default', pu.is_default_sale_unit,
             'is_base', pu.unit_label = p.base_unit)
           ORDER BY (pu.unit_label = p.base_unit) DESC, pu.multiplier_to_base)
      FROM product_units pu JOIN units um ON um.unit_code = pu.unit_label
     WHERE pu.product_id = p.product_id
  ), '[]'::jsonb)`;

function barcodeValue(v: unknown): string {
  const code = str(v, 'Barcode', { max: 64 });
  if (!/^[0-9A-Za-z\-_.]{3,64}$/.test(code)) {
    throw badRequest(`"${code}" is not a valid barcode. Use letters, digits and dashes only.`);
  }
  return code;
}

async function assertBarcodesFree(trx: Tx, codes: string[], exceptProductId?: string) {
  if (!codes.length) return;
  const taken = (await sql<{ barcode: string; name: string }>`
    SELECT pb.barcode, p.name FROM product_barcodes pb JOIN products p ON p.product_id = pb.product_id
     WHERE pb.barcode = ANY(${codes}::text[])
       ${exceptProductId ? sql`AND pb.product_id <> ${exceptProductId}` : sql``}
  `.execute(trx)).rows;
  if (taken.length) {
    throw conflict(`Barcode ${taken[0].barcode} is already assigned to "${taken[0].name}".`);
  }
}

async function assertHsnHasRate(trx: Tx, hsn: string) {
  const rate = await sql<{ gst_rate_pct: string }>`
    SELECT gst_rate_pct FROM hsn_tax_rates WHERE hsn_code = ${hsn} AND effective_to IS NULL LIMIT 1
  `.execute(trx);
  if (!rate.rows[0]) {
    throw badRequest(`No GST rate is on file for HSN ${hsn}. Add the rate under Catalog → GST rates first.`);
  }
}

/** Parses the requested sale units for a product and resolves each conversion. */
async function parseUnits(trx: Tx, base: UnitRow, raw: unknown): Promise<Array<{ code: string; multiplier: number; isDefault: boolean }>> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Units must be a list.');
  if (raw.length > 20) throw badRequest('A product can have at most 20 sale units.');
  const codes = raw.map((u: any) => str(u?.unit_code ?? u?.unit_label, 'Unit', { max: 20 }).toUpperCase());
  const master = await loadUnits(trx, codes);
  const seen = new Set<string>();
  const out: Array<{ code: string; multiplier: number; isDefault: boolean }> = [];
  raw.forEach((u: any, i: number) => {
    const code = codes[i];
    const unit = master.get(code);
    if (!unit) throw badRequest(`Unit "${code}" is not in the units list. Add it under Catalog → Units first.`);
    if (!unit.is_active) throw badRequest(`Unit "${unit.name}" has been deactivated.`);
    if (seen.has(code)) throw badRequest(`${unit.name} is listed twice.`);
    seen.add(code);
    const typed = u?.multiplier_to_base === undefined || u?.multiplier_to_base === null || u?.multiplier_to_base === ''
      ? null : num(u.multiplier_to_base, `Size of one ${unit.print_label}`, { min: 0.000001, max: 1e9 });
    out.push({ code, multiplier: code === base.unit_code ? 1 : resolveMultiplier(base, unit, typed), isDefault: Boolean(u?.is_default) });
  });
  if (out.filter((u) => u.isDefault).length > 1) throw badRequest('Choose only one default sale unit.');
  return out;
}

export default async function catalogRoutes(app: FastifyInstance) {
  // ── Product search (requirement #2: fuzzy) ────────────────────────────────
  app.get('/products', guarded('view_catalog', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const search = q.q?.trim().slice(0, 80);
    // Validate rather than pass through: an unparseable value reached Postgres as
    // a bad uuid cast and surfaced as a 500 instead of a clear 400.
    const branchId = resolveBranchScope(session, optionalUuid(q.branch_id, 'branch_id')) ?? session.branch_id;
    const status = q.status === 'inactive' ? 'inactive' : q.status === 'all' || q.include_inactive === 'true' ? 'all' : 'active';

    // Trigram similarity, not just ILIKE: "cpvc elbo" and "havels wire" have to
    // find the right product, because a cashier at a counter with a customer
    // waiting will not spell the catalog name exactly (requirement #2).
    const rows = await sql<any>`
      SELECT p.product_id, p.sku, p.name, p.description, p.base_unit, p.hsn_code, p.default_price_type,
             p.batch_tracked, p.serial_tracked, p.is_active, p.spec, p.image_url,
             p.reference_purchase_price, p.reorder_level AS default_reorder_level,
             bu.print_label AS base_unit_label, bu.allows_fraction AS base_allows_fraction,
             c.category_id, c.name AS category_name,
             br.brand_id, br.name AS brand_name,
             pp.selling_price, pp.mrp,
             htr.gst_rate_pct,
             bs.base_unit_qty, bs.reserved_qty, bs.weighted_avg_cost,
             COALESCE(bs.reorder_min, p.reorder_level) AS reorder_min,
             COALESCE(bs.base_unit_qty, 0) - COALESCE(bs.reserved_qty, 0) AS available_qty,
             (SELECT pb.barcode FROM product_barcodes pb WHERE pb.product_id = p.product_id
               ORDER BY pb.is_internally_generated, pb.barcode LIMIT 1) AS barcode,
             ${UNITS_JSON} AS units
        FROM products p
        JOIN units bu ON bu.unit_code = p.base_unit
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN brands br ON br.brand_id = p.brand_id
        LEFT JOIN LATERAL (
            SELECT selling_price, mrp FROM product_prices
             WHERE product_id = p.product_id AND effective_to IS NULL
             ORDER BY (branch_id = ${branchId}) DESC NULLS LAST
             LIMIT 1
        ) pp ON TRUE
        LEFT JOIN LATERAL (
            SELECT gst_rate_pct FROM hsn_tax_rates
             WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1
        ) htr ON TRUE
        -- A null branchId is the Owner/Admin "All branches" view, and it has to SUM
        -- across branches rather than compare against NULL (which is never true).
        LEFT JOIN LATERAL (
            SELECT sum(s.base_unit_qty)  AS base_unit_qty,
                   sum(s.reserved_qty)   AS reserved_qty,
                   sum(s.reorder_min)    AS reorder_min,
                   -- Value-weighted, not avg(): branches hold different quantities at
                   -- different costs, and a mean of means would misstate the margin.
                   CASE WHEN sum(s.base_unit_qty) > 0
                        THEN sum(s.base_unit_qty * s.weighted_avg_cost) / sum(s.base_unit_qty)
                        ELSE max(s.weighted_avg_cost) END AS weighted_avg_cost
              FROM branch_stock s
             WHERE s.product_id = p.product_id
               ${branchId ? sql`AND s.branch_id = ${branchId}` : sql``}
        ) bs ON TRUE
       WHERE ${status === 'active' ? sql`p.is_active` : status === 'inactive' ? sql`NOT p.is_active` : sql`TRUE`}
         ${q.category_id ? sql`AND p.category_id = ${uuid(q.category_id, 'category_id')}` : sql``}
         ${q.brand_id ? sql`AND p.brand_id = ${uuid(q.brand_id, 'brand_id')}` : sql``}
         ${q.ids ? sql`AND p.product_id = ANY(${q.ids.split(',').slice(0, 200).map((v) => uuid(v.trim(), 'ids'))}::uuid[])` : sql``}
         ${q.stock === 'low' ? sql`AND COALESCE(bs.base_unit_qty, 0) <= COALESCE(bs.reorder_min, p.reorder_level, 0)` : sql``}
         ${q.stock === 'out' ? sql`AND COALESCE(bs.base_unit_qty, 0) <= 0` : sql``}
         ${search ? sql`AND (p.name ILIKE ${'%' + search + '%'} OR p.sku ILIKE ${'%' + search + '%'}
                             OR p.name % ${search}
                             OR EXISTS (SELECT 1 FROM product_barcodes pb
                                         WHERE pb.product_id = p.product_id AND pb.barcode = ${search}))` : sql``}
       ORDER BY ${search ? sql`(p.sku = ${search} OR EXISTS (SELECT 1 FROM product_barcodes pb
                                  WHERE pb.product_id = p.product_id AND pb.barcode = ${search})) DESC,
                              (p.name ILIKE ${search + '%'}) DESC,
                              similarity(p.name, ${search}) DESC,` : sql``} p.name
       LIMIT ${clampLimit(q.limit, 200, 500)} OFFSET ${Math.max(Number(q.offset) || 0, 0)}
    `.execute(trx);

    return maskCost(rows.rows, showCost, { keepRate: true });
  }));

  // Barcode scan (3.7 / 3.9) — exact match, returns the sale unit the barcode is for.
  app.get('/barcode/:code', guarded('view_catalog', async ({ session, db: trx, req }) => {
    const { code } = req.params as { code: string };
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    // Same rule as /products above: an Owner/Admin scanning with no branch selected
    // is asking chain-wide.
    const branchId = resolveBranchScope(session, optionalUuid(q.branch_id, 'branch_id'));
    const rows = await sql<any>`
      SELECT p.product_id, p.name, p.sku, p.base_unit, p.hsn_code, p.default_price_type,
             bu.print_label AS base_unit_label,
             pb.product_unit_id, COALESCE(pu.unit_label, p.base_unit) AS unit_label,
             COALESCE(pu.multiplier_to_base, 1) AS multiplier_to_base,
             pp.selling_price, htr.gst_rate_pct,
             COALESCE(bs.base_unit_qty, 0) - COALESCE(bs.reserved_qty, 0) AS available_qty,
             ${UNITS_JSON} AS units
        FROM product_barcodes pb
        JOIN products p ON p.product_id = pb.product_id
        JOIN units bu ON bu.unit_code = p.base_unit
        LEFT JOIN product_units pu ON pu.product_unit_id = pb.product_unit_id
        LEFT JOIN LATERAL (SELECT selling_price FROM product_prices
                            WHERE product_id = p.product_id AND effective_to IS NULL
                            ORDER BY (branch_id = ${branchId}) DESC NULLS LAST LIMIT 1) pp ON TRUE
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
        LEFT JOIN LATERAL (
            SELECT sum(s.base_unit_qty) AS base_unit_qty,
                   sum(s.reserved_qty)  AS reserved_qty
              FROM branch_stock s
             WHERE s.product_id = p.product_id
               ${branchId ? sql`AND s.branch_id = ${branchId}` : sql``}
        ) bs ON TRUE
       WHERE pb.barcode = ${str(code, 'barcode', { max: 64 })} AND p.is_active
       LIMIT 1
    `.execute(trx);
    const row = rows.rows[0];
    if (!row) throw notFound('No product is registered against that barcode.');
    return row;
  }));

  app.get('/products/:id', guarded('view_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);

    const product = (await sql<any>`
      SELECT p.*, c.name AS category_name, br.name AS brand_name,
             bu.name AS base_unit_name, bu.print_label AS base_unit_label, bu.dimension AS base_dimension,
             ${UNITS_JSON} AS units,
             (SELECT vpm.vendor_id FROM vendor_product_map vpm
               WHERE vpm.product_id = p.product_id AND vpm.is_preferred LIMIT 1) AS preferred_vendor_id,
             (SELECT v.name FROM vendor_product_map vpm JOIN vendors v ON v.vendor_id = vpm.vendor_id
               WHERE vpm.product_id = p.product_id AND vpm.is_preferred LIMIT 1) AS preferred_vendor_name,
             EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.product_id = p.product_id) AS has_movements
        FROM products p
        JOIN units bu ON bu.unit_code = p.base_unit
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN brands br ON br.brand_id = p.brand_id
       WHERE p.product_id = ${id}
    `.execute(trx)).rows[0];
    if (!product) throw notFound('Product not found.');

    const [prices, barcodes, taxRates, stock, warranty, vendors] = await Promise.all([
      sql<any>`SELECT pp.*, b.name AS branch_name FROM product_prices pp
                 LEFT JOIN branches b ON b.branch_id = pp.branch_id
                WHERE pp.product_id = ${id} ORDER BY pp.effective_from DESC`.execute(trx),
      sql<any>`SELECT pb.*, pu.unit_label FROM product_barcodes pb
                 LEFT JOIN product_units pu ON pu.product_unit_id = pb.product_unit_id
                WHERE pb.product_id = ${id} ORDER BY pb.barcode`.execute(trx),
      sql<any>`SELECT * FROM hsn_tax_rates WHERE hsn_code = ${product.hsn_code} ORDER BY effective_from DESC`.execute(trx),
      sql<any>`SELECT bs.*, b.name AS branch_name,
                      COALESCE(bs.reorder_min, ${product.reorder_level}) AS effective_reorder
                 FROM branch_stock bs
                 JOIN branches b ON b.branch_id = bs.branch_id
                WHERE bs.product_id = ${id} ORDER BY b.name`.execute(trx),
      sql<any>`SELECT duration_months FROM warranties
                WHERE product_id = ${id} OR category_id = ${product.category_id}
                ORDER BY (product_id IS NOT NULL) DESC LIMIT 1`.execute(trx),
      sql<any>`SELECT vpm.vendor_id, v.name AS vendor_name, vpm.vendor_sku, vpm.last_purchase_rate, vpm.is_preferred
                 FROM vendor_product_map vpm JOIN vendors v ON v.vendor_id = vpm.vendor_id
                WHERE vpm.product_id = ${id} ORDER BY vpm.is_preferred DESC, v.name`.execute(trx),
    ]);

    return {
      ...maskCostOne(product, showCost),
      prices: prices.rows,
      barcodes: barcodes.rows,
      tax_rates: taxRates.rows,           // 2.7 — the whole effective-dated history
      stock: maskCost(stock.rows, showCost),
      warranty_months: warranty.rows[0]?.duration_months ?? null,
      vendors: maskCost(vendors.rows, showCost),
    };
  }));

  app.post('/products', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sku = str(body.sku, 'SKU', { max: 60 }).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9\-_./]{0,59}$/.test(sku)) {
      throw badRequest('A SKU may use letters, digits and - _ . / only, e.g. PLB-PIPE-15.');
    }
    const name = str(body.name, 'Product name', { max: 200 });
    const base = await requireUnit(trx, str(body.base_unit, 'Base unit', { max: 20 }).toUpperCase(), 'Base unit');
    const hsn = str(body.hsn_code, 'HSN code', { max: 12 });
    const sellingPrice = num(body.selling_price, 'Selling price', { min: 0, max: 10_000_000 });
    const mrp = body.mrp === undefined || body.mrp === null || body.mrp === ''
      ? sellingPrice : num(body.mrp, 'MRP', { min: 0, max: 10_000_000 });
    if (mrp < sellingPrice) throw badRequest('MRP cannot be lower than the selling price.');
    if (sellingPrice <= 0) throw badRequest('Enter a selling price greater than zero.');

    // 2.7 — refuse to create a product whose HSN has no tax rate on file, rather
    // than letting it reach the billing screen and silently bill at 0% GST.
    await assertHsnHasRate(trx, hsn);

    const dup = await sql<{ name: string }>`SELECT name FROM products WHERE upper(sku) = ${sku}`.execute(trx);
    if (dup.rows[0]) throw conflict(`SKU ${sku} is already used by "${dup.rows[0].name}".`);

    const barcodes = Array.isArray(body.barcodes)
      ? [...new Set((body.barcodes as unknown[]).filter((b) => b !== null && b !== undefined && String(b).trim() !== '').map(barcodeValue))]
      : [];
    await assertBarcodesFree(trx, barcodes);

    const units = await parseUnits(trx, base, body.units);
    const categoryId = optionalUuid(body.category_id, 'Category');
    const brandId = optionalUuid(body.brand_id, 'Brand');
    const preferredVendor = optionalUuid(body.preferred_vendor_id, 'Supplier');

    const product = (await sql<any>`
      INSERT INTO products (sku, name, description, category_id, brand_id, base_unit, hsn_code, default_price_type,
                            reference_purchase_price, reorder_level, image_url, spec, batch_tracked, serial_tracked)
      VALUES (${sku}, ${name}, ${optionalStr(body.description, 'Description', { max: 1000 })},
              ${categoryId}, ${brandId}, ${base.unit_code}, ${hsn},
              ${oneOf(body.default_price_type ?? 'TAX_INCLUSIVE', 'Price type', PRICE_TYPES)}::price_type,
              ${body.reference_purchase_price === undefined || body.reference_purchase_price === '' || body.reference_purchase_price === null ? null : num(body.reference_purchase_price, 'Expected cost', { min: 0 })},
              ${body.reorder_level === undefined || body.reorder_level === '' || body.reorder_level === null ? null : num(body.reorder_level, 'Reorder level', { min: 0, max: 1e9 })},
              ${optionalStr(body.image_url, 'Image URL', { max: 500 })},
              ${body.spec ? JSON.stringify(body.spec) : null}::jsonb,
              ${bool(body.batch_tracked, 'batch_tracked', false)},
              ${bool(body.serial_tracked, 'serial_tracked', false)})
      RETURNING *
    `.execute(trx)).rows[0];

    // 2.2.1 — the base unit is always a sale unit with multiplier 1. Without this
    // row nothing could be sold at all, so it is created here, not left to the UI.
    const explicitDefault = units.find((u) => u.isDefault)?.code ?? null;
    await sql`
      INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
      VALUES (${product.product_id}, ${base.unit_code}, 1, ${!explicitDefault || explicitDefault === base.unit_code})
    `.execute(trx);
    for (const u of units) {
      if (u.code === base.unit_code) continue;
      await sql`
        INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
        VALUES (${product.product_id}, ${u.code}, ${u.multiplier}, ${u.code === explicitDefault})
      `.execute(trx);
    }

    await sql`
      INSERT INTO product_prices (product_id, mrp, selling_price, created_by)
      VALUES (${product.product_id}, ${mrp}, ${sellingPrice}, ${session.user_id})
    `.execute(trx);

    for (const code of barcodes) {
      await sql`INSERT INTO product_barcodes (product_id, barcode) VALUES (${product.product_id}, ${code})`.execute(trx);
    }

    if (preferredVendor) {
      await sql`
        INSERT INTO vendor_product_map (vendor_id, product_id, is_preferred)
        VALUES (${preferredVendor}, ${product.product_id}, TRUE)
        ON CONFLICT (vendor_id, product_id) DO UPDATE SET is_preferred = TRUE
      `.execute(trx);
    }

    await audit(trx, session, 'PRODUCT_CREATED', 'products', product.product_id,
      { after: { sku, name, base_unit: base.unit_code, selling_price: sellingPrice, mrp,
                 units: units.map((u) => `${u.code}×${u.multiplier}`), barcodes } });
    return product;
  }));

  app.put('/products/:id', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM products WHERE product_id = ${id} FOR UPDATE`.execute(trx)).rows[0];
    if (!before) throw notFound('Product not found.');

    const hsn = body.hsn_code === undefined ? before.hsn_code : str(body.hsn_code, 'HSN code', { max: 12 });
    if (hsn !== before.hsn_code) await assertHsnHasRate(trx, hsn);

    // The base unit is what every stock figure, cost and price is measured in.
    // Changing it once anything has moved would silently re-denominate history,
    // so it is only allowed on a product nothing has happened to yet.
    let baseUnit = before.base_unit as string;
    if (body.base_unit !== undefined && String(body.base_unit).toUpperCase() !== before.base_unit) {
      const moved = (await sql<{ n: number }>`
        SELECT (SELECT count(*) FROM stock_ledger WHERE product_id = ${id})
             + (SELECT count(*) FROM invoice_lines WHERE product_id = ${id}) AS n
      `.execute(trx)).rows[0];
      if (Number(moved.n) > 0) {
        throw badRequest('The base unit cannot change once the product has stock or sales. Create a new product instead.');
      }
      const base = await requireUnit(trx, String(body.base_unit).toUpperCase(), 'Base unit');
      baseUnit = base.unit_code;
      await sql`DELETE FROM product_units WHERE product_id = ${id}`.execute(trx);
      await sql`
        INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
        VALUES (${id}, ${baseUnit}, 1, TRUE)
      `.execute(trx);
    }

    await sql`
      UPDATE products SET
        name = ${optionalStr(body.name, 'Product name', { max: 200 }) ?? before.name},
        description = ${body.description === undefined ? before.description : optionalStr(body.description, 'Description', { max: 1000 })},
        category_id = ${body.category_id === undefined ? before.category_id : optionalUuid(body.category_id, 'Category')},
        brand_id = ${body.brand_id === undefined ? before.brand_id : optionalUuid(body.brand_id, 'Brand')},
        base_unit = ${baseUnit},
        hsn_code = ${hsn},
        default_price_type = ${(body.default_price_type ? oneOf(body.default_price_type, 'Price type', PRICE_TYPES) : before.default_price_type)}::price_type,
        reference_purchase_price = ${body.reference_purchase_price === undefined ? before.reference_purchase_price
          : body.reference_purchase_price === null || body.reference_purchase_price === '' ? null
          : num(body.reference_purchase_price, 'Expected cost', { min: 0 })},
        reorder_level = ${body.reorder_level === undefined ? before.reorder_level
          : body.reorder_level === null || body.reorder_level === '' ? null
          : num(body.reorder_level, 'Reorder level', { min: 0, max: 1e9 })},
        image_url = ${body.image_url === undefined ? before.image_url : optionalStr(body.image_url, 'Image URL', { max: 500 })},
        spec = ${body.spec === undefined ? before.spec : JSON.stringify(body.spec)}::jsonb,
        batch_tracked = ${body.batch_tracked === undefined ? before.batch_tracked : bool(body.batch_tracked, 'batch_tracked')},
        serial_tracked = ${body.serial_tracked === undefined ? before.serial_tracked : bool(body.serial_tracked, 'serial_tracked')},
        is_active = ${body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active')},
        updated_at = now()
      WHERE product_id = ${id}
    `.execute(trx);

    if (body.preferred_vendor_id !== undefined) {
      const vendorId = optionalUuid(body.preferred_vendor_id, 'Supplier');
      await sql`UPDATE vendor_product_map SET is_preferred = FALSE WHERE product_id = ${id}`.execute(trx);
      if (vendorId) {
        await sql`
          INSERT INTO vendor_product_map (vendor_id, product_id, is_preferred) VALUES (${vendorId}, ${id}, TRUE)
          ON CONFLICT (vendor_id, product_id) DO UPDATE SET is_preferred = TRUE
        `.execute(trx);
      }
    }

    const changed = Object.fromEntries(Object.keys(body).map((k) => [k, (before as any)[k]]));
    await audit(trx, session, 'PRODUCT_UPDATED', 'products', id, { before: changed, after: body });
    return { ok: true };
  }));

  /**
   * 2.5 / 2.7 — a price change never overwrites the old row. The current row is
   * closed off with effective_to = now() and a new one opens, so an invoice
   * raised last month still reprices at last month's figure when reprinted.
   */
  app.put('/products/:id/price', guarded('edit_pricing', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sellingPrice = num(body.selling_price, 'Selling price', { min: 0.0001, max: 10_000_000 });
    const mrp = body.mrp === undefined || body.mrp === null || body.mrp === ''
      ? sellingPrice : num(body.mrp, 'MRP', { min: 0, max: 10_000_000 });
    if (mrp < sellingPrice) throw badRequest('MRP cannot be lower than the selling price.');

    const settings = await loadSettings(trx, session.branch_id);
    const branchId: string | null = optionalUuid(body.branch_id, 'branch_id');
    if (branchId && !settings.allow_branch_price_override) {
      throw badRequest('Branch-level price overrides are switched off. Turn on "Allow branch price override" in Admin Settings first.');
    }

    const current = (await sql<any>`
      SELECT * FROM product_prices
       WHERE product_id = ${id} AND effective_to IS NULL
         AND branch_id IS NOT DISTINCT FROM ${branchId}
       FOR UPDATE
    `.execute(trx)).rows[0];

    // Closing the old range and opening the new one must be atomic — the EXCLUDE
    // constraint on product_prices rejects any overlap, so a half-applied change
    // would fail loudly rather than corrupt the history. Both statements are in
    // the request transaction, so that cannot happen.
    if (current) {
      await sql`UPDATE product_prices SET effective_to = now() WHERE price_id = ${current.price_id}`.execute(trx);
    }
    await sql`
      INSERT INTO product_prices (product_id, branch_id, mrp, selling_price, created_by)
      VALUES (${id}, ${branchId}, ${mrp}, ${sellingPrice}, ${session.user_id})
    `.execute(trx);

    await audit(trx, session, 'PRICE_CHANGE', 'products', id, {
      before: current ? { selling_price: current.selling_price, mrp: current.mrp } : null,
      after: { selling_price: sellingPrice, mrp, branch_id: branchId },
    });
    return { ok: true };
  }));

  // ── Sale units ────────────────────────────────────────────────────────────
  /**
   * Adds a sale unit. A measured conversion (100 G on a KG product) is DERIVED
   * from the units master and cannot be typed wrong; a pack size (a BOX of 100)
   * must be stated, because only the person holding the box knows.
   */
  app.post('/products/:id/units', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const product = (await sql<any>`SELECT product_id, name, base_unit FROM products WHERE product_id = ${id}`.execute(trx)).rows[0];
    if (!product) throw notFound('Product not found.');
    const base = await requireUnit(trx, product.base_unit, 'Base unit');
    const [unit] = await parseUnits(trx, base, [{
      unit_code: body.unit_code ?? body.unit_label,
      multiplier_to_base: body.multiplier_to_base,
      is_default: body.is_default_sale_unit,
    }]);
    if (unit.code === base.unit_code) throw badRequest(`${base.name} is already this product's base unit.`);
    if (unit.isDefault) {
      await sql`UPDATE product_units SET is_default_sale_unit = FALSE WHERE product_id = ${id}`.execute(trx);
    }
    const row = (await sql<any>`
      INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
      VALUES (${id}, ${unit.code}, ${unit.multiplier}, ${unit.isDefault})
      RETURNING *
    `.execute(trx)).rows[0];
    await audit(trx, session, 'PRODUCT_UPDATED', 'products', id,
      { after: { unit_added: unit.code, multiplier_to_base: unit.multiplier } });
    return row;
  }));

  app.put('/products/:id/units/:unitId', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const unitId = uuid((req.params as any).unitId, 'product_unit_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = (await sql<any>`
      SELECT pu.*, p.base_unit FROM product_units pu JOIN products p ON p.product_id = pu.product_id
       WHERE pu.product_unit_id = ${unitId} AND pu.product_id = ${id}
    `.execute(trx)).rows[0];
    if (!row) throw notFound('That unit is not on this product.');

    if (body.multiplier_to_base !== undefined && row.unit_label !== row.base_unit) {
      const units = await loadUnits(trx, [row.base_unit, row.unit_label]);
      const multiplier = resolveMultiplier(units.get(row.base_unit)!, units.get(row.unit_label)!,
        num(body.multiplier_to_base, 'Conversion', { min: 0.000001, max: 1e9 }));
      await sql`UPDATE product_units SET multiplier_to_base = ${multiplier} WHERE product_unit_id = ${unitId}`.execute(trx);
    }
    if (body.is_default_sale_unit === true) {
      await sql`UPDATE product_units SET is_default_sale_unit = FALSE WHERE product_id = ${id}`.execute(trx);
      await sql`UPDATE product_units SET is_default_sale_unit = TRUE WHERE product_unit_id = ${unitId}`.execute(trx);
    }
    await audit(trx, session, 'PRODUCT_UPDATED', 'products', id,
      { before: { unit: row.unit_label, multiplier_to_base: row.multiplier_to_base, is_default: row.is_default_sale_unit },
        after: body });
    return { ok: true };
  }));

  app.delete('/products/:id/units/:unitId', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const unitId = uuid((req.params as any).unitId, 'product_unit_id');
    const row = (await sql<any>`
      SELECT pu.*, p.base_unit FROM product_units pu JOIN products p ON p.product_id = pu.product_id
       WHERE pu.product_unit_id = ${unitId} AND pu.product_id = ${id}
    `.execute(trx)).rows[0];
    if (!row) throw notFound('That unit is not on this product.');
    if (row.unit_label === row.base_unit) throw badRequest('The base unit cannot be removed from a product.');
    const used = (await sql<{ n: string }>`
      SELECT (SELECT count(*) FROM invoice_lines WHERE product_unit_id = ${unitId})
           + (SELECT count(*) FROM quotation_lines WHERE product_unit_id = ${unitId})
           + (SELECT count(*) FROM grn_lines WHERE product_unit_id = ${unitId}) AS n
    `.execute(trx)).rows[0];
    if (Number(used.n) > 0) {
      throw badRequest('This unit has been used on bills, estimates or purchases and cannot be removed.');
    }
    await sql`UPDATE product_barcodes SET product_unit_id = NULL WHERE product_unit_id = ${unitId}`.execute(trx);
    await sql`DELETE FROM product_units WHERE product_unit_id = ${unitId}`.execute(trx);
    if (row.is_default_sale_unit) {
      await sql`UPDATE product_units SET is_default_sale_unit = TRUE WHERE product_id = ${id} AND unit_label = ${row.base_unit}`.execute(trx);
    }
    await audit(trx, session, 'PRODUCT_UPDATED', 'products', id, { before: { unit_removed: row.unit_label } });
    return { ok: true };
  }));

  // ── Barcodes ──────────────────────────────────────────────────────────────
  app.post('/products/:id/barcodes', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = barcodeValue(body.barcode);
    await assertBarcodesFree(trx, [code]);
    const productUnitId = optionalUuid(body.product_unit_id, 'product_unit_id');
    if (productUnitId) {
      const ok = (await sql<any>`SELECT 1 FROM product_units WHERE product_unit_id = ${productUnitId} AND product_id = ${id}`.execute(trx)).rows[0];
      if (!ok) throw badRequest('That unit is not on this product.');
    }
    const row = (await sql<any>`
      INSERT INTO product_barcodes (product_id, product_unit_id, barcode, is_internally_generated)
      VALUES (${id}, ${productUnitId}, ${code}, ${bool(body.is_internally_generated, 'is_internally_generated', false)})
      RETURNING *
    `.execute(trx)).rows[0];
    await audit(trx, session, 'PRODUCT_UPDATED', 'products', id, { after: { barcode_added: code } });
    return row;
  }));

  app.delete('/products/:id/barcodes/:barcodeId', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const barcodeId = uuid((req.params as any).barcodeId, 'barcode_id');
    const removed = (await sql<{ barcode: string }>`
      DELETE FROM product_barcodes WHERE barcode_id = ${barcodeId} AND product_id = ${id} RETURNING barcode
    `.execute(trx)).rows[0];
    if (!removed) throw notFound('That barcode is not on this product.');
    await audit(trx, session, 'PRODUCT_UPDATED', 'products', id, { before: { barcode_removed: removed.barcode } });
    return { ok: true };
  }));

  // ── Units master ──────────────────────────────────────────────────────────
  app.get('/units', guarded(null, async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT u.*, (SELECT count(*) FROM products p WHERE p.base_unit = u.unit_code) AS product_count
        FROM units u
       WHERE ${q.include_inactive === 'true' ? sql`TRUE` : sql`u.is_active`}
       ORDER BY array_position(ARRAY['COUNT','MASS','LENGTH','VOLUME','AREA','PACK'], u.dimension),
                u.to_dimension_base NULLS LAST, u.unit_code
    `.execute(trx)).rows;
  }));

  app.post('/units', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = str(body.unit_code, 'Unit code', { max: 20 }).toUpperCase().replace(/\s+/g, '_');
    if (!/^[A-Z0-9_]{1,20}$/.test(code)) throw badRequest('A unit code may only use capital letters, digits and underscores, e.g. BAG or 5KG.');
    const dimension = oneOf(body.dimension, 'Unit type', DIMENSIONS);
    const factor = dimension === 'PACK' ? null
      : num(body.to_dimension_base, dimension === 'MASS' ? 'Grams in one unit'
        : dimension === 'LENGTH' ? 'Millimetres in one unit'
        : dimension === 'VOLUME' ? 'Millilitres in one unit'
        : dimension === 'AREA' ? 'Square feet in one unit' : 'Pieces in one unit', { min: 0.000001, max: 1e9 });
    const existing = (await sql<any>`SELECT unit_code FROM units WHERE unit_code = ${code}`.execute(trx)).rows[0];
    if (existing) throw conflict(`A unit with code ${code} already exists.`);
    const row = (await sql<any>`
      INSERT INTO units (unit_code, name, print_label, dimension, to_dimension_base, allows_fraction)
      VALUES (${code}, ${str(body.name, 'Unit name', { max: 60 })},
              ${(optionalStr(body.print_label, 'Printed label', { max: 12 }) ?? code).toUpperCase()},
              ${dimension}, ${factor},
              ${bool(body.allows_fraction, 'allows_fraction', dimension !== 'COUNT' && dimension !== 'PACK')})
      RETURNING *
    `.execute(trx)).rows[0];
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'units', null, { after: row });
    return row;
  }));

  app.put('/units/:code', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const code = str((req.params as any).code, 'Unit code', { max: 20 }).toUpperCase();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM units WHERE unit_code = ${code}`.execute(trx)).rows[0];
    if (!before) throw notFound('Unit not found.');
    // A shipped unit's size is a physical fact (1 KG is 1000 G); only its wording
    // and whether it is offered may change.
    if (before.is_system && (body.dimension !== undefined || body.to_dimension_base !== undefined)) {
      throw badRequest('The size of a built-in unit cannot be changed.');
    }
    await sql`
      UPDATE units SET
        name = ${optionalStr(body.name, 'Unit name', { max: 60 }) ?? before.name},
        print_label = ${(optionalStr(body.print_label, 'Printed label', { max: 12 }) ?? before.print_label).toUpperCase()},
        allows_fraction = ${body.allows_fraction === undefined ? before.allows_fraction : bool(body.allows_fraction, 'allows_fraction')},
        is_active = ${body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active')}
      WHERE unit_code = ${code}
    `.execute(trx);
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'units', null, { before, after: body });
    return { ok: true };
  }));

  // ── Categories & brands ───────────────────────────────────────────────────
  app.get('/categories', guarded(null, async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT c.category_id, c.name, c.parent_category_id, c.is_active, p.name AS parent_name,
             CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS path,
             (SELECT count(*) FROM products WHERE category_id = c.category_id AND is_active) AS product_count,
             rw.window_days AS return_window_days
        FROM categories c
        LEFT JOIN categories p ON p.category_id = c.parent_category_id
        LEFT JOIN return_windows rw ON rw.category_id = c.category_id
       WHERE ${q.include_inactive === 'true' ? sql`TRUE` : sql`c.is_active`}
         ${q.q ? sql`AND c.name ILIKE ${'%' + q.q.trim() + '%'}` : sql``}
       ORDER BY COALESCE(p.name, c.name), p.name NULLS FIRST, c.name
    `.execute(trx)).rows;
  }));

  app.post('/categories', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'Category name', { max: 100 });
    const parent = optionalUuid(body.parent_category_id, 'Parent category');
    const dup = (await sql<any>`
      SELECT category_id FROM categories
       WHERE lower(btrim(name)) = lower(btrim(${name}))
         AND parent_category_id IS NOT DISTINCT FROM ${parent}
    `.execute(trx)).rows[0];
    if (dup) throw conflict(`A category called "${name}" already exists here.`);
    const row = (await sql<any>`
      INSERT INTO categories (name, parent_category_id) VALUES (${name}, ${parent}) RETURNING *
    `.execute(trx)).rows[0];
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'categories', row.category_id, { after: row });
    return row;
  }));

  app.put('/categories/:id', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'category_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM categories WHERE category_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Category not found.');
    const parent = body.parent_category_id === undefined ? before.parent_category_id
      : optionalUuid(body.parent_category_id, 'Parent category');
    if (parent === id) throw badRequest('A category cannot be its own parent.');
    await sql`
      UPDATE categories SET name = ${optionalStr(body.name, 'Category name', { max: 100 }) ?? before.name},
             parent_category_id = ${parent},
             is_active = ${body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active')}
       WHERE category_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'categories', id, { before, after: body });
    return { ok: true };
  }));

  app.get('/brands', guarded(null, async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    return (await sql<any>`
      SELECT b.*, (SELECT count(*) FROM products WHERE brand_id = b.brand_id AND is_active) AS product_count
        FROM brands b
       WHERE ${q.include_inactive === 'true' ? sql`TRUE` : sql`b.is_active`}
         ${q.q ? sql`AND b.name ILIKE ${'%' + q.q.trim() + '%'}` : sql``}
       ORDER BY b.name
    `.execute(trx)).rows;
  }));

  app.post('/brands', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name, 'Brand name', { max: 100 });
    const dup = (await sql<any>`SELECT brand_id, name FROM brands WHERE lower(btrim(name)) = lower(btrim(${name}))`.execute(trx)).rows[0];
    if (dup) throw conflict(`A brand called "${dup.name}" already exists.`);
    const row = (await sql<any>`INSERT INTO brands (name) VALUES (${name}) RETURNING *`.execute(trx)).rows[0];
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'brands', row.brand_id, { after: row });
    return row;
  }));

  app.put('/brands/:id', guarded('manage_master_data', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'brand_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM brands WHERE brand_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Brand not found.');
    await sql`
      UPDATE brands SET name = ${optionalStr(body.name, 'Brand name', { max: 100 }) ?? before.name},
             is_active = ${body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active')}
       WHERE brand_id = ${id}
    `.execute(trx);
    await audit(trx, session, 'MASTER_DATA_CHANGE', 'brands', id, { before, after: body });
    return { ok: true };
  }));

  // ── Tax rates (2.7) ───────────────────────────────────────────────────────
  app.get('/hsn-rates', guarded(null, async ({ db: trx, req }) => {
    const q = (req.query ?? {}) as { all?: string };
    return (await sql<any>`
      SELECT * FROM hsn_tax_rates
       ${q.all === 'true' ? sql`` : sql`WHERE effective_to IS NULL`}
       ORDER BY hsn_code, effective_from DESC
    `.execute(trx)).rows;
  }));

  app.post('/hsn-rates', guarded('manage_settings', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hsn = str(body.hsn_code, 'HSN code', { max: 12 });
    if (!/^[0-9]{4,8}$/.test(hsn)) throw badRequest('An HSN/SAC code is 4 to 8 digits.');
    const rate = num(body.gst_rate_pct, 'GST rate', { min: 0, max: 100 });
    if (![0, 0.1, 0.25, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40].includes(rate)) {
      throw badRequest(`${rate}% is not a GST slab. Use 0, 0.25, 3, 5, 12, 18, 28 or 40.`);
    }
    const effectiveFrom = str(body.effective_from, 'Effective from', { max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw badRequest('Effective from must be a date (YYYY-MM-DD).');

    const cess = body.cess_rate_pct === undefined ? 0 : num(body.cess_rate_pct, 'Cess rate', { min: 0, max: 100 });

    // Same HSN, same start date: this is a correction of a rate entered wrongly,
    // not a new rate. Bills already made keep the tax they were made with (each
    // invoice line stores its own rate), so correcting the row is safe.
    const same = (await sql<any>`
      SELECT * FROM hsn_tax_rates WHERE hsn_code = ${hsn} AND effective_from = ${effectiveFrom}::date
    `.execute(trx)).rows[0];
    if (same) {
      const row = (await sql<any>`
        UPDATE hsn_tax_rates SET gst_rate_pct = ${rate}, cess_rate_pct = ${cess}
         WHERE hsn_tax_rate_id = ${same.hsn_tax_rate_id} RETURNING *
      `.execute(trx)).rows[0];
      await audit(trx, session, 'SETTING_CHANGE', 'hsn_tax_rates', row.hsn_tax_rate_id,
        { before: { rate: same.gst_rate_pct, cess: same.cess_rate_pct }, after: { hsn, rate, cess, effectiveFrom } });
      return row;
    }
    const later = (await sql<any>`
      SELECT effective_from FROM hsn_tax_rates WHERE hsn_code = ${hsn} AND effective_from > ${effectiveFrom}::date LIMIT 1
    `.execute(trx)).rows[0];
    if (later) throw badRequest(`HSN ${hsn} already has a rate starting later than that date. Enter a date on or after the latest rate.`);

    // A new rate closes the open one at the same instant it opens. The EXCLUDE
    // constraint in the schema then guarantees the ranges cannot overlap, which
    // is what keeps historical invoices reproducible.
    await sql`
      UPDATE hsn_tax_rates SET effective_to = ${effectiveFrom}::date
       WHERE hsn_code = ${hsn} AND effective_to IS NULL AND effective_from < ${effectiveFrom}::date
    `.execute(trx);
    const row = (await sql<any>`
      INSERT INTO hsn_tax_rates (hsn_code, gst_rate_pct, cess_rate_pct, effective_from)
      VALUES (${hsn}, ${rate}, ${cess}, ${effectiveFrom}::date)
      RETURNING *
    `.execute(trx)).rows[0];

    await audit(trx, session, 'SETTING_CHANGE', 'hsn_tax_rates', row.hsn_tax_rate_id, { after: { hsn, rate, effectiveFrom } });
    return row;
  }));

  // ── Bundles (2.4) ─────────────────────────────────────────────────────────
  app.get('/bundles', guarded('view_catalog', async ({ db: trx }) => {
    const bundles = (await sql<any>`SELECT * FROM bundles WHERE is_active ORDER BY name`.execute(trx)).rows;
    if (!bundles.length) return [];
    const items = (await sql<any>`
      SELECT bi.bundle_id, bi.product_id, bi.qty_base_unit, p.name AS product_name, p.base_unit
        FROM bundle_items bi JOIN products p ON p.product_id = bi.product_id
    `.execute(trx)).rows;
    return bundles.map((b: any) => ({ ...b, items: items.filter((i: any) => i.bundle_id === b.bundle_id) }));
  }));

  app.post('/bundles', guarded('edit_catalog', async ({ db: trx, req, session }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!settings.enable_bundles) throw badRequest('Bundles are switched off. Turn on "Enable bundles" in Admin Settings first.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const bundle = (await sql<any>`
      INSERT INTO bundles (name) VALUES (${str(body.name, 'Bundle name', { max: 120 })}) RETURNING *
    `.execute(trx)).rows[0];
    for (const item of (body.items as any[]) ?? []) {
      await sql`
        INSERT INTO bundle_items (bundle_id, product_id, qty_base_unit)
        VALUES (${bundle.bundle_id}, ${uuid(item.product_id, 'product_id')}, ${num(item.qty_base_unit, 'Quantity', { min: 0.0001 })})
      `.execute(trx);
    }
    return bundle;
  }));

  // ── Bulk import (4.9 "bulk Excel import") ─────────────────────────────────
  // Rows already parsed from a CSV by the client. Every row is validated BEFORE a
  // single insert, and the whole file runs in one transaction: a sheet with one
  // bad row imports nothing, and the report names every bad row, not just the first.
  app.post('/products/bulk-import', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as { rows?: unknown; dry_run?: unknown };
    if (!Array.isArray(body.rows) || body.rows.length === 0) throw badRequest('The file has no rows to import.');
    if (body.rows.length > 2000) throw badRequest('Import at most 2000 rows at a time.');
    const dryRun = body.dry_run === true;

    const errors: { row: number; message: string }[] = [];
    const validated: any[] = [];
    const knownHsn = new Set(
      (await sql<{ hsn_code: string }>`SELECT DISTINCT hsn_code FROM hsn_tax_rates WHERE effective_to IS NULL`
        .execute(trx)).rows.map((r) => r.hsn_code),
    );
    const unitMaster = new Map((await sql<UnitRow>`SELECT * FROM units WHERE is_active`.execute(trx)).rows
      .map((u) => [u.unit_code, u]));
    const categoriesByName = new Map((await sql<{ category_id: string; name: string }>`
      SELECT category_id, name FROM categories WHERE is_active`.execute(trx)).rows
      .map((c) => [c.name.trim().toLowerCase(), c.category_id]));
    const brandsByName = new Map((await sql<{ brand_id: string; name: string }>`
      SELECT brand_id, name FROM brands WHERE is_active`.execute(trx)).rows
      .map((b) => [b.name.trim().toLowerCase(), b.brand_id]));
    const seenSkus = new Set<string>();
    const seenBarcodes = new Set<string>();

    for (let i = 0; i < body.rows.length; i++) {
      const r = body.rows[i] as Record<string, unknown>;
      try {
        const sku = str(r.sku, 'sku', { max: 60 }).toUpperCase();
        const name = str(r.name, 'name', { max: 200 });
        const baseUnit = str(r.base_unit ?? 'PIECE', 'base_unit', { max: 20 }).toUpperCase();
        if (!unitMaster.has(baseUnit)) throw badRequest(`base_unit "${baseUnit}" is not in the units list`);
        const hsn = str(r.hsn_code, 'hsn_code', { max: 12 });
        const price = num(r.selling_price, 'selling_price', { min: 0.0001 });
        const mrp = r.mrp === undefined || r.mrp === '' ? price : num(r.mrp, 'mrp', { min: 0 });
        // 2.7 — the same gate the single-product form applies. Without it an
        // imported product reached the billing screen and was billed at 0% GST.
        if (!knownHsn.has(hsn)) throw badRequest(`no GST rate is on file for HSN ${hsn}`);
        if (mrp < price) throw badRequest('mrp is below selling_price');
        if (seenSkus.has(sku)) throw badRequest(`sku ${sku} appears more than once in this file`);
        seenSkus.add(sku);
        let categoryId: string | null = null;
        if (r.category !== undefined && String(r.category).trim()) {
          categoryId = categoriesByName.get(String(r.category).trim().toLowerCase()) ?? null;
          if (!categoryId) throw badRequest(`category "${r.category}" does not exist — add it first`);
        }
        let brandId: string | null = null;
        if (r.brand !== undefined && String(r.brand).trim()) {
          brandId = brandsByName.get(String(r.brand).trim().toLowerCase()) ?? null;
          if (!brandId) throw badRequest(`brand "${r.brand}" does not exist — add it first`);
        }
        const barcode = r.barcode === undefined || String(r.barcode).trim() === '' ? null : barcodeValue(r.barcode);
        if (barcode) {
          if (seenBarcodes.has(barcode)) throw badRequest(`barcode ${barcode} appears more than once in this file`);
          seenBarcodes.add(barcode);
        }
        validated.push({
          sku, name, baseUnit, hsn, price, mrp, categoryId, brandId, barcode,
          reorder: r.reorder_level === undefined || r.reorder_level === '' ? null : num(r.reorder_level, 'reorder_level', { min: 0 }),
          cost: r.reference_purchase_price === undefined || r.reference_purchase_price === '' ? null
            : num(r.reference_purchase_price, 'reference_purchase_price', { min: 0 }),
        });
      } catch (err) {
        errors.push({ row: i + 1, message: err instanceof Error ? err.message : 'Invalid row' });
      }
    }

    // Barcodes already on OTHER products are a conflict the file cannot resolve.
    if (seenBarcodes.size) {
      const taken = (await sql<{ barcode: string; sku: string }>`
        SELECT pb.barcode, p.sku FROM product_barcodes pb JOIN products p ON p.product_id = pb.product_id
         WHERE pb.barcode = ANY(${[...seenBarcodes]}::text[])
      `.execute(trx)).rows;
      for (const t of taken) {
        const idx = validated.findIndex((v) => v.barcode === t.barcode && v.sku !== t.sku);
        if (idx >= 0) errors.push({ row: body.rows.findIndex((r: any) => String(r.barcode).trim() === t.barcode) + 1, message: `barcode ${t.barcode} already belongs to ${t.sku}` });
      }
    }

    if (errors.length) {
      throw badRequest(
        `Import cancelled: ${errors.length} row(s) have problems. Nothing was changed.`,
        errors.sort((a, b) => a.row - b.row).slice(0, 50));
    }

    const existingSkus = new Set((await sql<{ sku: string }>`
      SELECT upper(sku) AS sku FROM products WHERE upper(sku) = ANY(${[...seenSkus]}::text[])
    `.execute(trx)).rows.map((r) => r.sku));
    if (dryRun) {
      return { ok: true, dry_run: true, would_create: validated.filter((v) => !existingSkus.has(v.sku)).length,
               would_update: validated.filter((v) => existingSkus.has(v.sku)).length };
    }

    let created = 0, updated = 0;
    for (const v of validated) {
      const existing = (await sql<any>`SELECT product_id FROM products WHERE upper(sku) = ${v.sku}`.execute(trx)).rows[0];
      if (existing) {
        await sql`UPDATE products SET name = ${v.name}, hsn_code = ${v.hsn},
                         category_id = COALESCE(${v.categoryId}, category_id), brand_id = COALESCE(${v.brandId}, brand_id),
                         reorder_level = COALESCE(${v.reorder}, reorder_level), updated_at = now()
                   WHERE product_id = ${existing.product_id}`.execute(trx);
        await sql`UPDATE product_prices SET effective_to = now()
                   WHERE product_id = ${existing.product_id} AND effective_to IS NULL AND branch_id IS NULL`.execute(trx);
        await sql`INSERT INTO product_prices (product_id, mrp, selling_price, created_by)
                  VALUES (${existing.product_id}, ${v.mrp}, ${v.price}, ${session.user_id})`.execute(trx);
        if (v.barcode) {
          await sql`INSERT INTO product_barcodes (product_id, barcode) VALUES (${existing.product_id}, ${v.barcode})
                    ON CONFLICT (barcode) DO NOTHING`.execute(trx);
        }
        updated++;
      } else {
        const p = (await sql<any>`
          INSERT INTO products (sku, name, base_unit, hsn_code, category_id, brand_id, reference_purchase_price, reorder_level)
          VALUES (${v.sku}, ${v.name}, ${v.baseUnit}, ${v.hsn}, ${v.categoryId}, ${v.brandId}, ${v.cost}, ${v.reorder})
          RETURNING product_id
        `.execute(trx)).rows[0];
        await sql`INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
                  VALUES (${p.product_id}, ${v.baseUnit}, 1, TRUE)`.execute(trx);
        await sql`INSERT INTO product_prices (product_id, mrp, selling_price, created_by)
                  VALUES (${p.product_id}, ${v.mrp}, ${v.price}, ${session.user_id})`.execute(trx);
        if (v.barcode) {
          await sql`INSERT INTO product_barcodes (product_id, barcode) VALUES (${p.product_id}, ${v.barcode})`.execute(trx);
        }
        created++;
      }
    }

    await audit(trx, session, 'PRODUCT_IMPORTED', 'products', null, { after: { created, updated } });
    return { ok: true, created, updated };
  }));

  // ── Margin view (2.6) ─────────────────────────────────────────────────────
  // Owner-only by default, but the requirement explicitly lets the Owner grant a
  // Branch Manager sight of their own branch's costs.
  app.get('/margins', guarded(null, async ({ session, db: trx, req }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!canSeeCost(session.role, settings)) {
      throw forbidden('Cost and margin figures are restricted. An Owner can grant a Branch Manager access under Admin → Settings → Catalog.');
    }
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const branchId = resolveBranchScope(session, q.branch_id);
    const rows = await sql<any>`
      SELECT p.product_id, p.sku, p.name, c.name AS category_name, b.name AS branch_name,
             pp.selling_price, p.reference_purchase_price AS expected_cost,
             bs.weighted_avg_cost AS actual_cost, bs.base_unit_qty,
             -- A tax-inclusive price contains GST; margin is measured on the
             -- price net of tax, the same basis cost is recorded on.
             pp.selling_price / CASE WHEN p.default_price_type = 'TAX_INCLUSIVE'
                                     THEN 1 + COALESCE(htr.gst_rate_pct, 0) / 100 ELSE 1 END AS net_price,
             NULL::numeric AS margin_amount, NULL::numeric AS margin_pct
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id
        JOIN branches b ON b.branch_id = bs.branch_id
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN LATERAL (SELECT selling_price FROM product_prices
                            WHERE product_id = p.product_id AND effective_to IS NULL LIMIT 1) pp ON TRUE
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
       WHERE p.is_active ${branchId ? sql`AND bs.branch_id = ${branchId}` : sql``}
       LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx);
    return rows.rows.map((r: any) => {
      const net = Number(r.net_price ?? 0);
      const cost = Number(r.actual_cost ?? 0);
      return {
        ...r,
        net_price: round2(net),
        margin_amount: round2(net - cost),
        margin_pct: net > 0 ? round2(((net - cost) / net) * 100) : null,
        // The "expected vs actual" gap the requirement asks to surface at a glance (2.6).
        cost_variance: r.expected_cost != null && r.actual_cost != null
          ? round2(Number(r.actual_cost) - Number(r.expected_cost)) : null,
      };
    }).sort((a: any, b: any) => (a.margin_pct ?? 1e9) - (b.margin_pct ?? 1e9));
  }));
}
