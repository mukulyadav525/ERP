// ============================================================================
// Catalog (spec §8–§14)
//
// Products, the units they are sold in, their barcodes and prices, and the
// master lists behind them (categories, brands, units, GST rates). A product has
// one BASE unit that stock and prices are kept in; every other sale unit states
// how many base units it holds. Measured units (100 G of a KG product) are
// derived from the units master and cannot be typed wrong; pack sizes (a BOX of
// 100) are stated, because only the person holding the box knows.
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiDelete, apiPost, apiPut, businessToday, downloadCsv, fetcher, formatDate, inr, num, qtyWithUnit,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field,
  Modal, PageHeader, Pager, RequirePermission, SearchInput, Switch, Tabs, useDebounced,
} from '../../components/ui';
import { VendorPicker, type VendorHit } from '../../components/pickers';
import { Icon } from '../../components/icons';

export default function CatalogPage() {
  return (
    <RequirePermission permission="view_catalog">
      <CatalogScreen />
    </RequirePermission>
  );
}

interface UnitMaster {
  unit_code: string; name: string; print_label: string; dimension: string;
  to_dimension_base: string | number | null; allows_fraction: boolean; is_system: boolean; is_active: boolean; product_count?: number;
}
const DIMENSION_LABEL: Record<string, string> = { COUNT: 'Count', MASS: 'Weight', LENGTH: 'Length', VOLUME: 'Volume', AREA: 'Area', PACK: 'Pack (size per product)' };
const GST_SLABS = ['0', '0.25', '3', '5', '12', '18', '28', '40'];
const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');

/** How many base units one `unit` holds, when it can be derived from the units master. */
function derived(base: UnitMaster | undefined, unit: UnitMaster | undefined): number | null {
  if (!base || !unit || unit.dimension === 'PACK' || base.dimension === 'PACK') return null;
  if (unit.dimension !== base.dimension) return null;
  const b = Number(base.to_dimension_base), u = Number(unit.to_dimension_base);
  if (!b || !u) return null;
  return Math.round((u / b) * 1e6) / 1e6;
}

function CatalogScreen() {
  const { can } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [tab, setTab] = useState<'products' | 'categories' | 'brands' | 'units' | 'tax' | 'margins'>('products');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [newBarcode, setNewBarcode] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const { data: categories, mutate: mutateCategories } = useSWR<any[]>('/api/catalog/categories?include_inactive=true', fetcher);
  const { data: brands, mutate: mutateBrands } = useSWR<any[]>('/api/catalog/brands?include_inactive=true', fetcher);
  const { data: units, mutate: mutateUnits } = useSWR<UnitMaster[]>('/api/catalog/units?include_inactive=true', fetcher);
  const { data: hsn, mutate: mutateHsn } = useSWR<any[]>('/api/catalog/hsn-rates', fetcher);

  // ?new=1&barcode=… — "Create product" from an unknown scan at the counter.
  useEffect(() => {
    if (router.query.new === '1' && can('edit_catalog')) {
      setNewBarcode(typeof router.query.barcode === 'string' ? router.query.barcode : null);
      setEditing('new');
    }
    if (typeof router.query.product === 'string') setEditing(router.query.product);
  }, [router.query.new, router.query.barcode, router.query.product, can]);

  const master = { categories: categories ?? [], brands: brands ?? [], units: units ?? [], hsn: hsn ?? [],
    refresh: () => { void mutateCategories(); void mutateBrands(); void mutateUnits(); void mutateHsn(); } };

  return (
    <>
      <PageHeader title={t('navCatalog')} subtitle="Products, units, barcodes and prices"
        actions={can('edit_catalog') && <>
          <Button onClick={() => setImportOpen(true)}><Icon name="download" size={14} /> Import CSV</Button>
          <Button variant="primary" onClick={() => { setNewBarcode(null); setEditing('new'); }}><Icon name="plus" size={14} /> New product</Button>
        </>} />
      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'products', label: t('products') },
          { key: 'categories', label: 'Categories' },
          { key: 'brands', label: 'Brands' },
          { key: 'units', label: 'Units' },
          { key: 'tax', label: 'GST rates' },
          ...(can('view_cost_price') ? [{ key: 'margins', label: 'Margins' }] : []),
        ]} />

      {tab === 'products' && <ProductsTab master={master} onOpen={(id) => setEditing(id)} />}
      {tab === 'categories' && <CategoriesTab categories={categories ?? []} onChanged={() => void mutateCategories()} />}
      {tab === 'brands' && <BrandsTab brands={brands ?? []} onChanged={() => void mutateBrands()} />}
      {tab === 'units' && <UnitsTab units={units ?? []} onChanged={() => void mutateUnits()} />}
      {tab === 'tax' && <TaxTab rates={hsn ?? []} onChanged={() => void mutateHsn()} />}
      {tab === 'margins' && <MarginsTab />}

      <ProductEditor id={editing} initialBarcode={newBarcode} master={master}
        onClose={() => { setEditing(null); if (router.query.new || router.query.product) void router.replace('/catalog', undefined, { shallow: true }); }}
        onSaved={(id) => setEditing(id)} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

type Master = { categories: any[]; brands: any[]; units: UnitMaster[]; hsn: any[]; refresh: () => void };

// ── Product list ─────────────────────────────────────────────────────────────
function ProductsTab({ master, onOpen }: { master: Master; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [status, setStatus] = useState('active');
  const [stock, setStock] = useState('');
  const [limit, setLimit] = useState(100);
  const params = new URLSearchParams({ limit: String(limit), status });
  if (search) params.set('q', search);
  if (category) params.set('category_id', category);
  if (brand) params.set('brand_id', brand);
  if (stock) params.set('stock', stock);
  const { data, error, isLoading, mutate } = useSWR<any[]>(`/api/catalog/products?${params}`, fetcher, { keepPreviousData: true });

  return (
    <>
      <div className="table-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Name, SKU or barcode…" />
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {master.categories.filter((c) => c.is_active).map((c) => <option key={c.category_id} value={c.category_id}>{c.path ?? c.name}</option>)}
        </select>
        <select aria-label="Brand" value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">All brands</option>
          {master.brands.filter((b) => b.is_active).map((b) => <option key={b.brand_id} value={b.brand_id}>{b.name}</option>)}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
        </select>
        <select aria-label="Stock" value={stock} onChange={(e) => setStock(e.target.value)}>
          <option value="">Any stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
        </select>
        <div className="spacer" />
        <Button onClick={() => downloadCsv((data ?? []).map((p) => ({
          sku: p.sku, name: p.name, category: p.category_name, brand: p.brand_name, base_unit: p.base_unit, hsn_code: p.hsn_code,
          gst_rate: p.gst_rate_pct, price_type: p.default_price_type, selling_price: p.selling_price, mrp: p.mrp, barcode: p.barcode,
          reorder_level: p.default_reorder_level, units: (p.units ?? []).filter((u: any) => !u.is_base).map((u: any) => `${u.unit_code}=${u.multiplier_to_base}`).join(' '),
          stock: p.base_unit_qty, active: p.is_active,
        })), 'products.csv')} disabled={!data?.length}><Icon name="download" size={14} /> Export</Button>
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="catalog" title="No products" text={search ? 'Nothing matches that search.' : 'Add your first product, or import a CSV.'} />}>
          {(rows) => (
            <>
              <DataTable rows={rows} rowKey={(p: any) => p.product_id} onRowClick={(p: any) => onOpen(p.product_id)}
                columns={[
                  { key: 'n', header: t('product'), render: (p: any) => (
                    <div><span style={{ fontWeight: 550 }}>{p.name}</span>{!p.is_active && <> <Badge tone="neutral">inactive</Badge></>}
                      <div className="muted small mono">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''}</div></div>) },
                  { key: 'c', header: 'Category / brand', render: (p: any) => <div>{p.category_name ?? '—'}<div className="muted small">{p.brand_name ?? ''}</div></div> },
                  { key: 'h', header: 'HSN · GST', nowrap: true, render: (p: any) => <span className="mono small">{p.hsn_code} · {num(p.gst_rate_pct ?? 0, 2)}%</span> },
                  { key: 'u', header: 'Sold in', render: (p: any) => (
                    <div className="row tight">{(p.units ?? []).map((u: any) => (
                      <Badge key={u.product_unit_id} tone={u.is_default ? 'info' : 'neutral'}>{u.print_label}</Badge>))}</div>) },
                  { key: 'p', header: 'Price', align: 'right', render: (p: any) => {
                    const u = (p.units ?? []).find((x: any) => x.is_default) ?? (p.units ?? [])[0];
                    const per = Number(p.selling_price ?? 0) * Number(u?.multiplier_to_base ?? 1);
                    return <div>{inr(per, { decimals: true })} <span className="muted small">/ {u?.print_label ?? p.base_unit_label}</span>
                      <div className="muted small">{p.default_price_type === 'TAX_INCLUSIVE' ? 'incl. GST' : '+ GST'}</div></div>;
                  } },
                  { key: 's', header: 'Stock', align: 'right', render: (p: any) => {
                    const q = Number(p.base_unit_qty ?? 0);
                    return <span className="nowrap">{q <= 0 ? <Badge tone="critical">out</Badge> : q <= Number(p.reorder_min ?? 0) ? <Badge tone="warning">low</Badge> : null} {qtyWithUnit(q, p.base_unit_label)}</span>;
                  } },
                ]} />
              <Pager shown={rows.length} pageSize={100} onMore={() => setLimit((l) => l + 100)} />
            </>
          )}
        </AsyncSection>
      </Card>
    </>
  );
}

// ── Product editor ───────────────────────────────────────────────────────────
interface NewUnit { unit_code: string; size: string; is_default: boolean }
const EMPTY = {
  name: '', sku: '', description: '', category_id: '', brand_id: '', base_unit: 'PIECE', hsn_code: '',
  default_price_type: 'TAX_INCLUSIVE', selling_price: '', mrp: '', reference_purchase_price: '', reorder_level: '',
  batch_tracked: false, serial_tracked: false, is_active: true,
};

function ProductEditor({ id, initialBarcode, master, onClose, onSaved }: {
  id: string | 'new' | null; initialBarcode: string | null; master: Master; onClose: () => void; onSaved: (id: string) => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const isNew = id === 'new';
  const { data: product, mutate } = useSWR<any>(id && id !== 'new' ? `/api/catalog/products/${id}` : null, fetcher);
  const [form, setForm] = useState({ ...EMPTY });
  const [vendor, setVendor] = useState<VendorHit | null>(null);
  const [newUnits, setNewUnits] = useState<NewUnit[]>([]);
  const [barcodes, setBarcodes] = useState<string[]>([]);
  const [barcodeText, setBarcodeText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const mayEdit = can('edit_catalog');

  useEffect(() => {
    setErrors({}); setBarcodeText('');
    if (id === 'new') {
      setForm({ ...EMPTY }); setVendor(null); setNewUnits([]); setBarcodes(initialBarcode ? [initialBarcode] : []);
    }
  }, [id, initialBarcode]);
  useEffect(() => {
    if (!product) return;
    setForm({
      name: product.name ?? '', sku: product.sku ?? '', description: product.description ?? '', category_id: product.category_id ?? '',
      brand_id: product.brand_id ?? '', base_unit: product.base_unit, hsn_code: product.hsn_code ?? '',
      default_price_type: product.default_price_type, selling_price: '', mrp: '',
      reference_purchase_price: product.reference_purchase_price === null || product.reference_purchase_price === undefined ? '' : String(Number(product.reference_purchase_price)),
      reorder_level: product.reorder_level === null || product.reorder_level === undefined ? '' : String(Number(product.reorder_level)),
      batch_tracked: Boolean(product.batch_tracked), serial_tracked: Boolean(product.serial_tracked), is_active: Boolean(product.is_active),
    });
    setVendor(product.preferred_vendor_id ? { vendor_id: product.preferred_vendor_id, name: product.preferred_vendor_name } : null);
  }, [product]);
  const set = (k: keyof typeof EMPTY, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const unitMap = useMemo(() => new Map(master.units.map((u) => [u.unit_code, u])), [master.units]);
  const baseUnit = unitMap.get(form.base_unit);
  const hsnRate = master.hsn.find((h) => h.hsn_code === form.hsn_code.trim());
  const currentPrice = product?.prices?.find((p: any) => !p.effective_to && !p.branch_id);

  async function quickAdd(kind: 'categories' | 'brands') {
    const name = window.prompt(kind === 'categories' ? 'New category name:' : 'New brand name:');
    if (!name || !name.trim()) return;
    try {
      const row = await apiPost<any>(`/api/catalog/${kind}`, { name: name.trim() });
      master.refresh();
      set(kind === 'categories' ? 'category_id' : 'brand_id', kind === 'categories' ? row.category_id : row.brand_id);
      toast.success(kind === 'categories' ? 'Category added' : 'Brand added', row.name);
    } catch (err) { toast.error(err); }
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Enter the product name.';
    if (isNew && !/^[A-Za-z0-9][A-Za-z0-9\-_./]{0,59}$/.test(form.sku.trim())) e.sku = 'Letters, digits and - _ . / only, e.g. PLB-PIPE-15.';
    if (!/^[0-9]{4,8}$/.test(form.hsn_code.trim())) e.hsn_code = 'An HSN code is 4–8 digits.';
    else if (!hsnRate) e.hsn_code = 'This HSN has no GST rate on file. Add it on the GST rates tab first.';
    if (isNew) {
      if (!(Number(form.selling_price) > 0)) e.selling_price = 'Enter the selling price.';
      if (form.mrp && Number(form.mrp) < Number(form.selling_price)) e.mrp = 'MRP cannot be below the selling price.';
      for (const u of newUnits) {
        const m = unitMap.get(u.unit_code);
        if (m?.dimension === 'PACK' && !(Number(u.size) > 0)) e.units = `Enter how many ${baseUnit?.print_label ?? 'base units'} are in one ${m.print_label}.`;
      }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setBusy(true);
    const common = {
      name: form.name.trim(), description: form.description.trim() || null, category_id: form.category_id || null,
      brand_id: form.brand_id || null, hsn_code: form.hsn_code.trim(), default_price_type: form.default_price_type,
      reference_purchase_price: form.reference_purchase_price === '' ? null : Number(form.reference_purchase_price),
      reorder_level: form.reorder_level === '' ? null : Number(form.reorder_level),
      batch_tracked: form.batch_tracked, serial_tracked: form.serial_tracked, preferred_vendor_id: vendor?.vendor_id ?? null,
    };
    try {
      if (isNew) {
        const res = await apiPost<any>('/api/catalog/products', {
          ...common, sku: form.sku.trim().toUpperCase(), base_unit: form.base_unit,
          selling_price: Number(form.selling_price), mrp: form.mrp === '' ? undefined : Number(form.mrp),
          units: newUnits.map((u) => ({ unit_code: u.unit_code, multiplier_to_base: u.size === '' ? undefined : Number(u.size), is_default: u.is_default })),
          barcodes,
        });
        toast.success('Product created', `${res.sku} · ${res.name}`);
        onSaved(res.product_id);
      } else {
        await apiPut(`/api/catalog/products/${id}`, {
          ...common, is_active: form.is_active, ...(product && !product.has_movements && form.base_unit !== product.base_unit ? { base_unit: form.base_unit } : {}),
        });
        toast.success('Product saved', form.name);
        void mutate();
      }
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  // Edit-mode unit and barcode actions apply immediately.
  async function addUnit(code: string, size: string, isDefault: boolean) {
    try {
      await apiPost(`/api/catalog/products/${id}/units`, { unit_code: code, multiplier_to_base: size === '' ? undefined : Number(size), is_default_sale_unit: isDefault });
      toast.success('Unit added'); void mutate();
    } catch (err) { toast.error(err); }
  }
  async function makeDefault(unitId: string) {
    try { await apiPut(`/api/catalog/products/${id}/units/${unitId}`, { is_default_sale_unit: true }); void mutate(); } catch (err) { toast.error(err); }
  }
  async function removeUnit(unitId: string, label: string) {
    if (!window.confirm(`Remove the ${label} unit from this product?`)) return;
    try { await apiDelete(`/api/catalog/products/${id}/units/${unitId}`); toast.success('Unit removed'); void mutate(); } catch (err) { toast.error(err); }
  }
  async function addBarcode() {
    const code = barcodeText.trim();
    if (!code) return;
    if (isNew) { if (!barcodes.includes(code)) setBarcodes([...barcodes, code]); setBarcodeText(''); return; }
    try { await apiPost(`/api/catalog/products/${id}/barcodes`, { barcode: code }); setBarcodeText(''); toast.success('Barcode added'); void mutate(); }
    catch (err) { toast.error(err); }
  }
  async function removeBarcode(b: any) {
    if (!window.confirm(`Remove barcode ${b.barcode}?`)) return;
    try { await apiDelete(`/api/catalog/products/${id}/barcodes/${b.barcode_id}`); void mutate(); } catch (err) { toast.error(err); }
  }

  const title = isNew ? 'New product' : product ? product.name : 'Product';
  const baseLocked = !isNew && Boolean(product?.has_movements);
  const availableUnits = master.units.filter((u) => u.is_active && u.unit_code !== form.base_unit
    && !(isNew ? newUnits.some((n) => n.unit_code === u.unit_code) : (product?.units ?? []).some((x: any) => x.unit_code === u.unit_code))
    && (u.dimension === 'PACK' || u.dimension === baseUnit?.dimension));

  return (
    <Modal open={id !== null} onClose={onClose} wide title={title}
      footer={mayEdit ? <>
        {!isNew && can('edit_pricing') && <Button onClick={() => setPriceOpen(true)}>Change price…</Button>}
        <span className="spacer" />
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Create product' : 'Save changes'}</Button>
      </> : <Button onClick={onClose}>Close</Button>}>
      {!isNew && !product ? <div className="muted">Loading…</div> : (
        <div className="stack">
          {!isNew && !form.is_active && <Alert tone="warning">This product is inactive — it is not offered at the counter.</Alert>}
          <div className="form-grid">
            <Field label="Product name" required error={errors.name}><input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={200} disabled={!mayEdit} autoFocus={isNew} /></Field>
            <Field label="SKU" required={isNew} error={errors.sku} hint={isNew ? 'Your own short code, e.g. PLB-PIPE-15' : 'The SKU cannot be changed'}>
              <input className="mono" value={form.sku} onChange={(e) => set('sku', e.target.value.toUpperCase())} disabled={!isNew} maxLength={60} /></Field>
            <Field label="Category">
              <div className="row tight" style={{ flexWrap: 'nowrap' }}>
                <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)} disabled={!mayEdit}>
                  <option value="">None</option>
                  {master.categories.filter((c) => c.is_active || c.category_id === form.category_id).map((c) => <option key={c.category_id} value={c.category_id}>{c.path ?? c.name}</option>)}
                </select>
                {can('manage_master_data') && <Button size="sm" onClick={() => void quickAdd('categories')} title="Add a category">+ New</Button>}
              </div>
            </Field>
            <Field label="Brand">
              <div className="row tight" style={{ flexWrap: 'nowrap' }}>
                <select value={form.brand_id} onChange={(e) => set('brand_id', e.target.value)} disabled={!mayEdit}>
                  <option value="">None</option>
                  {master.brands.filter((b) => b.is_active || b.brand_id === form.brand_id).map((b) => <option key={b.brand_id} value={b.brand_id}>{b.name}</option>)}
                </select>
                {can('manage_master_data') && <Button size="sm" onClick={() => void quickAdd('brands')} title="Add a brand">+ New</Button>}
              </div>
            </Field>
            <Field label="HSN code" required error={errors.hsn_code} hint={hsnRate ? `GST ${num(hsnRate.gst_rate_pct, 2)}%` : 'Choose from the list, or add the rate first'}>
              <input className="mono" list="hsn-codes" value={form.hsn_code} onChange={(e) => set('hsn_code', e.target.value.replace(/\D/g, ''))} maxLength={8} disabled={!mayEdit} />
            </Field>
            <datalist id="hsn-codes">{master.hsn.map((h) => <option key={h.hsn_code} value={h.hsn_code}>{`${num(h.gst_rate_pct, 2)}% GST`}</option>)}</datalist>
            <Field label="Prices are">
              <select value={form.default_price_type} onChange={(e) => set('default_price_type', e.target.value)} disabled={!mayEdit}>
                <option value="TAX_INCLUSIVE">Including GST (MRP style)</option><option value="TAX_EXCLUSIVE">Excluding GST</option>
              </select>
            </Field>
            <Field label="Base unit" hint={baseLocked ? 'Fixed — this product already has stock or sales' : 'Stock and prices are kept in this unit'}>
              <select value={form.base_unit} onChange={(e) => { set('base_unit', e.target.value); setNewUnits([]); }} disabled={!mayEdit || baseLocked}>
                {master.units.filter((u) => u.is_active || u.unit_code === form.base_unit).map((u) => <option key={u.unit_code} value={u.unit_code}>{u.name} ({u.print_label})</option>)}
              </select>
            </Field>
            {isNew ? (
              <>
                <Field label={`Selling price per ${baseUnit?.print_label ?? 'unit'} (₹)`} required error={errors.selling_price}>
                  <input inputMode="decimal" value={form.selling_price} onChange={(e) => set('selling_price', decimalOnly(e.target.value))} /></Field>
                <Field label={`MRP per ${baseUnit?.print_label ?? 'unit'} (₹)`} error={errors.mrp} hint="Optional; at least the selling price">
                  <input inputMode="decimal" value={form.mrp} onChange={(e) => set('mrp', decimalOnly(e.target.value))} /></Field>
              </>
            ) : (
              <Field label="Current price">
                <div style={{ paddingTop: 6 }}>{currentPrice
                  ? <><b>{inr(currentPrice.selling_price, { decimals: true })}</b> / {product.base_unit_label} · MRP {inr(currentPrice.mrp, { decimals: true })}</>
                  : <span className="muted">No price set</span>}</div>
              </Field>
            )}
            {(can('view_cost_price') || isNew) && (
              <Field label={`Expected cost per ${baseUnit?.print_label ?? 'unit'} (₹, ex-GST)`} hint="Used for reorder planning; actual cost comes from purchases">
                <input inputMode="decimal" value={form.reference_purchase_price} onChange={(e) => set('reference_purchase_price', decimalOnly(e.target.value))} disabled={!mayEdit} /></Field>
            )}
            <Field label={`Reorder level (${baseUnit?.print_label ?? 'base units'})`} hint="Shows as low stock at or below this; branches can override">
              <input inputMode="decimal" value={form.reorder_level} onChange={(e) => set('reorder_level', decimalOnly(e.target.value))} disabled={!mayEdit} /></Field>
            <Field label="Usual supplier"><VendorPicker value={vendor} onSelect={setVendor} /></Field>
            <div className="span-2"><Field label="Description"><input value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} disabled={!mayEdit} /></Field></div>
            <div className="row" style={{ gap: 18 }}>
              <Switch checked={form.batch_tracked} onChange={(v) => set('batch_tracked', v)} disabled={!mayEdit} label="Track batches & expiry" />
              <Switch checked={form.serial_tracked} onChange={(v) => set('serial_tracked', v)} disabled={!mayEdit} label="Track serial numbers" />
              {!isNew && <Switch checked={form.is_active} onChange={(v) => set('is_active', v)} disabled={!mayEdit} label="Active" />}
            </div>
          </div>

          <div>
            <div className="section-title">Sale units</div>
            {errors.units && <Alert tone="critical">{errors.units}</Alert>}
            <UnitsEditor
              baseUnit={baseUnit}
              rows={isNew
                ? [{ key: form.base_unit, code: form.base_unit, label: baseUnit?.print_label ?? form.base_unit, size: 1, is_base: true, is_default: !newUnits.some((u) => u.is_default) },
                   ...newUnits.map((u) => {
                     const m = unitMap.get(u.unit_code);
                     return { key: u.unit_code, code: u.unit_code, label: m?.print_label ?? u.unit_code, size: m?.dimension === 'PACK' ? (u.size === '' ? null : Number(u.size)) : derived(baseUnit, m), is_base: false, is_default: u.is_default, pack: m?.dimension === 'PACK', rawSize: u.size };
                   })]
                : (product?.units ?? []).map((u: any) => ({ key: u.product_unit_id, id: u.product_unit_id, code: u.unit_code, label: u.print_label, size: Number(u.multiplier_to_base), is_base: u.is_base, is_default: u.is_default }))}
              available={availableUnits}
              unitMap={unitMap}
              mayEdit={mayEdit}
              price={isNew ? Number(form.selling_price || 0) : Number(currentPrice?.selling_price ?? 0)}
              onAdd={(code, size, isDefault) => {
                if (isNew) setNewUnits((prev) => [...prev.map((u) => (isDefault ? { ...u, is_default: false } : u)), { unit_code: code, size, is_default: isDefault }]);
                else void addUnit(code, size, isDefault);
              }}
              onSize={(key, size) => setNewUnits((prev) => prev.map((u) => (u.unit_code === key ? { ...u, size } : u)))}
              onDefault={(row) => {
                if (isNew) setNewUnits((prev) => prev.map((u) => ({ ...u, is_default: !row.is_base && u.unit_code === row.code })));
                else if (row.id) void makeDefault(row.id);
              }}
              onRemove={(row) => {
                if (isNew) setNewUnits((prev) => prev.filter((u) => u.unit_code !== row.code));
                else if (row.id) void removeUnit(row.id, row.label);
              }} />
          </div>

          <div>
            <div className="section-title">Barcodes</div>
            <div className="row tight">
              {(isNew ? barcodes.map((b) => ({ barcode: b, barcode_id: b })) : (product?.barcodes ?? [])).map((b: any) => (
                <Badge key={b.barcode_id} tone="neutral">
                  <span className="mono">{b.barcode}</span>{b.unit_label ? ` · ${b.unit_label}` : ''}
                  {mayEdit && <button type="button" className="icon-btn" style={{ marginLeft: 4, width: 18, height: 18 }} aria-label={`Remove barcode ${b.barcode}`}
                    onClick={() => (isNew ? setBarcodes(barcodes.filter((x) => x !== b.barcode)) : void removeBarcode(b))}><Icon name="close" size={11} /></button>}
                </Badge>
              ))}
              {!(isNew ? barcodes.length : product?.barcodes?.length) && <span className="muted small">No barcode — the product is found by name or SKU.</span>}
            </div>
            {mayEdit && (
              <div className="row tight" style={{ marginTop: 8, maxWidth: 420 }}>
                <input className="mono" aria-label="New barcode" placeholder="Scan or type a barcode" value={barcodeText}
                  onChange={(e) => setBarcodeText(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addBarcode(); } }} />
                <Button size="sm" onClick={() => void addBarcode()} disabled={!barcodeText}>Add</Button>
              </div>
            )}
          </div>

          {!isNew && product && (
            <div className="grid cols-2">
              <div>
                <div className="section-title">Stock by branch</div>
                <DataTable rows={product.stock ?? []} emptyText="No stock at any branch yet." rowKey={(s: any) => s.branch_id}
                  columns={[
                    { key: 'b', header: 'Branch', render: (s: any) => s.branch_name },
                    { key: 'q', header: 'On hand', align: 'right', render: (s: any) => qtyWithUnit(s.base_unit_qty, product.base_unit_label) },
                    { key: 'r', header: 'Reorder at', align: 'right', render: (s: any) => (s.effective_reorder !== null ? qtyWithUnit(s.effective_reorder, product.base_unit_label) : '—') },
                  ]} />
              </div>
              <div>
                <div className="section-title">Price history</div>
                <DataTable rows={(product.prices ?? []).slice(0, 8)} emptyText="No prices." rowKey={(p: any) => p.price_id}
                  columns={[
                    { key: 'f', header: 'From', nowrap: true, render: (p: any) => formatDate(p.effective_from) },
                    { key: 'b', header: 'Applies to', render: (p: any) => p.branch_name ?? 'All branches' },
                    { key: 's', header: 'Price', align: 'right', render: (p: any) => inr(p.selling_price, { decimals: true }) },
                    { key: 'm', header: 'MRP', align: 'right', render: (p: any) => inr(p.mrp, { decimals: true }) },
                    { key: 't', header: '', render: (p: any) => (p.effective_to ? <span className="muted small">until {formatDate(p.effective_to)}</span> : <Badge tone="good">current</Badge>) },
                  ]} />
              </div>
            </div>
          )}
        </div>
      )}
      {!isNew && product && <PriceModal open={priceOpen} product={product} onClose={() => setPriceOpen(false)} onDone={() => { setPriceOpen(false); void mutate(); }} />}
    </Modal>
  );
}

interface UnitRowView { key: string; id?: string; code: string; label: string; size: number | null; is_base: boolean; is_default: boolean; pack?: boolean; rawSize?: string }

function UnitsEditor({ baseUnit, rows, available, unitMap, mayEdit, price, onAdd, onSize, onDefault, onRemove }: {
  baseUnit: UnitMaster | undefined; rows: UnitRowView[]; available: UnitMaster[]; unitMap: Map<string, UnitMaster>; mayEdit: boolean; price: number;
  onAdd: (code: string, size: string, isDefault: boolean) => void; onSize: (key: string, size: string) => void;
  onDefault: (row: UnitRowView) => void; onRemove: (row: UnitRowView) => void;
}) {
  const [code, setCode] = useState('');
  const [size, setSize] = useState('');
  const picked = unitMap.get(code);
  const auto = derived(baseUnit, picked);
  const bl = baseUnit?.print_label ?? 'base unit';
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="table-wrap">
        <table className="data compact">
          <thead><tr><th>Unit</th><th className="num">Holds</th><th className="num">Price per unit</th><th>Default at the counter</th><th aria-label="Remove" /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td><b>{r.label}</b>{r.is_base && <span className="muted small"> · base unit</span>}</td>
                <td className="num nowrap">
                  {r.pack && r.rawSize !== undefined
                    ? <span className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <input inputMode="decimal" aria-label={`${bl} in one ${r.label}`} value={r.rawSize} style={{ width: 80 }} onChange={(e) => onSize(r.code, decimalOnly(e.target.value))} />
                        <span className="muted small">{bl}</span>
                      </span>
                    : r.size !== null ? `${num(r.size, 6)} ${bl}` : '—'}
                </td>
                <td className="num nowrap">{price > 0 && r.size ? inr(price * r.size, { decimals: true }) : '—'}</td>
                <td>{r.is_default ? <Badge tone="info">default</Badge> : mayEdit ? <Button size="sm" variant="ghost" onClick={() => onDefault(r)}>Make default</Button> : null}</td>
                <td>{!r.is_base && mayEdit && <button type="button" className="icon-btn" aria-label={`Remove ${r.label}`} onClick={() => onRemove(r)}><Icon name="trash" size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mayEdit && (
        <div className="row tight" style={{ alignItems: 'flex-end' }}>
          <Field label="Add a sale unit">
            <select value={code} onChange={(e) => { setCode(e.target.value); setSize(''); }} style={{ minWidth: 200 }}>
              <option value="">Choose a unit…</option>
              {available.map((u) => <option key={u.unit_code} value={u.unit_code}>{u.name} ({u.print_label}){u.dimension === 'PACK' ? ' — pack' : ''}</option>)}
            </select>
          </Field>
          {picked && (picked.dimension === 'PACK'
            ? <Field label={`${bl} in one ${picked.print_label}`}><input inputMode="decimal" value={size} onChange={(e) => setSize(decimalOnly(e.target.value))} style={{ width: 110 }} /></Field>
            : <div className="muted small" style={{ paddingBottom: 9 }}>1 {picked.print_label} = {auto !== null ? num(auto, 6) : '?'} {bl} (fixed)</div>)}
          <Button size="sm" disabled={!code || (picked?.dimension === 'PACK' && !(Number(size) > 0))} onClick={() => { onAdd(code, size, false); setCode(''); setSize(''); }}>Add unit</Button>
        </div>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        Weights, lengths and volumes convert automatically (100 G is 0.1 KG). A pack unit — box, bag, tin — needs its size, because a box of screws is not a box of bolts.
      </p>
    </div>
  );
}

function PriceModal({ open, product, onClose, onDone }: { open: boolean; product: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const current = product.prices?.find((p: any) => !p.effective_to && !p.branch_id);
  const [price, setPrice] = useState('');
  const [mrp, setMrp] = useState('');
  useEffect(() => { if (open) { setPrice(current ? String(Number(current.selling_price)) : ''); setMrp(current ? String(Number(current.mrp)) : ''); } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    if (!(Number(price) > 0)) { toast.error(new Error('Enter the new selling price.')); return; }
    if (mrp && Number(mrp) < Number(price)) { toast.error(new Error('MRP cannot be below the selling price.')); return; }
    try {
      await apiPut(`/api/catalog/products/${product.product_id}/price`, { selling_price: Number(price), mrp: mrp === '' ? undefined : Number(mrp) });
      toast.success('Price changed', 'Bills already made keep the price they were made at.'); onDone();
    } catch (err) { toast.error(err); }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Change price — ${product.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save new price</Button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Prices are per {product.base_unit_label}, {product.default_price_type === 'TAX_INCLUSIVE' ? 'including' : 'excluding'} GST. The old price is kept in the history.</p>
        <div className="form-grid">
          <Field label="Selling price (₹)" required><input inputMode="decimal" value={price} onChange={(e) => setPrice(decimalOnly(e.target.value))} autoFocus /></Field>
          <Field label="MRP (₹)"><input inputMode="decimal" value={mrp} onChange={(e) => setMrp(decimalOnly(e.target.value))} /></Field>
        </div>
        {(product.units ?? []).filter((u: any) => !u.is_base).length > 0 && Number(price) > 0 && (
          <div className="muted small">{(product.units ?? []).filter((u: any) => !u.is_base).map((u: any) => `${u.print_label}: ${inr(Number(price) * Number(u.multiplier_to_base), { decimals: true })}`).join(' · ')}</div>
        )}
      </div>
    </Modal>
  );
}

// ── Master data tabs ─────────────────────────────────────────────────────────
function CategoriesTab({ categories, onChanged }: { categories: any[]; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  useEffect(() => { if (editing === 'new') { setName(''); setParent(''); } else if (editing) { setName(editing.name); setParent(editing.parent_category_id ?? ''); } }, [editing]);
  async function save() {
    if (!name.trim()) { toast.error(new Error('Enter the category name.')); return; }
    try {
      if (editing === 'new') await apiPost('/api/catalog/categories', { name: name.trim(), parent_category_id: parent || null });
      else await apiPut(`/api/catalog/categories/${editing.category_id}`, { name: name.trim(), parent_category_id: parent || null });
      toast.success('Category saved'); setEditing(null); onChanged();
    } catch (err) { toast.error(err); }
  }
  async function toggle(c: any) {
    try { await apiPut(`/api/catalog/categories/${c.category_id}`, { is_active: !c.is_active }); onChanged(); } catch (err) { toast.error(err); }
  }
  return (
    <>
      {can('manage_master_data') && <div className="table-toolbar"><div className="spacer" /><Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Add category</Button></div>}
      <Card flush>
        <DataTable rows={categories} emptyText="No categories yet." rowKey={(c: any) => c.category_id}
          onRowClick={can('manage_master_data') ? (c: any) => setEditing(c) : undefined}
          columns={[
            { key: 'n', header: 'Category', render: (c: any) => <span>{c.path ?? c.name}{!c.is_active && <> <Badge tone="neutral">inactive</Badge></>}</span> },
            { key: 'p', header: 'Products', align: 'right', render: (c: any) => num(c.product_count, 0) },
            { key: 'w', header: 'Return window', align: 'right', render: (c: any) => (c.return_window_days ? `${c.return_window_days} days` : 'shop default') },
            ...(can('manage_master_data') ? [{ key: 'a', header: '', render: (c: any) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void toggle(c); }}>{c.is_active ? 'Deactivate' : 'Activate'}</Button> }] : []),
          ]} />
      </Card>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add category' : 'Edit category'}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Name" required><input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></Field>
          <Field label="Inside (optional)">
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">Top level</option>
              {categories.filter((c) => !c.parent_category_id && c.is_active && (editing === 'new' || c.category_id !== editing?.category_id)).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
            </select>
          </Field>
        </form>
      </Modal>
    </>
  );
}

function BrandsTab({ brands, onChanged }: { brands: any[]; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  async function add() {
    const name = window.prompt('Brand name:');
    if (!name || !name.trim()) return;
    try { await apiPost('/api/catalog/brands', { name: name.trim() }); toast.success('Brand added'); onChanged(); } catch (err) { toast.error(err); }
  }
  async function rename(b: any) {
    const name = window.prompt('Brand name:', b.name);
    if (!name || !name.trim() || name.trim() === b.name) return;
    try { await apiPut(`/api/catalog/brands/${b.brand_id}`, { name: name.trim() }); onChanged(); } catch (err) { toast.error(err); }
  }
  async function toggle(b: any) {
    try { await apiPut(`/api/catalog/brands/${b.brand_id}`, { is_active: !b.is_active }); onChanged(); } catch (err) { toast.error(err); }
  }
  return (
    <>
      {can('manage_master_data') && <div className="table-toolbar"><div className="spacer" /><Button variant="primary" onClick={() => void add()}><Icon name="plus" size={14} /> Add brand</Button></div>}
      <Card flush>
        <DataTable rows={brands} emptyText="No brands yet." rowKey={(b: any) => b.brand_id}
          columns={[
            { key: 'n', header: 'Brand', render: (b: any) => <span>{b.name}{!b.is_active && <> <Badge tone="neutral">inactive</Badge></>}</span> },
            { key: 'p', header: 'Products', align: 'right', render: (b: any) => num(b.product_count, 0) },
            ...(can('manage_master_data') ? [{ key: 'a', header: '', render: (b: any) => (
              <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" onClick={() => void rename(b)}>Rename</Button>
                <Button size="sm" variant="ghost" onClick={() => void toggle(b)}>{b.is_active ? 'Deactivate' : 'Activate'}</Button>
              </div>) }] : []),
          ]} />
      </Card>
    </>
  );
}

function UnitsTab({ units, onChanged }: { units: UnitMaster[]; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ unit_code: '', name: '', print_label: '', dimension: 'PACK', to_dimension_base: '', allows_fraction: false });
  const sizeLabel = form.dimension === 'MASS' ? 'Grams in one unit' : form.dimension === 'LENGTH' ? 'Millimetres in one unit'
    : form.dimension === 'VOLUME' ? 'Millilitres in one unit' : form.dimension === 'AREA' ? 'Square feet in one unit' : 'Pieces in one unit';
  async function save() {
    try {
      await apiPost('/api/catalog/units', { ...form, unit_code: form.unit_code.trim(), name: form.name.trim(), print_label: form.print_label.trim() || undefined,
        to_dimension_base: form.dimension === 'PACK' ? undefined : Number(form.to_dimension_base) });
      toast.success('Unit added'); setOpen(false); onChanged();
    } catch (err) { toast.error(err); }
  }
  async function toggle(u: UnitMaster) {
    try { await apiPut(`/api/catalog/units/${u.unit_code}`, { is_active: !u.is_active }); onChanged(); } catch (err) { toast.error(err); }
  }
  const baseOf: Record<string, string> = { COUNT: 'pieces', MASS: 'g', LENGTH: 'mm', VOLUME: 'ml', AREA: 'sq ft' };
  return (
    <>
      {can('manage_master_data') && <div className="table-toolbar"><span className="muted small">The units products can be stocked and sold in.</span><div className="spacer" />
        <Button variant="primary" onClick={() => { setForm({ unit_code: '', name: '', print_label: '', dimension: 'PACK', to_dimension_base: '', allows_fraction: false }); setOpen(true); }}><Icon name="plus" size={14} /> Add unit</Button></div>}
      <Card flush>
        <DataTable rows={units} rowKey={(u) => u.unit_code}
          columns={[
            { key: 'c', header: 'Code', render: (u) => <span className="mono">{u.unit_code}</span> },
            { key: 'n', header: 'Name', render: (u) => <span>{u.name}{!u.is_active && <> <Badge tone="neutral">inactive</Badge></>}{u.is_system && <> <Badge tone="neutral">built-in</Badge></>}</span> },
            { key: 'l', header: 'Printed as', render: (u) => u.print_label },
            { key: 'd', header: 'Type', render: (u) => DIMENSION_LABEL[u.dimension] ?? u.dimension },
            { key: 's', header: 'Size', align: 'right', render: (u) => (u.dimension === 'PACK' ? 'set per product' : `${num(u.to_dimension_base, 6)} ${baseOf[u.dimension] ?? ''}`) },
            { key: 'f', header: 'Fractions', render: (u) => (u.allows_fraction ? 'yes (e.g. 1.5)' : 'whole only') },
            { key: 'p', header: 'Products', align: 'right', render: (u) => num(u.product_count ?? 0, 0) },
            ...(can('manage_master_data') ? [{ key: 'a', header: '', render: (u: UnitMaster) => <Button size="sm" variant="ghost" onClick={() => void toggle(u)}>{u.is_active ? 'Deactivate' : 'Activate'}</Button> }] : []),
          ]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add unit"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Add unit</Button></>}>
        <div className="form-grid">
          <Field label="Code" required hint="Capitals, e.g. BAG or 5KG"><input className="mono" value={form.unit_code} onChange={(e) => setForm({ ...form, unit_code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} maxLength={20} /></Field>
          <Field label="Name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} /></Field>
          <Field label="Printed on bills as"><input value={form.print_label} onChange={(e) => setForm({ ...form, print_label: e.target.value.toUpperCase() })} maxLength={12} placeholder={form.unit_code} /></Field>
          <Field label="Type">
            <select value={form.dimension} onChange={(e) => setForm({ ...form, dimension: e.target.value, allows_fraction: !['COUNT', 'PACK'].includes(e.target.value) })}>
              {Object.entries(DIMENSION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          {form.dimension !== 'PACK' && <Field label={sizeLabel} required><input inputMode="decimal" value={form.to_dimension_base} onChange={(e) => setForm({ ...form, to_dimension_base: decimalOnly(e.target.value) })} /></Field>}
          <div style={{ alignSelf: 'end', paddingBottom: 6 }}><Switch checked={form.allows_fraction} onChange={(v) => setForm({ ...form, allows_fraction: v })} label="Allow fractions (1.5)" /></div>
        </div>
      </Modal>
    </>
  );
}

function TaxTab({ rates, onChanged }: { rates: any[]; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ hsn_code: '', gst_rate_pct: '18', effective_from: '', cess_rate_pct: '0' });
  const [correcting, setCorrecting] = useState(false);
  async function save() {
    if (!/^[0-9]{4,8}$/.test(form.hsn_code)) { toast.error(new Error('An HSN code is 4–8 digits.')); return; }
    if (!form.effective_from) { toast.error(new Error('Enter the date the rate applies from.')); return; }
    try {
      await apiPost('/api/catalog/hsn-rates', { ...form, gst_rate_pct: Number(form.gst_rate_pct), cess_rate_pct: Number(form.cess_rate_pct || 0) });
      toast.success(correcting ? 'GST rate corrected' : 'GST rate saved'); setOpen(false); onChanged();
    }
    catch (err) { toast.error(err); }
  }
  return (
    <>
      {can('manage_settings') && <div className="table-toolbar"><span className="muted small">A new rate closes the old one on its start date; past bills keep the rate they were made at.</span><div className="spacer" />
        <Button variant="primary" onClick={() => { setCorrecting(false); setForm({ hsn_code: '', gst_rate_pct: '18', effective_from: businessToday(), cess_rate_pct: '0' }); setOpen(true); }}><Icon name="plus" size={14} /> Add / change rate</Button></div>}
      <Card flush>
        <DataTable rows={rates} emptyText="No GST rates." rowKey={(r: any) => r.hsn_tax_rate_id ?? `${r.hsn_code}:${r.effective_from}`}
          columns={[
            { key: 'h', header: 'HSN', render: (r: any) => <span className="mono">{r.hsn_code}</span> },
            { key: 'g', header: 'GST', align: 'right', render: (r: any) => `${num(r.gst_rate_pct, 2)}%` },
            { key: 'c', header: 'Cess', align: 'right', render: (r: any) => `${num(r.cess_rate_pct ?? 0, 2)}%` },
            { key: 'f', header: 'From', render: (r: any) => formatDate(r.effective_from) },
            { key: 't', header: 'Until', render: (r: any) => (r.effective_to ? formatDate(r.effective_to) : <Badge tone="good">current</Badge>) },
            ...(can('manage_settings') ? [{ key: 'e', header: '', render: (r: any) => (r.effective_to ? null : (
              <Button size="sm" onClick={() => {
                setCorrecting(true);
                setForm({ hsn_code: r.hsn_code, gst_rate_pct: String(Number(r.gst_rate_pct)), effective_from: String(r.effective_from).slice(0, 10), cess_rate_pct: String(Number(r.cess_rate_pct ?? 0)) });
                setOpen(true);
              }}>Edit</Button>)) }] : []),
          ]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title={correcting ? `Correct the GST rate for HSN ${form.hsn_code}` : 'GST rate for an HSN code'}
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
        {correcting && <Alert tone="info">Keep the same date to correct a rate entered wrongly. Change the date to start a new rate from that day — bills before it keep the old rate.</Alert>}
        <div className="form-grid">
          <Field label="HSN code" required><input className="mono" value={form.hsn_code} disabled={correcting} onChange={(e) => setForm({ ...form, hsn_code: e.target.value.replace(/\D/g, '') })} maxLength={8} /></Field>
          <Field label="GST rate">
            <select value={form.gst_rate_pct} onChange={(e) => setForm({ ...form, gst_rate_pct: e.target.value })}>{GST_SLABS.map((g) => <option key={g} value={g}>{g}%</option>)}</select>
          </Field>
          <Field label="Cess %"><input type="number" min={0} step="0.01" value={form.cess_rate_pct} onChange={(e) => setForm({ ...form, cess_rate_pct: e.target.value })} /></Field>
          <Field label="Applies from" required><input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

function MarginsTab() {
  const { t } = useI18n();
  const { data } = useSWR<any[]>('/api/catalog/margins?limit=300', fetcher);
  return (
    <Card flush title="Margins" description="Selling price (net of GST) against the actual average cost from purchases, per branch.">
      <AsyncSection data={data} isLoading={!data} empty={<EmptyState text="No stock to analyse yet." />}>
        {(rows) => (
          <DataTable rows={rows} rowKey={(r: any) => `${r.product_id}:${r.branch_name}`}
            columns={[
              { key: 'name', header: t('product'), render: (r: any) => <div>{r.name}<div className="muted small mono">{r.sku}</div></div> },
              { key: 'branch', header: t('branch'), render: (r: any) => r.branch_name },
              { key: 'sell', header: 'Price (ex-GST)', align: 'right', render: (r: any) => inr(r.net_price ?? r.selling_price, { decimals: true }) },
              { key: 'expected', header: 'Expected cost', align: 'right', render: (r: any) => (r.expected_cost !== null ? inr(r.expected_cost, { decimals: true }) : '—') },
              { key: 'actual', header: 'Actual cost', align: 'right', render: (r: any) => inr(r.actual_cost, { decimals: true }) },
              { key: 'margin', header: 'Margin', align: 'right', render: (r: any) => (r.margin_pct === null || r.margin_pct === undefined ? '—'
                : <Badge tone={Number(r.margin_pct) < 10 ? 'critical' : Number(r.margin_pct) < 20 ? 'warning' : 'good'}>{num(r.margin_pct, 1)}%</Badge>) },
            ]} />
        )}
      </AsyncSection>
    </Card>
  );
}

// ── CSV import ───────────────────────────────────────────────────────────────
/** A small RFC-4180 reader: quoted fields, commas and newlines inside quotes. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setRows([]); setFileName(''); setReport(null); } }, [open]);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/catalog/products/bulk-import', { rows, dry_run: dryRun });
      setReport({ ...res, dryRun });
      if (!dryRun) toast.success('Import complete', `${res.created} added, ${res.updated} updated`);
    } catch (err: any) {
      setReport({ error: err?.message, errors: Array.isArray(err?.details) ? err.details : [], dryRun });
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title="Import products from CSV"
      footer={<><Button onClick={onClose}>Close</Button>
        <Button busy={busy} disabled={!rows.length} onClick={() => void run(true)}>Check file</Button>
        <Button variant="primary" busy={busy} disabled={!rows.length || !report?.dryRun || Boolean(report?.error) || (report?.errors?.length ?? 0) > 0} onClick={() => void run(false)}>Import {rows.length} row(s)</Button></>}>
      <div className="stack">
        <Alert tone="info" title="Columns">
          <span className="mono small">sku, name, hsn_code, selling_price</span> (required) and optionally{' '}
          <span className="mono small">mrp, base_unit, category, brand, barcode, price_type, reorder_level, reference_purchase_price</span>.
          Categories and brands must already exist. The whole file imports, or none of it does.
        </Alert>
        <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setFileName(f.name); setReport(null);
          try { setRows(parseCsv(await f.text())); } catch { toast.error(new Error('That file could not be read as CSV.')); }
        }} />
        {fileName && <div className="muted small">{fileName}: {rows.length} row(s) read.</div>}
        {report && (report.error || (report.errors?.length ?? 0) > 0
          ? <Alert tone="critical" title={report.error ?? 'Problems found — nothing was imported'}>
              {(report.errors ?? []).slice(0, 30).map((e: any, i: number) => <div key={i}>Row {e.row}: {e.message}</div>)}
              {(report.errors?.length ?? 0) > 30 && <div>…and {report.errors.length - 30} more.</div>}
            </Alert>
          : <Alert tone="good" title={report.dryRun ? 'The file is valid' : 'Imported'}>
              {report.dryRun
                ? `${report.would_create} new product(s) and ${report.would_update} update(s) to existing SKUs. Nothing has been saved yet.`
                : `${report.created} product(s) added and ${report.updated} updated.`}
            </Alert>)}
        {rows.length > 0 && (
          <DataTable rows={rows.slice(0, 10)} rowKey={(r) => r.sku ?? JSON.stringify(r)}
            columns={['sku', 'name', 'hsn_code', 'selling_price', 'base_unit', 'category'].map((k) => ({ key: k, header: k, render: (r: any) => r[k] ?? '' }))} />
        )}
      </div>
    </Modal>
  );
}

