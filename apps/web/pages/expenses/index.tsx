// Section 9 — Expenses.
import { useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import { apiPost, downloadCsv, fetcher, formatDate, inr, num, withBranch } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, Modal,
  PageHeader, RequirePermission, StatTile, StatusBadge, Tabs,
} from '../../components/ui';
import { BarsChart, DonutChart, ChartLegend, TrendChart } from '../../components/charts';

export default function ExpensesPage() {
  return (
    <RequirePermission permission="view_expenses">
      <ExpensesScreen />
    </RequirePermission>
  );
}

function ExpensesScreen() {
  const router = useRouter();
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'list' | 'analysis'>('list');
  const [status, setStatus] = useState<string>(typeof router.query.status === 'string' ? router.query.status : '');
  const [newOpen, setNewOpen] = useState(false);
  const [rejecting, setRejecting] = useState<any | null>(null);
  const [reason, setReason] = useState('');

  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch(`/api/expenses?limit=300${status ? `&status=${status}` : ''}`, activeBranchId), fetcher);
  const { data: summary } = useSWR<any>(
    tab === 'analysis' ? withBranch('/api/expenses/summary?months=12', activeBranchId) : null, fetcher);

  const pending = (data ?? []).filter((e) => e.status === 'PENDING');
  const approvedTotal = (data ?? []).filter((e) => e.status === 'APPROVED')
    .reduce((s, e) => s + Number(e.amount), 0);

  async function decide(expense: any, action: 'approve' | 'reject', why?: string) {
    try {
      await apiPost(`/api/expenses/${expense.expense_id}/${action}`, why ? { reason: why } : {});
      toast.success(action === 'approve' ? 'Expense approved' : 'Expense rejected');
      setRejecting(null); setReason(''); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <PageHeader title={t('navExpenses')} subtitle="Branch spending, approvals and the expense-to-revenue ratio"
        actions={<>
          <Button onClick={() => downloadCsv(data ?? [], 'expenses.csv')} disabled={!data?.length}>Export</Button>
          {can('create_expense') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ Expense</Button>}
        </>} />

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <StatTile label="Approved spend (shown period)" value={inr(approvedTotal)} />
        <StatTile label="Awaiting approval" value={num(pending.length, 0)}
          hint={pending.length ? inr(pending.reduce((s, e) => s + Number(e.amount), 0)) : 'Nothing waiting'} />
        <StatTile label="Entries" value={num(data?.length ?? 0, 0)} />
      </div>

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[{ key: 'list', label: 'Entries' }, { key: 'analysis', label: 'Analysis' }]} />

      {tab === 'list' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="segmented">
              {[['', 'All'], ['PENDING', t('pending')], ['APPROVED', t('approved')], ['REJECTED', t('rejected')]]
                .map(([v, label]) => (
                  <button key={v} className={status === v ? 'active' : ''} onClick={() => setStatus(v)}>{label}</button>
                ))}
            </div>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="expenses" title="No expenses recorded" />}>
              {(rows) => (
                <DataTable rows={rows} footer={`${rows.length} entr(ies)`}
                  columns={[
                    { key: 'd', header: 'Date', nowrap: true, render: (e: any) => formatDate(e.created_at) },
                    { key: 'c', header: 'Category', render: (e: any) => e.category_name },
                    { key: 'desc', header: 'Description', render: (e: any) => (
                      <div>
                        {e.description ?? <span className="muted">—</span>}
                        {e.paid_from_till_session_id && <div><Badge tone="info">paid from till</Badge></div>}
                      </div>
                    ) },
                    { key: 'b', header: 'Branch', render: (e: any) => e.branch_name },
                    { key: 'by', header: 'Raised by', render: (e: any) => e.requested_by_name },
                    { key: 's', header: 'Status', render: (e: any) => (
                      <div>
                        <StatusBadge status={e.status} />
                        {e.approved_by_name && <div className="muted small">{e.approved_by_name}</div>}
                      </div>
                    ) },
                    { key: 'a', header: 'Amount', align: 'right', render: (e: any) => inr(e.amount, { decimals: true }) },
                    { key: 'act', header: '', render: (e: any) => e.status === 'PENDING' && can('approve_expense') && (
                      <div className="row tight">
                        <Button size="sm" variant="primary" onClick={() => void decide(e, 'approve')}>{t('approve')}</Button>
                        <Button size="sm" onClick={() => setRejecting(e)}>{t('reject')}</Button>
                      </div>
                    ) },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'analysis' && (
        <div className="stack">
          <div className="grid cols-2">
            <Card title="Spend by category" description="Approved expenses, last 12 months">
              {summary?.by_category?.length ? (
                <>
                  <DonutChart data={summary.by_category} nameKey="category_name" valueKey="total" />
                  <ChartLegend items={summary.by_category.map((c: any) => c.category_name)} />
                </>
              ) : <EmptyState />}
            </Card>
            <Card title="Monthly spend">
              {summary?.by_month?.length
                ? <BarsChart data={summary.by_month} xKey="month" series={[{ key: 'total', label: 'Expenses' }]} />
                : <EmptyState />}
            </Card>
          </div>
          <Card title="Expenses against revenue"
            description="The ratio the requirements ask for — what proportion of each month's takings goes back out.">
            {summary?.expense_vs_revenue?.length ? (
              <>
                <TrendChart data={summary.expense_vs_revenue} xKey="month"
                  series={[{ key: 'revenue', label: 'Revenue' }, { key: 'expenses', label: 'Expenses' }]} />
                <div className="table-wrap" style={{ marginTop: 14 }}>
                  <DataTable rows={summary.expense_vs_revenue.slice(-12).reverse()}
                    columns={[
                      { key: 'm', header: 'Month', render: (r: any) => r.month },
                      { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
                      { key: 'rev', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
                      { key: 'exp', header: 'Expenses', align: 'right', render: (r: any) => inr(r.expenses) },
                      { key: 'pct', header: 'Ratio', align: 'right', render: (r: any) =>
                        r.expense_to_revenue_pct == null ? <span className="muted">—</span> : (
                          <Badge tone={Number(r.expense_to_revenue_pct) > 60 ? 'critical'
                            : Number(r.expense_to_revenue_pct) > 40 ? 'warning' : 'good'}>
                            {num(r.expense_to_revenue_pct, 1)}%
                          </Badge>
                        ) },
                    ]} />
                </div>
              </>
            ) : <EmptyState />}
          </Card>
        </div>
      )}

      <NewExpenseModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />

      <Modal open={Boolean(rejecting)} onClose={() => setRejecting(null)} title="Reject this expense"
        footer={<><Button onClick={() => setRejecting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void decide(rejecting, 'reject', reason)}>Reject</Button></>}>
        <Field label="Reason" hint="Kept on the record so the person who raised it knows why">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}

function NewExpenseModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ category_id: '', amount: '', description: '', receipt_url: '' });
  const { data: categories } = useSWR<any[]>(open ? '/api/expenses/categories' : null, fetcher);
  const { data: settings } = useSWR<any>(open ? '/api/admin/settings/effective' : null, fetcher);
  const threshold = Number(settings?.expense_approval_threshold ?? 5000);

  async function submit() {
    try {
      const res = await apiPost<any>('/api/expenses', {
        category_id: form.category_id, amount: Number(form.amount),
        description: form.description || undefined, receipt_url: form.receipt_url || undefined,
      });
      toast.success('Expense recorded', res.message);
      setForm({ category_id: '', amount: '', description: '', receipt_url: '' });
      onCreated();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Record an expense"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!form.category_id || !form.amount}
          onClick={() => void submit()}>Record</Button></>}>
      <div className="stack">
        {Number(form.amount) > threshold && (
          <Alert tone="warning">
            Above the {inr(threshold)} threshold — this will need approval before it counts as spend.
          </Alert>
        )}
        <Field label="Category" required>
          <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
            <option value="">Choose…</option>
            {(categories ?? []).map((c: any) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Amount" required>
          <input type="number" min={0.01} step="any" value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label="Description">
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Receipt link" hint="Paste a link to the scanned bill, if you have one">
          <input value={form.receipt_url} onChange={(e) => setForm({ ...form, receipt_url: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
