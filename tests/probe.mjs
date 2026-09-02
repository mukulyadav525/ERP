// Ad-hoc probe harness used during the audit.
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
export async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
export async function login(email, password) {
  const r = await call('POST', '/api/auth/login/password', { body: { email, password } });
  if (!r.body?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body).slice(0,300)}`);
  return r.body;
}
export async function loginPin(phone, pin) {
  const r = await call('POST', '/api/auth/login/pin', { body: { phone, pin } });
  if (!r.body?.token) throw new Error(`pin login failed ${phone}: ${JSON.stringify(r.body).slice(0,300)}`);
  return r.body;
}
