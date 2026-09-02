// Section 4 — Inventory & Procurement.
import { useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiGet, apiPost, apiPut, downloadCsv, fetcher, formatDate, formatDateTime, inr, num, withBranch,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatTile, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';
import { MiniBar } from '../../components/charts';

export default function InventoryPage() {
  return (
    <RequirePermission permission="view_inventory">
      <InventoryScreen />
    </RequirePermission>
  );
}

type Tab = 'stock' | 'reorder' | 'grn' | 'transfers' | 'audits' | 'ledger' | 'batches' | 'crossbranch';

function InventoryScreen() {
  const router = useRouter();
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>(router.query.low ? 'reorder' : 'stock');

  const { data: transfers } = useSWR<any[]>(withBranch('/api/inventory/transfers', activeBranchId), fetcher);
  const openIssues = (transfers ?? []).filter((x) => x.status === 'TRANSFER_DISCREPANCY').length;

  return (
    <>
      <PageHeader title={t('navInventory')} subtitle="Stock, procurement, transfers and audits — scoped to your branch" />
      <Tabs active={tab} onChange={(k) => setTab(k as Tab)}
        tabs={[
          { key: 'stock', label: t('stock') },
          { key: 'reorder', label: 'Reorder' },
          { key: 'grn', label: t('goodsReceipt') },
          { key: 'transfers', label: t('transfer'), count: openIssues || undefined },
          { key: 'audits', label: 'Stock audit' },
          { key: 'batches', label: 'Batches & serials' },
          { key: 'ledger', label: 'Movement log' },
          ...(can('cross_branch_lookup') ? [{ key: 'crossbranch', label: 'Cross-branch lookup' }] : []),
        ]} />
      {tab === 'stock' && <StockTab />}
      {tab === 'reorder' && <ReorderTab />}
      {tab === 'grn' && <GrnTab />}
      {tab === 'transfers' && <TransfersTab />}
      {tab === 'audits' && <AuditTab />}
      {tab === 'batches' && <BatchTab />}
      {tab === 'ledger' && <LedgerTab />}
      {tab === 'crossbranch' && <CrossBranchTab />}
    </>
  );
}

// ── Stock on hand ───────────────────────────────────────────────────────────
function StockTab() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [lowOnly, setLowOnly] = useState(false);
  const [reorderFor, setReorderFor] = useState<any | null>(null);
  const [minQty, setMinQty] = useState(0);
  const [maxQty, setMaxQty] = useState(0);

  const path = withBranch(
    `/api/inventory/stock?limit=500${search ? `&q=${encodeURIComponent(search)}` : ''}${lowOnly ? '&low_stock_only=true' : ''}`,
    activeBranchId);
  const { data, error, isLoading, mutate } = useSWR<any[]>(path, fetcher);

  const totalValue = (data ?? []).reduce((s, r) => s + Number(r.stock_value ?? 0), 0);
  const lowCount = (data ?? []).filter((r) => r.is_low).length;

  async function saveReorder() {
    if (!reorderFor) return;
    try {
      await apiPut(`/api/inventory/stock/${reorderFor.product_id}/reorder`,
        { reorder_min: minQty, reorder_max: maxQty || undefined, branch_id: reorderFor.branch_id });
      toast.success('Reorder level saved');
      setReorderFor(null); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <StatTile label="SKUs carried" value={num(data?.length ?? 0, 0)} />
        <StatTile label="Below reorder point" value={num(lowCount, 0)}
          hint={lowCount ? 'Raise a purchase order' : 'Nothing to reorder'} />
        {can('view_cost_price') && (
          <StatTile label="Stock value at cost" value={inr(totalValue)} hint="Weighted average cost" />
        )}
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <SearchInput value={query} onChange={setQuery} placeholder="Product name or SKU…" />
        <label className="checkbox">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Only items below reorder point
        </label>
        <div className="spacer" />
        <Button onClick={() => downloadCsv(data ?? [], 'stock.csv')} disabled={!data?.length}>{t('export')}</Button>
      </div>

      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="📦" title="No stock rows" text="Receive goods against a vendor to start tracking stock." />}>
          {(rows) => (
            <DataTable rows={rows} footer={`${rows.length} item(s)`}
              columns={[
                { key: 'name', header: t('product'), render: (r: any) => (
                  <div><div style={{ fontWeight: 550 }}>{r.name}</div>
                    <div className="muted small mono">{r.sku} · {r.category_name ?? 'Uncategorised'}</div></div>
                ) },
                { key: 'branch', header: t('branch'), render: (r: any) => r.branch_name },
                { key: 'qty', header: 'On hand', align: 'right', render: (r: any) => (
                  <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                    <MiniBar value={Number(r.base_unit_qty)} max={Math.max(Number(r.reorder_max ?? 0), Number(r.base_unit_qty), 1)}
                      tone={Number(r.base_unit_qty) <= 0 ? 'critical' : r.is_low ? 'warning' : 'good'} />
                    <span>{num(r.base_unit_qty)}</span>
                  </div>
                ) },
                { key: 'res', header: 'Reserved', align: 'right', render: (r: any) =>
                  Number(r.reserved_qty) > 0
                    ? <Badge tone="info">{num(r.reserved_qty)}</Badge>
                    : <span className="muted">—</span> },
                { key: 'avail', header: 'Sellable', align: 'right', render: (r: any) => num(r.available_qty) },
                { key: 'min', header: t('reorderLevel'), align: 'right', render: (r: any) => (
                  <button className="btn ghost sm" onClick={() => {
                    setReorderFor(r); setMinQty(Number(r.reorder_min ?? 0)); setMaxQty(Number(r.reorder_max ?? 0));
                  }}>{r.reorder_min ? num(r.reorder_min) : 'set'}</button>
                ) },
                ...(can('view_cost_price') ? [
                  { key: 'cost', header: 'Avg cost', align: 'right' as const,
                    render: (r: any) => inr(r.weighted_avg_cost, { decimals: true }) },
                  { key: 'value', header: 'Value', align: 'right' as const,
                    render: (r: any) => inr(r.stock_value) },
                ] : []),
              ]} />
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(reorderFor)} onClose={() => setReorderFor(null)} title="Reorder levels"
        footer={<><Button onClick={() => setReorderFor(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void saveReorder()}>Save</Button></>}>
        <div className="stack">
          <Alert tone="info">
            When stock falls to the minimum, this item appears on the reorder list with a suggested
            quantity that takes it back up to the maximum.
          </Alert>
          <Field label="Minimum (reorder point)">
            <input type="number" min={0} value={minQty} onChange={(e) => setMinQty(Number(e.target.value))} />
          </Field>
          <Field label="Maximum (restock target)">
            <input type="number" min={0} value={maxQty} onChange={(e) => setMaxQty(Number(e.target.value))} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

// ── Reorder suggestions (4.3) ───────────────────────────────────────────────
function ReorderTab() {
  const { activeBranchId, can } = useAuth();
  const toast = useToast();
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [vendorId, setVendorId] = useState('');
  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch('/api/inventory/reorder-suggestions', activeBranchId), fetcher);
  const { data: vendors } = useSWR<any[]>('/api/vendors', fetcher);

  const chosen = Object.entries(selected).filter(([, qty]) => qty > 0);

  async function raisePo() {
    if (!vendorId || !chosen.length) return;
    try {
      await apiPost('/api/inventory/purchase-orders', {
        vendor_id: vendorId,
        lines: chosen.map(([product_id, qty_base_unit]) => {
          const row = (data ?? []).find((r) => r.product_id === product_id);
          return { product_id, qty_base_unit, rate: Number(row?.expected_rate ?? 0) };
        }),
      });
      toast.success('Purchase order raised');
      setSelected({}); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <Card flush title="Items at or below their reorder point"
        description="Suggested quantity takes each item back to its restock target, grouped by the preferred vendor.">
        <AsyncSection data={data} error={error} isLoading={isLoading}
          empty={<EmptyState icon="✓" title="Nothing needs reordering" text="Every item is above its reorder point." />}>
          {(rows) => (
            <DataTable rows={rows}
              columns={[
                { key: 'name', header: 'Product', render: (r: any) => (
                  <div>{r.product_name}<div className="muted small mono">{r.sku}</div></div>
                ) },
                { key: 'have', header: 'On hand', align: 'right', render: (r: any) => (
                  <Badge tone={Number(r.base_unit_qty) <= 0 ? 'critical' : 'warning'}>{num(r.base_unit_qty)}</Badge>
                ) },
                { key: 'min', header: 'Reorder at', align: 'right', render: (r: any) => num(r.reorder_min) },
                { key: 'vendor', header: 'Preferred vendor', render: (r: any) =>
                  r.vendor_name ?? <span className="muted">not mapped</span> },
                { key: 'order', header: 'Order qty', align: 'right', render: (r: any) => (
                  <input type="number" min={0} style={{ width: 100, textAlign: 'right', padding: '5px 8px' }}
                    value={selected[r.product_id] ?? Math.ceil(Number(r.suggested_qty))}
                    onChange={(e) => setSelected({ ...selected, [r.product_id]: Number(e.target.value) })} />
                ) },
              ]} />
          )}
        </AsyncSection>
      </Card>

      {can('create_purchase_order') && (data ?? []).length > 0 && (
        <Card title="Raise a purchase order" >
          <div className="row">
            <Field label="Vendor">
              <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} style={{ width: 260 }}>
                <option value="">Choose a vendor…</option>
                {(vendors ?? []).map((v: any) => <option key={v.vendor_id} value={v.vendor_id}>{v.name}</option>)}
              </select>
            </Field>
            <Button variant="primary" disabled={!vendorId || !chosen.length}
              onClick={() => void raisePo()} style={{ alignSelf: 'flex-end' }}>
              Raise PO for {chosen.length || 0} item(s)
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

// ── Goods receipt (4.5) ─────────────────────────────────────────────────────
function GrnTab() {
  const { activeBranchId, can } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<any | null>(null);
  const [returnFor, setReturnFor] = useState<any | null>(null);

  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch('/api/inventory/grn', activeBranchId), fetcher);
  const { data: debitNotes } = useSWR<any[]>(withBranch('/api/inventory/purchase-returns', activeBranchId), fetcher);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        {can('create_grn') && <Button variant="primary" onClick={() => setOpen(true)}>+ Receive goods</Button>}
      </div>

      <Card flush title="Goods receipts"
        description="Receiving stock is what recalculates the weighted-average cost — it is never typed in by hand.">
        <AsyncSection data={data} error={error} isLoading={isLoading}
          empty={<EmptyState icon="🚚" title="No goods received yet" />}>
          {(rows) => (
            <DataTable rows={rows} onRowClick={async (r) => {
              try { setDetail(await apiGet(`/api/inventory/grn/${r.grn_id}`)); } catch (err) { toast.error(err); }
            }}
              columns={[
                { key: 'no', header: 'GRN', render: (r: any) => <span className="mono">{r.grn_number}</span> },
                { key: 'vendor', header: 'Vendor', render: (r: any) => r.vendor_name },
                { key: 'branch', header: 'Branch', render: (r: any) => r.branch_name },
                { key: 'lines', header: 'Lines', align: 'right', render: (r: any) => num(r.line_count, 0) },
                { key: 'date', header: 'Received', nowrap: true, render: (r: any) => formatDateTime(r.received_at) },
                ...(can('view_cost_price') ? [{ key: 'val', header: 'Value', align: 'right' as const,
                  render: (r: any) => inr(r.total_value) }] : []),
              ]} />
          )}
        </AsyncSection>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card flush title="Purchase returns / vendor debit notes"
          description="Goods sent back after ITC was claimed need a formal debit note — that is what reverses the credit (4.5.1).">
          <DataTable rows={debitNotes ?? []} emptyText="No purchase returns raised."
            columns={[
              { key: 'no', header: 'Debit note', render: (r: any) => <span className="mono">{r.debit_note_number}</span> },
              { key: 'grn', header: 'Against GRN', render: (r: any) => <span className="mono">{r.grn_number}</span> },
              { key: 'vendor', header: 'Vendor', render: (r: any) => r.vendor_name },
              { key: 'reason', header: 'Reason', render: (r: any) => r.reason },
              { key: 'date', header: 'Raised', nowrap: true, render: (r: any) => formatDate(r.created_at) },
              { key: 'amt', header: 'Amount', align: 'right', render: (r: any) => inr(r.total_amount, { decimals: true }) },
            ]} />
        </Card>
      </div>

      <NewGrnModal open={open} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); void mutate(); }} />

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide title={`GRN ${detail?.grn_number ?? ''}`}
        footer={can('create_purchase_return') && detail ? (
          <Button onClick={() => { setReturnFor(detail); setDetail(null); }}>Return items to vendor</Button>
        ) : undefined}>
        {detail && (
          <div className="stack">
            <KeyValue items={[
              ['Vendor', detail.vendor_name],
              ['Vendor GSTIN', detail.vendor_gstin],
              ['Branch', detail.branch_name],
              ['Received', formatDateTime(detail.received_at)],
            ]} />
            <DataTable rows={detail.lines ?? []}
              columns={[
                { key: 'p', header: 'Product', render: (l: any) => l.product_name },
                { key: 'q', header: 'Qty', align: 'right', render: (l: any) => `${num(l.qty_base_unit)} ${l.base_unit}` },
                ...(can('view_cost_price') ? [{ key: 'r', header: 'Rate', align: 'right' as const,
                  render: (l: any) => inr(l.rate, { decimals: true }) }] : []),
                { key: 'b', header: 'Batch', render: (l: any) => l.batch_number ?? <span className="muted">—</span> },
                { key: 'ret', header: 'Returned', align: 'right', render: (l: any) =>
                  Number(l.returned_qty) > 0 ? <Badge tone="warning">{num(l.returned_qty)}</Badge> : <span className="muted">—</span> },
              ]} />
          </div>
        )}
      </Modal>

      <PurchaseReturnModal grn={returnFor} onClose={() => setReturnFor(null)}
        onDone={() => { setReturnFor(null); void mutate(); }} />
    </>
  );
}

function NewGrnModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [vendorId, setVendorId] = useState('');
  const [lines, setLines] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [busy, setBusy] = useState(false);

  const { data: vendors } = useSWR<any[]>(open ? '/api/vendors' : null, fetcher);
  const { data: products } = useSWR<any[]>(
    open ? `/api/catalog/products?limit=25${search ? `&q=${encodeURIComponent(search)}` : ''}` : null, fetcher);

  function addLine(p: any) {
    if (lines.some((l) => l.product_id === p.product_id)) return;
    setLines([...lines, {
      product_id: p.product_id, name: p.name, base_unit: p.base_unit,
      batch_tracked: p.batch_tracked, serial_tracked: p.serial_tracked,
      qty_base_unit: 1, rate: Number(p.reference_purchase_price ?? 0),
      batch_number: '', expiry_date: '',
    }]);
    setQuery('');
  }

  async function submit() {
    setBusy(true);
    try {
      await apiPost('/api/inventory/grn', {
        vendor_id: vendorId,
        lines: lines.map((l) => ({
          product_id: l.product_id, qty_base_unit: Number(l.qty_base_unit), rate: Number(l.rate),
          batch_number: l.batch_number || undefined,
          expiry_date: l.expiry_date || undefined,
        })),
      });
      toast.success('Goods received', 'Stock and weighted-average cost have been updated.');
      setVendorId(''); setLines([]); onCreated();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title="Receive goods"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!vendorId || !lines.length}
          onClick={() => void submit()}>Receive {lines.length} line(s)</Button></>}>
      <div className="stack">
        <Field label="Vendor" required>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Choose a vendor…</option>
            {(vendors ?? []).map((v: any) => <option key={v.vendor_id} value={v.vendor_id}>{v.name}</option>)}
          </select>
        </Field>

        <Field label="Add items">
          <SearchInput value={query} onChange={setQuery} placeholder="Search the catalog…" />
        </Field>
        {query && (
          <div style={{ maxHeight: 160, overflowY: 'auto' }}>
            {(products ?? []).map((p: any) => (
              <button key={p.product_id} onClick={() => addLine(p)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                  border: '1px solid var(--border)', borderRadius: 6, marginBottom: 4,
                  background: 'var(--surface-1)', cursor: 'pointer', font: 'inherit' }}>
                {p.name} <span className="muted small mono">{p.sku}</span>
              </button>
            ))}
          </div>
        )}

        {lines.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr>
                <th>Product</th><th style={{ width: 100 }}>Qty</th><th style={{ width: 110 }}>Rate</th>
                <th style={{ width: 150 }}>Batch</th><th style={{ width: 140 }}>Expiry</th><th style={{ width: 40 }} />
              </tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.product_id}>
                    <td>{l.name}
                      {l.batch_tracked && <div><Badge tone="info">batch required</Badge></div>}</td>
                    <td><input type="number" min={0.0001} step="any" value={l.qty_base_unit} style={{ padding: '5px 8px' }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty_base_unit: e.target.value } : x))} /></td>
                    <td><input type="number" min={0} step="any" value={l.rate} style={{ padding: '5px 8px' }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} /></td>
                    <td><input value={l.batch_number} placeholder={l.batch_tracked ? 'required' : 'n/a'}
                      disabled={!l.batch_tracked} style={{ padding: '5px 8px' }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, batch_number: e.target.value } : x))} /></td>
                    <td><input type="date" value={l.expiry_date} disabled={!l.batch_tracked} style={{ padding: '5px 8px' }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, expiry_date: e.target.value } : x))} /></td>
                    <td><button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PurchaseReturnModal({ grn, onClose, onDone }: { grn: any | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    const lines = Object.entries(qtys).filter(([, q]) => q > 0)
      .map(([grn_line_id, qty_base_unit]) => ({ grn_line_id, qty_base_unit }));
    if (!lines.length) return;
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/inventory/purchase-returns', { grn_id: grn.grn_id, reason, lines });
      toast.success(`Debit note ${res.debit_note_number} raised`, res.itc_reversal_note);
      setQtys({}); setReason(''); onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={Boolean(grn)} onClose={onClose} wide title="Return goods to the vendor"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!reason} onClick={() => void submit()}>Raise debit note</Button></>}>
      {grn && (
        <div className="stack">
          <Alert tone="info" title="This raises a vendor debit note">
            Input tax credit was claimed when these goods were received, so a formal debit note —
            with its own number series — is what reverses it. A return record on its own is not enough for GST.
          </Alert>
          <Field label="Reason" required>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Choose…</option>
              <option>Damaged in transit</option>
              <option>Wrong specification supplied</option>
              <option>Short shipment</option>
              <option>Quality rejected</option>
            </select>
          </Field>
          <DataTable rows={grn.lines ?? []}
            columns={[
              { key: 'p', header: 'Product', render: (l: any) => l.product_name },
              { key: 'recv', header: 'Received', align: 'right', render: (l: any) => num(l.qty_base_unit) },
              { key: 'already', header: 'Already returned', align: 'right', render: (l: any) => num(l.returned_qty) },
              { key: 'ret', header: 'Return now', align: 'right', render: (l: any) => (
                <input type="number" min={0} step="any" style={{ width: 100, textAlign: 'right', padding: '5px 8px' }}
                  value={qtys[l.grn_line_id] ?? 0}
                  onChange={(e) => setQtys({ ...qtys, [l.grn_line_id]: Number(e.target.value) })} />
              ) },
            ]} />
        </div>
      )}
    </Modal>
  );
}

// ── Transfers (4.4 / 4.4.1) ─────────────────────────────────────────────────
function TransfersTab() {
  const { can, user, activeBranchId, branches } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<any | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState<Record<string, number>>({});
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch('/api/inventory/transfers', activeBranchId), fetcher);

  async function act(path: string, body?: any, message = 'Done') {
    try {
      const res = await apiPost<any>(path, body ?? {});
      toast.success(message, res?.message);
      setDetail(null); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        {can('create_transfer') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ New transfer</Button>}
      </div>

      <Card flush title="Inter-branch transfers"
        description="Stock leaves on dispatch and arrives on receipt. A short receipt is held as a discrepancy for the owner to settle — neither side is silently adjusted.">
        <AsyncSection data={data} error={error} isLoading={isLoading}
          empty={<EmptyState icon="🔁" title="No transfers" />}>
          {(rows) => (
            <DataTable rows={rows} onRowClick={async (r) => {
              try { setDetail(await apiGet(`/api/inventory/transfers/${r.transfer_id}`)); setReceiveQtys({}); }
              catch (err) { toast.error(err); }
            }}
              columns={[
                { key: 'from', header: 'From', render: (r: any) => r.from_branch_name },
                { key: 'to', header: 'To', render: (r: any) => r.to_branch_name },
                { key: 'lines', header: 'Lines', align: 'right', render: (r: any) => num(r.line_count, 0) },
                { key: 'type', header: 'GST movement', render: (r: any) => <Badge tone="neutral">{r.transfer_doc_type}</Badge> },
                { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                { key: 'disc', header: 'Variance', align: 'right', render: (r: any) =>
                  Number(r.total_discrepancy) !== 0
                    ? <Badge tone="critical">{num(r.total_discrepancy)}</Badge>
                    : <span className="muted">—</span> },
                { key: 'when', header: 'Dispatched', nowrap: true, render: (r: any) => formatDate(r.dispatched_at) },
              ]} />
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide
        title={`Transfer · ${detail?.from_branch_name ?? ''} → ${detail?.to_branch_name ?? ''}`}
        footer={detail && (
          <>
            {detail.status === 'REQUESTED' && can('create_transfer') && (
              <Button variant="primary"
                onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/dispatch`, {}, 'Dispatched')}>
                Dispatch
              </Button>
            )}
            {detail.status === 'DISPATCHED' && can('receive_transfer') && (
              <Button variant="primary" onClick={() => void act(
                `/api/inventory/transfers/${detail.transfer_id}/receive`,
                { lines: (detail.lines ?? []).map((l: any) => ({
                    line_id: l.line_id,
                    received_qty: receiveQtys[l.line_id] ?? Number(l.dispatched_qty),
                  })) },
                'Received')}>
                Confirm receipt
              </Button>
            )}
            {detail.status === 'TRANSFER_DISCREPANCY' && can('resolve_transfer_discrepancy') && (
              <>
                <Button onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/resolve`,
                  { resolution: 'COUNT_CORRECTION', responsible_branch_id: detail.to_branch_id }, 'Corrected')}>
                  It was a counting error
                </Button>
                <Button variant="danger" onClick={() => void act(`/api/inventory/transfers/${detail.transfer_id}/resolve`,
                  { resolution: 'WRITE_OFF', responsible_branch_id: detail.from_branch_id }, 'Written off')}>
                  Write off the shortfall
                </Button>
              </>
            )}
          </>
        )}>
        {detail && (
          <div className="stack">
            <KeyValue items={[
              ['Status', <StatusBadge status={detail.status} />],
              ['Driver / vehicle', detail.driver_ref],
              ['Dispatched', formatDateTime(detail.dispatched_at)],
              ['Received', formatDateTime(detail.received_at)],
            ]} />
            {detail.status === 'TRANSFER_DISCREPANCY' && (
              <Alert tone="critical" title="Quantities did not match">
                Neither branch's stock has been forced to agree. Decide whether the shortfall is a
                genuine loss (write it off against the responsible branch) or a miscount (correct the receiving count).
              </Alert>
            )}
            <DataTable rows={detail.lines ?? []}
              columns={[
                { key: 'p', header: 'Product', render: (l: any) => l.product_name },
                { key: 'd', header: 'Dispatched', align: 'right', render: (l: any) => num(l.dispatched_qty) },
                { key: 'r', header: 'Received', align: 'right', render: (l: any) =>
                  detail.status === 'DISPATCHED'
                    ? <input type="number" min={0} step="any" style={{ width: 100, textAlign: 'right', padding: '5px 8px' }}
                        value={receiveQtys[l.line_id] ?? Number(l.dispatched_qty)}
                        onChange={(e) => setReceiveQtys({ ...receiveQtys, [l.line_id]: Number(e.target.value) })} />
                    : (l.received_qty === null ? <span className="muted">—</span> : num(l.received_qty)) },
                { key: 'v', header: 'Variance', align: 'right', render: (l: any) =>
                  Number(l.discrepancy_qty) !== 0
                    ? <Badge tone="critical">{num(l.discrepancy_qty)}</Badge>
                    : <span className="muted">—</span> },
                { key: 'res', header: 'Resolution', render: (l: any) => l.resolution ?? <span className="muted">—</span> },
              ]} />
          </div>
        )}
      </Modal>

      <NewTransferModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />
    </>
  );
}

function NewTransferModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { user, branches } = useAuth();
  const toast = useToast();
  const [toBranch, setToBranch] = useState('');
  const [driverRef, setDriverRef] = useState('');
  const [lines, setLines] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [allBranches, setAllBranches] = useState<any[]>([]);
  const { data: products } = useSWR<any[]>(
    open ? `/api/catalog/products?limit=25${search ? `&q=${encodeURIComponent(search)}` : ''}` : null, fetcher);

  // The destination list has to include branches this user cannot otherwise see,
  // so it comes from the admin branch endpoint when available and falls back to
  // the user's own visible list.
  useSWR(open ? '/api/admin/branches' : null, fetcher, {
    onSuccess: (d) => setAllBranches(d as any[]),
    onError: () => setAllBranches(branches),
  });

  async function submit() {
    try {
      await apiPost('/api/inventory/transfers', {
        to_branch_id: toBranch, driver_ref: driverRef || undefined,
        lines: lines.map((l) => ({ product_id: l.product_id, dispatched_qty: Number(l.qty) })),
      });
      toast.success('Transfer requested', 'Stock moves when you dispatch it.');
      setLines([]); setToBranch(''); setDriverRef(''); onCreated();
    } catch (err) { toast.error(err); }
  }

  const options = (allBranches.length ? allBranches : branches).filter((b: any) => b.branch_id !== user?.branch_id);

  return (
    <Modal open={open} onClose={onClose} wide title="New inter-branch transfer"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!toBranch || !lines.length} onClick={() => void submit()}>
          Request transfer
        </Button></>}>
      <div className="stack">
        <div className="grid cols-2">
          <Field label="Send to" required>
            <select value={toBranch} onChange={(e) => setToBranch(e.target.value)}>
              <option value="">Choose a branch…</option>
              {options.map((b: any) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Driver / vehicle reference">
            <input value={driverRef} onChange={(e) => setDriverRef(e.target.value)} placeholder="MH-01-AB-1234" />
          </Field>
        </div>
        <Field label="Items"><SearchInput value={query} onChange={setQuery} placeholder="Search the catalog…" /></Field>
        {query && (
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            {(products ?? []).map((p: any) => (
              <button key={p.product_id} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                border: '1px solid var(--border)', borderRadius: 6, marginBottom: 4, background: 'var(--surface-1)',
                cursor: 'pointer', font: 'inherit' }}
                onClick={() => { setLines([...lines, { product_id: p.product_id, name: p.name, qty: 1, available: p.available_qty }]); setQuery(''); }}>
                {p.name} <span className="muted small">({num(p.available_qty)} available)</span>
              </button>
            ))}
          </div>
        )}
        {lines.map((l, i) => (
          <div className="row tight" key={i}>
            <span style={{ flex: 1 }}>{l.name}</span>
            <input type="number" min={0.0001} step="any" value={l.qty} style={{ width: 110 }}
              onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
            <button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ── Stock audit (4.6) & write-offs (4.7) ────────────────────────────────────
function AuditTab() {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<any | null>(null);
  const [counting, setCounting] = useState<any | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [writeOffOpen, setWriteOffOpen] = useState(false);

  const { data, mutate } = useSWR<any[]>(withBranch('/api/inventory/stock-audits', activeBranchId), fetcher);
  const { data: writeOffs, mutate: mutateWriteOffs } = useSWR<any[]>(
    withBranch('/api/inventory/write-offs', activeBranchId), fetcher);
  const { data: stock } = useSWR<any[]>(
    counting ? withBranch('/api/inventory/stock?limit=500', activeBranchId) : null, fetcher);

  async function startAudit() {
    try {
      const audit = await apiPost<any>('/api/inventory/stock-audits', {});
      setCounting(audit); setCounts({});
      toast.success('Stock take started', 'Count the shelves and enter what you find.');
      void mutate();
    } catch (err) { toast.error(err); }
  }

  async function completeAudit() {
    if (!counting) return;
    try {
      const res = await apiPost<any>(`/api/inventory/stock-audits/${counting.audit_id}/complete`, {
        counts: Object.entries(counts).map(([product_id, counted_qty]) => ({ product_id, counted_qty })),
      });
      toast.success('Stock take complete',
        `${res.variance_lines} line(s) differed from the system and have been corrected through the ledger.`);
      setCounting(null); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        {can('approve_write_off') && <Button onClick={() => setWriteOffOpen(true)}>Record a write-off</Button>}
        {can('run_stock_audit') && <Button variant="primary" onClick={() => void startAudit()}>Start a stock take</Button>}
      </div>

      {counting && (
        <Card title="Counting in progress" description="Enter the physical count for each item you check. Anything you leave blank is skipped."
          footer={<div className="row">
            <Button variant="ghost" onClick={() => setCounting(null)}>Abandon</Button>
            <div className="spacer" />
            <Button variant="primary" disabled={!Object.keys(counts).length} onClick={() => void completeAudit()}>
              Finish and post {Object.keys(counts).length} count(s)
            </Button>
          </div>} flush>
          <DataTable rows={(stock ?? []).slice(0, 200)}
            columns={[
              { key: 'p', header: 'Product', render: (r: any) => (
                <div>{r.name}<div className="muted small mono">{r.sku}</div></div>
              ) },
              { key: 'sys', header: 'System says', align: 'right', render: (r: any) => num(r.base_unit_qty) },
              { key: 'cnt', header: 'Counted', align: 'right', render: (r: any) => (
                <input type="number" min={0} step="any" style={{ width: 110, textAlign: 'right', padding: '5px 8px' }}
                  value={counts[r.product_id] ?? ''} placeholder="—"
                  onChange={(e) => {
                    const v = e.target.value;
                    setCounts((prev) => {
                      const next = { ...prev };
                      if (v === '') delete next[r.product_id]; else next[r.product_id] = Number(v);
                      return next;
                    });
                  }} />
              ) },
              { key: 'var', header: 'Variance', align: 'right', render: (r: any) => {
                const c = counts[r.product_id];
                if (c === undefined) return <span className="muted">—</span>;
                const v = c - Number(r.base_unit_qty);
                return v === 0 ? <Badge tone="good">match</Badge>
                  : <Badge tone={Math.abs(v) > 5 ? 'critical' : 'warning'}>{v > 0 ? '+' : ''}{num(v)}</Badge>;
              } },
            ]} />
        </Card>
      )}

      <Card flush title="Stock takes">
        <DataTable rows={data ?? []} emptyText="No stock take has been run yet."
          onRowClick={async (r) => {
            try { setDetail(await apiGet(`/api/inventory/stock-audits/${r.audit_id}`)); } catch (err) { toast.error(err); }
          }}
          columns={[
            { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
            { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
            { key: 'l', header: 'Items counted', align: 'right', render: (r: any) => num(r.line_count, 0) },
            { key: 'v', header: 'With variance', align: 'right', render: (r: any) =>
              Number(r.variance_count) > 0
                ? <Badge tone="warning">{num(r.variance_count, 0)}</Badge>
                : <Badge tone="good">none</Badge> },
            { key: 'by', header: 'Run by', render: (r: any) => r.created_by_name },
            { key: 'when', header: 'Started', nowrap: true, render: (r: any) => formatDate(r.started_at) },
          ]} />
      </Card>

      <div style={{ marginTop: 16 }}>
        <Card flush title="Damage & wastage write-offs"
          description="Distinct from a sales return — this is stock that will never be sold.">
          <DataTable rows={writeOffs ?? []} emptyText="No write-offs recorded."
            columns={[
              { key: 'p', header: 'Product', render: (r: any) => r.product_name },
              { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
              { key: 'q', header: 'Qty', align: 'right', render: (r: any) => num(r.qty_base_unit) },
              { key: 'r', header: 'Reason', render: (r: any) => <Badge tone="warning">{r.reason_code}</Badge> },
              { key: 'by', header: 'By', render: (r: any) => r.created_by_name },
              { key: 'w', header: 'When', nowrap: true, render: (r: any) => formatDate(r.created_at) },
            ]} />
        </Card>
      </div>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide title="Stock take variance">
        {detail && (
          <DataTable rows={detail.lines ?? []}
            columns={[
              { key: 'p', header: 'Product', render: (l: any) => l.product_name },
              { key: 's', header: 'System', align: 'right', render: (l: any) => num(l.system_qty) },
              { key: 'c', header: 'Counted', align: 'right', render: (l: any) => num(l.counted_qty) },
              { key: 'v', header: 'Variance', align: 'right', render: (l: any) =>
                Number(l.variance_qty) === 0
                  ? <Badge tone="good">match</Badge>
                  : <Badge tone={Number(l.variance_qty) < 0 ? 'critical' : 'warning'}>
                      {Number(l.variance_qty) > 0 ? '+' : ''}{num(l.variance_qty)}
                    </Badge> },
            ]} />
        )}
      </Modal>

      <WriteOffModal open={writeOffOpen} onClose={() => setWriteOffOpen(false)}
        onDone={() => { setWriteOffOpen(false); void mutateWriteOffs(); }} />
    </>
  );
}

function WriteOffModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('DAMAGED');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const { data: products } = useSWR<any[]>(
    open ? `/api/catalog/products?limit=25${search ? `&q=${encodeURIComponent(search)}` : ''}` : null, fetcher);

  async function submit() {
    try {
      await apiPost('/api/inventory/write-offs', { product_id: productId, qty_base_unit: qty, reason_code: reason });
      toast.success('Write-off recorded');
      setProductId(''); setQty(1); onDone();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Write off damaged or unsellable stock"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={!productId} onClick={() => void submit()}>Write off</Button></>}>
      <div className="stack">
        <Field label="Product" required>
          <SearchInput value={query} onChange={setQuery} placeholder="Search…" />
          <select value={productId} onChange={(e) => setProductId(e.target.value)} style={{ marginTop: 8 }}>
            <option value="">Choose…</option>
            {(products ?? []).map((p: any) => (
              <option key={p.product_id} value={p.product_id}>{p.name} ({num(p.available_qty)} on hand)</option>
            ))}
          </select>
        </Field>
        <Field label="Quantity"><input type="number" min={0.0001} step="any" value={qty}
          onChange={(e) => setQty(Number(e.target.value))} /></Field>
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="DAMAGED">Damaged</option>
            <option value="EXPIRED">Expired</option>
            <option value="THEFT">Theft / shrinkage</option>
            <option value="SAMPLE">Used as a sample</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

// ── Batches & serials (4.2 / 4.9) ───────────────────────────────────────────
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
      <Card flush title="Batches" description="Tracked for paint, adhesives, chemicals and batteries.">
        <DataTable rows={batches ?? []} emptyText="No batch-tracked stock on hand."
          columns={[
            { key: 'p', header: 'Product', render: (b: any) => b.product_name },
            { key: 'n', header: 'Batch', render: (b: any) => <span className="mono">{b.batch_number}</span> },
            { key: 'q', header: 'Remaining', align: 'right', render: (b: any) => num(b.qty_remaining) },
            { key: 'e', header: 'Expires', nowrap: true, render: (b: any) => {
              if (!b.expiry_date) return <span className="muted">—</span>;
              const days = Number(b.days_to_expiry);
              return (
                <span>
                  {formatDate(b.expiry_date)}{' '}
                  {days < 0 ? <Badge tone="critical">expired</Badge>
                    : days < 90 ? <Badge tone="warning">{days}d left</Badge> : null}
                </span>
              );
            } },
            { key: 'b', header: 'Branch', render: (b: any) => b.branch_name },
          ]} />
      </Card>
      <div style={{ marginTop: 16 }}>
        <Card flush title="Serial numbers" description="Captured at sale, so a warranty claim can name the exact unit.">
          <DataTable rows={serials ?? []} emptyText="No serialised stock."
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

// ── Ledger (4.1) ────────────────────────────────────────────────────────────
function LedgerTab() {
  const { can, activeBranchId } = useAuth();
  const [type, setType] = useState('');
  const { data } = useSWR<any[]>(
    withBranch(`/api/inventory/stock-ledger?limit=300${type ? `&movement_type=${type}` : ''}`, activeBranchId), fetcher);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 220 }}>
          <option value="">All movement types</option>
          {['PURCHASE', 'SALE', 'SALE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'PURCHASE_RETURN',
            'WRITE_OFF', 'COUNT_ADJUSTMENT'].map((m) => (
            <option key={m} value={m}>{m.replace(/_/g, ' ').toLowerCase()}</option>
          ))}
        </select>
        <div className="spacer" />
        <Button onClick={() => downloadCsv(data ?? [], 'stock-ledger.csv')} disabled={!data?.length}>Export</Button>
      </div>
      <Card flush title="Every stock movement, with its reason and who made it">
        <DataTable rows={data ?? []} emptyText="No movements recorded."
          columns={[
            { key: 'when', header: 'When', nowrap: true, render: (l: any) => formatDateTime(l.created_at) },
            { key: 'p', header: 'Product', render: (l: any) => l.product_name },
            { key: 'b', header: 'Branch', render: (l: any) => l.branch_name },
            { key: 't', header: 'Movement', render: (l: any) => (
              <Badge tone={Number(l.base_unit_qty_change) >= 0 ? 'good' : 'neutral'}>
                {l.movement_type.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            ) },
            { key: 'q', header: 'Change', align: 'right', render: (l: any) => (
              <span style={{ color: Number(l.base_unit_qty_change) < 0 ? 'var(--status-critical)' : 'var(--status-good)' }}>
                {Number(l.base_unit_qty_change) > 0 ? '+' : ''}{num(l.base_unit_qty_change)}
              </span>
            ) },
            { key: 'r', header: 'Reason', render: (l: any) => l.reason_code ?? <span className="muted">—</span> },
            { key: 'u', header: 'By', render: (l: any) => l.created_by_name ?? <span className="muted">system</span> },
          ]} />
      </Card>
    </>
  );
}

// ── Cross-branch lookup (Section 0) ─────────────────────────────────────────
function CrossBranchTab() {
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const { data, isLoading } = useSWR<any[]>(
    `/api/inventory/stock/cross-branch?limit=50${search ? `&q=${encodeURIComponent(search)}` : ''}`, fetcher);

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <Alert tone="info" title="Owner-only view">
          Staff are confined to their own branch. This screen answers “does another branch have this
          item in stock?” without switching context.
        </Alert>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <SearchInput value={query} onChange={setQuery} placeholder="Search any product across the chain…" />
      </div>
      <div className="grid cols-auto">
        {(data ?? []).map((p: any) => (
          <Card key={p.product_id} title={p.name} description={`${p.sku} · ${num(p.chain_total)} ${p.base_unit.toLowerCase()} chain-wide`}>
            <div className="stack" style={{ gap: 8 }}>
              {p.branches.map((b: any) => (
                <div className="row tight" key={b.branch_id}>
                  <span style={{ flex: 1 }}>{b.branch_name}</span>
                  <MiniBar value={Number(b.available)} max={Math.max(Number(p.chain_total), 1)}
                    tone={Number(b.available) <= 0 ? 'critical' : 'good'} />
                  <b className="num">{num(b.available)}</b>
                </div>
              ))}
            </div>
          </Card>
        ))}
        {!isLoading && (data ?? []).length === 0 && (
          <Card><EmptyState text="No matching product." /></Card>
        )}
      </div>
    </>
  );
}
