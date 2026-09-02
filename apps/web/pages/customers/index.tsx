// Section 6 — Customers & Credit Ledger. Identity is chain-wide (Section 0).
import { useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiGet, apiPost, apiPut, downloadCsv, fetcher, formatDate, formatDateTime, inr, num,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatTile, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';

export default function CustomersPage() {
  return (
    <RequirePermission permission="view_customers">
      <CustomersScreen />
    </RequirePermission>
  );
}

function CustomersScreen() {
  const router = useRouter();
  const { can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | 'outstanding' | 'loyalty'>(
    router.query.tab === 'outstanding' ? 'outstanding' : 'all');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [detail, setDetail] = useState<any | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<any[]>(
    `/api/customers?limit=200${search ? `&q=${encodeURIComponent(search)}` : ''}`, fetcher);
  const { data: outstanding, mutate: mutateOutstanding } = useSWR<any[]>(
    '/api/customers/outstanding/list?limit=200', fetcher);

  const totalDue = (outstanding ?? []).reduce((s, r) => s + Number(r.balance_owed), 0);

  async function openDetail(row: any) {
    try { setDetail(await apiGet(`/api/customers/${row.customer_id}`)); }
    catch (err) { toast.error(err); }
  }

  return (
    <>
      <PageHeader title={t('navCustomers')}
        subtitle="One record per person across every branch, deduplicated on phone number"
        actions={<>
          {can('merge_customers') && <Button onClick={() => setMergeOpen(true)}>Merge duplicates</Button>}
          {can('edit_customer') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ {t('customer')}</Button>}
        </>} />

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <StatTile label="Customers" value={num(data?.length ?? 0, 0)} />
        <StatTile label={t('outstanding')} value={inr(totalDue)}
          hint={`${(outstanding ?? []).length} with a balance`} />
        <StatTile label="Over 90 days" value={inr((outstanding ?? [])
          .filter((r) => r.ageing_bucket === '90+').reduce((s, r) => s + Number(r.balance_owed), 0))}
          hint="Needs chasing" />
      </div>

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'all', label: 'All customers' },
          { key: 'outstanding', label: t('outstanding'), count: outstanding?.length },
        ]} />

      {tab === 'all' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Name or phone…" />
            <div className="spacer" />
            <Button onClick={() => downloadCsv(data ?? [], 'customers.csv')} disabled={!data?.length}>Export</Button>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="👥" title="No customers yet" />}>
              {(rows) => (
                <DataTable rows={rows} onRowClick={(r) => void openDetail(r)} footer={`${rows.length} customer(s)`}
                  columns={[
                    { key: 'name', header: t('name'), render: (r: any) => (
                      <div>{r.name}<div className="muted small">{r.phone}</div></div>
                    ) },
                    { key: 'type', header: 'Type', render: (r: any) => (
                      <Badge tone={r.customer_type === 'B2B_CONTRACTOR' ? 'info' : 'neutral'}>
                        {r.customer_type === 'B2B_CONTRACTOR' ? 'Contractor' : 'Retail'}
                      </Badge>
                    ) },
                    { key: 'credit', header: t('creditLimit'), align: 'right', render: (r: any) =>
                      r.credit_allowed ? inr(r.credit_limit) : <span className="muted">no credit</span> },
                    { key: 'bal', header: t('balance'), align: 'right', render: (r: any) =>
                      Number(r.balance_owed) > 0
                        ? <span style={{ color: 'var(--status-critical)', fontWeight: 600 }}>{inr(r.balance_owed)}</span>
                        : <span className="muted">—</span> },
                    { key: 'pts', header: t('points'), align: 'right', render: (r: any) => num(r.loyalty_points_balance, 0) },
                    { key: 'since', header: 'Customer since', nowrap: true, render: (r: any) => formatDate(r.created_at) },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'outstanding' && (
        <Card flush title="Outstanding balances by age"
          right={<Button size="sm" onClick={async () => {
            try {
              const res = await apiPost<any>('/api/customers/outstanding/send-reminders', { min_days_outstanding: 15 });
              toast.success(`${res.queued} reminder(s) queued`, 'They will go out over WhatsApp.');
            } catch (err) { toast.error(err); }
          }}>Send reminders</Button>}>
          <AsyncSection data={outstanding}
            empty={<EmptyState icon="✓" title="Nothing outstanding" text="No customer is carrying a balance." />}>
            {(rows) => (
              <DataTable rows={rows} onRowClick={(r) => void openDetail(r)}
                columns={[
                  { key: 'n', header: t('customer'), render: (r: any) => (
                    <div>{r.name}<div className="muted small">{r.phone}</div></div>
                  ) },
                  { key: 'age', header: 'Oldest unpaid', render: (r: any) => (
                    <Badge tone={r.ageing_bucket === '90+' ? 'critical'
                      : r.ageing_bucket === '61-90' ? 'warning' : 'neutral'}>
                      {r.ageing_bucket} days
                    </Badge>
                  ) },
                  { key: 'lim', header: t('creditLimit'), align: 'right', render: (r: any) => inr(r.credit_limit) },
                  { key: 'bal', header: t('balance'), align: 'right', render: (r: any) => (
                    <b>{inr(r.balance_owed)}</b>
                  ) },
                  { key: 'over', header: '', render: (r: any) =>
                    Number(r.balance_owed) > Number(r.credit_limit)
                      ? <Badge tone="critical">over limit</Badge> : null },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      <CustomerDetail customer={detail} onClose={() => setDetail(null)}
        onChanged={() => { void mutate(); void mutateOutstanding(); }} />
      <NewCustomerModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />
      <MergeModal open={mergeOpen} onClose={() => setMergeOpen(false)}
        onDone={() => { setMergeOpen(false); void mutate(); }} />
    </>
  );
}

function CustomerDetail({ customer, onClose, onChanged }: {
  customer: any | null; onClose: () => void; onChanged: () => void;
}) {
  const { can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [payment, setPayment] = useState('');
  const [creditAllowed, setCreditAllowed] = useState(false);
  const [creditLimit, setCreditLimit] = useState('');
  const [busy, setBusy] = useState(false);

  const [current, setCurrent] = useState<any | null>(null);
  const shown = current ?? customer;

  async function reload() {
    if (!customer) return;
    try { setCurrent(await apiGet(`/api/customers/${customer.customer_id}`)); } catch { /* keep what we have */ }
    onChanged();
  }

  async function recordPayment() {
    if (!shown) return;
    setBusy(true);
    try {
      await apiPost(`/api/customers/${shown.customer_id}/payments`, { amount: Number(payment) });
      toast.success('Payment recorded');
      setPayment(''); await reload();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function saveCredit() {
    if (!shown) return;
    setBusy(true);
    try {
      await apiPut(`/api/customers/${shown.customer_id}/credit`,
        { credit_allowed: creditAllowed, credit_limit: Number(creditLimit || 0) });
      toast.success('Credit terms updated');
      await reload();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={Boolean(customer)} onClose={() => { setCurrent(null); onClose(); }} wide
      title={shown?.name ?? ''}>
      {shown && (
        <div className="stack">
          <div className="grid cols-3">
            <StatTile label={t('balance')} value={inr(shown.balance_owed)} />
            <StatTile label="Credit available" value={shown.credit_allowed ? inr(shown.credit_available) : '—'} />
            <StatTile label={t('points')} value={num(shown.loyalty_points_balance, 0)} />
          </div>

          <KeyValue items={[
            [t('phone'), shown.phone],
            ['Email', shown.email],
            ['Type', shown.customer_type === 'B2B_CONTRACTOR' ? 'Contractor / B2B' : 'Retail'],
            ['GSTIN', shown.gstin],
            ['Date of birth', shown.dob ? formatDate(shown.dob) : null],
            ['Lifetime value', inr(shown.lifetime_value)],
          ]} />

          {can('record_customer_payment') && Number(shown.balance_owed) > 0 && (
            <Card title={t('recordPayment')}>
              <div className="row">
                <Field label="Amount received">
                  <input type="number" min={0.01} step="any" value={payment}
                    onChange={(e) => setPayment(e.target.value)} placeholder={String(shown.balance_owed)} />
                </Field>
                <Button variant="primary" busy={busy} disabled={!payment}
                  onClick={() => void recordPayment()} style={{ alignSelf: 'flex-end' }}>Record</Button>
              </div>
            </Card>
          )}

          {can('set_credit_limit') && (
            <Card title="Credit terms" description="Only the owner can set a credit limit.">
              <div className="row">
                <label className="checkbox">
                  <input type="checkbox" checked={creditAllowed || shown.credit_allowed}
                    onChange={(e) => setCreditAllowed(e.target.checked)} />
                  Allow buying on credit
                </label>
                <Field label="Limit">
                  <input type="number" min={0} value={creditLimit || shown.credit_limit}
                    onChange={(e) => setCreditLimit(e.target.value)} />
                </Field>
                <Button busy={busy} onClick={() => void saveCredit()} style={{ alignSelf: 'flex-end' }}>Save</Button>
              </div>
            </Card>
          )}

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Purchase history (all branches)</div>
            <DataTable rows={(shown.invoices ?? []).slice(0, 20)} emptyText="No purchases yet."
              columns={[
                { key: 'n', header: 'Invoice', render: (i: any) => <span className="mono">{i.invoice_number}</span> },
                { key: 'b', header: 'Branch', render: (i: any) => i.branch_name },
                { key: 's', header: 'Status', render: (i: any) => <StatusBadge status={i.status} /> },
                { key: 'd', header: 'Date', nowrap: true, render: (i: any) => formatDate(i.server_received_at) },
                { key: 't', header: 'Amount', align: 'right', render: (i: any) => inr(i.grand_total, { decimals: true }) },
              ]} />
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}>Credit ledger</div>
            <DataTable rows={(shown.ledger ?? []).slice(0, 20)} emptyText="No credit activity."
              columns={[
                { key: 'd', header: 'When', nowrap: true, render: (l: any) => formatDateTime(l.created_at) },
                { key: 't', header: 'Entry', render: (l: any) => (
                  <Badge tone={l.entry_type === 'PAYMENT_RECEIVED' ? 'good' : 'neutral'}>
                    {l.entry_type.replace(/_/g, ' ').toLowerCase()}
                  </Badge>
                ) },
                { key: 'b', header: 'Branch', render: (l: any) => l.branch_name ?? <span className="muted">—</span> },
                { key: 'a', header: 'Amount', align: 'right', render: (l: any) => (
                  <span style={{ color: Number(l.amount) < 0 ? 'var(--status-good)' : undefined }}>
                    {inr(l.amount, { decimals: true })}
                  </span>
                ) },
                { key: 'bal', header: 'Balance after', align: 'right', render: (l: any) => inr(l.balance_after, { decimals: true }) },
              ]} />
          </div>

          {can('export_customer_pii') && (
            <div className="row">
              <Button size="sm" onClick={async () => {
                try {
                  const data = await apiGet(`/api/customers/${shown.customer_id}/export`);
                  downloadCsv([data.customer], `customer-${shown.phone}.csv`);
                  toast.success('Exported', 'This export has been recorded in the audit log.');
                } catch (err) { toast.error(err); }
              }}>Export personal data</Button>
              <span className="muted small">Admin-only, and the export is logged.</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function NewCustomerModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ phone: '', name: '', email: '', dob: '', gstin: '', customer_type: 'RETAIL' });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/customers', {
        ...form, email: form.email || undefined, dob: form.dob || undefined, gstin: form.gstin || undefined,
      });
      if (res.already_existed) {
        toast.toast('That phone number is already registered', {
          tone: 'info',
          message: `Using the existing record for ${res.name} — one customer, one record, chain-wide.`,
        });
      } else {
        toast.success('Customer added');
      }
      setForm({ phone: '', name: '', email: '', dob: '', gstin: '', customer_type: 'RETAIL' });
      onCreated();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a customer"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} disabled={!form.phone || !form.name}
          onClick={() => void submit()}>Add</Button></>}>
      <div className="stack">
        <Alert tone="info">
          Phone number is the identity. If this person already shops at another branch, their existing
          record — with its ledger, points and history — is used instead of creating a second one.
        </Alert>
        <div className="grid cols-2">
          <Field label="Phone" required><input type="tel" required value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Name" required><input required value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2">
          <Field label="Email"><input type="email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Date of birth" hint="Used for birthday greetings">
            <input type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2">
          <Field label="Type">
            <select value={form.customer_type} onChange={(e) => setForm({ ...form, customer_type: e.target.value })}>
              <option value="RETAIL">Retail</option>
              <option value="B2B_CONTRACTOR">Contractor / B2B</option>
            </select>
          </Field>
          <Field label="GSTIN" hint="For B2B invoices"><input value={form.gstin}
            onChange={(e) => setForm({ ...form, gstin: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function MergeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [primary, setPrimary] = useState('');
  const [duplicate, setDuplicate] = useState('');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const { data } = useSWR<any[]>(open ? `/api/customers?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}` : null, fetcher);

  async function submit() {
    try {
      const res = await apiPost<any>('/api/customers/merge',
        { primary_customer_id: primary, duplicate_customer_id: duplicate });
      toast.success('Customers merged', `Combined points balance: ${res.merged_points_balance}.`);
      setPrimary(''); setDuplicate(''); onDone();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Merge duplicate customers"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!primary || !duplicate || primary === duplicate}
          onClick={() => void submit()}>Merge</Button></>}>
      <div className="stack">
        <Alert tone="warning" title="This cannot be undone from here">
          Every invoice, ledger entry and loyalty point moves to the record you keep. The duplicate is
          retired rather than deleted, so the merge stays traceable.
        </Alert>
        <SearchInput value={query} onChange={setQuery} placeholder="Search customers…" />
        <Field label="Keep this record">
          <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
            <option value="">Choose…</option>
            {(data ?? []).map((c: any) => (
              <option key={c.customer_id} value={c.customer_id}>{c.name} — {c.phone}</option>
            ))}
          </select>
        </Field>
        <Field label="Merge and retire this one">
          <select value={duplicate} onChange={(e) => setDuplicate(e.target.value)}>
            <option value="">Choose…</option>
            {(data ?? []).filter((c: any) => c.customer_id !== primary).map((c: any) => (
              <option key={c.customer_id} value={c.customer_id}>{c.name} — {c.phone}</option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
