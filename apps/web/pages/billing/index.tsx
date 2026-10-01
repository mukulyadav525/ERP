// ============================================================================
// Billing / POS (spec §15–§24)
//
// The counter screen. What the design is built around:
//  • keyboard first — the item search holds focus; ↑/↓/Enter pick an item; a
//    barcode scanner (a keyboard) types a code and presses Enter; after each add
//    the caret returns to the search, so a queue of items needs no mouse
//  • sale units — every line picks the unit it is sold in (PCS, BOX, 100 G, KG);
//    the rate shown is per THAT unit and the stock it takes is in base units
//  • the server is the arithmetic — the cart shows a preview, but Review saves a
//    draft that the server prices, and Finalise bills what the server stored
//  • "All branches" is never where a sale happens — an owner picks a branch first
//  • an offline sale is queued locally with its own id and replayed; the server
//    ignores the duplicate if the first attempt did in fact land
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import useSWR, { useSWRConfig } from 'swr';
import {
  apiGet, apiPost, apiPut, apiDelete, downloadFile, printFile, whatsappShareUrl, idempotencyKey,
  fetcher, inr, num, withBranch, formatDateTime, formatDate, qtyWithUnit, ApiError,
} from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, BranchGate, Button, Card, DataTable, EmptyState, Field, KeyValue, Modal,
  PageHeader, RequirePermission, SearchInput, StatusBadge, StatTile, Tabs, useDebounced, Pager,
} from '../../components/ui';
import {
  CustomerPicker, ProductPicker, defaultUnit, stateName,
  type CustomerHit, type ProductHit, type UnitOption,
} from '../../components/pickers';
import { Icon } from '../../components/icons';

// ── Types ────────────────────────────────────────────────────────────────────
interface CartLine {
  key: string;
  product_id: string; name: string; sku: string; base_unit_label: string;
  units: UnitOption[];
  unit_id: string;
  qty: string;                 // as typed, so "0." and "" are editable
  rate_base: number;           // per BASE unit, locked when the item was added (3.10)
  catalog_rate: number;        // per base unit, the list price it started from
  gst_rate: number;
  price_type: 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';
  discount: string;
  available: number;           // base units
}
interface Payment { method: string; amount: string; ref_no?: string }
interface DocFields { order_no: string; challan_no: string; challan_date: string; vehicle_no: string; due_date: string; place_of_delivery: string; notes: string }
interface TillSession {
  session_id: string; counter_id: string; opening_float: string; status: string;
  cash_sales: string; cash_receipts?: string; cash_drops: string; petty_expenses: string; expected_drawer_cash: string;
  cashier_name?: string; cashier_user_id?: string; opened_at?: string;
}

const OFFLINE_QUEUE_KEY = 'erp_offline_bills';
const EMPTY_DOC: DocFields = { order_no: '', challan_no: '', challan_date: '', vehicle_no: '', due_date: '', place_of_delivery: '', notes: '' };
const METHODS: Array<[string, string]> = [
  ['CASH', 'Cash'], ['UPI', 'UPI'], ['CARD', 'Card'], ['BANK_TRANSFER', 'Bank transfer'],
  ['CREDIT', 'Credit (on account)'], ['LOYALTY_POINTS', 'Loyalty points'],
];

/** 3.1.1 — the same half-up rule the server uses. */
function round2(n: number): number {
  return Math.round(Number((Math.abs(n) * 100).toFixed(6))) / 100 * Math.sign(n || 1);
}
const toNum = (s: string | number | undefined | null) => {
  const n = typeof s === 'number' ? s : Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function unitOf(l: CartLine): UnitOption | undefined { return l.units.find((u) => u.product_unit_id === l.unit_id); }
function multiplierOf(l: CartLine): number { return Number(unitOf(l)?.multiplier_to_base ?? 1) || 1; }

/** A PREVIEW of the line. The server's figures on the review screen are what bills. */
function previewLine(l: CartLine) {
  const baseQty = toNum(l.qty) * multiplierOf(l);
  const gross = round2(baseQty * l.rate_base);
  const net = round2(gross - Math.min(toNum(l.discount), gross));
  const g = l.gst_rate;
  const taxable = g > 0 && l.price_type === 'TAX_INCLUSIVE' ? round2(net / (1 + g / 100)) : net;
  const tax = g > 0 ? (l.price_type === 'TAX_INCLUSIVE' ? round2(net - taxable) : round2((taxable * g) / 100)) : 0;
  return { baseQty, gross, taxable, tax, total: round2(taxable + tax) };
}

export default function BillingPage() {
  return (
    <RequirePermission permission="view_billing">
      <BillingScreen />
    </RequirePermission>
  );
}

const BILLING_TABS = ['pos', 'drafts', 'invoices', 'till', 'conflicts'] as const;
type BillingTab = typeof BILLING_TABS[number];

function BillingScreen() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const initialTab: BillingTab = (() => {
    const q = router.query;
    if (typeof q.tab === 'string' && (BILLING_TABS as readonly string[]).includes(q.tab)) return q.tab as BillingTab;
    if (typeof q.invoice === 'string') return 'invoices';
    return 'pos';
  })();
  const [tab, setTab] = useState<BillingTab>(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const [offlineCount, setOfflineCount] = useState(0);

  useEffect(() => {
    try { setOfflineCount(JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]').length); }
    catch { setOfflineCount(0); }
  }, [tab]);

  const { data: conflicts } = useSWR<any[]>(
    can('view_billing') ? withBranch('/api/billing/stock-conflicts', activeBranchId) : null, fetcher);
  const { data: drafts } = useSWR<any[]>(
    can('create_invoice') ? withBranch('/api/billing/drafts?limit=50', activeBranchId) : null, fetcher);

  return (
    <>
      <PageHeader title={t('navBilling')} subtitle="Counter sales, drafts, invoice history and the till" />
      {offlineCount > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="warning" title={`${offlineCount} sale(s) waiting to sync`}>
            These were billed while the connection was down. They upload automatically when the
            connection returns — each carries its own reference, so nothing is billed twice.
          </Alert>
        </div>
      )}
      <Tabs active={tab} onChange={(k) => setTab(k as BillingTab)}
        tabs={[
          ...(can('create_invoice') ? [{ key: 'pos', label: t('newBill') }] : []),
          ...(can('create_invoice') ? [{ key: 'drafts', label: t('drafts'), count: drafts?.length || undefined }] : []),
          { key: 'invoices', label: t('invoices') },
          ...(can('manage_till') ? [{ key: 'till', label: 'Till' }] : []),
          { key: 'conflicts', label: 'Stock conflicts', count: conflicts?.length || undefined },
        ]} />
      {tab === 'pos' && can('create_invoice') && <BranchGate what="this bill"><PosTab /></BranchGate>}
      {tab === 'drafts' && <DraftsTab onResume={(id) => { void router.push(`/billing?draft=${id}`); setTab('pos'); }} />}
      {tab === 'invoices' && <InvoicesTab />}
      {tab === 'till' && <BranchGate what="the till"><TillTab /></BranchGate>}
      {tab === 'conflicts' && <ConflictsTab />}
    </>
  );
}

// ── POS ──────────────────────────────────────────────────────────────────────
function PosTab() {
  const { activeBranchId, user, can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const { mutate: mutateCache } = useSWRConfig();
  // Drafts and invoice lists elsewhere on the page are stale once a bill is saved.
  const refreshLists = useCallback(() => {
    void mutateCache((key) => typeof key === 'string' && (key.startsWith('/api/billing/drafts') || key.startsWith('/api/billing/invoices')));
  }, [mutateCache]);

  const scanRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [invoiceType, setInvoiceType] = useState<'GST' | 'NON_GST'>('GST');
  const [doc, setDoc] = useState<DocFields>(EMPTY_DOC);
  const [payments, setPayments] = useState<Payment[]>([{ method: 'CASH', amount: '' }]);
  const [cashReceived, setCashReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastInvoice, setLastInvoice] = useState<any | null>(null);
  // `draft` is the SERVER's copy of the bill. The review screen renders it and
  // never the local cart totals: what the cashier approves is what the server bills.
  const [draft, setDraft] = useState<any | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [overridePin, setOverridePin] = useState('');
  const [pinModal, setPinModal] = useState<null | 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT'>(null);
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  // One idempotency key per attempt at a direct sale: a double click, or a retry
  // after a dropped connection, cannot bill the customer twice.
  const saleKey = useRef<string>(idempotencyKey());

  const { data: settings } = useSWR<any>('/api/admin/settings/effective', fetcher);
  const { data: tills, mutate: refreshTills } = useSWR<TillSession[]>(
    can('manage_till') ? withBranch('/api/billing/till-sessions?status=OPEN&mine=true', activeBranchId) : null, fetcher);
  const openTill = tills?.[0];
  const discountLimit = Number(settings?.staff_discount_limit_pct ?? 5);
  const isManager = user?.role === 'OWNER_ADMIN' || user?.role === 'BRANCH_MANAGER';

  // ── Totals preview ────────────────────────────────────────────────────────
  const totals = useMemo(() => {
    const lines = cart.map(previewLine);
    const taxable = round2(lines.reduce((s, c) => s + c.taxable, 0));
    const tax = round2(lines.reduce((s, c) => s + c.tax, 0));
    const discount = round2(cart.reduce((s, l, i) => s + Math.min(toNum(l.discount), lines[i].gross), 0));
    return { taxable, tax, discount, grand: round2(taxable + tax) };
  }, [cart]);
  const payable = reviewing && draft ? Number(draft.totals?.payable ?? 0) : totals.grand;
  const paid = round2(payments.reduce((s, p) => s + toNum(p.amount), 0));
  const balance = round2(payable - paid);
  const catalogValue = round2(cart.reduce((s, l) => s + l.catalog_rate * toNum(l.qty) * multiplierOf(l), 0));
  const givenAway = round2(cart.reduce((s, l) => s + Math.max(l.catalog_rate - l.rate_base, 0) * toNum(l.qty) * multiplierOf(l) + toNum(l.discount), 0));
  const givenAwayPct = catalogValue > 0 ? (givenAway / catalogValue) * 100 : 0;
  const needsDiscountApproval = givenAwayPct > discountLimit + 0.001 && !isManager;
  const cashPart = payments.filter((p) => p.method === 'CASH').reduce((s, p) => s + toNum(p.amount), 0);
  const change = cashReceived ? round2(toNum(cashReceived) - cashPart) : null;

  // The common case — one payment for the whole bill — needs no typing: a single
  // untouched payment line follows the total.
  const paymentTouched = useRef(false);
  useEffect(() => {
    if (paymentTouched.current) return;
    setPayments((prev) => (prev.length === 1 ? [{ ...prev[0], amount: payable ? payable.toFixed(2) : '' }] : prev));
  }, [payable]);

  const focusSearch = useCallback(() => { setTimeout(() => scanRef.current?.focus(), 0); }, []);

  function clearBill() {
    setCart([]); setCustomer(null); setInvoiceType('GST'); setDoc(EMPTY_DOC);
    setPayments([{ method: 'CASH', amount: '' }]); setCashReceived(''); paymentTouched.current = false;
    setApprovals({}); setDraft(null); setReviewing(false); setUnknownCode(null);
    saleKey.current = idempotencyKey();
  }

  // ── Adding items ────────────────────────────────────────────────────────────
  const addProduct = useCallback((p: ProductHit, unitId?: string | null) => {
    const unit = (unitId ? p.units.find((u) => u.product_unit_id === unitId) : null) ?? defaultUnit(p);
    const rate = Number(p.selling_price ?? 0);
    if (!rate) { toast.error(new Error(`"${p.name}" has no selling price. Set one in the catalog first.`)); return; }
    if (!unit) { toast.error(new Error(`"${p.name}" has no sale unit set up.`)); return; }
    setCart((prev) => {
      const same = prev.find((l) => l.product_id === p.product_id && l.unit_id === unit.product_unit_id);
      if (same) return prev.map((l) => (l === same ? { ...l, qty: String(toNum(l.qty) + 1) } : l));
      return [...prev, {
        key: `${p.product_id}:${unit.product_unit_id}:${Date.now()}`,
        product_id: p.product_id, name: p.name, sku: p.sku, base_unit_label: p.base_unit_label,
        units: p.units, unit_id: unit.product_unit_id, qty: '1',
        rate_base: rate, catalog_rate: rate,
        gst_rate: invoiceType === 'NON_GST' ? 0 : Number(p.gst_rate_pct ?? 0),
        price_type: p.default_price_type, discount: '',
        available: Number(p.available_qty ?? 0),
      }];
    });
    setUnknownCode(null);
    focusSearch();
  }, [invoiceType, toast, focusSearch]);

  /** Enter with nothing highlighted — what a scanner sends after a code. */
  async function onScanText(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const hit = await apiGet<any>(`/api/catalog/barcode/${encodeURIComponent(trimmed)}`);
      const full = (await apiGet<ProductHit[]>(`/api/catalog/products?ids=${hit.product_id}&limit=1`))[0];
      if (full) addProduct(full, hit.product_unit_id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Something that looks like a scanned code rather than a word is reported
        // as a missing product, with a way to create it carrying the code across.
        if (/^[0-9A-Za-z-]{6,}$/.test(trimmed)) setUnknownCode(trimmed);
        else toast.toast('No exact match', { tone: 'info', message: 'Pick an item from the list with ↓ and Enter.' });
      } else toast.error(err);
    }
  }

  function updateLine(key: string, patch: Partial<CartLine>) {
    setCart((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
    focusSearch();
  }

  function changeInvoiceType(type: 'GST' | 'NON_GST') {
    setInvoiceType(type);
    // A bill of supply carries no GST; switching back restores each item's rate.
    if (type === 'NON_GST') setCart((c) => c.map((l) => ({ ...l, gst_rate: 0 })));
    else void refreshGst();
  }
  async function refreshGst() {
    if (!cart.length) return;
    try {
      const fresh = await apiGet<ProductHit[]>(`/api/catalog/products?ids=${[...new Set(cart.map((l) => l.product_id))].join(',')}&status=all&limit=200`);
      setCart((c) => c.map((l) => ({ ...l, gst_rate: Number(fresh.find((f) => f.product_id === l.product_id)?.gst_rate_pct ?? l.gst_rate) })));
    } catch { /* the server re-prices on review anyway */ }
  }

  /** 3.10 — the explicit refresh. Prices only move when the cashier asks. */
  async function refreshPrices() {
    try {
      const fresh = await apiGet<ProductHit[]>(`/api/catalog/products?ids=${[...new Set(cart.map((l) => l.product_id))].join(',')}&limit=200`);
      let changed = 0;
      setCart((prev) => prev.map((l) => {
        const p = fresh.find((f) => f.product_id === l.product_id);
        if (!p) return l;
        const rate = Number(p.selling_price);
        if (Math.abs(rate - l.rate_base) > 0.0001) { changed++; return { ...l, rate_base: rate, catalog_rate: rate }; }
        return l;
      }));
      toast.success(changed ? `${changed} line(s) repriced` : 'All prices are already current');
    } catch (err) { toast.error(err); }
  }

  async function verifyPin(purpose: 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT') {
    try {
      const res = await apiPost<{ approval_id: string; approver_name: string; expires_in_minutes: number }>(
        '/api/auth/verify-override-pin', { pin: overridePin, purpose });
      setApprovals((prev) => ({ ...prev, [purpose]: res.approval_id }));
      setPinModal(null); setOverridePin('');
      toast.success(`Approved by ${res.approver_name}`, `Valid for this sale only, for ${res.expires_in_minutes} minutes.`);
    } catch (err) { toast.error(err); }
  }

  // ── The bill as the server accepts it ──────────────────────────────────────
  function lineBody() {
    return cart.map((l) => ({
      product_id: l.product_id,
      product_unit_id: l.unit_id,
      qty_in_sale_unit: toNum(l.qty),
      rate_locked_at_scan: l.rate_base,
      price_type: l.price_type,
      discount_amount: toNum(l.discount) || 0,
    }));
  }
  function docBody() {
    const d: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(doc)) d[k] = v.trim() ? v.trim() : null;
    return d;
  }
  function paymentBody() {
    return payments.filter((p) => toNum(p.amount) > 0)
      .map((p) => ({ method: p.method, amount: round2(toNum(p.amount)), ref_no: p.ref_no?.trim() || undefined }));
  }
  function validateCart(): string | null {
    if (!cart.length) return 'Add at least one item.';
    for (const l of cart) {
      const q = toNum(l.qty);
      if (!(q > 0)) return `Enter a quantity for "${l.name}".`;
      const u = unitOf(l);
      if (u && !u.allows_fraction && !Number.isInteger(q)) return `"${l.name}" is sold in whole ${u.print_label} — ${q} is not allowed.`;
      if (toNum(l.discount) < 0) return `The discount on "${l.name}" cannot be negative.`;
    }
    return null;
  }

  /** Saves the bill as a draft and opens the review. Nothing is committed yet. */
  async function openReview() {
    const problem = validateCart();
    if (problem) { toast.error(new Error(problem)); return; }
    setBusy(true);
    try {
      const body = { invoice_type: invoiceType, customer_id: customer?.customer_id ?? null, lines: lineBody(), ...docBody(),
                     payments: paymentBody() };
      const saved = draft?.invoice_id
        ? await apiPut<any>(`/api/billing/drafts/${draft.invoice_id}`, body)
        : await apiPost<any>('/api/billing/drafts', body);
      setDraft(saved);
      setReviewing(true);
      refreshLists();
      if (!paymentTouched.current) setPayments([{ method: payments[0]?.method ?? 'CASH', amount: Number(saved.totals.payable).toFixed(2) }]);
    } catch (err) { toast.error(err); }
    finally { setBusy(false); }
  }

  // Ctrl/Cmd+S saves and reviews; it never finalises. Nothing that draws an
  // invoice number, moves stock or takes money is a single keystroke away.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // A dialog (new customer, manager PIN) owns the keyboard while it is open.
      if (document.querySelector('[role="dialog"]')) return;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!busy && !reviewing && cart.length) void openReview();
      }
      // "/" jumps to the item search from anywhere that is not a text field.
      if (e.key === '/' && !mod) {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) { e.preventDefault(); scanRef.current?.focus(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, reviewing, cart, draft, invoiceType, customer, doc, payments]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ?new=1 starts a clean bill; ?draft=<id> reopens a saved one (from Drafts, or
  // an estimate converted to a bill).
  useEffect(() => {
    if (router.query.new === '1') { clearBill(); focusSearch(); void router.replace('/billing', undefined, { shallow: true }); }
  }, [router.query.new]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = router.query.draft;
    if (typeof id !== 'string') return;
    void (async () => {
      try {
        const d = await apiGet<any>(`/api/billing/drafts/${id}`);
        const ids = [...new Set((d.lines ?? []).map((l: any) => l.product_id))];
        const products = ids.length
          ? await apiGet<ProductHit[]>(`/api/catalog/products?ids=${ids.join(',')}&status=all&limit=200`) : [];
        setCart((d.lines ?? []).map((l: any, i: number) => {
          const p = products.find((x) => x.product_id === l.product_id);
          return {
            key: `${l.product_id}:${l.product_unit_id}:${i}`,
            product_id: l.product_id, name: l.product_name, sku: l.sku ?? '', base_unit_label: p?.base_unit_label ?? '',
            units: p?.units ?? [], unit_id: l.product_unit_id, qty: String(l.qty_in_sale_unit),
            rate_base: Number(l.rate_locked_at_scan), catalog_rate: Number(l.catalog_rate ?? l.rate_locked_at_scan),
            gst_rate: Number(l.gst_rate_pct ?? 0), price_type: l.price_type, discount: Number(l.discount_amount) ? String(l.discount_amount) : '',
            available: Number(l.available_qty ?? p?.available_qty ?? 0),
          };
        }));
        setInvoiceType(d.invoice_type);
        setCustomer(d.customer_id ? { customer_id: d.customer_id, name: d.customer_name, phone: d.customer_phone ?? '',
          whatsapp: d.customer_whatsapp, credit_allowed: d.credit_allowed, loyalty_points_balance: d.loyalty_points_balance } : null);
        setDoc({ order_no: d.order_no ?? '', challan_no: d.challan_no ?? '', challan_date: d.challan_date ?? '',
                 vehicle_no: d.vehicle_no ?? '', due_date: d.due_date ?? '', place_of_delivery: d.place_of_delivery ?? '', notes: d.notes ?? '' });
        setDraft(d);
        setPayments(d.payments?.length
          ? d.payments.map((p: any) => ({ method: p.method, amount: Number(p.amount).toFixed(2), ref_no: p.ref_no ?? '' }))
          : [{ method: 'CASH', amount: Number(d.totals.payable).toFixed(2) }]);
        setReviewing(true);
      } catch (err) { toast.error(err); }
      finally { void router.replace('/billing', undefined, { shallow: true }); }
    })();
  }, [router.query.draft]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function discardDraft() {
    if (!draft?.invoice_id) { clearBill(); return; }
    if (!window.confirm('Discard this draft bill? Nothing has been billed yet.')) return;
    setBusy(true);
    try {
      await apiDelete(`/api/billing/drafts/${draft.invoice_id}`);
      clearBill();
      refreshLists();
      toast.success('Draft discarded');
      focusSearch();
    } catch (err) { toast.error(err); }
    finally { setBusy(false); }
  }

  function checkPayments(): boolean {
    if (Math.abs(balance) > 0.01) {
      toast.error(new Error(`Payments are ${inr(Math.abs(balance), { decimals: true })} ${balance > 0 ? 'short' : 'over'} the bill.`));
      return false;
    }
    if (payments.some((p) => p.method === 'CREDIT' && toNum(p.amount) > 0) && !customer) {
      toast.error(new Error('A credit sale needs a customer. Pick or add the customer first.'));
      return false;
    }
    if (payments.some((p) => ['BANK_TRANSFER'].includes(p.method) && toNum(p.amount) > 0 && !p.ref_no?.trim())) {
      toast.error(new Error('Enter the bank transfer reference (UTR).'));
      return false;
    }
    if (needsDiscountApproval && !approvals.DISCOUNT) { setPinModal('DISCOUNT'); return false; }
    return true;
  }

  function onSaleDone(invoice: any) {
    setLastInvoice(invoice);
    clearBill();
    void refreshTills();
    refreshLists();
    toast.success(`Bill ${invoice.invoice_number} finalised`, inr(invoice.amount ?? invoice.grand_total, { decimals: true }));
  }
  function onSaleError(err: any) {
    if (err?.status === 409 && /manager PIN/i.test(String(err.message))) {
      setPinModal(/credit limit/i.test(String(err.message)) ? 'CREDIT_LIMIT' : 'NEGATIVE_STOCK');
    }
    toast.error(err);
  }

  /** Finalises the reviewed draft. Lines are NOT re-sent: the server bills what it stored. */
  async function finalizeDraft() {
    if (!draft?.invoice_id || !checkPayments()) return;
    setBusy(true);
    try {
      const invoice = await apiPost<any>(`/api/billing/drafts/${draft.invoice_id}/finalize`, {
        till_session_id: openTill?.session_id ?? undefined,
        discount_approval_id: approvals.DISCOUNT, negative_stock_approval_id: approvals.NEGATIVE_STOCK,
        credit_approval_id: approvals.CREDIT_LIMIT, payments: paymentBody(),
      });
      onSaleDone(invoice);
    } catch (err: any) { onSaleError(err); } finally { setBusy(false); }
  }

  /** The fast path for a simple counter sale with nothing to review. */
  async function completeSale() {
    const problem = validateCart();
    if (problem) { toast.error(new Error(problem)); return; }
    if (!checkPayments()) return;
    const body = {
      invoice_type: invoiceType, customer_id: customer?.customer_id ?? null,
      till_session_id: openTill?.session_id ?? undefined,
      discount_approval_id: approvals.DISCOUNT, negative_stock_approval_id: approvals.NEGATIVE_STOCK,
      credit_approval_id: approvals.CREDIT_LIMIT,
      lines: lineBody(), payments: paymentBody(), ...docBody(),
      client_txn_id: saleKey.current,
    };
    setBusy(true);
    try {
      onSaleDone(await apiPost<any>('/api/billing/invoices', body));
    } catch (err: any) {
      // 3.5 — a network failure must not lose the sale. It is queued with its own
      // id and replayed; the server ignores it if the first attempt did land.
      if (err?.status === 0) {
        try {
          const list = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
          list.push({ ...body, device_created_at: new Date().toISOString() });
          localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(list));
          clearBill();
          toast.toast('Saved offline', { tone: 'info',
            message: 'The connection is down. This sale is queued and uploads when you are back online. Print the bill after it syncs.' });
        } catch { toast.error(err); }
      } else onSaleError(err);
    } finally { setBusy(false); }
  }

  // Drain the offline queue whenever the browser reports it is back online.
  useEffect(() => {
    async function drain() {
      let list: any[] = [];
      try { list = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); } catch { return; }
      if (!list.length) return;
      const remaining: any[] = [];
      let failed = 0;
      for (const item of list) {
        try { await apiPost('/api/billing/invoices', item); }
        catch (err: any) { if (err?.status === 0) remaining.push(item); else failed++; }
      }
      localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
      const synced = list.length - remaining.length - failed;
      if (synced > 0) toast.success(`${synced} offline sale(s) synced`);
      if (failed > 0) toast.error(new Error(`${failed} offline sale(s) were refused by the server — check stock conflicts.`));
    }
    window.addEventListener('online', drain);
    void drain();
    return () => window.removeEventListener('online', drain);
  }, [toast]);

  const paymentEditor = (
    <PaymentEditor payments={payments} payable={payable} cashReceived={cashReceived}
      setCashReceived={setCashReceived} change={change}
      onChange={(next) => { paymentTouched.current = true; setPayments(next); }} />
  );

  if (reviewing && draft) {
    return (
      <>
        <ReviewScreen draft={draft} openTill={openTill} busy={busy} paymentEditor={paymentEditor}
          balance={balance} onEdit={() => { setReviewing(false); focusSearch(); }}
          onFinalize={() => void finalizeDraft()} onDiscard={() => void discardDraft()} t={t} />
        <PinModal purpose={pinModal} pin={overridePin} setPin={setOverridePin}
          givenAwayPct={Number(draft.discount_pct ?? givenAwayPct)} discountLimit={discountLimit}
          onClose={() => { setPinModal(null); setOverridePin(''); }} onVerify={verifyPin} />
        <SaleCompleteModal invoice={lastInvoice} onClose={() => { setLastInvoice(null); focusSearch(); }} settings={settings} />
      </>
    );
  }

  return (
    <>
      {can('manage_till') && !openTill && (
        <div style={{ marginBottom: 14 }}>
          <Alert tone="warning" title="No till is open">
            Cash on bills is only counted against an open till. Open one on the Till tab to start the shift.
          </Alert>
        </div>
      )}

      <div className="grid split-work pos-layout">
        <div className="stack">
          <Card title="Items" right={<span className="kbd-hints"><span><kbd>↑</kbd><kbd>↓</kbd><kbd>↵</kbd> add</span><span><kbd>/</kbd> search</span><span><kbd>Ctrl</kbd><kbd>S</kbd> review</span></span>}>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <ProductPicker inputRef={scanRef} autoFocus onSelect={(p) => addProduct(p)} onSubmitText={(c) => void onScanText(c)}
                onTextChange={() => unknownCode && setUnknownCode(null)}
                placeholder="Scan a barcode, or type e.g. cpvc elbow, putty, 8901234500014" ariaLabel="Search or scan an item" />
            </div>
            {unknownCode && (
              <div style={{ marginTop: 10 }}>
                <Alert tone="warning" title="No product has this code">
                  Nothing in the catalog carries <span className="mono">{unknownCode}</span>.
                  {can('edit_catalog')
                    ? ' Add it to the catalog, or check the code and scan again.'
                    : ' Check the code, or ask someone who can edit the catalog to add it.'}
                  {can('edit_catalog') && (
                    <div style={{ marginTop: 10 }}>
                      <Link href={`/catalog?new=1&barcode=${encodeURIComponent(unknownCode)}`} className="btn sm">
                        <Icon name="plus" size={14} /> Create product
                      </Link>
                    </div>
                  )}
                </Alert>
              </div>
            )}
          </Card>

          <Card title={`${t('cart')} (${cart.length})`} flush
            right={cart.length > 0 && (
              <div className="row tight">
                <Button size="sm" onClick={() => void refreshPrices()} title="Re-read every line's price from the catalog">
                  <Icon name="refresh" size={13} /> Refresh prices
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Clear this bill?')) clearBill(); }}>Clear</Button>
              </div>
            )}>
            {cart.length === 0 ? (
              <EmptyState icon="billing" title="The bill is empty" text="Scan or search above — each item is added here." />
            ) : (
              <div className="table-wrap pos-cart">
                <table className="data pos-lines">
                  <thead>
                    <tr>
                      <th>{t('product')}</th>
                      <th>Unit</th>
                      <th className="num">{t('quantity')}</th>
                      <th className="num">Rate / unit</th>
                      <th className="num">{t('discount')} ₹</th>
                      <th className="num">{t('total')}</th>
                      <th aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((l) => {
                      const c = previewLine(l);
                      const unit = unitOf(l);
                      const short = c.baseQty > l.available + 1e-9;
                      const unitRate = round2(l.rate_base * multiplierOf(l));
                      return (
                        <tr key={l.key}>
                          <td className="pos-cell-item">
                            <div style={{ fontWeight: 600 }}>{l.name}</div>
                            <div className="muted small">
                              <Badge tone={l.price_type === 'TAX_INCLUSIVE' ? 'neutral' : 'info'}>
                                {l.gst_rate === 0 ? 'no GST' : l.price_type === 'TAX_INCLUSIVE' ? `incl. ${num(l.gst_rate, 2)}% GST` : `+ ${num(l.gst_rate, 2)}% GST`}
                              </Badge>{' '}
                              {unit && !unit.is_base && <span>= {qtyWithUnit(c.baseQty, l.base_unit_label)} · </span>}
                              {l.available <= 0
                                ? <span style={{ color: 'var(--status-critical)' }}>out of stock</span>
                                : short
                                  ? <span style={{ color: 'var(--status-critical)' }}>only {qtyWithUnit(l.available, l.base_unit_label)} in stock</span>
                                  : <span>{qtyWithUnit(l.available, l.base_unit_label)} in stock</span>}
                            </div>
                          </td>
                          <td data-label="Unit">
                            <select className="pos-unit" aria-label={`Unit for ${l.name}`} value={l.unit_id}
                              onChange={(e) => updateLine(l.key, { unit_id: e.target.value })}>
                              {l.units.map((u) => <option key={u.product_unit_id} value={u.product_unit_id}>{u.print_label}</option>)}
                            </select>
                          </td>
                          <td data-label="Qty" className="num">
                            <input className="pos-qty num" inputMode="decimal" aria-label={`Quantity of ${l.name}`} value={l.qty}
                              onChange={(e) => updateLine(l.key, { qty: e.target.value.replace(/[^\d.]/g, '') })}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSearch(); } }}
                              style={{ textAlign: 'right' }} />
                          </td>
                          <td data-label={`Rate / ${unit?.print_label ?? ''}`} className="num">
                            <input className="pos-money num" inputMode="decimal" aria-label={`Rate for ${l.name}`}
                              defaultValue={unitRate.toFixed(2)} key={`${l.key}:${l.unit_id}:${l.rate_base}`}
                              onBlur={(e) => {
                                const v = toNum(e.target.value);
                                if (v >= 0) updateLine(l.key, { rate_base: Math.round((v / multiplierOf(l)) * 10000) / 10000 });
                              }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); focusSearch(); } }} />
                          </td>
                          <td data-label="Discount ₹" className="num">
                            <input className="pos-money num" inputMode="decimal" aria-label={`Discount on ${l.name}`} value={l.discount} placeholder="0"
                              onChange={(e) => updateLine(l.key, { discount: e.target.value.replace(/[^\d.]/g, '') })}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusSearch(); } }} />
                          </td>
                          <td className="num pos-cell-total" data-label="Total" style={{ fontWeight: 650 }}>{inr(c.total, { decimals: true })}</td>
                          <td className="pos-cell-remove">
                            <button type="button" className="icon-btn" onClick={() => removeLine(l.key)} aria-label={`Remove ${l.name}`}>
                              <Icon name="trash" size={15} />
                            </button>
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

        <div className="stack">
          <Card title={t('customer')}>
            <CustomerPicker value={customer} onSelect={setCustomer} inputRef={customerRef}
              placeholder="Walk-in — or search name, phone, GSTIN" />
            {customer && (
              <div className="muted small" style={{ marginTop: 8 }}>
                {customer.gstin ? `GSTIN ${customer.gstin} · ` : ''}
                {customer.state_code ? `${stateName(customer.state_code)} · ` : ''}
                {num(customer.loyalty_points_balance ?? 0, 0)} points
                {customer.credit_allowed ? ` · credit ${inr(customer.credit_available ?? 0)} available` : ''}
                {Number(customer.balance_owed ?? 0) > 0 ? ` · owes ${inr(customer.balance_owed)}` : ''}
              </div>
            )}
            {!customer && <div className="muted small" style={{ marginTop: 8 }}>Leave empty for a walk-in customer.</div>}
          </Card>

          <Card title="Bill">
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="label" style={{ flex: 1 }}>Invoice type</span>
              <div className="segmented" role="radiogroup" aria-label="Invoice type">
                <button type="button" role="radio" aria-checked={invoiceType === 'GST'} className={invoiceType === 'GST' ? 'active' : ''}
                  onClick={() => changeInvoiceType('GST')}>GST invoice</button>
                <button type="button" role="radio" aria-checked={invoiceType === 'NON_GST'} className={invoiceType === 'NON_GST' ? 'active' : ''}
                  onClick={() => changeInvoiceType('NON_GST')}>Non-GST</button>
              </div>
            </div>
            <dl className="kv">
              <dt>{invoiceType === 'GST' ? 'Taxable value' : t('subtotal')}</dt><dd className="num">{inr(totals.taxable, { decimals: true })}</dd>
              {totals.discount > 0 && <><dt>{t('discount')}</dt><dd className="num">− {inr(totals.discount, { decimals: true })}</dd></>}
              {invoiceType === 'GST' && <><dt>GST</dt><dd className="num">{inr(totals.tax, { decimals: true })}</dd></>}
            </dl>
            <div className="divider" />
            <div className="row">
              <span style={{ flex: 1, fontWeight: 650 }}>{t('grandTotal')}</span>
              <span className="num pos-total">{inr(totals.grand, { decimals: true })}</span>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>Preview. The server calculates the final figures on review.</div>
            {givenAway > 0 && (
              <div className="muted small" style={{ marginTop: 6 }}>
                {inr(givenAway, { decimals: true })} off catalog price ({givenAwayPct.toFixed(1)}%), including lowered rates.
              </div>
            )}
            {needsDiscountApproval && (
              <div style={{ marginTop: 10 }}>
                <Alert tone="warning" title={`${givenAwayPct.toFixed(1)}% below catalog — above your ${discountLimit}% limit`}>
                  {approvals.DISCOUNT ? 'A manager has approved it for this sale.' : 'A manager PIN will be needed to finish this sale.'}
                </Alert>
              </div>
            )}
            <details className="more" style={{ marginTop: 12 }}>
              <summary>More details — order, challan, vehicle, delivery</summary>
              <div className="form-grid">
                <Field label="Buyer's order no."><input value={doc.order_no} onChange={(e) => setDoc({ ...doc, order_no: e.target.value })} /></Field>
                <Field label="Due date"><input type="date" value={doc.due_date} onChange={(e) => setDoc({ ...doc, due_date: e.target.value })} /></Field>
                <Field label="Challan no."><input value={doc.challan_no} onChange={(e) => setDoc({ ...doc, challan_no: e.target.value })} /></Field>
                <Field label="Challan date"><input type="date" value={doc.challan_date} onChange={(e) => setDoc({ ...doc, challan_date: e.target.value })} /></Field>
                <Field label="Vehicle no."><input value={doc.vehicle_no} onChange={(e) => setDoc({ ...doc, vehicle_no: e.target.value.toUpperCase() })} placeholder="MH04AB1234" /></Field>
                <div className="span-2"><Field label="Place of delivery"><input value={doc.place_of_delivery} onChange={(e) => setDoc({ ...doc, place_of_delivery: e.target.value })} /></Field></div>
                <div className="span-2"><Field label="Notes on the bill"><input value={doc.notes} onChange={(e) => setDoc({ ...doc, notes: e.target.value })} maxLength={1000} /></Field></div>
              </div>
            </details>
          </Card>

          <Card title={t('payment')} description="Split across as many methods as needed">
            {paymentEditor}
            {payments.some((p) => p.method === 'CREDIT' && toNum(p.amount) > 0) && !customer && (
              <div style={{ marginTop: 10 }}><Alert tone="critical">A credit sale needs a customer.</Alert></div>
            )}
          </Card>

          <Button variant="primary" size="lg" className="block" busy={busy} disabled={!cart.length}
            onClick={() => void openReview()}>
            {t('reviewBill')} · {inr(totals.grand, { decimals: true })}
          </Button>
          <Button size="lg" className="block" busy={busy} disabled={!cart.length || Math.abs(balance) > 0.01}
            onClick={() => void completeSale()} title="Finalise straight away, without the review step">
            {t('completeSale')}
          </Button>
        </div>
      </div>

      <PinModal purpose={pinModal} pin={overridePin} setPin={setOverridePin}
        givenAwayPct={givenAwayPct} discountLimit={discountLimit}
        onClose={() => { setPinModal(null); setOverridePin(''); }} onVerify={verifyPin} />
      <SaleCompleteModal invoice={lastInvoice} onClose={() => { setLastInvoice(null); focusSearch(); }} settings={settings} />
    </>
  );
}

// ── Payment editor ───────────────────────────────────────────────────────────
function PaymentEditor({ payments, payable, onChange, cashReceived, setCashReceived, change }: {
  payments: Payment[]; payable: number; onChange: (p: Payment[]) => void;
  cashReceived: string; setCashReceived: (v: string) => void; change: number | null;
}) {
  const paid = round2(payments.reduce((s, p) => s + toNum(p.amount), 0));
  const balance = round2(payable - paid);
  const set = (i: number, patch: Partial<Payment>) => onChange(payments.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const hasCash = payments.some((p) => p.method === 'CASH' && toNum(p.amount) > 0);
  return (
    <div className="stack">
      {payments.map((p, i) => (
        <div key={i} className="stack" style={{ gap: 6 }}>
          <div className="row tight">
            <select value={p.method} style={{ width: 150 }} aria-label={`Payment ${i + 1} method`}
              onChange={(e) => set(i, { method: e.target.value })}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input inputMode="decimal" value={p.amount} style={{ flex: 1, textAlign: 'right' }} aria-label={`Payment ${i + 1} amount`}
              onChange={(e) => set(i, { amount: e.target.value.replace(/[^\d.]/g, '') })} className="num" />
            {payments.length > 1 && (
              <button type="button" className="icon-btn" aria-label={`Remove payment ${i + 1}`}
                onClick={() => onChange(payments.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
            )}
          </div>
          {['UPI', 'CARD', 'BANK_TRANSFER'].includes(p.method) && (
            <input value={p.ref_no ?? ''} aria-label={`Payment ${i + 1} reference`}
              placeholder={p.method === 'BANK_TRANSFER' ? 'UTR / bank reference (required)' : p.method === 'UPI' ? 'UPI transaction id (optional)' : 'Card auth code (optional)'}
              onChange={(e) => set(i, { ref_no: e.target.value })} />
          )}
        </div>
      ))}
      <div className="row">
        <Button size="sm" onClick={() => onChange([...payments, { method: 'UPI', amount: balance > 0 ? balance.toFixed(2) : '' }])}>
          <Icon name="plus" size={13} /> Split payment
        </Button>
        <span className="spacer" />
        {Math.abs(balance) > 0.01
          ? <Badge tone={balance > 0 ? 'warning' : 'critical'}>{balance > 0 ? `${inr(balance, { decimals: true })} to collect` : `${inr(-balance, { decimals: true })} over`}</Badge>
          : payable > 0 ? <Badge tone="good">Settled</Badge> : null}
      </div>
      {hasCash && (
        <div className="row tight">
          <label className="label" htmlFor="cash-received" style={{ flex: 1 }}>Cash received (for change)</label>
          <input id="cash-received" inputMode="decimal" value={cashReceived} style={{ width: 130, textAlign: 'right' }} className="num"
            onChange={(e) => setCashReceived(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" />
          {change !== null && (
            <Badge tone={change < 0 ? 'critical' : 'good'}>{change < 0 ? `short ${inr(-change, { decimals: true })}` : `change ${inr(change, { decimals: true })}`}</Badge>
          )}
        </div>
      )}
    </div>
  );
}

// ── Review (server figures) ──────────────────────────────────────────────────
function ReviewScreen({ draft, openTill, busy, paymentEditor, balance, onEdit, onFinalize, onDiscard, t }: {
  draft: any; openTill: TillSession | undefined; busy: boolean; paymentEditor: React.ReactNode; balance: number;
  onEdit: () => void; onFinalize: () => void; onDiscard: () => void; t: (k: string) => string;
}) {
  const totals = draft?.totals ?? {};
  const payable = Number(totals.payable ?? 0);
  const isGst = draft?.invoice_type === 'GST';
  return (
    <div className="stack">
      <Alert tone="info" title={`${t('reviewBill')} — ${t('draftNotFinal')}`}>
        These figures were calculated by the server. Nothing is billed yet — no invoice number, no stock
        movement, no ledger entry. Check the bill with the customer, take payment, then finalise.
      </Alert>
      {draft.pricing_error && <Alert tone="critical" title="This draft cannot be priced">{draft.pricing_error}</Alert>}
      {(draft?.stock_warnings?.length ?? 0) > 0 && (
        <Alert tone="warning" title="Not enough stock for this bill">
          {draft.stock_warnings.map((w: any) => (
            <div key={w.product_name}>
              {w.product_name}: needs {qtyWithUnit(w.requested, w.unit)},{' '}
              {Number(w.available) > 0 ? `${qtyWithUnit(w.available, w.unit)} available` : 'none available'}
            </div>
          ))}
          <div style={{ marginTop: 6 }}>Finalising will need a manager PIN, or reduce the quantity.</div>
        </Alert>
      )}

      <div className="grid split-work">
        <div className="stack">
          <Card title={isGst ? 'Tax invoice preview' : 'Cash memo preview'}
            description={draft?.customer_name ? `${draft.customer_name}${draft.customer_phone ? ` · ${draft.customer_phone}` : ''}` : 'Walk-in customer'}
            right={<Badge tone={isGst ? 'info' : 'neutral'}>{isGst ? (draft.interstate ? 'GST · IGST' : 'GST · CGST+SGST') : 'Non-GST'}</Badge>}>
            <DataTable rows={draft?.lines ?? []} emptyText="This draft has no items." rowKey={(r: any) => `${r.product_id}:${r.product_unit_id}:${r.qty_in_sale_unit}`}
              columns={[
                { key: 'item', header: 'Item', render: (r: any) => (
                  <span>
                    <span style={{ display: 'block', fontWeight: 550 }}>{r.product_name}</span>
                    <span className="muted small mono">{r.sku}{r.hsn_code ? ` · HSN ${r.hsn_code}` : ''}{r.price_changed_since_scan ? ' · price held from scan' : ''}</span>
                  </span>) },
                { key: 'qty', header: 'Qty', align: 'right', nowrap: true, render: (r: any) => qtyWithUnit(r.qty_in_sale_unit, r.unit_print_label) },
                { key: 'rate', header: 'Rate', align: 'right', render: (r: any) => inr(r.rate_per_sale_unit, { decimals: true }) },
                { key: 'disc', header: 'Disc.', align: 'right', render: (r: any) => (Number(r.discount_amount) ? inr(r.discount_amount, { decimals: true }) : '—') },
                ...(isGst ? [{ key: 'gst', header: 'GST', align: 'right' as const, render: (r: any) => `${num(r.gst_rate_pct, 2)}%` }] : []),
                { key: 'amt', header: 'Amount', align: 'right', render: (r: any) => <strong>{inr(r.line_total, { decimals: true })}</strong> },
              ]} />
          </Card>
          <Card title="Payment" description="The split must settle the bill exactly">{paymentEditor}</Card>
        </div>

        <div className="stack">
          <Card title="Bill summary" right={<span className="muted small">{t('serverRecalculated')}</span>}>
            <KeyValue items={[
              ['Items', String(draft?.lines?.length ?? 0)],
              ...(Number(totals.discount_total) > 0 ? [['Discount', `− ${inr(totals.discount_total, { decimals: true })}`] as [string, React.ReactNode]] : []),
              [isGst ? 'Taxable value' : 'Subtotal', inr(totals.subtotal, { decimals: true })],
              ...(isGst && Number(totals.igst_total) > 0
                ? [['IGST', inr(totals.igst_total, { decimals: true })] as [string, React.ReactNode]]
                : isGst ? ([['CGST', inr(totals.cgst_total, { decimals: true })], ['SGST', inr(totals.sgst_total, { decimals: true })]] as [string, React.ReactNode][]) : []),
              ...(Number(totals.round_off) ? [['Round off', inr(totals.round_off, { decimals: true })] as [string, React.ReactNode]] : []),
              ...(isGst && draft.place_of_supply_state_code ? [['Place of supply', `${draft.place_of_supply_state_code} ${stateName(draft.place_of_supply_state_code)}`] as [string, React.ReactNode]] : []),
              ...(draft.quotation_number ? [['From estimate', draft.quotation_number] as [string, React.ReactNode]] : []),
              ...(draft.vehicle_no ? [['Vehicle', draft.vehicle_no] as [string, React.ReactNode]] : []),
              ...(draft.order_no ? [['Order no.', draft.order_no] as [string, React.ReactNode]] : []),
            ]} />
            <div className="row" style={{ marginTop: 12, paddingTop: 12, borderTop: '2px solid var(--border)' }}>
              <strong style={{ flex: 1 }}>Total payable</strong>
              <strong className="num pos-total">{inr(payable, { decimals: true })}</strong>
            </div>
            {Number(draft?.given_away) > 0 && (
              <p className="muted small" style={{ marginTop: 8 }}>
                {inr(draft.given_away, { decimals: true })} off catalog ({num(draft.discount_pct, 1)}%).
              </p>
            )}
            {!openTill && <p className="muted small" style={{ marginTop: 8 }}>No till is open for you, so cash on this bill will not be in a drawer count.</p>}
          </Card>

          <Card title="Next step">
            <div className="stack" style={{ gap: 8 }}>
              <Button variant="primary" size="lg" busy={busy}
                disabled={busy || !draft?.lines?.length || Math.abs(balance) > 0.01 || Boolean(draft.pricing_error)}
                onClick={onFinalize}>
                <Icon name="check" size={15} /> {t('finalizeBill')} · {inr(payable, { decimals: true })}
              </Button>
              <Button onClick={onEdit} disabled={busy}>← {t('editBill')}</Button>
              <Button onClick={() => void downloadFile(`/api/billing/invoices/${draft.invoice_id}/pdf`, `Draft-${String(draft.invoice_id).slice(0, 8)}.pdf`)}>
                <Icon name="download" size={14} /> {t('previewPdf')}
              </Button>
              <Button variant="danger" onClick={onDiscard} disabled={busy}>{t('discardDraft')}</Button>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Finalising assigns the invoice number, takes the stock, records the payment and locks the bill.
              A correction afterwards is a return, a credit note or a void.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── After the sale ───────────────────────────────────────────────────────────
function SaleCompleteModal({ invoice, onClose, settings }: { invoice: any | null; onClose: () => void; settings: any }) {
  const toast = useToast();
  if (!invoice) return null;
  const summary = invoice.payment_summary;
  const amount = Number(invoice.amount ?? invoice.grand_total);
  const status = summary?.status === 'ON_CREDIT'
    ? `On credit — ${inr(summary.on_credit, { decimals: true })} outstanding`
    : summary?.status === 'PARTIALLY_PAID'
      ? `Part paid — ${inr(summary.settled, { decimals: true })} received, ${inr(summary.on_credit, { decimals: true })} outstanding`
      : 'Paid';
  const businessName = settings?.business_profile?.name || invoice.branch_name || 'BHAWANI ONE';
  const phone = invoice.customer?.whatsapp || invoice.customer?.phone;
  const message = [
    businessName,
    `Invoice: ${invoice.invoice_number}`,
    `Date: ${formatDateTime(invoice.server_received_at)}`,
    invoice.customer?.name ? `Customer: ${invoice.customer.name}` : null,
    `Amount: ${inr(amount, { decimals: true })}`,
    `Payment: ${status}`,
    '',
    'Thank you for your business.',
  ].filter((l) => l !== null).join('\n');
  const url = whatsappShareUrl(phone, message);
  const pdfPath = `/api/billing/invoices/${invoice.invoice_id}/pdf`;
  return (
    <Modal open onClose={onClose} title="Sale complete"
      footer={<>
        <Button onClick={onClose}>New bill</Button>
        <Button onClick={() => printFile(pdfPath).catch((e) => toast.error(e))}><Icon name="print" size={14} /> Print</Button>
        <Button variant="primary" onClick={() => downloadFile(pdfPath, `Invoice-${invoice.invoice_number}.pdf`).catch((e) => toast.error(e))}>
          <Icon name="download" size={14} /> Download PDF
        </Button>
      </>}>
      <div className="stack">
        <Alert tone="good" title={`Invoice ${invoice.invoice_number}`}>
          {inr(amount, { decimals: true })} · {status}
          {invoice.points_redeemed > 0 && ` · ${invoice.points_redeemed} points redeemed`}
        </Alert>
        {invoice.warning && <Alert tone="warning">{invoice.warning}</Alert>}
        {url ? (
          <div className="stack" style={{ gap: 6 }}>
            <Button className="block" onClick={() => window.open(url, '_blank', 'noopener')}>
              <Icon name="whatsapp" size={15} /> Share on WhatsApp
            </Button>
            <p className="muted small" style={{ margin: 0 }}>
              Opens WhatsApp with the bill details written out, for you to send. It does not send anything by
              itself and cannot attach the PDF — download it first if the customer wants the document.
            </p>
          </div>
        ) : (
          <p className="muted small">
            {invoice.customer?.name
              ? 'This customer has no phone number on file, so the bill cannot be shared on WhatsApp.'
              : 'Walk-in sale — add a customer with a phone number to share bills on WhatsApp.'}
          </p>
        )}
      </div>
    </Modal>
  );
}

function PinModal({ purpose, pin, setPin, givenAwayPct, discountLimit, onClose, onVerify }: {
  purpose: null | 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT'; pin: string; setPin: (v: string) => void;
  givenAwayPct: number; discountLimit: number; onClose: () => void;
  onVerify: (purpose: 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT') => void;
}) {
  return (
    <Modal open={purpose !== null} onClose={onClose} title="Manager approval"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pin.length < 4} onClick={() => purpose && onVerify(purpose)}>Approve</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); if (purpose && pin.length >= 4) onVerify(purpose); }}>
        <p className="muted">
          {purpose === 'DISCOUNT'
            ? `This bill is ${givenAwayPct.toFixed(1)}% below catalog price, above the ${discountLimit}% staff limit.`
            : purpose === 'NEGATIVE_STOCK'
              ? 'System stock is short for one or more items.'
              : 'This sale would take the customer over their credit limit.'}
          {' '}A manager or the owner can approve it with their PIN, for this sale only.
        </p>
        <Field label="Manager PIN">
          <input type="password" inputMode="numeric" maxLength={6} value={pin} autoComplete="off"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: '0.4em', fontSize: 17 }} />
        </Field>
      </form>
    </Modal>
  );
}

// ── Drafts ───────────────────────────────────────────────────────────────────
function DraftsTab({ onResume }: { onResume: (id: string) => void }) {
  const { activeBranchId } = useAuth();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch('/api/billing/drafts?limit=100', activeBranchId), fetcher);
  async function discard(id: string) {
    if (!window.confirm('Discard this draft? Nothing on it has been billed.')) return;
    try { await apiDelete(`/api/billing/drafts/${id}`); toast.success('Draft discarded'); void mutate(); }
    catch (err) { toast.error(err); }
  }
  return (
    <Card flush title="Saved draft bills" description="Bills prepared but not finalised — no number, no stock movement, no payment yet.">
      <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
        empty={<EmptyState icon="billing" title="No drafts" text="Bills saved for review, or estimates opened as bills, appear here." />}>
        {(rows) => (
          <DataTable rows={rows} onRowClick={(r: any) => onResume(r.invoice_id)}
            columns={[
              { key: 'cust', header: 'Customer', render: (r: any) => r.customer_name ?? <span className="muted">Walk-in</span> },
              { key: 'lines', header: 'Items', align: 'right', render: (r: any) => num(r.line_count, 0) },
              { key: 'by', header: 'Started by', render: (r: any) => r.created_by_name },
              { key: 'branch', header: 'Branch', render: (r: any) => r.branch_name },
              { key: 'when', header: 'Last changed', nowrap: true, render: (r: any) => formatDateTime(r.updated_at) },
              { key: 'total', header: 'Total', align: 'right', render: (r: any) => inr(Number(r.grand_total) + Number(r.round_off ?? 0), { decimals: true }) },
              { key: 'act', header: '', render: (r: any) => (
                <div className="row tight" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="primary" onClick={() => onResume(r.invoice_id)}>Resume</Button>
                  <Button size="sm" variant="ghost" onClick={() => void discard(r.invoice_id)}>Discard</Button>
                </div>) },
            ]} />
        )}
      </AsyncSection>
    </Card>
  );
}

// ── Invoice history ──────────────────────────────────────────────────────────
function InvoicesTab() {
  const { activeBranchId, can } = useAuth();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const search = useDebounced(query, 300);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [payStatus, setPayStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<any | null>(null);
  const [voiding, setVoiding] = useState(false);

  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set('q', search);
  if (status) params.set('status', status);
  if (type) params.set('invoice_type', type);
  if (payStatus) params.set('payment_status', payStatus);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch(`/api/billing/invoices?${params}`, activeBranchId), fetcher,
    { keepPreviousData: true });

  async function openInvoice(id: string) {
    try { setSelected(await apiGet(`/api/billing/invoices/${id}`)); }
    catch (err) { toast.error(err); }
  }
  // ?invoice=<id> — where a global-search hit lands.
  useEffect(() => {
    const id = router.query.invoice;
    if (typeof id !== 'string' || selected?.invoice_id === id) return;
    void openInvoice(id);
  }, [router.query.invoice]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function voidInvoice() {
    if (!selected) return;
    const reason = window.prompt(`Void invoice ${selected.invoice_number}? This reverses its stock, payments, credit and points.\n\nReason for voiding:`);
    if (!reason || !reason.trim()) return;
    setVoiding(true);
    try {
      await apiPost(`/api/billing/invoices/${selected.invoice_id}/void`, { reason: reason.trim() });
      toast.success('Invoice voided', 'Stock, payments, credit and loyalty points were reversed.');
      setSelected(null); void mutate();
    } catch (err) { toast.error(err); } finally { setVoiding(false); }
  }

  const shareUrl = selected ? whatsappShareUrl(selected.customer_whatsapp ?? selected.customer_phone, [
    selected.branch_name,
    `Invoice: ${selected.invoice_number}`,
    `Date: ${formatDateTime(selected.server_received_at)}`,
    selected.customer_name ? `Customer: ${selected.customer_name}` : null,
    `Amount: ${inr(selected.amount, { decimals: true })}`,
    `Payment: ${selected.payment_status === 'PAID' ? 'Paid' : selected.payment_status === 'CREDIT' ? `On credit — ${inr(selected.on_credit, { decimals: true })} outstanding` : `Part paid — ${inr(selected.on_credit, { decimals: true })} outstanding`}`,
  ].filter(Boolean).join('\n')) : null;

  return (
    <>
      <div className="table-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Invoice number, customer or phone…" />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Final + void</option><option value="FINAL">Final</option><option value="VOID">Void</option>
        </select>
        <select aria-label="Invoice type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option><option value="GST">GST</option><option value="NON_GST">Non-GST</option>
        </select>
        <select aria-label="Payment status" value={payStatus} onChange={(e) => setPayStatus(e.target.value)}>
          <option value="">Any payment</option><option value="PAID">Paid</option>
          <option value="PARTIALLY_PAID">Part paid</option><option value="CREDIT">On credit</option>
        </select>
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="billing" title="No invoices" text="No bill matches these filters." />}>
          {(rows) => (
            <>
              <DataTable rows={rows} onRowClick={(r: any) => void openInvoice(r.invoice_id)}
                columns={[
                  { key: 'no', header: 'Invoice', nowrap: true, render: (r: any) => <span className="mono">{r.invoice_number}</span> },
                  { key: 'date', header: 'Date', nowrap: true, render: (r: any) => formatDateTime(r.server_received_at) },
                  { key: 'branch', header: t('branch'), render: (r: any) => r.branch_name },
                  { key: 'cust', header: t('customer'), render: (r: any) => r.customer_name ?? <span className="muted">{t('walkIn')}</span> },
                  { key: 'type', header: 'Type', render: (r: any) => <Badge tone={r.invoice_type === 'GST' ? 'info' : 'neutral'}>{r.invoice_type === 'GST' ? 'GST' : 'Non-GST'}</Badge> },
                  { key: 'pay', header: t('payment'), render: (r: any) => (
                    <span className="row tight">
                      {r.status === 'FINAL' && <Badge tone={r.payment_status === 'PAID' ? 'good' : r.payment_status === 'CREDIT' ? 'warning' : 'info'}>
                        {r.payment_status === 'PAID' ? 'Paid' : r.payment_status === 'CREDIT' ? 'Credit' : 'Part paid'}</Badge>}
                      <span className="muted small">{r.payment_methods}</span>
                    </span>) },
                  { key: 'status', header: 'Status', render: (r: any) => (
                    <span className="row tight"><StatusBadge status={r.status} />{r.has_returns && <Badge tone="neutral">returns</Badge>}</span>) },
                  { key: 'total', header: t('total'), align: 'right', render: (r: any) => inr(r.amount, { decimals: true }) },
                ]} />
              <Pager shown={rows.length} pageSize={50} onMore={() => setLimit((l) => l + 50)} />
            </>
          )}
        </AsyncSection>
      </Card>

      <Modal open={Boolean(selected)} onClose={() => setSelected(null)} wide
        title={`${selected?.invoice_type === 'GST' ? 'Tax invoice' : 'Cash memo'} ${selected?.invoice_number ?? ''}`}
        footer={<>
          {can('void_invoice') && selected?.status === 'FINAL' && (
            <Button variant="danger" busy={voiding} onClick={() => void voidInvoice()}>Void…</Button>
          )}
          {can('process_return') && selected?.status === 'FINAL' && (
            <Link className="btn" href={`/returns?invoice=${selected.invoice_id}`}>Return items</Link>
          )}
          <div className="spacer" />
          {shareUrl && <Button onClick={() => window.open(shareUrl, '_blank', 'noopener')}><Icon name="whatsapp" size={14} /> WhatsApp</Button>}
          <Button onClick={() => selected && printFile(`/api/billing/invoices/${selected.invoice_id}/pdf`).catch((e) => toast.error(e))}>
            <Icon name="print" size={14} /> Print
          </Button>
          <Button variant="primary" onClick={() => selected && downloadFile(
            `/api/billing/invoices/${selected.invoice_id}/pdf`, `Invoice-${selected.invoice_number}.pdf`).catch((e) => toast.error(e))}>
            <Icon name="download" size={14} /> PDF
          </Button>
        </>}>
        {selected && <InvoiceDetail inv={selected} />}
      </Modal>
    </>
  );
}

function InvoiceDetail({ inv }: { inv: any }) {
  const { t } = useI18n();
  return (
    <div className="stack">
      {inv.status === 'VOID' && <Alert tone="critical" title="This invoice is void">Its stock, payments, credit and points were reversed.</Alert>}
      <div className="grid cols-3">
        <div>
          <div className="label">Billed to</div>
          <div>{inv.customer_name ?? t('walkIn')}</div>
          <div className="muted small">{[inv.customer_phone, inv.customer_gstin].filter(Boolean).join(' · ')}</div>
        </div>
        <div>
          <div className="label">Branch & date</div>
          <div>{inv.branch_name}</div>
          <div className="muted small">{formatDateTime(inv.server_received_at)}</div>
        </div>
        <div>
          <div className="label">Payment</div>
          <div>{inv.payment_status === 'PAID' ? 'Paid' : inv.payment_status === 'CREDIT' ? 'On credit' : inv.payment_status ? 'Part paid' : '—'}</div>
          <div className="muted small">{(inv.payments ?? []).map((p: any) => `${p.method.replace('_', ' ')} ${inr(p.amount, { decimals: true })}${p.ref_no ? ` (${p.ref_no})` : ''}`).join(' · ')}</div>
        </div>
      </div>
      <DataTable rows={inv.lines ?? []} rowKey={(l: any) => l.line_id}
        columns={[
          { key: 'item', header: 'Item', render: (l: any) => <div>{l.product_name}<div className="muted small mono">{l.sku}{l.hsn_code ? ` · HSN ${l.hsn_code}` : ''}</div></div> },
          { key: 'qty', header: 'Qty', align: 'right', nowrap: true, render: (l: any) => qtyWithUnit(l.qty_in_sale_unit, l.unit_print_label) },
          { key: 'rate', header: 'Rate', align: 'right', render: (l: any) => inr(l.rate_per_sale_unit, { decimals: true }) },
          { key: 'tax', header: 'Taxable', align: 'right', render: (l: any) => inr(l.taxable_value, { decimals: true }) },
          { key: 'gst', header: 'GST', align: 'right', render: (l: any) => inr(Number(l.cgst_amount) + Number(l.sgst_amount) + Number(l.igst_amount), { decimals: true }) },
          { key: 'total', header: 'Total', align: 'right', render: (l: any) => inr(l.line_total, { decimals: true }) },
        ]} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <dl className="kv" style={{ minWidth: 260 }}>
          <dt>Taxable value</dt><dd className="num">{inr(inv.subtotal, { decimals: true })}</dd>
          {Number(inv.igst_total) > 0
            ? <><dt>IGST</dt><dd className="num">{inr(inv.igst_total, { decimals: true })}</dd></>
            : <><dt>CGST</dt><dd className="num">{inr(inv.cgst_total, { decimals: true })}</dd><dt>SGST</dt><dd className="num">{inr(inv.sgst_total, { decimals: true })}</dd></>}
          {Number(inv.round_off) !== 0 && <><dt>Round off</dt><dd className="num">{inr(inv.round_off, { decimals: true })}</dd></>}
          <dt><b>{t('grandTotal')}</b></dt><dd className="num"><b>{inr(inv.amount, { decimals: true })}</b></dd>
        </dl>
      </div>
      {(inv.returns?.length ?? 0) > 0 && (
        <Alert tone="info" title="Returns against this invoice">
          {inv.returns.map((r: any) => (
            <div key={r.return_id}>{formatDate(r.created_at)} · {r.credit_note_number ?? 'Return'} · refunded {inr(Number(r.refund_total) + Number(r.store_credit_total), { decimals: true })} ({r.refund_method})</div>
          ))}
        </Alert>
      )}
      {(inv.history?.length ?? 0) > 0 && (
        <div>
          <div className="section-title">History</div>
          {inv.history.map((h: any, i: number) => (
            <div key={i} className="muted small">{formatDateTime(h.created_at)} · {h.action.replace(/_/g, ' ').toLowerCase()} · {h.user_name ?? 'system'}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Till (3.3 / 3.3.1) ───────────────────────────────────────────────────────
function TillTab() {
  const { activeBranchId, user } = useAuth();
  const toast = useToast();
  const [openingFloat, setOpeningFloat] = useState('2000');
  const [counterId, setCounterId] = useState('COUNTER-1');
  const [countedCash, setCountedCash] = useState('');
  const [eventModal, setEventModal] = useState<null | 'CASH_DROP' | 'PETTY_EXPENSE_PAYOUT'>(null);
  const [eventAmount, setEventAmount] = useState('');
  const [eventNote, setEventNote] = useState('');
  const [eventCategory, setEventCategory] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const isManager = user?.role === 'OWNER_ADMIN' || user?.role === 'BRANCH_MANAGER';

  const { data: sessions, mutate } = useSWR<TillSession[]>(
    withBranch('/api/billing/till-sessions?limit=20&status=OPEN', activeBranchId), fetcher);
  const mine = sessions?.find((s) => s.cashier_user_id === user?.user_id);
  const others = (sessions ?? []).filter((s) => s.cashier_user_id !== user?.user_id);
  const [viewing, setViewing] = useState<string | null>(null);
  const open = (viewing ? sessions?.find((s) => s.session_id === viewing) : null) ?? mine;
  const { data: recon, mutate: mutateRecon } = useSWR<any>(open ? `/api/billing/till-sessions/${open.session_id}/reconcile` : null, fetcher);
  const { data: categories } = useSWR<any[]>(eventModal === 'PETTY_EXPENSE_PAYOUT' ? '/api/expenses/categories' : null, fetcher);

  async function openTill() {
    setBusy(true);
    try {
      await apiPost('/api/billing/till-sessions', { counter_id: counterId.trim(), opening_float: toNum(openingFloat) });
      toast.success('Till opened', `Opening cash ${inr(openingFloat, { decimals: true })}`); void mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function addEvent() {
    if (!open || !eventModal) return;
    setBusy(true);
    try {
      let approvalId: string | undefined;
      if (eventModal === 'CASH_DROP' && !isManager) {
        const res = await apiPost<{ approval_id: string }>('/api/auth/verify-override-pin', { pin, purpose: 'CASH_DROP' });
        approvalId = res.approval_id;
      }
      await apiPost(`/api/billing/till-sessions/${open.session_id}/events`, {
        event_type: eventModal, amount: toNum(eventAmount), note: eventNote || undefined, approval_id: approvalId,
        category_id: eventModal === 'PETTY_EXPENSE_PAYOUT' ? eventCategory : undefined,
      });
      toast.success(eventModal === 'CASH_DROP' ? 'Cash drop recorded' : 'Petty expense recorded');
      setEventModal(null); setEventAmount(''); setEventNote(''); setPin('');
      void mutateRecon(); void mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function closeTill() {
    if (!open) return;
    const expected = Number(recon?.expected_drawer_cash ?? 0);
    const variance = round2(toNum(countedCash) - expected);
    if (Math.abs(variance) > 0.01 && !window.confirm(`The drawer is ${variance > 0 ? 'over' : 'short'} by ${inr(Math.abs(variance), { decimals: true })}. Close the till with this variance recorded?`)) return;
    setBusy(true);
    try {
      const res = await apiPost<any>(`/api/billing/till-sessions/${open.session_id}/close`, { closing_counted_cash: toNum(countedCash) });
      toast.success('Till closed', Math.abs(res.variance) < 0.01 ? 'The drawer balanced exactly.' : `Variance of ${inr(res.variance, { decimals: true })} recorded.`);
      setCountedCash(''); setViewing(null); void mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <div className="stack">
        <Card title="Open your till" description="Count the cash you are starting with. Cash on every bill is then expected in this drawer.">
          <form className="stack" style={{ maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); void openTill(); }}>
            <Field label="Counter"><input value={counterId} onChange={(e) => setCounterId(e.target.value)} /></Field>
            <Field label="Opening cash (₹)" hint="The float placed in the drawer at the start of the shift">
              <input inputMode="decimal" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value.replace(/[^\d.]/g, ''))} />
            </Field>
            <Button variant="primary" type="submit" busy={busy} disabled={!counterId.trim()}>Open till</Button>
          </form>
        </Card>
        {isManager && others.length > 0 && <OtherTills tills={others} onView={setViewing} />}
      </div>
    );
  }

  const variance = countedCash === '' ? null : round2(toNum(countedCash) - Number(recon?.expected_drawer_cash ?? 0));
  const ownTill = open.cashier_user_id === user?.user_id;
  return (
    <div className="stack">
      {!ownTill && <Alert tone="info" title={`Viewing ${open.cashier_name}'s till (${open.counter_id})`}>
        <Button size="sm" onClick={() => setViewing(null)}>Back to your till</Button></Alert>}
      <div className="grid cols-4">
        <StatTile label="Opening cash" value={inr(recon?.opening_float, { decimals: true })} />
        <StatTile label="Cash sales (net of refunds)" value={inr(recon?.cash_sales, { decimals: true })} />
        <StatTile label="Cash received on account" value={inr(recon?.cash_receipts, { decimals: true })} />
        <StatTile label="Drops & petty cash" value={`− ${inr(Number(recon?.cash_drops ?? 0) + Number(recon?.petty_expenses ?? 0), { decimals: true })}`} />
      </div>
      <div className="grid cols-2">
        <Card title="Close the till" description="Expected = opening + cash sales + receipts − drops − petty payouts">
          <div className="row"><span className="label" style={{ flex: 1 }}>Expected in drawer</span>
            <span className="num pos-total">{inr(recon?.expected_drawer_cash, { decimals: true })}</span></div>
          <div className="divider" />
          <Field label="Actual cash counted (₹)">
            <input inputMode="decimal" value={countedCash} placeholder="Count the drawer and enter the total"
              onChange={(e) => setCountedCash(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          {variance !== null && (
            <div style={{ marginTop: 10 }}>
              <Alert tone={Math.abs(variance) < 0.01 ? 'good' : Math.abs(variance) < 100 ? 'warning' : 'critical'}>
                {Math.abs(variance) < 0.01 ? 'The drawer balances exactly.' : `Variance: ${variance > 0 ? 'over' : 'short'} by ${inr(Math.abs(variance), { decimals: true })}.`}
              </Alert>
            </div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <Button onClick={() => setEventModal('CASH_DROP')}>Cash drop</Button>
            <Button onClick={() => setEventModal('PETTY_EXPENSE_PAYOUT')}>Petty expense</Button>
            <div className="spacer" />
            <Button variant="primary" busy={busy} disabled={countedCash === ''} onClick={() => void closeTill()}>Close till</Button>
          </div>
        </Card>
        <Card title="Cash movements this shift" flush>
          <DataTable rows={recon?.events ?? []} emptyText="No cash movements yet this shift." rowKey={(e: any) => e.event_id}
            columns={[
              { key: 'type', header: 'Event', render: (e: any) => (
                <Badge tone={e.event_type === 'CASH_SALE' || e.event_type === 'CASH_RECEIPT' ? 'good' : e.event_type === 'CLOSING_COUNT' ? 'neutral' : 'warning'}>
                  {e.event_type.replace(/_/g, ' ').toLowerCase()}</Badge>) },
              { key: 'note', header: 'Note', render: (e: any) => e.note ?? <span className="muted">—</span> },
              { key: 'ack', header: 'Approved by', render: (e: any) => e.acknowledged_by_name ?? <span className="muted">—</span> },
              { key: 'time', header: 'Time', nowrap: true, render: (e: any) => formatDateTime(e.created_at) },
              { key: 'amt', header: 'Amount', align: 'right', render: (e: any) => inr(e.amount, { decimals: true }) },
            ]} />
        </Card>
      </div>
      {isManager && others.length > 0 && <OtherTills tills={others} onView={setViewing} />}

      <Modal open={eventModal !== null} onClose={() => setEventModal(null)}
        title={eventModal === 'CASH_DROP' ? 'Record a cash drop' : 'Record a petty expense'}
        footer={<>
          <Button onClick={() => setEventModal(null)}>Cancel</Button>
          <Button variant="primary" busy={busy}
            disabled={!(toNum(eventAmount) > 0) || (eventModal === 'PETTY_EXPENSE_PAYOUT' && !eventCategory) || (eventModal === 'CASH_DROP' && !isManager && pin.length < 4)}
            onClick={() => void addEvent()}>Record</Button>
        </>}>
        <div className="stack">
          <Alert tone="info">
            {eventModal === 'CASH_DROP'
              ? 'Cash moved from the drawer to the safe or the owner. A manager must approve it, and it stops the till reading short at close.'
              : 'A small expense paid from the drawer. It becomes an expense record against a category.'}
          </Alert>
          <Field label="Amount (₹)"><input inputMode="decimal" value={eventAmount} onChange={(e) => setEventAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          {eventModal === 'PETTY_EXPENSE_PAYOUT' && (
            <Field label="Expense category">
              <select value={eventCategory} onChange={(e) => setEventCategory(e.target.value)}>
                <option value="">Choose…</option>
                {(categories ?? []).map((c: any) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Note"><input value={eventNote} onChange={(e) => setEventNote(e.target.value)} /></Field>
          {eventModal === 'CASH_DROP' && !isManager && (
            <Field label="Manager PIN" hint="The manager approving this drop enters their PIN">
              <input type="password" inputMode="numeric" maxLength={6} value={pin} autoComplete="off"
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Field>
          )}
        </div>
      </Modal>
    </div>
  );
}

function OtherTills({ tills, onView }: { tills: TillSession[]; onView: (id: string) => void }) {
  return (
    <Card flush title="Other open tills at this branch">
      <DataTable rows={tills} rowKey={(s) => s.session_id} onRowClick={(s) => onView(s.session_id)}
        columns={[
          { key: 'c', header: 'Counter', render: (s) => s.counter_id },
          { key: 'u', header: 'Cashier', render: (s) => s.cashier_name },
          { key: 'o', header: 'Opened', render: (s) => formatDateTime(s.opened_at) },
          { key: 'e', header: 'Expected cash', align: 'right', render: (s) => inr(s.expected_drawer_cash, { decimals: true }) },
        ]} />
    </Card>
  );
}

// ── Offline stock conflicts (3.5.1) ──────────────────────────────────────────
function ConflictsTab() {
  const { activeBranchId, can } = useAuth();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<any[]>(withBranch('/api/billing/stock-conflicts', activeBranchId), fetcher);
  async function resolve(id: string, resolution: string) {
    try { await apiPost(`/api/billing/stock-conflicts/${id}/resolve`, { resolution }); toast.success('Conflict resolved'); void mutate(); }
    catch (err) { toast.error(err); }
  }
  return (
    <Card flush title="Sales that arrived against insufficient stock"
      description="A sale already made at the counter is never voided automatically — it is listed here for a person to decide.">
      <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
        empty={<EmptyState icon="check" title="Nothing to resolve" text="No offline sale has conflicted with stock." />}>
        {(rows) => (
          <DataTable rows={rows} rowKey={(r: any) => r.conflict_id}
            columns={[
              { key: 'inv', header: 'Invoice', render: (r: any) => <span className="mono">{r.invoice_number}</span> },
              { key: 'prod', header: 'Product', render: (r: any) => r.product_name },
              { key: 'req', header: 'Sold', align: 'right', render: (r: any) => num(r.requested_qty) },
              { key: 'avail', header: 'Available', align: 'right', render: (r: any) => num(r.available_qty) },
              { key: 'when', header: 'Raised', nowrap: true, render: (r: any) => formatDateTime(r.created_at) },
              { key: 'act', header: '', render: (r: any) => can('resolve_stock_conflict') && (
                <select defaultValue="" aria-label="Resolve as" onChange={(e) => e.target.value && void resolve(r.conflict_id, e.target.value)} style={{ width: 190 }}>
                  <option value="">Resolve as…</option>
                  <option value="SUBSTITUTED">Substituted item</option>
                  <option value="BACKORDERED">Backordered</option>
                  <option value="NEGATIVE_STOCK_OVERRIDE">Stock count was wrong</option>
                  <option value="CANCELLED">Cancelled with customer</option>
                </select>) },
            ]} />
        )}
      </AsyncSection>
    </Card>
  );
}
