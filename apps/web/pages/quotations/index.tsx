// ============================================================================
// Estimates / quotations (spec §39–§41)
//
// An estimate is priced by the same tax engine as a bill and in the same sale
// units, so what the customer is quoted is what they are billed. Converting an
// estimate opens it as a DRAFT bill on the billing screen — the cashier reviews
// it, takes payment and finalises there; nothing is billed or paid here.
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiGet, apiPost, apiPut, businessToday, downloadFile, fetcher, formatDate, inr, num, printFile, qtyWithUnit,
  whatsappShareUrl, withBranch,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, BranchGate, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, Pager, RequirePermission, SearchInput, StatusBadge, Switch, Tabs, useDebounced,
} from '../../components/ui';
import {
  CustomerPicker, ProductPicker, defaultUnit, stateName,
  type CustomerHit, type ProductHit, type UnitOption,
} from '../../components/pickers';
import { Icon } from '../../components/icons';

export default function QuotationsPage() {
  return (
    <RequirePermission permission="view_quotations">
      <QuotationsScreen />
    </RequirePermission>
  );
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');

function QuotationsScreen() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const [tab, setTab] = useState<'quotes' | 'challans'>('quotes');
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(50);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null | 'new'>(null);

  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set('q', search);
  if (status) params.set('status', status);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/quotations?${params}`, activeBranchId), fetcher, { keepPreviousData: true });
  const { data: challans } = useSWR<any[]>(tab === 'challans' ? withBranch('/api/quotations/challans', activeBranchId) : null, fetcher);
  const moduleOff = error && String((error as Error).message).includes('switched off');

  useEffect(() => { if (typeof router.query.quotation === 'string') setDetailId(router.query.quotation); }, [router.query.quotation]);
  useEffect(() => { if (router.query.new === '1' && can('create_quotation')) setEditing('new'); }, [router.query.new, can]);

  if (moduleOff) {
    return (
      <>
        <PageHeader title={t('navQuotations')} />
        <Card><EmptyState icon="quotation" title="Estimates are switched off" text="The owner can turn them on under Admin → Settings → Quotations." /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('navQuotations')} subtitle="Estimates for customers — priced like a bill, opened as a bill when they confirm"
        actions={can('create_quotation') && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New estimate</Button>} />
      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[{ key: 'quotes', label: 'Estimates' }, { key: 'challans', label: 'Delivery challans' }]} />

      {tab === 'quotes' && (
        <>
          <div className="table-toolbar">
            <SearchInput value={query} onChange={setQuery} placeholder="Estimate number, customer or phone…" />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option><option value="DRAFT">Draft</option><option value="APPROVED">Approved</option>
              <option value="CONVERTED">Billed</option><option value="EXPIRED">Expired</option><option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <Card flush>
            <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
              empty={<EmptyState icon="quotation" title="No estimates" text="Create an estimate for a customer; open it as a bill when they confirm." />}>
              {(rows) => (
                <>
                  <DataTable rows={rows} rowKey={(q: any) => q.quotation_id} onRowClick={(q: any) => setDetailId(q.quotation_id)}
                    columns={[
                      { key: 'n', header: 'Estimate', nowrap: true, render: (q: any) => <span className="mono">{q.quotation_number}</span> },
                      { key: 'c', header: 'Customer', render: (q: any) => <div>{q.customer_name}<div className="muted small">{q.customer_phone}</div></div> },
                      ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (q: any) => q.branch_name }]),
                      { key: 'd', header: 'Date', nowrap: true, render: (q: any) => formatDate(q.created_at) },
                      { key: 'v', header: 'Valid until', nowrap: true, render: (q: any) => (q.valid_until
                        ? <span>{formatDate(q.valid_until)}{q.is_expired && ['DRAFT', 'APPROVED'].includes(q.status) && <> <Badge tone="warning">lapsed</Badge></>}</span> : '—') },
                      { key: 'l', header: 'Items', align: 'right', render: (q: any) => num(q.line_count, 0) },
                      { key: 's', header: 'Status', render: (q: any) => (
                        <span className="row tight"><StatusBadge status={q.status} />{q.stock_reserved && <Badge tone="info">stock held</Badge>}
                          {q.open_draft_id && <Badge tone="warning">bill in progress</Badge>}</span>) },
                      { key: 'a', header: 'Amount', align: 'right', render: (q: any) => inr(q.total_value, { decimals: true }) },
                    ]} />
                  <Pager shown={rows.length} pageSize={50} onMore={() => setLimit((l) => l + 50)} />
                </>
              )}
            </AsyncSection>
          </Card>
        </>
      )}

      {tab === 'challans' && (
        <Card flush title="Delivery challans" description="A delivery note for goods sent ahead of the bill. Not a tax invoice — it creates no GST liability and moves no stock.">
          <DataTable rows={challans ?? []} emptyText="No challans issued." rowKey={(c: any) => c.challan_id}
            columns={[
              { key: 'n', header: 'Challan', render: (c: any) => <span className="mono">{c.challan_number}</span> },
              { key: 'q', header: 'Against estimate', render: (c: any) => c.quotation_number ?? '—' },
              { key: 'c', header: 'Customer', render: (c: any) => c.customer_name },
              { key: 'b', header: 'Branch', render: (c: any) => c.branch_name },
              { key: 'l', header: 'Items', align: 'right', render: (c: any) => num(c.line_count, 0) },
              { key: 'd', header: 'Date', nowrap: true, render: (c: any) => formatDate(c.created_at) },
            ]} />
        </Card>
      )}

      <QuotationDetail id={detailId} onClose={() => { setDetailId(null); if (router.query.quotation) void router.replace('/quotations', undefined, { shallow: true }); }}
        onEdit={(q) => { setDetailId(null); setEditing(q); }} onChanged={() => void mutate()} />
      <QuotationEditor quotation={editing} onClose={() => setEditing(null)}
        onSaved={(id) => { setEditing(null); void mutate(); setDetailId(id); }} />
    </>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────
function QuotationDetail({ id, onClose, onEdit, onChanged }: { id: string | null; onClose: () => void; onEdit: (q: any) => void; onChanged: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [reserve, setReserve] = useState(false);
  const [holdDays, setHoldDays] = useState('3');
  const { data: q, error, mutate } = useSWR<any>(id ? `/api/quotations/${id}` : null, fetcher);
  const { data: settings } = useSWR<any>(approving ? '/api/admin/settings/effective' : null, fetcher);
  useEffect(() => { if (settings) { setReserve(Boolean(settings.quotation_stock_reservation)); setHoldDays(String(settings.quotation_hold_days ?? 3)); } }, [settings]);

  async function act(action: string, body: any, message: string) {
    if (!q) return;
    setBusy(true);
    try {
      await apiPost(`/api/quotations/${q.quotation_id}/${action}`, body ?? {});
      toast.success(message); setApproving(false); void mutate(); onChanged();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function convert() {
    if (!q) return;
    if (q.open_draft_id) { void router.push(`/billing?draft=${q.open_draft_id}`); return; }
    setBusy(true);
    try {
      const res = await apiPost<any>(`/api/quotations/${q.quotation_id}/convert`, {});
      toast.success('Opened as a draft bill', 'Review it, take payment and finalise on the billing screen.');
      onChanged();
      void router.push(`/billing?draft=${res.draft_invoice_id}`);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  const editable = q && ['DRAFT', 'APPROVED', 'EXPIRED'].includes(q.status) && !q.open_draft_id;
  const pdf = q ? `/api/quotations/${q.quotation_id}/pdf` : '';
  const share = q ? whatsappShareUrl(q.customer_whatsapp ?? q.customer_phone, [
    `${q.branch_name}`, `Estimate ${q.quotation_number}`, `Amount: ${inr(q.totals?.grand_total, { decimals: true })}`,
    q.valid_until ? `Valid until ${formatDate(q.valid_until)}` : null, 'Please contact us to confirm the order.',
  ].filter(Boolean).join('\n')) : null;

  return (
    <Modal open={Boolean(id)} onClose={onClose} wide title={q ? `Estimate ${q.quotation_number}` : 'Estimate'}
      footer={q && <>
        {can('approve_quotation') && !['CONVERTED', 'CANCELLED'].includes(q.status) && (
          <Button variant="danger" busy={busy} onClick={() => { if (window.confirm('Cancel this estimate? Any stock it holds is released.')) void act('cancel', {}, 'Estimate cancelled'); }}>Cancel estimate</Button>
        )}
        <span className="spacer" />
        {share && <Button onClick={() => window.open(share, '_blank', 'noopener')}><Icon name="whatsapp" size={14} /> WhatsApp</Button>}
        <Button onClick={() => printFile(pdf).catch((e) => toast.error(e))}><Icon name="print" size={14} /> Print</Button>
        <Button onClick={() => downloadFile(pdf, `Estimate-${q.quotation_number}.pdf`).catch((e) => toast.error(e))}><Icon name="download" size={14} /> PDF</Button>
        {editable && can('create_quotation') && <Button onClick={() => onEdit(q)}><Icon name="edit" size={14} /> Edit</Button>}
        {q.status === 'DRAFT' && can('approve_quotation') && <Button onClick={() => setApproving(true)}>Approve…</Button>}
        {['DRAFT', 'APPROVED'].includes(q.status) && can('convert_quotation') && (
          <Button variant="primary" busy={busy} onClick={() => void convert()}>{q.open_draft_id ? 'Continue the bill' : 'Convert to bill'}</Button>
        )}
      </>}>
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {!q && !error && <div className="muted">Loading…</div>}
      {q && (
        <div className="stack">
          {q.status === 'CONVERTED' && <Alert tone="good" title="Billed">This estimate became invoice {q.converted_invoice_number ?? ''}.</Alert>}
          {q.open_draft_id && <Alert tone="warning" title="A bill is being prepared from this estimate">Continue it on the billing screen. The estimate cannot be edited until that draft is finalised or discarded.</Alert>}
          {q.valid_until && q.valid_until < businessToday() && ['DRAFT', 'APPROVED'].includes(q.status) && (
            <Alert tone="warning">The validity date has passed. Prices may have changed — edit the estimate to refresh it.</Alert>
          )}
          <div className="grid cols-2">
            <KeyValue items={[
              ['Customer', `${q.customer_name}${q.customer_company ? ` · ${q.customer_company}` : ''}`], ['Phone', q.customer_phone],
              ['GSTIN', q.customer_gstin || '—'], ['Place of supply', q.place_of_supply_state_code ? `${q.place_of_supply_state_code} ${stateName(q.place_of_supply_state_code)}` : '—'],
            ]} />
            <KeyValue items={[
              ['Status', <StatusBadge key="s" status={q.status} />], ['Date', formatDate(q.created_at)],
              ['Valid until', q.valid_until ? formatDate(q.valid_until) : '—'],
              ['Prices', `${q.price_type === 'TAX_INCLUSIVE' ? 'Including' : 'Excluding'} GST${q.with_gst === false ? ' · no GST' : ''}`],
              ...(q.stock_reserved ? [['Stock held until', formatDate(q.reservation_hold_until)] as [string, React.ReactNode]] : []),
            ]} />
          </div>
          <DataTable rows={q.lines ?? []} rowKey={(l: any) => l.line_id}
            columns={[
              { key: 'p', header: 'Item', render: (l: any) => <div>{l.product_name}<div className="muted small mono">{l.sku}{l.hsn_code ? ` · HSN ${l.hsn_code}` : ''}</div></div> },
              { key: 'q', header: 'Qty', align: 'right', nowrap: true, render: (l: any) => qtyWithUnit(l.qty_in_sale_unit, l.unit_print_label) },
              { key: 'r', header: 'Rate', align: 'right', render: (l: any) => inr(l.rate_per_sale_unit, { decimals: true }) },
              { key: 'd', header: 'Disc.', align: 'right', render: (l: any) => (Number(l.discount_amount) ? inr(l.discount_amount, { decimals: true }) : '—') },
              { key: 'g', header: 'GST', align: 'right', render: (l: any) => `${num(l.gst_rate_pct, 2)}%` },
              { key: 't', header: 'Amount', align: 'right', render: (l: any) => <b>{inr(l.line_total, { decimals: true })}</b> },
            ]} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <dl className="kv" style={{ minWidth: 260 }}>
              {Number(q.totals?.discount_total) > 0 && <><dt>Discount</dt><dd className="num">− {inr(q.totals.discount_total, { decimals: true })}</dd></>}
              <dt>Taxable value</dt><dd className="num">{inr(q.totals?.subtotal, { decimals: true })}</dd>
              {q.interstate
                ? <><dt>IGST</dt><dd className="num">{inr(q.totals?.igst_total, { decimals: true })}</dd></>
                : <><dt>CGST</dt><dd className="num">{inr(q.totals?.cgst_total, { decimals: true })}</dd><dt>SGST</dt><dd className="num">{inr(q.totals?.sgst_total, { decimals: true })}</dd></>}
              <dt><b>Total</b></dt><dd className="num"><b>{inr(q.totals?.grand_total, { decimals: true })}</b></dd>
            </dl>
          </div>
          {(q.notes || q.terms) && (
            <div className="grid cols-2">
              {q.notes && <div><div className="section-title">Notes</div><div style={{ whiteSpace: 'pre-wrap' }}>{q.notes}</div></div>}
              {q.terms && <div><div className="section-title">Terms</div><div style={{ whiteSpace: 'pre-wrap' }}>{q.terms}</div></div>}
            </div>
          )}
          {q.stock_reserved && can('approve_quotation') && (
            <div><Button size="sm" busy={busy} onClick={() => void act('release-reservation', {}, 'Held stock released')}>Release held stock</Button></div>
          )}
        </div>
      )}

      <Modal open={approving} onClose={() => setApproving(false)} title="Approve estimate"
        footer={<><Button onClick={() => setApproving(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void act('approve', { reserve_stock: reserve, hold_days: Number(holdDays || 3) }, reserve ? 'Approved — stock held' : 'Approved')}>Approve</Button></>}>
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>Approving confirms the prices with the customer. Holding stock keeps it from being sold to anyone else until the estimate is billed or the hold ends.</p>
          <Switch checked={reserve} onChange={setReserve} label="Hold the stock for this customer" />
          {reserve && <Field label="Hold for (days)"><input inputMode="numeric" value={holdDays} onChange={(e) => setHoldDays(e.target.value.replace(/\D/g, ''))} /></Field>}
        </div>
      </Modal>
    </Modal>
  );
}

// ── Create / edit ────────────────────────────────────────────────────────────
interface QLine {
  key: string; product: ProductHit; unit_id: string; qty: string;
  rate: string;      // per sale unit, as typed; '' = catalog price
  discount: string;
}
const unitOf = (l: QLine): UnitOption | undefined => l.product.units.find((u) => u.product_unit_id === l.unit_id);
const multOf = (l: QLine) => Number(unitOf(l)?.multiplier_to_base ?? 1) || 1;

/** The catalog price restated on the estimate's basis, per base unit — what the server uses when no rate is typed. */
function catalogBase(p: ProductHit, priceType: string, withGst: boolean): number {
  const c = Number(p.selling_price ?? 0);
  const g = withGst ? Number(p.gst_rate_pct ?? 0) : 0;
  if (priceType === p.default_price_type || g === 0) return c;
  return priceType === 'TAX_EXCLUSIVE' ? c / (1 + g / 100) : c * (1 + g / 100);
}

function QuotationEditor({ quotation, onClose, onSaved }: { quotation: any | null | 'new'; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const { activeBranch } = useAuth();
  const isNew = quotation === 'new';
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [priceType, setPriceType] = useState<'TAX_EXCLUSIVE' | 'TAX_INCLUSIVE'>('TAX_EXCLUSIVE');
  const [withGst, setWithGst] = useState(true);
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<QLine[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (quotation === null) return;
    if (quotation === 'new') {
      const d = new Date(`${businessToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 15);
      setCustomer(null); setPriceType('TAX_EXCLUSIVE'); setWithGst(true); setValidUntil(d.toISOString().slice(0, 10));
      setNotes(''); setTerms(''); setLines([]);
      return;
    }
    const q = quotation;
    setCustomer({ customer_id: q.customer_id, name: q.customer_name, phone: q.customer_phone, gstin: q.customer_gstin, state_code: q.customer_state_code });
    setPriceType(q.price_type); setWithGst(q.with_gst !== false); setValidUntil(q.valid_until ?? ''); setNotes(q.notes ?? ''); setTerms(q.terms ?? '');
    const ids = [...new Set((q.lines ?? []).map((l: any) => l.product_id))];
    if (!ids.length) { setLines([]); return; }
    void apiGet<ProductHit[]>(`/api/catalog/products?ids=${ids.join(',')}&status=all&limit=200`).then((products) => {
      setLines((q.lines ?? []).map((l: any, i: number) => {
        const p = products.find((x) => x.product_id === l.product_id);
        if (!p) return null;
        return { key: `${l.line_id ?? i}`, product: p, unit_id: l.product_unit_id ?? (p.units.find((u) => u.is_base)?.product_unit_id ?? ''),
                 qty: String(Number(l.qty_in_sale_unit)), rate: String(round2(Number(l.rate_per_sale_unit))),
                 discount: Number(l.discount_amount) ? String(Number(l.discount_amount)) : '' } as QLine;
      }).filter(Boolean) as QLine[]);
    }).catch((err) => toast.error(err));
  }, [quotation]);   // eslint-disable-line react-hooks/exhaustive-deps

  const interstate = Boolean(withGst && customer?.state_code && activeBranch?.state_code && customer.state_code !== activeBranch.state_code);
  const preview = useMemo(() => {
    let taxable = 0, tax = 0;
    const per = lines.map((l) => {
      const m = multOf(l);
      const rateBase = l.rate === '' ? catalogBase(l.product, priceType, withGst) : Number(l.rate) / m;
      const gross = round2(Number(l.qty || 0) * m * rateBase);
      const net = round2(gross - Math.min(Number(l.discount || 0), gross));
      const g = withGst ? Number(l.product.gst_rate_pct ?? 0) : 0;
      const tv = priceType === 'TAX_INCLUSIVE' && g > 0 ? round2(net / (1 + g / 100)) : net;
      const tx = g > 0 ? (priceType === 'TAX_INCLUSIVE' ? round2(net - tv) : round2(tv * g / 100)) : 0;
      taxable += tv; tax += tx;
      return { unitRate: round2(rateBase * m), total: round2(tv + tx) };
    });
    return { per, taxable: round2(taxable), tax: round2(tax), grand: round2(taxable + tax) };
  }, [lines, priceType, withGst]);

  function add(p: ProductHit) {
    if (!Number(p.selling_price)) { toast.error(new Error(`"${p.name}" has no price on file — set one in the catalog first.`)); return; }
    const u = defaultUnit(p);
    setLines((prev) => [...prev, { key: `${p.product_id}:${Date.now()}`, product: p, unit_id: u?.product_unit_id ?? '', qty: '1', rate: '', discount: '' }]);
  }
  const upd = (key: string, patch: Partial<QLine>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save() {
    if (!customer) { toast.error(new Error('Choose the customer.')); return; }
    if (!lines.length) { toast.error(new Error('Add at least one item.')); return; }
    for (const l of lines) {
      const q = Number(l.qty);
      if (!(q > 0)) { toast.error(new Error(`Enter a quantity for "${l.product.name}".`)); return; }
      const u = unitOf(l);
      if (u && !u.allows_fraction && !Number.isInteger(q)) { toast.error(new Error(`"${l.product.name}" is sold in whole ${u.print_label}.`)); return; }
    }
    if (validUntil && validUntil < businessToday()) { toast.error(new Error('The validity date is already in the past.')); return; }
    const body = {
      customer_id: customer.customer_id, price_type: priceType, with_gst: withGst, valid_until: validUntil || undefined,
      notes: notes.trim() || null, terms: terms.trim() || null,
      lines: lines.map((l) => ({ product_id: l.product.product_id, product_unit_id: l.unit_id || undefined, qty: Number(l.qty),
        unit_rate: l.rate === '' ? undefined : Number(l.rate), discount_amount: Number(l.discount || 0) || 0 })),
    };
    setBusy(true);
    try {
      if (isNew) {
        const res = await apiPost<any>('/api/quotations', body);
        toast.success(`Estimate ${res.quotation_number} created`); onSaved(res.quotation_id);
      } else {
        await apiPut(`/api/quotations/${(quotation as any).quotation_id}`, body);
        toast.success('Estimate updated', (quotation as any).status === 'APPROVED' ? 'It is back to draft and needs approving again.' : undefined);
        onSaved((quotation as any).quotation_id);
      }
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={quotation !== null} onClose={onClose} wide title={isNew ? 'New estimate' : `Edit estimate ${(quotation as any)?.quotation_number ?? ''}`}
      footer={<>
        <span className="muted small">Total {inr(preview.grand, { decimals: true })} (preview)</span>
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Create estimate' : 'Save changes'}</Button>
      </>}>
      <BranchGate what="this estimate">
        <div className="stack">
          <div className="form-grid">
            <Field label="Customer" required><CustomerPicker value={customer} onSelect={setCustomer} /></Field>
            <Field label="Valid until"><input type="date" value={validUntil} min={businessToday()} onChange={(e) => setValidUntil(e.target.value)} /></Field>
            <Field label="Prices are">
              <select value={priceType} onChange={(e) => setPriceType(e.target.value as any)}>
                <option value="TAX_EXCLUSIVE">Excluding GST (GST added on top)</option>
                <option value="TAX_INCLUSIVE">Including GST</option>
              </select>
            </Field>
            <div style={{ alignSelf: 'end', paddingBottom: 6 }}><Switch checked={withGst} onChange={setWithGst} label="Charge GST on this estimate" /></div>
          </div>
          {customer && withGst && <div className="muted small">{interstate ? `${stateName(customer.state_code)} customer — IGST applies.` : 'CGST + SGST applies.'}</div>}
          <ProductPicker onSelect={add} ariaLabel="Add an item to the estimate" placeholder="Search the product to add…" />
          {lines.length > 0 && (
            <div className="table-wrap">
              <table className="data compact">
                <thead><tr><th>Item</th><th>Unit</th><th className="num">Qty</th><th className="num">Rate / unit</th><th className="num">Discount ₹</th><th className="num">Amount</th><th aria-label="Remove" /></tr></thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.key}>
                      <td style={{ minWidth: 160 }}>{l.product.name}<div className="muted small">GST {num(l.product.gst_rate_pct ?? 0, 2)}% · {num(l.product.available_qty ?? 0, 3)} {l.product.base_unit_label} in stock</div></td>
                      <td>
                        <select aria-label={`Unit for ${l.product.name}`} value={l.unit_id} style={{ minWidth: 90 }} onChange={(e) => {
                          const oldM = multOf(l); const newM = Number(l.product.units.find((u) => u.product_unit_id === e.target.value)?.multiplier_to_base ?? 1);
                          upd(l.key, { unit_id: e.target.value, rate: l.rate === '' ? '' : String(round2(Number(l.rate) / oldM * newM)) });
                        }}>
                          {l.product.units.map((u) => <option key={u.product_unit_id} value={u.product_unit_id}>{u.print_label}</option>)}
                        </select>
                      </td>
                      <td className="num"><input inputMode="decimal" aria-label={`Quantity of ${l.product.name}`} value={l.qty} style={{ width: 80 }} onChange={(e) => upd(l.key, { qty: decimalOnly(e.target.value) })} /></td>
                      <td className="num"><input inputMode="decimal" aria-label={`Rate for ${l.product.name}`} value={l.rate} style={{ width: 100 }}
                        placeholder={preview.per[i] ? preview.per[i].unitRate.toFixed(2) : ''} onChange={(e) => upd(l.key, { rate: decimalOnly(e.target.value) })} /></td>
                      <td className="num"><input inputMode="decimal" aria-label={`Discount on ${l.product.name}`} value={l.discount} placeholder="0" style={{ width: 84 }} onChange={(e) => upd(l.key, { discount: decimalOnly(e.target.value) })} /></td>
                      <td className="num nowrap" style={{ fontWeight: 600 }}>{inr(preview.per[i]?.total ?? 0, { decimals: true })}</td>
                      <td><button type="button" className="icon-btn" aria-label={`Remove ${l.product.name}`} onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}><Icon name="trash" size={14} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>Leave a rate blank to use the catalog price. Totals here are a preview — the saved estimate is priced by the server.</p>
          <div className="grid cols-2">
            <Field label="Notes (printed)"><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Delivery, site address…" /></Field>
            <Field label="Terms (printed)"><textarea rows={3} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={2000} placeholder="50% advance. Prices valid till the date above." /></Field>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <dl className="kv" style={{ minWidth: 240 }}>
              <dt>Taxable value</dt><dd className="num">{inr(preview.taxable, { decimals: true })}</dd>
              {withGst && <><dt>{interstate ? 'IGST' : 'CGST + SGST'}</dt><dd className="num">{inr(preview.tax, { decimals: true })}</dd></>}
              <dt><b>Total</b></dt><dd className="num"><b>{inr(preview.grand, { decimals: true })}</b></dd>
            </dl>
          </div>
        </div>
      </BranchGate>
    </Modal>
  );
}
