# Hardware Store ERP

A multi-branch ERP for a hardware retail chain: catalog, GST billing, inventory and
procurement, quotations, customer credit, returns and warranty, CRM, expenses, HR,
reporting, and an admin control panel — built against the v6 requirements document.

**Status:** complete and verified. 260 API checks and 39 UI checks pass from a database
built out of `db/schema.sql` + `db/seed.sql`. See `REQUIREMENTS_CHECKLIST.md` for the
requirement-by-requirement mapping.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Database | **PostgreSQL 16** | Row-level security, triggers, generated columns, `EXCLUDE` constraints — the schema leans on all of them. Branch isolation is enforced *here*, not in application code. |
| Backend | **Node.js + TypeScript + Fastify** | One language across the stack, JSON-schema validation on every route, good performance at this concurrency. |
| DB access | **Kysely** (typed SQL builder, not an ORM) | Compile-time query safety without fighting the Postgres features this schema depends on. No raw string interpolation anywhere. |
| Frontend | **Next.js (Pages Router) + SWR + Recharts** | Web-first with offline billing, one shared design system, Hindi/English, light/dark. |
| Offline | Local queue + `client_txn_id` idempotency | Billing keeps working through an outage; conflicts resolve by `server_received_at`, never by silently overselling. |

## Security model

The application connects to Postgres as **`erp_app`, a non-owner role**, which is the
whole point: a table owner bypasses row-level security, so an app connecting as the owner
would have RLS that looks enforced and isn't.

Every request opens a transaction that sets three GUCs from the session —
`erp.user_id`, `erp.role`, `erp.branch_id` — and every RLS policy is written against
them. A branch user cannot read another branch's rows even if a route forgets to filter,
and the branch for a write is always taken from the session, never from the request body.

Credentials never leave the database. Passwords, PINs and OTPs are hashed with pgcrypto
bcrypt inside `SECURITY DEFINER` functions; sessions are HMAC-tagged bearer tokens of
which only the SHA-256 is stored. OTP codes and reset tokens go into `auth_message_outbox`,
which has RLS on, **no policy**, and `REVOKE ALL … FROM erp_app` — the app role cannot
read it at all.

## Layout

```
erp-project/
├── db/
│   ├── schema.sql              ← the entire schema: tables, RLS, functions, grants
│   └── seed.sql                ← the entire demo dataset
├── apps/
│   ├── api/                    ← Fastify + Kysely
│   │   ├── src/lib/            ← db scoping, rbac, sessions, tax, ledger, audit, pdf
│   │   ├── src/routes/         ← one folder per requirements section
│   │   └── scripts/smoke-test.mjs   ← 260 checks
│   └── web/                    ← Next.js
│       ├── styles/globals.css  ← the design tokens
│       ├── components/ui.tsx   ← the shared component library
│       └── pages/              ← 13 screens
├── uitest.mjs                  ← 39 Playwright checks
├── shots.mjs                   ← screenshot capture
├── screenshots/
├── REQUIREMENTS_CHECKLIST.md
└── docker-compose.yml
```

There is exactly one schema file and one seed file. Nothing else is `.sql`.

## Getting started

```bash
docker compose up -d                     # local Postgres 16

cp .env.example .env                     # then fill in the secrets below

# Apply the schema as the OWNER role, not as the app role.
export MIGRATION_DATABASE_URL=postgres://erp:erp_dev_password@127.0.0.1:5432/erp
psql "$MIGRATION_DATABASE_URL" -v erp_app_password=change_me -f db/schema.sql
psql "$MIGRATION_DATABASE_URL" -f db/seed.sql

npm install
npm run dev                              # API on :4000, web on :3000
```

`.env.example` documents every variable. At minimum set `DATABASE_URL` (the **`erp_app`**
connection the API uses — not the owner), `MIGRATION_DATABASE_URL` (the owner role, used
only to apply the two `.sql` files), and `SESSION_SECRET`. `GOOGLE_OAUTH_CLIENT_ID` and the
WhatsApp credentials are optional: leave them blank and Google sign-in is disabled while
email+password and phone+PIN still work, and the message queue drains locally instead of
delivering.

## Verifying

```bash
npm run typecheck
npm run build
node apps/api/scripts/smoke-test.mjs     # 260 checks, per-role and per-branch
node uitest.mjs                          # 39 checks, desktop + mobile
```

The smoke test asserts real behaviour, not just status codes: that a Branch-1 cashier
reads zero Branch-2 invoices *in SQL as `erp_app`*, that cost columns are masked for
staff, that a void reverses the money, that two concurrent credit sales cannot both
squeeze under one limit, and that a revoked token stops working immediately.

## Demo credentials

Development only — rotate before any real deployment.

| Role | Login | Secret |
|---|---|---|
| Owner / Admin | `owner@hardwareerp.in` | `Owner@12345` |
| Branch Manager (Andheri West) | `sunita@hardwareerp.in` | `Manager@12345` |
| Accountant | `meera@hardwareerp.in` | `Account@12345` |
| Cashier (Andheri West) | phone `9900000005` | PIN `1234` |
| Inventory staff (Andheri West) | phone `9900000008` | PIN `1234` |

## Before production

- Rotate every seeded credential and the `erp_app` password.
- Point `GOOGLE_OAUTH_CLIENT_ID` at a real OAuth client; the WhatsApp sender in
  `apps/api/src/lib/whatsapp.ts` is a queue with a stub transport — plug in the
  Business API provider.
- Confirm with a CA whether inter-branch transfers are intrastate or interstate for
  your GSTIN structure (flagged in the requirements doc, §15). The system supports
  both; which applies is a legal question.
- Move background sweeps off in-process timers onto a real job queue if you scale
  past one API instance.
