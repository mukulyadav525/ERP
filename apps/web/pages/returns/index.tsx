// Section 12 — Returns, refunds and warranty.
import { useState } from 'react';
import useSWR from 'swr';
import { apiGet, apiPost, fetcher, formatDate, formatDateTime, inr, num, withBranch } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue,
  Modal, PageHeader, RequirePermission, SearchInput, StatusBadge, Tabs, useDebounced,
} from '../../components/ui';

export default function ReturnsPage() {
  return (
    <RequirePermission permission="view_returns">
      <ReturnsScreen />
    </RequirePermission>
  );
}

function ReturnsScreen() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<'returns' | 'credit_notes' | 'warranty'>('returns');
  const [newOpen, setNewOpen] = useState(false);

  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch('/api/returns?limit=200', activeBranchId), fetcher);
  const { data: creditNotes } = useSWR<any[]>(
    tab === 'credit_notes' ? withBranch('/api/returns/credit-notes?limit=200', activeBranchId) : null, fetcher);
  const { data: claims } = useSWR<any[]>(
    tab === 'warranty' ? '/api/returns/warranty-claims?limit=100' : null, fetcher);

  return (
    <>
      <PageHeader title={t('navReturns')}
        subtitle="Sales returns, GST credit notes and warranty claims"
        actions={can('process_return') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ Process a return</Button>} />

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'returns', label: 'Returns', count: data?.length },
          { key: 'credit_notes', label: 'Credit notes' },
          { key: 'warranty', label: 'Warranty claims' },
        ]} />

      {tab === 'returns' && (
        <Card flush>
          <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
            empty={<EmptyState icon="returns" title="No returns" />}>
            {(rows) => (
              <DataTable rows={rows} footer={`${rows.length} return(s)`}
                columns={[
                  { key: 'inv', header: 'Against invoice', render: (r: any) => (
                    <div><span className="mono">{r.invoice_number}</span>
                      <div><Badge tone={r.invoice_type === 'GST' ? 'info' : 'neutral'}>{r.invoice_type}</Badge></div></div>
                  ) },
                  { key: 'c', header: 'Customer', render: (r: any) => r.customer_name ?? <span className="muted">walk-in</span> },
                  { key: 'cn', header: 'Credit note', render: (r: any) => r.credit_note_number
                    ? <span className="mono">{r.credit_note_number}</span>
                    : <span className="muted">not required</span> },
                  { key: 'reason', header: 'Reason', render: (r: any) => r.return_reason },
                  { key: 'm', header: 'Refunded via', render: (r: any) => <Badge tone="neutral">{r.refund_method ?? '—'}</Badge> },
                  { key: 'amt', header: 'Refunded', align: 'right', render: (r: any) => (
                    <div>
                      {inr(r.refund_total, { decimals: true })}
                      {Number(r.store_credit_total) > 0 && (
                        <div className="muted small">+{inr(r.store_credit_total)} store credit</div>
                      )}
                    </div>
                  ) },
                  { key: 'd', header: 'When', nowrap: true, render: (r: any) => formatDate(r.created_at) },
                ]} />
            )}
          </AsyncSection>
        </Card>
      )}

      {tab === 'credit_notes' && (
        <Card flush title="GST credit notes"
          description="A return against a GST invoice must produce a credit note with its own number series — that is what reduces the reported outward supply (12.1.1).">
          <DataTable rows={creditNotes ?? []} emptyText="No credit notes issued."
            columns={[
              { key: 'n', header: 'Credit note', render: (c: any) => <span className="mono">{c.credit_note_number}</span> },
              { key: 'i', header: 'Original invoice', render: (c: any) => <span className="mono">{c.invoice_number}</span> },
              { key: 'cust', header: 'Customer', render: (c: any) => (
                <div>{c.customer_name ?? <span className="muted">walk-in</span>}
                  {c.customer_gstin && <div className="muted small mono">{c.customer_gstin}</div>}</div>
              ) },
              { key: 'b', header: 'Branch', render: (c: any) => c.branch_name },
              { key: 'r', header: 'Reason', render: (c: any) => c.reason },
              { key: 'd', header: 'Issued', nowrap: true, render: (c: any) => formatDate(c.created_at) },
              { key: 'a', header: 'Amount', align: 'right', render: (c: any) => inr(c.total_amount, { decimals: true }) },
            ]} />
        </Card>
      )}

      {tab === 'warranty' && (
        <Card flush title="Warranty claims"
          description="Claims are matched to the original sale line and, for serialised goods, to the exact unit.">
          <DataTable rows={claims ?? []} emptyText="No warranty claims."
            columns={[
              { key: 'r', header: 'RMA', render: (c: any) => <span className="mono">{c.rma_number}</span> },
              { key: 'p', header: 'Product', render: (c: any) => (
                <div>{c.product_name}
                  {c.serial_number && <div className="muted small mono">{c.serial_number}</div>}</div>
              ) },
              { key: 'i', header: 'Invoice', render: (c: any) => <span className="mono">{c.invoice_number}</span> },
              { key: 'cust', header: 'Customer', render: (c: any) => c.customer_name ?? <span className="muted">—</span> },
              { key: 'v', header: 'Vendor', render: (c: any) => c.vendor_name ?? <span className="muted">—</span> },
              { key: 's', header: 'Status', render: (c: any) => <StatusBadge status={c.status} /> },
              { key: 'd', header: 'Raised', nowrap: true, render: (c: any) => formatDate(c.claim_date) },
            ]} />
        </Card>
      )}

      <NewReturnModal open={newOpen} onClose={() => setNewOpen(false)}
        onDone={() => { setNewOpen(false); void mutate(); }} />
    </>
  );
}

function NewReturnModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { activeBranchId } = useAuth();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const [eligibility, setEligibility] = useState<any | null>(null);
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [conditions, setConditions] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('CASH');
  const [busy, setBusy] = useState(false);

  const { data: invoices } = useSWR<any[]>(
    open && search ? withBranch(`/api/billing/invoices?limit=10&q=${encodeURIComponent(search)}`, activeBranchId) : null,
    fetcher);

  async function pick(invoice: any) {
    try {
      setEligibility(await apiGet(`/api/returns/eligibility/${invoice.invoice_id}`));
      setQtys({}); setConditions({});
    } catch (err) { toast.error(err); }
  }

  async function submit() {
    const lines = Object.entries(qtys).filter(([, q]) => q > 0).map(([invoice_line_id, qty_base_unit]) => ({
      invoice_line_id, qty_base_unit, condition: conditions[invoice_line_id] ?? 'RESELLABLE',
    }));
    if (!lines.length) return;
    setBusy(true);
    try {
      const res = await apiPost<any>('/api/returns', {
        invoice_id: eligibility.invoice.invoice_id, return_reason: reason,
        refund_method: refundMethod, lines,
      });
      toast.success(
        res.credit_note_number ? `Credit note ${res.credit_note_number} issued` : 'Return processed',
        `Refund ${inr(res.cash_refund_amount, { decimals: true })}` +
        (res.points_redeemed_restored ? ` · ${res.points_redeemed_restored} points restored` : '') +
        (res.points_earned_reversed ? ` · ${res.points_earned_reversed} points revoked` : ''));
      setEligibility(null); setQuery(''); setReason(''); onDone();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={() => { setEligibility(null); onClose(); }} wide title="Process a return"
      footer={eligibility && (
        <><Button onClick={() => setEligibility(null)}>Back</Button>
          <Button variant="primary" busy={busy} disabled={!reason || !Object.values(qtys).some((q) => q > 0)}
            onClick={() => void submit()}>Process return</Button></>
      )}>
      {!eligibility ? (
        <div className="stack">
          <Field label="Find the original invoice" required>
            <SearchInput value={query} onChange={setQuery} placeholder="Invoice number, customer name or phone…" />
          </Field>
          {(invoices ?? []).map((i: any) => (
            <button key={i.invoice_id} onClick={() => void pick(i)}
              style={{ display: 'flex', width: '100%', gap: 10, textAlign: 'left', padding: '8px 10px',
                border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface-1)',
                cursor: 'pointer', font: 'inherit' }}>
              <span style={{ flex: 1 }}>
                <b className="mono">{i.invoice_number}</b>
                <div className="muted small">{i.customer_name ?? 'Walk-in'} · {formatDate(i.server_received_at)}</div>
              </span>
              <span><b>{inr(i.grand_total, { decimals: true })}</b>
                <div><Badge tone={i.invoice_type === 'GST' ? 'info' : 'neutral'}>{i.invoice_type}</Badge></div></span>
            </button>
          ))}
          {query && invoices?.length === 0 && <EmptyState text="No matching invoice at your branch." />}
        </div>
      ) : (
        <div className="stack">
          <KeyValue items={[
            ['Invoice', <span className="mono">{eligibility.invoice.invoice_number}</span>],
            ['Customer', eligibility.invoice.customer_name ?? 'Walk-in'],
            ['Sold', formatDateTime(eligibility.invoice.sold_at)],
            ['Age', `${eligibility.days_since_sale} days`],
            ['Type', <Badge tone={eligibility.invoice.invoice_type === 'GST' ? 'info' : 'neutral'}>
              {eligibility.invoice.invoice_type}</Badge>],
          ]} />

          {eligibility.invoice.invoice_type === 'GST' && (
            <Alert tone="info" title="This will issue a GST credit note">
              A return against a GST invoice is reported to GST as a credit note with its own number,
              linked to the original invoice. Refunding without one does not reconcile.
            </Alert>
          )}

          <DataTable rows={eligibility.lines}
            columns={[
              { key: 'p', header: 'Item', render: (l: any) => (
                <div>{l.product_name}
                  <div className="muted small">
                    sold {num(l.sold_qty)} · already returned {num(l.already_returned)}
                  </div></div>
              ) },
              { key: 'route', header: '', render: (l: any) =>
                l.route === 'RETURN' ? <Badge tone="good">returnable</Badge>
                : l.route === 'WARRANTY_CLAIM' ? <Badge tone="warning">past window — warranty</Badge>
                : l.route === 'FULLY_RETURNED' ? <Badge tone="neutral">fully returned</Badge>
                : <Badge tone="critical">outside window</Badge> },
              { key: 'q', header: 'Return qty', align: 'right', render: (l: any) => (
                <input type="number" min={0} max={l.returnable_qty} step="any" disabled={l.returnable_qty <= 0}
                  style={{ width: 100, textAlign: 'right', padding: '5px 8px' }}
                  value={qtys[l.line_id] ?? 0}
                  onChange={(e) => setQtys({ ...qtys, [l.line_id]: Number(e.target.value) })} />
              ) },
              { key: 'c', header: 'Condition', render: (l: any) => (
                <select style={{ width: 140 }} disabled={!(qtys[l.line_id] > 0)}
                  value={conditions[l.line_id] ?? 'RESELLABLE'}
                  onChange={(e) => setConditions({ ...conditions, [l.line_id]: e.target.value })}>
                  <option value="RESELLABLE">Resellable</option>
                  <option value="DAMAGED">Damaged</option>
                </select>
              ) },
            ]} />

          <div className="grid cols-2">
            <Field label="Reason" required>
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Choose…</option>
                <option>Customer changed mind</option>
                <option>Wrong item billed</option>
                <option>Damaged on delivery</option>
                <option>Size or specification mismatch</option>
                <option>Faulty</option>
              </select>
            </Field>
            <Field label="Refund by">
              <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
                <option value="CREDIT">Store credit</option>
              </select>
            </Field>
          </div>

          <Alert tone="warning" title="Loyalty points are settled first">
            Points earned on this purchase are revoked, and any points spent on it come back as points —
            not as cash. Only the remaining money portion is refunded.
          </Alert>
        </div>
      )}
    </Modal>
  );
}
