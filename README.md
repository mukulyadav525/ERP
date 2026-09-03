# BHAWANI ONE — Smart Business Management System

A multi-branch ERP for a hardware, paint, plumbing and electrical retail chain: catalog,
GST billing, inventory and procurement, quotations, customer credit, returns and warranty,
CRM, expenses, HR, reporting, and an admin control panel — built against the v6
requirements document.

**Status:** verified against a database built from scratch out of `db/schema.sql` +
`db/seed.sql`. `npm run verify` runs typecheck, lint, build and the whole suite:

| Suite | What it covers | Checks |
|---|---|---|
| `tests/tax-properties.mjs` | GST rounding, base-unit maths, returns, weighted-average cost, over ~50,000 generated cases | 20 |
| `apps/api/scripts/smoke-test.mjs` | per-role and per-branch API behaviour, RLS in raw SQL, global-search scope | 265 |
| `tests/regression.mjs` | every defect found in the production audit, plus negative and concurrency cases | 75 |
| `tests/workflows.mjs` | the ten end-to-end business journeys, each cross-checked against the database | 68 |
| `tests/pdf-matrix.mjs` + `pdf-geometry.mjs` | 13 document permutations, then an automatic margin/overlap check | 13 + 13 |
| `tests/uitest.mjs` | a real browser: every page, 390px layout, the draft flow, roles, Hindi, themes, dead controls | 76 |
| `tests/viewports.mjs` | 12 widths (320 → 2560px) × 12 routes × both themes: page overflow, clipped controls, touch targets | 35 |

See `REQUIREMENTS_CHECKLIST.md` for the requirement-by-requirement mapping.

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
│   │   ├── src/lib/            ← db scoping, rbac, sessions, tax, billing engine, ledger, audit
│   │   ├── src/lib/pdf/        ← the document system: theme, renderer, business profile
│   │   ├── src/routes/         ← one folder per requirements section
│   │   ├── assets/fonts/       ← Lohit Devanagari, for Hindi documents (OFL)
│   │   └── scripts/smoke-test.mjs
│   └── web/                    ← Next.js
│       ├── styles/globals.css  ← the design tokens
│       ├── components/ui.tsx   ← the shared component library
│       └── pages/              ← 13 screens
├── tests/
│   ├── tax-properties.mjs      ← property tests for the tax engine
│   ├── regression.mjs          ← the audit's findings, locked down
│   ├── workflows.mjs           ← the ten end-to-end business journeys
│   ├── pdf-matrix.mjs          ← renders every document permutation
│   ├── pdf-geometry.mjs        ← asserts nothing clips or overlaps
│   ├── uitest.mjs              ← browser checks (Playwright)
│   └── viewports.mjs           ← responsive sweep, every supported width
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
npm run verify        # typecheck + lint + build + every suite below
npm test              # tax properties, API, regression, workflows, documents
npm run test:ui         # browser checks (needs: npx playwright install chromium)
npm run test:responsive # every viewport, both themes, every route
```

The suites assert behaviour, not status codes: that a Branch-1 cashier reads zero
Branch-2 invoices *in SQL as `erp_app`*, that cost columns are masked for staff, that a
void reverses the money, that two concurrent credit sales cannot both squeeze under one
limit, that two clerks refunding the same line at once cannot refund it twice, that a
finalised invoice cannot be altered even by the database role the API connects as, and
that the figure on the screen, in the ledger, in the report and on the PDF is the same
figure.

## Printed documents

Three templates share one renderer (`src/lib/pdf/`): the **GST tax invoice**, the
**non-GST cash memo / bill of supply**, and the **estimate / quotation**. They page
automatically, repeat the column headings, size their money columns to the figures they
actually hold, and carry the tax summary, amount in words, bank and UPI details,
declaration, terms and signature. A draft prints as a watermarked proforma with no
number, because it has not drawn one from the gapless series.

Nothing about the shop is hard-coded. Name, logo, address, GSTIN, bank, UPI, declaration,
terms and signature label all come from the **Business profile** in Admin → Settings,
chain-wide or overridden per branch.

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
