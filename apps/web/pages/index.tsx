// Dashboard — the first screen everyone lands on, tuned per role.
import useSWR from 'swr';
import Link from 'next/link';
import { fetcher, inr, inrCompact, num, withBranch, formatDate } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useI18n } from '../lib/i18n';
import {
  AsyncSection, Badge, Button, Card, DataTable, EmptyState, LoadingState,
  PageHeader, StatTile, StatusBadge, deltaProps,
} from '../components/ui';
import { TrendChart, DonutChart, ChartLegend, MiniBar } from '../components/charts';

interface Dashboard {
  period_days: number; revenue: number; revenue_change_pct: number | null;
  invoice_count: number; invoice_count_change_pct: number | null;
  avg_ticket: number; tax_collected: number; low_stock_items: number;
  total_outstanding: number; customers_with_balance: number;
  pending_expense_approvals: number; open_till_sessions: number;
  cost_visible: boolean;
}

export default function DashboardPage() {
  const { user, can, activeBranchId, activeBranchName } = useAuth();
  const { t } = useI18n();

  const { data: stats, error, isLoading } = useSWR<Dashboard>(
    withBranch('/api/reports/dashboard?days=30', activeBranchId), fetcher, { refreshInterval: 60_000 });

  const { data: trend } = useSWR<any[]>(
    can('view_reports') ? withBranch('/api/reports/sales-trend?days=30&grain=day', activeBranchId) : null, fetcher);

  const { data: payments } = useSWR<any[]>(
    can('view_reports') ? withBranch('/api/reports/payment-mode-split?days=30', activeBranchId) : null, fetcher);

  const { data: lowStock } = useSWR<any[]>(
    can('view_inventory') ? withBranch('/api/inventory/stock?low_stock_only=true&limit=8', activeBranchId) : null, fetcher);

  const { data: recent } = useSWR<any[]>(
    can('view_billing') ? withBranch('/api/billing/invoices?limit=8', activeBranchId) : null, fetcher);

  const { data: dues } = useSWR<any[]>(
    can('view_customers') ? '/api/customers/outstanding/list?limit=6' : null, fetcher);

  // The trend endpoint returns one row per branch per day; the chart wants one
  // point per day with the branches summed.
  const trendByDay = (() => {
    const map = new Map<string, number>();
    for (const row of trend ?? []) {
      map.set(row.period, (map.get(row.period) ?? 0) + Number(row.revenue));
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, revenue]) => ({
        period: new Date(period).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        revenue,
      }));
  })();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user?.full_name?.split(' ')[0] ?? ''}`}
        subtitle={<>{activeBranchName} · {t('last30Days')}</>}
        actions={can('view_billing') && (
          <Link href="/billing" className="btn primary">{t('newBill')}</Link>
        )}
      />

      {error ? (
        <Card><EmptyState icon="⚠" title="Could not load the dashboard" text={(error as Error).message} /></Card>
      ) : isLoading || !stats ? (
        <Card><LoadingState rows={5} /></Card>
      ) : (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <StatTile label={t('revenue')} value={inr(stats.revenue)} {...deltaProps(stats.revenue_change_pct)} />
            <StatTile label={t('invoices')} value={num(stats.invoice_count, 0)} {...deltaProps(stats.invoice_count_change_pct)} />
            <StatTile label={t('avgTicket')} value={inr(stats.avg_ticket)} hint={t('last30Days')} />
            <StatTile label={t('taxCollected')} value={inr(stats.tax_collected)} hint="CGST + SGST + IGST" />
          </div>

          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <StatTile label={t('lowStockItems')} value={num(stats.low_stock_items, 0)}
              hint={stats.low_stock_items > 0
                ? <Link href="/inventory?low=1">Review reorder list →</Link>
                : 'Everything above its reorder point'} />
            <StatTile label={t('outstanding')} value={inr(stats.total_outstanding)}
              hint={`${stats.customers_with_balance} customer(s) with a balance`} />
            <StatTile label={t('openTills')} value={num(stats.open_till_sessions, 0)}
              hint={stats.open_till_sessions > 0 ? 'Counters still to reconcile' : 'All tills closed'} />
            <StatTile label={t('pendingApprovals')} value={num(stats.pending_expense_approvals, 0)}
              hint={stats.pending_expense_approvals > 0
                ? <Link href="/expenses?status=PENDING">Review expenses →</Link>
                : 'Nothing waiting'} />
          </div>
        </>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', marginBottom: 16 }}>
        {can('view_reports') && (
          <Card title="Daily revenue" description={`${activeBranchName} · last 30 days`}>
            {trendByDay.length
              ? <TrendChart data={trendByDay} xKey="period" series={[{ key: 'revenue', label: 'Revenue' }]} />
              : <EmptyState text="No sales recorded in this period yet." />}
          </Card>
        )}
        {can('view_reports') && (
          <Card title="How customers paid" description="Last 30 days">
            {payments?.length ? (
              <>
                <DonutChart data={payments} nameKey="method" valueKey="total" />
                <ChartLegend items={payments.map((p) => p.method)} />
              </>
            ) : <EmptyState text="No payments in this period." />}
          </Card>
        )}
      </div>

      <div className="grid cols-2">
        {can('view_billing') && (
          <Card title="Recent bills" flush
                right={<Link href="/billing" className="btn ghost sm">View all</Link>}>
            <AsyncSection data={recent} empty={<EmptyState text="No bills yet today." />}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  columns={[
                    { key: 'no', header: 'Invoice', render: (r: any) => <span className="mono">{r.invoice_number}</span> },
                    { key: 'cust', header: t('customer'), render: (r: any) => r.customer_name ?? <span className="muted">{t('walkIn')}</span> },
                    { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                    { key: 'total', header: t('total'), align: 'right', render: (r: any) => inr(r.grand_total, { decimals: true }) },
                  ]}
                />
              )}
            </AsyncSection>
          </Card>
        )}

        {can('view_inventory') && (
          <Card title="Needs reordering" flush
                right={<Link href="/inventory" className="btn ghost sm">Inventory</Link>}>
            <AsyncSection data={lowStock}
              empty={<EmptyState icon="✓" title="Stock is healthy" text="Nothing is below its reorder point." />}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  columns={[
                    { key: 'name', header: t('product'), render: (r: any) => (
                      <div>
                        <div>{r.name}</div>
                        <div className="muted small mono">{r.sku}</div>
                      </div>
                    ) },
                    { key: 'qty', header: t('stock'), align: 'right', render: (r: any) => (
                      <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                        <MiniBar value={Number(r.base_unit_qty)} max={Number(r.reorder_min) * 2 || 1}
                                 tone={Number(r.base_unit_qty) <= 0 ? 'critical' : 'warning'} />
                        <span>{num(r.base_unit_qty)}</span>
                      </div>
                    ) },
                    { key: 'min', header: t('reorderLevel'), align: 'right', render: (r: any) => num(r.reorder_min) },
                  ]}
                />
              )}
            </AsyncSection>
          </Card>
        )}

        {can('view_customers') && (
          <Card title="Top outstanding balances" flush
                right={<Link href="/customers?tab=outstanding" className="btn ghost sm">All dues</Link>}>
            <AsyncSection data={dues}
              empty={<EmptyState icon="✓" title="Nothing outstanding" text="No customer is carrying a balance." />}>
              {(rows) => (
                <DataTable
                  rows={rows}
                  columns={[
                    { key: 'name', header: t('customer'), render: (r: any) => (
                      <div>
                        <div>{r.name}</div>
                        <div className="muted small">{r.phone}</div>
                      </div>
                    ) },
                    { key: 'age', header: 'Age', render: (r: any) => (
                      <Badge tone={r.ageing_bucket === '90+' ? 'critical'
                        : r.ageing_bucket === '61-90' ? 'warning' : 'neutral'}>
                        {r.ageing_bucket} days
                      </Badge>
                    ) },
                    { key: 'bal', header: t('balance'), align: 'right',
                      render: (r: any) => inr(r.balance_owed) },
                  ]}
                />
              )}
            </AsyncSection>
          </Card>
        )}
      </div>
    </>
  );
}
