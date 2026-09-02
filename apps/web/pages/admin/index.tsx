// Section 17 — Admin Control Panel.
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiDelete, apiPost, apiPut, downloadCsv, fetcher, formatDate, formatDateTime, inr, num } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field,
  KeyValue, Modal, PageHeader, RequirePermission, SearchInput, StatTile, StatusBadge,
  Switch, Tabs, useDebounced,
} from '../../components/ui';

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
    <Modal open={open} onClose={onClose} wide title="Business profile — printed documents"
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
          <Field label="Logo" hint="A data: URI (data:image/png;base64,…) or an absolute path on the server. Leave blank to use the monogram.">
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
  const { branches, user: me } = useAuth();
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

      <Card flush title="Users">
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
            { key: 'b', header: 'Branch', render: (u: any) =>
              u.branch_name ?? <span className="muted">chain-wide</span> },
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

function UserEditor({ user, onClose, onSaved }: { user: any | null; onClose: () => void; onSaved: () => void }) {
  const { branches } = useAuth();
  const toast = useToast();
  const [role, setRole] = useState('');
  const [branchId, setBranchId] = useState('');
  const [active, setActive] = useState(true);
  const [pin, setPin] = useState('');

  const current = user ? { role: role || user.role, branchId: branchId || user.branch_id || '', active } : null;

  async function save() {
    try {
      await apiPut(`/api/auth/users/${user.user_id}`, {
        role: role || user.role,
        branch_id: (role || user.role) === 'OWNER_ADMIN' ? null : (branchId || user.branch_id),
        is_active: active,
        unlock: user.is_locked || undefined,
      });
      if (pin) await apiPost('/api/auth/set-pin', { user_id: user.user_id, pin });
      toast.success('User updated', 'Any open sessions for this user have been signed out.');
      setPin(''); onSaved();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={Boolean(user)} onClose={onClose} title={user?.full_name ?? ''}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()}>Save</Button></>}>
      {user && (
        <div className="stack">
          {user.is_locked && (
            <Alert tone="critical" title="This account is locked">
              Too many failed sign-in attempts. Saving will unlock it.
            </Alert>
          )}
          <KeyValue items={[['Phone', user.phone], ['Email', user.email]]} />
          <Field label="Role">
            <select defaultValue={user.role} onChange={(e) => setRole(e.target.value)}>
              <option value="CASHIER">Cashier / Sales staff</option>
              <option value="INVENTORY_STAFF">Inventory staff</option>
              <option value="BRANCH_MANAGER">Branch manager</option>
              <option value="ACCOUNTANT">Accountant</option>
              <option value="OWNER_ADMIN">Owner / Admin (chain-wide)</option>
            </select>
          </Field>
          {(role || user.role) !== 'OWNER_ADMIN' && (
            <Field label="Branch" hint="This is what confines them to one branch's data.">
              <select defaultValue={user.branch_id ?? ''} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Choose…</option>
                {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <label className="checkbox">
            <input type="checkbox" defaultChecked={user.is_active} onChange={(e) => setActive(e.target.checked)} />
            Account is active
          </label>
          <Field label="Reset their PIN" hint="Leave blank to keep the current one. 4 to 6 digits.">
            <input type="password" inputMode="numeric" maxLength={6} value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function NewUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { branches } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    full_name: '', phone: '', email: '', role: 'CASHIER', branch_id: '', password: '', pin: '', designation: '',
  });

  async function submit() {
    try {
      await apiPost('/api/auth/users', {
        ...form,
        email: form.email || undefined,
        password: form.password || undefined,
        pin: form.pin || undefined,
        branch_id: form.role === 'OWNER_ADMIN' ? undefined : form.branch_id,
      });
      toast.success('User created');
      setForm({ full_name: '', phone: '', email: '', role: 'CASHIER', branch_id: '', password: '', pin: '', designation: '' });
      onCreated();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Create a user"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary"
          disabled={!form.full_name || !form.phone || (form.role !== 'OWNER_ADMIN' && !form.branch_id)}
          onClick={() => void submit()}>Create</Button></>}>
      <div className="stack">
        <div className="grid cols-2">
          <Field label="Full name" required><input required value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="Phone" required><input type="tel" required value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2">
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="CASHIER">Cashier / Sales staff</option>
              <option value="INVENTORY_STAFF">Inventory staff</option>
              <option value="BRANCH_MANAGER">Branch manager</option>
              <option value="ACCOUNTANT">Accountant</option>
              <option value="OWNER_ADMIN">Owner / Admin (chain-wide)</option>
            </select>
          </Field>
          {form.role !== 'OWNER_ADMIN' && (
            <Field label="Branch" required>
              <select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                <option value="">Choose…</option>
                {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label="Email" hint="Needed for Google sign-in and password reset by email">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label="Password" hint="At least 8 characters — for managers and above">
            <input type="password" value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Quick-access PIN" hint="4 to 6 digits — for shop-floor staff">
            <input type="password" inputMode="numeric" maxLength={6} value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ── Branches ────────────────────────────────────────────────────────────────
function BranchesTab() {
  const toast = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState({ name: '', state_code: 'MH', gstin: '', phone: '', address: '' });
  const { data, mutate } = useSWR<any[]>('/api/admin/branches', fetcher);

  async function submit() {
    try {
      await apiPost('/api/admin/branches', {
        ...form, gstin: form.gstin || undefined, phone: form.phone || undefined, address: form.address || undefined,
      });
      toast.success('Branch created');
      setForm({ name: '', state_code: 'MH', gstin: '', phone: '', address: '' });
      setNewOpen(false); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        <Button variant="primary" onClick={() => setNewOpen(true)}>+ Branch</Button>
      </div>
      <Card flush>
        <DataTable rows={data ?? []} emptyText="No branches."
          columns={[
            { key: 'n', header: 'Branch', render: (b: any) => (
              <div>{b.name}<div className="muted small">{b.address}</div></div>
            ) },
            { key: 's', header: 'State', render: (b: any) => <Badge tone="neutral">{b.state_code}</Badge> },
            { key: 'g', header: 'GSTIN', render: (b: any) => <span className="mono small">{b.gstin ?? '—'}</span> },
            { key: 'p', header: 'Phone', render: (b: any) => b.phone ?? <span className="muted">—</span> },
            { key: 'st', header: 'Staff', align: 'right', render: (b: any) => num(b.staff_count, 0) },
            { key: 'sk', header: 'SKUs', align: 'right', render: (b: any) => num(b.sku_count, 0) },
            { key: 'a', header: '', render: (b: any) => b.is_active ? null : <Badge tone="neutral">closed</Badge> },
          ]} />
      </Card>
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Add a branch"
        footer={<><Button onClick={() => setNewOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!form.name || !form.state_code} onClick={() => void submit()}>Create</Button></>}>
        <div className="stack">
          <Alert tone="info">
            The state code drives whether an inter-branch transfer is treated as intrastate or interstate
            for GST — confirm the treatment with your CA before relying on it.
          </Alert>
          <Field label="Name" required><input required value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="grid cols-2">
            <Field label="State code" required hint="e.g. MH, KA, DL">
              <input required maxLength={4} value={form.state_code}
                onChange={(e) => setForm({ ...form, state_code: e.target.value.toUpperCase() })} /></Field>
            <Field label="GSTIN"><input value={form.gstin}
              onChange={(e) => setForm({ ...form, gstin: e.target.value })} /></Field>
          </div>
          <Field label="Phone"><input type="tel" value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Address"><textarea value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ── Audit trail (7.3) ───────────────────────────────────────────────────────
function AuditTab() {
  const [action, setAction] = useState('');
  const { data } = useSWR<any[]>(`/api/admin/audit-log?limit=300${action ? `&action=${action}` : ''}`, fetcher);
  const { data: actions } = useSWR<any[]>('/api/admin/audit-log/actions', fetcher);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 280 }}>
          <option value="">All actions</option>
          {(actions ?? []).map((a: any) => (
            <option key={a.action} value={a.action}>
              {a.action.replace(/_/g, ' ').toLowerCase()} ({a.count})
            </option>
          ))}
        </select>
        <div className="spacer" />
        <Button onClick={() => downloadCsv(data ?? [], 'audit-log.csv')} disabled={!data?.length}>Export</Button>
      </div>
      <Card flush title="Every sensitive action, with who and when"
        description="Price changes, discount overrides, stock adjustments, refunds, role changes and settings edits.">
        <DataTable rows={data ?? []} emptyText="No audit entries."
          columns={[
            { key: 'w', header: 'When', nowrap: true, render: (a: any) => formatDateTime(a.created_at) },
            { key: 'u', header: 'Who', render: (a: any) => (
              <div>{a.user_name ?? <span className="muted">system</span>}
                {a.user_role && <div className="muted small">{a.user_role.replace(/_/g, ' ').toLowerCase()}</div>}</div>
            ) },
            { key: 'a', header: 'Action', render: (a: any) => (
              <Badge tone={/OVERRIDE|VOID|REJECT|WRITE_OFF/.test(a.action) ? 'warning' : 'neutral'}>
                {a.action.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            ) },
            { key: 'e', header: 'On', render: (a: any) => <span className="mono small">{a.entity_type}</span> },
            { key: 'b', header: 'Branch', render: (a: any) => a.branch_name ?? <span className="muted">chain</span> },
            { key: 'd', header: 'Detail', render: (a: any) => (
              <details>
                <summary className="muted small" style={{ cursor: 'pointer' }}>view</summary>
                <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', maxWidth: 320 }}>
                  {JSON.stringify(a.new_value ?? a.old_value ?? {}, null, 1)}
                </pre>
              </details>
            ) },
          ]} />
      </Card>
    </>
  );
}

// ── Compliance: backups, journals, warranties ───────────────────────────────
function ComplianceTab() {
  const toast = useToast();
  const { data: backups, mutate } = useSWR<any>('/api/admin/backups', fetcher);
  const { data: journals } = useSWR<any[]>('/api/admin/training-journals', fetcher);
  const { data: warranties } = useSWR<any[]>('/api/admin/warranties', fetcher);

  return (
    <div className="stack">
      {backups?.restore_test_overdue && (
        <Alert tone="warning" title="No recent restore test">
          Backups exist, but an untested backup is a guess. Run a restore into a scratch database and
          record the test here.
        </Alert>
      )}

      <div className="grid cols-3">
        <StatTile label="Last backup" value={backups?.last_backup_at ? formatDate(backups.last_backup_at) : '—'} />
        <StatTile label="Last restore test"
          value={backups?.last_restore_test_at ? formatDate(backups.last_restore_test_at) : 'never'}
          hint={backups?.restore_test_overdue ? 'Overdue' : 'Within 90 days'} />
        <StatTile label="Backups on file" value={num(backups?.backups?.length ?? 0, 0)} />
      </div>

      <Card flush title="Backup history">
        <DataTable rows={(backups?.backups ?? []).slice(0, 20)} emptyText="No backups recorded."
          columns={[
            { key: 'd', header: 'Taken', nowrap: true, render: (b: any) => formatDateTime(b.taken_at) },
            { key: 's', header: 'Status', render: (b: any) => <StatusBadge status={b.status} /> },
            { key: 'r', header: 'Storage', render: (b: any) => <span className="mono small">{b.storage_ref}</span> },
            { key: 't', header: 'Restore tested', render: (b: any) => b.restore_tested_at
              ? <Badge tone="good">{formatDate(b.restore_tested_at)}</Badge>
              : <Button size="sm" onClick={async () => {
                  try {
                    await apiPost(`/api/admin/backups/${b.backup_id}/restore-test`, {});
                    toast.success('Restore test recorded'); void mutate();
                  } catch (err) { toast.error(err); }
                }}>Record a test</Button> },
          ]} />
      </Card>

      <div className="grid cols-2">
        <Card flush title="Training journals"
          description="Versioned so they stay in step with the features they describe — one for the owner, one for staff, each in English and Hindi.">
          <DataTable rows={journals ?? []} emptyText="No journals published."
            columns={[
              { key: 't', header: 'Journal', render: (j: any) => (
                <Badge tone={j.journal_type === 'ADMIN' ? 'info' : 'neutral'}>{j.journal_type.toLowerCase()}</Badge>
              ) },
              { key: 'l', header: 'Language', render: (j: any) => j.language === 'hi' ? 'हिन्दी' : 'English' },
              { key: 'v', header: 'Version', align: 'right', render: (j: any) => `v${j.version}` },
              { key: 'u', header: '', render: (j: any) => <a href={j.content_url}>Open</a> },
            ]} />
        </Card>
        <Card flush title="Warranty terms">
          <DataTable rows={warranties ?? []} emptyText="No warranty terms set."
            columns={[
              { key: 'w', header: 'Applies to', render: (w: any) =>
                w.product_name ?? w.category_name ?? <span className="muted">—</span> },
              { key: 's', header: 'Scope', render: (w: any) =>
                <Badge tone="neutral">{w.product_name ? 'product' : 'category'}</Badge> },
              { key: 'd', header: 'Duration', align: 'right', render: (w: any) => `${w.duration_months} months` },
            ]} />
        </Card>
      </div>
    </div>
  );
}
