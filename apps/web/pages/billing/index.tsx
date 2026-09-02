// ============================================================================
// Billing / POS (Section 3)
//
// The counter screen. Design decisions that follow from the requirements:
//  • the line price is captured when an item enters the cart and shown as locked
//    (3.10) — an admin price change mid-sale does not move it under the customer
//  • the cashier picks a sale unit (piece / box / metre) and the conversion to
//    base units is shown, never hidden (2.2.1)
//  • tax-inclusive vs exclusive is labelled per line, so it is never ambiguous (2.8)
//  • split payment must reconcile to the bill before the button enables (3.2)
//  • an offline sale is queued locally and replayed with a client_txn_id (3.5)
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  apiGet, apiPost, apiPut, apiDelete, downloadFile, fetcher, inr, num, withBranch, formatDateTime,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, KeyValue, Modal,
  PageHeader, RequirePermission, SearchInput, StatusBadge, StatTile, Tabs, useDebounced,
} from '../../components/ui';

interface Product {
  product_id: string; name: string; sku: string; base_unit: string;
  selling_price: string; gst_rate_pct: string; default_price_type: 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';
  available_qty: string | null; batch_tracked: boolean; serial_tracked: boolean;
}
interface CartLine {
  key: string;
  product_id: string; name: string; sku: string;
  unit_label: string; multiplier: number;
  qty: number;
  rate: number;                         // per BASE unit, locked at scan (3.10)
  catalog_rate: number;                 // the list price this line started from

  gst_rate: number;
  price_type: 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';
  discount: number;
  available: number;
}
interface TillSession {
  session_id: string; counter_id: string; opening_float: string; status: string;
  cash_sales: string; cash_drops: string; petty_expenses: string; expected_drawer_cash: string;
}

const OFFLINE_QUEUE_KEY = 'erp_offline_bills';

/** 3.1.1 — the same half-up rule the server uses, so the cart preview and the
 *  printed invoice agree to the paisa. */
function round2(n: number): number {
  return Math.round(Number((Math.abs(n) * 100).toFixed(6))) / 100 * Math.sign(n || 1);
}

function computeLine(l: CartLine) {
  const baseQty = l.qty * l.multiplier;
  const gross = round2(baseQty * l.rate);
  const net = round2(gross - Math.min(l.discount, gross));
  const taxable = l.gst_rate > 0 && l.price_type === 'TAX_INCLUSIVE'
    ? round2(net / (1 + l.gst_rate / 100))
    : net;
  const cgst = l.gst_rate > 0 ? round2((taxable * (l.gst_rate / 2)) / 100) : 0;
  return { baseQty, gross, taxable, cgst, sgst: cgst, total: round2(taxable + cgst * 2) };
}

export default function BillingPage() {
  return (
    <RequirePermission permission="view_billing">
      <BillingScreen />
    </RequirePermission>
  );
}

function BillingScreen() {
  const { user, can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<'pos' | 'invoices' | 'till' | 'conflicts'>('pos');
  const [offlineCount, setOfflineCount] = useState(0);

  useEffect(() => {
    try {
      setOfflineCount(JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]').length);
    } catch { setOfflineCount(0); }
  }, [tab]);

  const { data: conflicts } = useSWR<any[]>(
    withBranch('/api/billing/stock-conflicts', activeBranchId), fetcher);

  return (
    <>
      <PageHeader
        title={t('navBilling')}
        subtitle="Counter sales, till reconciliation and invoice history"
      />
      {offlineCount > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="warning" title={`${offlineCount} sale(s) waiting to sync`}>
            These were billed while the connection was down. They will upload automatically —
            each carries its own reference, so nothing is billed twice.
          </Alert>
        </div>
      )}
      <Tabs
        active={tab}
        onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'pos', label: t('newBill') },
          { key: 'invoices', label: t('invoices') },
          { key: 'till', label: 'Till session' },
          { key: 'conflicts', label: 'Stock conflicts', count: conflicts?.length },
        ]}
      />
      {tab === 'pos' && <PosTab />}
      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'till' && <TillTab />}
      {tab === 'conflicts' && <ConflictsTab />}
    </>
  );
}

// ── POS ─────────────────────────────────────────────────────────────────────
function PosTab() {
  const { activeBranchId, user } = useAuth();
  const { t } = useI18n();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const search = useDebounced(query, 250);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<any | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const custSearch = useDebounced(customerQuery, 250);
  const [invoiceType, setInvoiceType] = useState<'GST' | 'NON_GST'>('GST');
  const [payments, setPayments] = useState<{ method: string; amount: number; ref_no?: string }[]>([
    { method: 'CASH', amount: 0 },
  ]);
  const [busy, setBusy] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<any | null>(null);
  // ── Review before finalising (Sections 11, 62) ───────────────────────────
  // `draft` is the SERVER's copy of the bill, re-priced by the server on every
  // save. The review screen renders that object and never the local cart totals,
  // which is the whole point: what the cashier approves is what the server will
  // charge, not what the browser calculated.
  const [draft, setDraft] = useState<any | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [overridePin, setOverridePin] = useState('');
  const [pinModal, setPinModal] = useState<null | 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT'>(null);
  // A manager's approval is a single-use grant tied to this purpose, this branch
  // and this cashier — not the manager's user id, which would be reusable forever.
  const [approvals, setApprovals] = useState<Record<string, string>>({});

  const { data: settings } = useSWR<any>('/api/admin/settings/effective', fetcher);
  const { data: products } = useSWR<Product[]>(
    search ? `/api/catalog/products?limit=25&q=${encodeURIComponent(search)}` : '/api/catalog/products?limit=25',
    fetcher);
  const { data: customers } = useSWR<any[]>(
    custSearch ? `/api/customers?limit=8&q=${encodeURIComponent(custSearch)}` : null, fetcher);
  const { data: tills, mutate: refreshTills } = useSWR<TillSession[]>(
    withBranch('/api/billing/till-sessions?status=OPEN&mine=true', activeBranchId), fetcher);

  const openTill = tills?.[0];
  const discountLimit = Number(settings?.staff_discount_limit_pct ?? 5);

  const totals = useMemo(() => {
    const computed = cart.map(computeLine);
    const subtotal = round2(computed.reduce((s, c) => s + c.taxable, 0));
    const cgst = round2(computed.reduce((s, c) => s + c.cgst, 0));
    const discountTotal = round2(cart.reduce((s, l) => s + Math.min(l.discount, computeLine(l).gross), 0));
    const grand = round2(subtotal + cgst * 2);
    const grossBeforeDiscount = round2(computed.reduce((s, c) => s + c.gross, 0)) + discountTotal;
    return {
      subtotal, cgst, sgst: cgst, grand, discountTotal,
      discountPct: grossBeforeDiscount > 0 ? (discountTotal / grossBeforeDiscount) * 100 : 0,
    };
  }, [cart]);

  const paidTotal = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const balance = round2(totals.grand - paidTotal);
  // The server measures the give-away against the CATALOG price, so a lowered
  // line rate counts as a discount just as a typed one does. This preview mirrors
  // that, or the cashier would be surprised by a refusal at the end of the sale.
  const catalogValue = round2(cart.reduce((sum, l) => sum + l.catalog_rate * l.qty * l.multiplier, 0));
  const givenAway = round2(cart.reduce((sum, l) =>
    sum + Math.max(l.catalog_rate - l.rate, 0) * l.qty * l.multiplier + l.discount, 0));
  const givenAwayPct = catalogValue > 0 ? (givenAway / catalogValue) * 100 : 0;
  const needsDiscountApproval = givenAwayPct > discountLimit + 0.001
    && user?.role !== 'OWNER_ADMIN' && user?.role !== 'BRANCH_MANAGER';

  // Keep the first payment line in step with the bill so the common case (one
  // cash payment for the full amount) needs no typing at all.
  useEffect(() => {
    setPayments((prev) => {
      if (prev.length !== 1) return prev;
      return [{ ...prev[0], amount: totals.grand }];
    });
  }, [totals.grand]);

  function addToCart(p: Product) {
    const gst = Number(p.gst_rate_pct ?? 0);
    const rate = Number(p.selling_price ?? 0);
    if (!rate) { toast.error(new Error(`"${p.name}" has no selling price set.`)); return; }
    setCart((prev) => {
      const existing = prev.find((l) => l.product_id === p.product_id && l.multiplier === 1);
      if (existing) {
        return prev.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, {
        key: `${p.product_id}-${Date.now()}`,
        product_id: p.product_id, name: p.name, sku: p.sku,
        unit_label: p.base_unit, multiplier: 1,
        qty: 1,
        rate,                               // 3.10 — locked here, at scan time
        catalog_rate: rate,                 // kept so a later edit reads as a discount
        gst_rate: invoiceType === 'NON_GST' ? 0 : gst,
        price_type: p.default_price_type,
        discount: 0,
        available: Number(p.available_qty ?? 0),
      }];
    });
    setQuery('');
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }
  function clearCart() {
    setCart([]); setCustomer(null); setPayments([{ method: 'CASH', amount: 0 }]);
    setApprovals({});
    setDraft(null); setReviewing(false);
  }

  /** 3.10 — the explicit refresh. Prices only move when the cashier asks. */
  async function refreshPrices() {
    try {
      const fresh = await apiGet<Product[]>('/api/catalog/products?limit=200');
      let changed = 0;
      setCart((prev) => prev.map((l) => {
        const p = fresh.find((f) => f.product_id === l.product_id);
        if (!p) return l;
        const rate = Number(p.selling_price);
        if (Math.abs(rate - l.rate) > 0.001) { changed++; return { ...l, rate, catalog_rate: rate }; }
        return l;
      }));
      toast.success(changed ? `${changed} line(s) repriced.` : 'All prices are already current.');
    } catch (err) { toast.error(err); }
  }

  async function verifyPin(purpose: 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT') {
    try {
      const res = await apiPost<{ approval_id: string; approver_name: string; expires_in_minutes: number }>(
        '/api/auth/verify-override-pin', { pin: overridePin, purpose });
      setApprovals((prev) => ({ ...prev, [purpose]: res.approval_id }));
      setPinModal(null); setOverridePin('');
      toast.success(`Approved by ${res.approver_name}`,
        `Valid for this sale only, for the next ${res.expires_in_minutes} minutes.`);
    } catch (err) { toast.error(err); }
  }

  /** The cart, in the shape both the draft and the sale endpoints accept. */
  function billBody() {
    return {
      invoice_type: invoiceType,
      customer_id: customer?.customer_id ?? null,
      lines: cart.map((l) => ({
        product_id: l.product_id,
        qty_in_sale_unit: l.qty,
        rate_locked_at_scan: l.rate,
        price_type: l.price_type,
        discount_amount: l.discount || 0,
      })),
      payments: payments.filter((p) => Number(p.amount) > 0)
        .map((p) => ({ method: p.method, amount: Number(p.amount), ref_no: p.ref_no || undefined })),
    };
  }

  /**
   * Saves the bill as a draft and opens the review screen.
   *
   * Nothing is committed here: no invoice number is drawn, no stock moves, no
   * ledger entry is written. The response is the server's own pricing of the
   * basket, which is what the review screen then shows.
   */
  async function openReview() {
    if (!cart.length) return;
    setBusy(true);
    try {
      const saved = draft?.invoice_id
        ? await apiPut<any>(`/api/billing/drafts/${draft.invoice_id}`, billBody())
        : await apiPost<any>('/api/billing/drafts', billBody());
      setDraft(saved);
      setReviewing(true);
    } catch (err) { toast.error(err); }
    finally { setBusy(false); }
  }

  /** Back to the cart. The draft stays on the server so nothing is retyped. */
  function backToEdit() { setReviewing(false); }

  async function discardDraft() {
    if (!draft?.invoice_id) { clearCart(); return; }
    setBusy(true);
    try {
      await apiDelete(`/api/billing/drafts/${draft.invoice_id}`);
      clearCart();
      toast.success('Draft discarded.');
    } catch (err) { toast.error(err); }
    finally { setBusy(false); }
  }

  /**
   * Finalises the reviewed draft. The lines are NOT re-sent: the server bills
   * what it stored and re-priced, so editing the page in a browser console
   * between review and finalise changes nothing.
   */
  async function finalizeDraft() {
    if (!draft?.invoice_id) return;
    const payable = Number(draft?.totals?.payable ?? 0);
    const paid = round2(payments.reduce((sum, pp) => sum + (Number(pp.amount) || 0), 0));
    if (Math.abs(paid - payable) > 0.01) {
      toast.error(new Error(`Payments are ₹${Math.abs(payable - paid).toFixed(2)} ${paid < payable ? 'short' : 'over'}.`));
      return;
    }
    if (needsDiscountApproval && !approvals.DISCOUNT) { setPinModal('DISCOUNT'); return; }
    setBusy(true);
    try {
      const invoice = await apiPost<any>(`/api/billing/drafts/${draft.invoice_id}/finalize`, {
        till_session_id: openTill?.session_id ?? null,
        discount_approval_id: approvals.DISCOUNT ?? undefined,
        negative_stock_approval_id: approvals.NEGATIVE_STOCK ?? undefined,
        credit_approval_id: approvals.CREDIT_LIMIT ?? undefined,
        payments: payments.filter((pp) => Number(pp.amount) > 0)
          .map((pp) => ({ method: pp.method, amount: Number(pp.amount), ref_no: pp.ref_no || undefined })),
      });
      setLastInvoice(invoice);
      clearCart();
      void refreshTills();
      toast.success(`Bill ${invoice.invoice_number} created`, inr(invoice.grand_total, { decimals: true }));
    } catch (err: any) {
      if (err?.status === 409 && /manager PIN/i.test(String(err.message))) {
        setPinModal(/credit limit/i.test(String(err.message)) ? 'CREDIT_LIMIT' : 'NEGATIVE_STOCK');
      }
      toast.error(err);
    } finally { setBusy(false); }
  }

  async function completeSale() {
    if (!cart.length) return;
    if (Math.abs(balance) > 0.01) {
      toast.error(new Error(`Payments are ₹${Math.abs(balance).toFixed(2)} ${balance > 0 ? 'short' : 'over'}.`));
      return;
    }
    if (needsDiscountApproval && !approvals.DISCOUNT) { setPinModal('DISCOUNT'); return; }

    const body = {
      invoice_type: invoiceType,
      customer_id: customer?.customer_id ?? null,
      till_session_id: openTill?.session_id ?? null,
      discount_approval_id: approvals.DISCOUNT ?? undefined,
      negative_stock_approval_id: approvals.NEGATIVE_STOCK ?? undefined,
      credit_approval_id: approvals.CREDIT_LIMIT ?? undefined,
      lines: cart.map((l) => ({
        product_id: l.product_id,
        qty_in_sale_unit: l.qty,
        rate_locked_at_scan: l.rate,
        price_type: l.price_type,
        discount_amount: l.discount || 0,
      })),
      payments: payments.filter((p) => Number(p.amount) > 0)
        .map((p) => ({ method: p.method, amount: Number(p.amount), ref_no: p.ref_no || undefined })),
    };

    setBusy(true);
    try {
      const invoice = await apiPost<any>('/api/billing/invoices', body);
      setLastInvoice(invoice);
      clearCart();
      void refreshTills();
      toast.success(`Bill ${invoice.invoice_number} created`, inr(invoice.grand_total, { decimals: true }));
    } catch (err: any) {
      // 3.5 — a network failure must not lose the sale. It is queued locally with
      // its own id and replayed; the server ignores duplicates.
      if (err?.status === 0) {
        const queued = { ...body, client_txn_id: crypto.randomUUID(), device_created_at: new Date().toISOString() };
        try {
          const list = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
          list.push(queued);
          localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(list));
          clearCart();
          toast.toast('Saved offline', {
            tone: 'info',
            message: 'The connection is down. This sale is queued and will upload when you are back online.',
          });
        } catch { toast.error(err); }
      } else if (err?.status === 409 && /manager PIN/i.test(String(err.message))) {
        setPinModal(/credit limit/i.test(String(err.message)) ? 'CREDIT_LIMIT' : 'NEGATIVE_STOCK');
        toast.error(err);
      } else {
        toast.error(err);
      }
    } finally { setBusy(false); }
  }

  // Drain the offline queue whenever the browser reports it is back online.
  useEffect(() => {
    async function drain() {
      let list: any[] = [];
      try { list = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); } catch { return; }
      if (!list.length) return;
      const remaining: any[] = [];
      for (const item of list) {
        try { await apiPost('/api/billing/invoices', item); }
        catch (err: any) { if (err?.status === 0) remaining.push(item); }
      }
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
      if (remaining.length < list.length) {
        toast.success(`${list.length - remaining.length} offline sale(s) synced.`);
      }
    }
    window.addEventListener('online', drain);
    void drain();
    return () => window.removeEventListener('online', drain);
  }, [toast]);

  // The review step takes over the whole POS panel rather than opening a modal:
  // this is the screen the cashier turns towards the customer, and a dialog over
  // a half-visible cart is the wrong thing to show them.
  if (reviewing && draft) {
    return (
      <>
        <ReviewScreen
          draft={draft} payments={payments} setPayments={setPayments}
          openTill={openTill} busy={busy}
          onEdit={backToEdit}
          onFinalize={() => void finalizeDraft()}
          onDiscard={() => void discardDraft()}
          t={t}
        />
        <PinModal purpose={pinModal} pin={overridePin} setPin={setOverridePin}
                  givenAwayPct={givenAwayPct} discountLimit={discountLimit}
                  onClose={() => { setPinModal(null); setOverridePin(''); }}
                  onVerify={verifyPin} />
      </>
    );
  }

  return (
    <>
      {!openTill && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="warning" title="No till session is open">
            Cash sales are only tracked against an open till. Open one on the “Till session”
            tab so the drawer can be reconciled at the end of the shift.
          </Alert>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.15fr) minmax(340px, 0.85fr)' }}>
        {/* ── Left: catalogue search + cart ───────────────────────────────── */}
        <div className="stack">
          <Card title="Find an item" description="Search by name, SKU or barcode — spelling does not have to be exact">
            <SearchInput value={query} onChange={setQuery} placeholder="e.g. cpvc elbow, wire, 8901234500014" />
            <div style={{ marginTop: 12, maxHeight: 240, overflowY: 'auto' }}>
              {(products ?? []).slice(0, 12).map((p) => {
                const avail = Number(p.available_qty ?? 0);
                return (
                  <button key={p.product_id} onClick={() => addToCart(p)}
                    style={{
                      display: 'flex', width: '100%', gap: 10, alignItems: 'center', textAlign: 'left',
                      padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8,
                      background: 'var(--surface-1)', marginBottom: 6, cursor: 'pointer', font: 'inherit',
                    }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 550 }}>{p.name}</span>
                      <span className="muted small mono">{p.sku} · {p.base_unit} · GST {num(p.gst_rate_pct, 0)}%</span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span style={{ display: 'block', fontWeight: 650 }}>{inr(p.selling_price, { decimals: true })}</span>
                      <Badge tone={avail <= 0 ? 'critical' : avail < 5 ? 'warning' : 'neutral'}>
                        {avail <= 0 ? t('outOfStock') : `${num(avail)} ${p.base_unit.toLowerCase()}`}
                      </Badge>
                    </span>
                  </button>
                );
              })}
              {products && products.length === 0 && <EmptyState text="No matching product." />}
            </div>
          </Card>

          <Card title={`${t('cart')} (${cart.length})`} flush
            right={cart.length > 0 && (
              <div className="row tight">
                <Button size="sm" onClick={refreshPrices} title="Re-check every line against the current catalog price">
                  Refresh prices
                </Button>
                <Button size="sm" variant="ghost" onClick={clearCart}>Clear</Button>
              </div>
            )}>
            {cart.length === 0 ? (
              <EmptyState icon="🛒" title="Cart is empty" text="Search above and tap an item to add it." />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('product')}</th>
                      <th style={{ width: 96 }}>{t('quantity')}</th>
                      <th className="num" style={{ width: 110 }}>{t('rate')}</th>
                      <th className="num" style={{ width: 100 }}>{t('discount')}</th>
                      <th className="num" style={{ width: 110 }}>{t('total')}</th>
                      <th style={{ width: 40 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((l) => {
                      const c = computeLine(l);
                      const short = c.baseQty > l.available;
                      return (
                        <tr key={l.key}>
                          <td>
                            <div style={{ fontWeight: 550 }}>{l.name}</div>
                            <div className="muted small">
                              {/* 2.8 — never leave the cashier guessing whether GST is already in the price */}
                              <Badge tone={l.price_type === 'TAX_INCLUSIVE' ? 'neutral' : 'info'}>
                                {l.price_type === 'TAX_INCLUSIVE' ? 'incl. GST' : '+ GST'}
                              </Badge>{' '}
                              {l.gst_rate}% · {c.baseQty} {l.unit_label.toLowerCase()}
                              {short && <span style={{ color: 'var(--status-critical)' }}> · only {num(l.available)} in stock</span>}
                            </div>
                          </td>
                          <td>
                            <input type="number" min={0.01} step="any" value={l.qty}
                              onChange={(e) => updateLine(l.key, { qty: Number(e.target.value) || 0 })}
                              style={{ padding: '5px 8px' }} />
                          </td>
                          <td className="num">
                            <input type="number" min={0} step="any" value={l.rate}
                              onChange={(e) => updateLine(l.key, { rate: Number(e.target.value) || 0 })}
                              style={{ padding: '5px 8px', textAlign: 'right' }} />
                            <div className="muted small" title="Locked when the item was added (3.10)">🔒 locked</div>
                          </td>
                          <td className="num">
                            <input type="number" min={0} step="any" value={l.discount}
                              onChange={(e) => updateLine(l.key, { discount: Number(e.target.value) || 0 })}
                              style={{ padding: '5px 8px', textAlign: 'right' }} />
                          </td>
                          <td className="num" style={{ fontWeight: 650 }}>{inr(c.total, { decimals: true })}</td>
                          <td>
                            <button className="icon-btn" onClick={() => removeLine(l.key)} aria-label="Remove">×</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* ── Right: customer, totals, payment ────────────────────────────── */}
        <div className="stack">
          <Card title={t('customer')}>
            {customer ? (
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{customer.name}</div>
                  <div className="muted small">
                    {customer.phone} · {num(customer.loyalty_points_balance, 0)} points
                    {customer.credit_allowed && ` · credit ${inr(customer.credit_available)} available`}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>Change</Button>
              </div>
            ) : (
              <>
                <SearchInput value={customerQuery} onChange={setCustomerQuery} placeholder="Name or phone…" />
                <div style={{ marginTop: 8 }}>
                  {(customers ?? []).map((c) => (
                    <button key={c.customer_id} onClick={() => { setCustomer(c); setCustomerQuery(''); }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
                        border: '1px solid var(--border)', borderRadius: 8, marginBottom: 5,
                        background: 'var(--surface-1)', cursor: 'pointer', font: 'inherit',
                      }}>
                      <b>{c.name}</b> <span className="muted small">{c.phone}</span>
                    </button>
                  ))}
                  {!customerQuery && <div className="muted small">Leave blank for a {t('walkIn').toLowerCase()}.</div>}
                </div>
              </>
            )}
          </Card>

          <Card title="Bill">
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="label" style={{ flex: 1 }}>Invoice type</span>
              <div className="segmented">
                <button className={invoiceType === 'GST' ? 'active' : ''}
                  onClick={() => { setInvoiceType('GST'); setCart((c) => c.map((l) => ({ ...l }))); }}>GST</button>
                <button className={invoiceType === 'NON_GST' ? 'active' : ''}
                  onClick={() => { setInvoiceType('NON_GST'); setCart((c) => c.map((l) => ({ ...l, gst_rate: 0 }))); }}>
                  Non-GST
                </button>
              </div>
            </div>

            <dl className="kv">
              <dt>{t('subtotal')}</dt><dd className="num">{inr(totals.subtotal, { decimals: true })}</dd>
              {totals.discountTotal > 0 && (
                <>
                  <dt>{t('discount')}</dt>
                  <dd className="num">− {inr(totals.discountTotal, { decimals: true })} ({totals.discountPct.toFixed(1)}%)</dd>
                </>
              )}
              {invoiceType === 'GST' && (
                <>
                  <dt>CGST</dt><dd className="num">{inr(totals.cgst, { decimals: true })}</dd>
                  <dt>SGST</dt><dd className="num">{inr(totals.sgst, { decimals: true })}</dd>
                </>
              )}
            </dl>
            <div className="divider" />
            <div className="row" style={{ fontSize: 19, fontWeight: 700 }}>
              <span style={{ flex: 1 }}>{t('grandTotal')}</span>
              <span className="num">{inr(totals.grand, { decimals: true })}</span>
            </div>

            {givenAway > 0 && (
              <div className="muted small" style={{ marginTop: 8 }}>
                {inr(givenAway, { decimals: true })} off the catalog price
                ({givenAwayPct.toFixed(1)}%), counting both typed discounts and lowered rates.
              </div>
            )}
            {needsDiscountApproval && (
              <div style={{ marginTop: 12 }}>
                <Alert tone="warning" title={`This bill is ${givenAwayPct.toFixed(1)}% below catalog, above the ${discountLimit}% staff limit`}>
                  {approvals.DISCOUNT
                    ? 'A manager has approved it for this sale.'
                    : 'A manager PIN is needed to complete this sale.'}
                </Alert>
              </div>
            )}
          </Card>

          <Card title={t('payment')} description="Split across as many methods as you need">
            <div className="stack">
              <PaymentEditor payments={payments} setPayments={setPayments} payable={totals.grand} t={t} />
              {payments.some((p) => p.method === 'CREDIT') && !customer && (
                <Alert tone="critical">A credit sale needs an identified customer.</Alert>
              )}
              {Math.abs(balance) > 0.01 && (
                <Alert tone={balance > 0 ? 'warning' : 'critical'}>
                  {balance > 0
                    ? `${inr(balance, { decimals: true })} still to collect.`
                    : `${inr(-balance, { decimals: true })} over the bill amount.`}
                </Alert>
              )}
            </div>
          </Card>

          {/* Review is the primary path (Section 62): prepare, check with the
              customer, then finalise. Finishing straight from the cart stays
              available for the fast counter sale where there is nothing to review. */}
          <Button variant="primary" size="lg" className="block" busy={busy}
            disabled={!cart.length}
            onClick={() => void openReview()}>
            {t('reviewBill')} · {inr(totals.grand)}
          </Button>
          <Button size="lg" className="block" busy={busy}
            disabled={!cart.length || Math.abs(balance) > 0.01}
            onClick={() => void completeSale()}>
            {t('completeSale')} · {inr(totals.grand)}
          </Button>
        </div>
      </div>

      {/* Manager override PIN (3.4 / 3.8) */}
      <PinModal purpose={pinModal} pin={overridePin} setPin={setOverridePin}
                givenAwayPct={givenAwayPct} discountLimit={discountLimit}
                onClose={() => { setPinModal(null); setOverridePin(''); }}
                onVerify={verifyPin} />

      {/* Post-sale receipt actions */}
      <Modal open={Boolean(lastInvoice)} onClose={() => setLastInvoice(null)} title="Sale complete"
        footer={<>
          <Button onClick={() => setLastInvoice(null)}>Done</Button>
          <Button variant="primary"
            onClick={() => void downloadFile(`/api/billing/invoices/${lastInvoice.invoice_id}/pdf`,
              `Invoice-${lastInvoice.invoice_number}.pdf`)}>
            Download invoice PDF
          </Button>
        </>}>
        <div className="stack">
          <Alert tone="good" title={`Invoice ${lastInvoice?.invoice_number}`}>
            {inr(lastInvoice?.grand_total, { decimals: true })} recorded.
            {lastInvoice?.points_redeemed > 0 && ` ${lastInvoice.points_redeemed} points redeemed.`}
          </Alert>
          {lastInvoice?.warning && <Alert tone="warning">{lastInvoice.warning}</Alert>}
        </div>
      </Modal>
    </>
  );
}

// ── Invoice history ─────────────────────────────────────────────────────────
/**
 * The review screen (Sections 11, 62).
 *
 * Every figure on it comes from `draft`, which is the server's own pricing of the
 * basket — not the local cart. That is deliberate and is the point of the whole
 * step: the cashier and the customer approve the number the server will actually
 * charge. "Edit bill" goes back to the cart, and saving re-prices on the server
 * again, so there is no path where an edit changes the paper without changing the
 * arithmetic.
 */

/**
 * The split-payment editor, shared by the cart and the review screen so the two
 * cannot offer different payment options for the same bill (3.2).
 */

/**
 * The manager-PIN prompt. Shared by the cart and the review screen, because an
 * override can become necessary at either point and the two must ask for it the
 * same way. What comes back is a single-use grant bound to this purpose, branch
 * and cashier — never the manager's user id, which would be reusable forever.
 */
function PinModal({ purpose, pin, setPin, givenAwayPct, discountLimit, onClose, onVerify }: {
  purpose: null | 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT';
  pin: string;
  setPin: (v: string) => void;
  givenAwayPct: number;
  discountLimit: number;
  onClose: () => void;
  onVerify: (purpose: 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT') => void;
}) {
  return (
    <Modal open={purpose !== null} onClose={onClose} title="Manager approval"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => purpose && onVerify(purpose)}>Approve</Button>
      </>}>
      <p className="muted">
        {purpose === 'DISCOUNT'
          ? `This bill is ${givenAwayPct.toFixed(1)}% below the catalog price, above the ${discountLimit}% staff limit.`
          : purpose === 'NEGATIVE_STOCK'
          ? 'System stock is short for one or more items.'
          : 'This sale would take the customer over their credit limit.'}
        {' '}A manager or the owner can approve it with their PIN. The approval covers
        this sale only and expires in a few minutes.
      </p>
      <Field label="Manager PIN">
        <input type="password" inputMode="numeric" maxLength={6} value={pin} autoFocus
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          style={{ letterSpacing: '0.4em', fontSize: 17 }} />
      </Field>
    </Modal>
  );
}

function PaymentEditor({ payments, setPayments, payable, t }: {
  payments: { method: string; amount: number; ref_no?: string }[];
  setPayments: React.Dispatch<React.SetStateAction<{ method: string; amount: number; ref_no?: string }[]>>;
  payable: number;
  t: (k: string) => string;
}) {
  const paid = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const balance = round2(payable - paid);
  return (
    <div className="stack">
      {payments.map((p, i) => (
        <div className="row tight" key={i}>
          <select value={p.method} style={{ width: 130 }} aria-label="Payment method"
            onChange={(e) => setPayments((prev) => prev.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))}>
            <option value="CASH">{t('cash')}</option>
            <option value="UPI">UPI</option>
            <option value="CARD">{t('card')}</option>
            <option value="CREDIT">{t('credit')}</option>
            <option value="LOYALTY_POINTS">{t('points')}</option>
          </select>
          <input type="number" min={0} step="any" value={p.amount} style={{ flex: 1, textAlign: 'right' }}
            aria-label="Amount"
            onChange={(e) => setPayments((prev) => prev.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) || 0 } : x)))} />
          {payments.length > 1 && (
            <button className="icon-btn" aria-label="Remove payment"
              onClick={() => setPayments((prev) => prev.filter((_, j) => j !== i))}>×</button>
          )}
        </div>
      ))}
      <Button size="sm" onClick={() => setPayments((prev) => [...prev, { method: 'UPI', amount: Math.max(balance, 0) }])}>
        + Split
      </Button>
      {(payments.some((p) => p.method === 'UPI' || p.method === 'CARD')) && (
        <Field label="Reference (UPI txn / card auth)">
          <input value={payments.find((p) => p.method === 'UPI' || p.method === 'CARD')?.ref_no ?? ''}
            onChange={(e) => setPayments((prev) => prev.map((x) =>
              (x.method === 'UPI' || x.method === 'CARD') ? { ...x, ref_no: e.target.value } : x))} />
        </Field>
      )}
    </div>
  );
}

function ReviewScreen({
  draft, payments, setPayments, openTill, busy, onEdit, onFinalize, onDiscard, t,
}: {
  draft: any;
  payments: { method: string; amount: number; ref_no?: string }[];
  setPayments: React.Dispatch<React.SetStateAction<{ method: string; amount: number; ref_no?: string }[]>>;
  openTill: TillSession | undefined;
  busy: boolean;
  onEdit: () => void;
  onFinalize: () => void;
  onDiscard: () => void;
  t: (k: string) => string;
}) {
  const totals = draft?.totals ?? {};
  const payable = Number(totals.payable ?? 0);
  const paid = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const shortfall = round2(payable - paid);
  const isGst = draft?.invoice_type === 'GST';

  return (
    <div className="stack">
      <Alert tone="info" title={`${t('reviewBill')} — ${t('draftNotFinal')}`}>
        These are the server&rsquo;s figures, recalculated from the catalog. Nothing has been
        billed yet: no invoice number, no stock movement, no ledger entry. Check the bill with
        the customer, then finalise it.
      </Alert>

      {/* Raised here rather than at finalisation, so the cashier finds out before
          they have told the customer the bill is done. */}
      {(draft?.stock_warnings?.length ?? 0) > 0 && (
        <Alert tone="warning" title="Not enough stock for this bill">
          {draft.stock_warnings.map((w: any) => (
            <div key={w.product_name}>
              {w.product_name} — asked {num(w.requested, 2)}, {Math.max(Number(w.available), 0)} on hand
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            Finalising will be refused unless a manager approves it with a PIN, or the
            quantity is reduced.
          </div>
        </Alert>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.15fr) minmax(320px, 0.85fr)' }}>
        <div className="stack">
          <Card
            title={isGst ? 'Tax invoice preview' : 'Cash memo preview'}
            description={draft?.customer_name
              ? `${draft.customer_name}${draft.customer_phone ? ` · ${draft.customer_phone}` : ''}`
              : 'Walk-in customer'}
            right={<Badge tone={isGst ? 'info' : 'neutral'}>{isGst ? 'GST' : 'Non-GST'}</Badge>}
          >
            <div style={{ overflowX: 'auto' }}>
              <DataTable
                columns={[
                  { key: 'product_name', header: 'Item',
                    render: (r: any) => (
                      <span>
                        <span style={{ display: 'block' }}>{r.product_name}</span>
                        <span className="muted small mono">
                          {r.sku ? `${r.sku} · ` : ''}{r.unit_label}
                          {r.price_changed_since_scan ? ' · price held from scan' : ''}
                        </span>
                      </span>
                    ) },
                  { key: 'qty_in_sale_unit', header: 'Qty', align: 'right',
                    render: (r: any) => num(r.qty_in_sale_unit, 2) },
                  { key: 'rate_locked_at_scan', header: 'Rate', align: 'right',
                    render: (r: any) => inr(r.rate_locked_at_scan, { decimals: true }) },
                  { key: 'discount_amount', header: 'Disc.', align: 'right',
                    render: (r: any) => (Number(r.discount_amount) ? inr(r.discount_amount, { decimals: true }) : '—') },
                  ...(isGst ? [{ key: 'gst_rate_pct', header: 'GST', align: 'right' as const,
                    render: (r: any) => `${num(r.gst_rate_pct, 0)}%` }] : []),
                  { key: 'line_total', header: 'Amount', align: 'right',
                    render: (r: any) => <strong>{inr(r.line_total, { decimals: true })}</strong> },
                ]}
                rows={draft?.lines ?? []}
                emptyText="This draft has no items."
              />
            </div>
          </Card>

          <Card title="Payment" description="The split must settle the bill exactly">
            <PaymentEditor payments={payments} setPayments={setPayments} payable={payable} t={t} />
            {Math.abs(shortfall) > 0.01 && (
              <div style={{ marginTop: 10 }}>
                <Alert tone="warning" title={shortfall > 0 ? 'Payment is short' : 'Payment is over'}>
                  {inr(Math.abs(shortfall), { decimals: true })} {shortfall > 0 ? 'still to collect.' : 'more than the bill.'}
                </Alert>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Bill summary" right={<span className="muted small">{t('serverRecalculated')}</span>}>
            <KeyValue items={[
              ['Items', String(draft?.lines?.length ?? 0)],
              ['Gross', inr(round2(Number(totals.subtotal ?? 0) + Number(totals.discount_total ?? 0)), { decimals: true })],
              ...(Number(totals.discount_total) > 0
                ? [['Discount', `− ${inr(totals.discount_total, { decimals: true })}`] as [string, React.ReactNode]] : []),
              [isGst ? 'Taxable value' : 'Subtotal', inr(totals.subtotal, { decimals: true })],
              ...(isGst && Number(totals.igst_total) > 0
                ? [['IGST', inr(totals.igst_total, { decimals: true })] as [string, React.ReactNode]]
                : isGst
                  ? ([['CGST', inr(totals.cgst_total, { decimals: true })],
                      ['SGST', inr(totals.sgst_total, { decimals: true })]] as [string, React.ReactNode][])
                  : []),
              ...(Number(totals.round_off)
                ? [['Round off', inr(totals.round_off, { decimals: true })] as [string, React.ReactNode]] : []),
            ]} />
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              marginTop: 12, paddingTop: 12, borderTop: '2px solid var(--border)',
            }}>
              <strong>Total payable</strong>
              <strong style={{ fontSize: 22 }}>{inr(payable, { decimals: true })}</strong>
            </div>
            {Number(draft?.given_away) > 0 && (
              <p className="muted small" style={{ marginTop: 8 }}>
                {inr(draft.given_away, { decimals: true })} given away against catalog
                ({num(draft.discount_pct, 1)}%).
              </p>
            )}
            {!openTill && (
              <p className="muted small" style={{ marginTop: 8 }}>
                No till session is open, so cash on this bill will not appear in a drawer count.
              </p>
            )}
          </Card>

          <Card title="Next step">
            <div className="stack" style={{ gap: 8 }}>
              <Button variant="primary" busy={busy}
                      disabled={busy || !draft?.lines?.length || Math.abs(shortfall) > 0.01}
                      onClick={onFinalize}>
                {t('finalizeBill')}
              </Button>
              <Button onClick={onEdit} disabled={busy}>← {t('editBill')}</Button>
              <Button onClick={() => downloadFile(`/api/billing/invoices/${draft.invoice_id}/pdf`,
                                                  `draft-${String(draft.invoice_id).slice(0, 8)}.pdf`)}>
                {t('previewPdf')}
              </Button>
              <Button variant="danger" onClick={onDiscard} disabled={busy}>{t('discardDraft')}</Button>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Finalising assigns the invoice number, moves stock, posts the payment and the
              ledger, and locks the bill. After that a correction has to go through a return,
              a credit note or a void.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function InvoicesTab() {
  const { activeBranchId, can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const [selected, setSelected] = useState<any | null>(null);
  const [voiding, setVoiding] = useState(false);

  const path = withBranch(`/api/billing/invoices?limit=100${search ? `&q=${encodeURIComponent(search)}` : ''}`, activeBranchId);
  const { data, error, isLoading, mutate } = useSWR<any[]>(path, fetcher);

  async function openInvoice(row: any) {
    try { setSelected(await apiGet(`/api/billing/invoices/${row.invoice_id}`)); }
    catch (err) { toast.error(err); }
  }

  async function voidInvoice() {
    if (!selected) return;
    setVoiding(true);
    try {
      await apiPost(`/api/billing/invoices/${selected.invoice_id}/void`, { reason: 'Voided from invoice history' });
      toast.success('Invoice voided', 'Stock has been returned and the movement recorded.');
      setSelected(null); void mutate();
    } catch (err) { toast.error(err); } finally { setVoiding(false); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <SearchInput value={query} onChange={setQuery} placeholder="Invoice number, customer name or phone…" />
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="🧾" title="No invoices" text="Bills you create will appear here." />}>
          {(rows) => (
            <DataTable rows={rows} onRowClick={(r) => void openInvoice(r)}
              footer={`${rows.length} invoice(s)`}
              columns={[
                { key: 'no', header: 'Invoice', nowrap: true, render: (r: any) => <span className="mono">{r.invoice_number}</span> },
                { key: 'date', header: 'Date', nowrap: true, render: (r: any) => formatDateTime(r.server_received_at) },
                { key: 'branch', header: t('branch'), render: (r: any) => r.branch_name },
                { key: 'cust', header: t('customer'), render: (r: any) => r.customer_name ?? <span className="muted">{t('walkIn')}</span> },
                { key: 'type', header: 'Type', render: (r: any) => <Badge tone={r.invoice_type === 'GST' ? 'info' : 'neutral'}>{r.invoice_type}</Badge> },
                { key: 'pay', header: t('payment'), render: (r: any) => <span className="muted small">{r.payment_methods}</span> },
                { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                { key: 'total', header: t('total'), align: 'right', render: (r: any) => inr(r.grand_total, { decimals: true }) },
              ]} />
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} wide
        title={`Invoice ${selected?.invoice_number ?? ''}`}
        footer={<>
          {can('void_invoice') && selected?.status === 'FINAL' && (
            <Button variant="danger" busy={voiding} onClick={() => void voidInvoice()}>Void invoice</Button>
          )}
          <div className="spacer" />
          <Button onClick={() => setSelected(null)}>{t('close')}</Button>
          <Button variant="primary" onClick={() => selected && void downloadFile(
            `/api/billing/invoices/${selected.invoice_id}/pdf`, `Invoice-${selected.invoice_number}.pdf`)}>
            PDF
          </Button>
        </>}>
        {selected && (
          <div className="stack">
            <div className="grid cols-2">
              <div>
                <div className="label">Billed to</div>
                <div>{selected.customer_name ?? t('walkIn')}</div>
                <div className="muted small">{selected.customer_phone}</div>
              </div>
              <div>
                <div className="label">Branch & date</div>
                <div>{selected.branch_name}</div>
                <div className="muted small">{formatDateTime(selected.server_received_at)}</div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Item</th><th className="num">Qty</th><th className="num">Rate</th>
                    <th className="num">Taxable</th><th className="num">GST</th><th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.lines?.map((l: any) => (
                    <tr key={l.line_id}>
                      <td>{l.product_name}<div className="muted small">{l.sku}</div></td>
                      <td className="num">{num(l.qty_in_sale_unit)} {l.unit_label ?? l.base_unit}</td>
                      <td className="num">{inr(l.rate_locked_at_scan, { decimals: true })}</td>
                      <td className="num">{inr(l.taxable_value, { decimals: true })}</td>
                      <td className="num">{inr(Number(l.cgst_amount) + Number(l.sgst_amount) + Number(l.igst_amount), { decimals: true })}</td>
                      <td className="num">{inr(l.line_total, { decimals: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 24 }}>
              <dl className="kv" style={{ minWidth: 260 }}>
                <dt>{t('subtotal')}</dt><dd className="num">{inr(selected.subtotal, { decimals: true })}</dd>
                <dt>CGST</dt><dd className="num">{inr(selected.cgst_total, { decimals: true })}</dd>
                <dt>SGST</dt><dd className="num">{inr(selected.sgst_total, { decimals: true })}</dd>
                {Number(selected.igst_total) > 0 && (<><dt>IGST</dt><dd className="num">{inr(selected.igst_total, { decimals: true })}</dd></>)}
                <dt><b>{t('grandTotal')}</b></dt><dd className="num"><b>{inr(selected.grand_total, { decimals: true })}</b></dd>
              </dl>
            </div>
            {selected.returns?.length > 0 && (
              <Alert tone="info" title="This invoice has returns against it">
                {selected.returns.map((r: any) => r.credit_note_number).filter(Boolean).join(', ') || 'A return was processed.'}
              </Alert>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

// ── Till session (3.3 / 3.3.1) ──────────────────────────────────────────────
function TillTab() {
  const { activeBranchId, can, user } = useAuth();
  const toast = useToast();
  const [openingFloat, setOpeningFloat] = useState(2000);
  const [counterId, setCounterId] = useState('COUNTER-1');
  const [countedCash, setCountedCash] = useState('');
  const [eventModal, setEventModal] = useState<null | 'CASH_DROP' | 'PETTY_EXPENSE_PAYOUT'>(null);
  const [eventAmount, setEventAmount] = useState(0);
  const [eventNote, setEventNote] = useState('');
  const [eventCategory, setEventCategory] = useState('');

  const { data: sessions, mutate } = useSWR<TillSession[]>(
    withBranch('/api/billing/till-sessions?limit=20', activeBranchId), fetcher);
  const open = sessions?.find((s) => s.status === 'OPEN');
  const { data: recon, mutate: mutateRecon } = useSWR<any>(
    open ? `/api/billing/till-sessions/${open.session_id}/reconcile` : null, fetcher);
  const { data: categories } = useSWR<any[]>('/api/expenses/categories', fetcher);

  async function openTill() {
    try {
      await apiPost('/api/billing/till-sessions', { counter_id: counterId, opening_float: openingFloat });
      toast.success('Till opened'); void mutate();
    } catch (err) { toast.error(err); }
  }

  async function addEvent() {
    if (!open || !eventModal) return;
    try {
      await apiPost(`/api/billing/till-sessions/${open.session_id}/events`, {
        event_type: eventModal, amount: eventAmount, note: eventNote,
        category_id: eventModal === 'PETTY_EXPENSE_PAYOUT' ? eventCategory : undefined,
      });
      toast.success(eventModal === 'CASH_DROP' ? 'Cash drop recorded' : 'Petty expense recorded');
      setEventModal(null); setEventAmount(0); setEventNote('');
      void mutateRecon(); void mutate();
    } catch (err) { toast.error(err); }
  }

  async function closeTill() {
    if (!open) return;
    try {
      const res = await apiPost<any>(`/api/billing/till-sessions/${open.session_id}/close`,
        { closing_counted_cash: Number(countedCash) });
      toast.success('Till closed',
        Math.abs(res.variance) < 0.01
          ? 'The drawer balanced exactly.'
          : `Variance of ${inr(res.variance, { decimals: true })} recorded.`);
      setCountedCash(''); void mutate();
    } catch (err) { toast.error(err); }
  }

  if (!open) {
    return (
      <Card title="Open a till session" description="Cash sales are reconciled per counter, per cashier, per shift">
        <div className="stack" style={{ maxWidth: 400 }}>
          <Field label="Counter">
            <input value={counterId} onChange={(e) => setCounterId(e.target.value)} />
          </Field>
          <Field label="Opening float" hint="Cash placed in the drawer at the start of the shift">
            <input type="number" min={0} value={openingFloat} onChange={(e) => setOpeningFloat(Number(e.target.value))} />
          </Field>
          <Button variant="primary" onClick={() => void openTill()}>Open till</Button>
        </div>
      </Card>
    );
  }

  const variance = recon?.counted_cash === null || recon?.counted_cash === undefined
    ? (countedCash === '' ? null : Number(countedCash) - Number(recon?.expected_drawer_cash ?? 0))
    : Number(recon.variance);

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatTile label="Opening float" value={inr(recon?.opening_float)} />
        <StatTile label="Cash sales" value={inr(recon?.cash_sales)} />
        <StatTile label="Cash drops" value={`− ${inr(recon?.cash_drops)}`} hint="Moved to the safe" />
        <StatTile label="Petty payouts" value={`− ${inr(recon?.petty_expenses)}`} hint="Paid from the drawer" />
      </div>

      <div className="grid cols-2">
        <Card title="Expected drawer cash"
          description="Opening float + cash sales − cash drops − petty payouts">
          <div style={{ fontSize: 30, fontWeight: 700 }} className="num">
            {inr(recon?.expected_drawer_cash, { decimals: true })}
          </div>
          <div className="divider" />
          <Field label="Counted cash in the drawer">
            <input type="number" min={0} value={countedCash} placeholder="Count the drawer and enter the total"
              onChange={(e) => setCountedCash(e.target.value)} />
          </Field>
          {variance !== null && (
            <div style={{ marginTop: 12 }}>
              <Alert tone={Math.abs(variance) < 0.01 ? 'good' : Math.abs(variance) < 100 ? 'warning' : 'critical'}>
                {Math.abs(variance) < 0.01
                  ? 'The drawer balances exactly.'
                  : `${variance > 0 ? 'Over' : 'Short'} by ${inr(Math.abs(variance), { decimals: true })}.`}
              </Alert>
            </div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <Button onClick={() => setEventModal('CASH_DROP')}>Record cash drop</Button>
            <Button onClick={() => setEventModal('PETTY_EXPENSE_PAYOUT')}>Petty expense</Button>
            <div className="spacer" />
            <Button variant="primary" disabled={countedCash === ''} onClick={() => void closeTill()}>Close till</Button>
          </div>
        </Card>

        <Card title="Session activity" flush>
          <DataTable rows={recon?.events ?? []}
            emptyText="No cash movements yet this shift."
            columns={[
              { key: 'type', header: 'Event', render: (e: any) => (
                <Badge tone={e.event_type === 'CASH_SALE' ? 'good' : e.event_type === 'CLOSING_COUNT' ? 'neutral' : 'warning'}>
                  {e.event_type.replace(/_/g, ' ').toLowerCase()}
                </Badge>
              ) },
              { key: 'note', header: 'Note', render: (e: any) => e.note ?? <span className="muted">—</span> },
              { key: 'ack', header: 'Acknowledged by', render: (e: any) => e.acknowledged_by_name ?? <span className="muted">—</span> },
              { key: 'time', header: 'Time', nowrap: true, render: (e: any) => formatDateTime(e.created_at) },
              { key: 'amt', header: 'Amount', align: 'right', render: (e: any) => inr(e.amount, { decimals: true }) },
            ]} />
        </Card>
      </div>

      <Modal open={eventModal !== null} onClose={() => setEventModal(null)}
        title={eventModal === 'CASH_DROP' ? 'Record a cash drop' : 'Record a petty expense'}
        footer={<>
          <Button onClick={() => setEventModal(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => void addEvent()}>Record</Button>
        </>}>
        <div className="stack">
          <Alert tone="info">
            {eventModal === 'CASH_DROP'
              ? 'Cash moved from the drawer to the safe or the owner. It needs a manager or owner to acknowledge it, and it stops the till reading short at close.'
              : 'A small expense paid straight out of the drawer. It becomes a real expense record against a category, not an untracked shortfall.'}
          </Alert>
          <Field label="Amount">
            <input type="number" min={0.01} value={eventAmount} autoFocus
              onChange={(e) => setEventAmount(Number(e.target.value))} />
          </Field>
          {eventModal === 'PETTY_EXPENSE_PAYOUT' && (
            <Field label="Expense category">
              <select value={eventCategory} onChange={(e) => setEventCategory(e.target.value)}>
                <option value="">Choose…</option>
                {(categories ?? []).map((c: any) => (
                  <option key={c.category_id} value={c.category_id}>{c.name}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Note">
            <input value={eventNote} onChange={(e) => setEventNote(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

// ── Offline stock conflicts (3.5.1) ─────────────────────────────────────────
function ConflictsTab() {
  const { activeBranchId, can } = useAuth();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch('/api/billing/stock-conflicts', activeBranchId), fetcher);

  async function resolve(id: string, resolution: string) {
    try {
      await apiPost(`/api/billing/stock-conflicts/${id}/resolve`, { resolution });
      toast.success('Conflict resolved'); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <Card flush title="Sales that arrived against insufficient stock"
      description="A sale already made at the counter is never voided automatically — it is surfaced here for a person to decide.">
      <AsyncSection data={data} error={error} isLoading={isLoading}
        empty={<EmptyState icon="✓" title="Nothing to resolve" text="No offline sale has conflicted with stock." />}>
        {(rows) => (
          <DataTable rows={rows}
            columns={[
              { key: 'inv', header: 'Invoice', render: (r: any) => <span className="mono">{r.invoice_number}</span> },
              { key: 'prod', header: 'Product', render: (r: any) => r.product_name },
              { key: 'req', header: 'Sold', align: 'right', render: (r: any) => num(r.requested_qty) },
              { key: 'avail', header: 'Available', align: 'right', render: (r: any) => num(r.available_qty) },
              { key: 'when', header: 'Raised', nowrap: true, render: (r: any) => formatDateTime(r.created_at) },
              { key: 'act', header: '', render: (r: any) => can('resolve_stock_conflict') && (
                <select defaultValue="" onChange={(e) => e.target.value && void resolve(r.conflict_id, e.target.value)}
                  style={{ width: 190 }}>
                  <option value="">Resolve as…</option>
                  <option value="SUBSTITUTED">Substituted item</option>
                  <option value="BACKORDERED">Backordered</option>
                  <option value="NEGATIVE_STOCK_OVERRIDE">Stock count was wrong</option>
                  <option value="CANCELLED">Cancelled with customer</option>
                </select>
              ) },
            ]} />
        )}
      </AsyncSection>
    </Card>
  );
}
