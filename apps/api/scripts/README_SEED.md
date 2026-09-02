See /db/seed for seed SQL. Run in order:
  psql $DATABASE_URL -f db/schema/001_init.sql
  psql $DATABASE_URL -f db/schema/002_grants.sql   # only if using a non-superuser app role
  psql $DATABASE_URL -f db/seed/seed.sql
  psql $DATABASE_URL -f db/seed/seed_transactions.sql
  psql $DATABASE_URL -f db/seed/seed_expenses_hr_returns.sql

Or restore the pre-generated dataset directly (fastest — skips regenerating ~37k rows):
  pg_restore -d erp --clean --if-exists db/seed/erp_seeded_dump.pgcustom
