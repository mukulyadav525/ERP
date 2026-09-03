// Section 2 — Catalog & Product Master.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import { apiGet, apiPost, apiPut, downloadCsv, fetcher, inr, num } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';
import { MiniBar } from '../../components/charts';

const BASE_UNITS = ['PIECE', 'METRE', 'KG', 'LITRE'];

export default function CatalogPage() {
  return (
    <RequirePermission permission="view_catalog">
      <CatalogScreen />
    </RequirePermission>
  );
}

function CatalogScreen() {
  const { can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'products' | 'categories' | 'tax' | 'margins'>('products');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [categoryId, setCategoryId] = useState('');
  const [detail, setDetail] = useState<any | null>(null);
  const [editor, setEditor] = useState<null | 'new' | 'price'>(null);
  const router = useRouter();
  // Deep links: ?new=1 opens the add form (the quick-actions menu), and ?barcode=
  // carries a code the till scanned and could not find, so the cashier is not
  // asked to read thirteen digits off a label and retype them.
  const scannedBarcode = typeof router.query.barcode === 'string' ? router.query.barcode : '';
  useEffect(() => {
    if (router.query.new === '1' && can('edit_catalog')) setEditor('new');
  }, [router.query.new, can]);
  // ?product=<id> is where a global-search hit lands.
  useEffect(() => {
    const id = router.query.product;
    if (typeof id !== 'string' || detail?.product_id === id) return;
    apiGet(`/api/catalog/products/${id}`).then(setDetail).catch(() => { /* a stale link is not an error worth shouting about */ });
  }, [router.query.product]);   // eslint-disable-line react-hooks/exhaustive-deps

  const productPath = `/api/catalog/products?limit=200${search ? `&q=${encodeURIComponent(search)}` : ''}${categoryId ? `&category_id=${categoryId}` : ''}`;
  const { data: products, error, isLoading, mutate } = useSWR<any[]>(productPath, fetcher);
  const { data: categories } = useSWR<any[]>('/api/catalog/categories', fetcher);
  const { data: brands } = useSWR<any[]>('/api/catalog/brands', fetcher);
  const { data: hsnRates } = useSWR<any[]>(tab === 'tax' ? '/api/catalog/hsn-rates?all=true' : null, fetcher);
  const { data: margins } = useSWR<any[]>(
    tab === 'margins' && can('view_cost_price') ? '/api/catalog/margins?limit=200' : null, fetcher);

  async function openDetail(row: any) {
    try { setDetail(await apiGet(`/api/catalog/products/${row.product_id}`)); }
    catch (err) { toast.error(err); }
  }

  return (
    <>
      <PageHeader
        title={t('navCatalog')}
        subtitle="Product master, pricing and tax rates — shared across every branch"
        actions={<>
          <Button onClick={() => downloadCsv(products ?? [], 'catalog.csv')} disabled={!products?.length}>
            {t('export')}
          </Button>
          {can('edit_catalog') && <Button variant="primary" onClick={() => setEditor('new')}>+ {t('product')}</Button>}
        </>}
      />

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'products', label: t('products'), count: products?.length },
          { key: 'categories', label: t('category'), count: categories?.length },
          { key: 'tax', label: 'GST rates' },
          ...(can('view_cost_price') ? [{ key: 'margins', label: 'Margins' }] : []),
        ]} />

      {tab === 'products' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Name, SKU or barcode — spelling need not be exact" />
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ width: 200 }}>
              <option value="">{t('all')} {t('category').toLowerCase()}</option>
              {(categories ?? []).map((c: any) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
            </select>
          </div>
          <Card flush>
            <AsyncSection data={products} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="catalog" title="No products found" text="Try a different search, or add a product." />}>
              {(rows) => (
                <DataTable rows={rows} onRowClick={(r) => void openDetail(r)}
                  footer={`${rows.length} product(s)`}
                  columns={[
                    { key: 'name', header: t('product'), render: (r: any) => (
                      <div>
                        <div style={{ fontWeight: 550 }}>{r.name}</div>
                        <div className="muted small mono">{r.sku}</div>
                      </div>
                    ) },
                    { key: 'cat', header: t('category'), render: (r: any) => r.category_name ?? <span className="muted">—</span> },
                    { key: 'brand', header: t('brand'), render: (r: any) => r.brand_name ?? <span className="muted">—</span> },
                    { key: 'hsn', header: 'HSN / GST', nowrap: true, render: (r: any) => (
                      <span className="mono small">{r.hsn_code} · {num(r.gst_rate_pct, 0)}%</span>
                    ) },
                    { key: 'unit', header: 'Unit', render: (r: any) => (
                      <div className="row tight">
                        <Badge tone="neutral">{r.base_unit}</Badge>
                        {r.batch_tracked && <Badge tone="info">batch</Badge>}
                        {r.serial_tracked && <Badge tone="info">serial</Badge>}
                      </div>
                    ) },
                    { key: 'price', header: t('sellingPrice'), align: 'right', render: (r: any) => (
                      <div>
                        <div style={{ fontWeight: 600 }}>{inr(r.selling_price, { decimals: true })}</div>
                        {Number(r.mrp) > Number(r.selling_price) && (
                          <div className="muted small">MRP {inr(r.mrp)}</div>
                        )}
                      </div>
                    ) },
                    { key: 'stock', header: `${t('stock')} (this branch)`, align: 'right', render: (r: any) => {
                      const qty = Number(r.available_qty ?? 0);
                      const min = Number(r.reorder_min ?? 0);
                      return (
                        <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                          <MiniBar value={qty} max={Math.max(min * 2, qty, 1)}
                            tone={qty <= 0 ? 'critical' : qty <= min ? 'warning' : 'good'} />
                          <span>{num(qty)}</span>
                        </div>
                      );
                    } },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'categories' && (
        <Card flush>
          <DataTable rows={categories ?? []}
            columns={[
              { key: 'name', header: t('category'), render: (c: any) => c.name },
              { key: 'parent', header: 'Parent', render: (c: any) => c.parent_name ?? <span className="muted">—</span> },
              { key: 'count', header: t('products'), align: 'right', render: (c: any) => num(c.product_count, 0) },
              { key: 'window', header: 'Return window', align: 'right', render: (c: any) =>
                c.return_window_days ? `${c.return_window_days} days` : <span className="muted">chain default</span> },
            ]} />
        </Card>
      )}

      {tab === 'tax' && (
        <Card flush title="Effective-dated GST rates"
          description="A rate change never overwrites history — an old invoice keeps the rate that applied on its date (2.7).">
          <DataTable rows={hsnRates ?? []}
            columns={[
              { key: 'hsn', header: 'HSN', render: (r: any) => <span className="mono">{r.hsn_code}</span> },
              { key: 'rate', header: 'GST %', align: 'right', render: (r: any) => `${num(r.gst_rate_pct, 2)}%` },
              { key: 'cess', header: 'Cess %', align: 'right', render: (r: any) => `${num(r.cess_rate_pct, 2)}%` },
              { key: 'from', header: 'Effective from', render: (r: any) => r.effective_from },
              { key: 'to', header: 'Effective to', render: (r: any) =>
                r.effective_to ?? <Badge tone="good">current</Badge> },
            ]} />
        </Card>
      )}

      {tab === 'margins' && (
        <Card flush title="Expected vs actual cost"
          description="Reference purchase price is what an admin typed; actual cost is the weighted average the system calculated from real goods receipts (2.6 / 4.8.1).">
          <AsyncSection data={margins} empty={<EmptyState text="No stock to analyse yet." />}>
            {(rows) => (
              <DataTable rows={rows}
                columns={[
                  { key: 'name', header: t('product'), render: (r: any) => (
                    <div>{r.name}<div className="muted small mono">{r.sku}</div></div>
                  ) },
                  { key: 'branch', header: t('branch'), render: (r: any) => r.branch_name },
                  { key: 'sell', header: 'Selling', align: 'right', render: (r: any) => inr(r.selling_price, { decimals: true }) },
                  { key: 'expected', header: 'Expected cost', align: 'right', render: (r: any) => inr(r.expected_cost, { decimals: true }) },
                  { key: 'actual', header: 'Actual cost', align: 'right', render: (r: any) => inr(r.actual_cost, { decimals: true }) },
                  { key: 'var', header: 'Gap', align: 'right', render: (r: any) => {
                    const v = Number(r.cost_variance ?? 0);
                    if (!r.cost_variance) return <span className="muted">—</span>;
                    return <Badge tone={Math.abs(v) > Number(r.expected_cost) * 0.1 ? 'warning' : 'neutral'}>
                      {v > 0 ? '+' : ''}{inr(v, { decimals: true })}
                    </Badge>;
                  } },
                  { key: 'margin', header: 'Margin', align: 'right', render: (r: any) => (
                    <Badge tone={Number(r.margin_pct) < 10 ? 'critical' : Number(r.margin_pct) < 20 ? 'warning' : 'good'}>
                      {num(r.margin_pct, 1)}%
                    </Badge>
                  ) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      <ProductDetail product={detail} onClose={() => setDetail(null)}
        onPriceChanged={() => { void mutate(); setDetail(null); }} />
      <NewProductModal open={editor === 'new'} initialBarcode={scannedBarcode} onClose={() => setEditor(null)}
        categories={categories ?? []} brands={brands ?? []}
        onCreated={() => { setEditor(null); void mutate(); }} />
    </>
  );
}

function ProductDetail({ product, onClose, onPriceChanged }: {
  product: any | null; onClose: () => void; onPriceChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [newPrice, setNewPrice] = useState('');
  const [newMrp, setNewMrp] = useState('');
  const [busy, setBusy] = useState(false);

  async function savePrice() {
    if (!product) return;
    setBusy(true);
    try {
      await apiPut(`/api/catalog/products/${product.product_id}/price`, {
        selling_price: Number(newPrice), mrp: newMrp ? Number(newMrp) : undefined,
      });
      toast.success('Price updated', 'The previous price is kept for historical invoices.');
      setNewPrice(''); setNewMrp(''); onPriceChanged();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={Boolean(product)} onClose={onClose} wide title={product?.name ?? ''}>
      {product && (
        <div className="stack">
          <KeyValue items={[
            ['SKU', <span className="mono">{product.sku}</span>],
            ['Category', product.category_name],
            ['Brand', product.brand_name],
            ['HSN', <span className="mono">{product.hsn_code}</span>],
            ['Base unit', <Badge tone="neutral">{product.base_unit}</Badge>],
            ['Price type', product.default_price_type === 'TAX_INCLUSIVE' ? 'Tax inclusive' : 'Tax exclusive'],
            ['Tracking', <>
              {product.batch_tracked ? <Badge tone="info">batch</Badge> : null}{' '}
              {product.serial_tracked ? <Badge tone="info">serial</Badge> : null}
              {!product.batch_tracked && !product.serial_tracked ? <span className="muted">none</span> : null}
            </>],
            ['Warranty', product.warranty_months ? `${product.warranty_months} months` : <span className="muted">none</span>],
          ]} />

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Sale units</div>
            <DataTable rows={product.units ?? []}
              columns={[
                { key: 'label', header: 'Unit', render: (u: any) => u.unit_label },
                { key: 'mult', header: `× ${product.base_unit}`, align: 'right', render: (u: any) => num(u.multiplier_to_base, 4) },
                { key: 'def', header: '', render: (u: any) => u.is_default_sale_unit ? <Badge tone="good">default</Badge> : null },
              ]} />
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Stock by branch</div>
            <DataTable rows={product.stock ?? []} emptyText="No branch is carrying this item."
              columns={[
                { key: 'branch', header: 'Branch', render: (s: any) => s.branch_name },
                { key: 'qty', header: 'On hand', align: 'right', render: (s: any) => num(s.base_unit_qty) },
                { key: 'res', header: 'Reserved', align: 'right', render: (s: any) => num(s.reserved_qty) },
                ...(can('view_cost_price') ? [{ key: 'cost', header: 'Avg cost', align: 'right' as const,
                  render: (s: any) => inr(s.weighted_avg_cost, { decimals: true }) }] : []),
                { key: 'min', header: 'Reorder at', align: 'right', render: (s: any) => num(s.reorder_min) },
              ]} />
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Price history</div>
            <DataTable rows={product.prices ?? []}
              columns={[
                { key: 'sp', header: 'Selling', align: 'right', render: (p: any) => inr(p.selling_price, { decimals: true }) },
                { key: 'mrp', header: 'MRP', align: 'right', render: (p: any) => inr(p.mrp, { decimals: true }) },
                { key: 'branch', header: 'Scope', render: (p: any) => p.branch_name ?? <span className="muted">chain-wide</span> },
                { key: 'from', header: 'From', render: (p: any) => new Date(p.effective_from).toLocaleDateString('en-IN') },
                { key: 'to', header: 'To', render: (p: any) => p.effective_to
                  ? new Date(p.effective_to).toLocaleDateString('en-IN')
                  : <Badge tone="good">current</Badge> },
              ]} />
          </div>

          {can('edit_pricing') && (
            <Card title="Change the price">
              <Alert tone="info">
                The current price is closed off with today&rsquo;s date and a new one starts — invoices
                already raised keep the rate they were billed at.
              </Alert>
              <div className="row" style={{ marginTop: 12 }}>
                <Field label="New selling price"><input type="number" min={0} step="any" value={newPrice}
                  onChange={(e) => setNewPrice(e.target.value)} /></Field>
                <Field label="New MRP (optional)"><input type="number" min={0} step="any" value={newMrp}
                  onChange={(e) => setNewMrp(e.target.value)} /></Field>
                <Button variant="primary" busy={busy} disabled={!newPrice}
                  onClick={() => void savePrice()} style={{ alignSelf: 'flex-end' }}>Update price</Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </Modal>
  );
}

function NewProductModal({ open, onClose, categories, brands, onCreated, initialBarcode = '' }: {
  open: boolean; onClose: () => void; categories: any[]; brands: any[]; onCreated: () => void;
  initialBarcode?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    sku: '', name: '', category_id: '', brand_id: '', base_unit: 'PIECE', hsn_code: '',
    selling_price: '', mrp: '', reference_purchase_price: '', barcode: '',
    default_price_type: 'TAX_INCLUSIVE', batch_tracked: false, serial_tracked: false,
  });
  // Prefilled when the form was opened from a scan that found nothing.
  useEffect(() => {
    if (open && initialBarcode) setForm((f) => (f.barcode ? f : { ...f, barcode: initialBarcode }));
  }, [open, initialBarcode]);
  const { data: hsnRates } = useSWR<any[]>(open ? '/api/catalog/hsn-rates' : null, fetcher);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await apiPost('/api/catalog/products', {
        ...form,
        barcodes: form.barcode.trim() ? [form.barcode.trim()] : undefined,
        category_id: form.category_id || undefined,
        brand_id: form.brand_id || undefined,
        selling_price: Number(form.selling_price),
        mrp: form.mrp ? Number(form.mrp) : undefined,
        reference_purchase_price: form.reference_purchase_price ? Number(form.reference_purchase_price) : undefined,
      });
      toast.success('Product created');
      onCreated();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a product"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={(e) => void submit(e as any)}>Create</Button>
      </>}>
      <form className="stack" onSubmit={submit}>
        <div className="grid cols-2">
          <Field label="SKU" required><input required value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })} /></Field>
          <Field label="Name" required><input required value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        </div>
        <Field label="Barcode" hint="Optional. Scan it into this box, or leave blank and add one later.">
          <input value={form.barcode} inputMode="numeric"
            onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label="Category"><select value={form.category_id}
            onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
            <option value="">None</option>
            {categories.map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
          </select></Field>
          <Field label="Brand"><select value={form.brand_id}
            onChange={(e) => setForm({ ...form, brand_id: e.target.value })}>
            <option value="">None</option>
            {brands.map((b) => <option key={b.brand_id} value={b.brand_id}>{b.name}</option>)}
          </select></Field>
        </div>
        <div className="grid cols-2">
          <Field label="Base unit" required
            hint="Everything is priced and taxed per base unit; box or reel units are multiples of it.">
            <select value={form.base_unit} onChange={(e) => setForm({ ...form, base_unit: e.target.value })}>
              {BASE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="HSN code" required hint="A GST rate must already exist for this HSN.">
            <select required value={form.hsn_code} onChange={(e) => setForm({ ...form, hsn_code: e.target.value })}>
              <option value="">Choose…</option>
              {(hsnRates ?? []).map((h: any) => (
                <option key={h.hsn_tax_rate_id} value={h.hsn_code}>{h.hsn_code} — {h.gst_rate_pct}%</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid cols-3">
          <Field label="Selling price" required><input type="number" min={0} step="any" required
            value={form.selling_price} onChange={(e) => setForm({ ...form, selling_price: e.target.value })} /></Field>
          <Field label="MRP"><input type="number" min={0} step="any" value={form.mrp}
            onChange={(e) => setForm({ ...form, mrp: e.target.value })} /></Field>
          <Field label="Expected cost" hint="Estimate only — real cost comes from goods receipts.">
            <input type="number" min={0} step="any" value={form.reference_purchase_price}
              onChange={(e) => setForm({ ...form, reference_purchase_price: e.target.value })} /></Field>
        </div>
        <Field label="Price type"
          hint="Retail counter prices normally include GST; B2B quoted rates normally do not.">
          <select value={form.default_price_type}
            onChange={(e) => setForm({ ...form, default_price_type: e.target.value })}>
            <option value="TAX_INCLUSIVE">Tax inclusive (retail)</option>
            <option value="TAX_EXCLUSIVE">Tax exclusive (B2B)</option>
          </select>
        </Field>
        <div className="row">
          <label className="checkbox"><input type="checkbox" checked={form.batch_tracked}
            onChange={(e) => setForm({ ...form, batch_tracked: e.target.checked })} /> Batch / expiry tracked</label>
          <label className="checkbox"><input type="checkbox" checked={form.serial_tracked}
            onChange={(e) => setForm({ ...form, serial_tracked: e.target.checked })} /> Serial number tracked</label>
        </div>
      </form>
    </Modal>
  );
}
