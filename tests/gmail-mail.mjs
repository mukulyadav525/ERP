// ============================================================================
// Email through the Gmail API: the message built, the token fetched once and
// reused, a failure reported — against fake Google servers (nothing is sent).
//   cd apps/api && npx tsx ../../tests/gmail-mail.mjs
// ============================================================================
import http from 'node:http';

const PORT = 4198;
process.env.GMAIL_CLIENT_SECRET = 'secret-x';
process.env.GMAIL_REFRESH_TOKEN = 'refresh-x';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-x.apps.googleusercontent.com';
process.env.MAIL_FROM = 'Bhawani Hardware — दुकान <shop@gmail.com>';
process.env.MAIL_API_URL = `http://127.0.0.1:${PORT}`;
process.env.MAIL_TOKEN_URL = `http://127.0.0.1:${PORT}/token`;
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ??= 'postgres://x:x@127.0.0.1:5432/x';

let passed = 0; const failures = [];
const check = (n, ok, d = '') => { if (ok) { passed++; console.log(`  ✓ ${n}`); } else { failures.push(`${n} ${d}`); console.log(`  ✗ ${n}  ${String(d).slice(0, 200)}`); } };

let tokenCalls = 0, sent = [], failNext = false;
const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.url === '/token') {
      tokenCalls++;
      const p = new URLSearchParams(b);
      const ok = p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'refresh-x' && p.get('client_secret') === 'secret-x' && p.get('client_id') === 'client-x.apps.googleusercontent.com';
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { access_token: 'at-1', expires_in: 3599 } : { error: 'invalid_grant' }));
    }
    if (req.url === '/gmail/v1/users/me/messages/send') {
      if (failNext) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"insufficient scope"}}'); }
      sent.push({ auth: req.headers.authorization, raw: Buffer.from(JSON.parse(b).raw, 'base64url').toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"id":"m1"}');
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

try {
  const { sendEmail, mailEnabled, codeEmail } = await import('../apps/api/src/lib/mailer.ts');
  const { env } = await import('../apps/api/src/lib/env.ts');
  console.log('\nGmail API provider');
  check('Gmail is picked, and email counts as set up', env.mail.provider === 'gmail' && mailEnabled());

  const body = codeEmail({ brand: 'Bhawani Hardware', heading: 'Your sign-in code', code: '482913', note: 'Expires in 10 minutes.' });
  await sendEmail({ to: 'someone@example.com', subject: 'Your code — नमस्ते', ...body });
  const m = sent[0];
  check('the message is sent with the access token', m?.auth === 'Bearer at-1');
  check('From is the Gmail address, with the shop name', /^From: .*<shop@gmail\.com>/m.test(m.raw), m.raw.split('\r\n')[0]);
  check('To and a non-English subject are encoded properly', /^To: someone@example\.com$/m.test(m.raw) && /^Subject: =\?UTF-8\?B\?/m.test(m.raw));
  const parts = m.raw.split(/--b_[^\r\n]+/);
  const decode = (p) => Buffer.from(p.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  const text = decode(parts[1]); const html = decode(parts[2]);
  check('the plain-text part holds the code', text.includes('482913'), text);
  check('the HTML part holds the code', html.includes('482913') && html.includes('<html'));

  await sendEmail({ to: 'a@example.com', subject: 'Second', text: 'plain only' });
  check('a second email reuses the access token (one token request)', tokenCalls === 1, `${tokenCalls}`);
  check('a text-only message is sent too', /Content-Type: text\/plain/.test(sent[1].raw));

  failNext = true;
  let err = ''; try { await sendEmail({ to: 'a@example.com', subject: 'x', text: 'x' }); } catch (e) { err = String(e.message); }
  check('a refusal from Gmail is reported, not swallowed', err.includes('403'), err);
} catch (e) { failures.push(`crashed: ${e.stack}`); console.log(e); }
finally { srv.close(); }

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log('  •', f)); process.exit(1); }
