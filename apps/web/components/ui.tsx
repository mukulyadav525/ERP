// ============================================================================
// The shared component kit. Every screen builds from these, which is what makes
// the UI consistent — there is no second way to render a table, a stat tile or a
// modal anywhere in the app.
// ============================================================================
import React, { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { useI18n } from '../lib/i18n';
import { Icon, type IconName } from './icons';

// ── Page furniture ──────────────────────────────────────────────────────────
export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, right, children, flush, footer }: {
  title?: string; description?: string; right?: React.ReactNode;
  children: React.ReactNode; flush?: boolean; footer?: React.ReactNode;
}) {
  return (
    <div className="card">
      {(title || right) && (
        <div className="card-head">
          <div className="grow" style={{ flex: 1, minWidth: 0 }}>
            {title && <div className="card-title">{title}</div>}
            {description && <div className="card-desc">{description}</div>}
          </div>
          {right}
        </div>
      )}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </div>
  );
}

export function StatTile({ label, value, delta, deltaDir, hint }: {
  label: string; value: React.ReactNode;
  delta?: string | null; deltaDir?: 'up' | 'down' | 'flat'; hint?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {delta != null && (
        <div className={`stat-delta ${deltaDir ?? 'flat'}`}>
          <span aria-hidden>{deltaDir === 'up' ? '▲' : deltaDir === 'down' ? '▼' : '–'}</span>
          {delta}
        </div>
      )}
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/** Turns a percentage change into the tile's delta props, so no page repeats
 *  the "is null / is negative / round it" logic. */
export function deltaProps(pct: number | null | undefined, suffix = 'vs previous period') {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return {};
  return {
    delta: `${Math.abs(pct).toFixed(1)}% ${suffix}`,
    deltaDir: (pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat') as 'up' | 'down' | 'flat',
  };
}

// ── Buttons & controls ──────────────────────────────────────────────────────
export function Button({ variant = 'default', size, busy, children, ...rest }: {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'lg';
  busy?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={`btn ${variant !== 'default' ? variant : ''} ${size ?? ''} ${rest.className ?? ''}`}
    >
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, required }: {
  label?: string; hint?: string; error?: string | null; children: React.ReactNode; required?: boolean;
}) {
  // The label is tied to its control, so a screen reader announces "Due date"
  // rather than "edit text", and clicking the label focuses the input. Only a
  // single native control is wired automatically; a composite child (a combobox,
  // a row of inputs) names itself.
  const autoId = useId();
  const only = React.Children.count(children) === 1 && React.isValidElement(children)
    ? (children as React.ReactElement<any>) : null;
  const native = only && typeof only.type === 'string' && ['input', 'select', 'textarea'].includes(only.type);
  const controlId: string = (native && only?.props.id) || autoId;
  const noteId = `${controlId}-note`;
  const note = error || hint;
  const control = native && only
    ? React.cloneElement(only, {
        id: controlId,
        'aria-describedby': note ? noteId : only.props['aria-describedby'],
        'aria-invalid': error ? true : only.props['aria-invalid'],
        'aria-required': required || only.props['aria-required'],
      })
    : children;
  return (
    <div className="field">
      {label && (
        <label htmlFor={native ? controlId : undefined}>
          {label}
          {required && <span style={{ color: 'var(--status-critical)' }} aria-hidden="true"> *</span>}
        </label>
      )}
      {control}
      {error ? <span className="error-text" id={noteId} role="alert">{error}</span>
        : hint ? <span className="hint" id={noteId}>{hint}</span> : null}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string;
}) {
  const id = useId();
  const toggle = (
    <span className="switch">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-label={label}
             onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
    </span>
  );
  // The label is shown next to the toggle — a bare toggle says nothing about what it switches.
  if (!label) return <label htmlFor={id} style={{ display: 'inline-flex' }}>{toggle}</label>;
  return (
    <label className="switch-field" htmlFor={id}>
      {toggle}
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder, inputRef, onEnter, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  /** Exposed so the caller can keep focus here — a USB/Bluetooth barcode scanner
   *  is a keyboard, and it types wherever the caret happens to be. */
  inputRef?: React.RefObject<HTMLInputElement>;
  /** Fires on Enter, which is also the terminator a scanner sends after a code. */
  onEnter?: (value: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="searchbar">
      <span className="search-icon"><Icon name="search" size={15} /></span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder ?? `${t('search')}…`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(value); } } : undefined}
      />
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: {
  tabs: { key: string; label: string; count?: number }[];
  active: string; onChange: (key: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key} role="tab" aria-selected={active === tab.key}
          className={`tab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}{tab.count !== undefined ? ` (${tab.count})` : ''}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: {
  tone?: 'good' | 'warning' | 'critical' | 'info' | 'neutral'; children: React.ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/** One place that decides what colour a status word gets, so PENDING looks the
 *  same on the expenses screen as on the transfers screen. */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = String(status ?? '').toUpperCase();
  const tone =
    ['APPROVED', 'FINAL', 'RECEIVED', 'COMPLETED', 'CLOSED', 'SENT', 'REPLACED', 'REPAIRED', 'ACTIVE', 'CONVERTED'].includes(s) ? 'good'
    : ['PENDING', 'DRAFT', 'REQUESTED', 'OPEN', 'QUEUED', 'DISPATCHED', 'IN_PROGRESS', 'PARTIALLY_RECEIVED', 'SENT_TO_VENDOR'].includes(s) ? 'warning'
    : ['REJECTED', 'VOID', 'FAILED', 'CANCELLED', 'EXPIRED', 'TRANSFER_DISCREPANCY'].includes(s) ? 'critical'
    : 'neutral';
  const label = s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return <Badge tone={tone as any}>{label || '—'}</Badge>;
}

export function Alert({ tone = 'info', title, children }: {
  tone?: 'info' | 'good' | 'warning' | 'critical'; title?: string; children?: React.ReactNode;
}) {
  const icon: IconName = tone === 'good' ? 'check'
    : tone === 'critical' || tone === 'warning' ? 'alert' : 'info';
  return (
    <div className={`alert ${tone}`}>
      <span className="alert-icon"><Icon name={icon} size={16} /></span>
      <div>
        {title && <b>{title}</b>}
        {title && children ? <br /> : null}
        {children}
      </div>
    </div>
  );
}

// ── States ──────────────────────────────────────────────────────────────────
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 9 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 15, width: `${100 - i * 8}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon = 'inbox', title, text, action }: {
  /** A name from the shared monoline set — never a literal glyph, so empty states
   *  across the app are drawn at one weight and follow the theme. */
  icon?: IconName; title?: string; text?: string; action?: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="empty-state">
      <span className="icon"><Icon name={icon} size={26} strokeWidth={1.5} /></span>
      {title && <div className="title">{title}</div>}
      <div>{text ?? t('noData')}</div>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Could not load this data.';
  return (
    <div className="empty-state">
      <span className="icon"><Icon name="alert" size={26} strokeWidth={1.5} /></span>
      <div className="title">Could not load</div>
      <div style={{ maxWidth: 460, margin: '0 auto' }}>{message}</div>
      {onRetry && <div style={{ marginTop: 14 }}><Button onClick={onRetry}>Try again</Button></div>}
    </div>
  );
}

/**
 * The one place list screens decide between loading / error / empty / content.
 * Without it every page reinvents the ladder and they drift apart.
 */
export function AsyncSection<T>({ data, error, isLoading, empty, children, onRetry }: {
  data: T[] | undefined; error?: unknown; isLoading?: boolean;
  empty?: React.ReactNode; onRetry?: () => void;
  children: (rows: T[]) => React.ReactNode;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isLoading && !data) return <LoadingState />;
  if (!data || data.length === 0) return <>{empty ?? <EmptyState />}</>;
  return <>{children(data)}</>;
}

// ── Table ───────────────────────────────────────────────────────────────────
export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  width?: number | string;
  nowrap?: boolean;
  render: (row: T) => React.ReactNode;
}

export function DataTable<T>({ columns, rows, onRowClick, footer, emptyText, rowKey, stackOnMobile = true }: {
  columns: Column<T>[]; rows: T[];
  onRowClick?: (row: T) => void; footer?: React.ReactNode; emptyText?: string;
  /** A stable key per row; falls back to common id fields, then the index. */
  rowKey?: (row: T) => string;
  /** Below 640px each row becomes a labelled block instead of a sideways-scrolling table. */
  stackOnMobile?: boolean;
}) {
  if (!rows.length) return <EmptyState text={emptyText} />;
  const keyOf = (row: T, i: number): string => {
    if (rowKey) return rowKey(row);
    const r = row as any;
    return String(r.id ?? r.invoice_id ?? r.product_id ?? r.customer_id ?? r.vendor_id ?? r.grn_id
      ?? r.entry_id ?? r.payment_id ?? r.return_id ?? r.quotation_id ?? r.expense_id ?? r.transfer_id ?? i);
  };
  return (
    <>
      <div className="table-wrap">
        <table className={`data${stackOnMobile ? ' stack-sm' : ''}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={`${c.align === 'right' ? 'num' : ''} ${c.nowrap ? 'nowrap' : ''}`}
                    style={c.width ? { width: c.width } : undefined}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={keyOf(row, i)} className={onRowClick ? 'clickable' : ''}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} data-label={c.header || undefined}
                      className={`${c.align === 'right' ? 'num' : ''} ${c.nowrap ? 'nowrap' : ''}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && <div className="table-footer">{footer}</div>}
    </>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string;
  children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Read through a ref: parents usually pass an inline arrow, and re-running the
  // effect on every render would steal focus back to the first field while the
  // person is typing in another one.
  const closeRef = useRef(onClose); closeRef.current = onClose;

  // Escape closes, Tab stays inside the dialog, the page behind does not scroll,
  // and focus returns to whatever opened the dialog when it closes.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((el) => el.offsetParent !== null);
    const onKey = (e: KeyboardEvent) => {
      // With one dialog opened from another, only the top one (last in the
      // document) answers: Escape closes it alone, and Tab stays inside it.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length && dialogs[dialogs.length - 1] !== ref.current) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const els = focusable();
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const body = ref.current?.querySelector('.modal-body');
    (body?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
      ?? ref.current?.querySelector<HTMLElement>('button'))?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <h3 id={titleId} style={{ flex: 1 }}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel, tone = 'danger', onConfirm, onCancel, busy }: {
  open: boolean; title: string; message: React.ReactNode; confirmLabel?: string;
  tone?: 'danger' | 'primary'; onConfirm: () => void; onCancel: () => void; busy?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Modal open={open} onClose={onCancel} title={title}
      footer={<>
        <Button onClick={onCancel} disabled={busy}>{t('cancel')}</Button>
        <Button variant={tone} onClick={onConfirm} busy={busy}>{confirmLabel ?? 'Confirm'}</Button>
      </>}>
      <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{message}</div>
    </Modal>
  );
}

// ── Access control ──────────────────────────────────────────────────────────
/** Renders children only when the user holds the permission. Used for buttons
 *  and panels; the server enforces the same rule regardless. */
export function Can({ permission, children, fallback = null }: {
  permission: string; children: React.ReactNode; fallback?: React.ReactNode;
}) {
  const { can } = useAuth();
  return <>{can(permission) ? children : fallback}</>;
}

export function AccessDenied({ permission }: { permission?: string }) {
  const { roleLabel } = useAuth();
  return (
    <div className="card">
      <div className="empty-state">
        <span className="icon"><Icon name="lock" size={26} strokeWidth={1.5} /></span>
        <div className="title">You do not have access to this screen</div>
        <div style={{ maxWidth: 460, margin: '0 auto' }}>
          Your role ({roleLabel}) is not permitted to
          {permission ? ` ${permission.replace(/_/g, ' ')}` : ' view this'}.
          If you need it, ask the owner to change your role in Admin → Users.
        </div>
      </div>
    </div>
  );
}

/** Wraps a whole page. Anything a role cannot reach shows the explanation above
 *  rather than an empty screen or a raw 403. */
export function RequirePermission({ permission, children }: {
  permission: string; children: React.ReactNode;
}) {
  const { can, isLoading } = useAuth();
  if (isLoading) return <LoadingState />;
  if (!can(permission)) return <AccessDenied permission={permission} />;
  return <>{children}</>;
}

// ── Branch filter (Section 0) ───────────────────────────────────────────────
/**
 * Only an Owner sees a branch selector at all: every other role is locked to one
 * branch, so a control that could not do anything would be a lie. For them this
 * renders their branch name as plain text.
 */
export function BranchFilter() {
  const { user, branches, activeBranchId, setActiveBranchId, canSwitchBranch } = useAuth();
  const { t } = useI18n();

  if (!user) return null;
  const isOwner = user.role === 'OWNER_ADMIN';
  if (!isOwner && !canSwitchBranch) {
    // One branch, nothing to choose: show where they are working, as plain text.
    const name = branches.find((b) => b.branch_id === activeBranchId)?.name ?? user.branch_name;
    if (!name) return null;
    return (
      <span className="badge neutral" title="Your account works at this branch">
        <Icon name="branch" size={13} /> {name}
      </span>
    );
  }
  // A select rather than a row of pills: it fits a phone's top bar however many
  // branches there are, and it is one keyboard stop instead of one per branch.
  return (
    <select className="branch-select" aria-label="Branch" value={activeBranchId ?? ''}
      onChange={(e) => setActiveBranchId(e.target.value || null)}>
      {isOwner && <option value="">{t('allBranches')}</option>}
      {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
    </select>
  );
}

/**
 * Wraps anything that records a physical transaction (a bill, a goods receipt, a
 * payment). "All branches" is a way of LOOKING at the chain, not a place a sale
 * happens, so an owner on "All branches" is asked to pick one first — in plain
 * words, before anything is typed, rather than with an error after submitting.
 */
export function BranchGate({ children, what = 'this transaction' }: { children: React.ReactNode; what?: string }) {
  const { needsBranchForTransaction, branches, setActiveBranchId } = useAuth();
  if (!needsBranchForTransaction) return <>{children}</>;
  return (
    <div className="branch-gate stack" role="group" aria-label="Select a branch">
      <div>
        <b>Please select a branch for {what}.</b>
        <div className="muted small">You are viewing all branches. A sale, receipt or purchase always happens at one branch.</div>
      </div>
      <select aria-label="Branch for this transaction" defaultValue=""
        onChange={(e) => e.target.value && setActiveBranchId(e.target.value)} style={{ maxWidth: 320 }}>
        <option value="" disabled>Choose a branch…</option>
        {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
      </select>
    </div>
  );
}

// ── Period picker (dashboard, reports) ──────────────────────────────────────
export type PeriodValue = { period: string; from?: string; to?: string };
export const PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' }, { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' }, { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' }, { value: 'this_fy', label: 'This financial year' },
  { value: 'custom', label: 'Custom range…' },
];
/** The query string for a period, for any report endpoint. */
export function periodQuery(p: PeriodValue): string {
  if (p.period === 'custom' && p.from && p.to) return `from=${p.from}&to=${p.to}`;
  return `period=${p.period === 'custom' ? 'last_30_days' : p.period}`;
}
export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  return (
    <div className="period-picker">
      <select aria-label="Period" value={value.period} style={{ width: 'auto' }}
        onChange={(e) => onChange({ ...value, period: e.target.value })}>
        {PERIOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {value.period === 'custom' && (
        <>
          <input type="date" aria-label="From" value={value.from ?? ''} max={value.to}
            onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <span className="muted small">to</span>
          <input type="date" aria-label="To" value={value.to ?? ''} min={value.from}
            onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </div>
  );
}

/** "Showing N · Load more" for lists fetched a page at a time. */
export function Pager({ shown, pageSize, onMore, busy }: {
  shown: number; pageSize: number; onMore: () => void; busy?: boolean;
}) {
  const maybeMore = shown > 0 && shown % pageSize === 0;
  return (
    <div className="pager">
      <span>{shown} shown</span>
      {maybeMore && <Button size="sm" onClick={onMore} busy={busy}>Load more</Button>}
    </div>
  );
}

// ── Misc ────────────────────────────────────────────────────────────────────
export function KeyValue({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** Debounces a value — used for every search box so typing does not fire a
 *  request per keystroke. */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export const SERIES_VARS = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
];
