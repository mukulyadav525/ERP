// Section 5 — Quotations & B2B / contractor pricing.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import { apiGet, apiPost, fetcher, formatDate, inr, num, withBranch } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';

export default function QuotationsPage() {
  return (
    <RequirePermission permission="view_quotations">
      <QuotationsScreen />
    </RequirePermission>
  );
}

function QuotationsScreen() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'quotes' | 'challans'>('quotes');
  const [detail, setDetail] = useState<any | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [approving, setApproving] = useState<any | null>(null);
  const [reserve, setReserve] = useState(false);
  const [holdDays, setHoldDays] = useState(3);

  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch('/api/quotations?limit=200', activeBranchId), fetcher);
  const { data: challans } = useSWR<any[]>(withBranch('/api/quotations/challans', activeBranchId), fetcher);
  const { data: settings } = useSWR<any>('/api/admin/settings/effective', fetcher);

  const moduleOff = error && String((error as Error).message).includes('switched off');

  // ?quotation=<id> — where a global-search hit lands.
  const router = useRouter();
  useEffect(() => {
    const id = router.query.quotation;
    if (typeof id !== 'string' || detail?.quotation_id === id) return;
    apiGet(`/api/quotations/${id}`).then(setDetail).catch(() => { /* stale link */ });
  }, [router.query.quotation]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function act(id: string, action: string, body?: any, message = 'Done') {
    try {
      const res = await apiPost<any>(`/api/quotations/${id}/${action}`, body ?? {});
      toast.success(message, res?.invoice_number ? `Invoice ${res.invoice_number} created.` : undefined);
      setDetail(null); setApproving(null); void mutate();
    } catch (err) { toast.error(err); }
  }

  if (moduleOff) {
    return (
      <>
        <PageHeader title={t('navQuotations')} />
        <Card>
          <EmptyState icon="quotation" title="The quotations module is switched off"
            text="An owner can turn it on under Admin → Settings → Quotations. It ships off in Phase 1 by design." />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('navQuotations')}
        subtitle="Quotes for contractors and B2B customers — priced tax-exclusive, convertible to an invoice"
        actions={can('create_quotation') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ Quotation</Button>} />

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[{ key: 'quotes', label: 'Quotations', count: data?.length },
               { key: 'challans', label: 'Delivery challans', count: challans?.length }]} />

      {tab === 'quotes' && (
        <Card flush>
          <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
            empty={<EmptyState icon="quotation" title="No quotations yet" />}>
            {(rows) => (
              <DataTable rows={rows} onRowClick={async (r) => {
                try { setDetail(await apiGet(`/api/quotations/${r.quotation_id}`)); } catch (err) { toast.error(err); }
              }}
                columns={[
                  { key: 'n', header: 'Quote', render: (q: any) => <span className="mono">{q.quotation_number}</span> },
                  { key: 'c', header: 'Customer', render: (q: any) => (
                    <div>{q.customer_name}
                      {q.customer_type === 'B2B_CONTRACTOR' && <div><Badge tone="info">contractor</Badge></div>}</div>
                  ) },
                  { key: 'b', header: 'Branch', render: (q: any) => q.branch_name },
                  { key: 'l', header: 'Lines', align: 'right', render: (q: any) => num(q.line_count, 0) },
                  { key: 'res', header: 'Stock held', render: (q: any) => q.stock_reserved
                    ? <Badge tone="warning">held to {formatDate(q.reservation_hold_until)}</Badge>
                    : <span className="muted">no</span> },
                  { key: 's', header: 'Status', render: (q: any) => <StatusBadge status={q.status} /> },
                  { key: 'd', header: 'Raised', nowrap: true, render: (q: any) => formatDate(q.created_at) },
                  { key: 'v', header: 'Value', align: 'right', render: (q: any) => inr(q.total_value) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      {tab === 'challans' && (
        <Card flush title="Delivery challans"
          description="A delivery note for goods sent to site ahead of the final bill. Not a tax invoice — it creates no GST liability.">
          <DataTable rows={challans ?? []} emptyText="No challans issued."
            columns={[
              { key: 'n', header: 'Challan', render: (c: any) => <span className="mono">{c.challan_number}</span> },
              { key: 'q', header: 'Against quote', render: (c: any) => c.quotation_number ?? <span className="muted">—</span> },
              { key: 'c', header: 'Customer', render: (c: any) => c.customer_name },
              { key: 'b', header: 'Branch', render: (c: any) => c.branch_name },
              { key: 'l', header: 'Lines', align: 'right', render: (c: any) => num(c.line_count, 0) },
              { key: 'd', header: 'Delivered', nowrap: true, render: (c: any) => formatDate(c.created_at) },
            ]} />
        </Card>
      )}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide
        title={`Quotation ${detail?.quotation_number ?? ''}`}
        footer={detail && (
          <>
            {detail.status === 'DRAFT' && can('approve_quotation') && (
              <Button variant="primary" onClick={() => { setApproving(detail); setReserve(Boolean(settings?.quotation_stock_reservation)); }}>
                Approve
              </Button>
            )}
            {detail.stock_reserved && (
              <Button onClick={() => void act(detail.quotation_id, 'release-reservation', {}, 'Reservation released')}>
                Release held stock
              </Button>
            )}
            {['DRAFT', 'APPROVED'].includes(detail.status) && can('convert_quotation') && (
              <Button variant="primary" onClick={() => void act(detail.quotation_id, 'convert', {}, 'Converted to an invoice')}>
                Convert to invoice
              </Button>
            )}
            {detail.status !== 'CONVERTED' && (
              <Button variant="danger" onClick={() => void act(detail.quotation_id, 'cancel', {}, 'Quotation cancelled')}>
                Cancel
              </Button>
            )}
          </>
        )}>
        {detail && (
          <div className="stack">
            <KeyValue items={[
              ['Customer', detail.customer_name],
              ['Phone', detail.customer_phone],
              ['GSTIN', detail.customer_gstin],
              ['Branch', detail.branch_name],
              ['Status', <StatusBadge status={detail.status} />],
              ['Pricing', detail.price_type === 'TAX_EXCLUSIVE' ? 'Tax exclusive — GST added on top' : 'Tax inclusive'],
            ]} />
            {detail.stock_reserved && (
              <Alert tone="warning" title="Stock is held against this quote">
                The quoted quantity is reserved and not sellable to a walk-in until {formatDate(detail.reservation_hold_until)}.
                If the quote is not converted by then it releases automatically.
              </Alert>
            )}
            <DataTable rows={detail.lines ?? []}
              columns={[
                { key: 'p', header: 'Product', render: (l: any) => l.product_name },
                { key: 'q', header: 'Qty', align: 'right', render: (l: any) => `${num(l.qty_base_unit)} ${l.base_unit}` },
                { key: 'r', header: 'Rate', align: 'right', render: (l: any) => inr(l.rate, { decimals: true }) },
                { key: 'g', header: 'GST', align: 'right', render: (l: any) => `${num(l.gst_rate_pct, 0)}%` },
                { key: 'v', header: 'Value', align: 'right', render: (l: any) => inr(l.line_value, { decimals: true }) },
              ]} />
            {detail.totals && (
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <dl className="kv" style={{ minWidth: 280 }}>
                  <dt>Taxable value</dt><dd className="num">{inr(detail.totals.subtotal, { decimals: true })}</dd>
                  <dt>CGST</dt><dd className="num">{inr(detail.totals.cgst_total, { decimals: true })}</dd>
                  <dt>SGST</dt><dd className="num">{inr(detail.totals.sgst_total, { decimals: true })}</dd>
                  <dt><b>Total</b></dt><dd className="num"><b>{inr(detail.totals.grand_total, { decimals: true })}</b></dd>
                </dl>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={Boolean(approving)} onClose={() => setApproving(null)} title="Approve this quotation"
        footer={<><Button onClick={() => setApproving(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void act(approving.quotation_id, 'approve',
            { reserve_stock: reserve, hold_days: holdDays }, 'Quotation approved')}>Approve</Button></>}>
        <div className="stack">
          <Alert tone="info">
            Approving can hold the quoted stock so a walk-in cannot buy it out from under the customer.
            Leave it off for a speculative estimate.
          </Alert>
          <label className="checkbox">
            <input type="checkbox" checked={reserve} onChange={(e) => setReserve(e.target.checked)} />
            Reserve the quoted stock
          </label>
          {reserve && (
            <Field label="Hold for (days)" hint="After this it releases back to sellable stock automatically.">
              <input type="number" min={1} max={90} value={holdDays} onChange={(e) => setHoldDays(Number(e.target.value))} />
            </Field>
          )}
        </div>
      </Modal>

      <NewQuotationModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />
    </>
  );
}

function NewQuotationModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [customerId, setCustomerId] = useState('');
  const [custQuery, setCustQuery] = useState('');
  const custSearch = useDebounced(custQuery, 250);
  const [lines, setLines] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);

  const { data: customers } = useSWR<any[]>(
    open ? `/api/customers?limit=20${custSearch ? `&q=${encodeURIComponent(custSearch)}` : ''}` : null, fetcher);
  const { data: products } = useSWR<any[]>(
    open ? `/api/catalog/products?limit=25${search ? `&q=${encodeURIComponent(search)}` : ''}` : null, fetcher);

  async function submit() {
    try {
      await apiPost('/api/quotations', {
        customer_id: customerId,
        lines: lines.map((l) => ({ product_id: l.product_id, qty_base_unit: Number(l.qty), rate: Number(l.rate) })),
      });
      toast.success('Quotation created');
      setLines([]); setCustomerId(''); onCreated();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title="New quotation"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!customerId || !lines.length} onClick={() => void submit()}>Create</Button></>}>
      <div className="stack">
        <Field label="Customer" required>
          <SearchInput value={custQuery} onChange={setCustQuery} placeholder="Search customers…" />
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={{ marginTop: 8 }}>
            <option value="">Choose…</option>
            {(customers ?? []).map((c: any) => (
              <option key={c.customer_id} value={c.customer_id}>
                {c.name} — {c.phone}{c.customer_type === 'B2B_CONTRACTOR' ? ' (contractor)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Items"><SearchInput value={query} onChange={setQuery} placeholder="Search the catalog…" /></Field>
        {query && (
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            {(products ?? []).map((p: any) => (
              <button key={p.product_id} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                border: '1px solid var(--border)', borderRadius: 6, marginBottom: 4, background: 'var(--surface-1)',
                cursor: 'pointer', font: 'inherit' }}
                onClick={() => {
                  setLines([...lines, { product_id: p.product_id, name: p.name, qty: 10, rate: Number(p.selling_price) }]);
                  setQuery('');
                }}>
                {p.name} <span className="muted small">{inr(p.selling_price, { decimals: true })}</span>
              </button>
            ))}
          </div>
        )}
        {lines.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th style={{ width: 110 }}>Qty</th><th style={{ width: 130 }}>Rate</th><th style={{ width: 40 }} /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.name}</td>
                    <td><input type="number" min={0.0001} step="any" value={l.qty} style={{ padding: '5px 8px' }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></td>
                    <td><input type="number" min={0} step="any" value={l.rate} style={{ padding: '5px 8px' }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} /></td>
                    <td><button className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Alert tone="info">
          Quotes are priced tax-exclusive by default — GST is shown as an addition, which is how
          contractors expect to be quoted.
        </Alert>
      </div>
    </Modal>
  );
}
