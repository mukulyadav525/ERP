// ============================================================================
// Reports (spec §48–§52)
//
// One period for every report on the page, the branch chosen at the top (or all
// branches for the owner), and every table exportable to CSV. Figures that need
// purchase cost appear only for roles allowed to see cost; the profit statement
// says plainly that it is indicative, and GST figures say what they cover.
// ============================================================================
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import { apiGet, downloadCsv, fetcher, formatDate, formatDateTime, inr, num, qtyWithUnit, withBranch } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, PageHeader, PeriodPicker, RequirePermission,
  StatTile, Tabs, periodQuery, type Column, type PeriodValue,
} from '../../components/ui';
import { BarsChart, ChartLegend, DonutChart, TrendChart } from '../../components/charts';
import { Icon } from '../../components/icons';

export default function ReportsPage() {
  return (
    <RequirePermission permission="view_reports">
      <ReportsScreen />
    </RequirePermission>
  );
}

const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', CHEQUE: 'Cheque', CREDIT: 'On credit', LOYALTY_POINTS: 'Points' };
type TabKey = 'sales' | 'profit' | 'gst' | 'registers' | 'stock' | 'till' | 'staff';
const PERIOD_KEY = 'erp_reports_period';

function ReportsScreen() {
  const { can, activeBranchName } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [period, setPeriod] = useState<PeriodValue>({ period: 'this_month' });
  useEffect(() => { try { const s = localStorage.getItem(PERIOD_KEY); if (s) setPeriod(JSON.parse(s)); } catch { /* ignore */ } }, []);
  const changePeriod = (p: PeriodValue) => { setPeriod(p); try { localStorage.setItem(PERIOD_KEY, JSON.stringify(p)); } catch { /* ignore */ } };
  const pq = period.period === 'custom' && !(period.from && period.to) ? 'period=this_month' : periodQuery(period);

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'sales', label: 'Sales' },
    ...(can('view_financial_reports') && can('view_cost_price') ? [{ key: 'profit' as TabKey, label: 'Profit' }] : []),
    ...(can('view_gst_reports') ? [{ key: 'gst' as TabKey, label: 'GST' }] : []),
    { key: 'registers', label: 'Registers' },
    ...(can('view_inventory') ? [{ key: 'stock' as TabKey, label: 'Stock' }] : []),
    ...(can('view_financial_reports') ? [{ key: 'till' as TabKey, label: 'Cash & tills' }] : []),
    ...(can('view_hr') ? [{ key: 'staff' as TabKey, label: 'Staff' }] : []),
  ];
  const wanted = typeof router.query.tab === 'string' && tabs.some((x) => x.key === router.query.tab) ? router.query.tab as TabKey : 'sales';
  const [tab, setTab] = useState<TabKey>(wanted);
  useEffect(() => setTab(wanted), [wanted]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader title={t('navAnalytics')} subtitle={`${activeBranchName} — figures for the period chosen here`}
        actions={<PeriodPicker value={period} onChange={changePeriod} />} />
      <Tabs active={tab} onChange={(k) => setTab(k as TabKey)} tabs={tabs} />
      {tab === 'sales' && <SalesTab pq={pq} />}
      {tab === 'profit' && <ProfitTab pq={pq} />}
      {tab === 'gst' && <GstTab pq={pq} />}
      {tab === 'registers' && <RegistersTab pq={pq} />}
      {tab === 'stock' && <StockTab />}
      {tab === 'till' && <TillTab pq={pq} />}
      {tab === 'staff' && <StaffTab pq={pq} />}
    </>
  );
}

function ExportButton({ rows, name, map }: { rows: any[] | undefined; name: string; map?: (r: any) => Record<string, unknown> }) {
  return (
    <Button size="sm" disabled={!rows?.length} onClick={() => downloadCsv((rows ?? []).map(map ?? ((r) => r)), name)}>
      <Icon name="download" size={13} /> CSV
    </Button>
  );
}

// ── Sales ────────────────────────────────────────────────────────────────────
function SalesTab({ pq }: { pq: string }) {
  const { can, activeBranchId } = useAuth();
  const q = (path: string) => withBranch(`${path}${path.includes('?') ? '&' : '?'}${pq}`, activeBranchId);
  const { data: dash } = useSWR<any>(q('/api/reports/dashboard'), fetcher);
  const { data: trend } = useSWR<any[]>(q('/api/reports/sales-trend'), fetcher);
  const { data: categories } = useSWR<any[]>(q('/api/reports/category-breakdown'), fetcher);
  const { data: payments } = useSWR<any[]>(q('/api/reports/payment-mode-split'), fetcher);
  const { data: top } = useSWR<any[]>(q('/api/reports/top-products?limit=20'), fetcher);
  const { data: branches } = useSWR<any[]>(can('view_chain_reports') && !activeBranchId ? `/api/reports/branch-comparison?${pq}` : null, fetcher);

  const series = (() => {
    const m = new Map<string, { revenue: number; invoices: number }>();
    for (const r of trend ?? []) {
      const e = m.get(r.period) ?? { revenue: 0, invoices: 0 };
      e.revenue += Number(r.revenue); e.invoices += Number(r.invoice_count); m.set(r.period, e);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([p, v]) => ({ period: new Date(`${p}T12:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), ...v }));
  })();

  return (
    <div className="stack">
      {dash && (
        <div className="grid cols-4">
          <StatTile label="Sales" value={inr(dash.revenue)} hint={dash.period?.label} />
          <StatTile label="Bills" value={num(dash.invoice_count, 0)} hint={`Average ${inr(dash.avg_ticket)}`} />
          <StatTile label="Returns" value={inr(dash.returns_value)} hint={`${num(dash.returns_count, 0)} return(s)`} />
          <StatTile label="Net sales" value={inr(dash.net_sales)} hint="Sales less returns, GST included" />
        </div>
      )}
      <div className="grid split-main">
        <Card title="Sales over time">
          {series.length ? <TrendChart data={series} xKey="period" series={[{ key: 'revenue', label: 'Sales' }]} height={280} />
            : <EmptyState title="No sales in this period" />}
        </Card>
        <Card title="How customers paid">
          {payments?.length ? (
            <>
              <DonutChart data={payments.map((p) => ({ ...p, method: METHOD_LABEL[p.method] ?? p.method }))} nameKey="method" valueKey="total" />
              <ChartLegend items={payments.map((p) => `${METHOD_LABEL[p.method] ?? p.method} · ${inr(p.total)}`)} />
            </>
          ) : <EmptyState title="No payments in this period" />}
        </Card>
      </div>
      {branches && (
        <Card flush title="Branches compared" right={<ExportButton rows={branches} name="branch-comparison.csv" />}>
          <DataTable rows={branches} rowKey={(r: any) => r.branch_id}
            columns={[
              { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
              { key: 'rev', header: 'Sales', align: 'right', render: (r: any) => inr(r.revenue) },
              { key: 'inv', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
              { key: 'avg', header: 'Average bill', align: 'right', render: (r: any) => inr(r.avg_ticket) },
              { key: 'exp', header: 'Expenses', align: 'right', render: (r: any) => inr(r.expenses) },
              ...(branches[0]?.stock_value !== undefined ? [{ key: 'sv', header: 'Stock value', align: 'right' as const, render: (r: any) => inr(r.stock_value) }] : []),
            ]} />
        </Card>
      )}
      <div className="grid cols-2">
        <Card flush title="By category" right={<ExportButton rows={categories} name="sales-by-category.csv" />}>
          <AsyncSection data={categories} isLoading={!categories} empty={<EmptyState text="No sales in this period." />}>
            {(rows) => (
              <DataTable rows={rows} rowKey={(r: any) => r.category_name}
                columns={[
                  { key: 'c', header: 'Category', render: (r: any) => r.category_name },
                  { key: 'b', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
                  { key: 't', header: 'Taxable', align: 'right', render: (r: any) => inr(r.taxable_value) },
                  { key: 'r', header: 'Sales', align: 'right', render: (r: any) => inr(r.revenue) },
                ]} />
            )}
          </AsyncSection>
        </Card>
        <Card flush title="Best-selling products" right={<ExportButton rows={top} name="top-products.csv" />}>
          <AsyncSection data={top} isLoading={!top} empty={<EmptyState text="No sales in this period." />}>
            {(rows) => (
              <DataTable rows={rows} rowKey={(r: any) => r.product_id}
                columns={[
                  { key: 'p', header: 'Product', render: (r: any) => <div>{r.product_name}<div className="muted small mono">{r.sku}</div></div> },
                  { key: 'q', header: 'Sold', align: 'right', render: (r: any) => qtyWithUnit(r.qty_sold, r.base_unit_label) },
                  { key: 'r', header: 'Sales', align: 'right', render: (r: any) => inr(r.revenue) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      </div>
    </div>
  );
}

// ── Profit ───────────────────────────────────────────────────────────────────
function ProfitTab({ pq }: { pq: string }) {
  const { activeBranchId } = useAuth();
  const [groupBy, setGroupBy] = useState('category');
  const { data: pl, error } = useSWR<any>(withBranch(`/api/reports/profit-and-loss?${pq}`, activeBranchId), fetcher);
  const { data: margin } = useSWR<any[]>(withBranch(`/api/reports/margin?group_by=${groupBy}&${pq}`, activeBranchId), fetcher);
  const { data: evr } = useSWR<any[]>(withBranch(`/api/reports/expense-vs-revenue?${pq}`, activeBranchId), fetcher);
  const months = (() => {
    const m = new Map<string, { revenue: number; expenses: number }>();
    for (const r of evr ?? []) { const e = m.get(r.month) ?? { revenue: 0, expenses: 0 }; e.revenue += Number(r.revenue); e.expenses += Number(r.expenses); m.set(r.month, e); }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({ month, ...v }));
  })();
  return (
    <div className="stack">
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {pl && (
        <div className="grid split-main">
          <Card title="Profit statement (indicative)" description={pl.period?.label}>
            <dl className="kv">
              <dt>Net sales (ex-GST, after returns)</dt><dd className="num">{inr(pl.net_sales, { decimals: true })}</dd>
              <dt>Cost of goods sold</dt><dd className="num">− {inr(pl.cost_of_goods_sold, { decimals: true })}</dd>
              <dt><b>Gross profit</b></dt><dd className="num"><b>{inr(pl.gross_profit, { decimals: true })}</b>{pl.gross_margin_pct !== null && <span className="muted small"> ({num(pl.gross_margin_pct, 1)}%)</span>}</dd>
              <dt>Stock written off / lost</dt><dd className="num">− {inr(pl.stock_shrinkage, { decimals: true })}</dd>
              {(pl.expenses ?? []).map((e: any) => <React.Fragment key={e.category}><dt className="muted">{e.category}</dt><dd className="num muted">− {inr(e.total, { decimals: true })}</dd></React.Fragment>)}
              <dt>Expenses</dt><dd className="num">− {inr(pl.expense_total, { decimals: true })}</dd>
              <dt><b>Operating profit</b></dt><dd className="num"><b>{inr(pl.operating_profit, { decimals: true })}</b></dd>
            </dl>
            <p className="muted small" style={{ marginTop: 10 }}>{pl.basis} Discounts given in the period: {inr(pl.discounts_given)}.</p>
          </Card>
          <Card title="Sales and expenses by month">
            {months.length ? <BarsChart data={months} xKey="month" series={[{ key: 'revenue', label: 'Sales' }, { key: 'expenses', label: 'Expenses' }]} height={280} />
              : <EmptyState text="No data in this period." />}
          </Card>
        </div>
      )}
      <Card flush title="Margin" right={<div className="row tight">
        <select aria-label="Group margin by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 'auto' }}>
          <option value="category">By category</option><option value="product">By product</option><option value="branch">By branch</option>
        </select>
        <ExportButton rows={margin} name={`margin-by-${groupBy}.csv`} />
      </div>}>
        <AsyncSection data={margin} isLoading={!margin} empty={<EmptyState text="No sales in this period." />}>
          {(rows) => (
            <DataTable rows={rows} rowKey={(r: any) => r.group_name}
              columns={[
                { key: 'g', header: groupBy === 'product' ? 'Product' : groupBy === 'branch' ? 'Branch' : 'Category', render: (r: any) => r.group_name },
                { key: 'r', header: 'Sales (ex-GST)', align: 'right', render: (r: any) => inr(r.revenue) },
                { key: 'c', header: 'Cost', align: 'right', render: (r: any) => inr(r.cogs) },
                { key: 'm', header: 'Margin', align: 'right', render: (r: any) => inr(r.margin_amount) },
                { key: 'p', header: '%', align: 'right', render: (r: any) => (r.margin_pct === null ? '—'
                  : <Badge tone={Number(r.margin_pct) < 10 ? 'critical' : Number(r.margin_pct) < 20 ? 'warning' : 'good'}>{num(r.margin_pct, 1)}%</Badge>) },
              ]} />
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}

// ── GST ──────────────────────────────────────────────────────────────────────
function GstTab({ pq }: { pq: string }) {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const { data, error } = useSWR<any>(withBranch(`/api/reports/gst-summary?${pq}`, activeBranchId), fetcher);
  const { data: itc } = useSWR<any[]>(withBranch(`/api/reports/itc-summary?${pq}`, activeBranchId), fetcher);
  async function exportKind(kind: string) {
    if (!data?.period) return;
    try {
      const rows = await apiGet<any[]>(withBranch(`/api/reports/accounting-export?kind=${kind}&from=${data.period.from}&to=${data.period.to}`, activeBranchId));
      if (!rows.length) { toast.toast('Nothing to export', { tone: 'info', message: 'No records in this period.' }); return; }
      downloadCsv(rows, `${kind}-${data.period.from}-to-${data.period.to}.csv`);
    } catch (err) { toast.error(err); }
  }
  const sum = (rows: any[] | undefined, k: string) => (rows ?? []).reduce((s, r) => s + Number(r[k] ?? 0), 0);
  return (
    <div className="stack">
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {data && (
        <>
          <Alert tone={data.scope === 'CHAIN_WIDE' ? 'info' : 'warning'} title={data.period?.label}>{data.scope_note} {data.note}</Alert>
          <div className="grid cols-3">
            <StatTile label="Output GST (net of credit notes)" value={inr(data.summary?.output_tax)} />
            <StatTile label="Input tax credit (purchases)" value={inr(data.summary?.input_tax_credit)} hint="Confirm against GSTR-2B" />
            <StatTile label="Net payable (indicative)" value={inr(data.summary?.net_payable_indicative)} />
          </div>
          <Card flush title="Outward supplies (GSTR-1)" right={<ExportButton rows={data.outward_supplies} name="gst-outward.csv" />}>
            <DataTable rows={data.outward_supplies ?? []} emptyText="No GST sales in this period." rowKey={(r: any) => `${r.month}:${r.supply_type}`}
              columns={[
                { key: 'm', header: 'Month', render: (r: any) => r.month },
                { key: 't', header: 'Type', render: (r: any) => <Badge tone={r.supply_type === 'B2B' ? 'info' : 'neutral'}>{r.supply_type}</Badge> },
                { key: 'n', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
                { key: 'v', header: 'Taxable', align: 'right', render: (r: any) => inr(r.taxable_value, { decimals: true }) },
                { key: 'c', header: 'CGST', align: 'right', render: (r: any) => inr(r.cgst, { decimals: true }) },
                { key: 's', header: 'SGST', align: 'right', render: (r: any) => inr(r.sgst, { decimals: true }) },
                { key: 'i', header: 'IGST', align: 'right', render: (r: any) => inr(r.igst, { decimals: true }) },
              ]} />
          </Card>
          <div className="grid cols-2">
            <Card flush title="Credit notes issued" right={<ExportButton rows={data.credit_notes} name="gst-credit-notes.csv" />}>
              <DataTable rows={data.credit_notes ?? []} emptyText="No credit notes in this period." rowKey={(r: any) => r.month}
                columns={[
                  { key: 'm', header: 'Month', render: (r: any) => r.month },
                  { key: 'n', header: 'Notes', align: 'right', render: (r: any) => num(r.credit_note_count, 0) },
                  { key: 'v', header: 'Taxable', align: 'right', render: (r: any) => inr(r.taxable_value, { decimals: true }) },
                  { key: 't', header: 'GST', align: 'right', render: (r: any) => inr(Number(r.cgst) + Number(r.sgst) + Number(r.igst), { decimals: true }) },
                ]} />
            </Card>
            <Card flush title="HSN summary" right={<ExportButton rows={data.hsn_summary} name="gst-hsn.csv" />}>
              <DataTable rows={data.hsn_summary ?? []} emptyText="No GST sales in this period." rowKey={(r: any) => `${r.hsn_code}:${r.uqc}`}
                columns={[
                  { key: 'h', header: 'HSN', render: (r: any) => <span className="mono">{r.hsn_code}</span> },
                  { key: 'q', header: 'Qty', align: 'right', render: (r: any) => qtyWithUnit(r.qty, r.uqc) },
                  { key: 'v', header: 'Taxable', align: 'right', render: (r: any) => inr(r.taxable_value, { decimals: true }) },
                  { key: 't', header: 'GST', align: 'right', render: (r: any) => inr(Number(r.cgst) + Number(r.sgst) + Number(r.igst), { decimals: true }) },
                ]} />
            </Card>
          </div>
        </>
      )}
      <Card flush title="Input tax credit by supplier" right={<ExportButton rows={itc} name="itc-by-supplier.csv" />}>
        <AsyncSection data={itc} isLoading={!itc} empty={<EmptyState text="No purchases in this period." />}>
          {(rows) => (
            <DataTable rows={rows} rowKey={(r: any) => `${r.month}:${r.vendor_name}`}
              footer={`ITC ${inr(sum(rows, 'net_itc'))} net of ${inr(sum(rows, 'itc_reversed'))} reversed`}
              columns={[
                { key: 'm', header: 'Month', render: (r: any) => r.month },
                { key: 'v', header: 'Supplier', render: (r: any) => <div>{r.vendor_name}<div className="muted small mono">{r.gstin ?? 'unregistered'}</div></div> },
                { key: 'p', header: 'Purchases (ex-GST)', align: 'right', render: (r: any) => inr(r.net_purchase_value) },
                { key: 'i', header: 'ITC', align: 'right', render: (r: any) => inr(r.itc, { decimals: true }) },
                { key: 'r', header: 'Reversed', align: 'right', render: (r: any) => (Number(r.itc_reversed) ? inr(r.itc_reversed, { decimals: true }) : '—') },
                { key: 'n', header: 'Net ITC', align: 'right', render: (r: any) => inr(r.net_itc, { decimals: true }) },
              ]} />
          )}
        </AsyncSection>
      </Card>
      {can('export_accounting') && (
        <Card title="Exports for your accountant" description="CSV files for the period above, ready for Tally or a spreadsheet.">
          <div className="row">
            {[['sales', 'Sales'], ['purchases', 'Purchases'], ['credit_notes', 'Credit notes'], ['expenses', 'Expenses'], ['payments', 'Payments received']].map(([k, l]) => (
              <Button key={k} onClick={() => void exportKind(k)}><Icon name="download" size={14} /> {l}</Button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Registers ────────────────────────────────────────────────────────────────
const REGISTERS: Record<string, { label: string; perm: string; path: string; columns: Column<any>[] }> = {
  sales: { label: 'Sales register', perm: 'view_reports', path: '/api/reports/sales-register', columns: [
    { key: 'n', header: 'Bill', nowrap: true, render: (r) => <span className="mono">{r.invoice_number}</span> },
    { key: 'd', header: 'Date', nowrap: true, render: (r) => formatDateTime(r.invoice_date) },
    { key: 'c', header: 'Customer', render: (r) => <div>{r.customer}{r.customer_gstin && <div className="muted small mono">{r.customer_gstin}</div>}</div> },
    { key: 't', header: 'Type', render: (r) => (r.status === 'VOID' ? <Badge tone="critical">void</Badge> : r.invoice_type === 'GST' ? 'GST' : 'Non-GST') },
    { key: 'v', header: 'Taxable', align: 'right', render: (r) => inr(r.taxable_value, { decimals: true }) },
    { key: 'g', header: 'GST', align: 'right', render: (r) => inr(Number(r.cgst_total) + Number(r.sgst_total) + Number(r.igst_total), { decimals: true }) },
    { key: 'a', header: 'Amount', align: 'right', render: (r) => inr(r.amount, { decimals: true }) },
    { key: 'p', header: 'Paid by', render: (r) => <span className="small">{r.payments}</span> },
  ] },
  purchases: { label: 'Purchase register', perm: 'view_financial_reports', path: '/api/reports/purchase-register', columns: [
    { key: 'n', header: 'GRN', nowrap: true, render: (r) => <span className="mono">{r.grn_number}</span> },
    { key: 'd', header: 'Received', nowrap: true, render: (r) => formatDate(r.received_at) },
    { key: 'v', header: 'Supplier', render: (r) => <div>{r.vendor}{r.vendor_gstin && <div className="muted small mono">{r.vendor_gstin}</div>}</div> },
    { key: 'b', header: 'Bill no.', render: (r) => r.vendor_invoice_no ?? '—' },
    { key: 't', header: 'Taxable', align: 'right', render: (r) => inr(r.taxable_total, { decimals: true }) },
    { key: 'g', header: 'GST', align: 'right', render: (r) => inr(Number(r.cgst_total) + Number(r.sgst_total) + Number(r.igst_total), { decimals: true }) },
    { key: 'a', header: 'Bill total', align: 'right', render: (r) => inr(r.grand_total, { decimals: true }) },
  ] },
  returns: { label: 'Returns register', perm: 'view_returns', path: '/api/reports/returns-register', columns: [
    { key: 'd', header: 'Date', nowrap: true, render: (r) => formatDateTime(r.created_at) },
    { key: 'i', header: 'Bill', render: (r) => <span className="mono">{r.invoice_number}</span> },
    { key: 'cn', header: 'Credit note', render: (r) => r.credit_note_number ?? '—' },
    { key: 'c', header: 'Customer', render: (r) => r.customer },
    { key: 'm', header: 'Refund', render: (r) => METHOD_LABEL[r.refund_method] ?? r.refund_method },
    { key: 'v', header: 'Value', align: 'right', render: (r) => inr(r.value, { decimals: true }) },
  ] },
  payments: { label: 'Money in & out', perm: 'view_financial_reports', path: '/api/reports/payments-register', columns: [
    { key: 'd', header: 'When', nowrap: true, render: (r) => formatDateTime(r.at) },
    { key: 'k', header: 'What', render: (r) => ({ SALE: 'Sale', RECEIPT: 'Receipt', VENDOR_PAYMENT: 'Supplier payment', REFUND: 'Refund', EXPENSE: 'Expense' } as Record<string, string>)[r.kind] ?? r.kind },
    { key: 'doc', header: 'Document', render: (r) => <span className="mono small">{r.document ?? '—'}</span> },
    { key: 'p', header: 'Party', render: (r) => r.party },
    { key: 'm', header: 'Method', render: (r) => METHOD_LABEL[r.method] ?? r.method },
    { key: 'i', header: 'In', align: 'right', render: (r) => (Number(r.amount_in) ? inr(r.amount_in, { decimals: true }) : '') },
    { key: 'o', header: 'Out', align: 'right', render: (r) => (Number(r.amount_out) ? inr(r.amount_out, { decimals: true }) : '') },
  ] },
};

function RegistersTab({ pq }: { pq: string }) {
  const { can, activeBranchId } = useAuth();
  const available = Object.entries(REGISTERS).filter(([, r]) => can(r.perm));
  const [kind, setKind] = useState(available[0]?.[0] ?? 'sales');
  const [method, setMethod] = useState('');
  const reg = REGISTERS[kind];
  const { data, error, isLoading } = useSWR<any[]>(reg ? withBranch(`${reg.path}?${pq}${kind === 'payments' && method ? `&method=${method}` : ''}`, activeBranchId) : null, fetcher);
  const totals = (() => {
    if (!data?.length) return null;
    if (kind === 'payments') {
      const inn = data.reduce((s, r) => s + Number(r.amount_in), 0), out = data.reduce((s, r) => s + Number(r.amount_out), 0);
      return `In ${inr(inn)} · out ${inr(out)} · net ${inr(inn - out)}`;
    }
    const key = kind === 'sales' ? 'amount' : kind === 'purchases' ? 'grand_total' : 'value';
    const rows = kind === 'sales' ? data.filter((r) => r.status !== 'VOID') : data;
    return `${rows.length} row(s) · total ${inr(rows.reduce((s, r) => s + Number(r[key]), 0), { decimals: true })}`;
  })();
  return (
    <div className="stack">
      <div className="table-toolbar">
        <select aria-label="Register" value={kind} onChange={(e) => setKind(e.target.value)}>
          {available.map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
        </select>
        {kind === 'payments' && (
          <select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">All methods</option>{['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE'].map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
          </select>
        )}
        <div className="spacer" />
        <ExportButton rows={data} name={`${kind}-register.csv`} />
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} empty={<EmptyState text="Nothing in this period." />}>
          {(rows) => <DataTable rows={rows.slice(0, 500)} columns={reg.columns} footer={<>{totals}{rows.length > 500 ? ' · first 500 shown; the CSV has every row' : ''}</>} />}
        </AsyncSection>
      </Card>
    </div>
  );
}

// ── Stock ────────────────────────────────────────────────────────────────────
function StockTab() {
  const { can, activeBranchId } = useAuth();
  const { data: summary } = useSWR<any[]>(withBranch('/api/reports/stock-summary', activeBranchId), fetcher);
  const { data: value } = useSWR<any[]>(can('view_cost_price') ? '/api/reports/stock-value' : null, fetcher);
  const { data: slow } = useSWR<any[]>(can('view_reports') ? withBranch('/api/reports/slow-moving?limit=30', activeBranchId) : null, fetcher);
  return (
    <div className="stack">
      {value && (
        <div className="grid cols-3">
          {value.map((b: any) => <StatTile key={b.branch_id} label={`Stock at cost — ${b.branch_name}`} value={inr(b.stock_value)} hint={`${num(b.sku_count, 0)} items in stock · ${num(b.out_of_stock_count, 0)} out`} />)}
        </div>
      )}
      <Card flush title="By category" right={<ExportButton rows={summary} name="stock-by-category.csv" />}>
        <AsyncSection data={summary} isLoading={!summary} empty={<EmptyState text="No products." />}>
          {(rows) => (
            <DataTable rows={rows} rowKey={(r: any) => r.category_name}
              columns={[
                { key: 'c', header: 'Category', render: (r: any) => r.category_name },
                { key: 'p', header: 'Products', align: 'right', render: (r: any) => num(r.products, 0) },
                { key: 'l', header: 'Low', align: 'right', render: (r: any) => (Number(r.low_stock) ? <Badge tone="warning">{num(r.low_stock, 0)}</Badge> : '—') },
                { key: 'o', header: 'Out', align: 'right', render: (r: any) => (Number(r.out_of_stock) ? <Badge tone="critical">{num(r.out_of_stock, 0)}</Badge> : '—') },
                ...(rows[0]?.stock_value !== undefined ? [{ key: 'v', header: 'Value at cost', align: 'right' as const, render: (r: any) => inr(r.stock_value) }] : []),
              ]} />
          )}
        </AsyncSection>
      </Card>
      {slow && (
        <Card flush title="Slow-moving stock" description="On the shelf, longest since last sold" right={<ExportButton rows={slow} name="slow-moving.csv" />}>
          <DataTable rows={slow} emptyText="Nothing slow-moving." rowKey={(r: any) => `${r.sku}:${r.branch_name}`}
            columns={[
              { key: 'p', header: 'Product', render: (r: any) => <div>{r.product_name}<div className="muted small mono">{r.sku}</div></div> },
              { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
              { key: 'q', header: 'On hand', align: 'right', render: (r: any) => num(r.qty_on_hand, 3) },
              ...(slow[0]?.tied_up_value !== undefined ? [{ key: 'v', header: 'Tied up', align: 'right' as const, render: (r: any) => inr(r.tied_up_value) }] : []),
              { key: 'l', header: 'Last sold', nowrap: true, render: (r: any) => (r.last_sale ? `${formatDate(r.last_sale)} (${r.days_since_sale} days)` : <Badge tone="warning">never</Badge>) },
            ]} />
        </Card>
      )}
    </div>
  );
}

// ── Cash & tills ─────────────────────────────────────────────────────────────
function TillTab({ pq }: { pq: string }) {
  const { activeBranchId } = useAuth();
  const { data, error, isLoading } = useSWR<any[]>(withBranch(`/api/reports/till-report?${pq}`, activeBranchId), fetcher);
  const closed = (data ?? []).filter((r) => r.status === 'CLOSED');
  const variance = closed.reduce((s, r) => s + Number(r.variance ?? 0), 0);
  return (
    <div className="stack">
      {data && (
        <div className="grid cols-3">
          <StatTile label="Tills in the period" value={num(data.length, 0)} hint={`${num(data.length - closed.length, 0)} still open`} />
          <StatTile label="Cash sales" value={inr(data.reduce((s, r) => s + Number(r.cash_sales), 0))} hint="Net of cash refunds" />
          <StatTile label="Total variance" value={inr(variance, { decimals: true })} hint={Math.abs(variance) < 0.01 ? 'Every drawer balanced' : variance < 0 ? 'Drawers short overall' : 'Drawers over overall'} />
        </div>
      )}
      <Card flush title="Each till: expected and counted cash" right={<ExportButton rows={data} name="till-report.csv" />}>
        <AsyncSection data={data} error={error} isLoading={isLoading} empty={<EmptyState text="No tills in this period." />}>
          {(rows) => (
            <DataTable rows={rows} rowKey={(r: any) => r.session_id}
              columns={[
                { key: 'o', header: 'Opened', nowrap: true, render: (r: any) => formatDateTime(r.opened_at) },
                { key: 'b', header: 'Branch · counter', render: (r: any) => `${r.branch} · ${r.counter_id}` },
                { key: 'u', header: 'Cashier', render: (r: any) => r.cashier },
                { key: 'e', header: 'Expected', align: 'right', render: (r: any) => inr(r.expected, { decimals: true }) },
                { key: 'c', header: 'Counted', align: 'right', render: (r: any) => (r.counted === null ? <Badge tone="info">open</Badge> : inr(r.counted, { decimals: true })) },
                { key: 'v', header: 'Variance', align: 'right', render: (r: any) => (r.variance === null ? '—'
                  : Math.abs(Number(r.variance)) < 0.01 ? <Badge tone="good">balanced</Badge>
                  : <Badge tone={Math.abs(Number(r.variance)) < 100 ? 'warning' : 'critical'}>{Number(r.variance) > 0 ? '+' : ''}{inr(r.variance, { decimals: true })}</Badge>) },
              ]} />
          )}
        </AsyncSection>
      </Card>
    </div>
  );
}

// ── Staff ────────────────────────────────────────────────────────────────────
function StaffTab({ pq }: { pq: string }) {
  const { activeBranchId } = useAuth();
  const { data: sales } = useSWR<any[]>(withBranch(`/api/reports/sales-by-employee?${pq}`, activeBranchId), fetcher);
  const { data: attendance } = useSWR<any[]>(withBranch(`/api/reports/attendance-summary?${pq}`, activeBranchId), fetcher);
  return (
    <div className="grid cols-2">
      <Card flush title="Sales by staff member" right={<ExportButton rows={sales} name="sales-by-staff.csv" />}>
        <DataTable rows={sales ?? []} emptyText="No sales in this period." rowKey={(r: any) => `${r.full_name}:${r.branch_name}`}
          columns={[
            { key: 'n', header: 'Name', render: (r: any) => <div>{r.full_name}<div className="muted small">{r.branch_name}</div></div> },
            { key: 'b', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
            { key: 'a', header: 'Average', align: 'right', render: (r: any) => inr(r.avg_ticket) },
            { key: 'r', header: 'Sales', align: 'right', render: (r: any) => inr(r.revenue) },
          ]} />
      </Card>
      <Card flush title="Attendance" right={<ExportButton rows={attendance} name="attendance.csv" />}>
        <DataTable rows={attendance ?? []} emptyText="No attendance recorded in this period." rowKey={(r: any) => `${r.full_name}:${r.branch_name}`}
          columns={[
            { key: 'n', header: 'Name', render: (r: any) => <div>{r.full_name}<div className="muted small">{r.branch_name}</div></div> },
            { key: 'd', header: 'Days present', align: 'right', render: (r: any) => num(r.present_days, 0) },
            { key: 'h', header: 'Avg hours', align: 'right', render: (r: any) => (r.avg_hours !== null ? num(r.avg_hours, 1) : '—') },
          ]} />
      </Card>
    </div>
  );
}
