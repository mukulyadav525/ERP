// ============================================================================
// Returns, credit notes and warranty claims (spec §42–§44)
//
// A return is always against the bill it came from: quantities are counted in
// the unit the customer bought in (2 BOX, 3 × 100 G), never more than is still
// returnable, and refunded at the price actually paid. A GST bill produces a
// numbered credit note with its own PDF; the refund goes out by cash, UPI, card,
// bank transfer or onto the customer's account — never "store credit" for a
// walk-in, who has no account to hold it.
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import {
  apiGet, apiPost, apiPut, downloadFile, fetcher, formatDate, formatDateTime, inr, num, printFile, qtyWithUnit, withBranch,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, Pager, RequirePermission, SearchInput, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';
import { Combobox } from '../../components/Combobox';
import { Icon } from '../../components/icons';

export default function ReturnsPage() {
  return (
    <RequirePermission permission="view_returns">
      <ReturnsScreen />
    </RequirePermission>
  );
}

const decimalOnly = (v: string) => v.replace(/[^\d.]/g, '');
const REFUND_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', CREDIT: 'To customer account' };

function ReturnsScreen() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [tab, setTab] = useState<'returns' | 'credit_notes' | 'warranty'>('returns');
  useEffect(() => {
    const q = router.query.tab;
    if (q === 'credit_notes' || q === 'warranty' || q === 'returns') setTab(q);
  }, [router.query.tab]);
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(50);
  const [newFor, setNewFor] = useState<string | null | ''>(null);   // '' = open with no invoice chosen
  const [detail, setDetail] = useState<any | null>(null);

  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set('q', search);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/returns?${params}`, activeBranchId), fetcher, { keepPreviousData: true });
  const { data: notes } = useSWR<any[]>(tab === 'credit_notes'
    ? withBranch(`/api/returns/credit-notes?limit=200${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, activeBranchId) : null, fetcher);
  const { data: claims, mutate: mutateClaims } = useSWR<any[]>(tab === 'warranty' ? '/api/returns/warranty-claims?limit=200' : null, fetcher);

  // ?invoice=<id> — "Return items" from an invoice opens the return for that bill.
  useEffect(() => {
    if (typeof router.query.invoice === 'string' && can('process_return')) setNewFor(router.query.invoice);
  }, [router.query.invoice, can]);

  async function openDetail(id: string) {
    try { setDetail(await apiGet(`/api/returns/${id}`)); } catch (err) { toast.error(err); }
  }
  async function updateClaim(id: string, status: string) {
    try { await apiPut(`/api/returns/warranty-claims/${id}`, { status }); toast.success('Claim updated'); void mutateClaims(); }
    catch (err) { toast.error(err); }
  }

  return (
    <>
      <PageHeader title={t('navReturns')} subtitle="Returns against a bill, GST credit notes and warranty claims"
        actions={can('process_return') && <Button variant="primary" onClick={() => setNewFor('')}><Icon name="plus" size={14} /> New return</Button>} />
      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[{ key: 'returns', label: 'Returns' }, { key: 'credit_notes', label: 'Credit notes' }, { key: 'warranty', label: 'Warranty claims' }]} />

      {tab !== 'warranty' && (
        <div className="table-toolbar">
          {tab === 'returns' && <SearchInput value={query} onChange={setQuery} placeholder="Bill, credit note or customer…" />}
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      )}

      {tab === 'returns' && (
        <Card flush>
          <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
            empty={<EmptyState icon="returns" title="No returns" text="Process a return from a bill with New return." />}>
            {(rows) => (
              <>
                <DataTable rows={rows} rowKey={(r: any) => r.return_id} onRowClick={(r: any) => void openDetail(r.return_id)}
                  columns={[
                    { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDateTime(r.created_at) },
                    { key: 'i', header: 'Bill', nowrap: true, render: (r: any) => <span className="mono">{r.invoice_number}</span> },
                    { key: 'cn', header: 'Credit note', nowrap: true, render: (r: any) => (r.credit_note_number ? <span className="mono">{r.credit_note_number}</span> : <span className="muted">—</span>) },
                    { key: 'c', header: 'Customer', render: (r: any) => r.customer_name ?? <span className="muted">Walk-in</span> },
                    ...(activeBranchId ? [] : [{ key: 'b', header: 'Branch', render: (r: any) => r.branch_name }]),
                    { key: 'm', header: 'Refund', render: (r: any) => REFUND_LABEL[r.refund_method] ?? r.refund_method },
                    { key: 'reason', header: 'Reason', render: (r: any) => r.return_reason },
                    { key: 'a', header: 'Value', align: 'right', render: (r: any) => inr(Number(r.refund_total) + Number(r.store_credit_total), { decimals: true }) },
                  ]} />
                <Pager shown={rows.length} pageSize={50} onMore={() => setLimit((l) => l + 50)} />
              </>
            )}
          </AsyncSection>
        </Card>
      )}

      {tab === 'credit_notes' && (
        <Card flush title="GST credit notes" description="Each one reduces the outward supply of the period it was issued in (GSTR-1).">
          <AsyncSection data={notes} isLoading={!notes} empty={<EmptyState icon="returns" title="No credit notes" />}>
            {(rows) => (
              <DataTable rows={rows} rowKey={(n: any) => n.credit_note_id}
                columns={[
                  { key: 'n', header: 'Credit note', nowrap: true, render: (n: any) => <span className="mono">{n.credit_note_number}</span> },
                  { key: 'd', header: 'Date', nowrap: true, render: (n: any) => formatDate(n.created_at) },
                  { key: 'i', header: 'Against bill', render: (n: any) => <span className="mono">{n.invoice_number}</span> },
                  { key: 'c', header: 'Customer', render: (n: any) => <div>{n.customer_name ?? 'Walk-in'}{n.customer_gstin && <div className="muted small mono">{n.customer_gstin}</div>}</div> },
                  { key: 'r', header: 'Reason', render: (n: any) => n.reason },
                  { key: 'a', header: 'Amount', align: 'right', render: (n: any) => inr(n.total_amount, { decimals: true }) },
                  { key: 'pdf', header: '', render: (n: any) => (
                    <Button size="sm" onClick={() => downloadFile(`/api/returns/credit-notes/${n.credit_note_id}/pdf`, `CreditNote-${n.credit_note_number}.pdf`).catch((e) => toast.error(e))}>
                      <Icon name="download" size={13} /> PDF</Button>) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      {tab === 'warranty' && (
        <Card flush title="Warranty claims" description="Items past the return window go to the manufacturer under warranty instead.">
          <DataTable rows={claims ?? []} emptyText="No warranty claims." rowKey={(c: any) => c.claim_id}
            columns={[
              { key: 'r', header: 'RMA', render: (c: any) => <span className="mono">{c.rma_number}</span> },
              { key: 'p', header: 'Product', render: (c: any) => <div>{c.product_name}{c.serial_number && <div className="muted small mono">{c.serial_number}</div>}</div> },
              { key: 'i', header: 'Bill', render: (c: any) => <span className="mono">{c.invoice_number}</span> },
              { key: 'cust', header: 'Customer', render: (c: any) => c.customer_name ?? '—' },
              { key: 'v', header: 'Vendor', render: (c: any) => c.vendor_name ?? '—' },
              { key: 'd', header: 'Raised', nowrap: true, render: (c: any) => formatDate(c.claim_date) },
              { key: 's', header: 'Status', render: (c: any) => (can('manage_warranty_claim') && !['REPLACED', 'REPAIRED', 'REFUNDED', 'REJECTED'].includes(c.status)
                ? <select aria-label={`Status of ${c.rma_number}`} value={c.status} style={{ width: 170 }} onChange={(e) => void updateClaim(c.claim_id, e.target.value)}>
                    {['OPEN', 'SENT_TO_VENDOR', 'REPLACED', 'REPAIRED', 'REFUNDED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
                  </select>
                : <StatusBadge status={c.status} />) },
            ]} />
        </Card>
      )}

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} wide title={`Return against ${detail?.invoice_number ?? ''}`}
        footer={detail?.credit_note_id && <>
          <Button onClick={() => printFile(`/api/returns/credit-notes/${detail.credit_note_id}/pdf`).catch((e) => toast.error(e))}><Icon name="print" size={14} /> Print credit note</Button>
          <Button variant="primary" onClick={() => downloadFile(`/api/returns/credit-notes/${detail.credit_note_id}/pdf`, `CreditNote-${detail.credit_note_number}.pdf`).catch((e) => toast.error(e))}>
            <Icon name="download" size={14} /> Credit note PDF</Button>
        </>}>
        {detail && (
          <div className="stack">
            <KeyValue items={[
              ['Date', formatDateTime(detail.created_at)], ['Customer', detail.customer_name ?? 'Walk-in'], ['Branch', detail.branch_name],
              ['Credit note', detail.credit_note_number ?? 'None (non-GST bill)'], ['Refund', `${REFUND_LABEL[detail.refund_method] ?? detail.refund_method}`],
              ['Reason', detail.return_reason],
            ]} />
            <DataTable rows={detail.lines ?? []} rowKey={(l: any) => l.return_line_id ?? l.invoice_line_id}
              columns={[
                { key: 'p', header: 'Item', render: (l: any) => <div>{l.product_name}<div className="muted small mono">{l.sku}</div></div> },
                { key: 'q', header: 'Returned', align: 'right', render: (l: any) => qtyWithUnit(l.qty_in_sale_unit, l.unit_print_label) },
                { key: 'c', header: 'Condition', render: (l: any) => <Badge tone={l.condition === 'DAMAGED' ? 'warning' : 'good'}>{String(l.condition).toLowerCase()}</Badge> },
                { key: 'a', header: 'Refunded', align: 'right', render: (l: any) => inr(l.cash_refund_amount, { decimals: true }) },
              ]} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <dl className="kv" style={{ minWidth: 240 }}>
                <dt>Paid back</dt><dd className="num">{inr(detail.refund_total, { decimals: true })}</dd>
                <dt>To customer account</dt><dd className="num">{inr(detail.store_credit_total, { decimals: true })}</dd>
              </dl>
            </div>
          </div>
        )}
      </Modal>

      <NewReturnModal invoiceId={newFor} onClose={() => { setNewFor(null); if (router.query.invoice) void router.replace('/returns', undefined, { shallow: true }); }}
        onDone={() => { setNewFor(null); void mutate(); if (router.query.invoice) void router.replace('/returns', undefined, { shallow: true }); }} />
    </>
  );
}

interface InvoiceHit { invoice_id: string; invoice_number: string; customer_name: string | null; amount: string | number; server_received_at: string }

function NewReturnModal({ invoiceId, onClose, onDone }: { invoiceId: string | null | ''; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { user, activeBranchId } = useAuth();
  const [picked, setPicked] = useState<InvoiceHit | null>(null);
  const [elig, setElig] = useState<any | null>(null);
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [conditions, setConditions] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('CASH');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const { data: settings } = useSWR<any>(invoiceId !== null ? '/api/admin/settings/effective' : null, fetcher);
  const isManager = user?.role === 'OWNER_ADMIN' || user?.role === 'BRANCH_MANAGER';
  const adminChoice = (settings?.refund_method ?? 'ADMIN_CHOICE') === 'ADMIN_CHOICE';

  useEffect(() => {
    if (invoiceId === null) { setPicked(null); setElig(null); setResult(null); return; }
    setQtys({}); setConditions({}); setReason(''); setRefundMethod('CASH'); setPin(''); setResult(null);
    if (invoiceId) void load(invoiceId);
  }, [invoiceId]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function load(id: string) {
    try { const e = await apiGet<any>(`/api/returns/eligibility/${id}`); setElig(e); setQtys({}); setConditions({}); }
    catch (err) { toast.error(err); setElig(null); }
  }

  const lines: any[] = useMemo(() => elig?.lines ?? [], [elig]);
  const refundPreview = useMemo(() => lines.reduce((s: number, l: any) => {
    const q = Number(qtys[l.line_id] || 0);
    return s + q * Number(l.multiplier_to_base) * Number(l.refund_per_base_unit);
  }, 0), [lines, qtys]);
  const outsideWindow = lines.some((l: any) => Number(qtys[l.line_id] || 0) > 0 && !l.within_return_window);

  async function submit() {
    const chosen = lines.filter((l: any) => Number(qtys[l.line_id] || 0) > 0);
    if (!chosen.length) { toast.error(new Error('Enter how many of each item came back.')); return; }
    for (const l of chosen) {
      const q = Number(qtys[l.line_id]);
      if (q > Number(l.returnable_qty_in_unit) + 1e-9) { toast.error(new Error(`Only ${qtyWithUnit(l.returnable_qty_in_unit, l.unit_print_label)} of "${l.product_name}" can still be returned.`)); return; }
      if (!l.allows_fraction && !Number.isInteger(q)) { toast.error(new Error(`"${l.product_name}" is counted in whole ${l.unit_print_label}.`)); return; }
    }
    if (!reason.trim()) { toast.error(new Error('Enter the reason for the return.')); return; }
    if (refundMethod === 'CREDIT' && !elig.invoice.customer_id) { toast.error(new Error('A walk-in sale has no account to credit. Refund by cash, UPI, card or bank transfer.')); return; }
    setBusy(true);
    try {
      let windowApproval: string | undefined;
      if (outsideWindow && !isManager) {
        if (pin.length < 4) { toast.error(new Error('An item is past its return window — a manager must approve with their PIN.')); setBusy(false); return; }
        windowApproval = (await apiPost<any>('/api/auth/verify-override-pin', { pin, purpose: 'RETURN_WINDOW' })).approval_id;
      }
      const res = await apiPost<any>('/api/returns', {
        invoice_id: elig.invoice.invoice_id, return_reason: reason.trim(), refund_method: adminChoice ? refundMethod : undefined,
        window_approval_id: windowApproval,
        lines: chosen.map((l: any) => ({ invoice_line_id: l.line_id, qty: Number(qtys[l.line_id]), condition: conditions[l.line_id] ?? 'RESELLABLE' })),
      });
      setResult(res);
      toast.success(res.credit_note_number ? `Credit note ${res.credit_note_number} issued` : 'Return recorded',
        `${inr(res.returned_value, { decimals: true })} returned`);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal guardUnsaved={!result} open={invoiceId !== null} onClose={result ? onDone : onClose} wide title={result ? 'Return recorded' : 'New return'}
      footer={result
        ? <>{result.credit_note_id && <Button onClick={() => downloadFile(`/api/returns/credit-notes/${result.credit_note_id}/pdf`, `CreditNote-${result.credit_note_number}.pdf`).catch((e) => toast.error(e))}>
              <Icon name="download" size={14} /> Credit note PDF</Button>}
            <span className="spacer" /><Button variant="primary" onClick={onDone}>Done</Button></>
        : <><Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={!elig} onClick={() => void submit()}>Process return · {inr(refundPreview, { decimals: true })}</Button></>}>
      {result ? (
        <div className="stack">
          <Alert tone="good" title={result.credit_note_number ? `Credit note ${result.credit_note_number}` : 'Return recorded'}>
            {inr(result.returned_value, { decimals: true })} of goods returned.
            {Number(result.cash_refund_amount) > 0 && ` ${inr(result.cash_refund_amount, { decimals: true })} paid back by ${REFUND_LABEL[result.refund_method] ?? result.refund_method}.`}
            {Number(result.store_credit_amount) > 0 && ` ${inr(result.store_credit_amount, { decimals: true })} taken off the customer's account.`}
          </Alert>
          {result.refund_note && <Alert tone="info">{result.refund_note}</Alert>}
          {result.till_note && <Alert tone="warning">No till is open for you, so this cash refund is not in any drawer count.</Alert>}
          {result.points_earned_reversed > 0 && <p className="muted small">{result.points_earned_reversed} loyalty points earned on these items were reversed.</p>}
          <p className="muted small">{result.gst_note}</p>
        </div>
      ) : (
        <div className="stack">
          {!elig && (
            <Field label="Bill to return against" hint="Search by bill number, customer name or phone">
              <Combobox<InvoiceHit>
                value={picked} onSelect={(i) => { setPicked(i); if (i) void load(i.invoice_id); }} ariaLabel="Bill" autoFocus
                placeholder="e.g. INV-AND/2026-27/00123 or a customer name"
                search={(q) => apiGet<InvoiceHit[]>(withBranch(`/api/billing/invoices?status=FINAL&limit=10&q=${encodeURIComponent(q)}`, activeBranchId))}
                getKey={(i) => i.invoice_id} getLabel={(i) => i.invoice_number}
                emptyText="No finalised bill matches."
                renderItem={(i) => (
                  <>
                    <span className="opt-main"><span className="opt-title mono">{i.invoice_number}</span>
                      <span className="opt-sub">{i.customer_name ?? 'Walk-in'} · {formatDate(i.server_received_at)}</span></span>
                    <span className="opt-side">{inr(i.amount, { decimals: true })}</span>
                  </>
                )} />
            </Field>
          )}
          {elig && (
            <>
              <div className="row">
                <div style={{ flex: 1 }}>
                  <b className="mono">{elig.invoice.invoice_number}</b> · {elig.invoice.customer_name ?? 'Walk-in'}
                  <div className="muted small">Billed {formatDateTime(elig.invoice.sold_at)} ({elig.days_since_sale} days ago) · {inr(elig.invoice.amount, { decimals: true })}{elig.invoice.invoice_type === 'GST' ? ' · GST bill — a credit note will be issued' : ' · non-GST bill'}</div>
                </div>
                {!invoiceId && <Button size="sm" variant="ghost" onClick={() => { setElig(null); setPicked(null); }}>Change bill</Button>}
              </div>
              <div className="table-wrap">
                <table className="data compact">
                  <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Can return</th><th className="num">Returning</th><th>Condition</th><th className="num">Refund</th></tr></thead>
                  <tbody>
                    {lines.map((l: any) => {
                      const q = Number(qtys[l.line_id] || 0);
                      const disabled = l.route === 'FULLY_RETURNED';
                      return (
                        <tr key={l.line_id}>
                          <td style={{ minWidth: 160 }}>{l.product_name}<div className="muted small mono">{l.sku}</div>
                            {l.route === 'FULLY_RETURNED' && <Badge tone="neutral">already returned</Badge>}
                            {l.route === 'WARRANTY_CLAIM' && <Badge tone="warning">past {l.window_days}-day window — warranty claim</Badge>}
                            {l.route === 'OUTSIDE_WINDOW' && <Badge tone="warning">past {l.window_days}-day window</Badge>}
                          </td>
                          <td className="num nowrap">{qtyWithUnit(l.sold_qty_in_unit, l.unit_print_label)}</td>
                          <td className="num nowrap">{qtyWithUnit(l.returnable_qty_in_unit, l.unit_print_label)}</td>
                          <td className="num">
                            <span className="row tight" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                              <input inputMode="decimal" aria-label={`Returning quantity of ${l.product_name}`} disabled={disabled}
                                value={qtys[l.line_id] ?? ''} placeholder="0" style={{ width: 80 }}
                                onChange={(e) => setQtys({ ...qtys, [l.line_id]: decimalOnly(e.target.value) })} />
                              <span className="muted small">{l.unit_print_label}</span>
                            </span>
                          </td>
                          <td>
                            <select aria-label={`Condition of ${l.product_name}`} value={conditions[l.line_id] ?? 'RESELLABLE'} disabled={disabled} style={{ width: 130 }}
                              onChange={(e) => setConditions({ ...conditions, [l.line_id]: e.target.value })}>
                              <option value="RESELLABLE">Resellable</option><option value="DAMAGED">Damaged</option>
                            </select>
                          </td>
                          <td className="num nowrap">{q > 0 ? inr(q * Number(l.multiplier_to_base) * Number(l.refund_per_base_unit), { decimals: true }) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ margin: 0 }}>Resellable items go back into stock. Damaged items are recorded but not restocked. The refund is the price paid, GST included.</p>
              <div className="form-grid">
                <Field label="Reason" required>
                  <input list="return-reasons" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
                  <datalist id="return-reasons">
                    <option value="Customer changed mind" /><option value="Wrong item billed" /><option value="Damaged on delivery" />
                    <option value="Size / specification mismatch" /><option value="Excess quantity" />
                  </datalist>
                </Field>
                {adminChoice ? (
                  <Field label="Refund by">
                    <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                      <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option><option value="BANK_TRANSFER">Bank transfer</option>
                      {elig.invoice.customer_id && <option value="CREDIT">To the customer&rsquo;s account</option>}
                    </select>
                  </Field>
                ) : (
                  <Field label="Refund by"><input readOnly value={settings?.refund_method === 'STORE_CREDIT' ? 'Customer account (shop policy)' : settings?.refund_method === 'ORIGINAL_MODE' ? 'The way it was paid (shop policy)' : 'Cash (shop policy)'} /></Field>
                )}
              </div>
              {outsideWindow && !isManager && (
                <Alert tone="warning" title="Past the return window">
                  A manager must approve this return.
                  <div style={{ marginTop: 8, maxWidth: 220 }}>
                    <input type="password" inputMode="numeric" maxLength={6} aria-label="Manager PIN" placeholder="Manager PIN" value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoComplete="off" />
                  </div>
                </Alert>
              )}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <b>Refund: {inr(refundPreview, { decimals: true })}</b>
              </div>
              {num(refundPreview) !== '0' && <p className="muted small" style={{ margin: 0, textAlign: 'right' }}>Preview. The server calculates the exact refund, including any part bought on credit, which comes off the account instead.</p>}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
