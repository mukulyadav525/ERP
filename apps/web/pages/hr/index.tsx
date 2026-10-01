// Section 10 — HR / Staff.
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { apiDelete, apiPost, apiPut, businessToday, downloadCsv, fetcher, formatDate, formatDateTime, inr, num, withBranch } from '../../lib/api';
import { useAuth } from '../../lib/AuthContext';
import { useI18n } from '../../lib/i18n';
import { useToast } from '../../lib/ToastContext';
import {
  Alert, AsyncSection, Badge, Button, Card, DataTable, EmptyState, Field, Modal,
  PageHeader, RequirePermission, StatTile, StatusBadge, Tabs,
} from '../../components/ui';
import { BarsChart } from '../../components/charts';

export default function HrPage() {
  return (
    <RequirePermission permission="view_hr">
      <HrScreen />
    </RequirePermission>
  );
}

function HrScreen() {
  const { can, activeBranchId } = useAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<'staff' | 'attendance' | 'leave' | 'performance' | 'shifts'>('staff');
  const { data: leave } = useSWR<any[]>(withBranch('/api/hr/leave-requests?status=PENDING', activeBranchId), fetcher);

  return (
    <>
      <PageHeader title={t('navHR')} subtitle="Staff, attendance, leave and sales performance" />
      <Tabs active={tab} onChange={(k) => setTab(k as any)}
        tabs={[
          { key: 'staff', label: 'Staff' },
          { key: 'attendance', label: 'Attendance' },
          { key: 'leave', label: 'Leave', count: leave?.length },
          { key: 'performance', label: 'Performance' },
          { key: 'shifts', label: 'Shifts' },
        ]} />
      {tab === 'staff' && <StaffTab />}
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'leave' && <LeaveTab />}
      {tab === 'performance' && <PerformanceTab />}
      {tab === 'shifts' && <ShiftsTab />}
    </>
  );
}

/** Designations default to the role code (BRANCH_MANAGER); show those as words. */
const designation = (d?: string | null) => (d && /^[A-Z_]+$/.test(d)
  ? d.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : d ?? '');

function StaffTab() {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const { user } = useAuth();
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch('/api/hr/employees', activeBranchId), fetcher);
  // The Owner edits anyone; a manager edits their counter, inventory and accounts staff.
  const mayEdit = (e: any) => can('manage_staff')
    && (user?.role === 'OWNER_ADMIN' || ['CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'].includes(e.role));

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        {can('manage_staff') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ Staff member</Button>}
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="staff" title="No staff yet" />}>
          {(rows) => (
            <DataTable rows={rows} footer={`${rows.length} staff member(s)`}
              onRowClick={(e: any) => { if (mayEdit(e)) setEditing(e); }}
              columns={[
                { key: 'n', header: 'Name', render: (e: any) => (
                  <div>{e.full_name}<div className="muted small">{designation(e.designation)}</div></div>
                ) },
                { key: 'r', header: 'Role', render: (e: any) => <Badge tone="neutral">{e.role.replace(/_/g, ' ').toLowerCase()}</Badge> },
                { key: 'b', header: 'Branch', render: (e: any) => e.branch_name },
                { key: 'p', header: 'Phone', render: (e: any) => e.phone },
                { key: 'j', header: 'Joined', nowrap: true, render: (e: any) => formatDate(e.joined_at) },
                { key: 'a', header: 'Present (30d)', align: 'right', render: (e: any) => (
                  <Badge tone={Number(e.days_present_30d) >= 22 ? 'good' : Number(e.days_present_30d) >= 15 ? 'warning' : 'critical'}>
                    {num(e.days_present_30d, 0)} days
                  </Badge>
                ) },
                { key: 's', header: '', render: (e: any) => e.is_active ? null : <Badge tone="critical">inactive</Badge> },
                { key: 'e', header: '', align: 'right', render: (e: any) => (mayEdit(e)
                  ? <Button size="sm" onClick={(ev) => { ev.stopPropagation(); setEditing(e); }}>Edit</Button> : null) },
              ]} />
          )}
        </AsyncSection>
      </Card>
      <NewStaffModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />
      <EditStaffModal staff={editing} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void mutate(); }} />
    </>
  );
}

function NewStaffModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState({ full_name: '', phone: '', email: '', role: 'CASHIER', designation: '', pin: '' });

  async function submit() {
    try {
      await apiPost('/api/hr/employees', {
        ...form, email: form.email || undefined, pin: form.pin || undefined,
        designation: form.designation || undefined,
      });
      toast.success('Staff member added', form.pin ? 'They can sign in with their phone and PIN.' : 'Set a PIN so they can sign in.');
      setForm({ full_name: '', phone: '', email: '', role: 'CASHIER', designation: '', pin: '' });
      onCreated();
    } catch (err) { toast.error(err); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a staff member"
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!form.full_name || !form.phone} onClick={() => void submit()}>Add</Button></>}>
      <div className="stack">
        <Alert tone="info">
          This creates their login as well as their staff record — the two are the same person, and
          splitting them leaves people on the roster who cannot sign in.
        </Alert>
        <div className="grid cols-2">
          <Field label="Full name" required><input required value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="Phone" required hint="This is how shop-floor staff sign in">
            <input type="tel" required value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2">
          <Field label="Role">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="CASHIER">Cashier / Sales staff</option>
              <option value="INVENTORY_STAFF">Inventory staff</option>
              {user?.role === 'OWNER_ADMIN' && <option value="BRANCH_MANAGER">Branch manager</option>}
              <option value="ACCOUNTANT">Accountant</option>
            </select>
          </Field>
          <Field label="Designation"><input value={form.designation}
            onChange={(e) => setForm({ ...form, designation: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2">
          <Field label="Email"><input type="email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Quick-access PIN" hint="4 to 6 digits">
            <input type="password" inputMode="numeric" maxLength={6} value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function AttendanceTab() {
  const { activeBranchId } = useAuth();
  const toast = useToast();
  const { data, mutate } = useSWR<any[]>(withBranch('/api/hr/attendance?limit=300', activeBranchId), fetcher);

  async function mark(action: 'check-in' | 'check-out') {
    try {
      await apiPost(`/api/hr/attendance/${action}`, {});
      toast.success(action === 'check-in' ? 'Checked in' : 'Checked out');
      void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <Button variant="primary" onClick={() => void mark('check-in')}>Check in</Button>
        <Button onClick={() => void mark('check-out')}>Check out</Button>
        <div className="spacer" />
        <Button onClick={() => downloadCsv(data ?? [], 'attendance.csv')} disabled={!data?.length}>Export</Button>
      </div>
      <Card flush>
        <DataTable rows={data ?? []} emptyText="No attendance recorded."
          columns={[
            { key: 'd', header: 'Date', nowrap: true, render: (a: any) => formatDate(a.work_date) },
            { key: 'n', header: 'Name', render: (a: any) => a.full_name },
            { key: 'b', header: 'Branch', render: (a: any) => a.branch_name },
            { key: 'in', header: 'In', nowrap: true, render: (a: any) =>
              a.check_in ? new Date(a.check_in).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—' },
            { key: 'out', header: 'Out', nowrap: true, render: (a: any) =>
              a.check_out ? new Date(a.check_out).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—' },
            { key: 'h', header: 'Hours', align: 'right', render: (a: any) =>
              a.hours_worked ? num(a.hours_worked, 1) : <span className="muted">—</span> },
            { key: 'm', header: 'Method', render: (a: any) => <Badge tone="neutral">{a.method.replace(/_/g, ' ').toLowerCase()}</Badge> },
          ]} />
      </Card>
    </>
  );
}

function LeaveTab() {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const [requestOpen, setRequestOpen] = useState(false);
  const [form, setForm] = useState({ from_date: '', to_date: '' });
  const { data, mutate } = useSWR<any[]>(withBranch('/api/hr/leave-requests', activeBranchId), fetcher);

  async function decide(id: string, status: 'APPROVED' | 'REJECTED') {
    try {
      await apiPost(`/api/hr/leave-requests/${id}/decide`, { status });
      toast.success(`Leave ${status.toLowerCase()}`); void mutate();
    } catch (err) { toast.error(err); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        <Button variant="primary" onClick={() => setRequestOpen(true)}>Request leave</Button>
      </div>
      <Card flush>
        <DataTable rows={data ?? []} emptyText="No leave requests."
          columns={[
            { key: 'n', header: 'Name', render: (l: any) => l.full_name },
            { key: 'b', header: 'Branch', render: (l: any) => l.branch_name },
            { key: 'f', header: 'From', nowrap: true, render: (l: any) => formatDate(l.from_date) },
            { key: 't', header: 'To', nowrap: true, render: (l: any) => formatDate(l.to_date) },
            { key: 'd', header: 'Days', align: 'right', render: (l: any) => num(l.days, 0) },
            { key: 's', header: 'Status', render: (l: any) => <StatusBadge status={l.status} /> },
            { key: 'a', header: '', render: (l: any) => l.status === 'PENDING' && can('approve_leave') && (
              <div className="row tight">
                <Button size="sm" variant="primary" onClick={() => void decide(l.id, 'APPROVED')}>Approve</Button>
                <Button size="sm" onClick={() => void decide(l.id, 'REJECTED')}>Reject</Button>
              </div>
            ) },
          ]} />
      </Card>
      <Modal open={requestOpen} onClose={() => setRequestOpen(false)} title="Request leave"
        footer={<><Button onClick={() => setRequestOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!form.from_date || !form.to_date} onClick={async () => {
            try {
              await apiPost('/api/hr/leave-requests', form);
              toast.success('Leave requested'); setRequestOpen(false); void mutate();
            } catch (err) { toast.error(err); }
          }}>Submit</Button></>}>
        <div className="grid cols-2">
          <Field label="From" required><input type="date" value={form.from_date}
            onChange={(e) => setForm({ ...form, from_date: e.target.value })} /></Field>
          <Field label="To" required><input type="date" value={form.to_date}
            onChange={(e) => setForm({ ...form, to_date: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

function PerformanceTab() {
  const { activeBranchId } = useAuth();
  const [days, setDays] = useState(30);
  const { data } = useSWR<any[]>(withBranch(`/api/hr/performance?days=${days}`, activeBranchId), fetcher);
  const chartData = (data ?? []).filter((r) => Number(r.revenue) > 0).slice(0, 10)
    .map((r) => ({ name: r.full_name, revenue: Number(r.revenue) }));

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="segmented">
          {[30, 90, 180].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d} days</button>
          ))}
        </div>
      </div>
      {chartData.length > 0 && (
        <Card title="Sales by staff member" description={`Attributed sales, last ${days} days`}>
          <BarsChart data={chartData} xKey="name" series={[{ key: 'revenue', label: 'Revenue' }]} horizontal height={300} />
        </Card>
      )}
      <div style={{ marginTop: 16 }}>
        <Card flush title="Performance detail"
          description="Sales are attributed to whoever was tagged on the bill — this is what an incentive scheme runs off.">
          <DataTable rows={data ?? []} emptyText="No performance data."
            columns={[
              { key: 'n', header: 'Name', render: (r: any) => (
                <div>{r.full_name}<div className="muted small">{r.role.replace(/_/g, ' ').toLowerCase()}</div></div>
              ) },
              { key: 'b', header: 'Branch', render: (r: any) => r.branch_name },
              { key: 'inv', header: 'Bills', align: 'right', render: (r: any) => num(r.invoice_count, 0) },
              { key: 'rev', header: 'Revenue', align: 'right', render: (r: any) => inr(r.revenue) },
              { key: 'avg', header: 'Avg bill', align: 'right', render: (r: any) =>
                r.avg_ticket ? inr(r.avg_ticket) : <span className="muted">—</span> },
              { key: 'd', header: 'Days present', align: 'right', render: (r: any) => num(r.days_present, 0) },
              { key: 'pd', header: 'Revenue / day', align: 'right', render: (r: any) =>
                r.revenue_per_day ? inr(r.revenue_per_day) : <span className="muted">—</span> },
            ]} />
        </Card>
      </div>
    </>
  );
}

function ShiftsTab() {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const { data: shifts, mutate } = useSWR<any[]>(withBranch('/api/hr/shifts', activeBranchId), fetcher);
  const { data: roster, mutate: mutateRoster } = useSWR<any[]>(withBranch('/api/hr/roster', activeBranchId), fetcher);
  const { data: staff } = useSWR<any[]>(can('manage_staff') ? withBranch('/api/hr/employees', activeBranchId) : null, fetcher);
  const [shiftForm, setShiftForm] = useState<any | null>(null);
  const [assign, setAssign] = useState<{ employee_id: string; shift_id: string; work_date: string } | null>(null);
  const manage = can('manage_staff');

  async function saveShift() {
    try {
      const body = { name: shiftForm.name, start_time: shiftForm.start_time, end_time: shiftForm.end_time };
      if (shiftForm.shift_id) await apiPut(`/api/hr/shifts/${shiftForm.shift_id}`, body);
      else await apiPost('/api/hr/shifts', body);
      toast.success('Shift saved'); setShiftForm(null); void mutate(); void mutateRoster();
    } catch (err) { toast.error(err); }
  }
  async function saveAssign() {
    try { await apiPost('/api/hr/roster', assign); toast.success('Shift assigned'); setAssign(null); void mutateRoster(); }
    catch (err) { toast.error(err); }
  }
  async function unassign(r: any) {
    if (!window.confirm(`Remove ${r.full_name} from ${r.shift_name} on ${formatDate(r.work_date)}?`)) return;
    try { await apiDelete(`/api/hr/roster/${r.id}`); toast.success('Removed from the roster'); void mutateRoster(); }
    catch (err) { toast.error(err); }
  }

  return (
    <>
      {manage && (
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="spacer" />
          <Button onClick={() => setShiftForm({ name: '', start_time: '09:00', end_time: '18:00' })}>+ Shift</Button>
          <Button variant="primary" disabled={!(shifts ?? []).length}
            onClick={() => setAssign({ employee_id: '', shift_id: '', work_date: businessToday() })}>Assign a shift</Button>
        </div>
      )}
      <div className="grid cols-2">
        <Card flush title="Shift definitions">
          <DataTable rows={shifts ?? []} emptyText="No shifts defined."
            columns={[
              { key: 'n', header: 'Shift', render: (x: any) => x.name },
              { key: 'b', header: 'Branch', render: (x: any) => x.branch_name },
              { key: 't', header: 'Hours', render: (x: any) => `${String(x.start_time).slice(0, 5)} – ${String(x.end_time).slice(0, 5)}` },
              ...(manage ? [{ key: 'e', header: '', align: 'right' as const, render: (x: any) => (
                <Button size="sm" onClick={() => setShiftForm({ shift_id: x.shift_id, name: x.name,
                  start_time: String(x.start_time).slice(0, 5), end_time: String(x.end_time).slice(0, 5) })}>Edit</Button>) }] : []),
            ]} />
        </Card>
        <Card flush title="Roster" description="Next 14 days">
          <DataTable rows={roster ?? []} emptyText="Nothing rostered."
            columns={[
              { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDate(r.work_date) },
              { key: 'n', header: 'Name', render: (r: any) => r.full_name },
              { key: 's', header: 'Shift', render: (r: any) => `${r.shift_name} (${String(r.start_time).slice(0, 5)}–${String(r.end_time).slice(0, 5)})` },
              ...(manage ? [{ key: 'x', header: '', align: 'right' as const, render: (r: any) => (
                <Button size="sm" variant="ghost" onClick={() => void unassign(r)}>Remove</Button>) }] : []),
            ]} />
        </Card>
      </div>

      <Modal open={Boolean(shiftForm)} onClose={() => setShiftForm(null)} title={shiftForm?.shift_id ? 'Edit shift' : 'New shift'}
        footer={<><Button onClick={() => setShiftForm(null)}>Cancel</Button>
          <Button variant="primary" disabled={!shiftForm?.name?.trim()} onClick={() => void saveShift()}>Save</Button></>}>
        {shiftForm && (
          <div className="grid cols-3">
            <Field label="Name" required><input value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} /></Field>
            <Field label="Starts"><input type="time" value={shiftForm.start_time} onChange={(e) => setShiftForm({ ...shiftForm, start_time: e.target.value })} /></Field>
            <Field label="Ends"><input type="time" value={shiftForm.end_time} onChange={(e) => setShiftForm({ ...shiftForm, end_time: e.target.value })} /></Field>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(assign)} onClose={() => setAssign(null)} title="Assign a shift"
        footer={<><Button onClick={() => setAssign(null)}>Cancel</Button>
          <Button variant="primary" disabled={!assign?.employee_id || !assign?.shift_id || !assign?.work_date} onClick={() => void saveAssign()}>Assign</Button></>}>
        {assign && (
          <div className="grid cols-3">
            <Field label="Staff member" required>
              <select value={assign.employee_id} onChange={(e) => setAssign({ ...assign, employee_id: e.target.value })}>
                <option value="">Choose…</option>
                {(staff ?? []).filter((x: any) => x.is_active).map((x: any) => <option key={x.employee_id} value={x.employee_id}>{x.full_name}</option>)}
              </select>
            </Field>
            <Field label="Shift" required>
              <select value={assign.shift_id} onChange={(e) => setAssign({ ...assign, shift_id: e.target.value })}>
                <option value="">Choose…</option>
                {(shifts ?? []).map((x: any) => <option key={x.shift_id} value={x.shift_id}>{x.name}</option>)}
              </select>
            </Field>
            <Field label="Date" required><input type="date" value={assign.work_date} onChange={(e) => setAssign({ ...assign, work_date: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

/** Correct a staff member's details. Role and branch changes are the Owner's, in Admin → Users. */
function EditStaffModal({ staff, onClose, onSaved }: { staff: any | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ full_name: '', phone: '', email: '', designation: '', joined_at: '', is_active: true, pin: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!staff) return;
    setForm({ full_name: staff.full_name ?? '', phone: staff.phone ?? '', email: staff.email ?? '', designation: designation(staff.designation),
      joined_at: String(staff.joined_at ?? '').slice(0, 10), is_active: Boolean(staff.is_active), pin: '' });
  }, [staff]);

  async function save() {
    if (!form.full_name.trim() || form.phone.replace(/\D/g, '').length < 10) { toast.error(new Error('Enter the name and a 10-digit phone number.')); return; }
    if (form.pin && !/^\d{4,6}$/.test(form.pin)) { toast.error(new Error('A PIN is 4 to 6 digits.')); return; }
    setBusy(true);
    try {
      await apiPut(`/api/hr/employees/${staff.employee_id}`, {
        full_name: form.full_name.trim(), phone: form.phone.trim(), email: form.email.trim(),
        designation: form.designation.trim(), joined_at: form.joined_at || undefined,
        is_active: form.is_active, pin: form.pin || undefined,
      });
      toast.success('Staff member updated', form.full_name.trim());
      onSaved();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Modal open={Boolean(staff)} onClose={onClose} title={staff ? `Edit ${staff.full_name}` : ''}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button></>}>
      {staff && (
        <div className="stack">
          <div className="grid cols-2">
            <Field label="Full name" required><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
            <Field label="Phone" required><input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          </div>
          <div className="grid cols-2">
            <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Designation"><input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></Field>
          </div>
          <div className="grid cols-2">
            <Field label="Joined on"><input type="date" value={form.joined_at} onChange={(e) => setForm({ ...form, joined_at: e.target.value })} /></Field>
            <Field label="New PIN" hint="Leave blank to keep the current one">
              <input type="password" inputMode="numeric" maxLength={6} value={form.pin} autoComplete="new-password"
                onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            Can sign in (untick when someone leaves — their past bills stay)
          </label>
          <span className="muted small">Role ({String(staff.role).replace(/_/g, ' ').toLowerCase()}) and branch are changed by the Owner in Admin → Users.</span>
        </div>
      )}
    </Modal>
  );
}
