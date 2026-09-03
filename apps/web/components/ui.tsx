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
  return (
    <div className="field">
      {label && (
        <label>
          {label}
          {required && <span style={{ color: 'var(--status-critical)' }}> *</span>}
        </label>
      )}
      {children}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string;
}) {
  const id = useId();
  return (
    <label className="switch" htmlFor={id} aria-label={label}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
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

export function DataTable<T>({ columns, rows, onRowClick, footer, emptyText }: {
  columns: Column<T>[]; rows: T[];
  onRowClick?: (row: T) => void; footer?: React.ReactNode; emptyText?: string;
}) {
  if (!rows.length) return <EmptyState text={emptyText} />;
  return (
    <>
      <div className="table-wrap">
        <table className="data">
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
              <tr key={(row as any).id ?? i} className={onRowClick ? 'clickable' : ''}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={`${c.align === 'right' ? 'num' : ''} ${c.nowrap ? 'nowrap' : ''}`}>
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

  // Escape closes, and the body stops scrolling behind the dialog — both are the
  // kind of thing that is obviously missing the moment it is missing.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h3 style={{ flex: 1 }}>{title}</h3>
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
  const { user, branches, activeBranchId, setActiveBranchId } = useAuth();
  const { t } = useI18n();

  if (!user) return null;
  if (user.role !== 'OWNER_ADMIN') {
    // The branch name arrives with the login response, so this is populated on the
    // first paint. If it somehow is not, show nothing rather than the word
    // "Branch", which reads like a real branch called Branch.
    const name = user.branch_name ?? branches.find((b) => b.branch_id === user.branch_id)?.name;
    if (!name) return null;
    return (
      <span className="badge neutral" title="Your account is scoped to this branch">
        ⌂ {name}
      </span>
    );
  }
  return (
    <div className="pill-row">
      <button className={`pill ${activeBranchId === null ? 'active' : ''}`} onClick={() => setActiveBranchId(null)}>
        {t('allBranches')}
      </button>
      {branches.map((b) => (
        <button key={b.branch_id}
          className={`pill ${activeBranchId === b.branch_id ? 'active' : ''}`}
          onClick={() => setActiveBranchId(b.branch_id)}>
          {b.name}
        </button>
      ))}
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
