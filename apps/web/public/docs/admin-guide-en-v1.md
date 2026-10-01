# BHAWANI ONE — Owner & manager guide (v1)

For owners, branch managers and the accountant. The counter guide covers billing itself.

## Branches and who sees what

* The **branch selector** (top right) decides which branch you are looking at. The Owner
  can also choose **All branches** to see the whole chain — but a sale, purchase,
  adjustment or payment always happens at one branch, so you will be asked to pick one
  before recording anything.
* Staff only ever see their own branch's data. A person who works at two shops is given
  a home branch and the other branch in **Admin → Users → Can also work at**; they switch
  between them from the top bar.
* Branches are added in **Admin → Branches**. The branch code (e.g. `AND`) is printed in
  every document number (`INV-AND/2026-27/00001`) and cannot be changed later. The state
  decides CGST + SGST or IGST.

## Catalog

* **Catalog → New product:** name, SKU, category, brand, HSN (its GST rate must be on file
  under **GST rates**), whether prices include GST, the **base unit** (what stock is
  counted and priced in) and the selling price per base unit.
* **Sale units:** add the units the item is also sold in. Weights, lengths and volumes
  convert automatically — 100 G of a KG product is 0.1 KG. Pack units (BOX, BAG, TIN) need
  their size, e.g. 1 BOX = 100 PCS. Choose the default unit the counter starts with.
* **Barcodes:** scan or type them into the product. An unknown barcode scanned at the
  counter offers **Create product** with the code filled in.
* **Change price** (Owner): the old price is kept in the history; bills already made keep
  their price.
* **Import CSV** checks the whole file first and imports all of it or none of it.

## Stock and purchasing

* **Inventory → Stock** shows on-hand, reserved (held for approved estimates) and
  available stock, low and out-of-stock items, and the reorder level for each item.
* **Reorder & orders:** items at or below their reorder level, with a suggested quantity;
  tick them, choose the supplier and **Raise purchase order**.
* **Purchases → Record purchase:** enter the supplier's bill — bill number and date, each
  item in the unit it was bought in (BAG, BOX…), the rate excluding GST, any discount and
  the GST rate. GST is CGST + SGST for a supplier in your state and IGST otherwise.
  Receiving against a purchase order fills in what is still pending; a partial delivery
  keeps the order open. The same supplier bill number cannot be entered twice.
* **Return goods to supplier** (from a purchase) raises a debit note and reverses the
  input tax credit for those items.
* **Adjustments:** opening stock (with its cost), found stock, counting corrections,
  damage, loss, expiry, own use — each numbered, with a reason. Stock figures are never
  edited directly.
* **Transfers:** create → dispatch (stock leaves the sender) → the receiving branch
  confirms what arrived. A short delivery stays open as a discrepancy until a manager
  decides whether it was a loss or a miscount.
* **Stock take:** start one, enter the physical counts, finish — differences are posted
  as count adjustments.
* **Movement log:** every stock movement with its document and who made it.

## Customers and credit

* **Credit limit** (Owner): a sale that would take a customer over it needs a manager PIN.
* **Statement:** opening balance, every bill, payment and return with a running balance,
  and the closing balance, for any period — CSV, or share the balance on WhatsApp.
* **Receive payment** records a numbered receipt; a payment larger than what is owed is
  refused unless you take the extra as an advance.
* **Outstanding** lists who owes what, aged from the oldest bill still unpaid (payments
  settle the oldest bills first). **Queue reminders** only queues WhatsApp messages; they
  are delivered only if the WhatsApp Business API is configured.

## Suppliers

* Each supplier's **Purchase bills** show what is still due on each, after debit notes and
  payments (payments not tied to a bill settle the oldest bills first).
* **Record payment** (Owner / accountant): against a bill or on account, by bank transfer
  (UTR required), cheque (number required), UPI, card or cash.
* **Payable** shows what is owed to each supplier and who is past their payment terms.

## Estimates

Create an estimate for a customer with units, rates and discounts, validity and terms.
**Approve** confirms it and can hold the stock for a number of days. **Convert to bill**
opens it on the billing screen as a draft to review and finalise; the estimate is marked
billed when that bill is finalised.

## Expenses

Record the date money was spent, the category, amount, how it was paid, who was paid and
the bill or UTR reference. Amounts above the approval limit wait for a manager; nobody
approves their own expense (except the Owner). Petty cash paid from the till is recorded
on the Till screen and appears here.

## Reports

Choose the period at the top (today, this week, this month, last month, this financial
year or a custom range). **Sales**, **Profit** (indicative — cost of goods is the average
cost recorded at each sale), **GST** (outward supplies B2B/B2C, credit notes, HSN summary,
input tax credit, and CSV exports for your accountant), **Registers** (every bill,
purchase, return and payment, exportable), **Stock**, **Cash & tills** (each till's
expected and counted cash) and **Staff**.

## Admin

* **Settings:** chain-wide defaults, some overridable per branch — discount limit,
  negative stock, return window, refund policy, estimate stock holds, and the business
  profile printed on every document.
* **Audit trail:** sign-ins, price and stock changes, discounts and overrides, payments,
  voids, refunds, user and settings changes — who, when and what changed.
* **Compliance:** backup status. "Not configured" means no verified backup exists yet —
  see the operations guide (`npm run backup`, `npm run backup:restore-test`).
