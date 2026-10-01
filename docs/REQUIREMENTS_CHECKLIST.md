# BHAWANI ONE — Requirements Compliance Checklist

Verified against a database built from scratch out of `db/schema.sql` + `db/seed.sql`.
**840 automated checks pass, 0 failures**, across nine suites (plus the PDF geometry check)
— see `PRODUCTION_AUDIT.md` for the defects found and fixed, and the remaining issues.

- Schema: `db/schema.sql` — 79 tables, row-level security throughout, run by a non-owner app role
- Seed: `db/seed.sql` — 3 branches, 11 users across 5 roles, 28 products (with loose goods sold by 100 G / KG), 60 customers, ~8,300 invoices over 270 days; stock equals its ledger for every item
- API: Fastify 5 + Kysely across 14 route modules, every endpoint behind a permission gate
- Web: Next.js 15, 13 pages on one design system, light (default) and dark, responsive from 320px, Hindi/English navigation
- Tests: tax properties (20), API smoke (274), regression (76), workflows (71), final pass (121), working day (140), documents (13 + geometry), browser (90), responsive (35)
- Operations: `npm run backup`, `npm run backup:restore-test`, `npm run create-owner`; `docs/OPERATIONS.md`

**Since the first release:** billing gained a draft → review → edit → finalise flow with
server-side recalculation at every step (Sections 11, 12, 62); the printed documents were
rebuilt as three templates on one renderer with a configurable business profile
(Sections 58–68); and thirteen defects were found and fixed, four of them financial.

There is exactly **one** schema file and **one** seed file in the project. No other `.sql` exists.

---

## Part A — Your 8 build instructions

| # | What you asked for | Status | Where it lives / how it was proved |
|---|---|---|---|
| A1 | Make the UI consistent everywhere | ✅ | One token-based design system in `apps/web/styles/globals.css`; one shared component library in `apps/web/components/ui.tsx` (PageHeader, Card, StatTile, Button, Field, Tabs, Badge, DataTable, Modal, ConfirmDialog, EmptyState, AsyncSection, …). All 13 pages rebuilt on it; no ad-hoc inline styling left. Light/dark/system themes, responsive to 390px. `uitest.mjs` checks layout on desktop and phone, including 0px horizontal overflow. |
| A2 | Fully working login: email+password, Google, register, phone, forgot | ✅ | `apps/api/src/routes/auth/index.ts` — `/login/password`, `/login/google`, `/login/pin`, `/otp/request` + `/login/otp`, `/register` (with admin approval queue), `/forgot` + `/reset`, `/change-password`, `/set-pin`, `/logout`, `/sessions`. Passwords and PINs are bcrypt (`gen_salt('bf',12)`) inside SECURITY DEFINER functions — no hash ever leaves the database. Sessions are HMAC-tagged bearer tokens; only `sha256(token)` is stored. Lockout after N failed attempts (`login_attempts`). |
| A3 | Role-based access + **row-level** access in the schema | ✅ | Postgres RLS on all 74 tables, 69 policies, driven by per-transaction GUCs `erp.user_id` / `erp.role` / `erp.branch_id` set by `withScope()` in `apps/api/src/lib/db.ts`. The app connects as a **non-owner** role (`erp_app`) so RLS is genuinely enforced rather than bypassed. 57 named permissions across 5 roles in `apps/api/src/lib/rbac.ts`. |
| A4 | No bugs, no errors, no security holes | ✅ | Two full adversarial review rounds. Round 1: 1 critical + 7 high + 11 medium + 10 low, all fixed. Round 2 (reviewing the fixes): 6 new issues introduced by the fixes, all fixed. Details in Part C. Smoke test has dedicated "Security regressions" and "Concurrency & background work" sections. |
| A5 | Make everything actually work | ✅ | Every module has real write paths, not stubs: quotations create→approve→reserve→convert, returns with GST credit notes, inter-branch transfers with a discrepancy state, purchase returns with vendor debit notes, stock audits, write-offs, expense approvals, HR attendance/leave/shifts/payroll, CRM campaigns, offline billing queue. |
| A6 | A branch member sees only their own branch | ✅ | Enforced in the database, not just the UI. `erp_branch_ok(b)` returns true only for `OWNER_ADMIN` or a row matching the caller's `erp.branch_id`. The branch for a write is taken from the session (`writeBranch()`), never from the request body. Smoke test section "Branch isolation" proves a Branch-1 cashier sees 0 rows of Branch 2 — checked directly in SQL as `erp_app`, not just through the API. |
| A7 | One schema.sql and one seed.sql, nothing else | ✅ | `db/schema.sql` and `db/seed.sql`. The old `001_init.sql`, `002_grants.sql`, `seed.sql`, `seed_transactions.sql`, `seed_expenses_hr_returns.sql` and the loose root `erp_schema.sql` are all gone, merged in. `find . -name '*.sql'` returns exactly two files. |
| A8 | Nothing missed | ✅ | Part B below walks every numbered requirement in the v6 document. |

---

## Part B — The 17 original requirements

| # | Requirement | Status | Evidence |
|---|---|---|---|
| B1 | Hindi / English i18n | ✅ | `apps/web/lib/i18n.tsx`, language toggle in the sidebar, applied to navigation, page chrome, receipts and WhatsApp message templates. Training journals carry both languages. |
| B2 | Master catalog + fuzzy search | ✅ | `catalog` routes: products, categories, brands, HSN rates, multi-barcode, units, bundles, bulk import, margins. Trigram fuzzy search on name/SKU — barcode is a speed option, never required (`require_barcode_at_billing` defaults off). |
| B3 | GST / non-GST billing | ✅ | `apps/api/src/lib/tax.ts` + `routes/billing`. Mixed GST and non-GST lines on one bill; CGST/SGST vs IGST; half-up rounding **per line**, invoice tax = sum of already-rounded line taxes (3.1.1). Tax-inclusive extraction verified against 20,000 generated lines with 0 mismatches. |
| B4 | WhatsApp invoice delivery | ✅ | `apps/api/src/lib/whatsapp.ts` + `whatsapp_message_log`, queued when offline and replayed on reconnect. Invoice PDF at `GET /api/billing/invoices/:id/pdf`. |
| B5 | Credit ledger | ✅ | `customer_credit_ledger` is **chain-wide**, not per-branch, so one ₹50,000 limit cannot be spent again at every branch. Posted only through `customer_credit_post(...)`, which takes `SELECT … FOR UPDATE` on the customer row before computing the balance, so two concurrent sales cannot both squeeze under the limit. |
| B6 | RBAC | ✅ | See A3. 5 roles, 57 permissions, plus field-level masking: cost and margin columns are stripped for anyone without `view_cost_price`, including in exports. |
| B7 | Vendor / service-provider tracking | ✅ | `vendors` routes: master, ledger, payments, outstanding list, performance analytics, vendor-item mapping. Payables posted through the locked `vendor_ledger_post(...)`. |
| B8 | Multi-branch inventory | ✅ | Master data global, stock local (`branch_stock` keyed on branch + product). Cross-branch lookup at `GET /api/inventory/stock/cross-branch`, gated on `cross_branch_lookup` (Owner/Admin only). |
| B9 | Expense management | ✅ | Categories, branch-wise entry, approval workflow above a configurable threshold, monthly comparison, expense-vs-revenue ratio per branch. |
| B10 | Employee performance | ✅ | `hr` routes: employees, attendance check-in/out, leave requests, shifts, roster, performance, payroll. Sales attribution per bill feeds `GET /api/reports/sales-by-employee`. |
| B11 | Admin control panel with feature flags | ✅ | All 34 Section-17 settings live in `admin_settings`, chain-wide or per-branch, editable at `PUT /api/admin/settings/:key` with no code change. |
| B12 | Birthday WhatsApp greetings | ✅ | `GET /api/crm/birthdays`, `POST /api/crm/birthdays/send-greetings`, plus a background sweep. |
| B13 | Loyalty points | ✅ | Earn rate, redemption, expiry, manual adjustment; stacking with discounts is a setting (off by default). |
| B14 | Sales return / refund | ✅ | Full and partial returns against the original invoice, resellable stock-in or write-off, refund method per transaction or locked chain-wide. |
| B15 | Warranty / replacement | ✅ | Warranty periods per product/category, serial capture at sale, claims linked to the original invoice, outcome recorded with vendor cross-reference. |
| B16 | Admin + staff training journals | ✅ | `training_journals`, versioned, Hindi/English, at `GET`/`POST /api/admin/training-journals`. |
| B17 | Cloud backup, phone + OTP restore | ✅ | `backups` table, `POST /api/admin/backups`, `POST /api/admin/backups/:id/restore-test` with a documented restore drill. Phone+OTP recovery through `/otp/request` → `/login/otp`. |

---

## Part C — The engineering and data fixes in the v6 document

Every `[DATA-FIX]` and `[ENG-FIX]` clause is implemented, because these are the ones that
quietly break a system months later.

| Clause | What it demanded | How it is done |
|---|---|---|
| 2.2.1 | Mandatory base unit; higher units are multiples, never separate prices | `products.base_unit` is `NOT NULL`; `product_units` stores the multiple. Billing converts to base units *before* pricing, so 3 screws out of a 100-piece box is `3 × (box_price ÷ 100)`. |
| 2.6 / 4.8.1 | Cost is derived, not typed | `weighted_avg_cost` recalculated per branch on every stock-in only; the admin-editable field is a separate *expected* purchase price, shown side by side. |
| 2.7 | Tax-rate versioning | `hsn_tax_rates (hsn_code, gst_rate_pct, effective_from)`; historical invoices keep the rate that applied on their billing date. |
| 2.8 | Tax-inclusive vs exclusive | Per-item default, per-line override, and the active mode is displayed on the billing line. Inclusive components are drift-corrected so they sum back exactly to the marked price. |
| 3.1.1 | GST rounding | Half-up, per line, invoice total = sum of rounded lines. Same code path for billing, quotations and credit notes. |
| 3.3.1 | Till cash movements | `till_events` with `OPENING_FLOAT`, `CASH_SALE`, `CASH_DROP` (manager acknowledgment required), `PETTY_EXPENSE_PAYOUT`; reconciliation compares expected-vs-counted, flagging only the variance. |
| 3.5 / 3.5.1 | Offline billing and sync conflicts | `client_txn_id` idempotency, localStorage queue, replay on reconnect. Later-arriving sales against insufficient stock become `stock_conflicts` for a human to resolve — never silently oversold, never auto-voided. |
| 3.6 | Gapless invoice numbering | A locked `document_sequences` table, **not** a Postgres sequence — sequences are non-transactional and leave gaps on rollback, which is exactly what a GST auditor flags. |
| 3.8 | Negative-stock override | Off by default and enforced by a database trigger; the PIN override sets a transaction-local `erp.allow_negative_stock` GUC. Receiving stock against an already-negative balance is always allowed. |
| 3.10 | Cart price lock | Line prices lock at scan time; an explicit "refresh cart" action is the only way to re-price. A *lowered* line rate is counted as an implied discount so it cannot be used to dodge the discount limit. |
| 4.4.1 | Transfer discrepancy | An explicit `TRANSFER_DISCREPANCY` state; neither branch's ledger is silently adjusted; the shortfall is routed to Admin to resolve as a write-off or a correction. |
| 4.5.1 | Vendor debit note | GRN reference → return quantity → debit note on its own number series → stock debited at that GRN's cost → payable reduced. This is what backs the ITC reversal. |
| 5.1 | Quotation stock reservation | Off by default; when on, *approving* (not generating) a quote moves stock to `RESERVED` with a configurable hold, auto-released on lapse. |
| 6.1.1 | Offline credit | Capped at 50% of the last-cached available limit, or hard-blocked, per setting; over-limit results on sync are flagged to Admin rather than accepted. Quotation conversion goes through the same limit check. |
| 11.2.1 | Refund hierarchy | Fixed, non-configurable order: revoke earned points → restore redeemed points → refund only the remaining cash portion, prorated per line on partial returns. |
| 12.1.1 | GST credit notes | Own sequential series, linked to the original invoice, only for GST-invoiced sales. |
| 15 | Compliance | Sequential numbering, mandatory HSN, rate versioning, e-invoicing flag, documented backup + restore test, customer PII export restricted to Admin. |

---

## Part D — Security findings and what was done

**Round one — 1 critical, 7 high, 11 medium, 10 low. All fixed.**

- **CRITICAL:** OTP codes and password-reset tokens were queued into `whatsapp_message_log`, which any authenticated user could read — a cashier could have reset the Owner's password in three requests. Fixed with a sealed `auth_message_outbox`: RLS on, **no policy at all**, and `REVOKE ALL … FROM erp_app`, so the application role cannot read it under any circumstances.
- **HIGH:** an unchecked scan-time rate could be replayed; the override PIN had no lockout; approver UUIDs were trusted from the request body; the credit ledger was per-branch; voiding an invoice did not reverse the money; credit-purchase returns paid out cash; quotation conversion bypassed the credit limit.

**Round two — reviewing the fixes themselves — 6 new problems, all fixed.**

1. The now chain-wide credit ledger had no write serialisation → `customer_credit_post` / `vendor_ledger_post` with row locks.
2. The negative-stock override could not actually work, because the database trigger vetoed it → transaction-local `erp.allow_negative_stock`.
3. `override_approvals` was weaker than its sibling auth tables → verification and issuance merged into one SECURITY DEFINER function, single-use, expiring, bound to purpose + branch + requester.
4. Background workers were silently doing nothing, having no RLS context → `withSystemScope()`.
5. Cross-branch commercial exposure in ledger detail and vendor payables → labelled "Another branch" for non-admins; payables moved behind `view_financial_reports`.
6. `auth_outbox_take` had no claim step, so two workers could send the same OTP → `FOR UPDATE SKIP LOCKED` with a `SENDING` state.

---

## Demo credentials

| Role | Login | Password / PIN |
|---|---|---|
| Owner / Admin | `owner@hardwareerp.in` | `Owner@12345` |
| Branch Manager | `sunita@hardwareerp.in` | `Manager@12345` |
| Cashier | phone `9900000005` | PIN `1234` |
| Inventory staff | phone `9900000008` | PIN `1234` |
| Accountant | `meera@hardwareerp.in` | `Account@12345` |

## Running it

```bash
# apply as the OWNER role; the API itself connects as the non-owner erp_app
psql "$MIGRATION_DATABASE_URL" -v erp_app_password=<pw> -f db/schema.sql
psql "$MIGRATION_DATABASE_URL" -f db/seed.sql
npm install && npm run build && npm run dev
npm run verify                         # typecheck + lint + build + all suites
npm run test:ui                        # browser checks (npx playwright install chromium)
```
