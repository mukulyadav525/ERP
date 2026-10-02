# BHAWANI ONE — Counter staff guide (v1)

For cashiers and sales staff. Everything here happens on the **Billing** screen unless
it says otherwise.

## Start of the day

1. Sign in with your phone number and PIN.
2. The branch you are working at shows at the top right. If you work at more than one
   branch, choose today's branch there.
3. **Billing → Till → Open till.** Count the cash in the drawer and enter it as the
   opening cash. Cash on every bill is then expected in this drawer.

## Making a bill

* The item search is ready as soon as the screen opens. **Scan a barcode**, or type part
  of the name (`cpvc elb`, `putty`) or the SKU.
* **↓ / ↑** move through the list, **Enter** adds the highlighted item. After each item
  the cursor goes back to the search, so you can scan the next one straight away.
  Press **/** to jump back to the search from anywhere.
* Each line has a **Unit**: PCS, BOX, KG, 100 G, METRE… The rate shown is per that unit.
  To sell 300 g of putty that is priced per KG, choose **100 G** and enter **3**, or
  choose **KG** and enter **0.3**. The stock taken is worked out for you.
* Change the quantity, the rate per unit, or give a discount in rupees on the line.
  A discount above your limit needs a manager's PIN before the bill can be finished.
* Removed a line by mistake? Press **Undo** in the message that appears.
* With a regular customer on the bill, each item shows what it was **last sold to them
  at**, so their usual rate is in front of you.
* The bill you are making is saved as you go. If the page is refreshed or closed, or you
  leave to create a product, Billing offers **Continue this bill** when you come back.
* **Customer:** leave empty for a walk-in. Type a name, phone or GSTIN to find a customer;
  if they are new, choose **Add new customer** — you do not leave the bill.
* **GST invoice / Non-GST** is chosen at the top of the bill panel.
* **More details** holds the buyer's order number, challan, vehicle number, due date and
  place of delivery, for bills that need them.

## Taking payment

* One payment line follows the bill total automatically.
* **Split payment** adds another method — e.g. part cash, part UPI. The bill can only be
  finished when the payments add up to the total exactly.
* For **Bank transfer**, the UTR reference is required. For UPI and card it is optional.
* **Credit (on account)** is only possible for a customer who has a credit limit.
* **Cash received** works out the change to give back — tap **Exact** or the note the
  customer handed over (₹500, ₹2,000…) instead of typing it.

## Finishing

* **Review bill** (or **Ctrl + S**) saves the bill as a draft and shows the server's
  figures — this is what will be billed. Nothing is billed yet: no invoice number, no
  stock taken.
* **Finalise bill** gives the invoice number, takes the stock and records the payment.
  After this the bill cannot be edited — a mistake is corrected with a return or a void.
* **Complete sale** does both in one step for a simple counter sale.
* After the sale: **Print**, **Download PDF**, or **Share on WhatsApp** (opens WhatsApp
  with the bill details for you to send; it does not send anything by itself and cannot
  attach the PDF).

## Repeat customers

* **Bill again** on any old bill (Billing → Invoices) starts a new bill with the same
  items and customer at today's prices.
* **New bill** on a customer's page starts a bill with that customer already chosen.
* **Duplicate** on an estimate makes a new estimate from it.

## Drafts and estimates

* A reviewed bill that was not finalised stays under **Drafts**; **Resume** carries on.
* An estimate a customer has confirmed is opened from **Estimates → Convert to bill**; it
  arrives here as a draft to review, take payment and finalise.

## If the internet goes down

Keep billing. A bill finished while the connection is down is saved on this computer and
uploads by itself when the connection returns — a yellow notice shows how many are
waiting (**Try uploading now** sends them at once). Each carries its own reference, so
nothing is billed twice, and it is kept until the server has accepted it. Print those
bills after they have synced.

If the server **refuses** one (for example, the customer was deactivated meanwhile), a
red notice lists it: the goods have gone, so make that bill again, then press **Billed
again — remove**.

## Returns

**Returns → New return** → find the bill → enter how many of each item came back, in the
unit it was sold in → choose resellable or damaged → reason → how the money goes back.
A GST bill gives a credit note with its own number and PDF. Items past their return
window need a manager's PIN.

## Customer payments

**Customers →** open the customer → **Receive payment** → amount, method (and the UTR or
cheque number) → **Record receipt**. Cash receipts go into your till.

## End of the day

**Billing → Till:** count the drawer and enter the actual cash. The screen shows the
expected cash (opening + cash sales + cash received − cash drops − petty cash) and any
difference before you close. **Cash drop** (cash taken to the safe) needs a manager's PIN.

## Keyboard

| Keys | Does |
|---|---|
| Ctrl/Cmd + K | Search anything — bills, customers, products, receipts |
| Ctrl/Cmd + N | New bill |
| Ctrl/Cmd + S | Save and review the bill |
| / | Back to the item search |
| ↑ ↓ Enter Esc | Move, choose, close in any list |
