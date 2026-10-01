// ============================================================================
// Dashboard (spec §47) — the first screen, tuned to what each role may see.
//
// One period for the whole page (today, this week, this month… or custom), and
// every figure is a link to the screen that explains it. Money a role may not
// see is simply absent, not shown as zero.
// ============================================================================
import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { BUSINESS_TIMEZONE, fetcher, formatDateTime, inr, num, qtyWithUnit, withBranch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useI18n } from '../lib/i18n';
import {
  Alert, AsyncSection, Badge, Card, DataTable, EmptyState, LoadingState, PageHeader, PeriodPicker,
  StatTile, deltaProps, periodQuery, type PeriodValue,
} from '../components/ui';
import { TrendChart, DonutChart, ChartLegend, MiniBar } from '../components/charts';
import { Icon } from '../components/icons';

interface Dashboard {
  period: { from: string; to: string; label: string; days: number };
  revenue: number; revenue_change_pct: number | null; comparison_label?: string; invoice_count: number; invoice_count_change_pct: number | null;
  avg_ticket: number; tax_collected: number; returns_count: number; returns_value: number; net_sales: number;
  low_stock_items: number; total_outstanding: number; customers_with_balance: number;
  vendor_payable: number | null; vendors_owed: number | null; pending_expense_approvals: number;
  open_till_sessions: number; open_drafts: number; open_stock_conflicts: number; transfer_discrepancies: number;
  expenses: number | null; gross_profit: number | null; gross_margin_pct: number | null; cost_visible: boolean;
}

const PERIOD_KEY = 'erp_dashboard_period';
const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', CREDIT: 'On credit', LOYALTY_POINTS: 'Points' };

function TileLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="tile-link">{children}</Link>;
}

export default function DashboardPage() {
  const { user, can, activeBranchId, activeBranchName } = useAuth();
  const { t } = useI18n();
  // The period is a per-person preference, remembered on this device.
  const [period, setPeriod] = useState<PeriodValue>({ period: 'today' });
  useEffect(() => {
    try { const saved = localStorage.getItem(PERIOD_KEY); if (saved) setPeriod(JSON.parse(saved)); } catch { /* ignore */ }
  }, []);
  function changePeriod(p: PeriodValue) {
    setPeriod(p);
    try { localStorage.setItem(PERIOD_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  }
  const pq = period.period === 'custom' && !(period.from && period.to) ? 'period=today' : periodQuery(period);

  const { data: stats, error, isLoading } = useSWR<Dashboard>(withBranch(`/api/reports/dashboard?${pq}`, activeBranchId), fetcher,
    { refreshInterval: 60_000, keepPreviousData: true });
  const reports = can('view_reports');
  const trendQuery = period.period === 'today' || period.period === 'yesterday' ? 'period=last_30_days' : pq;
  const { data: trend } = useSWR<any[]>(reports ? withBranch(`/api/reports/sales-trend?${trendQuery}`, activeBranchId) : null, fetcher);
  const { data: payments } = useSWR<any[]>(reports ? withBranch(`/api/reports/payment-mode-split?${pq}`, activeBranchId) : null, fetcher);
  const { data: lowStock } = useSWR<any[]>(can('view_inventory') ? withBranch('/api/inventory/stock?filter=low&limit=8', activeBranchId) : null, fetcher);
  const { data: recent } = useSWR<any[]>(can('view_billing') ? withBranch('/api/billing/invoices?limit=8', activeBranchId) : null, fetcher);
  const { data: dues } = useSWR<any[]>(can('view_customer_outstanding') ? '/api/customers/outstanding/list?limit=6' : null, fetcher);

  const trendByDay = (() => {
    const map = new Map<string, number>();
    for (const row of trend ?? []) map.set(row.period, (map.get(row.period) ?? 0) + Number(row.revenue));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, revenue]) => ({
      period: new Date(`${p}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), revenue,
    }));
  })();

  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: BUSINESS_TIMEZONE }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const label = stats?.period?.label ?? '';

  return (
    <>
      <PageHeader title={`${greeting}, ${user?.full_name?.split(' ')[0] ?? ''}`}
        subtitle={<>{activeBranchName}{label ? ` · ${label}` : ''}</>}
        actions={<>
          <PeriodPicker value={period} onChange={changePeriod} />
          {can('create_invoice') && <Link href="/billing?new=1" className="btn primary"><Icon name="plus" size={14} /> {t('newBill')}</Link>}
        </>} />

      {error ? (
        <Card><EmptyState icon="alert" title="Could not load the dashboard" text={(error as Error).message} /></Card>
      ) : isLoading && !stats ? (
        <Card><LoadingState rows={5} /></Card>
      ) : stats && (
        <>
          {(stats.open_stock_conflicts > 0 || stats.transfer_discrepancies > 0) && (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="warning" title="Needs attention">
                {stats.open_stock_conflicts > 0 && <div><Link href="/billing?tab=conflicts">{stats.open_stock_conflicts} offline sale(s) went through without enough stock →</Link></div>}
                {stats.transfer_discrepancies > 0 && <div><Link href="/inventory?tab=transfers">{stats.transfer_discrepancies} transfer(s) arrived short →</Link></div>}
              </Alert>
            </div>
          )}
          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <TileLink href="/billing?tab=invoices">
              <StatTile label="Sales" value={inr(stats.revenue)} {...deltaProps(stats.revenue_change_pct, stats.comparison_label ?? 'vs the period before')} />
            </TileLink>
            <TileLink href="/billing?tab=invoices">
              <StatTile label={t('invoices')} value={num(stats.invoice_count, 0)} hint={`Average bill ${inr(stats.avg_ticket)}`} />
            </TileLink>
            <TileLink href="/returns">
              <StatTile label="Returns" value={inr(stats.returns_value)} hint={`${num(stats.returns_count, 0)} return(s) · net sales ${inr(stats.net_sales)}`} />
            </TileLink>
            {stats.gross_profit !== null && stats.cost_visible ? (
              <TileLink href="/reports?tab=profit">
                <StatTile label="Gross profit" value={inr(stats.gross_profit)} hint={stats.gross_margin_pct !== null ? `${num(stats.gross_margin_pct, 1)}% margin, before expenses` : 'Before expenses'} />
              </TileLink>
            ) : (
              <TileLink href="/reports?tab=gst">
                <StatTile label="GST collected" value={inr(stats.tax_collected)} hint="Net of credit notes" />
              </TileLink>
            )}
          </div>

          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            {can('view_inventory') && (
              <TileLink href="/inventory?low=1">
                <StatTile label={t('lowStockItems')} value={num(stats.low_stock_items, 0)} hint={stats.low_stock_items > 0 ? 'At or below the reorder level' : 'Nothing low'} />
              </TileLink>
            )}
            {can('view_customer_outstanding') && (
              <TileLink href="/customers?tab=outstanding">
                <StatTile label="Customers owe" value={inr(stats.total_outstanding)} hint={`${num(stats.customers_with_balance, 0)} customer(s)`} />
              </TileLink>
            )}
            {stats.vendor_payable !== null && (
              <TileLink href="/vendors?tab=payable">
                <StatTile label="We owe suppliers" value={inr(stats.vendor_payable)} hint={`${num(stats.vendors_owed ?? 0, 0)} supplier(s)`} />
              </TileLink>
            )}
            {can('create_invoice') && (
              <TileLink href="/billing?tab=drafts">
                <StatTile label="Draft bills" value={num(stats.open_drafts, 0)} hint={stats.open_drafts ? 'Saved, not yet billed' : 'None waiting'} />
              </TileLink>
            )}
            {can('manage_till') && (
              <TileLink href="/billing?tab=till">
                <StatTile label={t('openTills')} value={num(stats.open_till_sessions, 0)} hint={stats.open_till_sessions ? 'Close and count at day end' : 'All tills closed'} />
              </TileLink>
            )}
            {can('view_expenses') && (
              <TileLink href="/expenses">
                <StatTile label={stats.expenses !== null ? 'Expenses' : t('pendingApprovals')}
                  value={stats.expenses !== null ? inr(stats.expenses) : num(stats.pending_expense_approvals, 0)}
                  hint={stats.pending_expense_approvals > 0 ? `${stats.pending_expense_approvals} waiting for approval` : 'Nothing waiting for approval'} />
              </TileLink>
            )}
          </div>
        </>
      )}

      {reports && (
        <div className="grid split-main" style={{ marginBottom: 16 }}>
          <Card title="Sales by day" description={`${activeBranchName} · ${trendQuery === 'period=last_30_days' && pq !== trendQuery ? 'last 30 days' : label}`}>
            {trendByDay.length
              ? <TrendChart data={trendByDay} xKey="period" series={[{ key: 'revenue', label: 'Sales' }]} />
              : <EmptyState title="No sales in this period" text="Finalised bills appear here." />}
          </Card>
          <Card title="How customers paid" description={label}>
            {payments?.length ? (
              <>
                <DonutChart data={payments.map((p) => ({ ...p, method: METHOD_LABEL[p.method] ?? p.method }))} nameKey="method" valueKey="total" />
                <ChartLegend items={payments.map((p) => METHOD_LABEL[p.method] ?? p.method)} />
              </>
            ) : <EmptyState title="No payments in this period" />}
          </Card>
        </div>
      )}

      <div className="grid cols-2">
        {can('view_billing') && (
          <Card title="Latest bills" flush right={<Link href="/billing?tab=invoices" className="btn ghost sm">All bills</Link>}>
            <AsyncSection data={recent} isLoading={!recent}
              empty={<EmptyState title="No bills yet" text="Start the day by billing a customer." />}>
              {(rows) => (
                <DataTable rows={rows} rowKey={(r: any) => r.invoice_id}
                  columns={[
                    { key: 'no', header: 'Bill', nowrap: true, render: (r: any) => <Link className="mono" href={`/billing?invoice=${r.invoice_id}`}>{r.invoice_number}</Link> },
                    { key: 'when', header: 'When', nowrap: true, render: (r: any) => formatDateTime(r.server_received_at) },
                    { key: 'cust', header: t('customer'), render: (r: any) => r.customer_name ?? <span className="muted">{t('walkIn')}</span> },
                    { key: 'total', header: t('total'), align: 'right', render: (r: any) => inr(r.amount, { decimals: true }) },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        )}
        {can('view_inventory') && (
          <Card title="Needs reordering" flush right={<Link href="/inventory?low=1" className="btn ghost sm">Reorder list</Link>}>
            <AsyncSection data={lowStock} isLoading={!lowStock}
              empty={<EmptyState icon="check" title="Stock is healthy" text="Nothing is at or below its reorder level." />}>
              {(rows) => (
                <DataTable rows={rows} rowKey={(r: any) => `${r.branch_id}:${r.product_id}`}
                  columns={[
                    { key: 'name', header: t('product'), render: (r: any) => <div>{r.name}<div className="muted small">{activeBranchId ? r.sku : r.branch_name}</div></div> },
                    { key: 'qty', header: 'On hand', align: 'right', render: (r: any) => (
                      <div className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <MiniBar value={Math.max(Number(r.base_unit_qty), 0)} max={Number(r.reorder_min) * 2 || 1} tone={Number(r.base_unit_qty) <= 0 ? 'critical' : 'warning'} />
                        <span className="nowrap">{qtyWithUnit(r.base_unit_qty, r.base_unit_label)}</span>
                      </div>) },
                    { key: 'min', header: 'Reorder at', align: 'right', render: (r: any) => qtyWithUnit(r.reorder_min, r.base_unit_label) },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        )}
        {can('view_customer_outstanding') && (
          <Card title="Largest customer balances" flush right={<Link href="/customers?tab=outstanding" className="btn ghost sm">All dues</Link>}>
            <AsyncSection data={dues} isLoading={!dues}
              empty={<EmptyState icon="check" title="Nothing outstanding" text="No customer is carrying a balance." />}>
              {(rows) => (
                <DataTable rows={rows} rowKey={(r: any) => r.customer_id}
                  columns={[
                    { key: 'name', header: t('customer'), render: (r: any) => <Link href={`/customers?customer=${r.customer_id}`}>{r.name}</Link> },
                    { key: 'age', header: 'Oldest unpaid', render: (r: any) => (
                      <Badge tone={r.ageing_bucket === '90+' ? 'critical' : r.ageing_bucket === '61-90' ? 'warning' : 'neutral'}>{r.days_outstanding ?? '—'} days</Badge>) },
                    { key: 'bal', header: t('balance'), align: 'right', render: (r: any) => inr(r.balance_owed) },
                  ]} />
              )}
            </AsyncSection>
          </Card>
        )}
      </div>
    </>
  );
}
