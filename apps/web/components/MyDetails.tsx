// "Your details" in My account — for every role: name, phone, email, language.
// Phone and email are what you sign in with, so changing either asks for your
// current password (or PIN). Role and branch are shown, but only the Owner
// changes them (Admin → Users).
import { useEffect, useState } from 'react';
import { apiPut } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useI18n } from '../lib/i18n';
import { useToast } from '../lib/ToastContext';
import { Button, Field, KeyValue } from './ui';

export default function MyDetails({ open }: { open: boolean }) {
  const { user, roleLabel, refreshUser } = useAuth();
  const { setLang } = useI18n();
  const toast = useToast();
  const initial = () => ({ full_name: user?.full_name ?? '', phone: user?.phone ?? '', email: user?.email ?? '', language_pref: user?.language_pref ?? 'en' });
  const [form, setForm] = useState(initial);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(initial()); setSecret(''); } }, [open, user]);   // eslint-disable-line react-hooks/exhaustive-deps

  const contactChanged = form.phone.replace(/\s+/g, '') !== (user?.phone ?? '') || form.email.trim().toLowerCase() !== (user?.email ?? '').toLowerCase();
  const dirty = contactChanged || form.full_name.trim() !== (user?.full_name ?? '') || form.language_pref !== (user?.language_pref ?? 'en');

  async function save() {
    if (!form.full_name.trim()) { toast.error(new Error('Enter your name.')); return; }
    if (form.phone && form.phone.replace(/\D/g, '').length < 10) { toast.error(new Error('Enter a 10-digit phone number.')); return; }
    if (contactChanged && !secret) { toast.error(new Error('Enter your current password or PIN to change your phone or email.')); return; }
    setBusy(true);
    try {
      const res = await apiPut<{ changed: string[] }>('/api/auth/me', {
        full_name: form.full_name.trim(), phone: form.phone.replace(/\s+/g, ''), email: form.email.trim(),
        language_pref: form.language_pref, current_secret: secret || undefined,
      });
      await refreshUser();
      if (res.changed.includes('language')) setLang(form.language_pref as 'en' | 'hi');
      setSecret('');
      toast.success('Your details are saved',
        res.changed.includes('phone') ? 'Sign in with your new phone number from now on.'
          : res.changed.includes('email') ? 'Use your new email to sign in from now on.' : undefined);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <b>Your details</b>
      <div className="grid cols-2">
        <Field label="Full name" required>
          <input value={form.full_name} maxLength={120} autoComplete="name" onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label="Language">
          <select value={form.language_pref} onChange={(e) => setForm({ ...form, language_pref: e.target.value as 'en' | 'hi' })}>
            <option value="en">English</option>
            <option value="hi">हिन्दी (Hindi)</option>
          </select>
        </Field>
        <Field label="Phone" hint="You sign in with this (phone + PIN)">
          <input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email" hint="For password sign-in, Google, and reset links">
          <input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
      </div>
      {contactChanged && (
        <Field label="Current password or PIN" required hint="Changing your phone or email needs it — they are how you sign in.">
          <input type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      )}
      <KeyValue items={[['Role', roleLabel], ['Branch', user?.branch_name || (user?.role === 'OWNER_ADMIN' ? 'All branches' : '—')]]} />
      <span className="muted small">Your role and branch are set by the owner.</span>
      <div><Button type="submit" variant="primary" busy={busy} disabled={!dirty}>Save my details</Button></div>
    </form>
  );
}
