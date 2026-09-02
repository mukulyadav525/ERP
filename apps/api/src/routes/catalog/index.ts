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

const BASE_UNITS = ['PIECE', 'METRE', 'KG', 'LITRE'] as const;
const PRICE_TYPES = ['TAX_INCLUSIVE', 'TAX_EXCLUSIVE'] as const;

export default async function catalogRoutes(app: FastifyInstance) {
  // ── Product search (requirement #2: fuzzy) ────────────────────────────────
  app.get('/products', guarded('view_catalog', async ({ session, db: trx, req }) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const settings = await loadSettings(trx, session.branch_id);
    const showCost = canSeeCost(session.role, settings);
    const search = q.q?.trim();
    // Validate rather than pass through: an unparseable value reached Postgres as
    // a bad uuid cast and surfaced as a 500 instead of a clear 400.
    const branchId = resolveBranchScope(session, optionalUuid(q.branch_id, 'branch_id')) ?? session.branch_id;

    // Trigram similarity, not just ILIKE: "cpvc elbo" and "havels wire" have to
    // find the right product, because a cashier at a counter with a customer
    // waiting will not spell the catalog name exactly (requirement #2).
    const rows = await sql<any>`
      SELECT p.product_id, p.sku, p.name, p.base_unit, p.hsn_code, p.default_price_type,
             p.batch_tracked, p.serial_tracked, p.is_active, p.spec, p.image_url,
             p.reference_purchase_price,
             c.category_id, c.name AS category_name,
             br.brand_id, br.name AS brand_name,
             pp.selling_price, pp.mrp,
             htr.gst_rate_pct,
             bs.base_unit_qty, bs.reserved_qty, bs.weighted_avg_cost, bs.reorder_min,
             COALESCE(bs.base_unit_qty, 0) - COALESCE(bs.reserved_qty, 0) AS available_qty
        FROM products p
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
        LEFT JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = ${branchId}
       WHERE (${q.include_inactive === 'true'} OR p.is_active)
         ${q.category_id ? sql`AND p.category_id = ${uuid(q.category_id, 'category_id')}` : sql``}
         ${q.brand_id ? sql`AND p.brand_id = ${uuid(q.brand_id, 'brand_id')}` : sql``}
         ${search ? sql`AND (p.name ILIKE ${'%' + search + '%'} OR p.sku ILIKE ${'%' + search + '%'}
                             OR p.name % ${search}
                             OR EXISTS (SELECT 1 FROM product_barcodes pb
                                         WHERE pb.product_id = p.product_id AND pb.barcode = ${search}))` : sql``}
       ORDER BY ${search ? sql`similarity(p.name, ${search}) DESC,` : sql``} p.name
       LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx);

    return maskCost(rows.rows, showCost, { keepRate: true });
  }));

  // Barcode scan (3.7 / 3.9) — exact match, returns the sale unit the barcode is for.
  app.get('/barcode/:code', guarded('view_catalog', async ({ session, db: trx, req }) => {
    const { code } = req.params as { code: string };
    const branchId = session.branch_id;
    const rows = await sql<any>`
      SELECT p.product_id, p.name, p.sku, p.base_unit, p.hsn_code, p.default_price_type,
             pb.product_unit_id, COALESCE(pu.unit_label, p.base_unit::text) AS unit_label,
             COALESCE(pu.multiplier_to_base, 1) AS multiplier_to_base,
             pp.selling_price, htr.gst_rate_pct,
             COALESCE(bs.base_unit_qty, 0) - COALESCE(bs.reserved_qty, 0) AS available_qty
        FROM product_barcodes pb
        JOIN products p ON p.product_id = pb.product_id
        LEFT JOIN product_units pu ON pu.product_unit_id = pb.product_unit_id
        LEFT JOIN LATERAL (SELECT selling_price FROM product_prices
                            WHERE product_id = p.product_id AND effective_to IS NULL LIMIT 1) pp ON TRUE
        LEFT JOIN LATERAL (SELECT gst_rate_pct FROM hsn_tax_rates
                            WHERE hsn_code = p.hsn_code AND effective_to IS NULL LIMIT 1) htr ON TRUE
        LEFT JOIN branch_stock bs ON bs.product_id = p.product_id AND bs.branch_id = ${branchId}
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
      SELECT p.*, c.name AS category_name, br.name AS brand_name
        FROM products p
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN brands br ON br.brand_id = p.brand_id
       WHERE p.product_id = ${id}
    `.execute(trx)).rows[0];
    if (!product) throw notFound('Product not found.');

    const [units, prices, barcodes, taxRates, stock, warranty] = await Promise.all([
      sql<any>`SELECT * FROM product_units WHERE product_id = ${id} ORDER BY multiplier_to_base`.execute(trx),
      sql<any>`SELECT pp.*, b.name AS branch_name FROM product_prices pp
                 LEFT JOIN branches b ON b.branch_id = pp.branch_id
                WHERE pp.product_id = ${id} ORDER BY pp.effective_from DESC`.execute(trx),
      sql<any>`SELECT * FROM product_barcodes WHERE product_id = ${id}`.execute(trx),
      sql<any>`SELECT * FROM hsn_tax_rates WHERE hsn_code = ${product.hsn_code} ORDER BY effective_from DESC`.execute(trx),
      sql<any>`SELECT bs.*, b.name AS branch_name FROM branch_stock bs
                 JOIN branches b ON b.branch_id = bs.branch_id
                WHERE bs.product_id = ${id} ORDER BY b.name`.execute(trx),
      sql<any>`SELECT duration_months FROM warranties
                WHERE product_id = ${id} OR category_id = ${product.category_id}
                ORDER BY (product_id IS NOT NULL) DESC LIMIT 1`.execute(trx),
    ]);

    return {
      ...maskCostOne(product, showCost),
      units: units.rows,
      prices: prices.rows,
      barcodes: barcodes.rows,
      tax_rates: taxRates.rows,           // 2.7 — the whole effective-dated history
      stock: maskCost(stock.rows, showCost),
      warranty_months: warranty.rows[0]?.duration_months ?? null,
    };
  }));

  app.post('/products', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sku = str(body.sku, 'SKU', { max: 60 });
    const name = str(body.name, 'Product name', { max: 200 });
    const baseUnit = oneOf(body.base_unit, 'Base unit', BASE_UNITS);
    const hsn = str(body.hsn_code, 'HSN code', { max: 12 });
    const sellingPrice = num(body.selling_price, 'Selling price', { min: 0 });
    const mrp = body.mrp === undefined ? sellingPrice : num(body.mrp, 'MRP', { min: 0 });
    if (mrp < sellingPrice) throw badRequest('MRP cannot be lower than the selling price.');

    // 2.7 — refuse to create a product whose HSN has no tax rate on file, rather
    // than letting it reach the billing screen and silently bill at 0% GST.
    const rate = await sql<{ gst_rate_pct: string }>`
      SELECT gst_rate_pct FROM hsn_tax_rates WHERE hsn_code = ${hsn} AND effective_to IS NULL LIMIT 1
    `.execute(trx);
    if (!rate.rows[0]) {
      throw badRequest(`No GST rate is on file for HSN ${hsn}. Add the rate under Admin → Tax Rates first.`);
    }

    const dup = await sql<{ product_id: string }>`SELECT product_id FROM products WHERE sku = ${sku}`.execute(trx);
    if (dup.rows[0]) throw conflict(`SKU ${sku} is already in use.`);

    const product = (await sql<any>`
      INSERT INTO products (sku, name, category_id, brand_id, base_unit, hsn_code, default_price_type,
                            reference_purchase_price, image_url, spec, batch_tracked, serial_tracked)
      VALUES (${sku}, ${name}, ${optionalUuid(body.category_id, 'category_id')},
              ${optionalUuid(body.brand_id, 'brand_id')}, ${baseUnit}::base_unit_type, ${hsn},
              ${oneOf(body.default_price_type ?? 'TAX_INCLUSIVE', 'Price type', PRICE_TYPES)}::price_type,
              ${body.reference_purchase_price === undefined ? null : num(body.reference_purchase_price, 'Reference purchase price', { min: 0 })},
              ${optionalStr(body.image_url, 'Image URL', { max: 500 })},
              ${body.spec ? JSON.stringify(body.spec) : null}::jsonb,
              ${bool(body.batch_tracked, 'batch_tracked', false)},
              ${bool(body.serial_tracked, 'serial_tracked', false)})
      RETURNING *
    `.execute(trx)).rows[0];

    // 2.2.1 — the base unit is always a sale unit with multiplier 1. Without this
    // row nothing could be sold at all, so it is created here, not left to the UI.
    await sql`
      INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
      VALUES (${product.product_id}, ${baseUnit}, 1, TRUE)
    `.execute(trx);

    // Extra sale units, each strictly a multiple of the base unit.
    if (Array.isArray(body.units)) {
      for (const u of body.units as any[]) {
        const label = str(u?.unit_label, 'Unit label', { max: 40 });
        const multiplier = num(u?.multiplier_to_base, 'Unit multiplier', { min: 0.0001 });
        if (label === baseUnit) continue;
        await sql`
          INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
          VALUES (${product.product_id}, ${label}, ${multiplier}, FALSE)
          ON CONFLICT DO NOTHING
        `.execute(trx);
      }
    }

    await sql`
      INSERT INTO product_prices (product_id, mrp, selling_price, created_by)
      VALUES (${product.product_id}, ${mrp}, ${sellingPrice}, ${session.user_id})
    `.execute(trx);

    if (Array.isArray(body.barcodes)) {
      for (const code of body.barcodes as any[]) {
        await sql`INSERT INTO product_barcodes (product_id, barcode) VALUES (${product.product_id}, ${String(code)})
                  ON CONFLICT DO NOTHING`.execute(trx);
      }
    }

    await audit(trx, session, 'PRICE_CHANGE', 'products', product.product_id,
      { after: { sku, name, selling_price: sellingPrice, mrp } });
    return product;
  }));

  app.put('/products/:id', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = (await sql<any>`SELECT * FROM products WHERE product_id = ${id}`.execute(trx)).rows[0];
    if (!before) throw notFound('Product not found.');

    await sql`
      UPDATE products SET
        name = ${optionalStr(body.name, 'Product name', { max: 200 }) ?? before.name},
        category_id = ${body.category_id === undefined ? before.category_id : optionalUuid(body.category_id, 'category_id')},
        brand_id = ${body.brand_id === undefined ? before.brand_id : optionalUuid(body.brand_id, 'brand_id')},
        hsn_code = ${optionalStr(body.hsn_code, 'HSN code', { max: 12 }) ?? before.hsn_code},
        default_price_type = ${(body.default_price_type ? oneOf(body.default_price_type, 'Price type', PRICE_TYPES) : before.default_price_type)}::price_type,
        reference_purchase_price = ${body.reference_purchase_price === undefined ? before.reference_purchase_price : num(body.reference_purchase_price, 'Reference purchase price', { min: 0 })},
        image_url = ${body.image_url === undefined ? before.image_url : optionalStr(body.image_url, 'Image URL', { max: 500 })},
        spec = ${body.spec === undefined ? before.spec : JSON.stringify(body.spec)}::jsonb,
        batch_tracked = ${body.batch_tracked === undefined ? before.batch_tracked : bool(body.batch_tracked, 'batch_tracked')},
        serial_tracked = ${body.serial_tracked === undefined ? before.serial_tracked : bool(body.serial_tracked, 'serial_tracked')},
        is_active = ${body.is_active === undefined ? before.is_active : bool(body.is_active, 'is_active')}
      WHERE product_id = ${id}
    `.execute(trx);

    await audit(trx, session, 'PRICE_CHANGE', 'products', id, { before, after: body });
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
    const sellingPrice = num(body.selling_price, 'Selling price', { min: 0 });
    const mrp = body.mrp === undefined ? sellingPrice : num(body.mrp, 'MRP', { min: 0 });
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

  // ── Units / barcodes ──────────────────────────────────────────────────────
  app.post('/products/:id/units', guarded('edit_catalog', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = (await sql<any>`
      INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
      VALUES (${id}, ${str(body.unit_label, 'Unit label', { max: 40 })},
              ${num(body.multiplier_to_base, 'Multiplier', { min: 0.0001 })},
              ${bool(body.is_default_sale_unit, 'is_default_sale_unit', false)})
      RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  app.post('/products/:id/barcodes', guarded('edit_catalog', async ({ db: trx, req }) => {
    const id = uuid((req.params as any).id, 'product_id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = (await sql<any>`
      INSERT INTO product_barcodes (product_id, product_unit_id, barcode, is_internally_generated)
      VALUES (${id}, ${optionalUuid(body.product_unit_id, 'product_unit_id')},
              ${str(body.barcode, 'Barcode', { max: 64 })},
              ${bool(body.is_internally_generated, 'is_internally_generated', false)})
      RETURNING *
    `.execute(trx)).rows[0];
    return row;
  }));

  // ── Categories & brands ───────────────────────────────────────────────────
  app.get('/categories', guarded(null, async ({ db: trx }) =>
    (await sql<any>`
      SELECT c.category_id, c.name, c.parent_category_id, p.name AS parent_name,
             (SELECT count(*) FROM products WHERE category_id = c.category_id AND is_active) AS product_count,
             rw.window_days AS return_window_days
        FROM categories c
        LEFT JOIN categories p ON p.category_id = c.parent_category_id
        LEFT JOIN return_windows rw ON rw.category_id = c.category_id
       ORDER BY c.name
    `.execute(trx)).rows));

  app.post('/categories', guarded('edit_catalog', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return (await sql<any>`
      INSERT INTO categories (name, parent_category_id)
      VALUES (${str(body.name, 'Category name', { max: 100 })}, ${optionalUuid(body.parent_category_id, 'parent_category_id')})
      RETURNING *
    `.execute(trx)).rows[0];
  }));

  app.get('/brands', guarded(null, async ({ db: trx }) =>
    (await sql<any>`SELECT * FROM brands ORDER BY name`.execute(trx)).rows));

  app.post('/brands', guarded('edit_catalog', async ({ db: trx, req }) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return (await sql<any>`
      INSERT INTO brands (name) VALUES (${str(body.name, 'Brand name', { max: 100 })}) RETURNING *
    `.execute(trx)).rows[0];
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
    const rate = num(body.gst_rate_pct, 'GST rate', { min: 0, max: 100 });
    const effectiveFrom = str(body.effective_from, 'Effective from');

    // A new rate closes the open one at the same instant it opens. The EXCLUDE
    // constraint in the schema then guarantees the ranges cannot overlap, which
    // is what keeps historical invoices reproducible.
    await sql`
      UPDATE hsn_tax_rates SET effective_to = ${effectiveFrom}::date
       WHERE hsn_code = ${hsn} AND effective_to IS NULL AND effective_from < ${effectiveFrom}::date
    `.execute(trx);
    const row = (await sql<any>`
      INSERT INTO hsn_tax_rates (hsn_code, gst_rate_pct, cess_rate_pct, effective_from)
      VALUES (${hsn}, ${rate}, ${body.cess_rate_pct === undefined ? 0 : num(body.cess_rate_pct, 'Cess rate', { min: 0, max: 100 })},
              ${effectiveFrom}::date)
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

  // ── Bulk import (4.9 "bulk Excel import", Phase 1) ────────────────────────
  // Accepts rows already parsed to JSON by the client. Everything is validated in
  // one transaction, so a spreadsheet with one bad row imports nothing rather
  // than half a catalog.
  app.post('/products/bulk-import', guarded('edit_catalog', async ({ session, db: trx, req }) => {
    const body = (req.body ?? {}) as { rows?: unknown };
    if (!Array.isArray(body.rows) || body.rows.length === 0) throw badRequest('Provide a non-empty "rows" array.');
    if (body.rows.length > 2000) throw badRequest('Import at most 2000 rows at a time.');

    // Every row is validated BEFORE a single insert. Validating inside the write
    // loop meant the first bad row aborted the Postgres transaction, and every
    // subsequent row then failed with "current transaction is aborted" — so the
    // error report blamed rows that were perfectly fine.
    const errors: { row: number; message: string }[] = [];
    const validated: any[] = [];
    const knownHsn = new Set(
      (await sql<{ hsn_code: string }>`SELECT DISTINCT hsn_code FROM hsn_tax_rates WHERE effective_to IS NULL`
        .execute(trx)).rows.map((r) => r.hsn_code),
    );
    const seenSkus = new Set<string>();

    for (let i = 0; i < body.rows.length; i++) {
      const r = body.rows[i] as Record<string, unknown>;
      try {
        const sku = str(r.sku, 'sku', { max: 60 });
        const name = str(r.name, 'name', { max: 200 });
        const baseUnit = oneOf(r.base_unit, 'base_unit', BASE_UNITS);
        const hsn = str(r.hsn_code, 'hsn_code', { max: 12 });
        const price = num(r.selling_price, 'selling_price', { min: 0 });
        const mrp = r.mrp === undefined ? price : num(r.mrp, 'mrp', { min: 0 });
        // 2.7 — the same gate the single-product form applies. Without it an
        // imported product reached the billing screen and was billed at 0% GST.
        if (!knownHsn.has(hsn)) {
          throw badRequest(`no GST rate is on file for HSN ${hsn}`);
        }
        if (mrp < price) throw badRequest('mrp is below selling_price');
        if (seenSkus.has(sku)) throw badRequest(`sku ${sku} appears more than once in this file`);
        seenSkus.add(sku);
        validated.push({ sku, name, baseUnit, hsn, price, mrp, raw: r });
      } catch (err) {
        errors.push({ row: i + 1, message: err instanceof Error ? err.message : 'Invalid row' });
      }
    }

    if (errors.length) {
      throw badRequest(
        `Import cancelled: ${errors.length} row(s) could not be read. Nothing was changed.`,
        errors.slice(0, 20));
    }

    let created = 0, updated = 0;
    for (const v of validated) {
      {
        const { sku, name, baseUnit, hsn, price, mrp, raw: r } = v;
        const existing = (await sql<any>`SELECT product_id FROM products WHERE sku = ${sku}`.execute(trx)).rows[0];
        if (existing) {
          await sql`UPDATE products SET name = ${name}, hsn_code = ${hsn} WHERE product_id = ${existing.product_id}`.execute(trx);
          await sql`UPDATE product_prices SET effective_to = now()
                     WHERE product_id = ${existing.product_id} AND effective_to IS NULL AND branch_id IS NULL`.execute(trx);
          await sql`INSERT INTO product_prices (product_id, mrp, selling_price, created_by)
                    VALUES (${existing.product_id}, ${mrp}, ${price}, ${session.user_id})`.execute(trx);
          updated++;
        } else {
          const p = (await sql<any>`
            INSERT INTO products (sku, name, base_unit, hsn_code, category_id, brand_id, reference_purchase_price)
            VALUES (${sku}, ${name}, ${baseUnit}::base_unit_type, ${hsn},
                    ${optionalUuid(r.category_id, 'category_id')}, ${optionalUuid(r.brand_id, 'brand_id')},
                    ${r.reference_purchase_price === undefined ? null : num(r.reference_purchase_price, 'reference_purchase_price', { min: 0 })})
            RETURNING product_id
          `.execute(trx)).rows[0];
          await sql`INSERT INTO product_units (product_id, unit_label, multiplier_to_base, is_default_sale_unit)
                    VALUES (${p.product_id}, ${baseUnit}, 1, TRUE)`.execute(trx);
          await sql`INSERT INTO product_prices (product_id, mrp, selling_price, created_by)
                    VALUES (${p.product_id}, ${mrp}, ${price}, ${session.user_id})`.execute(trx);
          created++;
        }
      }
    }

    await audit(trx, session, 'PRICE_CHANGE', 'products', null, { after: { bulk_import: { created, updated } } });
    return { ok: true, created, updated };
  }));

  // ── Margin view (2.6) ─────────────────────────────────────────────────────
  // Owner-only by default, but the requirement explicitly lets the Owner grant a
  // Branch Manager sight of their own branch's costs. Gating this purely on the
  // static role matrix ignored that setting, so the toggle worked for column
  // masking everywhere else and silently did nothing here.
  app.get('/margins', guarded(null, async ({ session, db: trx, req }) => {
    const settings = await loadSettings(trx, session.branch_id);
    if (!canSeeCost(session.role, settings)) {
      throw forbidden('Cost and margin figures are restricted. An Owner can grant a Branch Manager access under Admin → Settings → Catalog.');
    }
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const rows = await sql<any>`
      SELECT p.product_id, p.sku, p.name, c.name AS category_name, b.name AS branch_name,
             pp.selling_price, p.reference_purchase_price AS expected_cost,
             bs.weighted_avg_cost AS actual_cost, bs.base_unit_qty,
             (pp.selling_price - bs.weighted_avg_cost) AS margin_amount,
             CASE WHEN pp.selling_price > 0
                  THEN round(((pp.selling_price - bs.weighted_avg_cost) / pp.selling_price) * 100, 2)
                  ELSE NULL END AS margin_pct
        FROM branch_stock bs
        JOIN products p ON p.product_id = bs.product_id
        JOIN branches b ON b.branch_id = bs.branch_id
        LEFT JOIN categories c ON c.category_id = p.category_id
        LEFT JOIN LATERAL (SELECT selling_price FROM product_prices
                            WHERE product_id = p.product_id AND effective_to IS NULL LIMIT 1) pp ON TRUE
       WHERE p.is_active ${q.branch_id ? sql`AND bs.branch_id = ${uuid(q.branch_id, 'branch_id')}` : sql``}
       ORDER BY margin_pct ASC NULLS LAST
       LIMIT ${clampLimit(q.limit, 200, 500)}
    `.execute(trx);
    // The "expected vs actual" gap the requirement asks to surface at a glance (2.6).
    return rows.rows.map((r: any) => ({
      ...r,
      cost_variance: r.expected_cost != null && r.actual_cost != null
        ? round2(Number(r.actual_cost) - Number(r.expected_cost)) : null,
    }));
  }));
}
