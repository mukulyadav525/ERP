// ============================================================================
// Email, for sign-in codes and password resets.
//
// Sent through an HTTPS email API rather than SMTP: Railway blocks outgoing SMTP
// on its cheaper plans, and an API key is one setting instead of five.
//   BREVO_API_KEY  + MAIL_FROM   — Brevo: sends from one verified address (a
//                                  Gmail works), free tier 300 emails a day
//   RESEND_API_KEY + MAIL_FROM   — Resend: needs your own verified domain
// With neither set, email is simply off and the sign-in screen does not offer it.
// ============================================================================
import { env } from './env.js';

export const mailEnabled = (): boolean => env.mail.enabled;

/** "Shop Name <me@gmail.com>" or "me@gmail.com" → { name, email }. */
function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2] } : { email: from.trim() };
}

// For automated tests only: send to a local fake mail server instead.
const apiBase = (fallback: string) => (process.env.MAIL_API_URL || fallback).replace(/\/$/, '');

export async function sendEmail(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  if (!env.mail.enabled) throw new Error('Email is not configured.');
  const from = parseFrom(env.mail.from);
  const res = env.mail.provider === 'brevo'
    ? await fetch(`${apiBase('https://api.brevo.com')}/v3/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': env.mail.brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
          to: [{ email: msg.to }],
          subject: msg.subject,
          textContent: msg.text,
          ...(msg.html ? { htmlContent: msg.html } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      })
    : await fetch(`${apiBase('https://api.resend.com')}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.mail.resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.mail.from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
  // The provider's error text never includes the message body, so it is safe to keep.
  if (!res.ok) throw new Error(`${env.mail.provider} responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A plain, readable email: a heading, a big code (or a button), a note. */
export function codeEmail(opts: { brand: string; heading: string; code?: string; link?: { url: string; label: string }; note: string }): { text: string; html: string } {
  const text = [opts.heading, '', opts.code ? `Code: ${opts.code}` : '', opts.link ? `${opts.link.label}: ${opts.link.url}` : '', '', opts.note, '', `— ${opts.brand}`]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e3e5e8">
<div style="font-weight:700;font-size:15px;margin-bottom:14px">${esc(opts.brand)}</div>
<div style="font-size:17px;margin-bottom:18px">${esc(opts.heading)}</div>
${opts.code ? `<div style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace;margin:8px 0 18px">${esc(opts.code)}</div>` : ''}
${opts.link ? `<a href="${esc(opts.link.url)}" style="display:inline-block;background:#2f6bf0;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${esc(opts.link.label)}</a>` : ''}
<div style="font-size:13px;color:#666;margin-top:20px;line-height:1.5">${esc(opts.note)}</div>
</div></body></html>`;
  return { text, html };
}
