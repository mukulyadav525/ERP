# BHAWANI ONE — Operations guide

How to install, run, back up, restore and look after a BHAWANI ONE installation.
Everything here was run against PostgreSQL 16 and Node.js 20+.

---

## 1. What runs where

| Piece | What it is | Default port |
|---|---|---|
| PostgreSQL 16 | All data. Branch isolation is enforced here with row-level security. | 5432 |
| API (`apps/api`) | Fastify + TypeScript. Connects as the **non-owner** role `erp_app`. | 4000 |
| Web (`apps/web`) | Next.js. Talks only to the API. | 3000 |

Two database roles are involved and they must stay separate:

* **`erp`** (or whatever owns the tables) — applies `db/schema.sql`, runs backups and the
  owner set-up script. Its URL is `MIGRATION_DATABASE_URL`.
* **`erp_app`** — what the running API uses (`DATABASE_URL`). It is not the table owner,
  so row-level security applies to it. `db/schema.sql` creates it with the password you
  pass in.

If the API ever connects as the table owner, branch isolation silently stops working.

---

## 2. First installation (production)

```bash
# 1. Install dependencies and build
npm ci
npm run build

# 2. Create the database, owned by the owner role (run as a PostgreSQL superuser)
psql -d postgres -c "CREATE ROLE erp LOGIN PASSWORD '<owner password>'"
psql -d postgres -c "CREATE DATABASE bhawani_one OWNER erp"

# 3. Apply the schema. This also creates the erp_app role with the password given here.
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -v erp_app_password='<app password>' -f db/schema.sql

# 4. Create the first Owner account (the password is asked for, never typed on the command line)
npm run create-owner -- --name "Owner Name" --email owner@yourshop.in --phone 98XXXXXXXX
```

Do **not** load `db/seed.sql` on a production database — it is demonstration data
(three branches, 11 users with published passwords, a year of invented sales).

Then sign in as the Owner and, in this order:

1. **Admin → Branches** — add each shop: a short code (printed in every document number,
   e.g. `INV-AND/2026-27/00001`; it cannot change later), name, address, state and GSTIN.
2. **Admin → Settings → Business profile** — the name, GSTIN, address, bank and UPI
   details printed on bills, and the declaration/terms.
3. **Catalog → GST rates** — the HSN codes you sell under, with their GST rate. A product
   cannot be created under an HSN that has no rate on file.
4. **Catalog → Categories / Brands / Units** — the built-in units cover most needs
   (PCS, KG, 100 G, METRE, LITRE, BOX, BAG…); add pack units as needed.
5. **Catalog → New product / Import CSV**, then **Inventory → Adjustments → Opening stock**
   for what is on the shelves today (each line needs a cost, so stock is valued).
6. **Admin → Users** — staff, each with a home branch, and optionally other branches
   they may also work at.
7. **Expenses → New category** (Rent, Electricity, Salaries…) before the first expense.

### Environment

Copy `.env.example` to `.env` and fill it in. Required in production:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | as `erp_app` |
| `MIGRATION_DATABASE_URL` | as the table owner — used by scripts only, never by the API |
| `SESSION_SECRET` | at least 32 random characters |
| `CORS_ORIGINS` | the web address(es), comma separated |
| `NEXT_PUBLIC_API_URL` | the API address as the browser sees it |
| `NODE_ENV=production` | turns off development-only behaviour (e.g. showing OTPs) |

Optional: `GOOGLE_OAUTH_CLIENT_ID` (Google sign-in), `WHATSAPP_CLOUD_API_TOKEN` +
`WHATSAPP_PHONE_NUMBER_ID` (sending queued WhatsApp messages), `BUSINESS_TIMEZONE`
(default `Asia/Kolkata`; the schema also sets the database's time zone to Asia/Kolkata —
change that line in `db/schema.sql` for a business elsewhere).

### Running

```bash
npm run start --workspace=apps/api     # API on $PORT (4000)
npm run start --workspace=apps/web     # web on 3000
```

Run both under a process manager (systemd, pm2, Docker) that restarts them, behind a
reverse proxy that terminates HTTPS. `GET /health` on the API answers
`{"status":"ok","schema_reachable":true,…}` when it can reach the database.

### Hosted: Railway (API + web) with Supabase (database)

**Database (Supabase).** Project → *Connect* → *Connection pooling* (Railway cannot reach
Supabase's IPv6-only direct host). The pooler user is `<role>.<project-ref>`. Either
pooler port works for the API (verified: sign-in, RLS and every write flow, on port
6543). Use the **transaction pooler (6543)** for `DATABASE_URL`. For the Node scripts
append `?sslmode=no-verify`; `psql` does not understand that value, so for `psql` use
`?sslmode=require`.

```bash
# From your computer, as the Supabase `postgres` role (the owner role here):
export MIGRATION_DATABASE_URL='postgresql://postgres.<ref>:<db password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require'
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -v erp_app_password='<app password>' -f db/schema.sql
npm run create-owner -- --name "Owner Name" --email owner@yourshop.in --phone 98XXXXXXXX
# (demo only, instead of create-owner: psql "$MIGRATION_DATABASE_URL" -f db/seed.sql)
```

If `schema.sql` stops with "deadlock detected" (a Supabase background process touching
the catalog mid-DDL), drop the half-built schema
(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) and run it again.

The schema works with Supabase keeping `pgcrypto` in its `extensions` schema.

**Railway.** New project → *Deploy from GitHub repo* → add the repo **twice**, as two
services. In each service's *Settings → Config-as-code* set the file:

| Service | Config file | Variables |
|---|---|---|
| api | `deploy/railway.api.json` | `DATABASE_URL` (as `erp_app.<ref>`, pooler port 6543, `?sslmode=no-verify`), `MIGRATION_DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV=production`, `CORS_ORIGINS=https://<web domain>`, `BUSINESS_TIMEZONE=Asia/Kolkata`, `LOG_LEVEL=info` |
| web | `deploy/railway.web.json` | `NEXT_PUBLIC_API_URL=https://<api domain>`, `NEXT_PUBLIC_BUSINESS_TIMEZONE=Asia/Kolkata`, `NODE_ENV=production` |

Generate a public domain for each (*Settings → Networking*). `NEXT_PUBLIC_API_URL` is
baked in at build time — redeploy the web service after changing it. Check
`https://<api domain>/health`.

Backups: Supabase's free plan keeps no downloadable backups — run `npm run backup` from
your own computer with `MIGRATION_DATABASE_URL` pointing at Supabase (needs `pg_dump`
16+).

---

## 3. Development set-up (with demo data)

```bash
docker compose up -d postgres            # or a local PostgreSQL 16
psql "$MIGRATION_DATABASE_URL" -v erp_app_password='<app password>' -f db/schema.sql
psql "$MIGRATION_DATABASE_URL" -f db/seed.sql
npm run dev
```

Demo sign-ins (seed data only): `owner@hardwareerp.in` / `Owner@12345`,
`sunita@hardwareerp.in` / `Manager@12345` (Andheri manager), cashier phone `9900000005`
PIN `1234`.

To rebuild from scratch, drop and recreate the database and apply both files again —
there is exactly one schema file and one seed file.

---

## 4. Backups

```bash
npm run backup
```

This takes a `pg_dump` (custom format) into `BACKUP_DIR` (default `./backups`), **reads
it back** with `pg_restore --list`, counts its tables, writes a SHA-256 beside it, and only
then records it in the `backups` table. A dump that fails or cannot be read back is
recorded as **FAILED**. It keeps the newest `BACKUP_KEEP` (default 14) dump files.

The Admin → Compliance screen shows the backup status:

* **Not configured** — no verified backup has ever been recorded.
* **Overdue** — the last verified backup is older than twice `backup_frequency_hours`.
* **Up to date** — otherwise.

### Schedule it

Daily, e.g. at 23:30 (cron, as a user that can read `.env`):

```cron
30 23 * * *  cd /srv/bhawani-one && npm run backup >> /var/log/bhawani-backup.log 2>&1
```

On Windows use Task Scheduler with `npm run backup` in the project folder.

### Keep a copy somewhere else

A backup on the same disk as the database does not survive that disk. Copy the
`backups` folder off the machine every day — another disk, a NAS, or cloud storage
(e.g. `rclone copy ./backups remote:bhawani-backups`). The dump contains customer data:
keep the destination private.

---

## 5. Restore test (monthly)

```bash
RESTORE_ADMIN_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres  npm run backup:restore-test
```

It takes the newest completed backup, checks its SHA-256, restores it into a **new
scratch database**, and checks that every table came back, that stock on hand equals the
stock ledger, that customer balances equal their ledgers and that invoice numbers are
unique. It then drops the scratch database and records the result on the backup. The
live database is never touched except to record the result.

`RESTORE_ADMIN_URL` must be a connection allowed to create and drop databases and to make
the owner role their owner (usually the `postgres` superuser).

Admin → Compliance warns when no restore test has passed in 90 days.

---

## 6. Restoring for real (disaster recovery)

1. Stop the API (so nothing writes during the restore).
2. Check the file: `shasum -a 256 -c backups/<file>.dump.sha256`
3. Restore into a new database, as the owner role:
   ```bash
   psql -d postgres -c "CREATE DATABASE bhawani_one_restored OWNER erp"
   pg_restore --no-owner --dbname="postgres://erp:<pw>@host:5432/bhawani_one_restored" backups/<file>.dump
   psql -d postgres -c "GRANT CONNECT ON DATABASE bhawani_one_restored TO erp_app"
   ```
4. Point `DATABASE_URL` / `MIGRATION_DATABASE_URL` at the restored database (or rename
   databases), start the API, sign in and check the latest bills and stock.
5. Anything entered after the backup was taken is not in it. Offline bills still queued
   in counter browsers upload again on reconnect (each carries its own id, so none is
   doubled).

---

## 7. Upgrades

This release ships the schema as a single file for a fresh install. There are no
incremental migration files yet, so **upgrading an existing production database to a
later schema needs a planned, written migration** (take a backup and a restore test
first). For a new installation, `db/schema.sql` is always the complete, current schema.

---

## 8. WhatsApp

WhatsApp is optional and never automatic by default:

* Every bill, receipt, statement and estimate has a **Share on WhatsApp** button that
  opens WhatsApp with the text written out for a person to send. It cannot attach the
  PDF — download the PDF and attach it if the customer wants the document.
* Reminders and campaigns are only **queued** when someone presses the button for them.
* With `WHATSAPP_CLOUD_API_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` set, queued messages are
  delivered through the WhatsApp Business API. Without them they are closed as
  **NOT_CONFIGURED** and never reported as sent.
* "Queue bills and credit notes for WhatsApp automatically" (Admin → Settings) is off by
  default.

---

## 9. Health checks and logs

* `GET /health` — liveness plus a database round-trip.
* The API logs JSON lines (pino) to stdout; set `LOG_LEVEL=info` in production.
* Error responses to the browser are plain messages; full errors are only in the log.
* Background jobs run inside the API process: the WhatsApp queue every 30 seconds,
  releasing lapsed estimate stock holds every 5 minutes.

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every screen empty for a branch user | API connected as the table owner, or `erp_app` lacks grants — re-apply `db/schema.sql` grants, check `DATABASE_URL`. |
| "Please select a branch for this transaction." | The Owner is on **All branches**; pick a branch in the top bar. |
| Product cannot be created: "no GST rate on file" | Add the HSN on Catalog → GST rates. |
| Backup status "Not configured" | `npm run backup` has never completed — run it and schedule it. |
| Restore test: "Could not create a scratch database" | Set `RESTORE_ADMIN_URL` to a superuser connection. |
| Dates a day off | `BUSINESS_TIMEZONE` / `NEXT_PUBLIC_BUSINESS_TIMEZONE` not set to the shop's zone. |
