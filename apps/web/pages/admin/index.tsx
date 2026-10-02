// Section 17 — Admin Control Panel.
import React, { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiDelete, apiPost, apiPut, downloadCsv, fetcher, formatDate, formatDateTime, num } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, Field,
  KeyValue, Modal, PageHeader, RequirePermission, StatTile, StatusBadge,
  Switch, Tabs,
} from '../../components/ui';
import ExportButton from '../../components/ExportButton';
import { StateSelect, stateName } from '../../components/pickers';

export default function AdminPage() {
  return (
    <RequirePermission permission="view_admin">
      <AdminScreen />
    </RequirePermission>
  );
}

function AdminScreen() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'settings' | 'users' | 'branches' | 'audit' | 'compliance'>('settings');
  const { data: overview } = useSWR<any>('/api/admin/overview', fetcher);
  const { data: pendingRegs } = useSWR<any[]>('/api/auth/registration-requests', fetcher);

  return (
    <>
      <PageHeader title={t('navAdmin')} subtitle="Settings, users, branches, audit trail and compliance" />

      {overview && (
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <StatTile label="Branches" value={num(overview.branch_count, 0)} />
          <StatTile label="Active users" value={num(overview.active_user_count, 0)}
            hint={Number(overview.pending_registrations) > 0
              ? `${overview.pending_registrations} awaiting approval` : undefined} />
          <StatTile label="Products" value={num(overview.active_product_count, 0)} />
          <StatTile label="Needs attention"
            value={num(Number(overview.pending_expenses) + Number(overview.transfer_discrepancies)
                     + Number(overview.open_stock_conflicts) + Number(overview.pending_leave), 0)}
            hint="Approvals, discrepancies and conflicts" />
        </div>
      )}

      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'settings', label: 'Settings' },
          { key: 'users', label: 'Users', count: pendingRegs?.length },
          { key: 'branches', label: 'Branches' },
          { key: 'audit', label: 'Audit trail' },
          { key: 'compliance', label: 'Compliance' },
        ]} />

      {tab === 'settings' && <SettingsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'branches' && <BranchesTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'compliance' && <ComplianceTab />}
    </>
  );
}

// ── Settings (Section 17) ───────────────────────────────────────────────────

/**
 * A JSON setting that can actually be changed.
 *
 * The previous version rendered these read-only, behind a "view" disclosure —
 * which meant a setting the requirements describe as admin-configurable could
 * not be configured. The text is validated before it is sent so a stray comma
 * is caught here rather than by a 400 from the server.
 */
function JsonSetting({ setting, disabled, busy, onSave }: {
  setting: any; disabled: boolean; busy: boolean; onSave: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(setting.effective_value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div style={{ textAlign: 'right' }}>
        <Button size="sm" disabled={disabled} onClick={() => {
          setText(JSON.stringify(setting.effective_value ?? {}, null, 2));
          setError(null); setOpen(true);
        }}>Edit</Button>
      </div>
    );
  }
  return (
    <div>
      <textarea value={text} rows={7} spellCheck={false}
        aria-label={`${setting.label} value`}
        style={{ width: '100%', fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
        onChange={(e) => { setText(e.target.value); setError(null); }} />
      {error && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
      <div className="row tight" style={{ marginTop: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" variant="primary" busy={busy} onClick={() => {
          try {
            const parsed = JSON.parse(text);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              setError('This setting must be a JSON object.'); return;
            }
            onSave(parsed); setOpen(false);
          } catch (err: any) { setError(err.message); }
        }}>Save</Button>
      </div>
    </div>
  );
}

/** The fields printed on every invoice, cash memo and estimate (Section 65). */
const PROFILE_FIELDS: { key: string; label: string; hint?: string; wide?: boolean }[] = [
  { key: 'name', label: 'Business name' },
  { key: 'legal_name', label: 'Legal name', hint: 'Used on the signature line, if different' },
  { key: 'dealing_in', label: 'Dealing in', hint: 'The categories line under the shop name', wide: true },
  { key: 'address', label: 'Address', wide: true },
  { key: 'city_state', label: 'City / State line' },
  { key: 'phone', label: 'Phone' },
  { key: 'alt_phone', label: 'Alternate phone' },
  { key: 'email', label: 'Email' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'state', label: 'State' },
  { key: 'state_code', label: 'State code' },
  { key: 'bank_name', label: 'Bank' },
  { key: 'bank_branch', label: 'Bank branch' },
  { key: 'bank_account_no', label: 'Account number' },
  { key: 'bank_ifsc', label: 'IFSC' },
  { key: 'upi_id', label: 'UPI ID' },
  { key: 'jurisdiction', label: 'Jurisdiction', hint: 'Printed as "Subject to … jurisdiction"' },
  { key: 'signature_label', label: 'Signature label' },
  { key: 'declaration', label: 'Declaration', wide: true },
];

/**
 * The business identity behind every printed document.
 *
 * A form rather than a JSON blob, because the person who needs to change the
 * shop's GSTIN or bank account is the owner, not an engineer — and a mistyped
 * brace should not be able to break every invoice the shop prints.
 */
function BusinessProfileModal({ open, onClose, value, onSave, busy }: {
  open: boolean; onClose: () => void; value: any; onSave: (v: any) => void; busy: boolean;
}) {
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [terms, setTerms] = useState('');

  useEffect(() => {
    if (!open) return;
    const v = value ?? {};
    setDraft({ ...v });
    setTerms(Array.isArray(v.terms) ? v.terms.join('\n') : '');
  }, [open, value]);

  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Modal guardUnsaved open={open} onClose={onClose} wide title="Business profile — printed documents"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={() => onSave({
          ...draft,
          terms: terms.split('\n').map((t) => t.trim()).filter(Boolean).slice(0, 8),
        })}>Save profile</Button>
      </>}>
      <p className="muted small" style={{ marginTop: 0 }}>
        These appear on GST invoices, cash memos and estimates. A branch may hold its own
        profile — pick the branch above before editing to override the chain-wide one.
      </p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        {PROFILE_FIELDS.map((f) => (
          <div key={f.key} style={f.wide ? { gridColumn: '1 / -1' } : undefined}>
            <Field label={f.label} hint={f.hint}>
              {f.wide && (f.key === 'declaration' || f.key === 'address')
                ? <textarea rows={2} value={draft[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                : <input value={draft[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />}
            </Field>
          </div>
        ))}
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Terms & conditions" hint="One per line, up to 8">
            <textarea rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} />
          </Field>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <Field label="Logo" hint="Paste an embedded image as a data: URI (data:image/png;base64,…). Leave blank to use the monogram.">
            <input value={draft.logo ?? ''} onChange={(e) => set('logo', e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function SettingsTab() {
  const toast = useToast();
  const { branches } = useAuth();
  const [branchId, setBranchId] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const path = `/api/admin/settings${branchId ? `?branch_id=${branchId}` : ''}`;
  const { data, error, isLoading, mutate } = useSWR<any[]>(path, fetcher);

  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const s of data ?? []) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group)!.push(s);
    }
    return [...map.entries()];
  }, [data]);

  async function save(setting: any, value: unknown) {
    setSaving(setting.key);
    try {
      await apiPut(`/api/admin/settings/${setting.key}`, {
        value,
        branch_id: branchId && setting.per_branch ? branchId : undefined,
      });
      toast.success(`${setting.label} updated`);
      void mutate();
    } catch (err) { toast.error(err); } finally { setSaving(null); }
  }

  async function clearOverride(setting: any) {
    try {
      await apiDelete(`/api/admin/settings/${setting.key}?branch_id=${branchId}`);
      toast.success(`${setting.label} now follows the chain-wide value`);
      void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <div className="stack">
      <Card>
        <div className="row">
          <Field label="Editing settings for">
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} style={{ width: 280 }}>
              <option value="">Chain-wide defaults</option>
              {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name} (branch override)</option>)}
            </select>
          </Field>
          <div style={{ flex: 1 }}>
            <Alert tone="info">
              {branchId
                ? 'Only settings marked as per-branch can be overridden here. Anything left alone follows the chain-wide value.'
                : 'These are the chain-wide defaults. A branch can override the ones marked per-branch.'}
            </Alert>
          </div>
        </div>
      </Card>

      <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}>
        {() => (
          <>
            {groups.map(([group, settings]) => (
              <Card key={group} title={group} flush>
                <div style={{ padding: '4px 0' }}>
                  {settings.map((s: any) => {
                    const disabled = Boolean(branchId) && !s.per_branch;
                    const value = s.effective_value;
                    return (
                      <div key={s.key} style={{
                        display: 'flex', gap: 16, alignItems: 'flex-start',
                        padding: '13px 16px', borderBottom: '1px solid var(--border)',
                        opacity: disabled ? 0.55 : 1,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                            {s.label}
                            {s.per_branch && <> <Badge tone="neutral">per branch</Badge></>}
                            {s.is_overridden_at_branch && <> <Badge tone="info">overridden here</Badge></>}
                          </div>
                          <div className="muted small" style={{ marginTop: 2 }}>{s.help}</div>
                          {s.updated_by_name && (
                            <div className="muted small" style={{ marginTop: 3 }}>
                              Last changed by {s.updated_by_name}, {formatDate(s.updated_at)}
                            </div>
                          )}
                        </div>

                        <div style={{ width: 230, flexShrink: 0 }}>
                          {s.type === 'boolean' && (
                            <div className="row" style={{ justifyContent: 'flex-end' }}>
                              <Switch checked={Boolean(value)} disabled={disabled || saving === s.key}
                                onChange={(v) => void save(s, v)} label={s.label} />
                            </div>
                          )}
                          {s.type === 'number' && (
                            <input type="number" defaultValue={Number(value)} disabled={disabled}
                              min={s.min} max={s.max} style={{ textAlign: 'right' }}
                              onBlur={(e) => {
                                const v = Number(e.target.value);
                                if (v !== Number(value)) void save(s, v);
                              }} />
                          )}
                          {s.type === 'select' && (
                            <select value={String(value)} disabled={disabled}
                              onChange={(e) => void save(s, e.target.value)}>
                              {(s.options ?? []).map((o: any) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          )}
                          {s.type === 'json' && (
                            s.key === 'business_profile'
                              ? <Button size="sm" onClick={() => setProfileOpen(true)} disabled={saving === s.key}>
                                  Edit profile
                                </Button>
                              : <JsonSetting setting={s} disabled={disabled} busy={saving === s.key}
                                             onSave={(v) => void save(s, v)} />
                          )}
                          {s.is_overridden_at_branch && (
                            <button className="btn ghost sm" style={{ marginTop: 6 }}
                              onClick={() => void clearOverride(s)}>
                              Follow chain value ({String(s.chain_value)})
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            ))}
          </>
        )}
      </AsyncSection>

      <BusinessProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        value={(data ?? []).find((s: any) => s.key === 'business_profile')?.effective_value}
        busy={saving === 'business_profile'}
        onSave={(v) => {
          const setting = (data ?? []).find((x: any) => x.key === 'business_profile');
          if (setting) void save(setting, v);
          setProfileOpen(false);
        }}
      />
    </div>
  );
}

// ── Users & the registration queue ──────────────────────────────────────────
function UsersTab() {
  const { branches } = useAuth();
  const toast = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [approving, setApproving] = useState<any | null>(null);
  const [approveRole, setApproveRole] = useState('CASHIER');
  const [approveBranch, setApproveBranch] = useState('');

  const { data: users, mutate } = useSWR<any[]>('/api/auth/users?limit=300', fetcher);
  const { data: pending, mutate: mutatePending } = useSWR<any[]>('/api/auth/registration-requests', fetcher);

  async function approve() {
    try {
      await apiPost(`/api/auth/registration-requests/${approving.request_id}/approve`,
        { role: approveRole, branch_id: approveRole === 'OWNER_ADMIN' ? undefined : approveBranch });
      toast.success('Account approved', `${approving.full_name} can now sign in.`);
      setApproving(null); void mutate(); void mutatePending();
    } catch (err) { toast.error(err); }
  }

  async function reject(req: any) {
    try {
      await apiPost(`/api/auth/registration-requests/${req.request_id}/reject`, { reason: 'Not approved' });
      toast.success('Request rejected'); void mutatePending();
    } catch (err) { toast.error(err); }
  }

  return (
    <div className="stack">
      {(pending ?? []).length > 0 && (
        <Card flush title="Awaiting approval"
          description="A signup never creates a working account by itself — you decide the role and branch here.">
          <DataTable rows={pending ?? []}
            columns={[
              { key: 'n', header: 'Name', render: (r: any) => (
                <div>{r.full_name}<div className="muted small">{r.phone}{r.email ? ` · ${r.email}` : ''}</div></div>
              ) },
              { key: 'r', header: 'Requested role', render: (r: any) => (
                <Badge tone="neutral">{r.requested_role.replace(/_/g, ' ').toLowerCase()}</Badge>
              ) },
              { key: 'b', header: 'Requested branch', render: (r: any) =>
                r.requested_branch_name ?? <span className="muted">none</span> },
              { key: 'd', header: 'Requested', nowrap: true, render: (r: any) => formatDate(r.created_at) },
              { key: 'a', header: '', render: (r: any) => (
                <div className="row tight">
                  <Button size="sm" variant="primary" onClick={() => {
                    setApproving(r);
                    setApproveRole(r.requested_role);
                    setApproveBranch(r.requested_branch_id ?? '');
                  }}>Approve</Button>
                  <Button size="sm" onClick={() => void reject(r)}>Reject</Button>
                </div>
              ) },
            ]} />
        </Card>
      )}

      <div className="row">
        <div className="spacer" />
        <Button variant="primary" onClick={() => setNewOpen(true)}>+ User</Button>
      </div>

      <Card flush title="Users" description="Click Edit (or a row) to change details, role, branch, password or PIN.">
        <DataTable rows={users ?? []} onRowClick={(u) => setEditing(u)} emptyText="No users."
          columns={[
            { key: 'n', header: 'Name', render: (u: any) => (
              <div>{u.full_name}<div className="muted small">{u.phone}{u.email ? ` · ${u.email}` : ''}</div></div>
            ) },
            { key: 'r', header: 'Role', render: (u: any) => (
              <Badge tone={u.role === 'OWNER_ADMIN' ? 'info' : 'neutral'}>
                {u.role.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            ) },
            { key: 'b', header: 'Branch', render: (u: any) => (u.role === 'OWNER_ADMIN'
              ? <span className="muted">all branches</span>
              : <div>{u.branch_name ?? '—'}{(u.extra_branches ?? []).length > 0 && (
                  <div className="muted small">also {(u.extra_branches as any[]).map((b) => b.name).join(', ')}</div>)}</div>) },
            { key: 'c', header: 'Sign-in', render: (u: any) => (
              <div className="row tight">
                {u.has_password && <Badge tone="neutral">password</Badge>}
                {u.has_pin && <Badge tone="neutral">PIN</Badge>}
                {!u.has_password && !u.has_pin && <Badge tone="warning">no credential</Badge>}
              </div>
            ) },
            { key: 'l', header: 'Last seen', nowrap: true, render: (u: any) =>
              u.last_login_at ? formatDate(u.last_login_at) : <span className="muted">never</span> },
            { key: 's', header: 'Status', render: (u: any) =>
              u.is_locked ? <Badge tone="critical">locked</Badge>
              : u.is_active ? <Badge tone="good">active</Badge>
              : <Badge tone="neutral">disabled</Badge> },
            { key: 'e', header: '', render: (u: any) => (
              <Button size="sm" onClick={(e) => { e.stopPropagation(); setEditing(u); }}>Edit</Button>
            ) },
          ]} />
      </Card>

      <Modal open={Boolean(approving)} onClose={() => setApproving(null)} title="Approve this account"
        footer={<><Button onClick={() => setApproving(null)}>Cancel</Button>
          <Button variant="primary" disabled={approveRole !== 'OWNER_ADMIN' && !approveBranch}
            onClick={() => void approve()}>Approve and create the account</Button></>}>
        <div className="stack">
          <KeyValue items={[
            ['Name', approving?.full_name],
            ['Phone', approving?.phone],
            ['Email', approving?.email],
          ]} />
          <Alert tone="warning">
            The role and branch you choose here are what the account actually gets — not what was requested.
          </Alert>
          <Field label="Role">
            <select value={approveRole} onChange={(e) => setApproveRole(e.target.value)}>
              <option value="CASHIER">Cashier / Sales staff</option>
              <option value="INVENTORY_STAFF">Inventory staff</option>
              <option value="BRANCH_MANAGER">Branch manager</option>
              <option value="ACCOUNTANT">Accountant</option>
              <option value="OWNER_ADMIN">Owner / Admin (chain-wide)</option>
            </select>
          </Field>
          {approveRole !== 'OWNER_ADMIN' && (
            <Field label="Branch" required hint="A branch role must be pinned to one branch.">
              <select value={approveBranch} onChange={(e) => setApproveBranch(e.target.value)}>
                <option value="">Choose…</option>
                {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </Modal>

      <UserEditor user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void mutate(); }} />
      <NewUserModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />
    </div>
  );
}

/** Extra branches a branch user may switch to (their home branch is always theirs). */
function ExtraBranches({ home, value, onChange }: { home: string; value: string[]; onChange: (ids: string[]) => void }) {
  const { branches } = useAuth();
  const others = branches.filter((b) => b.branch_id !== home);
  if (!others.length) return null;
  return (
    <Field label="Can also work at" hint="They switch branch from the top bar. Their sales, stock and till stay separate per branch.">
      <div className="row" style={{ gap: 14 }}>
        {others.map((b) => (
          <label key={b.branch_id} className="checkbox">
            <input type="checkbox" checked={value.includes(b.branch_id)}
              onChange={(e) => onChange(e.target.checked ? [...value, b.branch_id] : value.filter((x) => x !== b.branch_id))} />
            {b.name}
          </label>
        ))}
      </div>
    </Field>
  );
}

const ROLE_OPTIONS = (
  <>
    <option value="CASHIER">Cashier / sales staff</option>
    <option value="INVENTORY_STAFF">Inventory staff</option>
    <option value="BRANCH_MANAGER">Branch manager</option>
    <option value="ACCOUNTANT">Accountant</option>
    <option value="OWNER_ADMIN">Owner / admin (all branches)</option>
  </>
);

function UserEditor({ user, onClose, onSaved }: { user: any | null; onClose: () => void; onSaved: () => void }) {
  const { branches } = useAuth();
  const toast = useToast();
  const [role, setRole] = useState('');
  const [branchId, setBranchId] = useState('');
  const [extra, setExtra] = useState<string[]>([]);
  const [active, setActive] = useState(true);
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [details, setDetails] = useState({ full_name: '', phone: '', email: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user) return;
    setRole(user.role); setBranchId(user.branch_id ?? ''); setActive(Boolean(user.is_active)); setPin(''); setPassword('');
    setDetails({ full_name: user.full_name ?? '', phone: user.phone ?? '', email: user.email ?? '' });
    setExtra((user.extra_branches ?? []).map((b: any) => b.branch_id));
  }, [user]);

  async function save() {
    if (role !== 'OWNER_ADMIN' && !branchId) { toast.error(new Error('Choose the branch this person works at.')); return; }
    if (pin && !/^\d{4,6}$/.test(pin)) { toast.error(new Error('A PIN is 4 to 6 digits.')); return; }
    if (!details.full_name.trim() || details.phone.replace(/\D/g, '').length < 10) { toast.error(new Error('Enter the name and a 10-digit phone number.')); return; }
    if (password && password.length < 8) { toast.error(new Error('A password needs at least 8 characters.')); return; }
    setBusy(true);
    try {
      await apiPut(`/api/auth/users/${user.user_id}`, {
        full_name: details.full_name.trim(), phone: details.phone.trim(), email: details.email.trim(),
        password: password || undefined,
        role, branch_id: role === 'OWNER_ADMIN' ? null : branchId, is_active: active, unlock: user.is_locked || undefined,
        extra_branch_ids: role === 'OWNER_ADMIN' ? [] : extra.filter((id) => id !== branchId),
      });
      if (pin) await apiPost('/api/auth/set-pin', { user_id: user.user_id, pin });
      toast.success('User updated', 'If their access changed, they are signed out and sign in again with the new access.');
      onSaved();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal guardUnsaved open={Boolean(user)} onClose={onClose} title={user?.full_name ?? ''}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}>
      {user && (
        <div className="stack">
          {user.is_locked && <Alert tone="critical" title="This account is locked">Too many failed sign-in attempts. Saving unlocks it.</Alert>}
          <div className="form-grid">
            <Field label="Full name" required><input value={details.full_name} onChange={(e) => setDetails({ ...details, full_name: e.target.value })} /></Field>
            <Field label="Phone" required><input type="tel" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></Field>
            <div className="span-2"><Field label="Email" hint="Used to sign in with a password or Google"><input type="email" value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} /></Field></div>
          </div>
          <KeyValue items={[['Last seen', user.last_login_at ? formatDateTime(user.last_login_at) : 'never']]} />
          <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}>{ROLE_OPTIONS}</select></Field>
          {role !== 'OWNER_ADMIN' && (
            <>
              <Field label="Home branch" required hint="Where they normally work; their data is confined to their branches.">
                <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setExtra((x) => x.filter((id) => id !== e.target.value)); }}>
                  <option value="">Choose…</option>
                  {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
                </select>
              </Field>
              {branchId && <ExtraBranches home={branchId} value={extra} onChange={setExtra} />}
            </>
          )}
          <Switch checked={active} onChange={setActive} label="Account is active" />
          <Field label="Set a new password" hint="Leave blank to keep the current one. At least 8 characters.">
            <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <UserSecurity userId={user.user_id} />
          <Field label="Reset their PIN" hint="Leave blank to keep the current one. 4 to 6 digits.">
            <input type="password" inputMode="numeric" maxLength={6} value={pin} autoComplete="new-password"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** Sign-in security for one user, as the Owner sees it. */
function UserSecurity({ userId }: { userId: string }) {
  const toast = useToast();
  const { data, mutate } = useSWR<any>(`/api/auth/users/${userId}/security`, fetcher);
  async function resetTwoStep() {
    if (!window.confirm('Turn off two-step sign-in for this person? Use this when they have lost their phone and their recovery codes. They will be signed out everywhere.')) return;
    try { await apiPost(`/api/auth/users/${userId}/two-step/reset`, {}); toast.success('Two-step turned off', 'They can sign in with their password and set it up again.'); void mutate(); }
    catch (err) { toast.error(err); }
  }
  async function signOutEverywhere() {
    if (!window.confirm('Sign this person out on every device?')) return;
    try { await apiPost(`/api/auth/users/${userId}/sessions/revoke`, {}); toast.success('Signed out everywhere'); void mutate(); }
    catch (err) { toast.error(err); }
  }
  if (!data) return null;
  return (
    <div className="stack" style={{ gap: 6, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div className="row tight" style={{ alignItems: 'center' }}>
        <b style={{ flex: 1 }}>Sign-in</b>
        {data.two_step ? <Badge tone="good">two-step on</Badge> : <Badge tone="neutral">two-step off</Badge>}
        <Badge tone="neutral">{data.active_sessions} signed-in device(s)</Badge>
      </div>
      <div className="row tight">
        {data.two_step && <Button size="sm" onClick={() => void resetTwoStep()}>Turn off two-step (lost phone)</Button>}
        {data.active_sessions > 0 && <Button size="sm" onClick={() => void signOutEverywhere()}>Sign out everywhere</Button>}
      </div>
      {(data.history ?? []).slice(0, 5).map((h: any, i: number) => (
        <div key={i} className="row tight small">
          <span style={{ flex: 1 }}>{formatDateTime(h.attempted_at)} <span className="muted">· {h.ip ?? 'unknown IP'}</span></span>
          {h.succeeded ? <Badge tone="good">signed in</Badge> : <Badge tone="critical">failed</Badge>}
        </div>
      ))}
    </div>
  );
}

function NewUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { branches } = useAuth();
  const toast = useToast();
  const empty = { full_name: '', phone: '', email: '', role: 'CASHIER', branch_id: '', password: '', pin: '' };
  const [form, setForm] = useState({ ...empty });
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setForm({ ...empty }); setExtra([]); } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!form.full_name.trim() || form.phone.replace(/\D/g, '').length < 10) { toast.error(new Error('Enter the name and a 10-digit phone number.')); return; }
    if (form.role !== 'OWNER_ADMIN' && !form.branch_id) { toast.error(new Error('Choose the branch this person works at.')); return; }
    if (!form.password && !form.pin) { toast.error(new Error('Give them a password or a PIN to sign in with.')); return; }
    if (form.password && form.password.length < 8) { toast.error(new Error('A password needs at least 8 characters.')); return; }
    if (form.pin && !/^\d{4,6}$/.test(form.pin)) { toast.error(new Error('A PIN is 4 to 6 digits.')); return; }
    setBusy(true);
    try {
      await apiPost('/api/auth/users', {
        full_name: form.full_name.trim(), phone: form.phone.trim(), email: form.email.trim() || undefined, role: form.role,
        password: form.password || undefined, pin: form.pin || undefined,
        branch_id: form.role === 'OWNER_ADMIN' ? undefined : form.branch_id,
        extra_branch_ids: form.role === 'OWNER_ADMIN' ? undefined : extra,
      });
      toast.success('User created', form.full_name);
      onCreated();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal guardUnsaved open={open} onClose={onClose} title="Create a user"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Create</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="form-grid">
          <Field label="Full name" required><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoFocus /></Field>
          <Field label="Phone" required><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{ROLE_OPTIONS}</select></Field>
          {form.role !== 'OWNER_ADMIN' && (
            <Field label="Home branch" required>
              <select value={form.branch_id} onChange={(e) => { setForm({ ...form, branch_id: e.target.value }); setExtra((x) => x.filter((id) => id !== e.target.value)); }}>
                <option value="">Choose…</option>
                {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <div className="span-2"><Field label="Email" hint="Needed for Google sign-in and email password resets"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field></div>
          <Field label="Password" hint="At least 8 characters — for managers and above">
            <input type="password" value={form.password} autoComplete="new-password" onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Quick PIN" hint="4 to 6 digits — for counter staff">
            <input type="password" inputMode="numeric" maxLength={6} value={form.pin} autoComplete="new-password" onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
        {form.role !== 'OWNER_ADMIN' && form.branch_id && <ExtraBranches home={form.branch_id} value={extra} onChange={setExtra} />}
      </form>
    </Modal>
  );
}

// ── Branches ────────────────────────────────────────────────────────────────
const EMPTY_BRANCH = { code: '', name: '', state_code: '', gstin: '', phone: '', email: '', address: '' };

function BranchesTab() {
  const toast = useToast();
  const [editing, setEditing] = useState<any | null | 'new'>(null);
  const [form, setForm] = useState({ ...EMPTY_BRANCH });
  const [busy, setBusy] = useState(false);
  const { data, mutate } = useSWR<any[]>('/api/admin/branches', fetcher);
  const isNew = editing === 'new';
  useEffect(() => {
    if (editing === 'new') setForm({ ...EMPTY_BRANCH });
    else if (editing) setForm({ code: editing.code ?? '', name: editing.name ?? '', state_code: editing.state_code ?? '', gstin: editing.gstin ?? '',
                                 phone: editing.phone ?? '', email: editing.email ?? '', address: editing.address ?? '' });
  }, [editing]);

  async function save() {
    if (isNew && !/^[A-Z0-9]{2,6}$/.test(form.code)) { toast.error(new Error('The branch code is 2–6 capital letters or digits, e.g. AND.')); return; }
    if (!form.name.trim()) { toast.error(new Error('Enter the branch name.')); return; }
    if (!form.state_code) { toast.error(new Error('Choose the state — it decides CGST + SGST or IGST.')); return; }
    const g = form.gstin.trim().toUpperCase();
    if (g && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) { toast.error(new Error('That is not a valid GSTIN.')); return; }
    if (g && g.slice(0, 2) !== form.state_code) { toast.error(new Error(`The GSTIN is registered in ${stateName(g.slice(0, 2))}, not ${stateName(form.state_code)}.`)); return; }
    setBusy(true);
    const body = { name: form.name.trim(), state_code: form.state_code, gstin: g || null, phone: form.phone.trim() || null,
                   email: form.email.trim() || null, address: form.address.trim() || null };
    try {
      if (isNew) await apiPost('/api/admin/branches', { ...body, code: form.code });
      else await apiPut(`/api/admin/branches/${editing.branch_id}`, body);
      toast.success(isNew ? 'Branch created' : 'Branch updated'); setEditing(null); void mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function toggle(b: any) {
    if (b.is_active && !window.confirm(`Close ${b.name}? It disappears from branch choices. Its history stays.`)) return;
    try { await apiPut(`/api/admin/branches/${b.branch_id}`, { is_active: !b.is_active }); toast.success(b.is_active ? 'Branch closed' : 'Branch re-opened'); void mutate(); }
    catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="table-toolbar"><div className="spacer" /><Button variant="primary" onClick={() => setEditing('new')}>+ Branch</Button></div>
      <Card flush>
        <DataTable rows={data ?? []} emptyText="No branches." rowKey={(b: any) => b.branch_id} onRowClick={(b: any) => setEditing(b)}
          columns={[
            { key: 'c', header: 'Code', render: (b: any) => <span className="mono">{b.code}</span> },
            { key: 'n', header: 'Branch', render: (b: any) => <div>{b.name}{!b.is_active && <> <Badge tone="neutral">closed</Badge></>}<div className="muted small">{b.address}</div></div> },
            { key: 's', header: 'State', render: (b: any) => `${b.state_code} ${stateName(b.state_code)}` },
            { key: 'g', header: 'GSTIN', render: (b: any) => <span className="mono small">{b.gstin ?? '—'}</span> },
            { key: 'p', header: 'Phone', render: (b: any) => b.phone ?? '—' },
            { key: 'st', header: 'Staff', align: 'right', render: (b: any) => num(b.staff_count, 0) },
            { key: 'a', header: '', render: (b: any) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void toggle(b); }}>{b.is_active ? 'Close' : 'Re-open'}</Button> },
          ]} />
      </Card>
      <Modal guardUnsaved open={editing !== null} onClose={() => setEditing(null)} title={isNew ? 'Add a branch' : `Edit ${(editing as any)?.name ?? ''}`}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Create' : 'Save'}</Button></>}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="form-grid">
            <Field label="Branch code" required hint={isNew ? 'Printed in every document number, e.g. INV-AND/…. Cannot change later.' : 'Fixed — it is part of every document number'}>
              <input className="mono" value={form.code} disabled={!isNew} maxLength={6} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></Field>
            <Field label="Name" required><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} /></Field>
            <Field label="State" required hint="Decides CGST + SGST or IGST"><StateSelect value={form.state_code} onChange={(v) => setForm({ ...form, state_code: v })} /></Field>
            <Field label="GSTIN"><input className="mono" value={form.gstin} maxLength={15} onChange={(e) => { const v = e.target.value.toUpperCase(); setForm({ ...form, gstin: v, state_code: form.state_code || (/^\d{2}/.test(v) ? v.slice(0, 2) : '') }); }} /></Field>
            <Field label="Phone"><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <div className="span-2"><Field label="Address (printed on bills)"><textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} maxLength={500} /></Field></div>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── Audit trail ─────────────────────────────────────────────────────────────
function AuditTab() {
  const { branches } = useAuth();
  const [action, setAction] = useState('');
  const [branch, setBranch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(200);
  const params = new URLSearchParams({ limit: String(limit) });
  if (action) params.set('action', action);
  if (branch) params.set('branch_id', branch);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const { data } = useSWR<any[]>(`/api/admin/audit-log?${params}`, fetcher, { keepPreviousData: true });
  const { data: actions } = useSWR<any[]>('/api/admin/audit-log/actions', fetcher);
  return (
    <>
      <div className="table-toolbar">
        <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 260 }}>
          <option value="">All actions</option>
          {(actions ?? []).map((a: any) => <option key={a.action} value={a.action}>{a.action.replace(/_/g, ' ').toLowerCase()} ({a.count})</option>)}
        </select>
        <select aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="">All branches</option>
          {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
        </select>
        <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        <div className="spacer" />
        <ExportButton path={`/api/admin/audit-log?${params}`} filename="audit-log.csv" map={(a: any) => ({ when: a.created_at, who: a.user_name, role: a.user_role, action: a.action, on: a.entity_type,
          entity_id: a.entity_id, branch: a.branch_name, before: JSON.stringify(a.old_value ?? null), after: JSON.stringify(a.new_value ?? null) })} />
      </div>
      <Card flush title="Every sensitive action, with who and when"
        description="Sign-ins, price and stock changes, discounts and overrides, payments, refunds, voids, user and settings changes.">
        <DataTable rows={data ?? []} emptyText="No audit entries match." rowKey={(a: any) => a.audit_id ?? `${a.created_at}:${a.action}:${a.entity_id}`}
          footer={data && data.length >= limit ? <Button size="sm" onClick={() => setLimit((l) => l + 200)}>Load more</Button> : undefined}
          columns={[
            { key: 'w', header: 'When', nowrap: true, render: (a: any) => formatDateTime(a.created_at) },
            { key: 'u', header: 'Who', render: (a: any) => <div>{a.user_name ?? <span className="muted">system</span>}{a.user_role && <div className="muted small">{a.user_role.replace(/_/g, ' ').toLowerCase()}</div>}</div> },
            { key: 'a', header: 'Action', render: (a: any) => <Badge tone={/OVERRIDE|VOID|REJECT|WRITE_OFF|ACCESS/.test(a.action) ? 'warning' : 'neutral'}>{a.action.replace(/_/g, ' ').toLowerCase()}</Badge> },
            { key: 'e', header: 'On', render: (a: any) => <span className="mono small">{a.entity_type}</span> },
            { key: 'b', header: 'Branch', render: (a: any) => a.branch_name ?? <span className="muted">chain</span> },
            { key: 'd', header: 'Detail', render: (a: any) => (
              <details>
                <summary className="muted small" style={{ cursor: 'pointer' }}>view</summary>
                <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxWidth: 360 }}>
                  {JSON.stringify({ before: a.old_value ?? undefined, after: a.new_value ?? undefined }, null, 1)}
                </pre>
              </details>) },
          ]} />
      </Card>
    </>
  );
}

// ── Compliance: backups, guides, warranties ─────────────────────────────────
function ComplianceTab() {
  const { data: backups, error } = useSWR<any>('/api/admin/backups', fetcher);
  const { data: journals } = useSWR<any[]>('/api/admin/training-journals', fetcher);
  const { data: warranties } = useSWR<any[]>('/api/admin/warranties', fetcher);
  const status = backups?.status as 'NOT_CONFIGURED' | 'OK' | 'OVERDUE' | undefined;
  return (
    <div className="stack">
      {error && <Alert tone="critical">{(error as Error).message}</Alert>}
      {status === 'NOT_CONFIGURED' && (
        <Alert tone="critical" title="Backups are not configured">
          No verified backup has been recorded for this database. {backups?.how_to}
        </Alert>
      )}
      {status === 'OVERDUE' && (
        <Alert tone="warning" title="The last backup is overdue">
          The most recent verified backup is {num(backups?.last_backup_age_hours, 1)} hours old; one is expected every {backups?.expected_every_hours} hours. {backups?.how_to}
        </Alert>
      )}
      {status && status !== 'NOT_CONFIGURED' && backups?.restore_test_overdue && (
        <Alert tone="warning" title="No restore test in the last 90 days">An untested backup is a guess. Run the restore test and it is recorded here.</Alert>
      )}
      <div className="grid cols-3">
        <StatTile label="Backup status" value={status === 'OK' ? 'Up to date' : status === 'OVERDUE' ? 'Overdue' : status === 'NOT_CONFIGURED' ? 'Not configured' : '—'}
          hint={backups?.last_backup_at ? `Last verified ${formatDateTime(backups.last_backup_at)}` : 'No verified backup yet'} />
        <StatTile label="Last restore test" value={backups?.last_restore_test_at ? formatDate(backups.last_restore_test_at) : 'never'} />
        <StatTile label="Backups recorded" value={num(backups?.backups?.length ?? 0, 0)} hint="Written only by the backup script after it verifies a dump" />
      </div>
      <Card flush title="Backup history">
        <DataTable rows={(backups?.backups ?? []).slice(0, 30)} emptyText="No backups recorded." rowKey={(b: any) => b.backup_id}
          columns={[
            { key: 'd', header: 'Taken', nowrap: true, render: (b: any) => formatDateTime(b.taken_at) },
            { key: 's', header: 'Status', render: (b: any) => <StatusBadge status={b.status} /> },
            { key: 'z', header: 'Size', align: 'right', render: (b: any) => (b.size_bytes ? `${num(Number(b.size_bytes) / 1048576, 1)} MB` : '—') },
            { key: 't', header: 'Tables', align: 'right', render: (b: any) => (b.table_count ?? '—') },
            { key: 'c', header: 'Checksum', render: (b: any) => <span className="mono small">{b.checksum_sha256 ? `${String(b.checksum_sha256).slice(0, 12)}…` : '—'}</span> },
            { key: 'r', header: 'Restore tested', render: (b: any) => (b.restore_tested_at ? <Badge tone="good">{formatDate(b.restore_tested_at)}</Badge> : <span className="muted">no</span>) },
          ]} />
      </Card>
      <div className="grid cols-2">
        <Card flush title="Guides" description="How to use the system — one for owners and managers, one for counter staff.">
          <DataTable rows={journals ?? []} emptyText="No guides published in your language." rowKey={(j: any) => j.journal_id ?? `${j.journal_type}:${j.language}:${j.version}`}
            columns={[
              { key: 't', header: 'Guide', render: (j: any) => (j.journal_type === 'ADMIN' ? 'Owner & manager guide' : 'Counter staff guide') },
              { key: 'l', header: 'Language', render: (j: any) => (j.language === 'hi' ? 'हिन्दी' : 'English') },
              { key: 'v', header: 'Version', align: 'right', render: (j: any) => `v${j.version}` },
              { key: 'u', header: '', render: (j: any) => (/^(\/(?!\/)|https:\/\/)/i.test(j.content_url ?? '')
                ? <a href={j.content_url} target="_blank" rel="noopener noreferrer">Open</a> : <span className="muted">invalid link</span>) },
            ]} />
        </Card>
        <Card flush title="Warranty terms">
          <DataTable rows={warranties ?? []} emptyText="No warranty terms set." rowKey={(w: any) => w.warranty_id ?? `${w.product_name}:${w.category_name}`}
            columns={[
              { key: 'w', header: 'Applies to', render: (w: any) => w.product_name ?? w.category_name ?? '—' },
              { key: 's', header: 'Scope', render: (w: any) => <Badge tone="neutral">{w.product_name ? 'product' : 'category'}</Badge> },
              { key: 'd', header: 'Duration', align: 'right', render: (w: any) => `${w.duration_months} months` },
            ]} />
        </Card>
      </div>
    </div>
  );
}
