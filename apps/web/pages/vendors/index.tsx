// ============================================================================
// Vendors / suppliers (spec §36–§38)
//
// Who the shop buys from, what is owed to each, bill by bill, and every payment
// as a numbered voucher with its method and bank reference. The payable is the
// vendor ledger and nothing else, so the statement, the outstanding list and
// the per-bill dues agree. Money is shown only to roles that may see it.
// ============================================================================
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiPost, apiPut, businessToday, downloadCsv, fetcher, formatDate, formatDateTime, idempotencyKey, inr, num,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, BranchGate, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatTile, Tabs, useDebounced,
} from '../../components/ui';
import { StateSelect, stateName } from '../../components/pickers';
import { Icon } from '../../components/icons';

export default function VendorsPage() {
  return (
    <RequirePermission permission="view_vendors">
      <VendorsScreen />
    </RequirePermission>
  );
}

const ENTRY_LABEL: Record<string, string> = {
  OPENING_BALANCE: 'Opening balance', GRN_PAYABLE: 'Purchase bill', PAYMENT_MADE: 'Payment', DEBIT_NOTE: 'Debit note (return)', ADJUSTMENT: 'Adjustment',
};
const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');

function VendorsScreen() {
  const router = useRouter();
  const { can } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<'all' | 'payable'>(router.query.tab === 'payable' ? 'payable' : 'all');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [status, setStatus] = useState('active');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<any | null | 'new'>(null);
  const money = can('view_financial_reports');

  const params = new URLSearchParams({ limit: '300', status });
  if (search) params.set('q', search);
  const { data, error, isLoading, mutate } = useSWR<any[]>(`/api/vendors?${params}`, fetcher, { keepPreviousData: true });
  const { data: payable, mutate: mutatePayable } = useSWR<any[]>(money ? '/api/vendors/outstanding/list' : null, fetcher);
  const totalOwed = (payable ?? []).reduce((s, r) => s + Number(r.balance_owed), 0);
  const overdue = (payable ?? []).filter((r) => r.is_overdue);

  useEffect(() => { if (router.query.new === '1' && can('edit_vendor')) setFormFor('new'); }, [router.query.new, can]);
  useEffect(() => { if (typeof router.query.vendor === 'string') setDetailId(router.query.vendor); }, [router.query.vendor]);
  const refresh = () => { void mutate(); void mutatePayable(); };

  return (
    <>
      <PageHeader title={t('navVendors')} subtitle="Suppliers, what is owed to them, and payments made"
        actions={can('edit_vendor') && <Button variant="primary" onClick={() => setFormFor('new')}><Icon name="plus" size={14} /> Add vendor</Button>} />

      {money && (
        <div className="grid cols-3" style={{ marginBottom: 14 }}>
          <StatTile label="Owed to suppliers" value={inr(totalOwed)} hint={`${(payable ?? []).length} supplier(s)`} />
          <StatTile label="Past payment terms" value={inr(overdue.reduce((s, r) => s + Number(r.balance_owed), 0))} hint={`${overdue.length} supplier(s) overdue`} />
          <StatTile label="Active suppliers" value={num((data ?? []).filter((v) => v.is_active).length, 0)} />
        </div>
      )}

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[{ key: 'all', label: 'All vendors' }, ...(money ? [{ key: 'payable', label: 'Payable', count: payable?.length || undefined }] : [])]} />

      {tab === 'all' && (
        <>
          <div className="table-toolbar">
            <SearchInput value={query} onChange={setQuery} placeholder="Name, contact, phone or GSTIN…" />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
            </select>
            <div className="spacer" />
            <Button onClick={() => downloadCsv((data ?? []).map((v) => ({
              name: v.name, contact: v.contact_person, phone: v.phone, email: v.email, gstin: v.gstin, state: v.state,
              terms_days: v.payment_terms_days, ...(money ? { balance: v.balance_owed } : {}),
            })), 'vendors.csv')} disabled={!data?.length}><Icon name="download" size={14} /> Export</Button>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="vendors" title="No vendors" text="Add the suppliers you buy from." />}>
              {(rows) => (
                <DataTable rows={rows} rowKey={(r: any) => r.vendor_id} onRowClick={(r: any) => setDetailId(r.vendor_id)}
                  columns={[
                    { key: 'n', header: 'Vendor', render: (r: any) => (
                      <div><span style={{ fontWeight: 550 }}>{r.name}</span>{!r.is_active && <> <Badge tone="neutral">inactive</Badge></>}
                        {r.contact_person && <div className="muted small">{r.contact_person}</div>}</div>) },
                    { key: 'p', header: 'Phone', nowrap: true, render: (r: any) => r.phone ?? '—' },
                    { key: 'g', header: 'GSTIN', render: (r: any) => (r.gstin ? <span className="mono small">{r.gstin}</span> : <span className="muted">—</span>) },
                    { key: 's', header: 'State', render: (r: any) => (r.state_code ? stateName(r.state_code) : '—') },
                    { key: 't', header: 'Terms', render: (r: any) => (r.payment_terms_days !== null && r.payment_terms_days !== undefined ? `${r.payment_terms_days} days` : '—') },
                    { key: 'l', header: 'Last purchase', nowrap: true, render: (r: any) => (r.last_purchase_at ? formatDate(r.last_purchase_at) : '—') },
                    ...(money ? [{ key: 'b', header: 'Owed', align: 'right' as const, render: (r: any) => (Number(r.balance_owed) > 0
                      ? <b>{inr(r.balance_owed, { decimals: true })}</b> : <span className="muted">—</span>) }] : []),
                  ]} />
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'payable' && money && (
        <Card flush title="What is owed to each supplier" description="Overdue when the oldest unpaid bill is older than the supplier's payment terms.">
          <AsyncSection data={payable} isLoading={!payable}
            empty={<EmptyState icon="check" title="Nothing payable" text="Every supplier bill is paid." />}>
            {(rows) => (
              <DataTable rows={rows} rowKey={(r: any) => r.vendor_id} onRowClick={(r: any) => setDetailId(r.vendor_id)}
                columns={[
                  { key: 'n', header: 'Vendor', render: (r: any) => <div>{r.name}<div className="muted small">{r.phone}</div></div> },
                  { key: 't', header: 'Terms', render: (r: any) => (r.payment_terms_days !== null ? `${r.payment_terms_days} days` : '—') },
                  { key: 'o', header: 'Oldest unpaid bill', render: (r: any) => (r.oldest_bill_days !== null
                    ? <Badge tone={r.is_overdue ? 'critical' : 'neutral'}>{r.oldest_bill_days} days{r.is_overdue ? ' · overdue' : ''}</Badge> : '—') },
                  { key: 'b', header: 'Owed', align: 'right', render: (r: any) => <b>{inr(r.balance_owed, { decimals: true })}</b> },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      <VendorDetail id={detailId} onClose={() => { setDetailId(null); if (router.query.vendor) void router.replace('/vendors', undefined, { shallow: true }); }}
        onEdit={(v) => setFormFor(v)} onChanged={refresh} />
      <VendorForm vendor={formFor} onClose={() => setFormFor(null)}
        onSaved={(v, isNew) => { setFormFor(null); refresh(); if (isNew && v?.vendor_id) setDetailId(v.vendor_id); }} />
    </>
  );
}

function VendorDetail({ id, onClose, onEdit, onChanged }: { id: string | null; onClose: () => void; onEdit: (v: any) => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const money = can('view_financial_reports');
  const [inner, setInner] = useState<'bills' | 'payments' | 'statement' | 'returns' | 'products'>('bills');
  const [pay, setPay] = useState<{ grn?: any } | null>(null);
  const { data: v, error, mutate } = useSWR<any>(id ? `/api/vendors/${id}` : null, fetcher);
  useEffect(() => setInner('bills'), [id]);

  async function toggleActive() {
    if (!v) return;
    if (v.is_active && !window.confirm(`Mark ${v.name} inactive? They will not be offered for new purchases. History and balance are kept.`)) return;
    try { await apiPut(`/api/vendors/${v.vendor_id}`, { is_active: !v.is_active }); toast.success(v.is_active ? 'Vendor marked inactive' : 'Vendor re-activated'); void mutate(); onChanged(); }
    catch (err) { toast.error(err); }
  }

  return (
    <Modal open={Boolean(id)} onClose={onClose} wide title={v?.name ?? 'Vendor'}
      footer={v && <>
        {can('edit_vendor') && <Button variant="ghost" onClick={() => void toggleActive()}>{v.is_active ? 'Mark inactive' : 'Re-activate'}</Button>}
        <span className="spacer" />
        {can('edit_vendor') && <Button onClick={() => onEdit(v)}><Icon name="edit" size={14} /> Edit</Button>}
        {can('record_vendor_payment') && <Button variant="primary" disabled={!(Number(v.balance_owed) > 0)} onClick={() => setPay({})}>Record payment</Button>}
      </>}>
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {!v && !error && <div className="muted">Loading…</div>}
      {v && (
        <div className="stack">
          {!v.is_active && <Alert tone="warning">This vendor is marked inactive.</Alert>}
          <div className="grid cols-2">
            <KeyValue items={[
              ['Contact', v.contact_person || '—'], ['Phone', v.phone || '—'], ['Email', v.email || '—'],
              ['Address', v.address || '—'],
            ]} />
            <KeyValue items={[
              ['GSTIN', v.gstin || 'Unregistered'], ['State', v.state_code ? `${v.state_code} ${stateName(v.state_code)}` : '—'],
              ['Payment terms', v.payment_terms_days !== null && v.payment_terms_days !== undefined ? `${v.payment_terms_days} days` : '—'],
              ...(money ? [['Bank', [v.bank_name, v.bank_account_no, v.bank_ifsc].filter(Boolean).join(' · ') || '—'] as [string, React.ReactNode],
                ['UPI', v.upi_id || '—'] as [string, React.ReactNode]] : []),
            ]} />
          </div>
          {money && (
            <div className="grid cols-3">
              <StatTile label="Owed now" value={inr(v.balance_owed, { decimals: true })} />
              <StatTile label="Bills with a balance" value={num((v.grns ?? []).filter((g: any) => Number(g.amount_due) > 0).length, 0)} />
              <StatTile label="Paid (last 100 vouchers)" value={inr((v.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0))} />
            </div>
          )}
          <Tabs active={inner} onChange={(k) => setInner(k as any)}
            tabs={[
              { key: 'bills', label: 'Purchase bills', count: v.grns?.length || undefined },
              ...(money ? [{ key: 'payments', label: 'Payments', count: v.payments?.length || undefined }, { key: 'statement', label: 'Statement' }] : []),
              { key: 'returns', label: 'Debit notes', count: v.returns?.length || undefined },
              { key: 'products', label: 'Items supplied', count: v.products?.length || undefined },
            ]} />
          {inner === 'bills' && (
            <DataTable rows={v.grns ?? []} emptyText="No purchases from this vendor yet." rowKey={(g: any) => g.grn_id}
              columns={[
                { key: 'n', header: 'GRN', nowrap: true, render: (g: any) => <span className="mono">{g.grn_number}</span> },
                { key: 'b', header: 'Supplier bill', render: (g: any) => (g.vendor_invoice_no ? `${g.vendor_invoice_no}${g.vendor_invoice_date ? ` · ${formatDate(g.vendor_invoice_date)}` : ''}` : '—') },
                { key: 'd', header: 'Received', nowrap: true, render: (g: any) => formatDate(g.received_at) },
                { key: 'br', header: 'Branch', render: (g: any) => g.branch_name },
                ...(g0(v.grns) ? [
                  { key: 't', header: 'Bill total', align: 'right' as const, render: (g: any) => inr(g.grand_total, { decimals: true }) },
                  { key: 'due', header: 'Due', align: 'right' as const, render: (g: any) => (Number(g.amount_due) > 0
                    ? <Badge tone={g.payment_status === 'PARTIALLY_PAID' ? 'info' : 'warning'}>{inr(g.amount_due, { decimals: true })}</Badge>
                    : <Badge tone="good">paid</Badge>) },
                  ...(can('record_vendor_payment') ? [{ key: 'pay', header: '', render: (g: any) => (Number(g.amount_due) > 0
                    ? <Button size="sm" onClick={(e) => { e.stopPropagation(); setPay({ grn: g }); }}>Pay</Button> : null) }] : []),
                ] : []),
              ]} />
          )}
          {inner === 'payments' && (
            <DataTable rows={v.payments ?? []} emptyText="No payments recorded." rowKey={(p: any) => p.payment_id}
              columns={[
                { key: 'n', header: 'Voucher', nowrap: true, render: (p: any) => <span className="mono">{p.payment_number}</span> },
                { key: 'd', header: 'Paid on', nowrap: true, render: (p: any) => formatDate(p.paid_on ?? p.created_at) },
                { key: 'm', header: 'Method', render: (p: any) => `${String(p.method).replace('_', ' ').toLowerCase()}${p.reference ? ` · ${p.reference}` : ''}` },
                { key: 'g', header: 'Against bill', render: (p: any) => (p.grn_number ? `${p.grn_number}${p.vendor_invoice_no ? ` (${p.vendor_invoice_no})` : ''}` : 'On account') },
                { key: 'u', header: 'By', render: (p: any) => p.paid_by ?? '—' },
                { key: 'a', header: 'Amount', align: 'right', render: (p: any) => inr(p.amount, { decimals: true }) },
              ]} />
          )}
          {inner === 'statement' && <VendorStatement vendorId={v.vendor_id} name={v.name} />}
          {inner === 'returns' && (
            <DataTable rows={v.returns ?? []} emptyText="No goods returned to this vendor." rowKey={(r: any) => r.debit_note_id}
              columns={[
                { key: 'n', header: 'Debit note', nowrap: true, render: (r: any) => <span className="mono">{r.debit_note_number}</span> },
                { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDate(r.created_at) },
                { key: 'g', header: 'Against', render: (r: any) => r.grn_number },
                { key: 'r', header: 'Reason', render: (r: any) => r.reason },
                ...(money ? [{ key: 'a', header: 'Value', align: 'right' as const, render: (r: any) => inr(r.total_amount, { decimals: true }) }] : []),
              ]} />
          )}
          {inner === 'products' && (
            <DataTable rows={v.products ?? []} emptyText="No items recorded from this vendor yet." rowKey={(p: any) => p.product_id}
              columns={[
                { key: 'p', header: 'Item', render: (p: any) => <div>{p.product_name}<div className="muted small mono">{p.sku}</div></div> },
                { key: 's', header: 'Their code', render: (p: any) => p.vendor_sku ?? '—' },
                { key: 'pref', header: 'Usual supplier', render: (p: any) => (p.is_preferred ? <Badge tone="good">yes</Badge> : '—') },
                ...(v.products?.[0]?.last_purchase_rate !== undefined ? [{ key: 'r', header: 'Last cost (ex-GST)', align: 'right' as const,
                  render: (p: any) => (p.last_purchase_rate !== null ? inr(p.last_purchase_rate, { decimals: true }) : '—') }] : []),
              ]} />
          )}
        </div>
      )}
      {v && pay && <VendorPaymentModal vendor={v} grn={pay.grn} onClose={() => setPay(null)} onDone={() => { setPay(null); void mutate(); onChanged(); }} />}
    </Modal>
  );
}
const g0 = (grns: any[] | undefined) => Boolean(grns?.length && grns[0].grand_total !== undefined);

function VendorStatement({ vendorId, name }: { vendorId: string; name: string }) {
  const today = businessToday();
  const [from, setFrom] = useState(() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 90); return d.toISOString().slice(0, 10); });
  const [to, setTo] = useState(today);
  const { data, error } = useSWR<any>(`/api/vendors/${vendorId}/statement?from=${from}&to=${to}`, fetcher, { keepPreviousData: true });
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
            date: formatDate(e.created_at), entry: ENTRY_LABEL[e.entry_type] ?? e.entry_type, reference: e.reference ?? '',
            payment: e.payment_method ? `${e.payment_method}${e.payment_reference ? ` ${e.payment_reference}` : ''}` : '',
            bill_amount: Number(e.amount) > 0 ? e.amount : '', paid_or_returned: Number(e.amount) < 0 ? -e.amount : '', balance: e.balance_after,
          })),
          { date: data.to, entry: 'Closing balance', reference: '', debit: '', credit: '', balance: data.closing_balance },
        ], `vendor-statement-${name.replace(/\W+/g, '-')}-${from}-to-${to}.csv`)}><Icon name="download" size={13} /> CSV</Button>
      </div>
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {data && (
        <>
          <div className="grid cols-4">
            <StatTile label={`Opening (${formatDate(data.from)})`} value={inr(data.opening_balance, { decimals: true })} />
            <StatTile label="Purchases" value={inr(data.purchases, { decimals: true })} />
            <StatTile label="Paid + returned" value={inr(Number(data.payments) + Number(data.debit_notes), { decimals: true })} />
            <StatTile label={`Closing (${formatDate(data.to)})`} value={inr(data.closing_balance, { decimals: true })} />
          </div>
          <DataTable rows={data.entries} emptyText="No activity in this period." rowKey={(e: any) => e.entry_id}
            columns={[
              { key: 'd', header: 'Date', nowrap: true, render: (e: any) => formatDateTime(e.created_at) },
              { key: 't', header: 'Entry', render: (e: any) => ENTRY_LABEL[e.entry_type] ?? e.entry_type },
              { key: 'r', header: 'Document', render: (e: any) => (e.reference ? <span className="mono small">{e.reference}</span> : '—') },
              { key: 'p', header: 'Paid by', render: (e: any) => (e.payment_method ? `${String(e.payment_method).replace('_', ' ').toLowerCase()}${e.payment_reference ? ` · ${e.payment_reference}` : ''}` : '') },
              { key: 'dr', header: 'Bill', align: 'right', render: (e: any) => (Number(e.amount) > 0 ? inr(e.amount, { decimals: true }) : '') },
              { key: 'cr', header: 'Paid / returned', align: 'right', render: (e: any) => (Number(e.amount) < 0 ? inr(-e.amount, { decimals: true }) : '') },
              { key: 'b', header: 'Balance', align: 'right', render: (e: any) => <b>{inr(e.balance_after, { decimals: true })}</b> },
            ]} />
        </>
      )}
    </div>
  );
}

function VendorPaymentModal({ vendor, grn, onClose, onDone }: { vendor: any; grn?: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const openBills = (vendor.grns ?? []).filter((g: any) => Number(g.amount_due) > 0);
  const [grnId, setGrnId] = useState<string>(grn?.grn_id ?? '');
  const selected = openBills.find((g: any) => g.grn_id === grnId);
  const [amount, setAmount] = useState(String(Number(grn?.amount_due ?? vendor.balance_owed ?? 0).toFixed(2)));
  const [method, setMethod] = useState('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(businessToday());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(idempotencyKey());
  const max = selected ? Number(selected.amount_due) : Number(vendor.balance_owed);

  async function submit() {
    const value = Number(amount || 0);
    if (!(value > 0)) { toast.error(new Error('Enter the amount paid.')); return; }
    if (value > max + 0.005) { toast.error(new Error(`At most ${inr(max, { decimals: true })} is due${selected ? ` on ${selected.grn_number}` : ''}.`)); return; }
    if (['BANK_TRANSFER', 'CHEQUE'].includes(method) && !reference.trim()) {
      toast.error(new Error(method === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the bank transfer reference (UTR).')); return;
    }
    setBusy(true);
    try {
      const res = await apiPost<any>(`/api/vendors/${vendor.vendor_id}/payments`, {
        amount: value, method, reference: reference.trim() || undefined, grn_id: grnId || undefined,
        paid_on: paidOn, notes: notes.trim() || undefined, client_txn_id: key.current,
      });
      toast.success(`Payment ${res.payment_number} recorded`, `Still owed to ${vendor.name}: ${inr(res.balance_after, { decimals: true })}`);
      onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Pay ${vendor.name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Record payment</Button></>}>
      <BranchGate what="this payment">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="muted small">Owed in total: <b>{inr(vendor.balance_owed, { decimals: true })}</b></div>
          <Field label="Against bill" hint="Choose a bill to settle it, or pay on account">
            <select value={grnId} onChange={(e) => { setGrnId(e.target.value); const g = openBills.find((x: any) => x.grn_id === e.target.value); setAmount(String(Number(g?.amount_due ?? vendor.balance_owed).toFixed(2))); }}>
              <option value="">On account (not against a specific bill)</option>
              {openBills.map((g: any) => <option key={g.grn_id} value={g.grn_id}>{g.grn_number}{g.vendor_invoice_no ? ` · bill ${g.vendor_invoice_no}` : ''} — {inr(g.amount_due, { decimals: true })} due</option>)}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Amount (₹)" required><input inputMode="decimal" value={amount} onChange={(e) => setAmount(decimalOnly(e.target.value))} /></Field>
            <Field label="Paid on"><input type="date" value={paidOn} max={businessToday()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
            <Field label="Method">
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CHEQUE">Cheque</option>
                <option value="CASH">Cash</option><option value="CARD">Card</option>
              </select>
            </Field>
            <Field label={method === 'CHEQUE' ? 'Cheque number' : method === 'BANK_TRANSFER' ? 'UTR / reference' : 'Reference (optional)'}
              required={['BANK_TRANSFER', 'CHEQUE'].includes(method)}>
              <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
            </Field>
            <div className="span-2"><Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field></div>
          </div>
        </form>
      </BranchGate>
    </Modal>
  );
}

const EMPTY = { name: '', contact_person: '', phone: '', email: '', gstin: '', state_code: '', address: '', payment_terms_days: '',
  bank_name: '', bank_account_no: '', bank_ifsc: '', upi_id: '', notes: '', opening_balance: '' };

function VendorForm({ vendor, onClose, onSaved }: { vendor: any | null | 'new'; onClose: () => void; onSaved: (v: any, isNew: boolean) => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const isNew = vendor === 'new';
  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (vendor === null) return;
    setErrors({});
    setForm(vendor === 'new' ? { ...EMPTY } : Object.fromEntries(Object.keys(EMPTY).map((k) => [k, vendor[k] === null || vendor[k] === undefined ? '' : String(vendor[k])])) as typeof EMPTY);
  }, [vendor]);
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Enter the vendor name.';
    if (form.phone && form.phone.replace(/\D/g, '').length < 8) e.phone = 'Enter a valid phone number.';
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) e.email = 'Enter a valid email.';
    const g = form.gstin.trim().toUpperCase();
    if (g && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) e.gstin = 'This is not a valid GSTIN.';
    if (g && form.state_code && g.slice(0, 2) !== form.state_code) e.state_code = `The GSTIN is registered in ${stateName(g.slice(0, 2))}.`;
    if (form.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(form.bank_ifsc)) e.bank_ifsc = 'An IFSC is 11 characters, e.g. HDFC0001234.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(form)) if (k !== 'opening_balance') body[k] = v.trim() === '' ? null : v.trim();
    body.gstin = g || null;
    body.payment_terms_days = form.payment_terms_days === '' ? null : Number(form.payment_terms_days);
    setBusy(true);
    try {
      if (isNew) {
        if (form.opening_balance) body.opening_balance = Number(form.opening_balance);
        const res = await apiPost<any>('/api/vendors', body);
        toast.success('Vendor added', res.name); onSaved(res, true);
      } else {
        await apiPut(`/api/vendors/${(vendor as any).vendor_id}`, body);
        toast.success('Vendor updated', form.name); onSaved(vendor, false);
      }
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={vendor !== null} onClose={onClose} wide title={isNew ? 'Add vendor' : `Edit ${(vendor as any)?.name ?? ''}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Add vendor' : 'Save changes'}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="form-grid">
          <Field label="Vendor name" required error={errors.name}><input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus maxLength={150} /></Field>
          <Field label="Contact person"><input value={form.contact_person} onChange={(e) => set('contact_person', e.target.value)} maxLength={120} /></Field>
          <Field label="Phone" error={errors.phone}><input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={20} /></Field>
          <Field label="Email" error={errors.email}><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="GSTIN" error={errors.gstin}><input className="mono" value={form.gstin} maxLength={15}
            onChange={(e) => { const v = e.target.value.toUpperCase(); set('gstin', v); if (/^\d{2}/.test(v) && !form.state_code) set('state_code', v.slice(0, 2)); }} /></Field>
          <Field label="State" error={errors.state_code} hint="Decides CGST + SGST or IGST on their bills"><StateSelect value={form.state_code} onChange={(v) => set('state_code', v)} /></Field>
          <div className="span-2"><Field label="Address"><textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={500} /></Field></div>
          <Field label="Payment terms (days)" hint="Bills older than this count as overdue">
            <input inputMode="numeric" value={form.payment_terms_days} onChange={(e) => set('payment_terms_days', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="UPI ID"><input value={form.upi_id} onChange={(e) => set('upi_id', e.target.value)} maxLength={80} /></Field>
          <Field label="Bank name"><input value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} maxLength={120} /></Field>
          <Field label="Account number"><input value={form.bank_account_no} onChange={(e) => set('bank_account_no', e.target.value.replace(/\s/g, ''))} maxLength={30} /></Field>
          <Field label="IFSC" error={errors.bank_ifsc}><input className="mono" value={form.bank_ifsc} onChange={(e) => set('bank_ifsc', e.target.value.toUpperCase())} maxLength={11} /></Field>
          <Field label="Notes"><input value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} /></Field>
          {isNew && ['OWNER_ADMIN', 'ACCOUNTANT', 'BRANCH_MANAGER'].includes(user?.role ?? '') && (
            <Field label="Opening balance owed to them (₹)" hint="From before you started using this system">
              <input inputMode="decimal" value={form.opening_balance} onChange={(e) => set('opening_balance', e.target.value.replace(/[^\d.-]/g, ''))} /></Field>
          )}
        </div>
      </form>
    </Modal>
  );
}
