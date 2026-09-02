// Section 8 — Vendor / Procurement Management.
import { useState } from 'react';
import useSWR from 'swr';
import { apiGet, apiPost, downloadCsv, fetcher, formatDate, inr, num } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatTile, Tabs, useDebounced,
} from '../../components/ui';
import { BarsChart } from '../../components/charts';

export default function VendorsPage() {
  return (
    <RequirePermission permission="view_vendors">
      <VendorsScreen />
    </RequirePermission>
  );
}

function VendorsScreen() {
  const { can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | 'payables'>('all');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [detail, setDetail] = useState<any | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [payFor, setPayFor] = useState<any | null>(null);
  const [payAmount, setPayAmount] = useState('');

  const { data, error, isLoading, mutate } = useSWR<any[]>(
    `/api/vendors?limit=200${search ? `&q=${encodeURIComponent(search)}` : ''}`, fetcher);
  const { data: payables, mutate: mutatePayables } = useSWR<any[]>('/api/vendors/outstanding/list', fetcher);

  const totalPayable = (payables ?? []).reduce((s, v) => s + Number(v.balance_owed), 0);
  const overdue = (payables ?? []).filter((v) => v.is_overdue);

  async function recordPayment() {
    if (!payFor) return;
    try {
      await apiPost(`/api/vendors/${payFor.vendor_id}/payments`, { amount: Number(payAmount) });
      toast.success('Payment recorded');
      setPayFor(null); setPayAmount(''); void mutatePayables(); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <PageHeader title={t('navVendors')} subtitle="Suppliers, payables and purchase performance"
        actions={can('edit_vendor') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ Vendor</Button>} />

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <StatTile label="Active vendors" value={num(data?.length ?? 0, 0)} />
        <StatTile label="Total payable" value={inr(totalPayable)} />
        <StatTile label="Past payment terms" value={num(overdue.length, 0)}
          hint={overdue.length ? inr(overdue.reduce((s, v) => s + Number(v.balance_owed), 0)) : 'All within terms'} />
      </div>

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[{ key: 'all', label: 'Vendors' }, { key: 'payables', label: 'Payables', count: payables?.length }]} />

      {tab === 'all' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Vendor name…" />
            <div className="spacer" />
            <Button onClick={() => downloadCsv(data ?? [], 'vendors.csv')} disabled={!data?.length}>Export</Button>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="🏪" title="No vendors" />}>
              {(rows) => (
                <DataTable rows={rows} onRowClick={async (r) => {
                  try { setDetail(await apiGet(`/api/vendors/${r.vendor_id}`)); } catch (err) { toast.error(err); }
                }}
                  columns={[
                    { key: 'n', header: 'Vendor', render: (v: any) => (
                      <div>{v.name}<div className="muted small mono">{v.gstin ?? 'no GSTIN'}</div></div>
                    ) },
                    { key: 'p', header: 'Phone', render: (v: any) => v.phone ?? <span className="muted">—</span> },
                    { key: 'terms', header: 'Terms', align: 'right', render: (v: any) =>
                      v.payment_terms_days ? `${v.payment_terms_days} days` : <span className="muted">—</span> },
                    { key: 'grn', header: 'Receipts', align: 'right', render: (v: any) => num(v.grn_count, 0) },
                    { key: 'bal', header: 'Payable', align: 'right', render: (v: any) =>
                      Number(v.balance_owed) > 0 ? <b>{inr(v.balance_owed)}</b> : <span className="muted">—</span> },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'payables' && (
        <Card flush title="Outstanding payables">
          <AsyncSection data={payables} empty={<EmptyState icon="✓" title="Nothing owed" />}>
            {(rows) => (
              <DataTable rows={rows}
                columns={[
                  { key: 'n', header: 'Vendor', render: (v: any) => v.name },
                  { key: 't', header: 'Terms', align: 'right', render: (v: any) =>
                    v.payment_terms_days ? `${v.payment_terms_days} days` : <span className="muted">—</span> },
                  { key: 'age', header: 'Since last activity', align: 'right', render: (v: any) => (
                    <Badge tone={v.is_overdue ? 'critical' : 'neutral'}>{num(v.days_since_activity, 0)} days</Badge>
                  ) },
                  { key: 'b', header: 'Payable', align: 'right', render: (v: any) => <b>{inr(v.balance_owed)}</b> },
                  { key: 'act', header: '', render: (v: any) => can('record_vendor_payment') && (
                    <Button size="sm" onClick={() => { setPayFor(v); setPayAmount(String(v.balance_owed)); }}>Pay</Button>
                  ) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      <VendorDetail vendor={detail} onClose={() => setDetail(null)} />
      <NewVendorModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />

      <Modal open={Boolean(payFor)} onClose={() => setPayFor(null)} title={`Pay ${payFor?.name ?? ''}`}
        footer={<><Button onClick={() => setPayFor(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void recordPayment()}>Record payment</Button></>}>
        <Field label="Amount" hint={`Outstanding: ${inr(payFor?.balance_owed)}`}>
          <input type="number" min={0.01} step="any" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}

function VendorDetail({ vendor, onClose }: { vendor: any | null; onClose: () => void }) {
  const { can } = useAuth();
  const { data: performance } = useSWR<any>(
    vendor && can('view_cost_price') ? `/api/vendors/${vendor.vendor_id}/performance` : null, fetcher);

  return (
    <Modal open={Boolean(vendor)} onClose={onClose} wide title={vendor?.name ?? ''}>
      {vendor && (
        <div className="stack">
          <KeyValue items={[
            ['GSTIN', vendor.gstin],
            ['Phone', vendor.phone],
            ['Address', vendor.address],
            ['Payment terms', vendor.payment_terms_days ? `${vendor.payment_terms_days} days` : null],
            ['Payable', <b>{inr(vendor.balance_owed)}</b>],
          ]} />

          {performance?.monthly?.length > 0 && (
            <Card title="Purchase volume by month" description="Receipts and returns, last 12 months">
              <BarsChart data={performance.monthly} xKey="month"
                series={[{ key: 'purchase_value', label: 'Purchases' }]} height={200} />
            </Card>
          )}

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Recent goods receipts</div>
            <DataTable rows={(vendor.grns ?? []).slice(0, 15)} emptyText="No receipts from this vendor."
              columns={[
                { key: 'n', header: 'GRN', render: (g: any) => <span className="mono">{g.grn_number}</span> },
                { key: 'b', header: 'Branch', render: (g: any) => g.branch_name },
                { key: 'd', header: 'Received', nowrap: true, render: (g: any) => formatDate(g.received_at) },
                ...(can('view_cost_price') ? [{ key: 'v', header: 'Value', align: 'right' as const,
                  render: (g: any) => inr(g.total_value) }] : []),
              ]} />
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Payables ledger</div>
            <DataTable rows={(vendor.ledger ?? []).slice(0, 20)} emptyText="No ledger activity."
              columns={[
                { key: 'd', header: 'When', nowrap: true, render: (l: any) => formatDate(l.created_at) },
                { key: 't', header: 'Entry', render: (l: any) => (
                  <Badge tone={l.entry_type === 'PAYMENT_MADE' ? 'good' : l.entry_type === 'DEBIT_NOTE' ? 'warning' : 'neutral'}>
                    {l.entry_type.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                ) },
                { key: 'a', header: 'Amount', align: 'right', render: (l: any) => inr(l.amount, { decimals: true }) },
                { key: 'b', header: 'Balance', align: 'right', render: (l: any) => inr(l.balance_after, { decimals: true }) },
              ]} />
          </div>
        </div>
      )}
    </Modal>
  );
}

function NewVendorModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', gstin: '', phone: '', address: '', payment_terms_days: '' });

  async function submit() {
    try {
      await apiPost('/api/vendors', {
        ...form,
        gstin: form.gstin || undefined, phone: form.phone || undefined, address: form.address || undefined,
        payment_terms_days: form.payment_terms_days ? Number(form.payment_terms_days) : undefined,
      });
      toast.success('Vendor added');
      setForm({ name: '', gstin: '', phone: '', address: '', payment_terms_days: '' });
      onCreated();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a vendor"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!form.name} onClick={() => void submit()}>Add</Button></>}>
      <div className="stack">
        <Field label="Name" required><input required value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label="GSTIN"><input value={form.gstin}
            onChange={(e) => setForm({ ...form, gstin: e.target.value })} /></Field>
          <Field label="Phone"><input type="tel" value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <Field label="Address"><textarea value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        <Field label="Payment terms (days)" hint="Used to flag overdue payables">
          <input type="number" min={0} value={form.payment_terms_days}
            onChange={(e) => setForm({ ...form, payment_terms_days: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
