# Production readiness audit — BHAWANI ONE

An end-to-end audit of the existing system, the defects it found, the fixes, and the
evidence. The application was already substantially built and of good quality: the
schema, RLS model, tax engine and auth design were sound and are largely unchanged. What
follows is what was **wrong**, what was **missing**, and how each is now proved.

---

## A · What was inspected

| Layer | Scope |
|---|---|
| Database | `db/schema.sql` (74 tables, 69 RLS policies, all SECURITY DEFINER functions), `db/seed.sql`, applied from an empty database and re-applied after every change |
| Backend | all 13 route modules and every `src/lib/` module — tax, ledger, numbering, rbac, sessions, settings, whatsapp, audit, db scoping, PDF |
| Frontend | all 13 pages, the shared component library, i18n dictionary, auth context, API client, RBAC mirror |
| Integrations | WhatsApp queue and sealed auth outbox, PDF generation, background workers |
| Build | typecheck, build, lint (added), test scripts (added) |

Method: read the code, then **attack it against a live database**. Every finding below was
reproduced against a running system before being fixed, and is now covered by a test.

---

## B · Defects found and fixed

### Critical / financial

**1 · A documented refund policy crashed every return.**
Section 17 lists four values for *Refund method*. `ORIGINAL_MODE` and `STORE_CREDIT` are
not members of the `payment_method` enum, and `ORIGINAL_MODE` was cast straight into it —
so a shop that chose the policy the requirements offer got a 500 on every single return.
Each policy is now mapped explicitly; `ORIGINAL_MODE` refunds by the largest non-points
component of the original payment. *(`routes/returns`)*

**2 · Two clerks could refund the same goods twice.**
The code took `FOR UPDATE` on the invoice line, which looks correct and is not: under
READ COMMITTED, when the second transaction is granted the lock it re-evaluates the row's
`WHERE` qualifiers but the `already_returned` **subquery in the SELECT list still runs
against the statement's original snapshot**. Verified: two simultaneous full returns of a
one-unit line both succeeded and two units came back into stock. The lock is now taken in
its own statement first, so the follow-up read gets a snapshot taken after the other
transaction committed. *(`routes/returns`)*

**3 · Cash refunds never left the till.**
A refund paid out of the drawer wrote no till event, so the shift still expected money
that had physically gone. Every close after a cash refund read short by exactly that
amount and the cashier wore the variance. Refunds now post a reversing `CASH_SALE`, and
default to the cashier's own open till rather than requiring the caller to know to pass
one. *(`routes/returns`)*

**4 · The loyalty/discount stacking rule was trivially bypassable.**
Typing a 4% discount was refused; baking the identical 4% into the line rate went
through — same margin, different code path. The discount *ceiling* already measured the
whole giveaway; the stacking rule looked only at the typed figure. Both now use the same
number. *(`routes/billing`)*

### Correctness / integrity

**5 · A void did not restore the batch it drew from.** The sale decremented
`stock_batches.qty_remaining`; the void restored `branch_stock` but not the batch, so the
shelf total and the batch quantities disagreed and expiry tracking lost sight of units
that were physically back. Fixed for voids and for resellable returns.

**6 · Success reported for work not done.** Resolving a stock conflict that did not exist,
was at another branch, or had just been resolved by someone else returned `{ok:true}` and
wrote an audit entry saying a human had dealt with it. Same for warranty-claim updates.
Both now check what they actually changed.

**7 · A malformed `branch_id` from an admin produced a 500** instead of a 400, with no
indication of what was wrong. `writeBranch`/`resolveBranchScope` now validate.

**8 · A warranty claim update was logged as `REFUND`,** making the audit trail read as if
money left the shop every time a claim moved to "sent to vendor".

**9 · A bill of supply printed the words "CGST + SGST".** The supply-type row was
unconditional, so a non-GST document carried GST wording — the exact confusion a bill of
supply exists to prevent. Now GST-only.

**10 · An accountant could record customer payments but could not see who owed money.**
Vendor payables were already theirs; the customer side sat behind `view_customers`, which
excludes the role. New `view_customer_outstanding` permission.

### Found by attacking my own changes (second pass)

**11 · Retiring a product stranded an open draft.** Every path re-priced the draft first,
so a product retired mid-sale made the bill unreadable, uneditable *and* undiscardable —
a dead bill on the counter screen with no way out. Pricing failure is now reported rather
than thrown; the offending lines are named, the draft can be repaired by replacing them,
and it can always be discarded.

**12 · My draft-mutability trigger was the only SECURITY DEFINER function in the schema
without a pinned `search_path`.** The app role could have created a temp table named
`invoices`, shadowed the real one, and had the guard read a fabricated status — turning
the protection for finalised invoices into the thing that waved the delete through. Pinned,
and a test now asserts no definer function is left unpinned.

**13 · The configurable logo accepted a filesystem path,** making a settings field into a
file-read primitive aimed at whatever the API process can reach. Restricted to embedded
`data:` URIs.

---

## C · What was missing and has been built

**Draft bills with review and edit before finalisation** (Sections 11, 12, 62) did not
exist — `POST /invoices` wrote `status: 'FINAL'` directly, and the `DRAFT` enum member the
schema had reserved was unused. Now: `POST/GET/PUT/DELETE /api/billing/drafts` and
`/drafts/:id/finalize`, plus a review screen the cashier turns towards the customer.

The rule that makes it safe: **every read and every edit re-prices on the server.** The
browser never sends a subtotal, a tax figure or a total, and if it does they are ignored —
verified by posting `grand_total: 1` and getting the real figure back. Finalisation bills
the lines **stored in the database**, not anything the client re-sends. A draft holds no
number, moves no stock, and posts nothing to any ledger until it is finalised; once
finalised it is immutable, enforced by a database trigger rather than by application code.

**The printed documents** were one hard-coded PDF function. Now three templates on one
renderer — GST tax invoice, non-GST cash memo, estimate/quotation — modelled on the shop's
physical bills but professionally typeset: automatic pagination with repeated column
headings and "Page X of Y", money columns sized to the figures they actually hold (large
values used to be silently truncated), HSN-wise tax summary, amount in words, bank and UPI
details, declaration, terms, signature. The old totals block also **did not add up**: it
printed a discount line under an already net-of-discount subtotal.

The business identity behind them is configurable per chain or per branch, with an admin
form. JSON settings used to be read-only "view" panels — a setting the requirements call
configurable that could not be configured.

Also added: **lint** (`npm run lint`, clean) and **test** scripts, which did not exist; the
`uitest.mjs` the README claimed and the repository did not contain; and a bundled
Devanagari font, without which Hindi documents rendered as blank boxes.

---

## D · Evidence

```
npm run typecheck   PASS   0 errors
npm run lint        PASS   0 errors, 0 warnings (both workspaces)
npm run build       PASS   API + web
db/schema.sql       PASS   applies to an empty database, 74 tables, 69 policies
db/seed.sql         PASS   ~9,900 invoices

tests/tax-properties.mjs    20/20    ~50,000 generated cases
apps/api/scripts/smoke-test 265/265  per-role, per-branch, RLS asserted in raw SQL
tests/regression.mjs        75/75    every finding above, negatives, concurrency
tests/workflows.mjs         68/68    the ten workflows, cross-checked against the DB
tests/pdf-matrix.mjs        13/13    1 → 50 items, GST/non-GST/estimate, IGST, Hindi, VOID
tests/pdf-geometry.mjs      13/13    6,098 text runs inside the margins, none overlapping
tests/uitest.mjs            76/76    real browser, desktop + 390px
tests/viewports.mjs         35/35    12 widths x 12 routes x both themes
```

Concurrency proved rather than asserted: two simultaneous finalisations of one draft
produce one sale, one stock movement and one payment; eight parallel sales take eight
distinct, gapless invoice numbers; two simultaneous returns cannot refund the same goods
twice.

Consistency proved end to end: for a ₹1,800 bill the invoice row, the payments, the stock
ledger, the sales report and the PDF all carry the same figure.

---

## E · Remaining issues

1. **The CA question is still open.** Whether an inter-branch transfer is intrastate or
   interstate depends on the GSTIN structure. The system supports both; which applies is a
   legal question the requirements themselves flag (§15).
2. **WhatsApp is a queue with a stub transport.** Messages queue, drain, retry and log
   correctly; the Business API credentials are not wired to a real provider.
3. **Background work runs on in-process timers.** Fine for one API instance; move to a job
   queue before running several.
4. **Seed `state_code` values are letters ("MH"), not GST state codes ("27").** Harmless
   for the intrastate/interstate comparison, which is consistent either way, but the
   branch rows should be corrected before real invoicing. The printed state code takes the
   configured business profile when set, so documents are already correct.
5. **Abandoned drafts are never swept.** They hold no stock and no number, but a periodic
   clean-up would keep the list tidy.
6. **Every seeded credential is public** and must be rotated, along with the `erp_app`
   password, before deployment.

---

## F · Production readiness

**READY**, with the caveats in E — none of which is a defect in the code.

The system enforces its rules where they cannot be bypassed: branch isolation and invoice
immutability in the database, financial arithmetic on the server, approvals as single-use
grants rather than client-supplied ids. The remaining items are deployment tasks
(credentials, a WhatsApp provider, a job queue at scale) and one legal question for a CA.

---

## G · Final integration pass

A later pass over the finished application. Everything above still holds; this is
what it added, and what it found.

### Defects found

**14 · Every bill told the customer it was paid.** The WhatsApp message built on
the post-sale screen carried a literal `Status: Paid` line. A sale taken wholly on
credit — the ordinary case for a contractor with an account — went out to that
customer's phone stating the money had been received. The finalize response now
returns a `payment_summary` read back from the `invoice_payments` rows it just
wrote, and the message says *Paid*, *Part paid* or *On credit* with the
outstanding figure. Covered by seven new regression checks, one of which compares
the reported figure against the payment rows in the database rather than against
the response's own arithmetic. *(`routes/billing`, `pages/billing`)*

**15 · The counter screen hid its own scan box on a phone.** The POS layout set
`grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr)` as an inline
style. An inline value cannot be overridden by a media query, so the 340px minimum
applied at every width; at 375px the left column was pushed off the left edge and
`overflow: hidden` on the card clipped it. The item search — the control the whole
screen exists for — was partly invisible, and because a parent clipped it rather
than the page scrolling, no overflow check saw it. Both splits are now classes
that collapse to one column below 1000px.

That second failure is why `tests/viewports.mjs` measures two things. Page-level
`scrollWidth > clientWidth` catches an element that pushes the document sideways.
It does not catch an element pushed *out* of the document and swallowed by a
clipping ancestor, which is strictly worse: the control is not awkward to reach,
it is gone. The suite now asserts both, across 320 → 2560px, on twelve routes, in
both themes.

**16 · A 48px horizontal page scroll on the billing screen at 320px**, from the
same hard-coded column minimum. Fixed by the same change and now asserted.

### What was added

**Global search** (`GET /api/search`, Ctrl/Cmd+K) over invoices, estimates,
customers, vendors, products, SKUs, barcodes and phone numbers. Two properties
matter more than the feature: every query runs inside the caller's RLS-scoped
transaction, so branch isolation is enforced by the database rather than by a
`WHERE` clause in the search route; and each result *type* is gated on the
permission guarding its own screen, so the result list cannot become a read-only
bypass of the role matrix. A branch user passing another branch's `branch_id` gets
their own branch's rows, not a 403 and not the other branch's records. Eleven
smoke-test checks assert this from both sides — the person who should find a
record does, the person who should not, does not — including that LIKE wildcards
typed into the box are treated as data rather than as syntax.

**Keyboard-first billing.** Ctrl/Cmd+K opens search, Ctrl/Cmd+N starts a bill,
Ctrl/Cmd+S saves the current basket as a draft, Escape closes any dialog. Ctrl+S
is wired to the same function as the button, so there is one code path and one set
of guards, and it never finalises: nothing that draws an invoice number, moves
stock or takes money is a keystroke away.

**Barcode scanners work because of what was *not* built.** A USB or Bluetooth
scanner is a keyboard. The item box holds focus, accepts the code, and treats the
Enter the scanner sends as "add this item": a single match goes straight into the
cart, several are left for the cashier to choose from, and a code matching nothing
is reported with a create-product link carrying the code across, so nobody retypes
thirteen digits off a label. No SDK, no driver, no scanner mode.

**One icon set.** The interface mixed colour emoji with geometric Unicode glyphs —
two drawing systems, different baselines, platform-dependent shapes, and emoji
ignore the theme entirely. All of it is now a single monoline SVG set drawn in
`currentColor`.

**Branding finished.** OTP and password-reset messages said "Hardware ERP". They
now use the configured business name, read through the system scope (there is no
session when a reset is requested) and cached for a minute, falling back to the
shipped name if the settings read fails — a settings lookup must never be the
reason a verification code is not sent. Browser titles are `BHAWANI ONE — <page>`.

**Actionable dashboard and useful empty states.** Every tile with a destination
now links to it, filtered; empty states carry the one action that is relevant and
no fabricated figures. The deep links they rely on (`?tab=`, `?invoice=`,
`?customer=`, `?product=`, `?vendor=`, `?quotation=`, `?new=`) were wired at the
same time, so none of them is a link to nowhere.

### Still open

Everything in section E remains true. In particular: WhatsApp is a share link and
a queue with a stub transport, not a delivered message — the post-sale screen now
says so in as many words rather than leaving the cashier to assume the PDF went
with it. Backups are not configured; that is a deployment task, not a code defect.
