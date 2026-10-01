// ============================================================================
// Expenses (spec §45)
//
// Money the shop spends: dated by the day it was spent, with how it was paid,
// who was paid and a bill or UTR reference. Large amounts wait for a manager's
// approval, and nobody approves their own claim. Petty cash paid from the till
// arrives here automatically from the Till screen.
// ============================================================================
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiPost, apiPut, businessToday, downloadCsv, fetcher, formatDate, formatDateTime, inr, num, withBranch,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, BranchGate, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, Pager, RequirePermission, SearchInput, StatTile, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';
import { BarsChart, DonutChart } from '../../components/charts';
import { Icon } from '../../components/icons';

export default function ExpensesPage() {
  return (
    <RequirePermission permission="view_expenses">
      <ExpensesScreen />
    </RequirePermission>
  );
}

const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque' };
const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');

function ExpensesScreen() {
  const { can, activeBranchId, user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [tab, setTab] = useState<'list' | 'summary'>('list');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(100);
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [detail, setDetail] = useState<any | null>(null);

  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set('q', search);
  if (status) params.set('status', status);
  if (category) params.set('category_id', category);
  if (method) params.set('payment_method', method);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/expenses?${params}`, activeBranchId), fetcher, { keepPreviousData: true });
  const { data: categories, mutate: mutateCategories } = useSWR<any[]>('/api/expenses/categories', fetcher);
  const { data: summary, mutate: mutateSummary } = useSWR<any>(withBranch('/api/expenses/summary?months=12', activeBranchId), fetcher);

  useEffect(() => { if (router.query.new === '1' && can('create_expense')) setEditing('new'); }, [router.query.new, can]);

  const shownTotal = (data ?? []).filter((e) => e.status !== 'REJECTED').reduce((s, e) => s + Number(e.amount), 0);
  const refresh = () => { void mutate(); void mutateSummary(); };

  async function approve(e: any) {
    try { await apiPost(`/api/expenses/${e.expense_id}/approve`, {}); toast.success('Expense approved', inr(e.amount, { decimals: true })); setDetail(null); refresh(); }
    catch (err) { toast.error(err); }
  }
  async function reject(e: any) {
    const reason = window.prompt('Reject this expense? Give the reason (shown to the person who raised it):');
    if (reason === null) return;
    try { await apiPost(`/api/expenses/${e.expense_id}/reject`, { reason: reason.trim() || undefined }); toast.success('Expense rejected'); setDetail(null); refresh(); }
    catch (err) { toast.error(err); }
  }

  // Month totals per branch become one row per month for the chart.
  const months: any[] = [];
  for (const r of summary?.by_month ?? []) {
    let m = months.find((x) => x.month === r.month);
    if (!m) { m = { month: r.month, total: 0 }; months.push(m); }
    m.total += Number(r.total);
  }

  return (
    <>
      <PageHeader title={t('navExpenses')} subtitle="What the shop spends, by the day it was spent"
        actions={can('create_expense') && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Add expense</Button>} />

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <StatTile label="Waiting for approval" value={inr(summary?.pending?.total ?? 0)} hint={`${num(summary?.pending?.count ?? 0, 0)} expense(s)`} />
        <StatTile label="Shown below (excl. rejected)" value={inr(shownTotal)} hint={`${(data ?? []).length} entries`} />
        <StatTile label="This month (approved)" value={inr(months.find((m) => m.month === businessToday().slice(0, 7))?.total ?? 0)} />
      </div>

      <Tabs active={tab} onChange={(k) => setTab(k as any)} tabs={[{ key: 'list', label: 'Expenses' }, { key: 'summary', label: 'Summary' }]} />

      {tab === 'list' && (
        <>
          <div className="table-toolbar">
            <SearchInput value={query} onChange={setQuery} placeholder="Description, paid to or reference…" />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option><option value="PENDING">Waiting for approval</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option>
            </select>
            <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {(categories ?? []).map((c: any) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
            </select>
            <select aria-label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">Any method</option>{Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
            <div className="spacer" />
            <Button onClick={() => downloadCsv((data ?? []).map((e) => ({
              date: e.expense_date, branch: e.branch_name, category: e.category_name, amount: e.amount, method: e.payment_method,
              paid_to: e.payee, reference: e.reference, description: e.description, status: e.status, raised_by: e.requested_by_name, approved_by: e.approved_by_name,
            })), 'expenses.csv')} disabled={!data?.length}><Icon name="download" size={14} /> Export</Button>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="expenses" title="No expenses" text="Nothing matches these filters." />}>
              {(rows) => (
                <>
                  <DataTable rows={rows} rowKey={(e: any) => e.expense_id} onRowClick={(e: any) => setDetail(e)}
                    columns={[
                      { key: 'd', header: 'Date', nowrap: true, render: (e: any) => formatDate(e.expense_date) },
                      { key: 'c', header: 'Category', render: (e: any) => e.category_name },
                      { key: 'p', header: 'Paid to', render: (e: any) => <div>{e.payee ?? <span className="muted">—</span>}{e.description && <div className="muted small">{e.description}</div>}</div> },
                      ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (e: any) => e.branch_name }]),
                      { key: 'm', header: 'Method', render: (e: any) => <span>{METHOD_LABEL[e.payment_method] ?? e.payment_method}{e.paid_from_till_session_id && <> <Badge tone="neutral">till</Badge></>}</span> },
                      { key: 's', header: 'Status', render: (e: any) => <StatusBadge status={e.status} /> },
                      { key: 'a', header: 'Amount', align: 'right', render: (e: any) => <b>{inr(e.amount, { decimals: true })}</b> },
                      ...(can('approve_expense') ? [{ key: 'act', header: '', render: (e: any) => (e.status === 'PENDING' && (e.created_by !== user?.user_id || user?.role === 'OWNER_ADMIN') ? (
                        <div className="row tight" onClick={(ev) => ev.stopPropagation()} style={{ flexWrap: 'nowrap' }}>
                          <Button size="sm" variant="primary" onClick={() => void approve(e)}>Approve</Button>
                          <Button size="sm" variant="ghost" onClick={() => void reject(e)}>Reject</Button>
                        </div>) : null) }] : []),
                    ]} />
                  <Pager shown={rows.length} pageSize={100} onMore={() => setLimit((l) => l + 100)} />
                </>
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'summary' && summary && (
        <div className="stack">
          <div className="grid cols-2">
            <Card title="Approved expenses by month">
              {months.length ? <BarsChart data={months} xKey="month" series={[{ key: 'total', label: 'Expenses' }]} /> : <EmptyState text="No approved expenses yet." />}
            </Card>
            <Card title="By category (last 12 months)">
              {(summary.by_category ?? []).length ? <DonutChart data={summary.by_category} nameKey="category_name" valueKey="total" /> : <EmptyState text="No approved expenses yet." />}
            </Card>
          </div>
          <Card flush title="Expenses against sales" description="Approved expenses as a share of sales, month by month and branch by branch.">
            <DataTable rows={summary.expense_vs_revenue ?? []} rowKey={(r: any) => `${r.month}:${r.branch_name}`} emptyText="No data yet."
              columns={[
                { key: 'm', header: 'Month', render: (r: any) => r.month },
                { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
                { key: 'rev', header: 'Sales', align: 'right', render: (r: any) => inr(r.revenue) },
                { key: 'exp', header: 'Expenses', align: 'right', render: (r: any) => inr(r.expenses) },
                { key: 'pct', header: 'Expenses ÷ sales', align: 'right', render: (r: any) => (r.expense_to_revenue_pct !== null ? `${num(r.expense_to_revenue_pct, 1)}%` : '—') },
              ]} />
          </Card>
        </div>
      )}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail ? `${detail.category_name} · ${inr(detail.amount, { decimals: true })}` : ''}
        footer={detail && <>
          {detail.status === 'PENDING' && can('create_expense') && (detail.created_by === user?.user_id || can('approve_expense')) && (
            <Button onClick={() => { setEditing(detail); setDetail(null); }}><Icon name="edit" size={14} /> Edit</Button>
          )}
          <span className="spacer" />
          {detail.status === 'PENDING' && can('approve_expense') && (detail.created_by !== user?.user_id || user?.role === 'OWNER_ADMIN') && <>
            <Button variant="danger" onClick={() => void reject(detail)}>Reject</Button>
            <Button variant="primary" onClick={() => void approve(detail)}>Approve</Button>
          </>}
        </>}>
        {detail && (
          <div className="stack">
            {detail.status === 'REJECTED' && <Alert tone="critical" title="Rejected">{detail.reject_reason || 'No reason given.'}</Alert>}
            {detail.status === 'PENDING' && detail.created_by === user?.user_id && user?.role !== 'OWNER_ADMIN' && (
              <Alert tone="info">You raised this expense, so someone else must approve it.</Alert>
            )}
            <KeyValue items={[
              ['Date spent', formatDate(detail.expense_date)], ['Branch', detail.branch_name], ['Category', detail.category_name],
              ['Amount', inr(detail.amount, { decimals: true })], ['Paid by', METHOD_LABEL[detail.payment_method] ?? detail.payment_method],
              ['Paid to', detail.payee || '—'], ['Reference', detail.reference || '—'], ['Description', detail.description || '—'],
              ['Receipt', detail.receipt_url ? (/^https?:\/\//.test(detail.receipt_url) ? <a href={detail.receipt_url} target="_blank" rel="noopener noreferrer">Open receipt</a> : detail.receipt_url) : '—'],
              ['Status', <StatusBadge key="s" status={detail.status} />], ['Raised by', `${detail.requested_by_name ?? '—'} · ${formatDateTime(detail.created_at)}`],
              ...(detail.approved_by_name ? [[detail.status === 'REJECTED' ? 'Rejected by' : 'Approved by', detail.approved_by_name] as [string, React.ReactNode]] : []),
              ...(detail.paid_from_till_session_id ? [['From the till', 'Paid out of the cash drawer as petty cash'] as [string, React.ReactNode]] : []),
            ]} />
          </div>
        )}
      </Modal>

      <ExpenseForm expense={editing} categories={categories ?? []} onCategoryAdded={() => void mutateCategories()}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
    </>
  );
}

const EMPTY = { expense_date: '', category_id: '', amount: '', payment_method: 'CASH', payee: '', reference: '', description: '', receipt_url: '' };

function ExpenseForm({ expense, categories, onCategoryAdded, onClose, onSaved }: {
  expense: any | null | 'new'; categories: any[]; onCategoryAdded: () => void; onClose: () => void; onSaved: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const isNew = expense === 'new';
  const [form, setForm] = useState({ ...EMPTY });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (expense === null) return;
    setErrors({});
    setForm(expense === 'new' ? { ...EMPTY, expense_date: businessToday() } : {
      expense_date: expense.expense_date ?? businessToday(), category_id: expense.category_id ?? '', amount: String(Number(expense.amount)),
      payment_method: expense.payment_method ?? 'CASH', payee: expense.payee ?? '', reference: expense.reference ?? '',
      description: expense.description ?? '', receipt_url: expense.receipt_url ?? '',
    });
  }, [expense]);
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function addCategory() {
    const name = window.prompt('New expense category:');
    if (!name || !name.trim()) return;
    try {
      const row = await apiPost<any>('/api/expenses/categories', { name: name.trim() });
      onCategoryAdded(); set('category_id', row.category_id);
      toast.success('Category added', row.name);
    } catch (err) { toast.error(err); }
  }

  async function save() {
    const e: Record<string, string> = {};
    if (!form.category_id) e.category_id = 'Choose a category.';
    if (!(Number(form.amount) > 0)) e.amount = 'Enter the amount spent.';
    if (!form.expense_date) e.expense_date = 'Enter the date the money was spent.';
    else if (form.expense_date > businessToday()) e.expense_date = 'The date cannot be in the future.';
    if (['BANK_TRANSFER', 'CHEQUE'].includes(form.payment_method) && !form.reference.trim()) {
      e.reference = form.payment_method === 'CHEQUE' ? 'Enter the cheque number.' : 'Enter the UTR / bank reference.';
    }
    setErrors(e);
    if (Object.keys(e).length) return;
    const body = {
      expense_date: form.expense_date, category_id: form.category_id, amount: Number(form.amount), payment_method: form.payment_method,
      payee: form.payee.trim() || null, reference: form.reference.trim() || null, description: form.description.trim() || null,
      receipt_url: form.receipt_url.trim() || null,
    };
    setBusy(true);
    try {
      if (isNew) {
        const res = await apiPost<any>('/api/expenses', body);
        toast.success('Expense recorded', res.status === 'PENDING' ? 'It is waiting for a manager to approve.' : 'Approved.');
      } else {
        await apiPut(`/api/expenses/${(expense as any).expense_id}`, body);
        toast.success('Expense updated');
      }
      onSaved();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={expense !== null} onClose={onClose} title={isNew ? 'Add expense' : 'Edit expense'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Save expense' : 'Save changes'}</Button></>}>
      <BranchGate what="this expense">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="form-grid">
            <Field label="Date spent" required error={errors.expense_date}>
              <input type="date" value={form.expense_date} max={businessToday()} onChange={(e) => set('expense_date', e.target.value)} />
            </Field>
            <Field label="Amount (₹)" required error={errors.amount}>
              <input inputMode="decimal" value={form.amount} onChange={(e) => set('amount', decimalOnly(e.target.value))} autoFocus />
            </Field>
            <Field label="Category" required error={errors.category_id}>
              <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)}>
                <option value="">Choose…</option>
                {categories.map((c: any) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Paid by">
              <select value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
                {Object.entries(METHOD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field label="Paid to"><input value={form.payee} onChange={(e) => set('payee', e.target.value)} maxLength={150} placeholder="Landlord, electrician, transporter…" /></Field>
            <Field label={form.payment_method === 'CHEQUE' ? 'Cheque number' : 'Bill no. / UTR'} required={['BANK_TRANSFER', 'CHEQUE'].includes(form.payment_method)} error={errors.reference}>
              <input value={form.reference} onChange={(e) => set('reference', e.target.value)} maxLength={80} />
            </Field>
            <div className="span-2"><Field label="Description"><input value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} /></Field></div>
            <div className="span-2"><Field label="Receipt link (optional)" hint="A link to the scanned bill, or its reference number">
              <input value={form.receipt_url} onChange={(e) => set('receipt_url', e.target.value)} maxLength={500} placeholder="https://…" /></Field></div>
          </div>
          {can('manage_master_data') && <div><Button size="sm" variant="ghost" onClick={() => void addCategory()}><Icon name="plus" size={13} /> New category</Button></div>}
          <p className="muted small" style={{ margin: 0 }}>Amounts above the approval limit wait for a manager. Petty cash paid out of the till is recorded from the Till screen instead.</p>
        </form>
      </BranchGate>
    </Modal>
  );
}
