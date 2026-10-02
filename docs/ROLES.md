# Who can do what — BHAWANI ONE

Five roles. The server enforces every rule below (the database too, for branch data); the
screens only hide what a role cannot use. Generated from `apps/api/src/lib/rbac.ts`.

**Branch rule:** everyone except the Owner works only in their own branch (plus any branch
the Owner adds under *Can also work at*). The Owner can see all branches, but every sale,
purchase or payment is made at one chosen branch.


## Screens you can open

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| Billing | ✓ | ✓ | ✓ |  |  |
| Catalog | ✓ | ✓ | ✓ | ✓ |  |
| Inventory | ✓ | ✓ |  | ✓ |  |
| Estimates | ✓ | ✓ | ✓ |  |  |
| Returns | ✓ | ✓ | ✓ |  | ✓ |
| Customers | ✓ | ✓ | ✓ |  |  |
| Vendors / suppliers | ✓ | ✓ |  | ✓ | ✓ |
| Expenses | ✓ | ✓ |  |  | ✓ |
| Staff page | ✓ | ✓ |  |  |  |
| Analytics / reports | ✓ | ✓ |  |  | ✓ |
| Admin | ✓ |  |  |  |  |

## Selling

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Make and finalise bills | ✓ | ✓ | ✓ |  |  |
| Void a finalised bill | ✓ | ✓ |  |  |  |
| Approve a discount above the limit (manager PIN) | ✓ | ✓ |  |  |  |
| Open / close a till, cash drop request | ✓ | ✓ | ✓ |  |  |
| Approve a cash drop | ✓ | ✓ |  |  |  |
| Resolve offline-sale stock conflicts | ✓ | ✓ |  |  |  |
| Take a return, issue a credit note | ✓ | ✓ | ✓ |  |  |
| Warranty claims | ✓ | ✓ | ✓ |  |  |
| Make and edit estimates | ✓ | ✓ | ✓ |  |  |
| Approve / cancel estimates, hold stock | ✓ | ✓ |  |  |  |
| Turn an estimate into a bill | ✓ | ✓ | ✓ |  |  |

## Customers

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Add and edit customers | ✓ | ✓ | ✓ |  |  |
| Set a credit limit | ✓ |  |  |  |  |
| Record a customer payment | ✓ | ✓ | ✓ |  | ✓ |
| Cancel a receipt recorded by mistake | ✓ | ✓ |  |  | ✓ |
| See who owes what | ✓ | ✓ | ✓ |  | ✓ |
| Merge duplicate customers | ✓ |  |  |  |  |
| Export customer contact data | ✓ |  |  |  |  |
| WhatsApp campaigns and greetings | ✓ | ✓ |  |  |  |
| Adjust loyalty points | ✓ |  |  |  |  |

## Catalog and stock

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Add and edit products, units, barcodes | ✓ | ✓ |  |  |  |
| Change selling prices | ✓ |  |  |  |  |
| Categories, brands, units | ✓ | ✓ |  | ✓ |  |
| See cost prices and margins | ✓ |  |  |  |  |
| Raise purchase orders | ✓ | ✓ |  | ✓ |  |
| Record supplier bills (goods in), reorder levels | ✓ | ✓ |  | ✓ |  |
| Return goods to a supplier | ✓ | ✓ |  | ✓ |  |
| Send stock to another branch | ✓ | ✓ |  | ✓ |  |
| Receive a transfer | ✓ | ✓ |  | ✓ |  |
| Decide a short transfer | ✓ |  |  |  |  |
| Look up stock at other branches | ✓ |  |  |  |  |
| Stock take | ✓ | ✓ |  | ✓ |  |
| Stock adjustments (opening, damage, found…) | ✓ | ✓ |  |  |  |
| Write-offs | ✓ | ✓ |  |  |  |

## Suppliers and money

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Add and edit suppliers | ✓ | ✓ |  |  |  |
| Pay suppliers, cancel a wrong supplier payment | ✓ |  |  |  | ✓ |
| Record expenses, edit/rename expense categories | ✓ | ✓ |  |  | ✓ |
| Approve / reject expenses | ✓ | ✓ |  |  |  |
| Profit, registers, cash | ✓ | ✓ |  |  | ✓ |
| GST reports | ✓ |  |  |  | ✓ |
| Accounting exports | ✓ |  |  |  | ✓ |
| All-branch reports | ✓ |  |  |  |  |

## Staff

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Add / edit staff, shifts, roster | ✓ | ✓ |  |  |  |
| Check in / out, request leave (My account) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Approve leave | ✓ | ✓ |  |  |  |
| Payroll | ✓ |  |  |  |  |

## System

| | Owner | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Users: roles, branches, passwords | ✓ |  |  |  |  |
| Settings, branches, GST rates, business profile | ✓ |  |  |  |  |
| Audit trail | ✓ |  |  |  |  |
| Backups | ✓ |  |  |  |  |

## Fixing mistakes

| Mistake | How it is fixed | Who |
|---|---|---|
| Your own name, phone, email or language wrong | My account (click your name) → Your details — phone/email need your current password or PIN | Everyone |
| Wrong name / phone / email / password on a user | Admin → Users → Edit | Owner |
| Wrong details or PIN for counter, inventory or accounts staff | Staff → Edit | Owner; Manager (own branch) |
| Someone left | Staff → Edit → untick *Can sign in* (their past bills stay) | Owner; Manager (own branch) |
| Wrong role or branch | Admin → Users → Edit | Owner only |
| Forgot own password / PIN | Sign-in screen → *Forgot password* (emails a reset link, when email is set up); otherwise the Owner sets a new one in Admin → Users | Everyone |
| Lost the phone with the authenticator app | Sign in with a recovery code; or the Owner → Admin → Users → Edit → *Turn off two-step* | Owner |
| Wrong GST rate for an HSN | Catalog → GST rates → Edit, same date | Owner |
| Product details / unit / barcode wrong | Catalog → product → Edit | Owner, Manager |
| Selling price wrong | Catalog → product → Change price (history kept) | Owner |
| Customer / supplier details wrong | Customers / Vendors → Edit | per table above |
| Receipt recorded by mistake | Customers → customer → Receipts → Cancel (reason required) | Owner, Manager, Accountant |
| Supplier payment recorded by mistake | Vendors → supplier → Payments → Cancel (reason required) | Owner, Accountant |
| Expense typed wrong (still waiting for approval) | Expenses → open → Edit | whoever raised it, Manager, Owner |
| Expense category misspelt | Expenses → Categories → Rename | Owner, Manager, Accountant |
| Shift or roster wrong | Staff → Shifts → Edit / Remove | Owner, Manager |
| Estimate wrong | Estimates → Edit (until converted) | Owner, Manager, Cashier |
| Draft bill wrong | Billing → Drafts → Resume / Delete | Owner, Manager, Cashier |
| **Finalised** bill wrong | Return (credit note) or Void — a final bill is never edited | Return: Owner, Manager, Cashier · Void: Owner, Manager |
| Supplier bill (goods in) wrong | Return goods to supplier (debit note) — never edited | Owner, Manager, Inventory |
| Stock count wrong | Inventory → Adjustments (counted correction) | Owner, Manager |
| Branch details wrong | Admin → Branches → Edit (the code cannot change) | Owner |

Every one of these is recorded in Admin → Audit trail: who, when, what changed.
