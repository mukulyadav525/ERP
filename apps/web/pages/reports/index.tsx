// Section 13 — Reporting & Analytics, plus the Section 14 accounting exports.
import { useState } from 'react';
import useSWR from 'swr';
import { apiGet, downloadCsv, fetcher, formatDate, inr, inrCompact, num, withBranch } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field,
  PageHeader, RequirePermission, Segmented, StatTile, Tabs,
} from '../../components/ui';
import { BarsChart, DonutChart, ChartLegend, TrendChart } from '../../components/charts';

export default function ReportsPage() {
  return (
    <RequirePermission permission="view_reports">
      <ReportsScreen />
    </RequirePermission>
  );
}

function ReportsScreen() {
  const { can } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<'sales' | 'inventory' | 'financial' | 'gst'>('sales');

  return (
    <>
      <PageHeader title={t('navAnalytics')} subtitle="Sales, stock, money and GST — scoped to what your role may see" />
      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'sales', label: 'Sales' },
          { key: 'inventory', label: 'Inventory' },
          { key: 'financial', label: 'Financial' },
          ...(can('view_gst_reports') ? [{ key: 'gst', label: 'GST & exports' }] : []),
        ]} />
      {tab === 'sales' && <SalesTab />}
      {tab === 'inventory' && <InventoryTab />}
      {tab === 'financial' && <FinancialTab />}
      {tab === 'gst' && <GstTab />}
    </>
  );
}

function SalesTab() {
  const { can, activeBranchId } = useAuth();
  const [days, setDays] = useState(90);
  const [grain, setGrain] = useState<'day' | 'week' | 'month'>('day');

  const { data: trend } = useSWR<any[]>(
    withBranch(`/api/reports/sales-trend?days=${days}&grain=${grain}`, activeBranchId), fetcher);
  const { data: categories } = useSWR<any[]>(
    withBranch(`/api/reports/category-breakdown?days=${days}`, activeBranchId), fetcher);
  const { data: payments } = useSWR<any[]>(
    withBranch(`/api/reports/payment-mode-split?days=${days}`, activeBranchId), fetcher);
  const { data: topProducts } = useSWR<any[]>(
    withBranch(`/api/reports/top-products?days=${days}&limit=12`, activeBranchId), fetcher);
  const { data: comparison } = useSWR<any[]>(
    can('view_chain_reports') ? `/api/reports/branch-comparison?days=${days}` : null, fetcher);
  const { data: byEmployee } = useSWR<any[]>(
    withBranch(`/api/reports/sales-by-employee?days=${days}`, activeBranchId), fetcher);

  // The trend endpoint returns a row per branch per period; collapse to one series.
  const series = (() => {
    const map = new Map<string, number>();
    for (const r of trend ?? []) map.set(r.period, (map.get(r.period) ?? 0) + Number(r.revenue));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([period, revenue]) => ({
        period: grain === 'month'
          ? new Date(period).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
          : new Date(period).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        revenue,
      }));
  })();

  const total = series.reduce((s, r) => s + r.revenue, 0);

  return (
    <div className="stack">
      <div className="row">
        <Segmented value={String(days)} onChange={(v) => setDays(Number(v))}
          options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' },
                    { value: '180', label: '6 months' }, { value: '365', label: '1 year' }]} />
        <Segmented value={grain} onChange={setGrain}
          options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
        <div className="spacer" />
        <Button onClick={() => downloadCsv(trend ?? [], 'sales-trend.csv')} disabled={!trend?.length}>Export</Button>
      </div>

      <div className="grid cols-3">
        <StatTile label="Revenue in period" value={inr(total)} />
        <StatTile label="Periods charted" value={num(series.length, 0)} />
        <StatTile label="Average per period" value={inr(series.length ? total / series.length : 0)} />
      </div>

      <Card title="Revenue over time">
        {series.length
          ? <TrendChart data={series} xKey="period" series={[{ key: 'revenue', label: 'Revenue' }]} height={300} />
          : <EmptyState />}
      </Card>

      <div className="grid cols-2">
        <Card title="Revenue by category">
          {categories?.length ? (
            <>
              <DonutChart data={categories} nameKey="category_name" valueKey="revenue" />
              <ChartLegend items={categories.map((c: any) => c.category_name)} />
            </>
          ) : <EmptyState />}
        </Card>
        <Card title="Payment methods">
          {payments?.length ? (
            <>
              <DonutChart data={payments} nameKey="method" valueKey="total" />
              <ChartLegend items={payments.map((p: any) => p.method)} />
            </>
          ) : <EmptyState />}
        </Card>
      </div>

      {can('view_chain_reports') && comparison && comparison.length > 1 && (
        <Card title="Branch comparison" description="Owner-only — staff see only their own branch">
          <BarsChart data={comparison} xKey="branch_name"
            series={[{ key: 'revenue', label: 'Revenue' }, { key: 'expenses', label: 'Expenses' }]} height={260} />
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <DataTable rows={comparison}
              columns={[
                { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
                { key: 'rev', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
                { key: 'inv', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
                { key: 'avg', header: 'Avg bill', align: 'right', render: (r: any) => inr(r.avg_ticket) },
                { key: 'exp', header: 'Expenses', align: 'right', render: (r: any) => inr(r.expenses) },
                { key: 'net', header: 'Net', align: 'right', render: (r: any) => (
                  <b style={{ color: Number(r.revenue) - Number(r.expenses) < 0 ? 'var(--status-critical)' : undefined }}>
                    {inr(Number(r.revenue) - Number(r.expenses))}
                  </b>
                ) },
                { key: 'stock', header: 'Stock value', align: 'right', render: (r: any) => inr(r.stock_value) },
              ]} />
          </div>
        </Card>
      )}

      <div className="grid cols-2">
        <Card flush title="Best sellers">
          <DataTable rows={topProducts ?? []} emptyText="No sales in this period."
            columns={[
              { key: 'p', header: 'Product', render: (r: any) => (
                <div>{r.product_name}<div className="muted small">{r.category_name}</div></div>
              ) },
              { key: 'q', header: 'Units', align: 'right', render: (r: any) => num(r.qty_sold) },
              { key: 'r', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
            ]} />
        </Card>
        <Card flush title="Sales by staff member">
          <DataTable rows={byEmployee ?? []} emptyText="No attributed sales."
            columns={[
              { key: 'n', header: 'Name', render: (r: any) => r.full_name },
              { key: 'b', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
              { key: 'r', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
              { key: 'a', header: 'Avg bill', align: 'right', render: (r: any) => inr(r.avg_ticket) },
            ]} />
        </Card>
      </div>
    </div>
  );
}

function InventoryTab() {
  const { can, activeBranchId } = useAuth();
  const { data: slow } = useSWR<any[]>(withBranch('/api/reports/slow-moving?limit=25', activeBranchId), fetcher);
  const { data: stockValue } = useSWR<any[]>(
    can('view_cost_price') ? '/api/reports/stock-value' : null, fetcher);
  const { data: margin } = useSWR<any[]>(
    can('view_cost_price') ? '/api/reports/margin?group_by=category&days=90' : null, fetcher);

  return (
    <div className="stack">
      {can('view_cost_price') && stockValue && (
        <>
          <div className="grid cols-3">
            <StatTile label="Total stock at cost"
              value={inr(stockValue.reduce((s: number, b: any) => s + Number(b.stock_value), 0))} />
            <StatTile label="SKUs carried"
              value={num(stockValue.reduce((s: number, b: any) => s + Number(b.sku_count), 0), 0)} />
            <StatTile label="Units on hand"
              value={num(stockValue.reduce((s: number, b: any) => s + Number(b.total_units), 0), 0)} />
          </div>
          <Card title="Stock value by branch">
            <BarsChart data={stockValue} xKey="branch_name" series={[{ key: 'stock_value', label: 'Stock value' }]} height={220} />
          </Card>
        </>
      )}

      {can('view_cost_price') && margin && (
        <Card flush title="Margin by category"
          description="Cost of goods uses the cost captured at the moment of each sale, so a later purchase at a different price does not rewrite last month's margin.">
          <DataTable rows={margin} emptyText="No sales to analyse."
            columns={[
              { key: 'g', header: 'Category', render: (r: any) => r.group_name },
              { key: 'rev', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
              { key: 'cogs', header: 'Cost of goods', align: 'right', render: (r: any) => inr(r.cogs) },
              { key: 'm', header: 'Margin', align: 'right', render: (r: any) => inr(r.margin_amount) },
              { key: 'p', header: '%', align: 'right', render: (r: any) => (
                <Badge tone={Number(r.margin_pct) < 10 ? 'critical' : Number(r.margin_pct) < 20 ? 'warning' : 'good'}>
                  {num(r.margin_pct, 1)}%
                </Badge>
              ) },
            ]} />
        </Card>
      )}

      <Card flush title="Slow-moving and dead stock"
        description="Sorted by how long it has been since anything sold — the money tied up on the shelf.">
        <DataTable rows={slow ?? []} emptyText="Everything is moving."
          columns={[
            { key: 'p', header: 'Product', render: (r: any) => (
              <div>{r.product_name}<div className="muted small mono">{r.sku}</div></div>
            ) },
            { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
            { key: 'q', header: 'On hand', align: 'right', render: (r: any) => num(r.qty_on_hand) },
            ...(can('view_cost_price') ? [{ key: 'v', header: 'Tied up', align: 'right' as const,
              render: (r: any) => inr(r.tied_up_value) }] : []),
            { key: 'l', header: 'Last sold', nowrap: true, render: (r: any) =>
              r.last_sale ? formatDate(r.last_sale) : <Badge tone="critical">never</Badge> },
          ]} />
      </Card>
    </div>
  );
}

function FinancialTab() {
  const { activeBranchId, can } = useAuth();
  const { data } = useSWR<any[]>(withBranch('/api/reports/expense-vs-revenue', activeBranchId), fetcher);
  const { data: digest } = useSWR<any>(withBranch('/api/reports/daily-digest', activeBranchId), fetcher);

  const recent = (data ?? []).slice(-18);

  return (
    <div className="stack">
      {digest && (
        <div className="grid cols-4">
          <StatTile label="Today's revenue" value={inr(digest.todays_revenue)}
            hint={`${digest.todays_invoices} bill(s)`} />
          <StatTile label="Total outstanding" value={inr(digest.total_outstanding)} />
          <StatTile label="Transfers in flight" value={num(digest.pending_transfers, 0)} />
          <StatTile label="Open stock conflicts" value={num(digest.open_stock_conflicts, 0)} />
        </div>
      )}

      <Card title="Revenue against expenses" description="Monthly, per branch">
        {recent.length
          ? <TrendChart data={recent} xKey="month"
              series={[{ key: 'revenue', label: 'Revenue' }, { key: 'expenses', label: 'Expenses' }]} height={280} />
          : <EmptyState />}
      </Card>

      <Card flush title="Monthly detail">
        <DataTable rows={[...(data ?? [])].reverse().slice(0, 24)} emptyText="No data yet."
          columns={[
            { key: 'm', header: 'Month', render: (r: any) => r.month },
            { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
            { key: 'rev', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
            { key: 'exp', header: 'Expenses', align: 'right', render: (r: any) => inr(r.expenses) },
            { key: 'net', header: 'Net', align: 'right', render: (r: any) => (
              <b style={{ color: Number(r.net) < 0 ? 'var(--status-critical)' : 'var(--status-good)' }}>
                {inr(r.net)}
              </b>
            ) },
          ]} />
      </Card>

      {digest?.low_stock?.length > 0 && (
        <Card flush title="Low stock right now">
          <DataTable rows={digest.low_stock}
            columns={[
              { key: 'n', header: 'Product', render: (r: any) => r.name },
              { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
              { key: 'q', header: 'On hand', align: 'right', render: (r: any) => num(r.base_unit_qty) },
              { key: 'm', header: 'Reorder at', align: 'right', render: (r: any) => num(r.reorder_min) },
            ]} />
        </Card>
      )}
    </div>
  );
}

function GstTab() {
  const { can } = useAuth();
  const toast = useToast();
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getFullYear(), today.getMonth() - 2, 1).toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [exportKind, setExportKind] = useState('sales');

  const { data: gst } = useSWR<any>(`/api/reports/gst-summary?from=${from}&to=${to}`, fetcher);
  const { data: itc } = useSWR<any[]>(`/api/reports/itc-summary?from=${from}&to=${to}`, fetcher);

  async function runExport() {
    try {
      const rows = await apiGet<any[]>(`/api/reports/accounting-export?kind=${exportKind}&from=${from}&to=${to}`);
      if (!rows.length) { toast.toast('Nothing to export in that range', { tone: 'info' }); return; }
      downloadCsv(rows, `${exportKind}-${from}-to-${to}.csv`);
      toast.success(`${rows.length} row(s) exported`);
    } catch (err) { toast.error(err); }
  }

  return (
    <div className="stack">
      <Card title="Reporting period">
        <div className="row">
          <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </Card>

      <Card flush title="GSTR-1 outward supplies"
        description="B2B and B2C are separated because GST returns report them in different tables.">
        <DataTable rows={gst?.outward_supplies ?? []} emptyText="No GST invoices in this period."
          columns={[
            { key: 'm', header: 'Month', render: (r: any) => r.month },
            { key: 't', header: 'Supply', render: (r: any) => <Badge tone={r.supply_type === 'B2B' ? 'info' : 'neutral'}>{r.supply_type}</Badge> },
            { key: 'i', header: 'Invoices', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
            { key: 'tv', header: 'Taxable value', align: 'right', render: (r: any) => inr(r.taxable_value, { decimals: true }) },
            { key: 'c', header: 'CGST', align: 'right', render: (r: any) => inr(r.cgst, { decimals: true }) },
            { key: 's', header: 'SGST', align: 'right', render: (r: any) => inr(r.sgst, { decimals: true }) },
            { key: 'ig', header: 'IGST', align: 'right', render: (r: any) => inr(r.igst, { decimals: true }) },
          ]} />
      </Card>

      <Card flush title="Credit notes issued"
        description={gst?.note}>
        <DataTable rows={gst?.credit_notes ?? []} emptyText="No credit notes in this period."
          columns={[
            { key: 'm', header: 'Month', render: (r: any) => r.month },
            { key: 'n', header: 'Notes', align: 'right', render: (r: any) => num(r.credit_note_count, 0) },
            { key: 'tv', header: 'Taxable value', align: 'right', render: (r: any) => inr(r.taxable_value, { decimals: true }) },
            { key: 'c', header: 'CGST', align: 'right', render: (r: any) => inr(r.cgst, { decimals: true }) },
            { key: 's', header: 'SGST', align: 'right', render: (r: any) => inr(r.sgst, { decimals: true }) },
          ]} />
      </Card>

      <Card flush title="HSN summary" description="Mandatory on a GST return.">
        <DataTable rows={gst?.hsn_summary ?? []} emptyText="No data."
          columns={[
            { key: 'h', header: 'HSN', render: (r: any) => <span className="mono">{r.hsn_code}</span> },
            { key: 'q', header: 'Quantity', align: 'right', render: (r: any) => num(r.qty) },
            { key: 'tv', header: 'Taxable value', align: 'right', render: (r: any) => inr(r.taxable_value, { decimals: true }) },
            { key: 'c', header: 'CGST', align: 'right', render: (r: any) => inr(r.cgst, { decimals: true }) },
            { key: 's', header: 'SGST', align: 'right', render: (r: any) => inr(r.sgst, { decimals: true }) },
          ]} />
      </Card>

      <Card flush title="Input tax credit and reversals"
        description="Purchases by vendor, with the debit notes that reverse credit already claimed.">
        <DataTable rows={itc ?? []} emptyText="No purchases in this period."
          columns={[
            { key: 'm', header: 'Month', render: (r: any) => r.month },
            { key: 'v', header: 'Vendor', render: (r: any) => (
              <div>{r.vendor_name}<div className="muted small mono">{r.gstin ?? 'no GSTIN'}</div></div>
            ) },
            { key: 'p', header: 'Purchases', align: 'right', render: (r: any) => inr(r.purchase_value) },
            { key: 'rev', header: 'ITC reversed', align: 'right', render: (r: any) =>
              Number(r.itc_reversed) > 0
                ? <Badge tone="warning">{inr(r.itc_reversed)}</Badge>
                : <span className="muted">—</span> },
            { key: 'n', header: 'Net', align: 'right', render: (r: any) => inr(r.net_purchase_value) },
          ]} />
      </Card>

      {can('export_accounting') && (
        <Card title="Accounting export"
          description="A dated bundle for your CA or a Tally import — the same rows you see on screen, as CSV.">
          <div className="row">
            <Field label="What to export">
              <select value={exportKind} onChange={(e) => setExportKind(e.target.value)} style={{ width: 220 }}>
                <option value="sales">Sales register</option>
                <option value="purchases">Purchase register</option>
                <option value="credit_notes">Credit notes</option>
                <option value="expenses">Expenses</option>
                <option value="payments">Payments received</option>
              </select>
            </Field>
            <Button variant="primary" onClick={() => void runExport()} style={{ alignSelf: 'flex-end' }}>
              Download CSV
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
