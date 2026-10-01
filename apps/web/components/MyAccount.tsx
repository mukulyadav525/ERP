// "My account": change your own password or PIN. Owners reset other people's
// credentials from Admin → Users; this is for yourself.
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { apiPost, businessToday, fetcher, formatDate, formatDateTime } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { Badge, Button, Field, KeyValue, Modal } from './ui';

export default function MyAccount({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, roleLabel, can } = useAuth();
  const { data: me, mutate: mutateMe } = useSWR<any>(open && can('mark_attendance') ? '/api/hr/me' : null, fetcher);
  const [leave, setLeave] = useState({ from_date: '', to_date: '' });
  const toast = useToast();
  const [pw, setPw] = useState({ current: '', next: '', again: '' });
  const [pin, setPin] = useState({ next: '', again: '' });
  const [busy, setBusy] = useState<'' | 'pw' | 'pin'>('');
  useEffect(() => { if (!open) { setPw({ current: '', next: '', again: '' }); setPin({ next: '', again: '' }); } }, [open]);

  async function changePassword() {
    if (pw.next.length < 8) { toast.error(new Error('Choose a new password of at least 8 characters.')); return; }
    if (pw.next !== pw.again) { toast.error(new Error('The two new passwords do not match.')); return; }
    setBusy('pw');
    try {
      await apiPost('/api/auth/change-password', { current_password: pw.current, new_password: pw.next });
      toast.success('Password changed', 'Use the new password next time you sign in.');
      setPw({ current: '', next: '', again: '' });
    } catch (err) { toast.error(err); } finally { setBusy(''); }
  }

  async function changePin() {
    if (!/^\d{4,6}$/.test(pin.next)) { toast.error(new Error('A PIN is 4 to 6 digits.')); return; }
    if (pin.next !== pin.again) { toast.error(new Error('The two PINs do not match.')); return; }
    setBusy('pin');
    try {
      await apiPost('/api/auth/set-pin', { pin: pin.next });
      toast.success('PIN changed', 'Use it to sign in with your phone, and to approve overrides.');
      setPin({ next: '', again: '' });
    } catch (err) { toast.error(err); } finally { setBusy(''); }
  }

  async function attendance(action: 'check-in' | 'check-out') {
    try { await apiPost(`/api/hr/attendance/${action}`, {}); toast.success(action === 'check-in' ? 'Checked in' : 'Checked out'); void mutateMe(); }
    catch (err) { toast.error(err); }
  }
  async function requestLeave() {
    if (!leave.from_date || !leave.to_date) { toast.error(new Error('Choose the first and last day of leave.')); return; }
    try { await apiPost('/api/hr/leave-requests', leave); toast.success('Leave requested', 'Your manager will approve or reject it.'); setLeave({ from_date: '', to_date: '' }); void mutateMe(); }
    catch (err) { toast.error(err); }
  }

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

  return (
    <Modal open={open} onClose={onClose} title="My account" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        <KeyValue items={[['Name', user?.full_name], ['Role', roleLabel], ['Phone', user?.phone || '—'], ['Email', user?.email || '—']]} />
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void changePassword(); }}>
          <b>Change password</b>
          <Field label="Current password" required>
            <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <div className="grid cols-2">
            <Field label="New password" hint="At least 8 characters">
              <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
            <Field label="New password again">
              <input type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} />
            </Field>
          </div>
          <div><Button type="submit" variant="primary" busy={busy === 'pw'} disabled={!pw.current || !pw.next}>Change password</Button></div>
        </form>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void changePin(); }}>
          <b>Change PIN</b>
          <div className="grid cols-2">
            <Field label="New PIN" hint="4 to 6 digits">
              <input type="password" inputMode="numeric" autoComplete="new-password" value={pin.next} onChange={(e) => setPin({ ...pin, next: digits(e.target.value) })} />
            </Field>
            <Field label="New PIN again">
              <input type="password" inputMode="numeric" autoComplete="new-password" value={pin.again} onChange={(e) => setPin({ ...pin, again: digits(e.target.value) })} />
            </Field>
          </div>
          <div><Button type="submit" busy={busy === 'pin'} disabled={!pin.next}>Change PIN</Button></div>
        </form>
        {me?.employee_id && (
          <div className="stack">
            <b>Today&apos;s attendance</b>
            <div className="row tight">
              <span className="muted small" style={{ flex: 1 }}>
                {me.today?.check_in ? `In at ${formatDateTime(me.today.check_in)}` : 'Not checked in yet'}
                {me.today?.check_out ? ` · out at ${formatDateTime(me.today.check_out)}` : ''}
              </span>
              <Button size="sm" disabled={Boolean(me.today?.check_in)} onClick={() => void attendance('check-in')}>Check in</Button>
              <Button size="sm" disabled={!me.today?.check_in || Boolean(me.today?.check_out)} onClick={() => void attendance('check-out')}>Check out</Button>
            </div>
            <b>Request leave</b>
            <div className="grid cols-3">
              <Field label="From"><input type="date" min={businessToday()} value={leave.from_date} onChange={(e) => setLeave({ ...leave, from_date: e.target.value, to_date: leave.to_date || e.target.value })} /></Field>
              <Field label="To"><input type="date" min={leave.from_date || businessToday()} value={leave.to_date} onChange={(e) => setLeave({ ...leave, to_date: e.target.value })} /></Field>
              <div style={{ alignSelf: 'end' }}><Button onClick={() => void requestLeave()}>Request</Button></div>
            </div>
            {(me.leave ?? []).map((l: any) => (
              <div key={l.id} className="row tight small">
                <span style={{ flex: 1 }}>{formatDate(l.from_date)} – {formatDate(l.to_date)}</span>
                <Badge tone={l.status === 'APPROVED' ? 'good' : l.status === 'REJECTED' ? 'critical' : 'neutral'}>{String(l.status).toLowerCase()}</Badge>
              </div>
            ))}
          </div>
        )}
        <span className="muted small">Forgot your password? Ask the Owner to set a new one in Admin → Users.</span>
      </div>
    </Modal>
  );
}
