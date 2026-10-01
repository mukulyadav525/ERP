// ============================================================================
// Inventory & purchasing (spec §25–§31)
//
// Stock on hand, purchase orders, purchase bills (GRN), stock adjustments,
// transfers between branches, stock takes and write-offs, batches and the
// movement log. Every quantity is entered in a unit the item is bought or
// counted in (BAG, BOX, KG, 100 G…) and stored in the item's base unit; the
// screens always say which unit a number is in.
// ============================================================================
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiGet, apiPost, apiPut, businessToday, downloadCsv, fetcher, formatDate, formatDateTime, idempotencyKey,
  inr, num, qtyWithUnit, withBranch,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, BranchGate, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, Pager, RequirePermission, SearchInput, StatTile, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';
import {
  ProductPicker, VendorPicker, defaultUnit, stateName,
  type ProductHit, type UnitOption, type VendorHit,
} from '../../components/pickers';
import { Icon } from '../../components/icons';
import { MiniBar } from '../../components/charts';

export default function InventoryPage() {
  return (
    <RequirePermission permission="view_inventory">
      <InventoryScreen />
    </RequirePermission>
  );
}

const TABS = ['stock', 'reorder', 'purchases', 'adjustments', 'transfers', 'audits', 'batches', 'ledger', 'crossbranch'] as const;
type Tab = typeof TABS[number];

const toNum = (s: string | number | null | undefined) => {
  const n = typeof s === 'number' ? s : Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');

function InventoryScreen() {
  const router = useRouter();
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const wanted: Tab = (() => {
    const q = router.query;
    if (q.low) return 'reorder';
    if (q.new === 'grn') return 'purchases';
    if (typeof q.product === 'string') return 'ledger';
    if (typeof q.tab === 'string' && (TABS as readonly string[]).includes(q.tab)) return q.tab as Tab;
    return 'stock';
  })();
  const [tab, setTab] = useState<Tab>(wanted);
  useEffect(() => { setTab(wanted); }, [wanted]);
  const [ledgerProduct, setLedgerProduct] = useState<{ id: string; name: string } | null>(null);

  const { data: transfers } = useSWR<any[]>(withBranch('/api/inventory/transfers?limit=100', activeBranchId), fetcher);
  const openIssues = (transfers ?? []).filter((x) => x.status === 'TRANSFER_DISCREPANCY' || x.status === 'DISPATCHED').length;

  return (
    <>
      <PageHeader title={t('navInventory')} subtitle="Stock, purchases, adjustments, transfers and stock takes" />
      <Tabs active={tab} onChange={(k) => setTab(k as Tab)}
        tabs={[
          { key: 'stock', label: t('stock') },
          { key: 'reorder', label: 'Reorder & orders' },
          { key: 'purchases', label: 'Purchases' },
          { key: 'adjustments', label: 'Adjustments' },
          { key: 'transfers', label: t('transfer'), count: openIssues || undefined },
          { key: 'audits', label: 'Stock take & write-offs' },
          { key: 'batches', label: 'Batches & serials' },
          { key: 'ledger', label: 'Movement log' },
          ...(can('cross_branch_lookup') ? [{ key: 'crossbranch', label: 'Other branches' }] : []),
        ]} />
      {tab === 'stock' && <StockTab onHistory={(p) => { setLedgerProduct(p); setTab('ledger'); }} />}
      {tab === 'reorder' && <ReorderTab />}
      {tab === 'purchases' && <PurchasesTab openNew={router.query.new === 'grn'} />}
      {tab === 'adjustments' && <AdjustmentsTab />}
      {tab === 'transfers' && <TransfersTab />}
      {tab === 'audits' && <AuditTab />}
      {tab === 'batches' && <BatchTab />}
      {tab === 'ledger' && <LedgerTab product={ledgerProduct ?? (typeof router.query.product === 'string' ? { id: router.query.product, name: '' } : null)}
        onClearProduct={() => { setLedgerProduct(null); if (router.query.product) void router.replace('/inventory?tab=ledger', undefined, { shallow: true }); }} />}
      {tab === 'crossbranch' && <CrossBranchTab />}
    </>
  );
}

// ── Unit-aware quantity entry ────────────────────────────────────────────────
interface QtyLine {
  key: string;
  product: ProductHit;
  unit_id: string;
  qty: string;
}
function unitFor(l: QtyLine): UnitOption | undefined {
  return l.product.units.find((u) => u.product_unit_id === l.unit_id);
}
function multiplierFor(l: QtyLine): number {
  return Number(unitFor(l)?.multiplier_to_base ?? 1) || 1;
}
function baseQtyOf(l: QtyLine): number {
  return Math.round(toNum(l.qty) * multiplierFor(l) * 10000) / 10000;
}
function qtyProblem(l: QtyLine): string | null {
  const q = toNum(l.qty);
  if (!(q > 0)) return `Enter a quantity for "${l.product.name}".`;
  const u = unitFor(l);
  if (u && !u.allows_fraction && !Number.isInteger(q)) return `"${l.product.name}" is counted in whole ${u.print_label} — ${q} is not allowed.`;
  return null;
}
function newQtyLine(p: ProductHit, preferBase = false): QtyLine {
  const unit = (preferBase ? p.units.find((u) => u.is_base) : undefined) ?? defaultUnit(p);
  return { key: `${p.product_id}:${Date.now()}:${Math.random()}`, product: p, unit_id: unit?.product_unit_id ?? '', qty: '' };
}
function UnitSelect({ line, onChange, label }: { line: QtyLine; onChange: (unitId: string) => void; label?: string }) {
  return (
    <select aria-label={label ?? `Unit for ${line.product.name}`} value={line.unit_id} onChange={(e) => onChange(e.target.value)}
      style={{ minWidth: 120 }}>
      {line.product.units.map((u) => (
        <option key={u.product_unit_id} value={u.product_unit_id}>
          {u.print_label}{!u.is_base ? ` (= ${num(u.multiplier_to_base, 4)} ${line.product.base_unit_label})` : ''}
        </option>
      ))}
    </select>
  );
}

// ── Stock on hand ────────────────────────────────────────────────────────────
function StockTab({ onHistory }: { onHistory: (p: { id: string; name: string }) => void }) {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [reorderFor, setReorderFor] = useState<any | null>(null);
  const [minQty, setMinQty] = useState('');
  const [maxQty, setMaxQty] = useState('');
  const [adjustFor, setAdjustFor] = useState<string | null>(null);

  const path = withBranch(
    `/api/inventory/stock?limit=1000&filter=${filter}${search ? `&q=${encodeURIComponent(search)}` : ''}`, activeBranchId);
  const { data, error, isLoading, mutate } = useSWR<any[]>(path, fetcher, { keepPreviousData: true });
  const showCost = Boolean(data?.length && data[0].weighted_avg_cost !== undefined);
  const totalValue = (data ?? []).reduce((s, r) => s + Number(r.stock_value ?? 0), 0);

  // Counts come from the unfiltered list, so the tiles do not change with the filter.
  const { data: all } = useSWR<any[]>(withBranch('/api/inventory/stock?limit=2000', activeBranchId), fetcher);
  const lowCount = (all ?? []).filter((r) => r.is_low && !r.is_out).length;
  const outCount = (all ?? []).filter((r) => r.is_out).length;

  async function saveReorder() {
    if (!reorderFor) return;
    try {
      await apiPut(`/api/inventory/stock/${reorderFor.product_id}/reorder`,
        { reorder_min: minQty === '' ? null : toNum(minQty), reorder_max: maxQty === '' ? null : toNum(maxQty), branch_id: reorderFor.branch_id });
      toast.success('Reorder level saved', reorderFor.name);
      setReorderFor(null); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <StatTile label="Items tracked" value={num(all?.length ?? 0, 0)} />
        <StatTile label="Low stock" value={num(lowCount, 0)} hint={lowCount ? 'At or below the reorder level' : 'Nothing low'} />
        <StatTile label="Out of stock" value={num(outCount, 0)} hint={outCount ? 'Nothing left to sell' : 'All in stock'} />
        {showCost
          ? <StatTile label="Stock value at cost" value={inr(totalValue)} hint="Weighted average cost, excluding GST" />
          : <StatTile label="Reserved for estimates" value={num((all ?? []).filter((r) => Number(r.reserved_qty) > 0).length, 0)} hint="Items held for approved estimates" />}
      </div>

      <div className="table-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Product name or SKU…" />
        <div className="segmented" role="radiogroup" aria-label="Stock filter">
          {([['all', 'All'], ['low', 'Low'], ['out', 'Out of stock']] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={filter === k} className={filter === k ? 'active' : ''}
              onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <div className="spacer" />
        <Button onClick={() => downloadCsv((data ?? []).map((r) => ({
          branch: r.branch_name, sku: r.sku, product: r.name, category: r.category_name, unit: r.base_unit_label,
          on_hand: r.base_unit_qty, reserved: r.reserved_qty, available: r.available_qty, reorder_level: r.reorder_min,
          ...(showCost ? { avg_cost: r.weighted_avg_cost, value: r.stock_value } : {}),
        })), 'stock.csv')} disabled={!data?.length}><Icon name="download" size={14} /> {t('export')}</Button>
      </div>

      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="catalog" title={filter === 'all' ? 'No products' : filter === 'low' ? 'Nothing is low' : 'Nothing is out of stock'}
            text={filter === 'all' ? 'Add products in the catalog, then receive stock with a purchase.' : 'Every item is above its reorder level.'} />}>
          {(rows) => (
            <DataTable rows={rows} rowKey={(r: any) => `${r.branch_id}:${r.product_id}`} footer={`${rows.length} item(s)`}
              columns={[
                { key: 'name', header: t('product'), render: (r: any) => (
                  <div><div style={{ fontWeight: 550 }}>{r.name}</div>
                    <div className="muted small mono">{r.sku} · {r.category_name ?? 'Uncategorised'}</div></div>) },
                ...(activeBranchId ? [] : [{ key: 'branch', header: t('branch'), render: (r: any) => r.branch_name }]),
                { key: 'qty', header: 'On hand', align: 'right', render: (r: any) => (
                  <div className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    <MiniBar value={Math.max(Number(r.base_unit_qty), 0)} max={Math.max(Number(r.reorder_max ?? 0), Number(r.reorder_min ?? 0) * 2, Number(r.base_unit_qty), 1)}
                      tone={r.is_out ? 'critical' : r.is_low ? 'warning' : 'good'} />
                    <span className="nowrap">{qtyWithUnit(r.base_unit_qty, r.base_unit_label)}</span>
                  </div>) },
                { key: 'res', header: 'Reserved', align: 'right', render: (r: any) =>
                  Number(r.reserved_qty) > 0 ? <Badge tone="info">{qtyWithUnit(r.reserved_qty, r.base_unit_label)}</Badge> : <span className="muted">—</span> },
                { key: 'avail', header: 'Available', align: 'right', render: (r: any) => (
                  <span className="row tight" style={{ justifyContent: 'flex-end' }}>
                    {r.is_out ? <Badge tone="critical">Out</Badge> : r.is_low ? <Badge tone="warning">Low</Badge> : null}
                    <span className="nowrap">{qtyWithUnit(r.available_qty, r.base_unit_label)}</span>
                  </span>) },
                { key: 'min', header: t('reorderLevel'), align: 'right', render: (r: any) => can('create_grn') ? (
                  <button className="btn ghost sm" onClick={(e) => {
                    e.stopPropagation();
                    setReorderFor(r); setMinQty(r.reorder_min ?? ''); setMaxQty(r.reorder_max ?? '');
                  }}>{r.reorder_min !== null && r.reorder_min !== undefined ? qtyWithUnit(r.reorder_min, r.base_unit_label) : 'Set'}</button>
                ) : (r.reorder_min !== null ? qtyWithUnit(r.reorder_min, r.base_unit_label) : '—') },
                ...(showCost ? [
                  { key: 'cost', header: 'Avg cost', align: 'right' as const, render: (r: any) => `${inr(r.weighted_avg_cost, { decimals: true })} / ${r.base_unit_label}` },
                  { key: 'value', header: 'Value', align: 'right' as const, render: (r: any) => inr(r.stock_value) },
                ] : []),
                { key: 'act', header: '', render: (r: any) => (
                  <div className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                    {can('adjust_stock') && activeBranchId && (
                      <Button size="sm" onClick={() => setAdjustFor(r.product_id)}>Adjust</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => onHistory({ id: r.product_id, name: r.name })}>History</Button>
                  </div>) },
              ]} />
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(reorderFor)} onClose={() => setReorderFor(null)} title={`Reorder level — ${reorderFor?.name ?? ''}`}
        footer={<><Button onClick={() => setReorderFor(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void saveReorder()}>Save</Button></>}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void saveReorder(); }}>
          <Alert tone="info">
            When stock at {reorderFor?.branch_name ?? 'this branch'} falls to the reorder level, the item shows as low stock and
            appears on the reorder list with a quantity that brings it back up to the maximum. Leave the level blank to use the
            product&rsquo;s default.
          </Alert>
          <Field label={`Reorder level (${reorderFor?.base_unit_label ?? ''})`}>
            <input inputMode="decimal" value={minQty} onChange={(e) => setMinQty(decimalOnly(e.target.value))} placeholder="Product default" />
          </Field>
          <Field label={`Maximum stock (${reorderFor?.base_unit_label ?? ''})`} hint="Optional — the level a reorder tops up to">
            <input inputMode="decimal" value={maxQty} onChange={(e) => setMaxQty(decimalOnly(e.target.value))} />
          </Field>
        </form>
      </Modal>

      <AdjustmentModal open={adjustFor !== null} productId={adjustFor} onClose={() => setAdjustFor(null)}
        onDone={() => { setAdjustFor(null); void mutate(); }} />
    </>
  );
}

// ── Reorder suggestions & purchase orders (§27) ──────────────────────────────
function ReorderTab() {
  const { activeBranchId, can } = useAuth();
  const toast = useToast();
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [vendor, setVendor] = useState<VendorHit | null>(null);
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const [poDetail, setPoDetail] = useState<any | null>(null);
  const [receivePo, setReceivePo] = useState<any | null>(null);
  const [poLimit, setPoLimit] = useState(30);

  const { data, error, isLoading, mutate } = useSWR<any[]>(
    activeBranchId ? withBranch('/api/inventory/reorder-suggestions', activeBranchId) : null, fetcher);
  const { data: pos, mutate: mutatePos } = useSWR<any[]>(withBranch(`/api/inventory/purchase-orders?limit=${poLimit}`, activeBranchId), fetcher);

  const chosen = (data ?? []).filter((r) => picked[r.product_id]);

  async function raisePo() {
    if (!vendor || !chosen.length) return;
    setBusy(true);
    try {
      const po = await apiPost<any>('/api/inventory/purchase-orders', {
        vendor_id: vendor.vendor_id, expected_date: expected || undefined,
        lines: chosen.map((r) => ({
          product_id: r.product_id,
          qty_base_unit: toNum(qtys[r.product_id] ?? Math.ceil(Number(r.suggested_qty))),
          rate: Number(r.expected_rate ?? 0),
        })),
      });
      toast.success(`Purchase order ${po.po_number} raised`, `${chosen.length} item(s) to ${vendor.name}`);
      setPicked({}); setQtys({}); void mutate(); void mutatePos();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function openPo(id: string) {
    try { setPoDetail(await apiGet(`/api/inventory/purchase-orders/${id}`)); } catch (err) { toast.error(err); }
  }
  const router = useRouter();
  useEffect(() => { if (typeof router.query.po === 'string') void openPo(router.query.po); }, [router.query.po]);   // eslint-disable-line react-hooks/exhaustive-deps
  async function cancelPo() {
    if (!poDetail) return;
    const partly = poDetail.status === 'PARTIALLY_RECEIVED';
    if (!window.confirm(partly
      ? `Close ${poDetail.po_number}? What has arrived stays received; nothing more is expected.`
      : `Cancel ${poDetail.po_number}? Nothing has been received against it.`)) return;
    try {
      await apiPost(`/api/inventory/purchase-orders/${poDetail.po_id}/cancel`, {});
      toast.success(partly ? 'Order closed' : 'Order cancelled');
      setPoDetail(null); void mutatePos();
    } catch (err) { toast.error(err); }
  }

  return (
    <div className="stack">
      {activeBranchId ? (
        <Card flush title="Items at or below their reorder level"
          description="Tick what to order. The suggested quantity brings each item back up to its maximum stock.">
          <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
            empty={<EmptyState icon="check" title="Nothing needs reordering" text="Every item is above its reorder level at this branch." />}>
            {(rows) => (
              <DataTable rows={rows} rowKey={(r: any) => r.product_id}
                columns={[
                  { key: 'pick', header: '', render: (r: any) => (
                    <input type="checkbox" aria-label={`Order ${r.product_name}`} checked={Boolean(picked[r.product_id])}
                      onChange={(e) => setPicked({ ...picked, [r.product_id]: e.target.checked })} />) },
                  { key: 'name', header: 'Product', render: (r: any) => <div>{r.product_name}<div className="muted small mono">{r.sku}</div></div> },
                  { key: 'have', header: 'On hand', align: 'right', render: (r: any) => (
                    <Badge tone={Number(r.base_unit_qty) <= 0 ? 'critical' : 'warning'}>{qtyWithUnit(r.base_unit_qty, r.base_unit_label)}</Badge>) },
                  { key: 'min', header: 'Reorder level', align: 'right', render: (r: any) => qtyWithUnit(r.reorder_min, r.base_unit_label) },
                  { key: 'vendor', header: 'Usual supplier', render: (r: any) => r.vendor_name ?? <span className="muted">none recorded</span> },
                  ...(data?.[0]?.expected_rate !== undefined ? [{ key: 'rate', header: 'Last rate', align: 'right' as const,
                    render: (r: any) => r.expected_rate ? `${inr(r.expected_rate, { decimals: true })} / ${r.base_unit_label}` : '—' }] : []),
                  { key: 'order', header: 'Order qty', align: 'right', render: (r: any) => (
                    <span className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <input inputMode="decimal" aria-label={`Order quantity for ${r.product_name}`} style={{ width: 90, textAlign: 'right' }}
                        value={qtys[r.product_id] ?? String(Math.ceil(Number(r.suggested_qty)))}
                        onChange={(e) => { setQtys({ ...qtys, [r.product_id]: decimalOnly(e.target.value) }); setPicked({ ...picked, [r.product_id]: true }); }} />
                      <span className="muted small">{r.base_unit_label}</span>
                    </span>) },
                ]} />
            )}
          </AsyncSection>
          {can('create_purchase_order') && (data ?? []).length > 0 && (
            <div className="card-foot">
              <div className="form-grid" style={{ alignItems: 'end' }}>
                <Field label="Supplier"><VendorPicker value={vendor} onSelect={setVendor} /></Field>
                <Field label="Expected by (optional)"><input type="date" value={expected} min={businessToday()} onChange={(e) => setExpected(e.target.value)} /></Field>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <span className="muted small">{chosen.length} item(s) ticked</span>
                <span className="spacer" />
                <Button variant="primary" busy={busy} disabled={!vendor || !chosen.length} onClick={() => void raisePo()}>
                  Raise purchase order
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Alert tone="info" title="Pick a branch to see what it needs">
          Reorder suggestions are per branch. Choose a branch at the top of the screen.
        </Alert>
      )}

      <Card flush title="Purchase orders" description="Open orders can be received in parts; each delivery is a purchase bill.">
        <AsyncSection data={pos} error={undefined} isLoading={!pos}
          empty={<EmptyState icon="inventory" title="No purchase orders" text="Raise one from the reorder list above." />}>
          {(rows) => (
            <>
              <DataTable rows={rows} rowKey={(r: any) => r.po_id} onRowClick={(r: any) => void openPo(r.po_id)}
                columns={[
                  { key: 'no', header: 'PO', nowrap: true, render: (r: any) => <span className="mono">{r.po_number}</span> },
                  { key: 'v', header: 'Supplier', render: (r: any) => r.vendor_name },
                  ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (r: any) => r.branch_name }]),
                  { key: 'l', header: 'Items', align: 'right', render: (r: any) => num(r.line_count, 0) },
                  { key: 'd', header: 'Raised', nowrap: true, render: (r: any) => formatDate(r.created_at) },
                  { key: 'e', header: 'Expected', nowrap: true, render: (r: any) => (r.expected_date ? formatDate(r.expected_date) : '—') },
                  { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                  ...(rows[0]?.total_value !== undefined ? [{ key: 'val', header: 'Value', align: 'right' as const, render: (r: any) => inr(r.total_value) }] : []),
                ]} />
              <Pager shown={rows.length} pageSize={30} onMore={() => setPoLimit((l) => l + 30)} />
            </>
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(poDetail)} onClose={() => setPoDetail(null)} wide
        title={`Purchase order ${poDetail?.po_number ?? ''}`}
        footer={poDetail && <>
          {can('create_purchase_order') && ['SENT', 'PARTIALLY_RECEIVED', 'DRAFT'].includes(poDetail.status) && (
            <Button variant="danger" onClick={() => void cancelPo()}>{poDetail.status === 'PARTIALLY_RECEIVED' ? 'Close order' : 'Cancel order'}</Button>
          )}
          <span className="spacer" />
          {can('create_grn') && ['SENT', 'PARTIALLY_RECEIVED'].includes(poDetail.status) && (
            <Button variant="primary" onClick={() => { setReceivePo(poDetail); setPoDetail(null); }}>Receive goods…</Button>
          )}
        </>}>
        {poDetail && (
          <div className="stack">
            <KeyValue items={[
              ['Supplier', poDetail.vendor_name], ['Branch', poDetail.branch_name], ['Status', <StatusBadge key="s" status={poDetail.status} />],
              ['Expected', poDetail.expected_date ? formatDate(poDetail.expected_date) : '—'], ['Notes', poDetail.notes || '—'],
            ]} />
            <DataTable rows={poDetail.lines ?? []} rowKey={(l: any) => l.po_line_id}
              columns={[
                { key: 'p', header: 'Product', render: (l: any) => <div>{l.product_name}<div className="muted small mono">{l.sku}</div></div> },
                { key: 'o', header: 'Ordered', align: 'right', render: (l: any) => qtyWithUnit(l.qty_base_unit, l.base_unit_label) },
                { key: 'r', header: 'Received', align: 'right', render: (l: any) => qtyWithUnit(l.received_qty, l.base_unit_label) },
                { key: 'pend', header: 'Pending', align: 'right', render: (l: any) => Number(l.pending_qty) > 0
                  ? <Badge tone="warning">{qtyWithUnit(l.pending_qty, l.base_unit_label)}</Badge> : <Badge tone="good">done</Badge> },
                ...(poDetail.lines?.[0]?.rate !== undefined ? [{ key: 'rate', header: 'Rate', align: 'right' as const,
                  render: (l: any) => `${inr(l.rate, { decimals: true })} / ${l.base_unit_label}` }] : []),
              ]} />
          </div>
        )}
      </Modal>

      <GrnModal open={Boolean(receivePo)} fromPo={receivePo} onClose={() => setReceivePo(null)}
        onCreated={() => { setReceivePo(null); void mutatePos(); void mutate(); }} />
    </div>
  );
}

// ── Purchase bills / goods receipts (§26) ────────────────────────────────────
function PurchasesTab({ openNew }: { openNew: boolean }) {
  const { activeBranchId, can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  // A "record a purchase" link opens the form once; the address then drops the flag
  // so a reload does not open it again.
  const closeNew = () => {
    setNewOpen(false);
    if (router.query.new) void router.replace('/inventory?tab=purchases', undefined, { shallow: true });
  };
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(50);
  const [detail, setDetail] = useState<any | null>(null);
  const [newOpen, setNewOpen] = useState(openNew);
  const [returning, setReturning] = useState<any | null>(null);
  useEffect(() => { if (openNew) setNewOpen(true); }, [openNew]);

  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set('q', search);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/inventory/grn?${params}`, activeBranchId), fetcher,
    { keepPreviousData: true });
  const showMoney = Boolean(data?.length && data[0].grand_total !== undefined);

  async function open(id: string) {
    try { setDetail(await apiGet(`/api/inventory/grn/${id}`)); } catch (err) { toast.error(err); }
  }
  useEffect(() => { if (typeof router.query.grn === 'string') void open(router.query.grn); }, [router.query.grn]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="table-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="GRN, supplier bill no. or supplier…" />
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <div className="spacer" />
        {can('create_grn') && <Button variant="primary" onClick={() => setNewOpen(true)}><Icon name="plus" size={14} /> Record purchase</Button>}
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="inventory" title="No purchases" text="Record a supplier's bill when goods arrive — stock goes up and the supplier is owed." />}>
          {(rows) => (
            <>
              <DataTable rows={rows} rowKey={(r: any) => r.grn_id} onRowClick={(r: any) => void open(r.grn_id)}
                columns={[
                  { key: 'no', header: 'GRN', nowrap: true, render: (r: any) => <span className="mono">{r.grn_number}</span> },
                  { key: 'bill', header: 'Supplier bill', render: (r: any) => r.vendor_invoice_no
                    ? <span>{r.vendor_invoice_no}<div className="muted small">{formatDate(r.vendor_invoice_date)}</div></span>
                    : <span className="muted">—</span> },
                  { key: 'v', header: 'Supplier', render: (r: any) => r.vendor_name },
                  ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (r: any) => r.branch_name }]),
                  { key: 'd', header: 'Received', nowrap: true, render: (r: any) => formatDateTime(r.received_at) },
                  { key: 'po', header: 'PO', render: (r: any) => r.po_number ?? <span className="muted">—</span> },
                  ...(showMoney ? [
                    { key: 'amt', header: 'Amount', align: 'right' as const, render: (r: any) => inr(r.grand_total, { decimals: true }) },
                    { key: 'pay', header: 'Payment', render: (r: any) => (
                      <Badge tone={r.payment_status === 'PAID' ? 'good' : r.payment_status === 'PARTIALLY_PAID' ? 'info' : 'warning'}>
                        {r.payment_status === 'PAID' ? 'Paid' : r.payment_status === 'PARTIALLY_PAID' ? `Part paid · ${inr(r.amount_due)} due` : `${inr(r.amount_due)} due`}
                      </Badge>) },
                  ] : []),
                  { key: 'ret', header: '', render: (r: any) => (r.has_returns ? <Badge tone="neutral">returns</Badge> : null) },
                ]} />
              <Pager shown={rows.length} pageSize={50} onMore={() => setLimit((l) => l + 50)} />
            </>
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide title={`Purchase ${detail?.grn_number ?? ''}`}
        footer={detail && can('create_purchase_return') && (
          <Button onClick={() => { setReturning(detail); setDetail(null); }}>Return goods to supplier…</Button>
        )}>
        {detail && <GrnDetail grn={detail} />}
      </Modal>

      <GrnModal open={newOpen} onClose={closeNew} onCreated={() => { closeNew(); void mutate(); }} />
      <PurchaseReturnModal grn={returning} onClose={() => setReturning(null)} onDone={() => { setReturning(null); void mutate(); }} />
    </>
  );
}

function GrnDetail({ grn }: { grn: any }) {
  const money = grn.grand_total !== undefined;
  const due = money ? Math.max(round2(Number(grn.grand_total) - Number(grn.returned_value ?? 0) - Number(grn.paid_against ?? 0)), 0) : 0;
  return (
    <div className="stack">
      <KeyValue items={[
        ['Supplier', grn.vendor_name + (grn.vendor_gstin ? ` · ${grn.vendor_gstin}` : '')],
        ['Supplier bill', grn.vendor_invoice_no ? `${grn.vendor_invoice_no}${grn.vendor_invoice_date ? ` dated ${formatDate(grn.vendor_invoice_date)}` : ''}` : '—'],
        ['Branch', grn.branch_name], ['Received', `${formatDateTime(grn.received_at)} by ${grn.created_by_name ?? '—'}`],
        ['Against PO', grn.po_number ?? '—'], ['GST', grn.interstate ? 'IGST (supplier in another state)' : 'CGST + SGST'],
        ...(grn.notes ? [['Notes', grn.notes] as [string, React.ReactNode]] : []),
      ]} />
      <DataTable rows={grn.lines ?? []} rowKey={(l: any) => l.grn_line_id}
        columns={[
          { key: 'p', header: 'Product', render: (l: any) => (
            <div>{l.product_name}<div className="muted small mono">{l.sku}{l.batch_number ? ` · batch ${l.batch_number}` : ''}</div></div>) },
          { key: 'q', header: 'Qty', align: 'right', nowrap: true, render: (l: any) => (
            <span>{qtyWithUnit(l.qty_in_unit ?? l.qty_base_unit, l.unit_print_label)}
              {Number(l.multiplier_to_base) !== 1 && <div className="muted small">= {qtyWithUnit(l.qty_base_unit, l.base_unit_label)}</div>}</span>) },
          ...(money ? [
            { key: 'r', header: 'Rate', align: 'right' as const, render: (l: any) => `${inr(Number(l.rate) * Number(l.multiplier_to_base), { decimals: true })} / ${l.unit_print_label}` },
            { key: 'd', header: 'Disc.', align: 'right' as const, render: (l: any) => (Number(l.discount_amount) ? inr(l.discount_amount, { decimals: true }) : '—') },
            { key: 'g', header: 'GST', align: 'right' as const, render: (l: any) => `${num(l.gst_rate_pct, 2)}%` },
            { key: 't', header: 'Taxable', align: 'right' as const, render: (l: any) => inr(l.taxable_value, { decimals: true }) },
            { key: 'tot', header: 'Total', align: 'right' as const, render: (l: any) => inr(l.line_total, { decimals: true }) },
          ] : []),
          { key: 'ret', header: 'Returned', align: 'right', render: (l: any) => (Number(l.returned_qty) ? qtyWithUnit(l.returned_qty, l.base_unit_label) : '—') },
        ]} />
      {money && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <dl className="kv" style={{ minWidth: 280 }}>
            {Number(grn.discount_total) > 0 && <><dt>Discount</dt><dd className="num">− {inr(grn.discount_total, { decimals: true })}</dd></>}
            <dt>Taxable value</dt><dd className="num">{inr(grn.taxable_total, { decimals: true })}</dd>
            {grn.interstate
              ? <><dt>IGST</dt><dd className="num">{inr(grn.igst_total, { decimals: true })}</dd></>
              : <><dt>CGST</dt><dd className="num">{inr(grn.cgst_total, { decimals: true })}</dd><dt>SGST</dt><dd className="num">{inr(grn.sgst_total, { decimals: true })}</dd></>}
            {Number(grn.round_off) !== 0 && <><dt>Round off</dt><dd className="num">{inr(grn.round_off, { decimals: true })}</dd></>}
            <dt><b>Bill total</b></dt><dd className="num"><b>{inr(grn.grand_total, { decimals: true })}</b></dd>
            {Number(grn.returned_value) > 0 && <><dt>Debit notes</dt><dd className="num">− {inr(grn.returned_value, { decimals: true })}</dd></>}
            <dt>Paid against this bill</dt><dd className="num">{inr(grn.paid_against, { decimals: true })}</dd>
            <dt><b>Still owed</b></dt><dd className="num"><b>{inr(due, { decimals: true })}</b></dd>
          </dl>
        </div>
      )}
      {(grn.debit_notes?.length ?? 0) > 0 && (
        <Alert tone="info" title="Debit notes (returns to supplier)">
          {grn.debit_notes.map((d: any) => (
            <div key={d.debit_note_id}>{d.debit_note_number} · {formatDate(d.created_at)} · {d.reason}{d.total_amount !== undefined ? ` · ${inr(d.total_amount, { decimals: true })}` : ''}</div>
          ))}
        </Alert>
      )}
    </div>
  );
}

interface GrnLine extends QtyLine {
  rate: string;            // per the chosen unit, ex-GST
  discount: string;
  gst: string;
  po_line_id?: string;
  pending_base?: number;
  batch_number: string;
  expiry_date: string;
}

/** Records a supplier's bill: stock in, supplier owed, GST as input credit. */
function GrnModal({ open, onClose, onCreated, fromPo }: {
  open: boolean; onClose: () => void; onCreated: () => void; fromPo?: any | null;
}) {
  const { activeBranch, can } = useAuth();
  const toast = useToast();
  const [vendor, setVendor] = useState<VendorHit | null>(null);
  const [poId, setPoId] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(businessToday());
  const [lines, setLines] = useState<GrnLine[]>([]);
  const [roundOff, setRoundOff] = useState('');
  const [notes, setNotes] = useState('');
  const [paidAmount, setPaidAmount] = useState('');
  const [paidMethod, setPaidMethod] = useState('CASH');
  const [paidRef, setPaidRef] = useState('');
  const [busy, setBusy] = useState(false);
  const txnKey = useRef(idempotencyKey());
  const canPay = can('record_vendor_payment');

  const { data: openPos } = useSWR<any[]>(open && vendor ? withBranch(`/api/inventory/purchase-orders?open=true&vendor_id=${vendor.vendor_id}`, activeBranch?.branch_id ?? null) : null, fetcher);

  function reset() {
    setVendor(null); setPoId(''); setBillNo(''); setBillDate(businessToday()); setLines([]); setRoundOff('');
    setNotes(''); setPaidAmount(''); setPaidMethod('CASH'); setPaidRef(''); txnKey.current = idempotencyKey();
  }
  useEffect(() => { if (!open) reset(); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Opened from a purchase order: the supplier and the pending lines come with it.
  async function loadPo(id: string) {
    setPoId(id);
    if (!id) return;
    try {
      const po = await apiGet<any>(`/api/inventory/purchase-orders/${id}`);
      const pending = (po.lines ?? []).filter((l: any) => Number(l.pending_qty) > 0);
      const ids = pending.map((l: any) => l.product_id);
      const products = ids.length ? await apiGet<ProductHit[]>(`/api/catalog/products?ids=${ids.join(',')}&status=all&limit=200`) : [];
      setLines(pending.map((l: any) => {
        const p = products.find((x) => x.product_id === l.product_id);
        if (!p) return null;
        const base = p.units.find((u) => u.is_base) ?? defaultUnit(p);
        return {
          ...newQtyLine(p, true), unit_id: base?.product_unit_id ?? '', qty: String(Number(l.pending_qty)),
          rate: l.rate !== undefined && Number(l.rate) > 0 ? String(Number(l.rate)) : '',
          discount: '', gst: String(Number(p.gst_rate_pct ?? l.gst_rate_pct ?? 0)),
          po_line_id: l.po_line_id, pending_base: Number(l.pending_qty), batch_number: '', expiry_date: '',
        } as GrnLine;
      }).filter(Boolean) as GrnLine[]);
    } catch (err) { toast.error(err); }
  }
  useEffect(() => {
    if (!open || !fromPo) return;
    setVendor({ vendor_id: fromPo.vendor_id, name: fromPo.vendor_name, state_code: fromPo.vendor_state_code });
    void loadPo(fromPo.po_id);
  }, [open, fromPo]);   // eslint-disable-line react-hooks/exhaustive-deps

  function addProduct(p: ProductHit) {
    const unit = defaultUnit(p);
    const ref = Number(p.reference_purchase_price ?? 0);
    setLines((prev) => [...prev, {
      ...newQtyLine(p), unit_id: unit?.product_unit_id ?? '', qty: '',
      rate: ref > 0 ? (ref * Number(unit?.multiplier_to_base ?? 1)).toFixed(2) : '',
      discount: '', gst: String(Number(p.gst_rate_pct ?? 0)), batch_number: '', expiry_date: '',
    }]);
  }
  const update = (key: string, patch: Partial<GrnLine>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const interstate = Boolean(vendor?.state_code && activeBranch?.state_code && vendor.state_code !== activeBranch.state_code);
  const totals = useMemo(() => {
    let taxable = 0, tax = 0, discount = 0;
    const per = lines.map((l) => {
      const gross = round2(toNum(l.qty) * toNum(l.rate));
      const d = Math.min(toNum(l.discount), gross);
      const tv = round2(gross - d);
      const g = toNum(l.gst);
      const lineTax = interstate ? round2(tv * g / 100) : round2(tv * g / 200) * 2;
      taxable += tv; tax += lineTax; discount += d;
      return { taxable: tv, tax: lineTax, total: round2(tv + lineTax) };
    });
    const exact = round2(taxable + tax);
    return { per, taxable: round2(taxable), tax: round2(tax), discount: round2(discount), exact, grand: round2(exact + toNum(roundOff)) };
  }, [lines, interstate, roundOff]);

  async function submit() {
    if (!vendor) { toast.error(new Error('Choose the supplier.')); return; }
    if (!lines.length) { toast.error(new Error('Add the items on the supplier bill.')); return; }
    for (const l of lines) {
      const p = qtyProblem(l);
      if (p) { toast.error(new Error(p)); return; }
      if (l.rate === '') { toast.error(new Error(`Enter the rate for "${l.product.name}" from the supplier bill.`)); return; }
      if (l.product.batch_tracked && !l.batch_number.trim()) { toast.error(new Error(`"${l.product.name}" is batch-tracked — enter the batch number.`)); return; }
    }
    if (Math.abs(toNum(roundOff)) > 1) { toast.error(new Error('Round off can be at most ₹1 either way.')); return; }
    if (toNum(paidAmount) > 0 && ['BANK_TRANSFER', 'CHEQUE'].includes(paidMethod) && !paidRef.trim()) {
      toast.error(new Error(paidMethod === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the bank transfer reference (UTR).')); return;
    }
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/inventory/grn', {
        vendor_id: vendor.vendor_id, po_id: poId || undefined,
        vendor_invoice_no: billNo.trim() || undefined, vendor_invoice_date: billDate || undefined,
        notes: notes.trim() || undefined, round_off: roundOff === '' ? undefined : toNum(roundOff),
        client_txn_id: txnKey.current,
        lines: lines.map((l) => ({
          product_id: l.product.product_id, product_unit_id: l.unit_id || undefined, qty: toNum(l.qty),
          rate: toNum(l.rate), discount_amount: toNum(l.discount) || 0, gst_rate_pct: toNum(l.gst),
          po_line_id: l.po_line_id, batch_number: l.batch_number.trim() || undefined, expiry_date: l.expiry_date || undefined,
        })),
        ...(canPay && toNum(paidAmount) > 0 ? { paid_amount: toNum(paidAmount), paid_method: paidMethod, paid_reference: paidRef.trim() || undefined } : {}),
      });
      toast.success(`Purchase ${res.grn_number} recorded`,
        `${inr(res.grand_total ?? res.total_value, { decimals: true })} from ${vendor.name}${res.payment ? ` · paid ${inr(res.payment.amount, { decimals: true })}` : ''}`);
      onCreated();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title="Record a purchase (supplier bill)"
      footer={<>
        <span className="muted small">Bill total {inr(totals.grand, { decimals: true })}</span>
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!vendor || !lines.length} onClick={() => void submit()}>Save purchase</Button>
      </>}>
      <BranchGate what="this purchase">
        <div className="stack">
          <div className="form-grid">
            <Field label="Supplier" required><VendorPicker value={vendor} onSelect={(v) => { setVendor(v); setPoId(''); }} /></Field>
            <Field label="Against purchase order" hint={vendor && !(openPos?.length) ? 'No open orders for this supplier' : undefined}>
              <select value={poId} disabled={!vendor || !openPos?.length} onChange={(e) => void loadPo(e.target.value)}>
                <option value="">None — a direct purchase</option>
                {(openPos ?? []).map((p: any) => <option key={p.po_id} value={p.po_id}>{p.po_number} · {formatDate(p.created_at)}</option>)}
              </select>
            </Field>
            <Field label="Supplier bill no."><input value={billNo} onChange={(e) => setBillNo(e.target.value)} maxLength={40} placeholder="As printed on their bill" /></Field>
            <Field label="Supplier bill date"><input type="date" value={billDate} max={businessToday()} onChange={(e) => setBillDate(e.target.value)} /></Field>
          </div>
          {vendor && (
            <div className="muted small">
              {interstate
                ? `${vendor.name} is in ${stateName(vendor.state_code)} — GST is charged as IGST.`
                : `GST is charged as CGST + SGST${vendor.state_code ? ` (${stateName(vendor.state_code)})` : ''}.`}
            </div>
          )}

          <div>
            <div className="section-title">Items on the bill</div>
            <ProductPicker onSelect={addProduct} includeInactive showStock={false} ariaLabel="Add an item to the purchase"
              placeholder="Search the product to add…" />
          </div>
          {lines.length > 0 && (
            <div className="table-wrap">
              <table className="data compact">
                <thead><tr>
                  <th>Item</th><th>Unit</th><th className="num">Qty</th><th className="num">Rate / unit (ex-GST)</th>
                  <th className="num">Discount ₹</th><th className="num">GST %</th><th className="num">Total</th><th aria-label="Remove" />
                </tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const u = unitFor(l);
                    return (
                      <tr key={l.key}>
                        <td style={{ minWidth: 160 }}>
                          <div style={{ fontWeight: 550 }}>{l.product.name}</div>
                          <div className="muted small">
                            {l.pending_base !== undefined && `${qtyWithUnit(l.pending_base, l.product.base_unit_label)} pending on the order · `}
                            {u && !u.is_base && toNum(l.qty) > 0 && `= ${qtyWithUnit(baseQtyOf(l), l.product.base_unit_label)}`}
                          </div>
                          {l.product.batch_tracked && (
                            <div className="row tight" style={{ marginTop: 6 }}>
                              <input aria-label={`Batch for ${l.product.name}`} placeholder="Batch no." value={l.batch_number} style={{ width: 120 }}
                                onChange={(e) => update(l.key, { batch_number: e.target.value })} />
                              <input type="date" aria-label={`Expiry for ${l.product.name}`} value={l.expiry_date} style={{ width: 150 }}
                                onChange={(e) => update(l.key, { expiry_date: e.target.value })} />
                            </div>
                          )}
                        </td>
                        <td><UnitSelect line={l} onChange={(unitId) => {
                          const oldM = multiplierFor(l);
                          const newM = Number(l.product.units.find((x) => x.product_unit_id === unitId)?.multiplier_to_base ?? 1);
                          // The rate follows the unit: ₹1,000 a BAG of 25 KG is ₹40 a KG.
                          update(l.key, { unit_id: unitId, rate: l.rate === '' ? '' : String(Math.round((toNum(l.rate) / oldM) * newM * 10000) / 10000) });
                        }} /></td>
                        <td className="num"><input inputMode="decimal" aria-label={`Quantity of ${l.product.name}`} value={l.qty} style={{ width: 80, textAlign: 'right' }}
                          onChange={(e) => update(l.key, { qty: decimalOnly(e.target.value) })} /></td>
                        <td className="num"><input inputMode="decimal" aria-label={`Rate for ${l.product.name}`} value={l.rate} style={{ width: 100, textAlign: 'right' }}
                          onChange={(e) => update(l.key, { rate: decimalOnly(e.target.value) })} /></td>
                        <td className="num"><input inputMode="decimal" aria-label={`Discount on ${l.product.name}`} value={l.discount} placeholder="0" style={{ width: 84, textAlign: 'right' }}
                          onChange={(e) => update(l.key, { discount: decimalOnly(e.target.value) })} /></td>
                        <td className="num">
                          <select aria-label={`GST rate for ${l.product.name}`} value={l.gst} style={{ width: 76 }} onChange={(e) => update(l.key, { gst: e.target.value })}>
                            {['0', '0.25', '3', '5', '12', '18', '28'].concat(['0', '0.25', '3', '5', '12', '18', '28'].includes(l.gst) ? [] : [l.gst])
                              .map((g) => <option key={g} value={g}>{g}%</option>)}
                          </select>
                        </td>
                        <td className="num nowrap" style={{ fontWeight: 600 }}>{inr(totals.per[i]?.total ?? 0, { decimals: true })}</td>
                        <td><button type="button" className="icon-btn" aria-label={`Remove ${l.product.name}`}
                          onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}><Icon name="trash" size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="grid cols-2">
            <div className="stack">
              <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Transporter, LR number…" /></Field>
              {canPay ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="section-title">Paid on delivery (optional)</div>
                  <div className="row tight">
                    <select aria-label="Payment method" value={paidMethod} style={{ width: 150 }} onChange={(e) => setPaidMethod(e.target.value)}>
                      <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="BANK_TRANSFER">Bank transfer</option>
                      <option value="CHEQUE">Cheque</option><option value="CARD">Card</option>
                    </select>
                    <input inputMode="decimal" aria-label="Amount paid now" placeholder="Amount paid now" value={paidAmount} style={{ flex: 1, textAlign: 'right' }}
                      onChange={(e) => setPaidAmount(decimalOnly(e.target.value))} />
                  </div>
                  {toNum(paidAmount) > 0 && paidMethod !== 'CASH' && (
                    <input aria-label="Payment reference" value={paidRef} onChange={(e) => setPaidRef(e.target.value)}
                      placeholder={paidMethod === 'CHEQUE' ? 'Cheque number (required)' : paidMethod === 'BANK_TRANSFER' ? 'UTR (required)' : 'Reference (optional)'} />
                  )}
                </div>
              ) : (
                <p className="muted small">The supplier is owed the bill total. The accountant or owner records payments on the Vendors screen.</p>
              )}
            </div>
            <dl className="kv">
              {totals.discount > 0 && <><dt>Discount</dt><dd className="num">− {inr(totals.discount, { decimals: true })}</dd></>}
              <dt>Taxable value</dt><dd className="num">{inr(totals.taxable, { decimals: true })}</dd>
              <dt>{interstate ? 'IGST' : 'CGST + SGST'}</dt><dd className="num">{inr(totals.tax, { decimals: true })}</dd>
              <dt>Round off (±₹1)</dt>
              <dd><input inputMode="decimal" aria-label="Round off" value={roundOff} placeholder="0.00" style={{ width: 90, textAlign: 'right' }}
                onChange={(e) => setRoundOff(e.target.value.replace(/[^\d.-]/g, ''))} /></dd>
              <dt><b>Bill total</b></dt><dd className="num"><b>{inr(totals.grand, { decimals: true })}</b></dd>
            </dl>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Saving adds the stock at this branch, costs it at the discounted rate excluding GST, records the GST as input credit,
            and adds the bill total to what is owed to the supplier.
          </p>
        </div>
      </BranchGate>
    </Modal>
  );
}

function PurchaseReturnModal({ grn, onClose, onDone }: { grn: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setQtys({}); setReason(''); }, [grn]);

  async function submit() {
    const lines = Object.entries(qtys).filter(([, q]) => toNum(q) > 0)
      .map(([grn_line_id, q]) => {
        const l = grn.lines.find((x: any) => x.grn_line_id === grn_line_id);
        return { grn_line_id, qty_base_unit: Math.round(toNum(q) * Number(l?.multiplier_to_base ?? 1) * 10000) / 10000 };
      });
    if (!lines.length) { toast.error(new Error('Enter the quantity being returned.')); return; }
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/inventory/purchase-returns', { grn_id: grn.grn_id, reason, lines });
      toast.success(`Debit note ${res.debit_note_number} raised`, res.itc_reversal_note);
      onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={Boolean(grn)} onClose={onClose} wide title={`Return goods to ${grn?.vendor_name ?? 'the supplier'}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!reason} onClick={() => void submit()}>Raise debit note</Button></>}>
      {grn && (
        <div className="stack">
          <Alert tone="info" title="This raises a debit note">
            The goods leave stock, the supplier is owed less (including the GST on them), and the input tax credit
            claimed on purchase {grn.grn_number} is reversed for these items.
          </Alert>
          <Field label="Reason" required>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose…</option>
              <option>Damaged in transit</option><option>Wrong item supplied</option>
              <option>Short shipment</option><option>Quality rejected</option><option>Excess supplied</option>
            </select>
          </Field>
          <DataTable rows={grn.lines ?? []} rowKey={(l: any) => l.grn_line_id}
            columns={[
              { key: 'p', header: 'Product', render: (l: any) => l.product_name },
              { key: 'recv', header: 'Received', align: 'right', render: (l: any) => qtyWithUnit(l.qty_in_unit ?? l.qty_base_unit, l.unit_print_label) },
              { key: 'already', header: 'Already returned', align: 'right', render: (l: any) => (Number(l.returned_qty) ? qtyWithUnit(Number(l.returned_qty) / Number(l.multiplier_to_base || 1), l.unit_print_label) : '—') },
              { key: 'ret', header: 'Return now', align: 'right', render: (l: any) => (
                <span className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <input inputMode="decimal" aria-label={`Return quantity of ${l.product_name}`} style={{ width: 90, textAlign: 'right' }}
                    value={qtys[l.grn_line_id] ?? ''} placeholder="0"
                    onChange={(e) => setQtys({ ...qtys, [l.grn_line_id]: decimalOnly(e.target.value) })} />
                  <span className="muted small">{l.unit_print_label}</span>
                </span>) },
            ]} />
        </div>
      )}
    </Modal>
  );
}

// ── Stock adjustments & opening stock (§30) ──────────────────────────────────
const ADJUST_REASONS: Array<[string, string, 'IN' | 'OUT' | 'EITHER']> = [
  ['OPENING_STOCK', 'Opening stock (new item, first count)', 'IN'],
  ['FOUND', 'Found stock (not on record)', 'IN'],
  ['COUNT_CORRECTION', 'Counting correction', 'EITHER'],
  ['DAMAGED', 'Damaged', 'OUT'],
  ['LOST', 'Lost / missing', 'OUT'],
  ['EXPIRED', 'Expired', 'OUT'],
  ['INTERNAL_USE', 'Used by the shop', 'OUT'],
  ['OTHER', 'Other (explain in notes)', 'EITHER'],
];

function AdjustmentsTab() {
  const { activeBranchId, can } = useAuth();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/inventory/stock-adjustments?limit=${limit}`, activeBranchId), fetcher);
  return (
    <>
      <div className="table-toolbar">
        <span className="muted small">Each adjustment is numbered, has a reason and moves stock through the ledger — stock figures are never edited directly.</span>
        <div className="spacer" />
        {can('adjust_stock') && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> New adjustment</Button>}
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="inventory" title="No adjustments" text="Opening stock, found stock and corrections are recorded here." />}>
          {(rows) => (
            <>
              <DataTable rows={rows} rowKey={(r: any) => r.adjustment_id}
                columns={[
                  { key: 'no', header: 'No.', nowrap: true, render: (r: any) => <span className="mono">{r.adjustment_number}</span> },
                  { key: 'd', header: 'When', nowrap: true, render: (r: any) => formatDateTime(r.created_at) },
                  { key: 'p', header: 'Product', render: (r: any) => <div>{r.product_name}<div className="muted small mono">{r.sku}</div></div> },
                  ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (r: any) => r.branch_name }]),
                  { key: 'q', header: 'Change', align: 'right', render: (r: any) => (
                    <span style={{ color: Number(r.qty_change) < 0 ? 'var(--status-critical)' : 'var(--status-good)', fontWeight: 600 }}>
                      {Number(r.qty_change) > 0 ? '+' : ''}{qtyWithUnit(r.qty_change, r.base_unit_label)}
                    </span>) },
                  { key: 'r', header: 'Reason', render: (r: any) => <Badge tone="neutral">{ADJUST_REASONS.find(([k]) => k === r.reason_code)?.[1] ?? r.reason_code}</Badge> },
                  ...(rows[0]?.unit_cost !== undefined ? [{ key: 'c', header: 'Cost', align: 'right' as const,
                    render: (r: any) => (r.unit_cost !== null ? `${inr(r.unit_cost, { decimals: true })} / ${r.base_unit_label}` : '—') }] : []),
                  { key: 'n', header: 'Notes', render: (r: any) => r.notes ?? <span className="muted">—</span> },
                  { key: 'u', header: 'By', render: (r: any) => r.created_by_name },
                ]} />
              <Pager shown={rows.length} pageSize={100} onMore={() => setLimit((l) => l + 100)} />
            </>
          )}
        </AsyncSection>
      </Card>
      <AdjustmentModal open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); void mutate(); }} />
    </>
  );
}

function AdjustmentModal({ open, onClose, onDone, productId }: {
  open: boolean; onClose: () => void; onDone: () => void; productId?: string | null;
}) {
  const toast = useToast();
  const [line, setLine] = useState<QtyLine | null>(null);
  const [reason, setReason] = useState('COUNT_CORRECTION');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [unitCost, setUnitCost] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setLine(null); setReason('COUNT_CORRECTION'); setDirection('IN'); setUnitCost(''); setNotes(''); return; }
    if (productId) {
      void apiGet<ProductHit[]>(`/api/catalog/products?ids=${productId}&status=all&limit=1`)
        .then((rows) => rows[0] && setLine(newQtyLine(rows[0], true))).catch((err) => toast.error(err));
    }
  }, [open, productId]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fixed = ADJUST_REASONS.find(([k]) => k === reason)?.[2] ?? 'EITHER';
  const dir: 'IN' | 'OUT' = fixed === 'EITHER' ? direction : fixed;
  const available = Number(line?.product.available_qty ?? 0);
  const after = line ? (dir === 'IN' ? available + baseQtyOf(line) : available - baseQtyOf(line)) : 0;

  async function submit() {
    if (!line) { toast.error(new Error('Choose the product.')); return; }
    const p = qtyProblem(line);
    if (p) { toast.error(new Error(p)); return; }
    if (reason === 'OPENING_STOCK' && unitCost === '') { toast.error(new Error('Enter the cost per unit, so the opening stock is valued.')); return; }
    if (reason === 'OTHER' && !notes.trim()) { toast.error(new Error('Explain the adjustment in the notes.')); return; }
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/inventory/stock-adjustments', {
        product_id: line.product.product_id, product_unit_id: line.unit_id || undefined, quantity: toNum(line.qty),
        reason_code: reason, direction: dir, unit_cost: dir === 'IN' && unitCost !== '' ? toNum(unitCost) : undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(`Adjustment ${res.adjustment_number} recorded`,
        `${line.product.name}: ${dir === 'IN' ? '+' : '−'}${qtyWithUnit(toNum(line.qty), unitFor(line)?.print_label)}`);
      onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Stock adjustment"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!line} onClick={() => void submit()}>Record adjustment</Button></>}>
      <BranchGate what="this adjustment">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {line ? (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{line.product.name}</div>
                <div className="muted small">{line.product.sku} · {qtyWithUnit(available, line.product.base_unit_label)} on record</div>
              </div>
              {!productId && <Button size="sm" variant="ghost" onClick={() => setLine(null)}>Change</Button>}
            </div>
          ) : (
            <Field label="Product" required>
              <ProductPicker onSelect={(p) => setLine(newQtyLine(p, true))} includeInactive autoFocus ariaLabel="Product to adjust" />
            </Field>
          )}
          <Field label="Reason" required>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              {ADJUST_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          {fixed === 'EITHER' && (
            <div className="segmented" role="radiogroup" aria-label="Direction">
              <button type="button" role="radio" aria-checked={direction === 'IN'} className={direction === 'IN' ? 'active' : ''} onClick={() => setDirection('IN')}>Add to stock</button>
              <button type="button" role="radio" aria-checked={direction === 'OUT'} className={direction === 'OUT' ? 'active' : ''} onClick={() => setDirection('OUT')}>Remove from stock</button>
            </div>
          )}
          {line && (
            <div className="form-grid">
              <Field label="Quantity" required>
                <input inputMode="decimal" value={line.qty} onChange={(e) => setLine({ ...line, qty: decimalOnly(e.target.value) })} />
              </Field>
              <Field label="Unit"><UnitSelect line={line} onChange={(unit_id) => setLine({ ...line, unit_id })} label="Unit" /></Field>
              {dir === 'IN' && (
                <div className="span-2">
                  <Field label={`Cost per ${unitFor(line)?.print_label ?? 'unit'} (ex-GST)`} required={reason === 'OPENING_STOCK'}
                    hint={reason === 'OPENING_STOCK' ? 'Needed to value the opening stock' : 'Optional — leave blank to keep the current average cost'}>
                    <input inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(decimalOnly(e.target.value))} />
                  </Field>
                </div>
              )}
            </div>
          )}
          <Field label="Notes" required={reason === 'OTHER'}>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </Field>
          {line && toNum(line.qty) > 0 && (
            <Alert tone={after < 0 ? 'critical' : 'info'}>
              {dir === 'IN' ? 'Adds' : 'Removes'} {qtyWithUnit(baseQtyOf(line), line.product.base_unit_label)}.
              Stock on record goes from {qtyWithUnit(available, line.product.base_unit_label)} to {qtyWithUnit(Math.round(after * 10000) / 10000, line.product.base_unit_label)}.
              {after < 0 && ' That is less than zero — check the quantity.'}
            </Alert>
          )}
        </form>
      </BranchGate>
    </Modal>
  );
}

// ── Transfers between branches (§29) ─────────────────────────────────────────
function TransfersTab() {
  const { can, activeBranchId, branches } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<any | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch(`/api/inventory/transfers?limit=200${status ? `&status=${status}` : ''}`, activeBranchId), fetcher);
  const myBranches = new Set(branches.map((b) => b.branch_id));

  async function act(path: string, body: any, message: string) {
    setBusy(true);
    try {
      const res = await apiPost<any>(path, body ?? {});
      toast.success(message, res?.message);
      setDetail(null); void mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function openTransfer(id: string) {
    try { setDetail(await apiGet(`/api/inventory/transfers/${id}`)); setReceiveQtys({}); } catch (err) { toast.error(err); }
  }
  const router = useRouter();
  useEffect(() => { if (typeof router.query.transfer === 'string') void openTransfer(router.query.transfer); }, [router.query.transfer]);   // eslint-disable-line react-hooks/exhaustive-deps

  const atSender = detail && myBranches.has(detail.from_branch_id);
  const atReceiver = detail && myBranches.has(detail.to_branch_id);

  return (
    <>
      <div className="table-toolbar">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="REQUESTED">Requested</option><option value="DISPATCHED">In transit</option>
          <option value="RECEIVED">Received</option><option value="TRANSFER_DISCREPANCY">Discrepancy</option>
          <option value="CLOSED">Closed</option><option value="CANCELLED">Cancelled</option>
        </select>
        <div className="spacer" />
        {can('create_transfer') && <Button variant="primary" onClick={() => setNewOpen(true)}><Icon name="plus" size={14} /> New transfer</Button>}
      </div>

      <Card flush title="Transfers between branches"
        description="Stock leaves the sender when dispatched and reaches the receiver when received. A short receipt stays open as a discrepancy until a manager settles it.">
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="truck" title="No transfers" text="Send stock to another branch with New transfer." />}>
          {(rows) => (
            <DataTable rows={rows} rowKey={(r: any) => r.transfer_id} onRowClick={(r: any) => void openTransfer(r.transfer_id)}
              columns={[
                { key: 'no', header: 'No.', nowrap: true, render: (r: any) => <span className="mono">{r.transfer_number ?? '—'}</span> },
                { key: 'from', header: 'From', render: (r: any) => r.from_branch_name },
                { key: 'to', header: 'To', render: (r: any) => r.to_branch_name },
                { key: 'lines', header: 'Items', align: 'right', render: (r: any) => num(r.line_count, 0) },
                { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                { key: 'disc', header: 'Short / over', align: 'right', render: (r: any) =>
                  Number(r.total_discrepancy) !== 0 ? <Badge tone="critical">{num(r.total_discrepancy)}</Badge> : <span className="muted">—</span> },
                { key: 'when', header: 'Created', nowrap: true, render: (r: any) => formatDate(r.created_at) },
              ]} />
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide
        title={`Transfer ${detail?.transfer_number ?? ''} · ${detail?.from_branch_name ?? ''} → ${detail?.to_branch_name ?? ''}`}
        footer={detail && (
          <>
            {detail.status === 'REQUESTED' && can('create_transfer') && atSender && (
              <Button variant="danger" busy={busy} onClick={() => {
                const reason = window.prompt('Cancel this transfer? Nothing has left the branch yet.\n\nReason (optional):');
                if (reason !== null) void act(`/api/inventory/transfers/${detail.transfer_id}/cancel`, { reason }, 'Transfer cancelled');
              }}>Cancel transfer</Button>
            )}
            <span className="spacer" />
            {detail.status === 'REQUESTED' && can('create_transfer') && atSender && (
              <Button variant="primary" busy={busy} onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/dispatch`, {}, 'Dispatched — stock has left this branch')}>
                Dispatch
              </Button>
            )}
            {detail.status === 'DISPATCHED' && can('receive_transfer') && atReceiver && (
              <Button variant="primary" busy={busy} onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/receive`,
                { lines: (detail.lines ?? []).map((l: any) => ({ line_id: l.line_id, received_qty: receiveQtys[l.line_id] === undefined ? Number(l.dispatched_qty) : toNum(receiveQtys[l.line_id]) })) },
                'Receipt recorded')}>
                Confirm receipt
              </Button>
            )}
            {detail.status === 'TRANSFER_DISCREPANCY' && can('resolve_transfer_discrepancy') && (
              <>
                <Button busy={busy} onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/resolve`,
                  { resolution: 'COUNT_CORRECTION', responsible_branch_id: detail.to_branch_id }, 'Count corrected')}>
                  It was a counting error
                </Button>
                <Button variant="danger" busy={busy} onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/resolve`,
                  { resolution: 'WRITE_OFF', responsible_branch_id: detail.from_branch_id }, 'Shortfall written off')}>
                  Write off the shortfall
                </Button>
              </>
            )}
          </>
        )}>
        {detail && (
          <div className="stack">
            <KeyValue items={[
              ['Status', <StatusBadge key="s" status={detail.status} />],
              ['Requested', `${formatDateTime(detail.created_at ?? detail.requested_at)} by ${detail.requested_by_name ?? '—'}`],
              ['Dispatched', detail.dispatched_at ? `${formatDateTime(detail.dispatched_at)} by ${detail.dispatched_by_name ?? '—'}` : '—'],
              ['Received', detail.received_at ? `${formatDateTime(detail.received_at)} by ${detail.received_by_name ?? '—'}` : '—'],
              ['Vehicle / driver', detail.driver_ref || '—'], ['GST movement', detail.transfer_doc_type === 'INTERSTATE' ? 'Interstate (needs a tax invoice / e-way bill)' : 'Within the state (delivery challan)'],
              ...(detail.notes ? [['Notes', detail.notes] as [string, React.ReactNode]] : []),
              ...(detail.cancelled_at ? [['Cancelled', `${formatDateTime(detail.cancelled_at)} by ${detail.cancelled_by_name ?? '—'}`] as [string, React.ReactNode]] : []),
            ]} />
            {detail.status === 'DISPATCHED' && atReceiver && (
              <Alert tone="info">Count what arrived. If a quantity differs, enter the actual count — the difference is held as a discrepancy, not forced to match.</Alert>
            )}
            {detail.status === 'TRANSFER_DISCREPANCY' && (
              <Alert tone="critical" title="Quantities did not match">
                Decide whether the shortfall is a real loss (write it off against the sending branch) or a miscount (correct the receiving branch&rsquo;s count).
              </Alert>
            )}
            <DataTable rows={detail.lines ?? []} rowKey={(l: any) => l.line_id}
              columns={[
                { key: 'p', header: 'Product', render: (l: any) => <div>{l.product_name}<div className="muted small mono">{l.sku}</div></div> },
                { key: 'd', header: 'Sent', align: 'right', render: (l: any) => qtyWithUnit(l.dispatched_qty, l.base_unit_label) },
                { key: 'r', header: 'Received', align: 'right', render: (l: any) =>
                  detail.status === 'DISPATCHED' && atReceiver
                    ? <span className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <input inputMode="decimal" aria-label={`Received quantity of ${l.product_name}`} style={{ width: 90, textAlign: 'right' }}
                          value={receiveQtys[l.line_id] ?? String(Number(l.dispatched_qty))}
                          onChange={(e) => setReceiveQtys({ ...receiveQtys, [l.line_id]: decimalOnly(e.target.value) })} />
                        <span className="muted small">{l.base_unit_label}</span>
                      </span>
                    : (l.received_qty === null ? <span className="muted">—</span> : qtyWithUnit(l.received_qty, l.base_unit_label)) },
                { key: 'v', header: 'Difference', align: 'right', render: (l: any) =>
                  Number(l.discrepancy_qty) ? <Badge tone="critical">{qtyWithUnit(l.discrepancy_qty, l.base_unit_label)}</Badge> : <span className="muted">—</span> },
                { key: 'res', header: 'Settled as', render: (l: any) => (l.resolution ? l.resolution.replace(/_/g, ' ').toLowerCase() : <span className="muted">—</span>) },
              ]} />
          </div>
        )}
      </Modal>

      <NewTransferModal open={newOpen} onClose={() => setNewOpen(false)} onCreated={() => { setNewOpen(false); void mutate(); }} />
    </>
  );
}

function NewTransferModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { activeBranchId, activeBranchName } = useAuth();
  const toast = useToast();
  const [toBranch, setToBranch] = useState('');
  const [driverRef, setDriverRef] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<QtyLine[]>([]);
  const [busy, setBusy] = useState(false);
  const { data: directory } = useSWR<any[]>(open ? '/api/auth/branch-directory' : null, fetcher);
  useEffect(() => { if (!open) { setToBranch(''); setDriverRef(''); setNotes(''); setLines([]); } }, [open]);

  function add(p: ProductHit) {
    if (lines.some((l) => l.product.product_id === p.product_id)) { toast.toast('Already on this transfer', { tone: 'info', message: 'Change its quantity instead.' }); return; }
    setLines((prev) => [...prev, newQtyLine(p)]);
  }
  async function submit() {
    if (!toBranch) { toast.error(new Error('Choose the branch the stock is going to.')); return; }
    if (!lines.length) { toast.error(new Error('Add at least one item.')); return; }
    for (const l of lines) {
      const p = qtyProblem(l);
      if (p) { toast.error(new Error(p)); return; }
      if (baseQtyOf(l) > Number(l.product.available_qty ?? 0) + 1e-9) {
        toast.error(new Error(`Only ${qtyWithUnit(l.product.available_qty, l.product.base_unit_label)} of "${l.product.name}" is available to send.`)); return;
      }
    }
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/inventory/transfers', {
        to_branch_id: toBranch, driver_ref: driverRef.trim() || undefined, notes: notes.trim() || undefined,
        lines: lines.map((l) => ({ product_id: l.product.product_id, qty_base_unit: baseQtyOf(l) })),
      });
      toast.success(`Transfer ${res.transfer_number} created`, 'Dispatch it when the goods leave.');
      onCreated();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title={`New transfer from ${activeBranchName}`}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!toBranch || !lines.length} onClick={() => void submit()}>Create transfer</Button></>}>
      <BranchGate what="this transfer">
        <div className="stack">
          <div className="form-grid">
            <Field label="Send to" required>
              <select value={toBranch} onChange={(e) => setToBranch(e.target.value)}>
                <option value="">Choose a branch…</option>
                {(directory ?? []).filter((b: any) => b.branch_id !== activeBranchId).map((b: any) => (
                  <option key={b.branch_id} value={b.branch_id}>{b.name} ({b.code})</option>
                ))}
              </select>
            </Field>
            <Field label="Vehicle / driver"><input value={driverRef} onChange={(e) => setDriverRef(e.target.value)} placeholder="MH04AB1234 · Ramesh" /></Field>
            <div className="span-2"><Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field></div>
          </div>
          <ProductPicker onSelect={add} ariaLabel="Add an item to the transfer" placeholder="Search the product to send…" />
          {lines.length > 0 && (
            <div className="table-wrap">
              <table className="data compact">
                <thead><tr><th>Item</th><th className="num">Available</th><th>Unit</th><th className="num">Qty to send</th><th aria-label="Remove" /></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key}>
                      <td>{l.product.name}<div className="muted small mono">{l.product.sku}</div></td>
                      <td className="num nowrap">{qtyWithUnit(l.product.available_qty, l.product.base_unit_label)}</td>
                      <td><UnitSelect line={l} onChange={(unit_id) => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, unit_id } : x)))} /></td>
                      <td className="num"><input inputMode="decimal" aria-label={`Quantity of ${l.product.name}`} value={l.qty} style={{ width: 90, textAlign: 'right' }}
                        onChange={(e) => setLines((prev) => prev.map((x) => (x.key === l.key ? { ...x, qty: decimalOnly(e.target.value) } : x)))} /></td>
                      <td><button type="button" className="icon-btn" aria-label={`Remove ${l.product.name}`}
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}><Icon name="trash" size={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </BranchGate>
    </Modal>
  );
}

// ── Stock take (§31) & write-offs ────────────────────────────────────────────
function AuditTab() {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<any | null>(null);
  const [counting, setCounting] = useState<any | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<any[]>(withBranch('/api/inventory/stock-audits', activeBranchId), fetcher);
  const { data: writeOffs, mutate: mutateWriteOffs } = useSWR<any[]>(withBranch('/api/inventory/write-offs?limit=100', activeBranchId), fetcher);
  const { data: stock } = useSWR<any[]>(counting ? withBranch('/api/inventory/stock?limit=2000', activeBranchId) : null, fetcher);
  const shown = (stock ?? []).filter((r) => !filter || `${r.name} ${r.sku}`.toLowerCase().includes(filter.toLowerCase()));

  async function startAudit() {
    try {
      const audit = await apiPost<any>('/api/inventory/stock-audits', {});
      setCounting(audit); setCounts({});
      toast.success('Stock take started', 'Count the shelves and enter what you find. Items left blank are not changed.');
      void mutate();
    } catch (err) { toast.error(err); }
  }
  async function completeAudit() {
    if (!counting) return;
    const entries = Object.entries(counts).filter(([, v]) => v !== '');
    if (!window.confirm(`Post ${entries.length} count(s)? Any difference from the system is corrected through the stock ledger.`)) return;
    setBusy(true);
    try {
      const res = await apiPost<any>(`/api/inventory/stock-audits/${counting.audit_id}/complete`, {
        counts: entries.map(([product_id, v]) => ({ product_id, counted_qty: toNum(v) })),
      });
      toast.success('Stock take complete', `${res.variance_lines} item(s) differed and were corrected.`);
      setCounting(null); void mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="table-toolbar">
        <div className="spacer" />
        {can('approve_write_off') && activeBranchId && <Button onClick={() => setWriteOffOpen(true)}>Write off damaged stock</Button>}
        {can('run_stock_audit') && activeBranchId && !counting && <Button variant="primary" onClick={() => void startAudit()}>Start a stock take</Button>}
      </div>
      {!activeBranchId && <div style={{ marginBottom: 12 }}><Alert tone="info">Choose a branch at the top to run a stock take or record a write-off there.</Alert></div>}

      {counting && (
        <Card title="Counting in progress" description="Enter the physical count, in each item's base unit. Items left blank are skipped."
          footer={<div className="row">
            <Button variant="ghost" onClick={() => setCounting(null)}>Pause (resume later)</Button>
            <div className="spacer" />
            <Button variant="primary" busy={busy} disabled={!Object.values(counts).some((v) => v !== '')} onClick={() => void completeAudit()}>
              Finish and post {Object.values(counts).filter((v) => v !== '').length} count(s)
            </Button>
          </div>} flush>
          <div style={{ padding: '10px 16px' }}><SearchInput value={filter} onChange={setFilter} placeholder="Find an item on the list…" /></div>
          <DataTable rows={shown.slice(0, 300)} rowKey={(r: any) => r.product_id}
            columns={[
              { key: 'p', header: 'Product', render: (r: any) => <div>{r.name}<div className="muted small mono">{r.sku}</div></div> },
              { key: 'sys', header: 'System says', align: 'right', render: (r: any) => qtyWithUnit(r.base_unit_qty, r.base_unit_label) },
              { key: 'cnt', header: 'Counted', align: 'right', render: (r: any) => (
                <span className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                  <input inputMode="decimal" aria-label={`Counted quantity of ${r.name}`} style={{ width: 90, textAlign: 'right' }}
                    value={counts[r.product_id] ?? ''} placeholder="—"
                    onChange={(e) => setCounts((prev) => ({ ...prev, [r.product_id]: decimalOnly(e.target.value) }))} />
                  <span className="muted small">{r.base_unit_label}</span>
                </span>) },
              { key: 'var', header: 'Difference', align: 'right', render: (r: any) => {
                const c = counts[r.product_id];
                if (c === undefined || c === '') return <span className="muted">—</span>;
                const v = Math.round((toNum(c) - Number(r.base_unit_qty)) * 10000) / 10000;
                return v === 0 ? <Badge tone="good">match</Badge>
                  : <Badge tone={v < 0 ? 'critical' : 'warning'}>{v > 0 ? '+' : ''}{qtyWithUnit(v, r.base_unit_label)}</Badge>;
              } },
            ]} />
          {shown.length > 300 && <div className="table-footer">Showing the first 300 — search to find others.</div>}
        </Card>
      )}

      <Card flush title="Stock takes">
        <DataTable rows={data ?? []} emptyText="No stock take has been run yet." rowKey={(r: any) => r.audit_id}
          onRowClick={async (r: any) => {
            if (r.status === 'IN_PROGRESS' && can('run_stock_audit')) { setCounting(r); return; }
            try { setDetail(await apiGet(`/api/inventory/stock-audits/${r.audit_id}`)); } catch (err) { toast.error(err); }
          }}
          columns={[
            { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'l', header: 'Items counted', align: 'right', render: (r: any) => num(r.line_count, 0) },
            { key: 'v', header: 'With a difference', align: 'right', render: (r: any) =>
              Number(r.variance_count) > 0 ? <Badge tone="warning">{num(r.variance_count, 0)}</Badge> : <Badge tone="good">none</Badge> },
            { key: 'by', header: 'Run by', render: (r: any) => r.created_by_name },
            { key: 'when', header: 'Started', nowrap: true, render: (r: any) => formatDateTime(r.started_at) },
          ]} />
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card flush title="Write-offs" description="Stock that will never be sold — damaged, expired, stolen or given as a sample.">
          <DataTable rows={writeOffs ?? []} emptyText="No write-offs recorded." rowKey={(r: any) => r.writeoff_id}
            columns={[
              { key: 'w', header: 'When', nowrap: true, render: (r: any) => formatDateTime(r.created_at) },
              { key: 'p', header: 'Product', render: (r: any) => r.product_name },
              ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (r: any) => r.branch_name }]),
              { key: 'q', header: 'Qty', align: 'right', render: (r: any) => qtyWithUnit(r.qty_base_unit, r.base_unit_label) },
              { key: 'r', header: 'Reason', render: (r: any) => <Badge tone="warning">{String(r.reason_code).replace(/_/g, ' ').toLowerCase()}</Badge> },
              { key: 'by', header: 'By', render: (r: any) => r.created_by_name },
            ]} />
        </Card>
      </div>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide title={`Stock take · ${detail?.branch_name ?? ''}`}>
        {detail && (
          <DataTable rows={detail.lines ?? []} rowKey={(l: any) => l.product_id}
            columns={[
              { key: 'p', header: 'Product', render: (l: any) => l.product_name },
              { key: 's', header: 'System', align: 'right', render: (l: any) => qtyWithUnit(l.system_qty, l.base_unit_label) },
              { key: 'c', header: 'Counted', align: 'right', render: (l: any) => qtyWithUnit(l.counted_qty, l.base_unit_label) },
              { key: 'v', header: 'Difference', align: 'right', render: (l: any) => Number(l.variance_qty) === 0
                ? <Badge tone="good">match</Badge>
                : <Badge tone={Number(l.variance_qty) < 0 ? 'critical' : 'warning'}>{Number(l.variance_qty) > 0 ? '+' : ''}{qtyWithUnit(l.variance_qty, l.base_unit_label)}</Badge> },
            ]} />
        )}
      </Modal>

      <WriteOffModal open={writeOffOpen} onClose={() => setWriteOffOpen(false)} onDone={() => { setWriteOffOpen(false); void mutateWriteOffs(); }} />
    </>
  );
}

function WriteOffModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [line, setLine] = useState<QtyLine | null>(null);
  const [reason, setReason] = useState('DAMAGED');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setLine(null); setReason('DAMAGED'); } }, [open]);

  async function submit() {
    if (!line) return;
    const p = qtyProblem(line);
    if (p) { toast.error(new Error(p)); return; }
    setBusy(true);
    try {
      await apiPost('/api/inventory/write-offs', { product_id: line.product.product_id, product_unit_id: line.unit_id || undefined, qty: toNum(line.qty), reason_code: reason });
      toast.success('Write-off recorded', `${line.product.name}: −${qtyWithUnit(baseQtyOf(line), line.product.base_unit_label)}`);
      onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Write off stock"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" busy={busy} disabled={!line} onClick={() => void submit()}>Write off</Button></>}>
      <div className="stack">
        {line ? (
          <div className="row">
            <div style={{ flex: 1 }}><b>{line.product.name}</b><div className="muted small">{qtyWithUnit(line.product.available_qty, line.product.base_unit_label)} available</div></div>
            <Button size="sm" variant="ghost" onClick={() => setLine(null)}>Change</Button>
          </div>
        ) : (
          <Field label="Product" required><ProductPicker onSelect={(p) => setLine(newQtyLine(p, true))} autoFocus ariaLabel="Product to write off" /></Field>
        )}
        {line && (
          <div className="form-grid">
            <Field label="Quantity" required><input inputMode="decimal" value={line.qty} onChange={(e) => setLine({ ...line, qty: decimalOnly(e.target.value) })} /></Field>
            <Field label="Unit"><UnitSelect line={line} onChange={(unit_id) => setLine({ ...line, unit_id })} label="Unit" /></Field>
          </div>
        )}
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="DAMAGED">Damaged</option><option value="EXPIRED">Expired</option>
            <option value="THEFT">Theft / shrinkage</option><option value="SAMPLE">Given as a sample</option><option value="OTHER">Other</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ── Batches & serials ────────────────────────────────────────────────────────
function BatchTab() {
  const { activeBranchId } = useAuth();
  const [expiringOnly, setExpiringOnly] = useState(false);
  const { data: batches } = useSWR<any[]>(
    withBranch(`/api/inventory/batches?limit=300${expiringOnly ? '&expiring_soon=true' : ''}`, activeBranchId), fetcher);
  const { data: serials } = useSWR<any[]>(withBranch('/api/inventory/serials?limit=300', activeBranchId), fetcher);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="checkbox">
          <input type="checkbox" checked={expiringOnly} onChange={(e) => setExpiringOnly(e.target.checked)} />
          Only batches expiring within 90 days
        </label>
      </div>
      <Card flush title="Batches" description="For paint, adhesives, chemicals and batteries.">
        <DataTable rows={batches ?? []} emptyText="No batch-tracked stock on hand." rowKey={(b: any) => b.batch_id}
          columns={[
            { key: 'p', header: 'Product', render: (b: any) => b.product_name },
            { key: 'n', header: 'Batch', render: (b: any) => <span className="mono">{b.batch_number}</span> },
            { key: 'q', header: 'Remaining', align: 'right', render: (b: any) => num(b.qty_remaining, 4) },
            { key: 'e', header: 'Expires', nowrap: true, render: (b: any) => {
              if (!b.expiry_date) return <span className="muted">—</span>;
              const days = Number(b.days_to_expiry);
              return <span>{formatDate(b.expiry_date)}{' '}{days < 0 ? <Badge tone="critical">expired</Badge> : days < 90 ? <Badge tone="warning">{days}d left</Badge> : null}</span>;
            } },
            { key: 'b', header: 'Branch', render: (b: any) => b.branch_name },
          ]} />
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card flush title="Serial numbers" description="Recorded at sale, so a warranty claim can name the exact unit.">
          <DataTable rows={serials ?? []} emptyText="No serialised stock." rowKey={(s: any) => s.serial_id ?? `${s.product_id}:${s.serial_number}`}
            columns={[
              { key: 'p', header: 'Product', render: (s: any) => s.product_name },
              { key: 'n', header: 'Serial', render: (s: any) => <span className="mono">{s.serial_number}</span> },
              { key: 's', header: 'Status', render: (s: any) => <StatusBadge status={s.status} /> },
              { key: 'b', header: 'Branch', render: (s: any) => s.branch_name },
            ]} />
        </Card>
      </div>
    </>
  );
}

// ── Movement log (stock ledger) ──────────────────────────────────────────────
const MOVEMENT_TYPES = ['PURCHASE', 'SALE', 'SALE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'PURCHASE_RETURN',
  'WRITE_OFF', 'COUNT_ADJUSTMENT', 'OPENING_STOCK', 'ADJUSTMENT'];

function LedgerTab({ product, onClearProduct }: { product: { id: string; name: string } | null; onClearProduct: () => void }) {
  const { activeBranchId } = useAuth();
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(200);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(product);
  useEffect(() => { setPicked(product); }, [product]);

  const params = new URLSearchParams({ limit: String(limit) });
  if (type) params.set('movement_type', type);
  if (picked) params.set('product_id', picked.id);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/inventory/stock-ledger?${params}`, activeBranchId), fetcher,
    { keepPreviousData: true });
  const name = picked?.name || data?.[0]?.product_name || '';

  return (
    <>
      <div className="table-toolbar">
        {picked ? (
          <span className="row tight"><Badge tone="info">{name || 'One product'}</Badge>
            <Button size="sm" variant="ghost" onClick={() => { setPicked(null); onClearProduct(); }}>All products</Button></span>
        ) : (
          <div style={{ minWidth: 260 }}>
            <ProductPicker onSelect={(p) => setPicked({ id: p.product_id, name: p.name })} includeInactive showStock={false}
              ariaLabel="Filter by product" placeholder="Filter by product…" />
          </div>
        )}
        <select aria-label="Movement type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All movements</option>
          {MOVEMENT_TYPES.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ').toLowerCase()}</option>)}
        </select>
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <div className="spacer" />
        <Button onClick={() => downloadCsv((data ?? []).map((l) => ({
          when: l.created_at, branch: l.branch_name, sku: l.sku, product: l.product_name, movement: l.movement_type,
          change: l.base_unit_qty_change, unit: l.base_unit_label, reference: l.reference, reason: l.reason_code, by: l.created_by_name,
        })), 'stock-movements.csv')} disabled={!data?.length}><Icon name="download" size={14} /> Export</Button>
      </div>
      <Card flush title="Every stock movement, with its document and who made it">
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="inventory" title="No movements" text="Nothing matches these filters." />}>
          {(rows) => (
            <>
              <DataTable rows={rows} rowKey={(l: any) => l.ledger_id}
                columns={[
                  { key: 'when', header: 'When', nowrap: true, render: (l: any) => formatDateTime(l.created_at) },
                  { key: 'p', header: 'Product', render: (l: any) => <div>{l.product_name}<div className="muted small mono">{l.sku}</div></div> },
                  ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (l: any) => l.branch_name }]),
                  { key: 't', header: 'Movement', render: (l: any) => (
                    <Badge tone={Number(l.base_unit_qty_change) >= 0 ? 'good' : 'neutral'}>{l.movement_type.replace(/_/g, ' ').toLowerCase()}</Badge>) },
                  { key: 'ref', header: 'Document', render: (l: any) => (l.reference ? <span className="mono small">{l.reference}</span> : <span className="muted">—</span>) },
                  { key: 'q', header: 'Change', align: 'right', render: (l: any) => (
                    <span style={{ color: Number(l.base_unit_qty_change) < 0 ? 'var(--status-critical)' : 'var(--status-good)', fontWeight: 600 }}>
                      {Number(l.base_unit_qty_change) > 0 ? '+' : ''}{qtyWithUnit(l.base_unit_qty_change, l.base_unit_label)}
                    </span>) },
                  { key: 'r', header: 'Reason', render: (l: any) => (l.reason_code ? String(l.reason_code).replace(/_/g, ' ').toLowerCase() : <span className="muted">—</span>) },
                  { key: 'u', header: 'By', render: (l: any) => l.created_by_name ?? <span className="muted">system</span> },
                ]} />
              <Pager shown={rows.length} pageSize={200} onMore={() => setLimit((l) => l + 200)} />
            </>
          )}
        </AsyncSection>
      </Card>
    </>
  );
}

// ── Other branches (owner) ───────────────────────────────────────────────────
function CrossBranchTab() {
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const { data, isLoading } = useSWR<any[]>(`/api/inventory/stock/cross-branch?limit=50${search ? `&q=${encodeURIComponent(search)}` : ''}`, fetcher);
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <SearchInput value={query} onChange={setQuery} placeholder="Does another branch have it? Search any product…" />
      </div>
      <div className="grid cols-auto">
        {(data ?? []).map((p: any) => (
          <Card key={p.product_id} title={p.name} description={`${p.sku} · ${qtyWithUnit(p.chain_total, p.base_unit_label)} across all branches`}>
            <div className="stack" style={{ gap: 8 }}>
              {p.branches.map((b: any) => (
                <div className="row tight" key={b.branch_id}>
                  <span style={{ flex: 1 }}>{b.branch_name}</span>
                  <MiniBar value={Math.max(Number(b.available), 0)} max={Math.max(Number(p.chain_total), 1)} tone={Number(b.available) <= 0 ? 'critical' : 'good'} />
                  <b className="num">{qtyWithUnit(b.available, p.base_unit_label)}</b>
                </div>
              ))}
            </div>
          </Card>
        ))}
        {!isLoading && (data ?? []).length === 0 && <Card><EmptyState text="No matching product." /></Card>}
      </div>
    </>
  );
}
