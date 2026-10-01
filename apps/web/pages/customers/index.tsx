// ============================================================================
// Customers & their accounts (spec §32–§35)
//
// One record per person across every branch (deduplicated on phone). The
// account balance is the credit ledger and nothing else, so the statement, the
// counter's credit check and the outstanding list always agree. Receiving money
// is a numbered receipt with a method and reference, posted once even if the
// form is submitted twice.
// ============================================================================
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiPost, apiPut, businessToday, downloadCsv, fetcher, formatDate, formatDateTime, idempotencyKey,
  inr, num, whatsappShareUrl,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, BranchGate, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, Pager, RequirePermission, SearchInput, StatTile, StatusBadge, Switch, Tabs, useDebounced,
} from '../../components/ui';
import { CustomerPicker, StateSelect, stateName, type CustomerHit } from '../../components/pickers';
import { Icon } from '../../components/icons';

export default function CustomersPage() {
  return (
    <RequirePermission permission="view_customers">
      <CustomersScreen />
    </RequirePermission>
  );
}

const ENTRY_LABEL: Record<string, string> = {
  OPENING_BALANCE: 'Opening balance', SALE_ON_CREDIT: 'Sale on credit', PAYMENT_RECEIVED: 'Payment received',
  REFUND_ADJUSTMENT: 'Return / credit note', ADJUSTMENT: 'Adjustment', CREDIT_SALE_REVERSAL: 'Bill voided',
};
const entryLabel = (t: string) => ENTRY_LABEL[t] ?? t.replace(/_/g, ' ').toLowerCase();
const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');

function CustomersScreen() {
  const router = useRouter();
  const { can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | 'outstanding'>(router.query.tab === 'outstanding' ? 'outstanding' : 'all');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [status, setStatus] = useState('active');
  const [withBalance, setWithBalance] = useState(false);
  const [sort, setSort] = useState('recent');
  const [limit, setLimit] = useState(100);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<any | null | 'new'>(null);
  const [mergeOpen, setMergeOpen] = useState(false);

  const params = new URLSearchParams({ limit: String(limit), status, sort });
  if (search) params.set('q', search);
  if (withBalance) params.set('has_balance', 'true');
  const { data, error, isLoading, mutate } = useSWR<any[]>(`/api/customers?${params}`, fetcher, { keepPreviousData: true });
  const { data: outstanding, mutate: mutateOutstanding } = useSWR<any[]>(
    can('view_customer_outstanding') ? '/api/customers/outstanding/list?limit=500' : null, fetcher);
  const totalDue = (outstanding ?? []).reduce((s, r) => s + Number(r.balance_owed), 0);
  const over90 = (outstanding ?? []).filter((r) => r.ageing_bucket === '90+').reduce((s, r) => s + Number(r.balance_owed), 0);

  // ?customer=<id> lands from global search; ?new=1 from the quick actions.
  useEffect(() => { if (router.query.new === '1' && can('edit_customer')) setFormFor('new'); }, [router.query.new, can]);
  useEffect(() => { if (typeof router.query.customer === 'string') setDetailId(router.query.customer); }, [router.query.customer]);

  function refresh() { void mutate(); void mutateOutstanding(); }

  async function sendReminders() {
    if (!window.confirm('Queue a WhatsApp reminder for every customer whose oldest unpaid bill is over 15 days old?\n\nMessages are only delivered if the WhatsApp Business API is configured in Admin. Otherwise use the WhatsApp button on each customer to send it yourself.')) return;
    try {
      const res = await apiPost<any>('/api/customers/outstanding/send-reminders', { min_days_outstanding: 15 });
      toast.toast(`${res.queued} reminder(s) queued`, { tone: 'info', message: 'Queued — not yet delivered. Delivery depends on the WhatsApp Business API being configured.' });
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <PageHeader title={t('navCustomers')}
        subtitle="One record per customer across every branch"
        actions={<>
          {can('merge_customers') && <Button onClick={() => setMergeOpen(true)}>Merge duplicates</Button>}
          {can('edit_customer') && <Button variant="primary" onClick={() => setFormFor('new')}><Icon name="plus" size={14} /> Add customer</Button>}
        </>} />

      {can('view_customer_outstanding') && (
        <div className="grid cols-3" style={{ marginBottom: 14 }}>
          <StatTile label="Owed by customers" value={inr(totalDue)} hint={`${(outstanding ?? []).length} customer(s) with a balance`} />
          <StatTile label="Over 90 days" value={inr(over90)} hint={over90 > 0 ? 'Needs chasing' : 'Nothing that old'} />
          <StatTile label="Over their credit limit" value={num((outstanding ?? []).filter((r) => Number(r.balance_owed) > Number(r.credit_limit)).length, 0)} hint="Customers" />
        </div>
      )}

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'all', label: 'All customers' },
          ...(can('view_customer_outstanding') ? [{ key: 'outstanding', label: t('outstanding'), count: outstanding?.length || undefined }] : []),
        ]} />

      {tab === 'all' && (
        <>
          <div className="table-toolbar">
            <SearchInput value={query} onChange={setQuery} placeholder="Name, phone, company or GSTIN…" />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
            </select>
            <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recent">Newest first</option><option value="name">Name A–Z</option><option value="balance">Highest balance</option>
            </select>
            <label className="checkbox"><input type="checkbox" checked={withBalance} onChange={(e) => setWithBalance(e.target.checked)} /> With a balance</label>
            <div className="spacer" />
            <Button onClick={() => downloadCsv((data ?? []).map((r) => ({
              name: r.name, company: r.company_name, phone: r.phone, whatsapp: r.whatsapp, email: r.email, gstin: r.gstin,
              state: r.state, type: r.customer_type, credit_limit: r.credit_limit, balance: r.balance_owed, points: r.loyalty_points_balance,
            })), 'customers.csv')} disabled={!data?.length}><Icon name="download" size={14} /> Export</Button>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="customers" title={search ? 'No customer matches' : 'No customers yet'}
                text={search ? 'Check the spelling or the phone number.' : 'Add a customer, or create one while billing.'} />}>
              {(rows) => (
                <>
                  <DataTable rows={rows} rowKey={(r: any) => r.customer_id} onRowClick={(r: any) => setDetailId(r.customer_id)}
                    columns={[
                      { key: 'name', header: t('name'), render: (r: any) => (
                        <div><span style={{ fontWeight: 550 }}>{r.name}</span>{!r.is_active && <> <Badge tone="neutral">inactive</Badge></>}
                          {r.company_name && <div className="muted small">{r.company_name}</div>}</div>) },
                      { key: 'phone', header: 'Phone', nowrap: true, render: (r: any) => r.phone },
                      { key: 'gst', header: 'GSTIN', render: (r: any) => (r.gstin ? <span className="mono small">{r.gstin}</span> : <span className="muted">—</span>) },
                      { key: 'type', header: 'Type', render: (r: any) => (
                        <Badge tone={r.customer_type === 'B2B_CONTRACTOR' ? 'info' : 'neutral'}>{r.customer_type === 'B2B_CONTRACTOR' ? 'Business' : 'Retail'}</Badge>) },
                      { key: 'credit', header: t('creditLimit'), align: 'right', render: (r: any) => (r.credit_allowed ? inr(r.credit_limit) : <span className="muted">no credit</span>) },
                      { key: 'bal', header: t('balance'), align: 'right', render: (r: any) => Number(r.balance_owed) > 0
                        ? <span style={{ color: 'var(--status-critical)', fontWeight: 600 }}>{inr(r.balance_owed, { decimals: true })}</span>
                        : Number(r.balance_owed) < 0 ? <Badge tone="good">advance {inr(-r.balance_owed)}</Badge> : <span className="muted">—</span> },
                    ]} />
                  <Pager shown={rows.length} pageSize={100} onMore={() => setLimit((l) => l + 100)} />
                </>
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'outstanding' && (
        <Card flush title="Outstanding balances by age"
          right={can('record_customer_payment') && <Button size="sm" onClick={() => void sendReminders()}>Queue reminders…</Button>}>
          <AsyncSection data={outstanding} isLoading={!outstanding}
            empty={<EmptyState icon="check" title="Nothing outstanding" text="No customer is carrying a balance." />}>
            {(rows) => (
              <DataTable rows={rows} rowKey={(r: any) => r.customer_id} onRowClick={(r: any) => setDetailId(r.customer_id)}
                columns={[
                  { key: 'n', header: t('customer'), render: (r: any) => <div>{r.name}<div className="muted small">{r.phone}</div></div> },
                  { key: 'age', header: 'Oldest unpaid', render: (r: any) => (
                    <Badge tone={r.ageing_bucket === '90+' ? 'critical' : r.ageing_bucket === '61-90' ? 'warning' : 'neutral'}>
                      {r.days_outstanding ?? '—'} days</Badge>) },
                  { key: 'last', header: 'Last activity', nowrap: true, render: (r: any) => formatDate(r.last_activity) },
                  { key: 'lim', header: t('creditLimit'), align: 'right', render: (r: any) => inr(r.credit_limit) },
                  { key: 'bal', header: t('balance'), align: 'right', render: (r: any) => <b>{inr(r.balance_owed, { decimals: true })}</b> },
                  { key: 'over', header: '', render: (r: any) => (Number(r.balance_owed) > Number(r.credit_limit) ? <Badge tone="critical">over limit</Badge> : null) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      <CustomerDetail id={detailId} onClose={() => {
        setDetailId(null);
        if (router.query.customer) void router.replace('/customers', undefined, { shallow: true });
      }} onEdit={(c) => setFormFor(c)} onChanged={refresh} />
      <CustomerForm customer={formFor} onClose={() => setFormFor(null)}
        onSaved={(c, isNew) => { setFormFor(null); refresh(); if (isNew && c?.customer_id) setDetailId(c.customer_id); }} />
      <MergeModal open={mergeOpen} onClose={() => setMergeOpen(false)} onDone={() => { setMergeOpen(false); refresh(); }} />
    </>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────
function CustomerDetail({ id, onClose, onEdit, onChanged }: {
  id: string | null; onClose: () => void; onEdit: (c: any) => void; onChanged: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [inner, setInner] = useState<'statement' | 'invoices' | 'receipts' | 'returns' | 'points'>('statement');
  const [payOpen, setPayOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const { data: c, error, mutate } = useSWR<any>(id ? `/api/customers/${id}` : null, fetcher);
  useEffect(() => { setInner(can('view_customer_outstanding') ? 'statement' : 'invoices'); }, [id, can]);

  async function toggleActive() {
    if (!c) return;
    const next = !c.is_active;
    if (!next && !window.confirm(`Mark ${c.name} inactive? They will not be offered at the counter. Their history and balance are kept.`)) return;
    try {
      await apiPut(`/api/customers/${c.customer_id}`, { is_active: next });
      toast.success(next ? 'Customer re-activated' : 'Customer marked inactive');
      void mutate(); onChanged();
    } catch (err) { toast.error(err); }
  }

  const balance = Number(c?.balance_owed ?? 0);
  const shareUrl = c ? whatsappShareUrl(c.whatsapp ?? c.phone, [
    `Namaste ${c.name},`,
    balance > 0 ? `Your account balance with us is ${inr(balance, { decimals: true })}.` : 'Your account with us has no balance due.',
    'Please contact us for a detailed statement.',
    'Thank you.',
  ].join('\n')) : null;

  return (
    <Modal open={Boolean(id)} onClose={onClose} wide title={c ? c.name : 'Customer'}
      footer={c && <>
        {can('edit_customer') && <Button variant="ghost" onClick={() => void toggleActive()}>{c.is_active ? 'Mark inactive' : 'Re-activate'}</Button>}
        <span className="spacer" />
        {shareUrl && <Button onClick={() => window.open(shareUrl, '_blank', 'noopener')}><Icon name="whatsapp" size={14} /> WhatsApp</Button>}
        {can('set_credit_limit') && <Button onClick={() => setCreditOpen(true)}>Credit limit</Button>}
        {can('edit_customer') && <Button onClick={() => onEdit(c)}><Icon name="edit" size={14} /> Edit</Button>}
        {can('record_customer_payment') && <Button variant="primary" onClick={() => setPayOpen(true)}>Receive payment</Button>}
      </>}>
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {!c && !error && <div className="muted">Loading…</div>}
      {c && (
        <div className="stack">
          {!c.is_active && <Alert tone="warning">This customer is marked inactive.</Alert>}
          <div className="grid cols-2">
            <KeyValue items={[
              ['Phone', c.phone], ['WhatsApp', c.whatsapp || 'same as phone'], ['Email', c.email || '—'],
              ['Company', c.company_name || '—'], ['Type', c.customer_type === 'B2B_CONTRACTOR' ? 'Business / contractor' : 'Retail'],
            ]} />
            <KeyValue items={[
              ['GSTIN', c.gstin || 'Unregistered'], ['State', c.state_code ? `${c.state_code} ${stateName(c.state_code)}` : '—'],
              ['Address', c.address || '—'], ['Customer since', formatDate(c.created_at)],
              ...(c.notes ? [['Notes', c.notes] as [string, React.ReactNode]] : []),
            ]} />
          </div>
          <div className="grid cols-4">
            <StatTile label="Balance owed" value={balance < 0 ? `Advance ${inr(-balance, { decimals: true })}` : inr(balance, { decimals: true })} />
            <StatTile label="Credit limit" value={c.credit_allowed ? inr(c.credit_limit) : 'No credit'}
              hint={c.credit_allowed ? `${inr(c.credit_available)} available` : undefined} />
            <StatTile label="Net purchases" value={inr(c.summary?.net_sales ?? c.lifetime_value)} hint={`${num(c.summary?.invoice_count ?? 0, 0)} bill(s)`} />
            <StatTile label="Loyalty points" value={num(c.loyalty_points_balance, 0)} hint={c.summary?.last_purchase_at ? `Last bought ${formatDate(c.summary.last_purchase_at)}` : 'No purchases yet'} />
          </div>
          <Tabs active={inner} onChange={(k) => setInner(k as any)}
            tabs={[
              ...(can('view_customer_outstanding') ? [{ key: 'statement', label: 'Statement' }] : []),
              { key: 'invoices', label: 'Bills', count: c.invoices?.length || undefined },
              { key: 'receipts', label: 'Receipts', count: c.payments?.length || undefined },
              { key: 'returns', label: 'Returns', count: c.returns?.length || undefined },
              { key: 'points', label: 'Points' },
            ]} />
          {inner === 'statement' && <Statement customerId={c.customer_id} name={c.name} />}
          {inner === 'invoices' && (
            <DataTable rows={c.invoices ?? []} emptyText="No bills yet." rowKey={(r: any) => r.invoice_id}
              columns={[
                { key: 'n', header: 'Bill', nowrap: true, render: (r: any) => <a className="mono" href={`/billing?invoice=${r.invoice_id}`}>{r.invoice_number}</a> },
                { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDateTime(r.server_received_at) },
                { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
                { key: 's', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                { key: 'cr', header: 'On credit', align: 'right', render: (r: any) => (Number(r.on_credit) ? inr(r.on_credit, { decimals: true }) : '—') },
                { key: 'a', header: 'Amount', align: 'right', render: (r: any) => inr(r.amount, { decimals: true }) },
              ]} />
          )}
          {inner === 'receipts' && (
            <DataTable rows={c.payments ?? []} emptyText="No payments received against the account yet." rowKey={(r: any) => r.payment_id}
              columns={[
                { key: 'n', header: 'Receipt', nowrap: true, render: (r: any) => <span className="mono">{r.receipt_number}</span> },
                { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDateTime(r.created_at) },
                { key: 'm', header: 'Method', render: (r: any) => `${r.method.replace('_', ' ').toLowerCase()}${r.reference ? ` · ${r.reference}` : ''}` },
                { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
                { key: 'u', header: 'Received by', render: (r: any) => r.received_by ?? '—' },
                { key: 'a', header: 'Amount', align: 'right', render: (r: any) => inr(r.amount, { decimals: true }) },
              ]} />
          )}
          {inner === 'returns' && (
            <DataTable rows={c.returns ?? []} emptyText="No returns." rowKey={(r: any) => r.return_id}
              columns={[
                { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDate(r.created_at) },
                { key: 'i', header: 'Against bill', render: (r: any) => <span className="mono">{r.invoice_number}</span> },
                { key: 'cn', header: 'Credit note', render: (r: any) => r.credit_note_number ?? '—' },
                { key: 'm', header: 'Refund', render: (r: any) => String(r.refund_method).replace('_', ' ').toLowerCase() },
                { key: 'a', header: 'Value', align: 'right', render: (r: any) => inr(Number(r.refund_total) + Number(r.store_credit_total), { decimals: true }) },
              ]} />
          )}
          {inner === 'points' && (
            <DataTable rows={c.loyalty ?? []} emptyText="No loyalty activity." rowKey={(r: any) => r.txn_id ?? `${r.created_at}:${r.points}`}
              columns={[
                { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDate(r.created_at) },
                { key: 't', header: 'Type', render: (r: any) => String(r.txn_type).toLowerCase() },
                { key: 'p', header: 'Points', align: 'right', render: (r: any) => `${Number(r.points) > 0 ? '+' : ''}${num(r.points, 0)}` },
                { key: 'b', header: 'Balance', align: 'right', render: (r: any) => num(r.balance_after, 0) },
              ]} />
          )}
        </div>
      )}
      {c && <ReceivePaymentModal open={payOpen} customer={c} onClose={() => setPayOpen(false)}
        onDone={() => { setPayOpen(false); void mutate(); onChanged(); }} />}
      {c && <CreditModal open={creditOpen} customer={c} onClose={() => setCreditOpen(false)}
        onDone={() => { setCreditOpen(false); void mutate(); onChanged(); }} />}
    </Modal>
  );
}

function Statement({ customerId, name }: { customerId: string; name: string }) {
  const today = businessToday();
  const [from, setFrom] = useState(() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 90); return d.toISOString().slice(0, 10); });
  const [to, setTo] = useState(today);
  const { data, error, isLoading } = useSWR<any>(`/api/customers/${customerId}/statement?from=${from}&to=${to}`, fetcher, { keepPreviousData: true });
  return (
    <div className="stack">
      <div className="table-toolbar">
        <input type="date" aria-label="From" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <span className="muted small">to</span>
        <input type="date" aria-label="To" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        <div className="spacer" />
        {data && !data.reconciles && <Badge tone="critical">does not reconcile</Badge>}
        <Button size="sm" disabled={!data?.entries?.length} onClick={() => downloadCsv([
          { date: data.from, entry: 'Opening balance', reference: '', debit: '', credit: '', balance: data.opening_balance },
          ...data.entries.map((e: any) => ({
            date: formatDate(e.created_at), entry: entryLabel(e.entry_type), reference: e.reference ?? '', branch: e.branch_name,
            debit: Number(e.amount) > 0 ? e.amount : '', credit: Number(e.amount) < 0 ? -e.amount : '', balance: e.balance_after,
          })),
          { date: data.to, entry: 'Closing balance', reference: '', debit: '', credit: '', balance: data.closing_balance },
        ], `statement-${name.replace(/\W+/g, '-')}-${from}-to-${to}.csv`)}><Icon name="download" size={13} /> CSV</Button>
      </div>
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {isLoading && !data && <div className="muted">Loading statement…</div>}
      {data && (
        <>
          <div className="grid cols-4">
            <StatTile label={`Opening (${formatDate(data.from)})`} value={inr(data.opening_balance, { decimals: true })} />
            <StatTile label="Credit sales" value={inr(data.sales_on_credit, { decimals: true })} />
            <StatTile label="Payments received" value={inr(data.payments, { decimals: true })} />
            <StatTile label={`Closing (${formatDate(data.to)})`} value={inr(data.closing_balance, { decimals: true })} />
          </div>
          <DataTable rows={data.entries} emptyText="No account activity in this period." rowKey={(e: any) => e.entry_id}
            columns={[
              { key: 'd', header: 'Date', nowrap: true, render: (e: any) => formatDateTime(e.created_at) },
              { key: 't', header: 'Entry', render: (e: any) => entryLabel(e.entry_type) },
              { key: 'r', header: 'Document', render: (e: any) => (e.reference ? <span className="mono small">{e.reference}</span> : <span className="muted">—</span>) },
              { key: 'b', header: 'Branch', render: (e: any) => e.branch_name ?? '—' },
              { key: 'dr', header: 'Debit', align: 'right', render: (e: any) => (Number(e.amount) > 0 ? inr(e.amount, { decimals: true }) : '') },
              { key: 'cr', header: 'Credit', align: 'right', render: (e: any) => (Number(e.amount) < 0 ? inr(-e.amount, { decimals: true }) : '') },
              { key: 'bal', header: 'Balance', align: 'right', render: (e: any) => <b>{inr(e.balance_after, { decimals: true })}</b> },
            ]} />
        </>
      )}
    </div>
  );
}

// ── Receive a payment (§34) ──────────────────────────────────────────────────
function ReceivePaymentModal({ open, customer, onClose, onDone }: { open: boolean; customer: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [advance, setAdvance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any | null>(null);
  const key = useRef(idempotencyKey());
  const balance = Number(customer.balance_owed ?? 0);
  useEffect(() => {
    if (open) { setAmount(balance > 0 ? balance.toFixed(2) : ''); setMethod('CASH'); setReference(''); setNotes(''); setAdvance(false); setDone(null); key.current = idempotencyKey(); }
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const value = Number(amount || 0);
  const over = value > balance + 0.005;
  async function submit() {
    if (!(value > 0)) { toast.error(new Error('Enter the amount received.')); return; }
    if (['BANK_TRANSFER', 'CHEQUE'].includes(method) && !reference.trim()) {
      toast.error(new Error(method === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the bank transfer reference (UTR).')); return;
    }
    if (over && !advance) { toast.error(new Error(`This is more than the ${inr(balance, { decimals: true })} owed. Tick "take the extra as an advance" if that is intended.`)); return; }
    setBusy(true);
    try {
      const res = await apiPost<any>(`/api/customers/${customer.customer_id}/payments`, {
        amount: value, method, reference: reference.trim() || undefined, notes: notes.trim() || undefined,
        allow_advance: over && advance, client_txn_id: key.current,
      });
      setDone(res);
      toast.success(`Receipt ${res.receipt_number} recorded`, `New balance ${inr(res.balance_owed, { decimals: true })}`);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  const shareUrl = done ? whatsappShareUrl(customer.whatsapp ?? customer.phone, [
    `Namaste ${customer.name},`,
    `We have received ${inr(done.amount, { decimals: true })} (${String(done.method).replace('_', ' ').toLowerCase()}), receipt ${done.receipt_number}.`,
    Number(done.balance_owed) > 0 ? `Balance still due: ${inr(done.balance_owed, { decimals: true })}.` : 'Your account is now fully settled.',
    'Thank you.',
  ].join('\n')) : null;

  return (
    <Modal open={open} onClose={done ? onDone : onClose} title={done ? 'Payment received' : `Receive payment — ${customer.name}`}
      footer={done
        ? <>{shareUrl && <Button onClick={() => window.open(shareUrl, '_blank', 'noopener')}><Icon name="whatsapp" size={14} /> Send receipt on WhatsApp</Button>}
            <span className="spacer" /><Button variant="primary" onClick={onDone}>Done</Button></>
        : <><Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} onClick={() => void submit()}>Record receipt</Button></>}>
      {done ? (
        <div className="stack">
          <Alert tone="good" title={`Receipt ${done.receipt_number}`}>
            {inr(done.amount, { decimals: true })} by {String(done.method).replace('_', ' ').toLowerCase()}{done.reference ? ` (${done.reference})` : ''}.
            Balance now {inr(done.balance_owed, { decimals: true })}.
          </Alert>
          {done.till_note && <Alert tone="warning">{done.till_note}</Alert>}
          {done.duplicate && <Alert tone="info">This receipt had already been recorded — it was not recorded twice.</Alert>}
        </div>
      ) : (
        <BranchGate what="this receipt">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="muted small">Currently owed: <b>{inr(balance, { decimals: true })}</b></div>
            <div className="form-grid">
              <Field label="Amount received (₹)" required>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(decimalOnly(e.target.value))} autoFocus />
              </Field>
              <Field label="Method">
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="CHEQUE">Cheque</option><option value="CARD">Card</option>
                </select>
              </Field>
              {method !== 'CASH' && (
                <Field label={method === 'CHEQUE' ? 'Cheque number' : method === 'BANK_TRANSFER' ? 'UTR / reference' : 'Reference (optional)'}
                  required={['BANK_TRANSFER', 'CHEQUE'].includes(method)}>
                  <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
                </Field>
              )}
              <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field>
            </div>
            {over && (
              <Alert tone="warning" title={`${inr(value - balance, { decimals: true })} more than is owed`}>
                <label className="checkbox"><input type="checkbox" checked={advance} onChange={(e) => setAdvance(e.target.checked)} />
                  Take the extra as an advance (held on the account against future bills)</label>
              </Alert>
            )}
            {method === 'CASH' && <p className="muted small" style={{ margin: 0 }}>Cash goes into your open till, so the drawer count expects it.</p>}
          </form>
        </BranchGate>
      )}
    </Modal>
  );
}

function CreditModal({ open, customer, onClose, onDone }: { open: boolean; customer: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [allowed, setAllowed] = useState(false);
  const [limit, setLimit] = useState('');
  useEffect(() => { if (open) { setAllowed(Boolean(customer.credit_allowed)); setLimit(String(Number(customer.credit_limit ?? 0))); } }, [open, customer]);
  async function save() {
    try {
      await apiPut(`/api/customers/${customer.customer_id}/credit`, { credit_allowed: allowed, credit_limit: allowed ? Number(limit || 0) : 0 });
      toast.success('Credit terms saved'); onDone();
    } catch (err) { toast.error(err); }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Credit terms — ${customer.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
      <div className="stack">
        <Switch checked={allowed} onChange={setAllowed} label="Allow sales on credit" />
        {allowed && (
          <Field label="Credit limit (₹)" hint={`Currently owed ${inr(customer.balance_owed, { decimals: true })}. A sale over the limit needs a manager PIN.`}>
            <input inputMode="decimal" value={limit} onChange={(e) => setLimit(decimalOnly(e.target.value))} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ── Create / edit ────────────────────────────────────────────────────────────
const EMPTY_FORM = { name: '', phone: '', whatsapp: '', company_name: '', email: '', gstin: '', state_code: '', address: '',
  customer_type: 'RETAIL', notes: '', opening_balance: '', credit_allowed: false, credit_limit: '' };

function CustomerForm({ customer, onClose, onSaved }: { customer: any | null | 'new'; onClose: () => void; onSaved: (c: any, isNew: boolean) => void }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const isNew = customer === 'new';
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mayOpening = ['OWNER_ADMIN', 'BRANCH_MANAGER', 'ACCOUNTANT'].includes(user?.role ?? '');
  useEffect(() => {
    if (customer === null) return;
    setErrors({});
    setForm(customer === 'new' ? { ...EMPTY_FORM } : {
      ...EMPTY_FORM, name: customer.name ?? '', phone: customer.phone ?? '', whatsapp: customer.whatsapp ?? '',
      company_name: customer.company_name ?? '', email: customer.email ?? '', gstin: customer.gstin ?? '',
      state_code: customer.state_code ?? '', address: customer.address ?? '', customer_type: customer.customer_type ?? 'RETAIL',
      notes: customer.notes ?? '',
    });
  }, [customer]);
  const set = (k: keyof typeof EMPTY_FORM, v: any) => setForm((f) => ({ ...f, [k]: v }));

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Enter the customer name.';
    if (form.phone.replace(/\D/g, '').length < 8) e.phone = 'Enter a valid phone number.';
    if (form.whatsapp && form.whatsapp.replace(/\D/g, '').length < 8) e.whatsapp = 'Enter a valid WhatsApp number, or leave it blank.';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) e.email = 'Enter a valid email, or leave it blank.';
    const g = form.gstin.trim().toUpperCase();
    if (g && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) e.gstin = 'This is not a valid GSTIN (15 characters, e.g. 27ABCDE1234F1Z5).';
    if (g && form.state_code && g.slice(0, 2) !== form.state_code) e.state_code = `The GSTIN is registered in state ${g.slice(0, 2)} — ${stateName(g.slice(0, 2))}.`;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setBusy(true);
    const body: Record<string, unknown> = {
      name: form.name.trim(), phone: form.phone.trim(), whatsapp: form.whatsapp.trim() || null,
      company_name: form.company_name.trim() || null, email: form.email.trim() || null,
      gstin: form.gstin.trim().toUpperCase() || null, state_code: form.state_code || null, address: form.address.trim() || null,
      customer_type: form.customer_type, notes: form.notes.trim() || null,
    };
    try {
      if (isNew) {
        if (form.opening_balance) body.opening_balance = Number(form.opening_balance);
        if (can('set_credit_limit') && form.credit_allowed) { body.credit_allowed = true; body.credit_limit = Number(form.credit_limit || 0); }
        const res = await apiPost<any>('/api/customers', body);
        if (res.already_existed) toast.toast('Already a customer', { tone: 'info', message: `${res.phone} belongs to ${res.name} — opened their record instead.` });
        else toast.success('Customer added', res.name);
        onSaved(res, true);
      } else {
        await apiPut(`/api/customers/${(customer as any).customer_id}`, body);
        toast.success('Customer updated', form.name);
        onSaved(customer, false);
      }
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={customer !== null} onClose={onClose} wide title={isNew ? 'Add customer' : `Edit ${(customer as any)?.name ?? ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Add customer' : 'Save changes'}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="form-grid">
          <Field label="Name" required error={errors.name}><input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={150} autoFocus /></Field>
          <Field label="Phone" required error={errors.phone} hint={isNew ? 'One customer per phone number' : undefined}>
            <input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={20} /></Field>
          <Field label="WhatsApp number" error={errors.whatsapp} hint="Leave blank if it is the same as the phone">
            <input type="tel" value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} maxLength={20} /></Field>
          <Field label="Email" error={errors.email}><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Company / business name"><input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} maxLength={150} /></Field>
          <Field label="Customer type">
            <select value={form.customer_type} onChange={(e) => set('customer_type', e.target.value)}>
              <option value="RETAIL">Retail</option><option value="B2B_CONTRACTOR">Business / contractor</option>
            </select>
          </Field>
          <Field label="GSTIN" error={errors.gstin} hint="For GST bills to a registered business">
            <input value={form.gstin} onChange={(e) => { const g = e.target.value.toUpperCase(); set('gstin', g); if (/^\d{2}/.test(g) && !form.state_code) set('state_code', g.slice(0, 2)); }}
              maxLength={15} className="mono" /></Field>
          <Field label="State" error={errors.state_code} hint="Decides CGST + SGST or IGST on their bills">
            <StateSelect value={form.state_code} onChange={(v) => set('state_code', v)} /></Field>
          <div className="span-2"><Field label="Address"><textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={500} /></Field></div>
          <div className="span-2"><Field label="Notes"><input value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} /></Field></div>
          {isNew && mayOpening && (
            <Field label="Opening balance (₹)" hint="Money they already owe from before — posted to their account">
              <input inputMode="decimal" value={form.opening_balance} onChange={(e) => set('opening_balance', e.target.value.replace(/[^\d.-]/g, ''))} /></Field>
          )}
          {isNew && can('set_credit_limit') && (
            <div className="stack" style={{ gap: 6 }}>
              <Switch checked={form.credit_allowed} onChange={(v) => set('credit_allowed', v)} label="Allow sales on credit" />
              {form.credit_allowed && <Field label="Credit limit (₹)"><input inputMode="decimal" value={form.credit_limit} onChange={(e) => set('credit_limit', decimalOnly(e.target.value))} /></Field>}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}

function MergeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [primary, setPrimary] = useState<CustomerHit | null>(null);
  const [duplicate, setDuplicate] = useState<CustomerHit | null>(null);
  useEffect(() => { if (!open) { setPrimary(null); setDuplicate(null); } }, [open]);
  async function submit() {
    if (!primary || !duplicate) return;
    if (!window.confirm(`Merge ${duplicate.name} (${duplicate.phone}) into ${primary.name} (${primary.phone})? This cannot be undone here.`)) return;
    try {
      const res = await apiPost<any>('/api/customers/merge', { primary_customer_id: primary.customer_id, duplicate_customer_id: duplicate.customer_id });
      toast.success('Customers merged', `Combined points: ${res.merged_points_balance}.`);
      onDone();
    } catch (err) { toast.error(err); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Merge duplicate customers"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!primary || !duplicate || primary.customer_id === duplicate.customer_id} onClick={() => void submit()}>Merge</Button></>}>
      <div className="stack">
        <Alert tone="warning" title="Check carefully">
          Every bill, account entry and loyalty point moves to the record you keep. The duplicate is retired, not deleted, so the merge stays traceable.
        </Alert>
        <Field label="Keep this record"><CustomerPicker value={primary} onSelect={setPrimary} allowCreate={false} /></Field>
        <Field label="Merge and retire this one"><CustomerPicker value={duplicate} onSelect={setDuplicate} allowCreate={false} /></Field>
        {primary && duplicate && primary.customer_id === duplicate.customer_id && <Alert tone="critical">Choose two different customers.</Alert>}
      </div>
    </Modal>
  );
}
