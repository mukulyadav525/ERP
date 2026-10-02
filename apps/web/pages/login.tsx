// ============================================================================
// Login (Section 7.2) — every documented path, all of them real:
//   • Google sign-in (verified ID token, when a client ID is configured)
//   • email or phone + password
//   • phone + PIN, for shop-floor staff
//   • a one-time code by email, or by WhatsApp to a phone
//   • two-step sign-in: an authenticator-app code after any of the above
//   • self-service registration → an admin approval queue
//   • forgot password / forgot PIN → single-use reset link or code
// Only options the server can actually deliver are shown (GET /api/auth/methods).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Script from 'next/script';
import { apiGet, apiPost, ApiError } from '../lib/api';
import { useAuth, type AuthUser } from '../lib/AuthContext';
import { useI18n } from '../lib/i18n';
import { Alert, Button, Field } from '../components/ui';

type Mode = 'password' | 'pin' | 'email' | 'otp' | 'register' | 'forgot' | 'twostep';

interface Branch { branch_id: string; name: string; }
interface Methods { google_client_id: string | null; email_codes: boolean; phone_codes: boolean; password_reset: boolean }
type LoginResult = { token: string; user: AuthUser } | { mfa_required: true; mfa_token: string };

// The client ID now comes from the API at runtime (one setting on the server);
// the build-time variable still works for older deployments.
const BUILD_GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const { t, lang, setLang } = useI18n();

  const [mode, setMode] = useState<Mode>('password');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);

  // Password
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  // PIN
  const [pinPhone, setPinPhone] = useState('');
  const [pin, setPin] = useState('');
  // OTP
  const [otpPhone, setOtpPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  // Register
  const [reg, setReg] = useState({ full_name: '', phone: '', email: '', requested_role: 'CASHIER', branch_id: '', password: '' });
  // Forgot / reset
  const [forgotId, setForgotId] = useState('');
  const [forgotKind, setForgotKind] = useState<'PASSWORD' | 'PIN'>('PASSWORD');
  const [resetToken, setResetToken] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [resetStage, setResetStage] = useState<'request' | 'enter'>('request');
  // Email code
  const [emailAddr, setEmailAddr] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  // Second step
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  // What this server offers
  const [methods, setMethods] = useState<Methods | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const GOOGLE_CLIENT_ID = methods?.google_client_id || BUILD_GOOGLE_CLIENT_ID;

  useEffect(() => {
    apiGet<Methods>('/api/auth/methods').then(setMethods)
      .catch(() => setMethods({ google_client_id: null, email_codes: false, phone_codes: false, password_reset: false }));
  }, []);

  // A reset link from an email: /login?reset=<token>&kind=PASSWORD|PIN
  useEffect(() => {
    const token = typeof router.query.reset === 'string' ? router.query.reset : '';
    if (!token) return;
    setMode('forgot'); setResetStage('enter'); setResetToken(token);
    setForgotKind(router.query.kind === 'PIN' ? 'PIN' : 'PASSWORD');
    setNotice(router.query.kind === 'PIN' ? 'Choose your new PIN below.' : 'Choose your new password below.');
  }, [router.query.reset, router.query.kind]);

  // The signup form needs branch names before anyone is signed in, so this is the
  // one unauthenticated read in the app.
  useEffect(() => {
    apiGet<Branch[]>('/api/auth/branches/public').then(setBranches).catch(() => setBranches([]));
  }, []);

  // Navigation is left to the auth gate in _app. Redirecting from here as well
  // meant two router.replace calls raced, and Next aborted one of them —
  // harmless, but it filled the console with a spurious error on every sign-in.
  const finish = useCallback((res: LoginResult) => {
    // Two-step sign-in: the first step passed; ask for the second before signing in.
    if ('mfa_required' in res) {
      setMfaToken(res.mfa_token); setMfaCode(''); setMode('twostep'); setError(''); setNotice('');
      return;
    }
    login(res.token, res.user);
  }, [login]);

  function switchMode(m: Mode) {
    setMode(m); setError(''); setNotice('');
    setOtpSent(false); setEmailSent(false); setResetStage('request');
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  }

  // ── Google ────────────────────────────────────────────────────────────────
  // The button hands us an ID token; the server verifies its signature against
  // Google's keys before trusting a single field in it.
  const handleGoogleCredential = useCallback((response: { credential: string }) => {
    void run(async () => {
      const res = await apiPost<LoginResult>('/api/auth/login/google', {
        id_token: response.credential,
      });
      finish(res);
    });
  }, [finish]);

  // The button is drawn into #google-btn, which only exists on the Password tab —
  // so it is (re)drawn whenever that tab is showing, not just once on load (it
  // used to vanish after visiting another tab and coming back).
  useEffect(() => {
    const g = (window as any).google;
    if (!googleReady || !g || !GOOGLE_CLIENT_ID || mode !== 'password') return;
    g.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
    const host = document.getElementById('google-btn');
    if (host) { host.innerHTML = ''; g.accounts.id.renderButton(host, { theme: 'outline', size: 'large', width: 336, text: 'signin_with' }); }
  }, [googleReady, GOOGLE_CLIENT_ID, mode, handleGoogleCredential]);

  return (
    <>
      <Head>
        <title>BHAWANI ONE — Sign in</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      {GOOGLE_CLIENT_ID && (
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onLoad={() => setGoogleReady(true)} />
      )}

      <div style={{
        minHeight: '100vh', display: 'grid', placeItems: 'center',
        background: 'var(--surface-0)', padding: 20,
      }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          {/* Brand */}
          <div style={{ textAlign: 'center', marginBottom: 22 }}>
            <div style={{
              width: 46, height: 46, borderRadius: 12, background: 'var(--accent)', color: '#fff',
              display: 'inline-grid', placeItems: 'center', fontSize: 17, fontWeight: 800, marginBottom: 10,
            }}>BO</div>
            <h1 style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em' }}>BHAWANI ONE</h1>
            <div className="muted small" style={{ marginTop: 2 }}>
              {lang === 'hi' ? 'स्मार्ट बिज़नेस मैनेजमेंट सिस्टम' : 'Smart Business Management System'}
            </div>
          </div>

          <div className="card">
            <div className="card-body">
              {/* Mode switcher */}
              {mode !== 'twostep' && <div className="segmented" style={{ display: 'flex', width: '100%', marginBottom: 18 }}>
                {([
                  ['password', lang === 'hi' ? 'पासवर्ड' : 'Password'],
                  ['pin', lang === 'hi' ? 'फ़ोन + पिन' : 'Phone + PIN'],
                  ...(methods?.email_codes ? [['email', lang === 'hi' ? 'ईमेल कोड' : 'Email code']] : []),
                  ...(methods?.phone_codes ? [['otp', lang === 'hi' ? 'फ़ोन कोड' : 'Phone code']] : []),
                ] as [Mode, string][]).map(([m, label]) => (
                  <button key={m} style={{ flex: 1 }} className={mode === m ? 'active' : ''}
                          onClick={() => switchMode(m)}>{label}</button>
                ))}
              </div>}

              {error && <div style={{ marginBottom: 14 }}><Alert tone="critical">{error}</Alert></div>}
              {notice && <div style={{ marginBottom: 14 }}><Alert tone="good">{notice}</Alert></div>}

              {/* ── Email / phone + password ────────────────────────────── */}
              {mode === 'password' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const res = await apiPost<LoginResult>('/api/auth/login/password',
                      { identifier: identifier.trim(), password });
                    finish(res);
                  });
                }}>
                  <Field label={lang === 'hi' ? 'ईमेल या फ़ोन' : 'Email or phone'}>
                    <input type="text" autoComplete="username" required value={identifier}
                           onChange={(e) => setIdentifier(e.target.value)}
                           placeholder="you@example.com" />
                  </Field>
                  <Field label={lang === 'hi' ? 'पासवर्ड' : 'Password'}>
                    <input type="password" autoComplete="current-password" required value={password}
                           onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                  </Field>
                  <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                    {lang === 'hi' ? 'साइन इन करें' : 'Sign in'}
                  </Button>

                  {GOOGLE_CLIENT_ID && (
                    <>
                      <div className="row" style={{ margin: '4px 0' }}>
                        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                        <span className="muted small">or</span>
                        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                      </div>
                      <div id="google-btn" style={{ display: 'flex', justifyContent: 'center' }} />
                    </>
                  )}
                </form>
              )}

              {/* ── Phone + PIN ─────────────────────────────────────────── */}
              {mode === 'pin' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const res = await apiPost<LoginResult>('/api/auth/login/pin',
                      { phone: pinPhone.trim(), pin });
                    finish(res);
                  });
                }}>
                  <Field label={lang === 'hi' ? 'फ़ोन नंबर' : 'Phone number'}>
                    <input type="tel" inputMode="numeric" autoComplete="tel" required value={pinPhone}
                           onChange={(e) => setPinPhone(e.target.value)} placeholder="9900000005" />
                  </Field>
                  <Field label={lang === 'hi' ? 'पिन' : 'PIN'}
                         hint={lang === 'hi' ? '4 से 6 अंक' : '4 to 6 digits'}>
                    <input type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} required value={pin}
                           onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                           placeholder="••••" style={{ letterSpacing: '0.4em', fontSize: 17 }} />
                  </Field>
                  <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                    {lang === 'hi' ? 'साइन इन करें' : 'Sign in'}
                  </Button>
                </form>
              )}

              {/* ── Phone + OTP ─────────────────────────────────────────── */}
              {mode === 'otp' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  if (!otpSent) {
                    void run(async () => {
                      const res = await apiPost<{ message: string; dev_otp?: string }>('/api/auth/otp/request',
                        { phone: otpPhone.trim(), purpose: 'LOGIN' });
                      setOtpSent(true);
                      // In development the server returns the code so the flow can
                      // be used without a live SMS/WhatsApp gateway.
                      setNotice(res.dev_otp ? `${res.message} (development code: ${res.dev_otp})` : res.message);
                    });
                  } else {
                    void run(async () => {
                      const res = await apiPost<LoginResult>('/api/auth/login/otp',
                        { phone: otpPhone.trim(), otp });
                      finish(res);
                    });
                  }
                }}>
                  <Field label={lang === 'hi' ? 'फ़ोन नंबर' : 'Phone number'}>
                    <input type="tel" inputMode="numeric" required value={otpPhone} disabled={otpSent}
                           onChange={(e) => setOtpPhone(e.target.value)} placeholder="9900000005" />
                  </Field>
                  {otpSent && (
                    <Field label={lang === 'hi' ? 'सत्यापन कोड' : 'Verification code'}>
                      <input type="text" inputMode="numeric" maxLength={6} required value={otp}
                             onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                             placeholder="000000" style={{ letterSpacing: '0.4em', fontSize: 17 }} />
                    </Field>
                  )}
                  <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                    {otpSent
                      ? (lang === 'hi' ? 'सत्यापित करें' : 'Verify and sign in')
                      : (lang === 'hi' ? 'कोड भेजें' : 'Send code')}
                  </Button>
                  {otpSent && (
                    <Button type="button" variant="ghost" size="sm"
                            onClick={() => { setOtpSent(false); setOtp(''); setNotice(''); }}>
                      Use a different number
                    </Button>
                  )}
                </form>
              )}

              {/* ── Code by email ───────────────────────────────────────── */}
              {mode === 'email' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  if (!emailSent) {
                    void run(async () => {
                      const res = await apiPost<{ message: string; dev_otp?: string }>('/api/auth/email-code/request', { email: emailAddr.trim() });
                      setEmailSent(true);
                      setNotice(res.dev_otp ? `${res.message} (development code: ${res.dev_otp})` : res.message);
                    });
                  } else {
                    void run(async () => {
                      finish(await apiPost<LoginResult>('/api/auth/login/email-code', { email: emailAddr.trim(), code: emailCode }));
                    });
                  }
                }}>
                  <Field label={lang === 'hi' ? 'ईमेल' : 'Email'}>
                    <input type="email" autoComplete="email" required value={emailAddr} disabled={emailSent}
                           onChange={(e) => setEmailAddr(e.target.value)} placeholder="you@example.com" />
                  </Field>
                  {emailSent && (
                    <Field label={lang === 'hi' ? 'ईमेल में आया कोड' : 'Code from the email'}>
                      <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={emailCode} autoFocus
                             onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                             placeholder="000000" style={{ letterSpacing: '0.4em', fontSize: 17 }} />
                    </Field>
                  )}
                  <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                    {emailSent ? (lang === 'hi' ? 'साइन इन करें' : 'Sign in') : (lang === 'hi' ? 'कोड भेजें' : 'Email me a code')}
                  </Button>
                  {emailSent && (
                    <Button type="button" variant="ghost" size="sm"
                            onClick={() => { setEmailSent(false); setEmailCode(''); setNotice(''); }}>
                      Use a different email, or send again
                    </Button>
                  )}
                </form>
              )}

              {/* ── Second step ─────────────────────────────────────────── */}
              {mode === 'twostep' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    finish(await apiPost<LoginResult>('/api/auth/login/two-step', { mfa_token: mfaToken, code: mfaCode.trim() }));
                  });
                }}>
                  <div>
                    <b>{lang === 'hi' ? 'दो-चरण सत्यापन' : 'Two-step sign-in'}</b>
                    <div className="muted small" style={{ marginTop: 4 }}>
                      {lang === 'hi'
                        ? 'अपने ऑथेंटिकेटर ऐप में दिख रहा 6 अंकों का कोड डालें।'
                        : 'Enter the 6-digit code shown in your authenticator app. Lost your phone? Use one of your recovery codes.'}
                    </div>
                  </div>
                  <Field label={lang === 'hi' ? 'कोड' : 'Code'}>
                    <input type="text" autoComplete="one-time-code" inputMode="text" maxLength={11} required value={mfaCode} autoFocus
                           onChange={(e) => setMfaCode(e.target.value.toUpperCase().replace(/[^0-9A-F-]/g, ''))}
                           placeholder="000000" style={{ letterSpacing: '0.3em', fontSize: 17 }} />
                  </Field>
                  <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                    {lang === 'hi' ? 'सत्यापित करें' : 'Verify and sign in'}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setMfaToken(''); switchMode('password'); }}>
                    Cancel and start again
                  </Button>
                </form>
              )}

              {/* ── Register ────────────────────────────────────────────── */}
              {mode === 'register' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const res = await apiPost<{ message: string }>('/api/auth/register', {
                      ...reg, branch_id: reg.branch_id || undefined, email: reg.email || undefined,
                    });
                    setNotice(res.message);
                    setReg({ full_name: '', phone: '', email: '', requested_role: 'CASHIER', branch_id: '', password: '' });
                  });
                }}>
                  <Alert tone="info">
                    {lang === 'hi'
                      ? 'आपका अनुरोध एडमिन की मंज़ूरी के बाद ही सक्रिय होगा।'
                      : 'Your request goes to the owner for approval — accounts are never created automatically.'}
                  </Alert>
                  <Field label={lang === 'hi' ? 'पूरा नाम' : 'Full name'} required>
                    <input required value={reg.full_name} onChange={(e) => setReg({ ...reg, full_name: e.target.value })} />
                  </Field>
                  <Field label={lang === 'hi' ? 'फ़ोन नंबर' : 'Phone number'} required>
                    <input type="tel" required value={reg.phone} onChange={(e) => setReg({ ...reg, phone: e.target.value })} />
                  </Field>
                  <Field label={lang === 'hi' ? 'ईमेल (वैकल्पिक)' : 'Work email (optional)'}>
                    <input type="email" value={reg.email} onChange={(e) => setReg({ ...reg, email: e.target.value })} />
                  </Field>
                  <Field label={lang === 'hi' ? 'भूमिका' : 'Role requested'}>
                    <select value={reg.requested_role} onChange={(e) => setReg({ ...reg, requested_role: e.target.value })}>
                      <option value="CASHIER">Cashier / Sales staff</option>
                      <option value="INVENTORY_STAFF">Inventory staff</option>
                      <option value="BRANCH_MANAGER">Branch manager</option>
                      <option value="ACCOUNTANT">Accountant</option>
                    </select>
                  </Field>
                  <Field label={lang === 'hi' ? 'शाखा' : 'Branch'}>
                    <select value={reg.branch_id} onChange={(e) => setReg({ ...reg, branch_id: e.target.value })}>
                      <option value="">Select a branch…</option>
                      {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.name}</option>)}
                    </select>
                  </Field>
                  <Field label={lang === 'hi' ? 'पासवर्ड चुनें' : 'Choose a password'}
                         hint={lang === 'hi' ? 'कम से कम 8 अक्षर' : 'At least 8 characters'} required>
                    <input type="password" minLength={8} required value={reg.password}
                           onChange={(e) => setReg({ ...reg, password: e.target.value })} />
                  </Field>
                  <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                    {lang === 'hi' ? 'अनुरोध भेजें' : 'Submit request'}
                  </Button>
                </form>
              )}

              {/* ── Forgot password / PIN ───────────────────────────────── */}
              {mode === 'forgot' && (
                <form className="stack" onSubmit={(e) => {
                  e.preventDefault();
                  if (resetStage === 'request') {
                    void run(async () => {
                      const res = await apiPost<{ message: string; dev_reset_token?: string }>('/api/auth/forgot',
                        { identifier: forgotId.trim(), kind: forgotKind });
                      setResetStage('enter');
                      if (res.dev_reset_token) setResetToken(res.dev_reset_token);
                      setNotice(res.dev_reset_token
                        ? `${res.message} (development code filled in below)`
                        : res.message);
                    });
                  } else {
                    void run(async () => {
                      await apiPost('/api/auth/reset', { token: resetToken.trim(), new_secret: newSecret });
                      setNotice(lang === 'hi'
                        ? 'हो गया। अब नए पासवर्ड से साइन इन करें।'
                        : 'Done. Sign in with your new credentials.');
                      setResetStage('request'); setForgotId(''); setResetToken(''); setNewSecret('');
                      setMode(forgotKind === 'PIN' ? 'pin' : 'password');
                    });
                  }
                }}>
                  {resetStage === 'request' ? (
                    <>
                      <Field label={lang === 'hi' ? 'क्या रीसेट करना है?' : 'What do you need to reset?'}>
                        <select value={forgotKind} onChange={(e) => setForgotKind(e.target.value as 'PASSWORD' | 'PIN')}>
                          <option value="PASSWORD">Password</option>
                          <option value="PIN">Quick-access PIN</option>
                        </select>
                      </Field>
                      <Field label={lang === 'hi' ? 'ईमेल या फ़ोन' : 'Email or phone'} required>
                        <input required value={forgotId} onChange={(e) => setForgotId(e.target.value)} />
                      </Field>
                      <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                        {lang === 'hi' ? 'रीसेट कोड भेजें' : 'Send reset code'}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Field label={lang === 'hi' ? 'रीसेट कोड' : 'Reset code'} required>
                        <input required value={resetToken} onChange={(e) => setResetToken(e.target.value)} />
                      </Field>
                      <Field
                        label={forgotKind === 'PIN'
                          ? (lang === 'hi' ? 'नया पिन' : 'New PIN')
                          : (lang === 'hi' ? 'नया पासवर्ड' : 'New password')}
                        hint={forgotKind === 'PIN' ? '4 to 6 digits' : 'At least 8 characters'} required>
                        <input type="password" required value={newSecret}
                               onChange={(e) => setNewSecret(forgotKind === 'PIN'
                                 ? e.target.value.replace(/\D/g, '').slice(0, 6)
                                 : e.target.value)} />
                      </Field>
                      <Button type="submit" variant="primary" size="lg" busy={busy} className="block">
                        {lang === 'hi' ? 'सेट करें' : 'Set new credentials'}
                      </Button>
                    </>
                  )}
                </form>
              )}
            </div>

            <div className="card-foot" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
              {mode === 'forgot' || mode === 'register' || mode === 'twostep' ? (
                <button className="btn ghost sm" onClick={() => switchMode('password')}>← Back to sign in</button>
              ) : methods?.password_reset ? (
                <button className="btn ghost sm" onClick={() => switchMode('forgot')}>Forgot password or PIN?</button>
              ) : (
                // No email or WhatsApp set up: a reset code could not be delivered,
                // so the link is not offered — the owner resets it instead.
                <span className="muted small" style={{ alignSelf: 'center' }}>Forgot it? Ask the owner to reset it.</span>
              )}
              {mode !== 'register' && mode !== 'twostep' && (
                <button className="btn ghost sm" onClick={() => switchMode('register')}>Request an account</button>
              )}
            </div>
          </div>

          <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
            <button className="btn ghost sm" onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>
              {lang === 'en' ? 'हिन्दी में देखें' : 'View in English'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
