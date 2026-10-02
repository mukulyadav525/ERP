// Your own sign-in security, inside "My account":
//   • two-step sign-in with an authenticator app (+ one-time recovery codes)
//   • the devices you are signed in on, each of which you can sign out
//   • your recent sign-ins, including failed attempts
import { useState } from 'react';
import useSWR from 'swr';
import { apiPost, fetcher, formatDateTime } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { Alert, Badge, Button, Field } from './ui';

/** "Chrome on Windows", "Safari on iPhone" — enough to recognise a device. */
export function describeDevice(ua?: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
const METHOD_LABEL: Record<string, string> = {
  PASSWORD: 'password', PIN: 'PIN', GOOGLE: 'Google', EMAIL_CODE: 'email code', PHONE_OTP: 'phone code',
};

export default function AccountSecurity({ open }: { open: boolean }) {
  const { logout } = useAuth();
  const toast = useToast();
  const { data: mfa, mutate: mutateMfa } = useSWR<any>(open ? '/api/auth/two-step' : null, fetcher);
  const { data: sessions, mutate: mutateSessions } = useSWR<any[]>(open ? '/api/auth/sessions' : null, fetcher);
  const { data: history } = useSWR<any[]>(open ? '/api/auth/sign-in-history' : null, fetcher);
  const [setup, setSetup] = useState<{ key: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    try { setSetup(await apiPost('/api/auth/two-step/begin', {})); setCode(''); }
    catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function enable() {
    setBusy(true);
    try {
      const res = await apiPost<{ recovery_codes: string[] }>('/api/auth/two-step/enable', { code });
      setRecovery(res.recovery_codes); setSetup(null); setCode('');
      toast.success('Two-step sign-in is on', 'Save your recovery codes now.');
      void mutateMfa();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true);
    try {
      await apiPost('/api/auth/two-step/disable', { code });
      setTurningOff(false); setCode(''); setRecovery(null);
      toast.success('Two-step sign-in is off');
      void mutateMfa();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  async function signOut(s: any) {
    try {
      const res = await apiPost<{ signed_out_self: boolean }>(`/api/auth/sessions/${s.session_id}/revoke`, {});
      if (res.signed_out_self) { void logout(); return; }
      toast.success('Signed out', describeDevice(s.user_agent));
      void mutateSessions();
    } catch (err) { toast.error(err); }
  }
  async function signOutOthers() {
    if (!window.confirm('Sign out of every other device? This one stays signed in.')) return;
    try {
      const res = await apiPost<{ signed_out: number }>('/api/auth/sessions/revoke-others', {});
      toast.success('Other devices signed out', `${res.signed_out} session(s) ended.`);
      void mutateSessions();
    } catch (err) { toast.error(err); }
  }
  function downloadRecovery() {
    if (!recovery) return;
    const blob = new Blob([`BHAWANI ONE recovery codes\nEach works once, instead of an authenticator code.\n\n${recovery.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'bhawani-one-recovery-codes.txt';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  }

  const others = (sessions ?? []).filter((s) => !s.is_current).length;

  return (
    <div className="stack">
      {/* ── Two-step ─────────────────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 8 }}>
        <div className="row tight" style={{ alignItems: 'center' }}>
          <b style={{ flex: 1 }}>Two-step sign-in</b>
          {mfa && (mfa.enabled ? <Badge tone="good">on</Badge> : <Badge tone="neutral">off</Badge>)}
        </div>
        <span className="muted small">
          After your password (or PIN, Google, email code), also ask for a code from an authenticator
          app on your phone — Google Authenticator, Microsoft Authenticator or similar. A stolen
          password alone is then not enough to get in.
        </span>

        {recovery && (
          <Alert tone="warning" title="Your recovery codes — save them now">
            If you lose your phone, each of these signs you in once instead of an app code. They are
            shown only this once.
            <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, max-content)', gap: '4px 24px', margin: '10px 0' }}>
              {recovery.map((c) => <span key={c}>{c}</span>)}
            </div>
            <div className="row tight">
              <Button size="sm" onClick={downloadRecovery}>Download</Button>
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(recovery.join('\n')).then(() => toast.success('Copied'))}>Copy</Button>
              <Button size="sm" variant="ghost" onClick={() => setRecovery(null)}>I have saved them</Button>
            </div>
          </Alert>
        )}

        {mfa && !mfa.enabled && !setup && (
          <div><Button busy={busy} onClick={() => void begin()}>Set up two-step sign-in</Button></div>
        )}
        {setup && (
          <div className="stack" style={{ gap: 8 }}>
            <span className="small">
              1. In your authenticator app, add an account. On this phone, tap{' '}
              <a href={setup.otpauth_url}>open in authenticator app</a>; on a computer, choose
              {' '}&ldquo;enter a setup key&rdquo; and type:
            </span>
            <div className="mono" style={{ fontSize: 16, letterSpacing: '0.08em', padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8, wordBreak: 'break-all' }}>
              {setup.key}
            </div>
            <span className="small">2. Type the 6-digit code the app now shows:</span>
            <div className="row tight">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} placeholder="000000"
                     onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ width: 130, letterSpacing: '0.3em' }} aria-label="Code from the app" />
              <Button variant="primary" busy={busy} disabled={code.length !== 6} onClick={() => void enable()}>Turn on</Button>
              <Button variant="ghost" onClick={() => { setSetup(null); setCode(''); }}>Cancel</Button>
            </div>
          </div>
        )}
        {mfa?.enabled && !turningOff && (
          <div className="row tight" style={{ alignItems: 'center' }}>
            <span className="muted small" style={{ flex: 1 }}>
              On since {formatDateTime(mfa.enabled_at)} · {mfa.recovery_codes_left} recovery code(s) left
            </span>
            <Button size="sm" variant="ghost" onClick={() => { setTurningOff(true); setCode(''); }}>Turn off</Button>
          </div>
        )}
        {turningOff && (
          <div className="row tight">
            <Field label="Current app code, or a recovery code">
              <input value={code} maxLength={11} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-F-]/g, ''))} style={{ width: 170 }} />
            </Field>
            <div style={{ alignSelf: 'end' }} className="row tight">
              <Button variant="danger" busy={busy} disabled={code.length < 6} onClick={() => void disable()}>Turn off</Button>
              <Button variant="ghost" onClick={() => setTurningOff(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Devices ──────────────────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row tight" style={{ alignItems: 'center' }}>
          <b style={{ flex: 1 }}>Signed in on</b>
          {others > 0 && <Button size="sm" variant="ghost" onClick={() => void signOutOthers()}>Sign out other devices</Button>}
        </div>
        {(sessions ?? []).map((s) => (
          <div key={s.session_id} className="row tight small" style={{ alignItems: 'center' }}>
            <span style={{ flex: 1 }}>
              <b>{describeDevice(s.user_agent)}</b>{s.is_current && <> <Badge tone="info">this device</Badge></>}
              <span className="muted"> · {METHOD_LABEL[s.login_method] ?? s.login_method} · {s.ip ?? 'unknown IP'} · active {formatDateTime(s.last_seen_at)}</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => void signOut(s)}>Sign out</Button>
          </div>
        ))}
      </div>

      {/* ── History ──────────────────────────────────────────────────────── */}
      <div className="stack" style={{ gap: 4 }}>
        <b>Recent sign-ins</b>
        {(history ?? []).slice(0, 10).map((h, i) => (
          <div key={i} className="row tight small">
            <span style={{ flex: 1 }}>{formatDateTime(h.attempted_at)} <span className="muted">· {h.ip ?? 'unknown IP'}</span></span>
            {h.succeeded ? <Badge tone="good">signed in</Badge> : <Badge tone="critical">failed</Badge>}
          </div>
        ))}
        {history && !history.length && <span className="muted small">No sign-ins recorded yet.</span>}
        {(history ?? []).slice(0, 10).some((h) => !h.succeeded) && (
          <span className="muted small">A failed attempt you do not recognise? Change your password and turn on two-step sign-in.</span>
        )}
      </div>
    </div>
  );
}
