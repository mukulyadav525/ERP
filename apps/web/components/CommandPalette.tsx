// ============================================================================
// Global search and quick actions — Ctrl/Cmd + K.
//
// The counter's fastest path to a record. It searches whatever the person typed
// against invoices, estimates, customers, vendors, products, SKUs, barcodes and
// phone numbers in one request, and it does NOT decide what the searcher is
// allowed to see: the server filters by role and the database filters by branch,
// so this component renders whatever comes back and nothing more.
//
// It doubles as the quick-actions menu. With an empty box it lists the handful of
// operations a cashier repeats all day; start typing and it becomes search.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiGet, inr, withBranch } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Icon, type IconName } from './icons';

interface Hit {
  type: 'invoice' | 'estimate' | 'customer' | 'vendor' | 'product' | 'payment' | 'receipt'
      | 'purchase_order' | 'purchase' | 'transfer' | 'credit_note';
  id: string; title: string; subtitle: string | null;
  amount: number | null; status: string | null; href: string;
}

const TYPE_META: Record<Hit['type'], { label: string; icon: IconName }> = {
  invoice:        { label: 'Bill',           icon: 'billing' },
  estimate:       { label: 'Estimate',       icon: 'quotation' },
  customer:       { label: 'Customer',       icon: 'customers' },
  vendor:         { label: 'Vendor',         icon: 'vendors' },
  product:        { label: 'Product',        icon: 'catalog' },
  payment:        { label: 'Payment',        icon: 'rupee' },
  receipt:        { label: 'Receipt',        icon: 'receipt' },
  purchase_order: { label: 'Purchase order', icon: 'inventory' },
  purchase:       { label: 'Purchase',       icon: 'truck' },
  transfer:       { label: 'Transfer',       icon: 'truck' },
  credit_note:    { label: 'Credit note',    icon: 'returns' },
};

interface QuickAction { label: string; href: string; icon: IconName; permission: string; hint: string; }

const QUICK_ACTIONS: QuickAction[] = [
  { label: 'New bill',        href: '/billing?new=1',      icon: 'billing',   permission: 'create_invoice',          hint: 'Ctrl N' },
  { label: 'New customer',    href: '/customers?new=1',    icon: 'customers', permission: 'edit_customer',           hint: '' },
  { label: 'Add product',     href: '/catalog?new=1',      icon: 'catalog',   permission: 'edit_catalog',            hint: '' },
  { label: 'New purchase',    href: '/inventory?new=grn',  icon: 'inventory', permission: 'create_grn',              hint: '' },
  { label: 'Record payment',  href: '/customers?tab=outstanding', icon: 'rupee', permission: 'record_customer_payment', hint: '' },
  { label: 'New estimate',    href: '/quotations?new=1',   icon: 'quotation', permission: 'create_quotation',        hint: '' },
  { label: 'Process a return', href: '/returns',           icon: 'returns',   permission: 'process_return',          hint: '' },
  { label: 'Add expense',     href: '/expenses?new=1',     icon: 'expenses',  permission: 'create_expense',          hint: '' },
];

export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { can, activeBranchId } = useAuth();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against an older, slower response overwriting a newer one — the classic
  // way a search box ends up showing results for a query the user already replaced.
  const seq = useRef(0);

  const actions = useMemo(() => QUICK_ACTIONS.filter((a) => can(a.permission)), [can]);
  const showingActions = query.trim().length < 2;
  const rows: Array<{ key: string; go: string }> = showingActions
    ? actions.map((a) => ({ key: a.href, go: a.href }))
    : hits.map((h) => ({ key: `${h.type}:${h.id}`, go: h.href }));

  // Focus is taken as the input mounts (autoFocus below), in the same commit that
  // opens the palette. A timer here lost whatever was typed in its first 20 ms —
  // Ctrl+K then "putty" arrived as "utty".
  useEffect(() => {
    if (!open) { setQuery(''); setHits([]); setCursor(0); setFailed(null); }
  }, [open]);

  // Debounced so a fast typist makes one request per pause rather than one per key.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term.length < 2) { setHits([]); setBusy(false); setFailed(null); return; }
    setBusy(true);
    const mine = ++seq.current;
    const id = window.setTimeout(() => {
      apiGet<{ results: Hit[] }>(withBranch(`/api/search?q=${encodeURIComponent(term)}`, activeBranchId))
        .then((r) => { if (mine === seq.current) { setHits(r.results ?? []); setFailed(null); setCursor(0); } })
        .catch((e) => { if (mine === seq.current) { setHits([]); setFailed(e?.message ?? 'Search is unavailable right now.'); } })
        .finally(() => { if (mine === seq.current) setBusy(false); });
    }, 220);
    return () => window.clearTimeout(id);
  }, [query, open, activeBranchId]);

  const go = useCallback((href: string) => { onClose(); void router.push(href); }, [onClose, router]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) go(row.go);
    }
  }

  if (!open) return null;

  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search BHAWANI ONE">
        <div className="palette-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search bills, customers, products, SKU, barcode or phone"
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
          />
          {busy && <span className="spinner" aria-label="Searching" />}
          <kbd className="palette-kbd">Esc</kbd>
        </div>

        <div className="palette-results" role="listbox">
          {failed && (
            <div className="palette-msg">
              <Icon name="alert" size={16} /> {failed}
            </div>
          )}

          {showingActions && !failed && (
            <>
              <div className="palette-group">Quick actions</div>
              {actions.map((a, i) => (
                <button key={a.href} className={`palette-row${i === cursor ? ' active' : ''}`}
                        role="option" aria-selected={i === cursor}
                        onMouseEnter={() => setCursor(i)} onClick={() => go(a.href)}>
                  <span className="palette-ico"><Icon name={a.icon} size={16} /></span>
                  <span className="palette-main"><span className="palette-title">{a.label}</span></span>
                  {a.hint && <kbd className="palette-kbd">{a.hint}</kbd>}
                </button>
              ))}
              {!actions.length && (
                <div className="palette-msg">Type at least two characters to search.</div>
              )}
            </>
          )}

          {!showingActions && !failed && !busy && !hits.length && (
            <div className="palette-msg">
              No match for &ldquo;{query.trim()}&rdquo; in anything you can see.
            </div>
          )}

          {!showingActions && hits.map((h, i) => (
            <button key={`${h.type}:${h.id}`} className={`palette-row${i === cursor ? ' active' : ''}`}
                    role="option" aria-selected={i === cursor}
                    onMouseEnter={() => setCursor(i)} onClick={() => go(h.href)}>
              <span className="palette-ico"><Icon name={TYPE_META[h.type].icon} size={16} /></span>
              <span className="palette-main">
                <span className="palette-title">
                  <span className="palette-type">{TYPE_META[h.type].label}</span>
                  {h.title}
                </span>
                {h.subtitle && <span className="palette-sub">{h.subtitle}</span>}
              </span>
              {h.amount !== null && <span className="palette-amount num">{inr(h.amount, { decimals: true })}</span>}
            </button>
          ))}
        </div>

        <div className="palette-foot">
          <span><kbd className="palette-kbd">↑</kbd><kbd className="palette-kbd">↓</kbd> move</span>
          <span><kbd className="palette-kbd">↵</kbd> open</span>
          <span className="spacer" />
          <span className="muted">Results are limited to what your role and branch allow.</span>
        </div>
      </div>
    </div>
  );
}
