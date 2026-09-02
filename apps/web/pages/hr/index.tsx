// Section 10 — HR / Staff.
import { useState } from 'react';
import useSWR from 'swr';
import { apiPost, downloadCsv, fetcher, formatDate, formatDateTime, inr, num, withBranch } from '../../lib/api';
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

function StaffTab() {
  const { can, activeBranchId } = useAuth();
  const toast = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<any[]>(
    withBranch('/api/hr/employees', activeBranchId), fetcher);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="spacer" />
        {can('manage_staff') && <Button variant="primary" onClick={() => setNewOpen(true)}>+ Staff member</Button>}
      </div>
      <Card flush>
        <AsyncSection data={data} error={error} isLoading={isLoading} onRetry={() => void mutate()}
          empty={<EmptyState icon="👤" title="No staff yet" />}>
          {(rows) => (
            <DataTable rows={rows} footer={`${rows.length} staff member(s)`}
              columns={[
                { key: 'n', header: 'Name', render: (e: any) => (
                  <div>{e.full_name}<div className="muted small">{e.designation}</div></div>
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
              ]} />
          )}
        </AsyncSection>
      </Card>
      <NewStaffModal open={newOpen} onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); void mutate(); }} />
    </>
  );
}

function NewStaffModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
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
              <option value="BRANCH_MANAGER">Branch manager</option>
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
  const { data: roster } = useSWR<any[]>(withBranch('/api/hr/roster', activeBranchId), fetcher);

  return (
    <div className="grid cols-2">
      <Card flush title="Shift definitions">
        <DataTable rows={shifts ?? []} emptyText="No shifts defined."
          columns={[
            { key: 'n', header: 'Shift', render: (s: any) => s.name },
            { key: 'b', header: 'Branch', render: (s: any) => s.branch_name },
            { key: 't', header: 'Hours', render: (s: any) => `${s.start_time} – ${s.end_time}` },
          ]} />
      </Card>
      <Card flush title="Roster" description="Next 14 days">
        <DataTable rows={roster ?? []} emptyText="Nothing rostered."
          columns={[
            { key: 'd', header: 'Date', nowrap: true, render: (r: any) => formatDate(r.work_date) },
            { key: 'n', header: 'Name', render: (r: any) => r.full_name },
            { key: 's', header: 'Shift', render: (r: any) => `${r.shift_name} (${r.start_time}–${r.end_time})` },
          ]} />
      </Card>
    </div>
  );
}
