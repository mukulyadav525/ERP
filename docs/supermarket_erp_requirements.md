# Hardware Store ERP — Requirements Document (Final — v6)

**Prepared for:** Multi-branch hardware / plumbing / paint / electronics store chain — Admin (owner) + Branch staff
**Date:** 23 Aug 2026

**v4 — final pass.** Every open decision from v3 was converted into an **admin-configurable setting** with a sensible default, instead of being left as an unresolved question. Nothing in this document is a hard-coded rule the owner is stuck with — where there was doubt, the owner/branch manager gets a toggle in the Admin Control Panel (Section 17) and the system ships with a working default so building isn't blocked on a decision.

**v5 — engineering edge-case review (round 1).** Four real-world failure states: inventory damaged/lost in transit (4.4), two branches selling the last unit of an item while offline (3.5), sales returns vs GST credit-note rules (12.1), tax-inclusive vs exclusive pricing (2.1/3.1). Marked **[ENG-FIX]**.

**v6 — engineering edge-case review (round 2), data-model level.** Nine further issues, several of them genuine contradictions between sections rather than just gaps: missing base-unit-of-measure math (2.2), a static admin-edited cost field contradicting weighted-average costing (2.6/4.8), incomplete till reconciliation missing cash drops/petty expenses (3.3), quotations not actually reserving stock (5), offline billing bypassing credit-limit checks (3.5/6.1), loyalty points + split payments + returns having no defined interaction (11.2/12.1), tax rounding not being specified precisely enough for GST audit (3.1), purchase returns missing the vendor debit-note/ITC-reversal workflow (4.5/8), and price changes mid-cart being undefined (3.x). All nine fixed below, marked **[DATA-FIX]**. This is the complete, consolidated document — supersedes v1–v5.

---

## 0. Core Architecture

- **Single shared database** for the whole chain. Every transactional table (inventory, sales, customers, ledger, employees) carries a `branch_id`.
- **Row-level scoping:** a branch user's session is filtered to `branch_id = their branch` for all normal screens (billing, stock, customers, staff).
- **Admin override:** Admin/Owner can query across branches (e.g. "does Branch B have this item in stock") without switching context, via a dedicated cross-branch inventory lookup screen. Staff cannot see other branches' data.
- **Master data is global, stock is local:** product catalog, HSN codes, vendor list, and pricing rules are shared chain-wide; stock quantity, batch, and shelf location are branch-specific rows against that same catalog ID.
- **Inter-branch stock transfer** is a first-class transaction (4.4), not just a config toggle.
- **Customer identity is chain-wide.** A customer buying from two branches is the *same* customer record, deduplicated on phone number — so credit ledger, loyalty points, and purchase history stay correct no matter which branch they visit. A manual merge tool handles the rare accidental double-registration.

---

## 1. Your Original 17 Requirements — Final Mapping

| # | Requirement | Where it lives now |
|---|---|---|
| 1 | Hindi/English i18n | Section 2 note + applies chain-wide to UI, receipts, WhatsApp messages, training journals |
| 2 | Master catalog + fuzzy search | Section 2 |
| 3 | GST/non-GST billing | Section 3 |
| 4 | WhatsApp invoice delivery | Section 3, Section 14 |
| 5 | Credit ledger | Section 6 |
| 6 | RBAC | Section 7 |
| 7 | Vendor/service provider tracking | Section 4 (Procurement), Section 8 |
| 8 | Multi-branch inventory | Section 4 |
| 9 | Expense management | Section 9 |
| 10 | Employee performance | Section 10 |
| 11 | Admin control panel with feature flags | Section 17 |
| 12 | Birthday WhatsApp greetings | Section 11 |
| 13 | Loyalty points | Section 11 |
| 14 | Sales return/refund | Section 12 |
| 15 | Warranty/replacement | Section 12 |
| 16 | Admin + staff training journals | Section 16 |
| 17 | Cloud backup, phone+OTP restore | Section 7, Section 15 |

---

## 2. Catalog & Product Master

**2.1 Product attributes:** name, category/sub-category (Plumbing, Paint, Electrical, Hand Tools, Power Tools, Hardware/Fasteners, Sanitaryware, etc.), brand, unit of measure, MRP, selling price, purchase price (admin-only, 2.5), HSN code, GST slab (version-dated, 2.6), barcode (optional, multiple per product for size/pack variants), image, min/reorder stock level, and hardware-relevant spec fields (voltage/wattage, pipe diameter/schedule, paint litre size and finish).

**2.2 Units of sale:** pipes/wire sold by length (foot/metre, cut-to-length at billing); fasteners sold loose per piece or by box, with a stored conversion (e.g. 1 box = 100 pcs); paint/adhesives/chemicals sold by tin size (1L/4L/10L/20L); taps/fittings/switches as size/model variants. ⚙ **Setting: "Multi-unit sale per item"** — On by default for pipe/wire/fastener categories, configurable per item.

**[DATA-FIX] 2.2.1 Mandatory base unit of measure.** Every product must declare a single **`base_unit`** (e.g. `PIECE`, `METRE`, `KG`, `LITRE`) — this is not optional, because without it there's no defined way to price 3 loose screws out of a box, or round the tax on 0.5 metres of wire. Every higher-level sale unit (Box, Tin, Reel, Dozen) is defined as an integer or decimal **multiple of `base_unit`** (e.g. 1 Box = 100 × PIECE, 1 Reel = 90 × METRE), never as an independent price. Selling price and MRP are stored per `base_unit`; the billing screen shows/accepts whichever sale unit is convenient for the cashier (box, piece, loose length) but internally converts to `base_unit` quantity before computing the line amount and tax — so a 3-piece sale out of a 100-piece box always evaluates as 3 × (box_price ÷ 100), not as a separately-typed price. ⚙ **Setting: "Fractional unit rounding"** — default **round to 2 decimal places at the line-item level**, ties into the tax-rounding rule in 3.1.1.

**2.3 Paint colour tinting:** a base-shade + tint-formula note recorded per sale so a customer's exact colour can be reproduced later. ⚙ **Setting: "Enable tinting records"** — **On by default** (it's a lightweight note field, not a big build item, so it ships in v1 rather than being deferred).

**2.4 Combo/bundle products:** trade "kits" (plumbing repair kit, tool set). ⚙ **Setting: "Enable bundles"** — Off by default, admin turns on when needed.

**2.5 Branch-level pricing override:** ⚙ **Setting: "Allow branch price override"** — **Off by default** (one price chain-wide, simplest to run); Owner can flip it on per branch if local pricing (e.g. rent-driven) is needed, and per-branch overrides always fall back to the chain price if unset.

**2.6 Purchase price vs selling price (admin-only cost visibility):**
- **Selling price** — visible to all staff for billing, editable by Admin (or Branch Manager if 2.5 override is on).
- Field-level RBAC on all cost data, not screen-level: staff-visible inventory reports and exports must mask cost/margin columns.
- Admin dashboard shows computed margin (₹ and %) per item, category, and branch.
- ⚙ **Setting: "Branch Manager cost visibility"** — **Hidden by default** (Owner-only chain-wide); Owner can grant a specific Branch Manager visibility into their own branch's cost data if desired.
- **[DATA-FIX] Purchase price is NOT a static admin-edited field — see 4.8.1.** Earlier drafts of this document treated `purchase_price` as a manually-entered catalog field, which directly contradicts the weighted-average costing model in Section 4.8: under weighted-average, cost is a moving number recalculated on every stock-in, not something an admin types once and forgets. What Admin actually edits is a **reference/expected purchase price** (used for PO drafting and quick margin estimates before a GRN is logged); the real cost figure used for margin and valuation reporting is the system-calculated `weighted_avg_cost` from 4.8.1, and the two are shown side by side on the admin dashboard so a large gap between "expected" and "actual weighted cost" is visible at a glance.

**2.7 Tax-rate versioning:** GST rate is stored as (rate, effective-from-date), not a single overwritable field, so past invoices keep the rate that applied on their billing date even after a government rate change.

**[ENG-FIX] 2.8 Tax-inclusive vs tax-exclusive pricing.** Retail counter sales (loose items, walk-in customers) are typically priced **tax-inclusive** (the sticker/selling price already includes GST), while B2B/contractor quotations (Section 5) are typically quoted **tax-exclusive** (GST added on top of the quoted rate) — mixing these up silently is a common and costly billing bug. ⚙ **Setting: "Default item price type"** — chosen per item at the catalog level (**Tax-Inclusive** default for retail-catalog items, **Tax-Exclusive** default for items primarily sold via quotations), with an explicit override available per line item at billing time and per quotation. The billing engine must show the cashier which mode is active on a given line so it's never ambiguous whether the displayed price already contains GST.

---

## 3. Billing / POS

**3.1 Mixed-tax invoice:** a single bill supports GST and non-GST line items together, tax computed per item.

**[DATA-FIX] 3.1.1 GST rounding algorithm.** Left unspecified, this causes real audit friction: per-item tax rounded to 2 decimals can sum to a figure ₹1–2 off from tax computed on the invoice total, which a GST auditor flags during GSTR-1 matching. The rule, stated precisely: **tax is computed on each line item's taxable value (post any line-level discount), each line's CGST/SGST/IGST rounded to 2 decimal places using standard half-up rounding (≥ 0.50 rounds up), and the invoice total tax is the sum of the already-rounded line taxes** — not a separate rounding of the invoice grand total. This matches how GST returns expect line-level tax to reconcile against invoice-level tax, and it must be the same rule everywhere tax is computed (retail billing 3.1, quotations 5, credit notes 12.1.1) so nothing produces a mismatched total.

**3.2 Payment modes:** cash, UPI, card, credit (ledger); split payment supported (part cash + part UPI).

**3.3 Till/register-level reconciliation:** cash reconciliation is scoped to counter + cashier + shift, not just branch/day, so a branch running multiple simultaneous counters can identify exactly which till is short at close.

**[DATA-FIX] 3.3.1 Till session must model mid-shift cash movements, not just open/close.** A till reconciled only as "opening count vs closing count vs cash sales" will fail to balance the moment cash leaves the drawer for anything other than change — which happens constantly (owner cash pickups, petty payouts). The Till Session model needs explicit ledger event types:
- **`OPENING_FLOAT`** — cash placed in the drawer at shift start.
- **`CASH_SALE`** — from billing (3.2).
- **`CASH_DROP`** — cash moved from till to safe/owner mid-shift, timestamped and requiring a manager/owner acknowledgment.
- **`PETTY_EXPENSE_PAYOUT`** — small cash expenses paid directly from the till (linked to Section 9's expense categories, not left untracked).

`Expected Drawer Cash = Opening Float + Cash Sales − Cash Drops − Petty Expense Payouts`

Reconciliation at shift close compares this expected figure against the physically counted drawer amount, and only the variance between the two is flagged — not the raw difference between opening float and closing count, which would falsely show the till "short" by the amount of every legitimate cash drop.

**3.4 Discounts & promotions:** manual discount, scheme discounts, coupon codes. ⚙ **Setting: "Staff discount limit"** — default **5% without Admin PIN override**; Owner sets the % per role.

**3.5 Offline resilience:** billing keeps working during internet outages, queuing WhatsApp sends and cloud sync for reconnection. **Required from Phase 1** — not deferrable, since a retail counter can't stop billing when the internet drops.

**[ENG-FIX] 3.5.1 Offline stock-sync conflict rule.** If Branch A goes offline and sells the last units of an item while Branch B (or an admin cross-branch action) sells the same units before A reconnects, a conflict surfaces on sync. ⚙ **Setting: "Offline sync conflict rule"** — default: **first transaction to reach the cloud (by server-received timestamp, not device clock) wins and decrements stock normally; every later-arriving transaction against the same now-insufficient stock is auto-flagged as a `STOCK_CONFLICT`**, is *not* silently allowed to oversell, and is routed to the branch's queue for the cashier/manager to resolve with the customer (offer a substitute, backorder, or apply the negative-stock override from 3.8 with a PIN). The flagged sale itself is **not voided automatically** — voiding a completed sale without staff/customer awareness is worse than a stock discrepancy — it's surfaced for a human decision. Owner can instead set this to "block and require manual reconciliation for every conflict" if they'd rather never auto-resolve.

**3.6 Invoice numbering:** sequential, no gaps (GST requirement), printed and WhatsApp PDF.

**3.7 Hardware:** thermal printer, barcode scanner (when barcode exists), cash drawer trigger, length/weight-measure support for cut-to-length pipe/wire and paint tins.

**3.8 Negative stock:** ⚙ **Setting: "Allow negative stock"** — **Off by default** (billing hard-blocks if system stock is zero); Owner/Branch Manager can override per-sale with a PIN if they trust the physical stock over the system count.

**3.9 Barcode requirement:** ⚙ **Setting: "Require barcode at billing"** — **Off by default**, per your original "no barcode needed" requirement — fuzzy-search catalog lookup remains the default path, barcode is a speed option when present, never mandatory.

**[DATA-FIX] 3.10 Price revision during an open cart.** Undefined until now: if Admin changes a chain-wide price (2.5) while a cashier at another branch has that exact item already sitting in an open, unbilled cart, does the cart price update live or stay as scanned? The rule: **line-item prices lock to the catalog price at the moment of scan/selection into the cart and do not silently change for the rest of that billing session**, even if Admin edits the catalog price mid-session — a price jumping under a customer's nose mid-transaction is worse than a few minutes of staleness. An explicit "refresh cart" action (not automatic) re-evaluates every line against the current catalog price, for the rare case a cashier needs to pull in a just-corrected price before finalizing the bill.

---

## 4. Inventory & Procurement

**4.1 Stock ledger:** every movement (purchase, sale, transfer, return, write-off, count adjustment) recorded with reason and timestamp.

**4.2 Shelf-life/batch tracking:** relevant for paint, adhesives, sealants, chemicals, batteries. ⚙ **Setting: "Enable batch tracking"** — On by default for categories flagged shelf-life-sensitive, Off for the rest (fasteners, tools, fittings don't need it).

**4.3 Low-stock/reorder alerts:** per-branch reorder threshold with auto-suggested purchase orders when stock crosses the minimum.

**4.4 Inter-branch stock transfer:** transfer-request → dispatch → receive workflow, stock ledger updates both branches, Admin sees pending/in-transit transfers chain-wide.

**[ENG-FIX] 4.4.1 Transfer discrepancy state.** The dispatch → receive workflow needs an explicit third outcome beyond "received in full": a **`TRANSFER_DISCREPANCY`** state, raised when the quantity received at Branch B doesn't match what Branch A dispatched. On discrepancy, the system: (a) does **not** silently adjust either branch's stock ledger to force a match, (b) records the variance against the specific transfer record (and driver/courier reference if captured), (c) holds the shortfall as a pending reconciliation item routed to Admin, who resolves it as either a write-off (4.7, against whichever branch is deemed responsible) or a correction if it was a counting error. This keeps ledger totals traceable instead of quietly breaking when transit loss happens — which it will, eventually.

**4.5 Procurement:** PO → goods receipt note (GRN) against vendor → auto stock-in → vendor bill/payment against the ledger (Section 8).

**[DATA-FIX] 4.5.1 Purchase return / vendor debit note workflow.** "Purchase returns handled separately from sales returns" wasn't specified beyond that line, and the compliance requirement is real: goods returned to a vendor after ITC (Input Tax Credit) was already claimed on their GRN needs to reverse that ITC, or the accountant can't reconcile GSTR-3B/GSTR-2B against what the vendor reports. The full workflow: **GRN reference selected → return quantity/reason recorded → Vendor Debit Note generated, with its own sequential numbering (separate series from sales invoices and sales credit notes), referencing the original GRN → stock ledger debited (removing the returned quantity from that branch's stock, at that GRN's cost) → vendor payable balance reduced by the debit note value (Section 8).** The debit note is what gets reported for ITC reversal — a purchase-return record alone, without a formal debit note, is not sufficient for GST compliance.

**4.6 Physical stock audit:** periodic stock-take with variance report (system vs counted) for shrinkage/theft control.

**4.7 Wastage/damage write-off:** removes damaged/unsellable stock with a reason code, distinct from a sales return.

**4.8 Stock valuation method:** ⚙ **Setting: "Valuation method"** — **Weighted-average by default** (simpler to run when the same item is restocked at different prices from different vendors); Owner can switch to FIFO if preferred. This feeds the margin calculation in 2.6.

**[DATA-FIX] 4.8.1 `weighted_avg_cost` as a derived, per-branch field.** Since stock (and its cost) is branch-local (Section 0), cost is recalculated **per branch** on every GRN (4.5) stock-in event, not as one chain-wide number:

`new_weighted_avg_cost = ((current_stock_qty × current_weighted_avg_cost) + (grn_qty × grn_rate)) / (current_stock_qty + grn_qty)`

This field is never directly editable — it only changes through a GRN stock-in event, an inter-branch transfer-in (carrying the sending branch's cost), or a stock-take correction (4.6). If the Owner switches the valuation method setting from weighted-average to FIFO, the system needs a defined cutover rule: existing stock keeps its last weighted-average cost as its FIFO layer cost at the moment of the switch, rather than trying to reconstruct historical FIFO layers retroactively.

**4.9 Multi-unit stock, serial/lot tracking, stock reservation, internal barcode/label printing, consignment stock, multi-location-within-branch, stock aging/dead-stock reports, ABC analysis, bulk Excel import, vendor-item mapping:** all as previously scoped — bulk import and reorder logic ship Phase 1; ABC analysis and ultra-granular multi-location move to Phase 3+ as usage data accumulates.

---

## 5. Quotations & B2B/Contractor Pricing

⚙ **Setting: "Enable quotations module"** — **Off in Phase 1, On from Phase 2** (feature-flagged, not a hard architectural decision — Admin turns it on chain-wide or per branch once ready).

- **Quotation module:** generate a quote (with/without GST) that converts to an invoice later.
- **B2B/contractor customer type:** flagged trade customer with its own price list/discount tier, separate from Section 6's general credit customers.
- **Delivery challan:** a delivery-note document distinct from a tax invoice, for site deliveries ahead of final billing.

**[DATA-FIX] 5.1 Quotation stock reservation.** A quotation that never touches stock creates a real failure mode: a contractor is quoted 50 bags of in-stock cement, walk-in customers buy them out before the contractor returns to pay, and conversion to invoice fails at the counter with the contractor standing there. ⚙ **Setting: "Quotation stock reservation"** — **Off by default** (quotations remain a pure price estimate, no stock impact, matching the original design); Owner can turn it **On, with a configurable hold period in days**, in which case *approving* a quote (not just generating one) moves the quoted quantity into a **`RESERVED`** stock state — visible to billing as "reserved, not sellable to a walk-in" but not yet a tax invoice — automatically released back to available stock if the hold period lapses without conversion. This is a per-quotation choice too: Admin/Manager can reserve some quotes (a confirmed order awaiting pickup) and leave others as pure estimates.

---

## 6. Credit & Customer Ledger

**6.1 Credit limit enforcement:** credit-allowed flag paired with an actual limit value; billing warns/blocks when exceeded (limit set per customer by Admin).

**[DATA-FIX] 6.1.1 Offline credit enforcement.** Section 3.5 requires billing to keep working offline, but a fully offline till can't confirm a customer's real-time credit balance against the central server — a customer already at 96% of their limit could be pushed well over it at an offline branch with no way to know. ⚙ **Setting: "Allow offline credit sales"** — default: **credit sales capped at 50% of the customer's last-known-cached available limit while offline** (the device syncs and caches each customer's limit/balance whenever it's last online, and offline credit sales draw down against that cached figure conservatively); Owner can instead set this to **hard-block all credit sales while offline** (cash/UPI only until reconnection) for a stricter policy, with a Manager-PIN override available either way for a judgment call at the counter. On reconnection, actual usage syncs and any resulting over-limit is flagged to Admin rather than silently accepted.

**6.2 Due reminders:** automated WhatsApp/SMS reminders tied to due dates.

**6.3 Payment collection & reconciliation:** partial payments, receipts, ledger history — chain-wide per customer (Section 0 identity dedup).

---

## 7. Access, Auth & Security

**7.1 Role matrix:**
- **Owner/Super Admin** — all branches, financials, catalog, user management.
- **Branch Manager** — full control within own branch (billing, stock, staff, local reports), no catalog/pricing edit by default.
- **Cashier/Sales Staff** — billing, customer lookup, limited discount authority (3.4).
- **Inventory/Stock Staff** — stock-in, transfer, stock-take, no billing/financial reports.
- **Accountant** (optional role) — financial reports only, no stock/catalog edit.
- Cost-price/margin visibility is a field-level permission layered on this matrix (2.6).

**7.2 Authentication:** ⚙ **Setting: "Login method by role"** — default: **Google OAuth for Owner/Admin and Branch Manager**, **phone number + OTP with a quick-access PIN for Cashier/Inventory staff** (shop-floor staff often don't use Google day-to-day, and a PIN avoids re-doing full login every shift). Owner can require Google for all roles if preferred. Session timeout and device-level login audit apply to every role.

**7.3 Audit trail:** every sensitive action (price change, discount override, stock adjustment, refund) logged with who/when.

**7.4 Baseline data security:** encryption at rest and in transit; backups carry the same field-level masking as live data (a backup file must not leak purchase price). ⚙ **Setting: "OTP/PIN policy"** — default **OTP expiry 5 minutes, PIN length 4–6 digits, 3 failed attempts before lockout**; Owner can adjust in Admin Settings.

---

## 8. Vendor / Procurement Management

Vendor GST details, payment terms, vendor-wise purchase history, outstanding-payable ledger (mirror of the customer credit ledger), vendor performance analytics (on-time delivery, price trends) with monthly graphical reports.

---

## 9. Expenses

Expense categories (rent, salaries, electricity, maintenance, marketing, misc), branch-wise entry with receipt attachments, admin approval workflow above a configurable threshold, branch-wise and month-over-month comparison, expense-vs-revenue ratio per branch.

---

## 10. HR / Staff

**10.1 Attendance:** ⚙ **Setting: "Attendance method"** — default **in-app check-in/out** (no extra hardware cost); Owner can switch to biometric-device integration or manual manager entry per branch if preferred.

**10.2 Sales attribution:** each bill optionally tags the cashier/salesperson for commission/incentive calculation.

**10.3 Payroll:** ⚙ **Setting: "Enable payroll module"** — **Off in Phase 1**, feature-flagged on when the Owner wants it; a simple salary register tied to attendance when enabled.

**10.4 Shift/leave management:** shift assignment and leave requests across branches.

---

## 11. CRM & Marketing

**11.1** Birthday/anniversary automated WhatsApp greetings (optional, discount-linked); festival/seasonal offer broadcasts to segmented customer lists; customer purchase history lookup at billing (chain-wide, Section 0).

**11.2 Loyalty points:** earn rate, redemption rules, point expiry. ⚙ **Setting: "Allow loyalty + discount stacking"** — **Off by default** (a customer applies either loyalty points or a manual/scheme discount, not both, to keep margin predictable); Owner can turn stacking on.

**[DATA-FIX] 11.2.1 Return refund hierarchy when loyalty points and split payment were involved.** A ₹1,000 sale paid as ₹200 loyalty points + ₹800 cash, returned the next day, cannot just refund ₹1,000 cash — that both drains store cash unnecessarily and opens a points-to-cash fraud path (redeem points, return item, pocket cash). The return workflow (12.1) applies this fixed order automatically, non-configurable since it's a fraud-prevention rule rather than a business preference:
1. **Points earned** on the original purchase (if any) are immediately revoked from the customer's balance.
2. **Points redeemed** on the original purchase are restored to the customer's point balance first — not converted to cash.
3. Only the **remaining cash/UPI/card portion** of the original payment is refunded, via the method chosen under Section 12.1's refund-method setting.
This applies per line item on a partial return too — the points/cash split is prorated against whichever items are actually being returned, not the whole invoice.

---

## 12. Returns, Refunds & Warranty

**12.1 Sales return:** full/partial return against the original invoice, auto stock-in (resellable) or write-off (damaged). ⚙ **Setting: "Refund method"** — default **Admin's choice per transaction** (cash, original payment mode, or store credit, decided case-by-case); Owner can lock it to a single policy chain-wide instead if preferred.

**[ENG-FIX] 12.1.1 GST credit note requirement.** Under Indian GST rules, a sales return against a GST invoice cannot just be an internal refund record — it must generate a formal **Credit Note**, linked directly to the original invoice number (and its IRN, if e-invoicing applies once turnover crosses the threshold noted in 15). The credit note carries its own sequential numbering (separate series from sales invoices), reduces the reported GSTR-1 outward-supply value for the period it's issued in, and is what actually gets reported to GST — not the return record alone. This applies only to GST-invoiced sales; a non-GST retail return is a simple refund with no credit note needed. Inter-branch stock transfers additionally need to distinguish **intrastate vs interstate** movement, since interstate transfer between branches under the same GSTIN structure has its own GST treatment — flagging this as a compliance detail to confirm with a CA before the transfer/procurement modules (4.4, 4.5) are finalized, since the exact treatment depends on whether branches share one GSTIN or hold separate state registrations.

**12.2 Warranty:** electronics, power tools, motors, pumps, and some plumbing fittings carry manufacturer warranties. Warranty period per product/category, serial/IMEI captured at sale for serialized electronics, claims linked to the original invoice, outcome (repair/replace/refund) recorded with vendor cross-reference.

**12.3 Return/exchange window:** ⚙ **Setting: "Return window (days)"** — default **7 days general merchandise**; Owner can set a different window per category (e.g. a longer window for electricals still within manufacturer warranty terms, which route to 12.2 instead once outside the return window).

---

## 13. Reporting & Analytics

Daily/weekly/monthly sales dashboard (branch-wise + consolidated); best-selling/slow-moving/dead-stock reports; profit margin report by product/category; GST summary reports (GSTR-1 outward supply data); branch comparison dashboard; customer-wise and vendor-wise outstanding reports.

---

## 14. Accounting, Payments & Compliance Add-ons

Tally (or similar) sync/export for CA bookkeeping; e-way bill generation when goods movement crosses the government value threshold; dynamic UPI QR at billing with gateway-settlement reconciliation; RMA workflow for vendor-side warranty returns; daily admin WhatsApp/email digest (sales, low stock, dues, pending transfers); print template configuration (thermal vs A4, branch letterhead/GSTIN); formal dated export bundle for CA/auditor use.

---

## 15. Compliance & Data

Sequential invoice numbering, mandatory HSN, tax-rate versioning (2.7), e-invoicing readiness if turnover crosses the applicable threshold; GST credit notes on sales returns with their own sequential numbering, linked to the original invoice/IRN (12.1.1); defined backup frequency with a documented disaster-recovery/restore test; customer personal-data export/view restricted to Admin (RBAC).

**[ENG-FIX] Flag for CA/tax-consultant sign-off before finalizing Sections 4.4/4.5:** whether inter-branch stock transfer is treated as an intrastate or interstate GST movement depends on whether branches operate under one GSTIN or separate state registrations — this document specifies the *system* needs to support both possibilities (a transfer document type flag), but which treatment actually applies is a legal/accounting question, not an engineering one, and should be confirmed with your CA before the transfer module is locked in.

---

## 16. Training & Documentation

Separate Admin Journal (feature/config reference for the Owner) and App Training Journal (day-to-day operation guide for staff), both versioned so they stay in sync as features change and the Hindi/English toggle applies to both.

---

## 17. Admin Control Panel — Consolidated Settings

Every ⚙ setting referenced above, in one place, is what the Admin Control Panel (your original requirement #11) actually needs to expose. Defaults are chosen to be the simplest safe starting point; every one is changeable chain-wide or per-branch without a code change.

| Setting | Default | Owner can change to |
|---|---|---|
| Multi-unit sale per item | On (pipe/wire/fastener categories) | Per-item override |
| Enable tinting records | On | Off |
| Enable bundles | Off | On |
| Allow branch price override | Off | On, per branch |
| Branch Manager cost visibility | Hidden | Visible for their own branch |
| Staff discount limit | 5% without Admin PIN | Any %, per role |
| Allow negative stock | Off (hard block) | On, with PIN override |
| Require barcode at billing | Off | On (not recommended — defeats fuzzy search) |
| Enable batch tracking | On for shelf-life categories | Per category |
| Valuation method | Weighted-average | FIFO |
| Enable quotations module | Off (Phase 1) | On (Phase 2+) |
| Login method by role | Google (Admin/Manager), Phone+PIN (staff) | Google for all roles |
| OTP/PIN policy | 5-min OTP, 4–6 digit PIN, 3-try lockout | Adjustable |
| Attendance method | In-app check-in | Biometric / manual |
| Enable payroll module | Off (Phase 1) | On (Phase 2+) |
| Allow loyalty + discount stacking | Off | On |
| Refund method | Admin's choice per transaction | Locked single policy |
| Return window (days) | 7 (general) | Per category |
| Offline sync conflict rule | First-to-cloud wins, later ones flagged for manual resolve | Block all conflicts, require manual reconciliation |
| Default item price type | Tax-Inclusive (retail catalog), Tax-Exclusive (quotation items) | Per item / per quotation override |
| Fractional unit rounding | Round to 2 decimals at line-item level | — (fixed, ties to GST rounding rule) |
| Quotation stock reservation | Off (pure estimate, no stock hold) | On, with configurable hold-period days |
| Allow offline credit sales | Capped at 50% of last-cached available limit | Hard-block credit sales while offline |

**Non-configurable rules (fixed, not toggles — these are correctness/compliance rules, not business preferences):** base-unit-of-measure pricing (2.2.1), weighted-average cost as a derived field (4.8.1), till cash-movement ledger events (3.3.1), GST rounding algorithm (3.1.1), loyalty-points return-refund hierarchy (11.2.1), vendor debit note on purchase returns (4.5.1), and cart price-lock behavior (3.10).

Feature flags additionally allow enabling/disabling entire modules per branch (e.g. a small branch might not need the quotations module even after it's chain-enabled).

---

## Build Phasing

- **Phase 1 (Core — open first branch):** Catalog + fuzzy search with multi-unit sale and tax-rate versioning, purchase price/margin privacy, Billing (GST/non-GST, till-level reconciliation, offline resilience), Inventory with reorder logic and batch tracking, Customer ledger + chain-wide identity, RBAC + auth (Google + phone/PIN), WhatsApp invoice, Cloud backup, baseline security, Admin Control Panel with the settings table above.
- **Phase 2 (Multi-branch operations):** Inter-branch transfer, cross-branch inventory lookup, Procurement/PO/GRN, Expense management, Quotations & B2B pricing.
- **Phase 3 (Growth/retention):** Loyalty points, marketing messaging, employee performance + attendance, warranty tracking, stock audit workflow, return/exchange policy enforcement, payroll.
- **Phase 4 (Reporting maturity):** Full analytics suite, GST filing exports, Tally sync, e-way bill generation, vendor/customer analytics dashboards, ABC analysis.

---

*This document is now considered complete for the requirements-gathering stage, including two rounds of engineering-level edge cases: round 1 covered transfer discrepancies, offline sync conflicts, GST credit notes, and tax-inclusive/exclusive pricing; round 2 covered data-model-level contradictions — base-unit-of-measure math, weighted-average costing as a derived (not static) field, till cash-movement events, quotation stock reservation, offline credit-limit enforcement, loyalty-points refund fraud prevention, precise GST rounding, vendor debit notes for purchase returns, and cart price-lock behavior. The one item left genuinely outside this document's scope is the CA/tax-consultant confirmation on interstate-vs-intrastate branch transfer treatment (Section 15) — everything else is either specified as a fixed correctness rule or turned into an admin-configurable setting. Next natural step: database schema design (turning Sections 0–17 into tables/relationships) or wireframes for the core screens (billing counter, admin dashboard, catalog management).*
