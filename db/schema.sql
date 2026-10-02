-- ============================================================================
-- Hardware Store ERP — COMPLETE DATABASE SCHEMA (PostgreSQL 16+)
-- Single authoritative file. Requirements Document v6, Sections 0-17.
--
--   psql "$MIGRATION_DATABASE_URL" -f db/schema.sql   -- as the OWNER role (e.g. erp)
--   psql "$MIGRATION_DATABASE_URL" -f db/seed.sql     -- then seed
--
-- This is a CREATE-FROM-SCRATCH file, not an incremental migration: it expects an
-- empty `public` schema and will report "already exists" if run over a populated
-- one. `npm run db:reset` drops and recreates the schema first, which is the
-- supported way to re-apply it during development.
--
-- Row-Level Security (Section 0 "row-level scoping"):
--   Tables are OWNED by the migration role (which therefore bypasses RLS, so this
--   file and seed.sql can run). The API connects as a separate, non-owner login
--   role `erp_app`, for which RLS is fully enforced. Every request opens a
--   transaction and does:
--        SELECT set_config('erp.user_id',   <uuid>, true);
--        SELECT set_config('erp.role',      <role>, true);
--        SELECT set_config('erp.branch_id', <uuid>, true);
--   Policies below then make a branch user's session physically unable to read or
--   write another branch's rows, even if application code has a bug.
-- ============================================================================

-- Conventions:
--   * Every PK is a UUID (gen_random_uuid()) unless noted.
--   * Money columns: NUMERIC(14,2). Quantities: NUMERIC(14,4) (fractional units — 2.2.1).
--   * `branch_id` on a table = branch-local data (Section 0). No `branch_id` = chain-wide master data.
--   * `created_at`/`updated_at` TIMESTAMPTZ everywhere; server-side default now().
--   * Requires: CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), crypt()/gen_salt() password + PIN hashing
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- required by the EXCLUDE (range-overlap) constraints below
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- [FIX] was missing: idx_products_name_trgm below needs gin_trgm_ops   -- required for the EXCLUDE (range-overlap) constraints below

-- ============================================================================
-- SECTION 0 — CORE / MULTI-BRANCH / TENANCY
-- ============================================================================

CREATE TABLE branches (
    branch_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Short, unique code that goes into every document number the branch issues
    -- (INV-AND/2026-27/00001). Document numbers are unique chain-wide, so two
    -- branches must never draw from series that print the same text.
    code            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    address         TEXT,
    state           TEXT,                        -- e.g. 'Maharashtra', printed on documents
    state_code      TEXT NOT NULL,              -- 2-digit GST state code ('27'); drives intra/interstate GST (15)
    gstin           TEXT,                        -- if branches share one GSTIN, this repeats; confirm with CA (15)
    phone           TEXT,
    email           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_branch_code CHECK (code ~ '^[A-Z0-9]{2,6}$')
);

CREATE TYPE user_role AS ENUM (
    'OWNER_ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT'
);  -- 7.1

CREATE TABLE users (
    user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID REFERENCES branches(branch_id),   -- NULL = chain-wide (Owner/Admin)
    role            user_role NOT NULL,
    full_name       TEXT NOT NULL,
    phone           TEXT UNIQUE,                  -- phone+OTP login path (7.2)
    email           TEXT UNIQUE,                  -- Google account email
    google_sub      TEXT UNIQUE,                  -- Google OAuth subject id (7.2)
    -- [FIX] Credentials are real hashes, verified in-database with pgcrypto crypt().
    -- Nothing here is ever compared in plaintext and no hash is ever sent to a client.
    password_hash   TEXT,                          -- bcrypt via crypt(pw, gen_salt('bf', 12))
    pin_hash        TEXT,                          -- quick-access PIN, same bcrypt scheme (7.2)
    failed_attempts SMALLINT NOT NULL DEFAULT 0,   -- 7.4: 3 failed attempts before lockout
    locked_until    TIMESTAMPTZ,                   -- set when failed_attempts crosses the policy limit
    last_login_at   TIMESTAMPTZ,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    language_pref   TEXT NOT NULL DEFAULT 'en',   -- 'en' / 'hi' (Section 1, req #1)
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_users_language CHECK (language_pref IN ('en','hi')),
    -- A branch user MUST have a branch; only OWNER_ADMIN may be chain-wide (Section 0).
    CONSTRAINT chk_users_branch_scope CHECK (role = 'OWNER_ADMIN' OR branch_id IS NOT NULL)
);

-- Section 0 — a branch employee may be authorised for more than one branch (a
-- relief manager, an accountant covering two shops). users.branch_id stays the
-- HOME branch; rows here grant the additional ones. A request always runs against
-- exactly ONE active branch, chosen per request and verified against this list by
-- the API before the RLS GUC is set — so every branch policy below is unchanged
-- and a user still never sees two branches' rows in the same transaction.
CREATE TABLE user_branch_access (
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    granted_by      UUID REFERENCES users(user_id),
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, branch_id)
);

-- [FIX] Sessions live in the database, not an in-memory Map. The server stores only a
-- SHA-256 hash of the bearer token, so a database leak cannot be replayed as a login.
-- Expiry and revocation are checked on every single request (7.2 session timeout).
CREATE TABLE user_sessions (        -- 7.2 device/session audit
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,         -- sha256(bearer token); the token itself is never stored
    device_id       TEXT,
    branch_id       UUID REFERENCES branches(branch_id),
    login_method    TEXT NOT NULL,                -- 'GOOGLE' | 'PHONE_OTP' | 'PIN' | 'PASSWORD'
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    CONSTRAINT chk_session_login_method
        CHECK (login_method IN ('GOOGLE','PHONE_OTP','PIN','PASSWORD'))
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, expires_at);

CREATE TABLE otp_requests (         -- 7.4 OTP/PIN policy
    otp_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone           TEXT NOT NULL,
    otp_hash        TEXT NOT NULL,                 -- bcrypt of the 6-digit code; never stored in the clear
    purpose         TEXT NOT NULL DEFAULT 'LOGIN', -- 'LOGIN' | 'RESET_PIN' | 'RESET_PASSWORD' | 'RESTORE_BACKUP'
    attempts        SMALLINT NOT NULL DEFAULT 0,
    consumed_at     TIMESTAMPTZ,                   -- single-use: a consumed OTP can never be replayed
    expires_at      TIMESTAMPTZ NOT NULL,          -- now() + otp_expiry_minutes (admin setting, default 5)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_otp_purpose
        CHECK (purpose IN ('LOGIN','RESET_PIN','RESET_PASSWORD','RESTORE_BACKUP'))
);
CREATE INDEX idx_otp_phone ON otp_requests(phone, purpose, expires_at);

-- 7.2 self-service registration. A signup NEVER creates a live user: it creates a request
-- that an Owner/Admin must approve, which is what then provisions the user + branch + role.
CREATE TABLE registration_requests (
    request_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       TEXT NOT NULL,
    email           TEXT,
    phone           TEXT NOT NULL,
    requested_role  user_role NOT NULL,
    requested_branch_id UUID REFERENCES branches(branch_id),
    password_hash   TEXT,                          -- captured at signup, used only if approved
    status          TEXT NOT NULL DEFAULT 'PENDING',
    reviewed_by     UUID REFERENCES users(user_id),
    reviewed_at     TIMESTAMPTZ,
    reject_reason   TEXT,
    created_user_id UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_regreq_status CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    CONSTRAINT chk_regreq_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX ux_regreq_pending_phone ON registration_requests(phone) WHERE status = 'PENDING';

-- 7.2 forgot password / forgot PIN. Single-use, expiring, hashed.
CREATE TABLE password_reset_tokens (
    reset_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    reset_kind      TEXT NOT NULL DEFAULT 'PASSWORD',  -- 'PASSWORD' | 'PIN'
    consumed_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_reset_kind CHECK (reset_kind IN ('PASSWORD','PIN'))
);

-- [FIX] OTP codes and password-reset tokens used to be queued into
-- whatsapp_message_log, which every authenticated session can read. That handed
-- any cashier a one-request path to an Owner password reset. Auth messages now go
-- to their own outbox: RLS is on with NO policy, so the application role cannot
-- read this table at all -- only the SECURITY DEFINER functions below can.
CREATE TABLE auth_message_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    to_phone        TEXT NOT NULL,
    to_email        TEXT,
    purpose         TEXT NOT NULL,                 -- 'OTP' | 'PASSWORD_RESET' | 'PIN_RESET'
    body            TEXT NOT NULL,                 -- contains the secret; never leaves this table
    status          TEXT NOT NULL DEFAULT 'QUEUED',
    attempts        SMALLINT NOT NULL DEFAULT 0,
    last_error      TEXT,
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,
    CONSTRAINT chk_auth_outbox_status CHECK (status IN ('QUEUED','SENDING','SENT','FAILED'))
);
CREATE INDEX idx_auth_outbox_queue ON auth_message_outbox(status, queued_at);

-- [FIX H-3] An override is now proved by a short-lived, single-use grant row
-- rather than by the caller passing back a manager's user id. Passing a bare UUID
-- meant any leaked manager id was a permanent self-approval token, and three of
-- the four override paths never validated it at all.
CREATE TABLE override_approvals (
    approval_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose         TEXT NOT NULL,                 -- 'DISCOUNT' | 'NEGATIVE_STOCK' | 'CREDIT_LIMIT' | 'RETURN_WINDOW' | 'CASH_DROP'
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    approver_id     UUID NOT NULL REFERENCES users(user_id),
    requested_by    UUID NOT NULL REFERENCES users(user_id),
    consumed_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_override_purpose CHECK (purpose IN
        ('DISCOUNT','NEGATIVE_STOCK','CREDIT_LIMIT','RETURN_WINDOW','CASH_DROP'))
);
CREATE INDEX idx_override_approvals_open ON override_approvals(requested_by, purpose, expires_at)
    WHERE consumed_at IS NULL;

-- 7.4 brute-force throttling, keyed on the login identifier rather than the user row,
-- so attempts against a non-existent account are throttled identically (no user enumeration).
CREATE TABLE login_attempts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier      TEXT NOT NULL,                 -- lowercased email or phone
    ip_address      INET,
    succeeded       BOOLEAN NOT NULL,
    attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_login_attempts_ident ON login_attempts(identifier, attempted_at DESC);

CREATE TABLE audit_log (            -- 7.3
    audit_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(user_id),
    branch_id       UUID REFERENCES branches(branch_id),
    action          TEXT NOT NULL,                 -- e.g. 'PRICE_CHANGE', 'DISCOUNT_OVERRIDE', 'REFUND'
    entity_type     TEXT NOT NULL,
    entity_id       UUID,
    old_value       JSONB,
    new_value       JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Section 17 consolidated settings table — every ⚙ toggle, chain-wide or per-branch.
-- [FIX] branch_id must stay NULLABLE (NULL = chain-wide default), so it CANNOT be part of a composite
-- PRIMARY KEY — Postgres silently forces every PK column to NOT NULL, which broke inserting a chain-wide
-- row (verified: "null value in column branch_id violates not-null constraint"). Fixed with a surrogate
-- PK plus a COALESCE-based unique index, which treats NULL branch_id as a single well-known "chain-wide" slot.
CREATE TABLE admin_settings (
    setting_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key     TEXT NOT NULL,                 -- e.g. 'allow_negative_stock', 'valuation_method'
    branch_id       UUID REFERENCES branches(branch_id),  -- NULL = chain-wide default
    value           JSONB NOT NULL,
    updated_by      UUID REFERENCES users(user_id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_admin_settings_key_branch
    ON admin_settings (setting_key, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
-- Resolution order at read time: branch-specific row, else chain-wide (branch_id IS NULL) row, else code default.

-- ============================================================================
-- SECTION 2 — CATALOG & PRODUCT MASTER
-- ============================================================================

CREATE TABLE categories (
    category_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_category_id UUID REFERENCES categories(category_id),
    name            TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive, so "Plumbing" and "plumbing " cannot both exist under one parent.
CREATE UNIQUE INDEX ux_categories_name ON categories (
    COALESCE(parent_category_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

CREATE TABLE brands (
    brand_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_brands_name ON brands (lower(btrim(name)));

-- 2.2.1 — the units master. Units are DATA, not an enum, so a shop can add
-- "BAG", "COIL" or "250G" without a code change.
--
-- `dimension` + `to_dimension_base` is what makes conversions explicit rather
-- than special-cased: every MASS unit states how many grams it is (G = 1,
-- 100G = 100, KG = 1000), every LENGTH unit how many millimetres, every VOLUME
-- unit how many millilitres, every COUNT unit how many pieces. Two units of the
-- same dimension therefore convert by simple division — 100G against a KG base
-- is 100 / 1000 = 0.1 — and nothing about "100 G" is hard-coded anywhere.
--
-- PACK units (BOX, PACK, REEL, SET, TIN, ...) have no fixed size: a box of screws
-- holds 100, a box of bolts 50. Their size is PRODUCT-specific and is stated on
-- product_units.multiplier_to_base instead.
CREATE TABLE units (
    unit_code           TEXT PRIMARY KEY,               -- 'KG', 'G', '100G', 'BOX'
    name                TEXT NOT NULL,                  -- 'Kilogram'
    print_label         TEXT NOT NULL,                  -- what an invoice prints: 'KG', 'G', '100 G'
    dimension           TEXT NOT NULL,
    to_dimension_base   NUMERIC(18,6),                  -- grams / mm / ml / pieces per ONE of this unit
    allows_fraction     BOOLEAN NOT NULL DEFAULT FALSE, -- 1.5 m of pipe yes; 1.5 boxes no
    is_system           BOOLEAN NOT NULL DEFAULT FALSE, -- shipped units cannot be deleted or re-dimensioned
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_unit_code CHECK (unit_code ~ '^[A-Z0-9_]{1,20}$'),
    CONSTRAINT chk_unit_dimension CHECK (dimension IN ('COUNT','MASS','LENGTH','VOLUME','AREA','PACK')),
    -- A measured unit must say how big it is; a pack unit must not (its size is per product).
    CONSTRAINT chk_unit_factor CHECK (
        (dimension = 'PACK' AND to_dimension_base IS NULL)
        OR (dimension <> 'PACK' AND to_dimension_base > 0))
);

-- The shipped units. Reference data the application cannot run without, so it
-- lives with the schema rather than in the demo seed; a shop adds its own on top.
INSERT INTO units (unit_code, name, print_label, dimension, to_dimension_base, allows_fraction, is_system) VALUES
 ('PIECE',  'Piece',            'PCS',    'COUNT',  1,       FALSE, TRUE),
 ('PCS',    'Pieces',           'PCS',    'COUNT',  1,       FALSE, TRUE),
 ('PAIR',   'Pair',             'PAIR',   'COUNT',  2,       FALSE, TRUE),
 ('DOZEN',  'Dozen',            'DOZ',    'COUNT',  12,      FALSE, TRUE),
 ('G',      'Gram',             'G',      'MASS',   1,       TRUE,  TRUE),
 ('100G',   '100 grams',        '100 G',  'MASS',   100,     TRUE,  TRUE),
 ('250G',   '250 grams',        '250 G',  'MASS',   250,     TRUE,  TRUE),
 ('500G',   '500 grams',        '500 G',  'MASS',   500,     TRUE,  TRUE),
 ('KG',     'Kilogram',         'KG',     'MASS',   1000,    TRUE,  TRUE),
 ('MM',     'Millimetre',       'MM',     'LENGTH', 1,       TRUE,  TRUE),
 ('CM',     'Centimetre',       'CM',     'LENGTH', 10,      TRUE,  TRUE),
 ('INCH',   'Inch',             'IN',     'LENGTH', 25.4,    TRUE,  TRUE),
 ('FT',     'Foot',             'FT',     'LENGTH', 304.8,   TRUE,  TRUE),
 ('METRE',  'Metre',            'M',      'LENGTH', 1000,    TRUE,  TRUE),
 ('ML',     'Millilitre',       'ML',     'VOLUME', 1,       TRUE,  TRUE),
 ('LITRE',  'Litre',            'L',      'VOLUME', 1000,    TRUE,  TRUE),
 ('SQFT',   'Square foot',      'SQ FT',  'AREA',   1,       TRUE,  TRUE),
 ('SQM',    'Square metre',     'SQ M',   'AREA',   10.7639, TRUE,  TRUE),
 ('BOX',    'Box',              'BOX',    'PACK',   NULL,    FALSE, TRUE),
 ('PACK',   'Pack',             'PACK',   'PACK',   NULL,    FALSE, TRUE),
 ('SET',    'Set',              'SET',    'PACK',   NULL,    FALSE, TRUE),
 ('CARTON', 'Carton',           'CTN',    'PACK',   NULL,    FALSE, TRUE),
 ('BAG',    'Bag',              'BAG',    'PACK',   NULL,    FALSE, TRUE),
 ('ROLL',   'Roll',             'ROLL',   'PACK',   NULL,    FALSE, TRUE),
 ('REEL',   'Reel / coil',      'REEL',   'PACK',   NULL,    FALSE, TRUE),
 ('BUNDLE', 'Bundle',           'BDL',    'PACK',   NULL,    FALSE, TRUE),
 ('TIN',    'Tin / can',        'TIN',    'PACK',   NULL,    FALSE, TRUE),
 ('BUCKET', 'Bucket',           'BKT',    'PACK',   NULL,    FALSE, TRUE),
 ('LENGTH', 'Length (pipe/rod)','LENGTH', 'PACK',   NULL,    FALSE, TRUE);

CREATE TYPE price_type AS ENUM ('TAX_INCLUSIVE', 'TAX_EXCLUSIVE');     -- 2.8

-- Money columns are NUMERIC(14,2). The per-BASE-unit rates below are (14,4):
-- a product stocked by the gram and sold by 100 g costs ₹0.125 a gram, which two
-- decimals cannot hold without mispricing every line built from it.
CREATE TABLE products (
    product_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku                 TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    description         TEXT,
    category_id         UUID REFERENCES categories(category_id),
    brand_id            UUID REFERENCES brands(brand_id),
    base_unit           TEXT NOT NULL REFERENCES units(unit_code),  -- 2.2.1: stock, cost and price are all per base unit
    hsn_code            TEXT NOT NULL,
    default_price_type  price_type NOT NULL DEFAULT 'TAX_INCLUSIVE',  -- 2.8
    reference_purchase_price NUMERIC(14,4),               -- admin-entered ESTIMATE only, not the real cost (2.6 DATA-FIX)
    -- Default reorder level in base units. A branch may set its own on
    -- branch_stock.reorder_min; this is what applies where it has not.
    reorder_level       NUMERIC(14,4),
    image_url           TEXT,
    spec                JSONB,                             -- voltage/wattage, pipe schedule, paint sheen, etc. (2.1)
    batch_tracked        BOOLEAN NOT NULL DEFAULT FALSE,    -- 4.2 — on for paint/adhesive/chemical/battery categories
    serial_tracked        BOOLEAN NOT NULL DEFAULT FALSE,    -- 12.2 — on for serialized electronics/power tools
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_products_reorder CHECK (reorder_level IS NULL OR reorder_level >= 0)
);

-- 2.2: every sale unit is a stated multiple of the base unit. Never an independent price:
-- 5 × 100G against a KG base is 5 × 0.1 = 0.5 KG of stock and 0.5 × the KG rate.
CREATE TABLE product_units (
    product_unit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    unit_label      TEXT NOT NULL REFERENCES units(unit_code),   -- 'BOX', 'REEL', '100G', 'PIECE'
    multiplier_to_base NUMERIC(14,6) NOT NULL,      -- base units in ONE of this unit: BOX of screws 100, 100G on KG 0.1
    is_default_sale_unit BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (product_id, unit_label),
    CONSTRAINT chk_product_unit_multiplier CHECK (multiplier_to_base > 0)
);
-- At most one default sale unit per product, or "the unit the counter opens on" is ambiguous.
CREATE UNIQUE INDEX ux_product_units_default ON product_units(product_id) WHERE is_default_sale_unit;

CREATE TABLE product_barcodes (      -- optional, multiple per product (2.1); a code identifies exactly one product
    barcode_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    product_unit_id UUID REFERENCES product_units(product_unit_id),
    barcode         TEXT NOT NULL UNIQUE,
    is_internally_generated BOOLEAN NOT NULL DEFAULT FALSE  -- 4.9 internal SKU label for unbarcoded items
);

-- 2.7: tax rate is EFFECTIVE-DATED — never a single overwritable field.
-- [FIX] The original partial-unique fix only stopped two "still open" (effective_to IS NULL) rows —
-- it did nothing to stop a backdated or future-scheduled row from overlapping an existing range, e.g. a
-- promotional rate inserted for [2026-09-01, 2026-09-10) that overlaps the currently-open row. Replaced
-- with an EXCLUDE constraint using daterange, which rejects ANY overlap — past, present, or future-scheduled
-- — not just the "two open rows" case. A NULL effective_to becomes an unbounded (infinite) upper bound in
-- the range, so the old "at most one open row" guarantee still holds; EXCLUDE strictly generalizes it.
CREATE TABLE hsn_tax_rates (
    hsn_tax_rate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hsn_code        TEXT NOT NULL,
    gst_rate_pct    NUMERIC(5,2) NOT NULL,
    cess_rate_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
    effective_from  DATE NOT NULL,
    effective_to    DATE,                          -- NULL = still open-ended (unbounded upper range)
    UNIQUE (hsn_code, effective_from),
    EXCLUDE USING gist (
        hsn_code WITH =,
        daterange(effective_from, effective_to, '[)') WITH &&
    )
);

-- Selling price, also effective-dated so historical margin reports stay accurate; branch_id NULL = chain-wide (2.5).
-- [FIX] Same overlap gap as hsn_tax_rates, fixed the same way: EXCLUDE using tstzrange instead of a partial
-- unique index, so a backdated or future-scheduled price can't silently overlap an existing effective range
-- for the same product+branch. COALESCE handles NULL branch_id (chain-wide) the same way admin_settings does.
CREATE TABLE product_prices (
    price_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    branch_id       UUID REFERENCES branches(branch_id),   -- NULL unless "allow branch price override" is on
    mrp             NUMERIC(14,4) NOT NULL,                -- per BASE unit, like every rate
    selling_price   NUMERIC(14,4) NOT NULL,
    CONSTRAINT chk_product_prices_values CHECK (selling_price >= 0 AND mrp >= selling_price),
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_to    TIMESTAMPTZ,                            -- NULL = open-ended (unbounded upper range)
    created_by      UUID REFERENCES users(user_id),
    EXCLUDE USING gist (
        product_id WITH =,
        COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
        tstzrange(effective_from, effective_to, '[)') WITH &&
    )
);
-- "Current price" query: SELECT ... WHERE product_id = ? AND effective_to IS NULL
--   AND branch_id = ? (fall back to WHERE branch_id IS NULL if no branch-specific row exists).
-- "Price as of a given date" query: SELECT ... WHERE product_id = ? AND tstzrange(effective_from, effective_to, '[)') @> ?::timestamptz

CREATE TABLE bundles (               -- 2.4, off by default
    bundle_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE bundle_items (
    bundle_id       UUID NOT NULL REFERENCES bundles(bundle_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL,
    PRIMARY KEY (bundle_id, product_id)
);

-- ============================================================================
-- SECTION 4 — INVENTORY & PROCUREMENT
-- ============================================================================

-- Branch-local current stock position. weighted_avg_cost is DERIVED — never directly editable (4.8.1 DATA-FIX).
CREATE TABLE branch_stock (
    branch_id           UUID NOT NULL REFERENCES branches(branch_id),
    product_id          UUID NOT NULL REFERENCES products(product_id),
    base_unit_qty        NUMERIC(14,4) NOT NULL DEFAULT 0,
    reserved_qty          NUMERIC(14,4) NOT NULL DEFAULT 0,   -- 5.1 quotation reservation
    weighted_avg_cost    NUMERIC(14,4) NOT NULL DEFAULT 0,    -- recalculated only via GRN/transfer-in/stock-take (never UPDATEd freehand by app code)
    reorder_min          NUMERIC(14,4),
    reorder_max          NUMERIC(14,4),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (branch_id, product_id)
);

-- [FIX] Negative stock is not blocked by a plain CHECK (base_unit_qty >= 0) — that would silently break the
-- requirements doc's own "allow negative stock" toggle (3.8: off by default/hard-block, but the Owner can
-- turn it on chain-wide or per-branch with a PIN override). A static CHECK can't consult admin_settings, so
-- enforcement is a trigger instead: it reads the resolved setting (branch-specific row, else chain-wide row,
-- else default-deny) at the moment of the UPDATE, and only blocks the write when negative stock is NOT allowed
-- for that branch. This makes both halves of the documented behavior actually true at the database level.
CREATE OR REPLACE FUNCTION fn_enforce_stock_non_negative() RETURNS TRIGGER AS $$
DECLARE
    allow_negative BOOLEAN;
BEGIN
    IF NEW.base_unit_qty >= 0 THEN
        RETURN NEW;
    END IF;

    -- Receiving stock against an already-negative balance must always be allowed.
    -- Blocking it treated "make the hole smaller" the same as "dig it deeper", so
    -- a branch that had once oversold could never take delivery again without an
    -- owner flipping a chain-wide setting. Only a movement that makes the position
    -- worse is a candidate for the block below.
    IF TG_OP = 'UPDATE' AND NEW.base_unit_qty > OLD.base_unit_qty THEN
        RETURN NEW;
    END IF;
    -- A manager's PIN override, and the 3.5.1 offline-conflict rule, both have to
    -- be able to get past this. Without that the trigger vetoed the very decisions
    -- the requirements say a human is allowed to make: an approved override came
    -- back as "go and change a setting", and a flagged offline sale aborted before
    -- its stock_conflicts row could be written. The API sets this transaction-local
    -- flag ONLY after consuming a single-use grant, so no client can set it.
    IF COALESCE(current_setting('erp.allow_negative_stock', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(
        (SELECT (value #>> '{}')::boolean FROM admin_settings
            WHERE setting_key = 'allow_negative_stock' AND branch_id = NEW.branch_id),
        (SELECT (value #>> '{}')::boolean FROM admin_settings
            WHERE setting_key = 'allow_negative_stock' AND branch_id IS NULL),
        FALSE   -- default-deny if no setting row exists at all (matches the documented default: Off)
    ) INTO allow_negative;
    IF NOT allow_negative THEN
        RAISE EXCEPTION 'Negative stock blocked for branch %, product % (base_unit_qty would be %); enable admin_settings.allow_negative_stock to override',
            NEW.branch_id, NEW.product_id, NEW.base_unit_qty;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_stock_non_negative
    BEFORE INSERT OR UPDATE ON branch_stock
    FOR EACH ROW EXECUTE FUNCTION fn_enforce_stock_non_negative();

CREATE TABLE stock_batches (         -- 4.2, only for batch_tracked products
    batch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    batch_number    TEXT NOT NULL,
    mfg_date        DATE,
    expiry_date     DATE,
    qty_remaining    NUMERIC(14,4) NOT NULL DEFAULT 0
);

CREATE TYPE serial_status AS ENUM ('IN_STOCK', 'SOLD', 'RETURNED', 'WARRANTY_CLAIM', 'WRITTEN_OFF');

CREATE TABLE stock_serials (         -- 4.9 / 12.2, only for serial_tracked products
    serial_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    serial_number   TEXT NOT NULL,
    status          serial_status NOT NULL DEFAULT 'IN_STOCK',
    invoice_line_id UUID,             -- set once sold (FK added after invoice_lines exists)
    UNIQUE (product_id, serial_number)
);

-- Immutable movement log — the single source of truth for how branch_stock got to its current number (4.1).
CREATE TYPE stock_movement_type AS ENUM (
    'PURCHASE', 'SALE', 'SALE_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN',
    'PURCHASE_RETURN', 'WRITE_OFF', 'COUNT_ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE',
    'OPENING_STOCK', 'ADJUSTMENT'
);

CREATE TABLE stock_ledger (
    ledger_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    movement_type   stock_movement_type NOT NULL,
    base_unit_qty_change NUMERIC(14,4) NOT NULL,   -- signed: +in, -out
    cost_at_movement NUMERIC(14,4),                 -- weighted_avg_cost snapshot at the moment of this movement
    ref_table       TEXT NOT NULL,                  -- 'invoices', 'grn', 'stock_transfers', ...
    ref_id          UUID NOT NULL,
    reason_code     TEXT,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendors (                -- 8
    vendor_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,                 -- trading name as it appears on their invoices
    contact_person  TEXT,
    gstin           TEXT,
    phone           TEXT,
    email           TEXT,
    address         TEXT,
    state           TEXT,
    state_code      TEXT,                          -- 2-digit GST code; decides CGST+SGST vs IGST on purchases
    payment_terms_days SMALLINT,
    -- Where the shop pays them. Informational: payments are recorded, not made, here.
    bank_name       TEXT,
    bank_account_no TEXT,
    bank_ifsc       TEXT,
    upi_id          TEXT,
    notes           TEXT,
    -- The payable brought forward when the vendor was set up. It is POSTED to
    -- vendor_ledger as an OPENING_BALANCE entry, so the ledger stays the single
    -- source of truth for what is owed; this column only records what was entered.
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendor_product_map (     -- 4.9 vendor-item mapping, multiple vendors per item
    vendor_id       UUID NOT NULL REFERENCES vendors(vendor_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    vendor_sku      TEXT,
    last_purchase_rate NUMERIC(14,4),              -- per base unit, ex-GST, net of discount
    is_preferred    BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (vendor_id, product_id)
);

CREATE TYPE po_status AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

CREATE TABLE purchase_orders (        -- 4.5
    po_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    vendor_id       UUID NOT NULL REFERENCES vendors(vendor_id),
    po_number       TEXT NOT NULL UNIQUE,
    status          po_status NOT NULL DEFAULT 'DRAFT',
    expected_date   DATE,
    notes           TEXT,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_lines (
    po_line_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id           UUID NOT NULL REFERENCES purchase_orders(po_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL CHECK (qty_base_unit > 0),
    rate            NUMERIC(14,4) NOT NULL CHECK (rate >= 0)   -- per base unit, ex-GST
);

-- A goods receipt is also the purchase entry: it carries the supplier's own bill
-- number and date, and its totals (with GST) are what goes to the payables ledger.
CREATE TABLE grn (                    -- Goods Receipt Note (4.5)
    grn_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_id           UUID REFERENCES purchase_orders(po_id),   -- nullable: GRN can happen without a PO
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    vendor_id       UUID NOT NULL REFERENCES vendors(vendor_id),
    grn_number      TEXT NOT NULL UNIQUE,
    vendor_invoice_no   TEXT,                      -- the supplier's bill number (what ITC is claimed against)
    vendor_invoice_date DATE,
    notes           TEXT,
    interstate      BOOLEAN NOT NULL DEFAULT FALSE,
    gross_total     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- before discount
    discount_total  NUMERIC(14,2) NOT NULL DEFAULT 0,
    taxable_total   NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    round_off       NUMERIC(14,2) NOT NULL DEFAULT 0,
    grand_total     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- what is owed to the vendor for this receipt
    client_txn_id   UUID UNIQUE,                        -- a double-clicked "Save" cannot receive the goods twice
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES users(user_id)
);
-- One supplier bill is received once per branch; a second entry of the same bill is a duplicate purchase.
CREATE UNIQUE INDEX ux_grn_vendor_invoice ON grn (branch_id, vendor_id, lower(vendor_invoice_no))
    WHERE vendor_invoice_no IS NOT NULL;

CREATE TABLE grn_lines (
    grn_line_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_id          UUID NOT NULL REFERENCES grn(grn_id),
    po_line_id      UUID REFERENCES purchase_order_lines(po_line_id),   -- partial receipts add up against this
    product_id      UUID NOT NULL REFERENCES products(product_id),
    product_unit_id UUID REFERENCES product_units(product_unit_id),     -- the unit it was bought in (BOX, BAG)
    qty_in_unit     NUMERIC(14,4),                   -- quantity in that unit, as on the supplier's bill
    qty_base_unit   NUMERIC(14,4) NOT NULL CHECK (qty_base_unit > 0),
    rate            NUMERIC(14,4) NOT NULL CHECK (rate >= 0),   -- price per BASE unit, ex-GST, before discount
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    gst_rate_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
    taxable_value   NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(14,2) GENERATED ALWAYS AS (taxable_value + cgst_amount + sgst_amount + igst_amount) STORED,
    batch_id        UUID REFERENCES stock_batches(batch_id)
);
-- The landed cost that feeds the weighted average (4.8.1) is taxable_value / qty_base_unit:
-- net of the supplier's discount, excluding GST (which is claimed back as ITC).
CREATE INDEX idx_grn_lines_po_line ON grn_lines(po_line_id) WHERE po_line_id IS NOT NULL;

-- Purchase return / Vendor Debit Note workflow (4.5.1 DATA-FIX) — separate numbered series from sales credit notes.
CREATE TABLE vendor_debit_notes (
    debit_note_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    debit_note_number TEXT NOT NULL UNIQUE,
    grn_id          UUID NOT NULL REFERENCES grn(grn_id),
    vendor_id       UUID NOT NULL REFERENCES vendors(vendor_id),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    reason          TEXT NOT NULL,
    taxable_total   NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_amount    NUMERIC(14,2) NOT NULL,         -- taxable + tax: what comes off the payable
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendor_debit_note_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    debit_note_id   UUID NOT NULL REFERENCES vendor_debit_notes(debit_note_id),
    grn_line_id     UUID NOT NULL REFERENCES grn_lines(grn_line_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL CHECK (qty_base_unit > 0),
    rate            NUMERIC(14,4) NOT NULL,
    taxable_value   NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(14,2) NOT NULL DEFAULT 0
);

CREATE TYPE vendor_ledger_entry_type AS ENUM ('GRN_PAYABLE', 'PAYMENT_MADE', 'DEBIT_NOTE', 'OPENING_BALANCE', 'ADJUSTMENT');

CREATE TABLE vendor_ledger (          -- 8, outstanding-payable ledger, mirror of customer credit ledger
    entry_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id       UUID NOT NULL REFERENCES vendors(vendor_id),
    branch_id       UUID REFERENCES branches(branch_id),
    entry_type      vendor_ledger_entry_type NOT NULL,
    amount          NUMERIC(14,2) NOT NULL,        -- positive = increases payable, negative = reduces it
    ref_table       TEXT,
    ref_id          UUID,
    balance_after   NUMERIC(14,2) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Money paid to a vendor, with how and against what. The ledger entry is the
-- balance; this row is the voucher behind it (method, bank reference, the bill it
-- settles), which is what an accountant reconciles a bank statement against.
CREATE TABLE vendor_payments (
    payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_number  TEXT NOT NULL UNIQUE,
    vendor_id       UUID NOT NULL REFERENCES vendors(vendor_id),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    grn_id          UUID REFERENCES grn(grn_id),              -- optional: the bill this settles
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    method          TEXT NOT NULL,
    reference       TEXT,                                     -- UTR / cheque no / UPI ref
    notes           TEXT,
    paid_on         DATE NOT NULL DEFAULT CURRENT_DATE,
    client_txn_id   UUID UNIQUE,                              -- a double-submit records one payment, not two
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vendor_payment_method CHECK (method IN ('CASH','UPI','CARD','BANK_TRANSFER','CHEQUE'))
);
CREATE INDEX idx_vendor_payments_vendor ON vendor_payments(vendor_id, created_at DESC);

-- Inter-branch transfer with explicit TRANSFER_DISCREPANCY state (4.4.1 ENG-FIX)
CREATE TYPE transfer_status AS ENUM ('REQUESTED', 'DISPATCHED', 'RECEIVED', 'TRANSFER_DISCREPANCY', 'CLOSED', 'CANCELLED');

CREATE TABLE stock_transfers (
    transfer_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_number TEXT UNIQUE,                    -- drawn from the SENDING branch's TRANSFER series
    from_branch_id  UUID NOT NULL REFERENCES branches(branch_id),
    to_branch_id    UUID NOT NULL REFERENCES branches(branch_id),
    status          transfer_status NOT NULL DEFAULT 'REQUESTED',
    transfer_doc_type TEXT NOT NULL DEFAULT 'INTRASTATE',  -- 'INTRASTATE' | 'INTERSTATE' — CA to confirm treatment (15)
    driver_ref      TEXT,
    notes           TEXT,
    requested_by    UUID REFERENCES users(user_id),
    dispatched_by   UUID REFERENCES users(user_id),
    received_by     UUID REFERENCES users(user_id),
    cancelled_by    UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at   TIMESTAMPTZ,
    received_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    CONSTRAINT chk_transfer_branches CHECK (from_branch_id <> to_branch_id)
);

CREATE TABLE stock_transfer_lines (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id     UUID NOT NULL REFERENCES stock_transfers(transfer_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    dispatched_qty  NUMERIC(14,4) NOT NULL,
    -- 4.8.1: the sending branch's weighted-average cost, captured at dispatch and
    -- travelling with the goods. It has to be recorded here because branch_stock is
    -- strictly branch-scoped by RLS — the receiving branch's session cannot read the
    -- sender's cost, and goods arriving valued at zero would corrupt every margin
    -- and stock-value figure for transferred stock.
    dispatch_cost   NUMERIC(14,4),
    received_qty    NUMERIC(14,4),                  -- NULL until receiving branch acts
    discrepancy_qty NUMERIC(14,4) GENERATED ALWAYS AS (COALESCE(dispatched_qty,0) - COALESCE(received_qty,0)) STORED,
    resolution      TEXT,                             -- 'WRITE_OFF' | 'COUNT_CORRECTION', set by Admin (4.4.1)
    resolved_by     UUID REFERENCES users(user_id),
    resolved_at     TIMESTAMPTZ
);

CREATE TABLE stock_audits (           -- 4.6
    audit_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    status          TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES users(user_id)
);

CREATE TABLE stock_audit_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_id        UUID NOT NULL REFERENCES stock_audits(audit_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    system_qty      NUMERIC(14,4) NOT NULL,
    counted_qty     NUMERIC(14,4) NOT NULL,
    variance_qty    NUMERIC(14,4) GENERATED ALWAYS AS (counted_qty - system_qty) STORED
);

CREATE TABLE stock_writeoffs (        -- 4.7
    writeoff_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL,
    reason_code     TEXT NOT NULL,                  -- 'DAMAGED' | 'EXPIRED' | 'TRANSFER_LOSS' | ...
    ref_transfer_line_id UUID REFERENCES stock_transfer_lines(line_id),
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4.1 — every manual change to stock is a document with a reason, never a silent
-- UPDATE of branch_stock: opening stock for a new product, stock found on a shelf,
-- a counting correction, goods used by the shop itself.
CREATE TABLE stock_adjustments (
    adjustment_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    adjustment_number TEXT NOT NULL UNIQUE,
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    qty_change      NUMERIC(14,4) NOT NULL CHECK (qty_change <> 0),  -- signed, base units
    unit_cost       NUMERIC(14,4),                   -- required for stock coming IN, so it is valued
    reason_code     TEXT NOT NULL,
    notes           TEXT,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_stock_adjustment_reason CHECK (reason_code IN
        ('OPENING_STOCK','FOUND','COUNT_CORRECTION','DAMAGED','LOST','EXPIRED','INTERNAL_USE','OTHER'))
);
CREATE INDEX idx_stock_adjustments_branch ON stock_adjustments(branch_id, created_at DESC);

-- ============================================================================
-- SECTION 6 — CUSTOMERS & CREDIT LEDGER (chain-wide identity, Section 0)
-- ============================================================================

CREATE TYPE customer_type AS ENUM ('RETAIL', 'B2B_CONTRACTOR');

CREATE TABLE customers (
    customer_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone           TEXT NOT NULL UNIQUE,           -- dedup key, chain-wide (Section 0)
    name            TEXT NOT NULL,
    email           TEXT,
    dob             DATE,                            -- optional, for 11.1 birthday greetings
    gstin           TEXT,                             -- for B2B customers
    -- A GST tax invoice to a registered buyer has to carry their name, address and
    -- place of supply, so these are invoice fields rather than optional CRM extras
    -- (Sections 58.2, 15). Nullable: a walk-in retail customer has none of them.
    company_name    TEXT,
    address         TEXT,
    state           TEXT,
    state_code      TEXT,                            -- 2-digit GST code; becomes the place of supply on their bills
    whatsapp        TEXT,                            -- when it differs from the calling number
    notes           TEXT,
    customer_type   customer_type NOT NULL DEFAULT 'RETAIL',
    credit_allowed  BOOLEAN NOT NULL DEFAULT FALSE,
    credit_limit    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
    -- The balance brought forward when the customer was set up. It is POSTED to the
    -- credit ledger as an OPENING_BALANCE entry — the ledger is the only balance;
    -- this column only records what was entered and when.
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    loyalty_points_balance INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_merge_log (     -- Section 0 manual merge tool
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    primary_customer_id UUID NOT NULL REFERENCES customers(customer_id),
    merged_customer_id  UUID NOT NULL,               -- soft-reference; the merged row is deactivated, not deleted
    merged_by       UUID REFERENCES users(user_id),
    merged_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE credit_ledger_entry_type AS ENUM (
    'SALE_ON_CREDIT', 'PAYMENT_RECEIVED', 'REFUND_ADJUSTMENT', 'OPENING_BALANCE', 'ADJUSTMENT');

CREATE TABLE customer_credit_ledger (  -- 6.1, 6.3
    entry_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    branch_id       UUID REFERENCES branches(branch_id),
    entry_type      credit_ledger_entry_type NOT NULL,
    amount          NUMERIC(14,2) NOT NULL,          -- positive = increases what's owed, negative = reduces it
    balance_after   NUMERIC(14,2) NOT NULL,           -- chain-wide running balance
    ref_table       TEXT,
    ref_id          UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.1.1 DATA-FIX: last-known-cached credit limit/balance, synced to offline-capable devices.
CREATE TABLE customer_credit_cache (
    customer_id     UUID PRIMARY KEY REFERENCES customers(customer_id),
    cached_credit_limit  NUMERIC(14,2) NOT NULL,
    cached_balance_owed  NUMERIC(14,2) NOT NULL,
    cached_at       TIMESTAMPTZ NOT NULL
);

-- ============================================================================
-- SECTION 5 — QUOTATIONS & B2B/CONTRACTOR PRICING
-- ============================================================================

CREATE TYPE quotation_status AS ENUM ('DRAFT', 'APPROVED', 'CONVERTED', 'EXPIRED', 'CANCELLED');

CREATE TABLE quotations (
    quotation_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_number TEXT NOT NULL UNIQUE,
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    status          quotation_status NOT NULL DEFAULT 'DRAFT',
    price_type      price_type NOT NULL DEFAULT 'TAX_EXCLUSIVE',   -- 2.8: quotations default exclusive
    with_gst        BOOLEAN NOT NULL DEFAULT TRUE,                  -- an estimate may be quoted without GST
    place_of_supply_state_code TEXT,
    valid_until     DATE,                                           -- the validity printed on the estimate
    notes           TEXT,
    terms           TEXT,
    stock_reserved  BOOLEAN NOT NULL DEFAULT FALSE,                 -- 5.1: only true if setting is ON and approved
    reservation_hold_until TIMESTAMPTZ,
    converted_invoice_id UUID,                       -- set once the bill made from it is FINALISED
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotation_lines (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id    UUID NOT NULL REFERENCES quotations(quotation_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    product_unit_id UUID REFERENCES product_units(product_unit_id),  -- the unit quoted in (BOX, 100G, ...)
    qty_in_sale_unit NUMERIC(14,4),                   -- as quoted; NULL on rows from before units were quoted
    qty_base_unit   NUMERIC(14,4) NOT NULL CHECK (qty_base_unit > 0),
    rate            NUMERIC(14,4) NOT NULL CHECK (rate >= 0),   -- per BASE unit
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE delivery_challans (      -- Section 5, delivery ahead of final billing
    challan_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challan_number  TEXT NOT NULL UNIQUE,
    quotation_id    UUID REFERENCES quotations(quotation_id),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    status          TEXT NOT NULL DEFAULT 'DELIVERED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_challan_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challan_id      UUID NOT NULL REFERENCES delivery_challans(challan_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL
);

-- ============================================================================
-- SECTION 3 — BILLING / POS (incl. till reconciliation, offline sync)
-- ============================================================================

CREATE TABLE till_sessions (          -- 3.3.1: counter + cashier + shift scope
    session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    counter_id      TEXT NOT NULL,                   -- physical register/counter identifier
    cashier_user_id UUID NOT NULL REFERENCES users(user_id),
    opening_float   NUMERIC(14,2) NOT NULL,           -- [FIX] sole source of the opening float — see below
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at       TIMESTAMPTZ,
    closing_counted_cash NUMERIC(14,2),
    status          TEXT NOT NULL DEFAULT 'OPEN'      -- 'OPEN' | 'CLOSED'
);

-- [FIX] 'OPENING_FLOAT' removed from this enum. Having it as both a till_sessions column AND a possible
-- till_events row created two places the same figure could live, and a naive "opening_float column +
-- SUM(all events)" query would double-count it if anyone ever logged an OPENING_FLOAT event. Fixed by making
-- till_sessions.opening_float the single source of truth for the float; till_events only ever records what
-- happens AFTER the shift starts.
-- CASH_RECEIPT: a customer settling their account in cash at the counter. It is
-- money INTO the drawer that is not a sale, and leaving it out made every shift
-- that collected dues read "over" at close.
CREATE TYPE till_event_type AS ENUM (
    'CASH_SALE', 'CASH_DROP', 'PETTY_EXPENSE_PAYOUT', 'CLOSING_COUNT', 'CASH_RECEIPT'
);  -- 3.3.1 DATA-FIX

CREATE TABLE till_events (
    event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      UUID NOT NULL REFERENCES till_sessions(session_id),
    event_type      till_event_type NOT NULL,
    amount          NUMERIC(14,2) NOT NULL,
    ref_table       TEXT,                              -- e.g. 'expenses' for a PETTY_EXPENSE_PAYOUT
    ref_id          UUID,
    note            TEXT,
    acknowledged_by UUID REFERENCES users(user_id),     -- required for CASH_DROP (manager/owner ack)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Expected Drawer Cash = till_sessions.opening_float
--                        + SUM(till_events.amount WHERE event_type = 'CASH_SALE')     (refunds post negative)
--                        + SUM(till_events.amount WHERE event_type = 'CASH_RECEIPT')
--                        - SUM(till_events.amount WHERE event_type = 'CASH_DROP')
--                        - SUM(till_events.amount WHERE event_type = 'PETTY_EXPENSE_PAYOUT')
-- (3.3.1) — opening_float appears exactly once, from the session row, never from till_events.
-- One OPEN session per counter per branch, enforced here rather than by a racy read.
CREATE UNIQUE INDEX ux_till_sessions_open_counter ON till_sessions(branch_id, counter_id) WHERE status = 'OPEN';

-- [FIX] Gapless, per-branch, per-series document numbering (3.6) implemented as data, not as a
-- Postgres sequence. A real sequence is explicitly WRONG here: sequences are non-transactional, so a
-- rolled-back invoice permanently burns a number and leaves a gap -- exactly what GST forbids. This
-- table is incremented inside the same transaction that finalizes the document under a row lock, so a
-- rollback gives the number back. Separate series per document kind (12.1.1, 4.5.1).
CREATE TABLE document_sequences (
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    series          TEXT NOT NULL,                 -- 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'QUOTATION' | 'GRN' | 'CHALLAN' | 'TRANSFER'
    fiscal_year     TEXT NOT NULL,                 -- '2026-27' -- Indian FY, numbering restarts each year
    prefix          TEXT NOT NULL,
    last_number     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, series, fiscal_year)
);

CREATE TYPE invoice_type AS ENUM ('GST', 'NON_GST');
CREATE TYPE invoice_status AS ENUM ('DRAFT', 'FINAL', 'VOID');

-- [FIX] invoice_number is nullable and only assigned on the DRAFT → FINAL transition (application-layer,
-- e.g. "SELECT nextval(...)" at that moment, not at DRAFT creation). If a DRAFT is later cancelled/deleted
-- without ever being finalized, no number was ever consumed, so the gapless GST sequence (3.6) stays intact.
-- UNIQUE still holds with multiple NULLs, since Postgres treats each NULL as distinct for uniqueness purposes.
CREATE TABLE invoices (
    invoice_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number  TEXT UNIQUE,                       -- NULL while DRAFT; sequential/gapless once FINAL (3.6)
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    till_session_id UUID REFERENCES till_sessions(session_id),
    customer_id     UUID REFERENCES customers(customer_id),   -- nullable: anonymous walk-in cash sale allowed
    invoice_type    invoice_type NOT NULL,
    status          invoice_status NOT NULL DEFAULT 'FINAL',
    subtotal        NUMERIC(14,2) NOT NULL,
    discount_total  NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
    grand_total     NUMERIC(14,2) NOT NULL,
    irn             TEXT,                               -- e-invoice IRN, once turnover threshold applies (15)
    -- [FIX] Offline sync idempotency (3.5): the till generates this id locally and re-sends it until the
    -- server acknowledges. UNIQUE means a retried/duplicated sync can never create a second invoice.
    client_txn_id   UUID UNIQUE,
    place_of_supply_state_code TEXT,                    -- drives CGST+SGST vs IGST (12.1.1 / 15)
    round_off       NUMERIC(14,2) NOT NULL DEFAULT 0,   -- cash rounding, kept explicit for GST reconciliation
    device_created_at TIMESTAMPTZ NOT NULL,             -- local device clock — for offline billing
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- authoritative for sync-conflict ordering (3.5.1)
    is_offline_conflict BOOLEAN NOT NULL DEFAULT FALSE,  -- STOCK_CONFLICT flag (3.5.1 ENG-FIX)
    conflict_resolved_by UUID REFERENCES users(user_id),
    created_by      UUID REFERENCES users(user_id),
    -- Free text the cashier can put on the bill (delivery instruction, site name).
    -- Editable while DRAFT, frozen once FINAL like everything else.
    notes           TEXT,
    -- The document fields a GST tax invoice carries alongside the items (Section 19).
    -- All optional; all frozen at finalisation with the rest of the bill.
    due_date        DATE,
    order_no        TEXT,                               -- buyer's order / PO reference
    challan_no      TEXT,
    challan_date    DATE,
    vehicle_no      TEXT,
    place_of_delivery TEXT,
    -- The estimate this bill was made from. The estimate is marked converted only
    -- when THIS invoice is finalised, so a discarded draft leaves it convertible.
    source_quotation_id UUID REFERENCES quotations(quotation_id),
    -- A draft is edited repeatedly before it becomes a commercial document, so it
    -- needs a "last touched" that is separate from when it was first opened.
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_final_invoice_has_number
        CHECK (status <> 'FINAL' OR invoice_number IS NOT NULL)   -- enforces the rule above, not just documents it
);

CREATE TABLE invoice_lines (
    line_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(invoice_id),
    -- The order the lines were rung up in. line_id is a random UUID, so ordering
    -- by it shuffled the items on every printed bill.
    line_no         SMALLINT NOT NULL DEFAULT 0,
    product_id      UUID NOT NULL REFERENCES products(product_id),
    product_unit_id UUID REFERENCES product_units(product_unit_id),  -- which sale unit the cashier picked (2.2.1)
    qty_in_sale_unit NUMERIC(14,4) NOT NULL CHECK (qty_in_sale_unit > 0),
    base_unit_qty   NUMERIC(14,4) NOT NULL CHECK (base_unit_qty > 0),  -- converted qty, what stock_ledger/tax actually use (2.2.1)
    price_type      price_type NOT NULL,               -- inclusive/exclusive, locked at scan time (3.10)
    rate_locked_at_scan NUMERIC(14,4) NOT NULL CHECK (rate_locked_at_scan >= 0),  -- per BASE unit, snapshot at scan (3.10)
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    taxable_value   NUMERIC(14,2) NOT NULL,
    cgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,   -- rounded half-up at LINE level (3.1.1)
    sgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    -- [FIX] line_total is now a GENERATED column, not a plain NOT NULL one the app computes and could get
    -- wrong (e.g. a missing HSN mapping silently leaving cgst/sgst at 0 while line_total still reflects the
    -- full tax-inclusive price) — this is stronger than a CHECK: it's not possible to insert a mismatched
    -- value at all, so a GSTR-1-invalidating line can't reach the database no matter what the app does wrong.
    line_total      NUMERIC(14,2) GENERATED ALWAYS AS (taxable_value + cgst_amount + sgst_amount + igst_amount) STORED,
    batch_id        UUID REFERENCES stock_batches(batch_id)
    -- [FIX] No serial_id column here. A single line can sell qty > 1 serialized units (e.g. 3 power drills
    -- on one line) — a single serial_id FK could only ever record one of them, silently losing the rest.
    -- Verified by test insert: a 3-serial sale against one invoice_line_id succeeds cleanly via the
    -- one-to-many stock_serials.invoice_line_id relationship below; there is no need for a reverse column,
    -- and keeping one would just be a second, narrower, easily-inconsistent source of the same fact.
);
ALTER TABLE stock_serials ADD CONSTRAINT fk_serial_invoice_line
    FOREIGN KEY (invoice_line_id) REFERENCES invoice_lines(line_id);
-- To find the serial(s) sold on a given line: SELECT * FROM stock_serials WHERE invoice_line_id = ?

CREATE TYPE payment_method AS ENUM ('CASH', 'UPI', 'CARD', 'CREDIT', 'LOYALTY_POINTS', 'BANK_TRANSFER');

CREATE TABLE invoice_payments (       -- 3.2 split payment
    payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(invoice_id),
    method          payment_method NOT NULL,
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    ref_no          TEXT                                -- UPI txn id / card auth code / bank UTR
);
CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);

-- 6.3 — money a customer pays against their ACCOUNT (not at the moment of a
-- sale). The credit-ledger entry is the balance; this is the receipt behind it:
-- its own number, how it was paid, and — for cash — the drawer it went into.
CREATE TABLE customer_payments (
    payment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_number  TEXT NOT NULL UNIQUE,
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    method          TEXT NOT NULL,
    reference       TEXT,
    notes           TEXT,
    till_session_id UUID REFERENCES till_sessions(session_id),
    client_txn_id   UUID UNIQUE,                     -- a double-tapped "Record payment" records it once
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_customer_payment_method CHECK (method IN ('CASH','UPI','CARD','BANK_TRANSFER','CHEQUE'))
);
CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id, created_at DESC);

-- A receipt or supplier payment recorded by mistake (wrong amount, wrong customer)
-- is CANCELLED, never edited or deleted: the payment row stays, this row records
-- who cancelled it and why, and a reversing ADJUSTMENT goes to the ledger. Every
-- total that sums payments excludes cancelled ones.
CREATE TABLE payment_cancellations (
    cancellation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_table   TEXT NOT NULL CHECK (payment_table IN ('customer_payments', 'vendor_payments')),
    payment_id      UUID NOT NULL,
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    reason          TEXT NOT NULL,
    cancelled_by    UUID REFERENCES users(user_id),
    cancelled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (payment_table, payment_id)
);

CREATE TABLE paint_tint_records (     -- 2.3
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_line_id UUID NOT NULL REFERENCES invoice_lines(line_id),
    base_shade      TEXT,
    tint_formula    TEXT,
    notes           TEXT
);

-- ============================================================================
-- SECTION 12 — RETURNS, REFUNDS, WARRANTY (incl. GST credit notes, loyalty hierarchy)
-- ============================================================================

CREATE TABLE credit_notes (           -- 12.1.1 ENG-FIX: separate numbered series
    credit_note_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_number TEXT NOT NULL UNIQUE,
    invoice_id      UUID NOT NULL REFERENCES invoices(invoice_id),
    reason          TEXT NOT NULL,
    total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,  -- [FIX] maintained by trigger below, not app-computed
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- [FIX] Return-line tax must be computed PROPORTIONALLY off the original line's effective rate, not
-- re-derived independently, or a partial return (e.g. 1 of 3 units on a line with a multi-item discount)
-- drifts from the original invoice tax by rounding cents:
--   return_taxable_value = (invoice_lines.taxable_value / invoice_lines.qty_in_sale_unit) * returned_qty
--   line tax = ROUND(return_taxable_value * gst_rate_pct / 100, 2)   -- half-up, same rule as 3.1.1
-- That computation happens in the application/service layer (it needs the original line + current HSN rate);
-- what the schema enforces is the OTHER half of this problem — that credit_notes.total_amount can never
-- silently drift from the sum of its own lines, via trigger rather than trusting every call site to get it right.
CREATE TABLE credit_note_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_id  UUID NOT NULL REFERENCES credit_notes(credit_note_id),
    invoice_line_id UUID NOT NULL REFERENCES invoice_lines(line_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL,
    taxable_value   NUMERIC(14,2) NOT NULL,
    cgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(14,2) GENERATED ALWAYS AS (taxable_value + cgst_amount + sgst_amount + igst_amount) STORED
);

CREATE OR REPLACE FUNCTION fn_sync_credit_note_total() RETURNS TRIGGER AS $$
BEGIN
    UPDATE credit_notes
    SET total_amount = COALESCE((
        SELECT SUM(line_total) FROM credit_note_lines
        WHERE credit_note_id = COALESCE(NEW.credit_note_id, OLD.credit_note_id)
    ), 0)
    WHERE credit_note_id = COALESCE(NEW.credit_note_id, OLD.credit_note_id);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_credit_note_total
    AFTER INSERT OR UPDATE OR DELETE ON credit_note_lines
    FOR EACH ROW EXECUTE FUNCTION fn_sync_credit_note_total();
-- credit_notes.total_amount is now impossible to drift from SUM(credit_note_lines.line_total) — the database
-- recomputes it on every line insert/update/delete, so no application code path can leave it stale.

CREATE TYPE return_line_condition AS ENUM ('RESELLABLE', 'DAMAGED');

CREATE TABLE sales_returns (          -- 12.1
    return_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(invoice_id),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    credit_note_id  UUID REFERENCES credit_notes(credit_note_id),   -- NULL only for non-GST returns
    refund_method   payment_method,
    refund_total    NUMERIC(14,2) NOT NULL DEFAULT 0,   -- cash/UPI/card actually refunded (11.2.1 step 3)
    store_credit_total NUMERIC(14,2) NOT NULL DEFAULT 0,-- 12.1 "store credit" refund option
    return_reason   TEXT,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_return_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id       UUID NOT NULL REFERENCES sales_returns(return_id),
    invoice_line_id UUID NOT NULL REFERENCES invoice_lines(line_id),
    qty_base_unit   NUMERIC(14,4) NOT NULL,
    condition       return_line_condition NOT NULL,
    points_earned_reversed   INTEGER NOT NULL DEFAULT 0,   -- 11.2.1 refund hierarchy step 1
    points_redeemed_restored INTEGER NOT NULL DEFAULT 0,   -- 11.2.1 refund hierarchy step 2
    cash_refund_amount       NUMERIC(14,2) NOT NULL DEFAULT 0  -- 11.2.1 refund hierarchy step 3
);

CREATE TABLE warranties (             -- 12.2
    warranty_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID REFERENCES products(product_id),
    category_id     UUID REFERENCES categories(category_id),
    duration_months SMALLINT NOT NULL,
    CONSTRAINT chk_warranty_target CHECK (product_id IS NOT NULL OR category_id IS NOT NULL)
);

-- 12.3 return window, overridable per category (the chain-wide default lives in admin_settings).
CREATE TABLE return_windows (
    category_id     UUID PRIMARY KEY REFERENCES categories(category_id),
    window_days     SMALLINT NOT NULL
);

CREATE TYPE warranty_claim_status AS ENUM ('OPEN', 'SENT_TO_VENDOR', 'REPLACED', 'REPAIRED', 'REFUNDED', 'REJECTED');

CREATE TABLE warranty_claims (        -- 12.2, 14 (RMA)
    claim_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_line_id UUID NOT NULL REFERENCES invoice_lines(line_id),
    serial_id       UUID REFERENCES stock_serials(serial_id),
    rma_number      TEXT UNIQUE,                       -- vendor-side return authorization (14)
    vendor_id       UUID REFERENCES vendors(vendor_id),
    status          warranty_claim_status NOT NULL DEFAULT 'OPEN',
    claim_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    resolved_at     TIMESTAMPTZ
);

-- 3.5.1 ENG-FIX: a later-arriving offline sale against now-insufficient stock is neither silently
-- oversold nor auto-voided -- it lands here as a STOCK_CONFLICT for a human at that branch to resolve.
CREATE TABLE stock_conflicts (
    conflict_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    invoice_id      UUID NOT NULL REFERENCES invoices(invoice_id),
    product_id      UUID NOT NULL REFERENCES products(product_id),
    requested_qty   NUMERIC(14,4) NOT NULL,
    available_qty   NUMERIC(14,4) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'OPEN',   -- 'OPEN' | 'RESOLVED'
    resolution      TEXT,                            -- 'SUBSTITUTED' | 'BACKORDERED' | 'NEGATIVE_STOCK_OVERRIDE' | 'CANCELLED'
    resolved_by     UUID REFERENCES users(user_id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_stock_conflict_status CHECK (status IN ('OPEN','RESOLVED'))
);

-- ============================================================================
-- SECTION 11 — CRM, MARKETING, LOYALTY
-- ============================================================================

CREATE TYPE loyalty_txn_type AS ENUM ('EARN', 'REDEEM', 'REVOKE', 'RESTORE', 'EXPIRE');

CREATE TABLE loyalty_transactions (   -- 11.2, 11.2.1
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID NOT NULL REFERENCES customers(customer_id),
    invoice_id      UUID REFERENCES invoices(invoice_id),
    sales_return_id UUID REFERENCES sales_returns(return_id),
    txn_type        loyalty_txn_type NOT NULL,
    points          INTEGER NOT NULL,                  -- signed
    balance_after   INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE marketing_campaigns (    -- 11.1
    campaign_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    campaign_type   TEXT NOT NULL,                     -- 'BIRTHDAY' | 'FESTIVAL' | 'WINBACK'
    segment_query   JSONB,                               -- filter definition for target customer list
    message_template TEXT NOT NULL,
    scheduled_at    TIMESTAMPTZ,
    created_by      UUID REFERENCES users(user_id)
);

CREATE TABLE whatsapp_message_log (   -- 1 req#4, 6.2, 11.1, 14 admin digest
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(customer_id),
    invoice_id      UUID REFERENCES invoices(invoice_id),
    campaign_id     UUID REFERENCES marketing_campaigns(campaign_id),
    to_phone        TEXT NOT NULL,
    message_type    TEXT NOT NULL,                      -- 'INVOICE_PDF' | 'DUE_REMINDER' | 'BIRTHDAY' | 'ADMIN_DIGEST' | ...
    body            TEXT,
    -- NOT_CONFIGURED: no WhatsApp Business credentials, so nothing was sent. It is
    -- never recorded as SENT — the system does not claim a delivery it did not make.
    status          TEXT NOT NULL DEFAULT 'QUEUED',      -- 'QUEUED' | 'SENT' | 'FAILED' | 'FALLBACK_SMS' | 'NOT_CONFIGURED'
    attempts        SMALLINT NOT NULL DEFAULT 0,
    last_error      TEXT,
    queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,
    CONSTRAINT chk_wa_status CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','FALLBACK_SMS','NOT_CONFIGURED'))
);
CREATE INDEX idx_whatsapp_queue ON whatsapp_message_log(status, queued_at);

-- ============================================================================
-- SECTION 9 — EXPENSES
-- ============================================================================

CREATE TABLE expense_categories (
    category_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE
);

CREATE TYPE expense_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- [FIX] No dedicated till_event_id FK here. Tested directly: it was NOT actually a circular-FK deadlock
-- (both sides were nullable, so a sequential insert-then-update works fine) — but it WAS two independent
-- paths to the same fact (this typed FK, and till_events.ref_table='expenses'/ref_id=expense_id), which can
-- silently drift apart if one side is updated and the other forgotten. Removed the special-cased column so
-- expenses<->till_events uses the same single polymorphic ref_table/ref_id pattern every other cross-reference
-- in this schema already uses (audit_log, vendor_ledger, customer_credit_ledger, stock_writeoffs, ...).
CREATE TABLE expenses (
    expense_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    category_id     UUID NOT NULL REFERENCES expense_categories(category_id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    -- The day the money was spent, which is what the books and the monthly
    -- comparison are about — not the moment someone got round to typing it in.
    expense_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    payment_method  TEXT NOT NULL DEFAULT 'CASH',
    payee           TEXT,                              -- who was paid (landlord, electrician, transporter)
    reference       TEXT,                              -- bill / receipt / UTR number
    description     TEXT,
    receipt_url     TEXT,
    paid_from_till_session_id UUID REFERENCES till_sessions(session_id), -- 3.3.1 PETTY_EXPENSE_PAYOUT link
    status          expense_status NOT NULL DEFAULT 'PENDING',
    approved_by     UUID REFERENCES users(user_id),
    reject_reason   TEXT,
    created_by      UUID REFERENCES users(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_expense_payment_method CHECK (payment_method IN ('CASH','UPI','CARD','BANK_TRANSFER','CHEQUE'))
);
-- To find the till_event (if any) that paid a given expense as PETTY_EXPENSE_PAYOUT:
--   SELECT * FROM till_events WHERE ref_table = 'expenses' AND ref_id = <expense_id>;

-- ============================================================================
-- SECTION 10 — HR / STAFF
-- ============================================================================

CREATE TABLE employees (
    employee_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(user_id),   -- one staff record per person
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    designation     TEXT,
    joined_at       DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE attendance (              -- 10.1
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(employee_id),
    work_date       DATE NOT NULL,
    check_in        TIMESTAMPTZ,
    check_out       TIMESTAMPTZ,
    method          TEXT NOT NULL DEFAULT 'APP_CHECKIN',  -- 'APP_CHECKIN' | 'BIOMETRIC' | 'MANUAL'
    UNIQUE (employee_id, work_date)
);

CREATE TABLE shifts (
    shift_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL REFERENCES branches(branch_id),
    name            TEXT NOT NULL,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL
);

CREATE TABLE employee_shifts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(employee_id),
    shift_id        UUID NOT NULL REFERENCES shifts(shift_id),
    work_date       DATE NOT NULL
);

CREATE TABLE leave_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(employee_id),
    from_date       DATE NOT NULL,
    to_date         DATE NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    approved_by     UUID REFERENCES users(user_id)
);

CREATE TABLE payroll_entries (         -- 10.3, Phase 2+
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     UUID NOT NULL REFERENCES employees(employee_id),
    pay_month       DATE NOT NULL,                      -- first-of-month convention
    base_salary     NUMERIC(14,2) NOT NULL,
    incentives      NUMERIC(14,2) NOT NULL DEFAULT 0,
    deductions      NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_pay         NUMERIC(14,2) NOT NULL,
    UNIQUE (employee_id, pay_month)
);

-- Sales attribution (10.2) — tags who made the sale, on the invoice itself.
ALTER TABLE invoices ADD COLUMN sold_by_employee_id UUID REFERENCES employees(employee_id);

-- ============================================================================
-- SECTION 16 — TRAINING & DOCUMENTATION
-- ============================================================================

CREATE TABLE training_journals (
    journal_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_type    TEXT NOT NULL,                      -- 'ADMIN' | 'STAFF'
    language        TEXT NOT NULL,                       -- 'en' | 'hi'
    version         INTEGER NOT NULL DEFAULT 1,
    content_url     TEXT NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- SECTION 15 — COMPLIANCE & BACKUP
-- ============================================================================

-- Written ONLY by the backup and restore-test scripts (apps/api/scripts), which
-- run pg_dump / pg_restore and record what they actually did. No endpoint can
-- claim a backup or a restore test that did not happen.
CREATE TABLE backups (
    backup_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    taken_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    storage_ref     TEXT NOT NULL,                       -- where the dump file is
    status          TEXT NOT NULL DEFAULT 'COMPLETED',
    size_bytes      BIGINT,
    checksum_sha256 TEXT,                                -- of the dump file, verified before recording
    table_count     INTEGER,                             -- tables listed by pg_restore --list
    restore_tested_at TIMESTAMPTZ,                       -- documented DR test (15)
    restore_test_notes TEXT,                             -- what the restore test checked, and found
    CONSTRAINT chk_backup_status CHECK (status IN ('COMPLETED', 'FAILED'))
);

-- ============================================================================
-- INDEXES (representative — expand per actual query patterns during build)
-- ============================================================================

CREATE INDEX idx_branch_stock_product ON branch_stock(product_id);
CREATE INDEX idx_stock_ledger_branch_product ON stock_ledger(branch_id, product_id, created_at);
-- The movement log reads newest first, chain-wide and per branch.
CREATE INDEX idx_stock_ledger_created ON stock_ledger(created_at DESC);
CREATE INDEX idx_stock_ledger_branch_created ON stock_ledger(branch_id, created_at DESC);
CREATE INDEX idx_invoices_branch_date ON invoices(branch_id, server_received_at);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);  -- requires pg_trgm, for fuzzy search (2)
CREATE INDEX idx_credit_ledger_customer ON customer_credit_ledger(customer_id, created_at);
CREATE INDEX idx_till_events_session ON till_events(session_id);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_stock_ledger_ref ON stock_ledger(ref_table, ref_id);
CREATE INDEX idx_expenses_branch_status ON expenses(branch_id, status, created_at DESC);
CREATE INDEX idx_grn_branch ON grn(branch_id, received_at DESC);
CREATE INDEX idx_quotations_branch ON quotations(branch_id, created_at DESC);
CREATE INDEX idx_sales_returns_branch ON sales_returns(branch_id, created_at DESC);
-- "Has this bill had a return?" is asked for every row of the bill list.
CREATE INDEX idx_sales_returns_invoice ON sales_returns(invoice_id);
CREATE INDEX idx_attendance_employee_date ON attendance(employee_id, work_date DESC);
CREATE INDEX idx_employees_branch ON employees(branch_id);
CREATE INDEX idx_product_prices_current ON product_prices(product_id) WHERE effective_to IS NULL;
CREATE INDEX idx_stock_conflicts_open ON stock_conflicts(branch_id, status);
CREATE INDEX idx_users_branch_role ON users(branch_id, role);
-- The chain-wide bill list (Owner on All branches) reads newest first.
CREATE INDEX idx_invoices_received ON invoices(server_received_at DESC);
CREATE INDEX idx_invoices_customer ON invoices(customer_id, server_received_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_invoices_status_date ON invoices(status, server_received_at DESC);
CREATE INDEX idx_invoices_number_trgm ON invoices USING gin (invoice_number gin_trgm_ops);
CREATE INDEX idx_invoice_payments_ref ON invoice_payments(ref_no) WHERE ref_no IS NOT NULL;
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE INDEX idx_vendors_name_trgm ON vendors USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand ON products(brand_id);
CREATE INDEX idx_product_barcodes_product ON product_barcodes(product_id);
CREATE INDEX idx_product_units_product ON product_units(product_id);
CREATE INDEX idx_quotations_customer ON quotations(customer_id, created_at DESC);
CREATE INDEX idx_grn_vendor ON grn(vendor_id, received_at DESC);
CREATE INDEX idx_vendor_ledger_vendor ON vendor_ledger(vendor_id, created_at);
CREATE INDEX idx_sales_return_lines_line ON sales_return_lines(invoice_line_id);
CREATE INDEX idx_credit_notes_invoice ON credit_notes(invoice_id);
CREATE INDEX idx_loyalty_customer ON loyalty_transactions(customer_id, created_at DESC);
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX idx_expenses_date ON expenses(branch_id, expense_date DESC);

-- ============================================================================
-- GAPLESS DOCUMENT NUMBERING (3.6, 4.5.1, 12.1.1)
-- ============================================================================
-- Called inside the SAME transaction that finalizes the document. The row lock
-- serialises concurrent tills at one branch; a rollback returns the number, so
-- the sequence stays gapless -- which a Postgres SEQUENCE could never guarantee.
-- Indian fiscal year (1 Apr - 31 Mar), the period GST document numbering restarts on.
CREATE OR REPLACE FUNCTION erp_fiscal_year(p_at TIMESTAMPTZ DEFAULT now()) RETURNS TEXT
    LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN EXTRACT(MONTH FROM p_at) >= 4
        THEN EXTRACT(YEAR FROM p_at)::INT || '-' || LPAD(((EXTRACT(YEAR FROM p_at)::INT + 1) % 100)::TEXT, 2, '0')
        ELSE (EXTRACT(YEAR FROM p_at)::INT - 1) || '-' || LPAD((EXTRACT(YEAR FROM p_at)::INT % 100)::TEXT, 2, '0')
    END
$$;

-- The prefix of a NEW series row carries the branch code (INV-AND, CN-THA). Every
-- *_number column is UNIQUE chain-wide, so two branches drawing plain 'CN' would
-- both print CN/2026-27/00001 and the second credit note would be refused — and
-- the same would happen to every series on the first day of each fiscal year.
CREATE OR REPLACE FUNCTION next_document_number(
    p_branch_id UUID, p_series TEXT, p_fiscal_year TEXT, p_prefix TEXT
) RETURNS TEXT AS $$
DECLARE
    v_next  BIGINT;
    v_prefix TEXT;
    v_code  TEXT;
BEGIN
    SELECT code INTO v_code FROM branches WHERE branch_id = p_branch_id;
    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Unknown branch % for document numbering', p_branch_id;
    END IF;

    INSERT INTO document_sequences (branch_id, series, fiscal_year, prefix, last_number)
    VALUES (p_branch_id, p_series, p_fiscal_year, p_prefix || '-' || v_code, 0)
    ON CONFLICT (branch_id, series, fiscal_year) DO NOTHING;

    UPDATE document_sequences
       SET last_number = last_number + 1
     WHERE branch_id = p_branch_id AND series = p_series AND fiscal_year = p_fiscal_year
    RETURNING last_number, prefix INTO v_next, v_prefix;

    RETURN v_prefix || '/' || p_fiscal_year || '/' || LPAD(v_next::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- What is still owed on each supplier bill, oldest first (FIFO).
--
-- A payment made against a named bill settles that bill. A payment made "on
-- account" settles the opening balance first and then the OLDEST open bills —
-- the way a supplier's statement reads. Without this, a vendor paid in full on
-- account would still show every bill as unpaid and every account as overdue.
-- SECURITY INVOKER: row-level security applies as for any other read.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erp_vendor_bill_dues(p_vendor_id UUID DEFAULT NULL)
RETURNS TABLE (grn_id UUID, vendor_id UUID, received_at TIMESTAMPTZ, net_amount NUMERIC,
               paid_direct NUMERIC, paid_on_account NUMERIC, amount_due NUMERIC)
LANGUAGE sql STABLE AS $$
    WITH bills AS (
        SELECT g.grn_id, g.vendor_id, g.received_at,
               g.grand_total - COALESCE((SELECT SUM(dn.total_amount) FROM vendor_debit_notes dn
                                          WHERE dn.grn_id = g.grn_id), 0) AS net_amount,
               COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp WHERE vp.grn_id = g.grn_id
                          AND NOT EXISTS (SELECT 1 FROM payment_cancellations pc
                                           WHERE pc.payment_table = 'vendor_payments' AND pc.payment_id = vp.payment_id)), 0) AS paid_direct
          FROM grn g
         WHERE p_vendor_id IS NULL OR g.vendor_id = p_vendor_id
    ), pool AS (
        SELECT v.vendor_id,
               GREATEST(COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp
                                   WHERE vp.vendor_id = v.vendor_id AND vp.grn_id IS NULL
                                     AND NOT EXISTS (SELECT 1 FROM payment_cancellations pc
                                                      WHERE pc.payment_table = 'vendor_payments' AND pc.payment_id = vp.payment_id)), 0)
                        - GREATEST(v.opening_balance, 0), 0) AS on_account
          FROM vendors v
         WHERE p_vendor_id IS NULL OR v.vendor_id = p_vendor_id
    ), open_bills AS (
        SELECT b.*, GREATEST(b.net_amount - b.paid_direct, 0) AS open_amount,
               COALESCE(SUM(GREATEST(b.net_amount - b.paid_direct, 0))
                        OVER (PARTITION BY b.vendor_id ORDER BY b.received_at, b.grn_id
                              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS open_before
          FROM bills b
    )
    SELECT o.grn_id, o.vendor_id, o.received_at, round(o.net_amount, 2), round(o.paid_direct, 2),
           round(LEAST(GREATEST(p.on_account - o.open_before, 0), o.open_amount), 2),
           round(o.open_amount - LEAST(GREATEST(p.on_account - o.open_before, 0), o.open_amount), 2)
      FROM open_bills o JOIN pool p ON p.vendor_id = o.vendor_id
$$;

-- ----------------------------------------------------------------------------
-- A customer's balance and the date of the OLDEST charge still unpaid, with
-- payments applied to the oldest charges first. "Days outstanding" is measured
-- from that date — not from the first credit sale the customer ever had.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION erp_customer_dues(p_customer_id UUID DEFAULT NULL)
RETURNS TABLE (customer_id UUID, balance NUMERIC, oldest_unpaid_at TIMESTAMPTZ, last_activity TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
    WITH bal AS (
        SELECT l.customer_id, SUM(l.amount) AS balance, MAX(l.created_at) AS last_activity
          FROM customer_credit_ledger l
         WHERE p_customer_id IS NULL OR l.customer_id = p_customer_id
         GROUP BY l.customer_id
    ), charges AS (
        SELECT l.customer_id, l.created_at,
               COALESCE(SUM(l.amount) OVER (PARTITION BY l.customer_id ORDER BY l.created_at DESC, l.entry_id DESC
                                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS newer_charges
          FROM customer_credit_ledger l
         WHERE l.amount > 0 AND (p_customer_id IS NULL OR l.customer_id = p_customer_id)
    )
    SELECT b.customer_id, round(b.balance, 2),
           (SELECT MIN(c.created_at) FROM charges c
             WHERE c.customer_id = b.customer_id AND c.newer_charges < b.balance - 0.005),
           b.last_activity
      FROM bal b
$$;

-- ============================================================================
-- ROW-LEVEL SECURITY (Section 0 — "a branch user's session is filtered to
-- branch_id = their branch for all normal screens"; Section 7.1 role matrix)
-- ============================================================================
-- These functions read the per-transaction GUCs the API sets on every request.
-- current_setting(..., true) returns NULL when unset, so an unauthenticated
-- connection sees nothing at all rather than everything.

CREATE OR REPLACE FUNCTION erp_role() RETURNS TEXT
    LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('erp.role', true), '') $$;

CREATE OR REPLACE FUNCTION erp_user_id() RETURNS UUID
    LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('erp.user_id', true), '')::UUID $$;

CREATE OR REPLACE FUNCTION erp_branch_id() RETURNS UUID
    LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('erp.branch_id', true), '')::UUID $$;

CREATE OR REPLACE FUNCTION erp_authenticated() RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$ SELECT erp_role() IS NOT NULL $$;

CREATE OR REPLACE FUNCTION erp_is_admin() RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$ SELECT erp_role() = 'OWNER_ADMIN' $$;

-- Strict branch match: NULL branch_id is NOT visible to a branch user.
CREATE OR REPLACE FUNCTION erp_branch_ok(b UUID) RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
    SELECT erp_role() IS NOT NULL
       AND (erp_role() = 'OWNER_ADMIN' OR (b IS NOT NULL AND b = erp_branch_id()))
$$;

-- Lenient branch match: a NULL branch_id means "chain-wide row", visible to everyone.
CREATE OR REPLACE FUNCTION erp_branch_ok_nullable(b UUID) RETURNS BOOLEAN
    LANGUAGE sql STABLE AS $$
    SELECT erp_role() IS NOT NULL
       AND (erp_role() = 'OWNER_ADMIN' OR b IS NULL OR b = erp_branch_id())
$$;

-- ---------------------------------------------------------------------------
-- Policies. Every table has RLS ON, so an app connection with no session GUCs
-- set sees an empty database rather than the whole chain.
-- ---------------------------------------------------------------------------

-- Chain-wide master data: readable by any authenticated session (Section 0:
-- "master data is global, stock is local"). Write authority is enforced by the
-- API's role matrix (7.1) on top of this.
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY branches_rls ON branches USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY categories_rls ON categories USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY brands_rls ON brands USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_rls ON products USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE product_units ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_units_rls ON product_units USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE product_barcodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_barcodes_rls ON product_barcodes USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE hsn_tax_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY hsn_tax_rates_rls ON hsn_tax_rates USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE bundles ENABLE ROW LEVEL SECURITY;
CREATE POLICY bundles_rls ON bundles USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE bundle_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY bundle_items_rls ON bundle_items USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendors_rls ON vendors USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE vendor_product_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_product_map_rls ON vendor_product_map USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_rls ON customers USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE customer_merge_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_merge_log_rls ON customer_merge_log USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE customer_credit_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_credit_cache_rls ON customer_credit_cache USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE warranties ENABLE ROW LEVEL SECURITY;
CREATE POLICY warranties_rls ON warranties USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE return_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY return_windows_rls ON return_windows USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE warranty_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY warranty_claims_rls ON warranty_claims
    USING (EXISTS (SELECT 1 FROM invoice_lines il WHERE il.line_id = warranty_claims.invoice_line_id))
    WITH CHECK (EXISTS (SELECT 1 FROM invoice_lines il WHERE il.line_id = warranty_claims.invoice_line_id));
ALTER TABLE loyalty_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY loyalty_transactions_rls ON loyalty_transactions USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY marketing_campaigns_rls ON marketing_campaigns USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE whatsapp_message_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_message_log_rls ON whatsapp_message_log USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY expense_categories_rls ON expense_categories USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE training_journals ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_journals_rls ON training_journals USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE backups ENABLE ROW LEVEL SECURITY;
CREATE POLICY backups_rls ON backups USING (erp_authenticated()) WITH CHECK (erp_authenticated());
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
CREATE POLICY units_rls ON units USING (erp_authenticated()) WITH CHECK (erp_authenticated());
-- A user may read their own branch grants (the API resolves the active branch
-- from them); only an Owner can grant or revoke.
ALTER TABLE user_branch_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_branch_access_rls ON user_branch_access
    USING (erp_is_admin() OR user_id = erp_user_id())
    WITH CHECK (erp_is_admin());
ALTER TABLE paint_tint_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY paint_tint_records_rls ON paint_tint_records
    USING (EXISTS (SELECT 1 FROM invoice_lines il WHERE il.line_id = paint_tint_records.invoice_line_id))
    WITH CHECK (EXISTS (SELECT 1 FROM invoice_lines il WHERE il.line_id = paint_tint_records.invoice_line_id));

-- Branch-local data: a non-admin session is physically confined to its own branch.
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_rls ON invoices USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE till_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY till_sessions_rls ON till_sessions USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE branch_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY branch_stock_rls ON branch_stock USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_ledger_rls ON stock_ledger USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_batches_rls ON stock_batches USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_serials ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_serials_rls ON stock_serials USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE grn ENABLE ROW LEVEL SECURITY;
CREATE POLICY grn_rls ON grn USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_rls ON purchase_orders USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE vendor_debit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_debit_notes_rls ON vendor_debit_notes USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_audits ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_audits_rls ON stock_audits USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_writeoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_writeoffs_rls ON stock_writeoffs USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY quotations_rls ON quotations USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE delivery_challans ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_challans_rls ON delivery_challans USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY expenses_rls ON expenses USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_cancellations ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_cancellations_rls ON payment_cancellations USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
CREATE POLICY employees_rls ON employees USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY shifts_rls ON shifts USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE sales_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_returns_rls ON sales_returns USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_conflicts_rls ON stock_conflicts USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_sequences_rls ON document_sequences USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE customer_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_payments_rls ON customer_payments USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_payments_rls ON vendor_payments USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_adjustments_rls ON stock_adjustments USING (erp_branch_ok(branch_id)) WITH CHECK (erp_branch_ok(branch_id));

-- Branch-local data where a NULL branch_id legitimately means "chain-wide row".
-- Vendors are chain-wide master data, so their payable balance is as well: a
-- per-branch view produced a running balance that was wrong for any vendor
-- supplying more than one branch. Writes are still confined to the caller's branch.
ALTER TABLE vendor_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_ledger_rls ON vendor_ledger
    USING (erp_authenticated())
    WITH CHECK (erp_branch_ok_nullable(branch_id));
-- [FIX] Customer identity is chain-wide (Section 0), so the credit ledger must be
-- too. Scoping it per branch meant a customer with one Rs.50,000 limit could draw
-- Rs.50,000 at EVERY branch, and made balance_after a running total over rows the
-- session could see rather than over the customer's actual history.
ALTER TABLE customer_credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_credit_ledger_rls ON customer_credit_ledger
    USING (erp_authenticated())
    WITH CHECK (erp_branch_ok_nullable(branch_id));
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_rls ON audit_log USING (erp_branch_ok_nullable(branch_id)) WITH CHECK (erp_branch_ok_nullable(branch_id));
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_settings_rls ON admin_settings USING (erp_branch_ok_nullable(branch_id)) WITH CHECK (erp_branch_ok_nullable(branch_id));
ALTER TABLE product_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_prices_rls ON product_prices USING (erp_branch_ok_nullable(branch_id)) WITH CHECK (erp_branch_ok_nullable(branch_id));

-- Child rows inherit their parent's branch scope.
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_lines_rls ON invoice_lines
    USING (EXISTS (SELECT 1 FROM invoices _p WHERE _p.invoice_id = invoice_lines.invoice_id))
    WITH CHECK (EXISTS (SELECT 1 FROM invoices _p WHERE _p.invoice_id = invoice_lines.invoice_id));
ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_payments_rls ON invoice_payments
    USING (EXISTS (SELECT 1 FROM invoices _p WHERE _p.invoice_id = invoice_payments.invoice_id))
    WITH CHECK (EXISTS (SELECT 1 FROM invoices _p WHERE _p.invoice_id = invoice_payments.invoice_id));
ALTER TABLE till_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY till_events_rls ON till_events
    USING (EXISTS (SELECT 1 FROM till_sessions _p WHERE _p.session_id = till_events.session_id))
    WITH CHECK (EXISTS (SELECT 1 FROM till_sessions _p WHERE _p.session_id = till_events.session_id));
ALTER TABLE grn_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY grn_lines_rls ON grn_lines
    USING (EXISTS (SELECT 1 FROM grn _p WHERE _p.grn_id = grn_lines.grn_id))
    WITH CHECK (EXISTS (SELECT 1 FROM grn _p WHERE _p.grn_id = grn_lines.grn_id));
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_lines_rls ON purchase_order_lines
    USING (EXISTS (SELECT 1 FROM purchase_orders _p WHERE _p.po_id = purchase_order_lines.po_id))
    WITH CHECK (EXISTS (SELECT 1 FROM purchase_orders _p WHERE _p.po_id = purchase_order_lines.po_id));
ALTER TABLE vendor_debit_note_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_debit_note_lines_rls ON vendor_debit_note_lines
    USING (EXISTS (SELECT 1 FROM vendor_debit_notes _p WHERE _p.debit_note_id = vendor_debit_note_lines.debit_note_id))
    WITH CHECK (EXISTS (SELECT 1 FROM vendor_debit_notes _p WHERE _p.debit_note_id = vendor_debit_note_lines.debit_note_id));
ALTER TABLE stock_audit_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_audit_lines_rls ON stock_audit_lines
    USING (EXISTS (SELECT 1 FROM stock_audits _p WHERE _p.audit_id = stock_audit_lines.audit_id))
    WITH CHECK (EXISTS (SELECT 1 FROM stock_audits _p WHERE _p.audit_id = stock_audit_lines.audit_id));
ALTER TABLE quotation_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY quotation_lines_rls ON quotation_lines
    USING (EXISTS (SELECT 1 FROM quotations _p WHERE _p.quotation_id = quotation_lines.quotation_id))
    WITH CHECK (EXISTS (SELECT 1 FROM quotations _p WHERE _p.quotation_id = quotation_lines.quotation_id));
ALTER TABLE delivery_challan_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_challan_lines_rls ON delivery_challan_lines
    USING (EXISTS (SELECT 1 FROM delivery_challans _p WHERE _p.challan_id = delivery_challan_lines.challan_id))
    WITH CHECK (EXISTS (SELECT 1 FROM delivery_challans _p WHERE _p.challan_id = delivery_challan_lines.challan_id));
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_notes_rls ON credit_notes
    USING (EXISTS (SELECT 1 FROM invoices _p WHERE _p.invoice_id = credit_notes.invoice_id))
    WITH CHECK (EXISTS (SELECT 1 FROM invoices _p WHERE _p.invoice_id = credit_notes.invoice_id));
ALTER TABLE credit_note_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_note_lines_rls ON credit_note_lines
    USING (EXISTS (SELECT 1 FROM credit_notes _p WHERE _p.credit_note_id = credit_note_lines.credit_note_id))
    WITH CHECK (EXISTS (SELECT 1 FROM credit_notes _p WHERE _p.credit_note_id = credit_note_lines.credit_note_id));
ALTER TABLE sales_return_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_return_lines_rls ON sales_return_lines
    USING (EXISTS (SELECT 1 FROM sales_returns _p WHERE _p.return_id = sales_return_lines.return_id))
    WITH CHECK (EXISTS (SELECT 1 FROM sales_returns _p WHERE _p.return_id = sales_return_lines.return_id));
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY attendance_rls ON attendance
    USING (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = attendance.employee_id))
    WITH CHECK (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = attendance.employee_id));
ALTER TABLE employee_shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY employee_shifts_rls ON employee_shifts
    USING (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = employee_shifts.employee_id))
    WITH CHECK (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = employee_shifts.employee_id));
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_rls ON leave_requests
    USING (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = leave_requests.employee_id))
    WITH CHECK (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = leave_requests.employee_id));
ALTER TABLE payroll_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_entries_rls ON payroll_entries
    USING (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = payroll_entries.employee_id))
    WITH CHECK (EXISTS (SELECT 1 FROM employees _p WHERE _p.employee_id = payroll_entries.employee_id));
ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfer_lines_rls ON stock_transfer_lines
    USING (EXISTS (SELECT 1 FROM stock_transfers _p WHERE _p.transfer_id = stock_transfer_lines.transfer_id))
    WITH CHECK (EXISTS (SELECT 1 FROM stock_transfers _p WHERE _p.transfer_id = stock_transfer_lines.transfer_id));

-- Inter-branch transfers are visible to BOTH ends of the transfer (4.4).
ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_rls ON stock_transfers
    USING (erp_branch_ok(from_branch_id) OR erp_branch_ok(to_branch_id))
    WITH CHECK (erp_branch_ok(from_branch_id) OR erp_branch_ok(to_branch_id));

-- Users: Owner sees the chain, a Branch Manager sees their own branch's staff,
-- and everyone can always read their own row (needed for /me).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- Writes: the Owner anywhere; a Branch Manager only for counter, inventory and
-- accounts staff of their own branch (the Staff screen) — never a manager or an
-- owner, so a manager cannot promote anyone, themselves included.
CREATE POLICY users_rls ON users
    USING (erp_is_admin() OR user_id = erp_user_id() OR (branch_id IS NOT NULL AND branch_id = erp_branch_id()))
    WITH CHECK (erp_is_admin()
                OR (erp_role() = 'BRANCH_MANAGER' AND branch_id IS NOT NULL AND branch_id = erp_branch_id()
                    AND role IN ('CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT')));

-- Auth-plumbing tables are touched ONLY by the SECURITY DEFINER functions below,
-- which run as the table owner and therefore bypass RLS. No policy is granted to
-- the app role, so a compromised API connection cannot read password/OTP material.
ALTER TABLE otp_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_own ON user_sessions USING (user_id = erp_user_id());

ALTER TABLE auth_message_outbox ENABLE ROW LEVEL SECURITY;   -- no policy: SECURITY DEFINER only
-- No policy, exactly like otp_requests and password_reset_tokens: a grant IS auth
-- material, and the application role has no business touching it directly.
-- Everything goes through auth_request_override / auth_consume_override.
ALTER TABLE override_approvals ENABLE ROW LEVEL SECURITY;

-- Admins still need to review the signup queue through the API (7.2).
CREATE POLICY registration_requests_admin ON registration_requests
    USING (erp_is_admin()) WITH CHECK (erp_is_admin());

-- ============================================================================
-- AUTHENTICATION (Section 7.2 / 7.4)
-- ============================================================================
-- Every credential check happens INSIDE the database, in SECURITY DEFINER
-- functions. Consequences that matter:
--   * No password/PIN/OTP hash is ever sent to the API process, so it cannot be
--     logged, cached, or leaked by an application bug.
--   * Comparison uses pgcrypto crypt(), which is constant-time for a given hash
--     and salted per user -- not a string equality test.
--   * Lockout (7.4: 3 failed attempts) is applied atomically with the check, so
--     parallel guesses cannot race past the counter.

CREATE OR REPLACE FUNCTION auth_policy_max_attempts() RETURNS INT
    LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT (value #>> '{}')::int FROM admin_settings
          WHERE setting_key = 'pin_max_attempts' AND branch_id IS NULL), 3)
$$;

CREATE OR REPLACE FUNCTION auth_policy_lockout_minutes() RETURNS INT
    LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT (value #>> '{}')::int FROM admin_settings
          WHERE setting_key = 'lockout_minutes' AND branch_id IS NULL), 15)
$$;

-- Shared tail of every successful login: reset the lockout counter, record the
-- session, and hand back exactly the claims the API is allowed to know.
CREATE OR REPLACE FUNCTION auth__issue_session(
    p_user users, p_token_hash TEXT, p_method TEXT, p_ip INET,
    p_user_agent TEXT, p_device_id TEXT, p_ttl_minutes INT
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_expires TIMESTAMPTZ := now() + make_interval(mins => p_ttl_minutes);
BEGIN
    UPDATE users u SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
     WHERE u.user_id = p_user.user_id;

    INSERT INTO user_sessions (user_id, token_hash, device_id, branch_id, login_method,
                               ip_address, user_agent, expires_at)
    VALUES (p_user.user_id, p_token_hash, p_device_id, p_user.branch_id, p_method,
            p_ip, p_user_agent, v_expires);

    -- Section 43 — a successful sign-in is a security event the owner can see in
    -- the audit log. Failed attempts are in login_attempts (keyed on the typed
    -- identifier, so they exist even for accounts that do not).
    INSERT INTO audit_log (user_id, branch_id, action, entity_type, entity_id, new_value)
    VALUES (p_user.user_id, p_user.branch_id, 'LOGIN', 'users', p_user.user_id,
            jsonb_build_object('method', p_method, 'ip', host(p_ip)));

    RETURN QUERY SELECT 'OK'::TEXT, p_user.user_id, p_user.role::TEXT, p_user.branch_id,
        p_user.full_name, p_user.email, p_user.phone, p_user.language_pref,
        p_user.must_change_password, v_expires;
END;
$$;

-- Records a failed attempt and locks the account once the policy limit is hit.
CREATE OR REPLACE FUNCTION auth__fail(p_user_id UUID, p_identifier TEXT, p_ip INET)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
    INSERT INTO login_attempts (identifier, ip_address, succeeded)
    VALUES (lower(p_identifier), p_ip, FALSE);
    IF p_user_id IS NOT NULL THEN
        UPDATE users SET
            failed_attempts = failed_attempts + 1,
            locked_until = CASE
                WHEN failed_attempts + 1 >= auth_policy_max_attempts()
                THEN now() + make_interval(mins => auth_policy_lockout_minutes())
                ELSE locked_until END
        WHERE user_id = p_user_id;
    END IF;
END;
$$;

-- Email/phone + password. Returns status 'OK' | 'INVALID' | 'LOCKED' | 'INACTIVE'.
-- 'INVALID' is deliberately returned for both "no such user" and "wrong password"
-- so the endpoint cannot be used to enumerate which accounts exist.
CREATE OR REPLACE FUNCTION auth_login_password(
    p_identifier TEXT, p_password TEXT, p_token_hash TEXT,
    p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL, p_ttl_minutes INT DEFAULT 720
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users;
BEGIN
    SELECT * INTO v_user FROM users u
     WHERE lower(u.email) = lower(trim(p_identifier)) OR u.phone = trim(p_identifier)
     LIMIT 1;

    IF v_user.user_id IS NULL OR v_user.password_hash IS NULL THEN
        PERFORM auth__fail(NULL, p_identifier, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- [FIX] The password is checked FIRST. Reporting "deactivated" or "locked"
    -- before verifying the credential turned this endpoint into an account
    -- oracle: three wrong guesses made a real account answer differently from a
    -- non-existent one, with no password ever needed.
    IF v_user.password_hash <> crypt(p_password, v_user.password_hash) THEN
        PERFORM auth__fail(v_user.user_id, p_identifier, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF NOT v_user.is_active THEN
        RETURN QUERY SELECT 'INACTIVE'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > now() THEN
        RETURN QUERY SELECT 'LOCKED'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, v_user.locked_until;
        RETURN;
    END IF;

    INSERT INTO login_attempts (identifier, ip_address, succeeded)
    VALUES (lower(p_identifier), p_ip, TRUE);
    RETURN QUERY SELECT * FROM auth__issue_session(
        v_user, p_token_hash, 'PASSWORD', p_ip, p_user_agent, p_device_id, p_ttl_minutes);
END;
$$;

-- Phone + quick-access PIN for shop-floor staff (7.2). Same lockout policy.
CREATE OR REPLACE FUNCTION auth_login_pin(
    p_phone TEXT, p_pin TEXT, p_token_hash TEXT,
    p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL, p_ttl_minutes INT DEFAULT 720
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users;
BEGIN
    SELECT * INTO v_user FROM users u WHERE u.phone = trim(p_phone) LIMIT 1;

    IF v_user.user_id IS NULL OR v_user.pin_hash IS NULL THEN
        PERFORM auth__fail(NULL, p_phone, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    -- Credential first, account state second -- see the note in auth_login_password.
    IF v_user.pin_hash <> crypt(p_pin, v_user.pin_hash) THEN
        PERFORM auth__fail(v_user.user_id, p_phone, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF NOT v_user.is_active THEN
        RETURN QUERY SELECT 'INACTIVE'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > now() THEN
        RETURN QUERY SELECT 'LOCKED'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, v_user.locked_until;
        RETURN;
    END IF;

    INSERT INTO login_attempts (identifier, ip_address, succeeded) VALUES (lower(p_phone), p_ip, TRUE);
    RETURN QUERY SELECT * FROM auth__issue_session(
        v_user, p_token_hash, 'PIN', p_ip, p_user_agent, p_device_id, p_ttl_minutes);
END;
$$;

-- Google OAuth (7.2). The API verifies the ID token's signature with Google's
-- public keys BEFORE calling this; this function only maps a verified identity
-- onto a provisioned user. It never creates users -- an unknown Google account
-- is rejected, not silently onboarded.
CREATE OR REPLACE FUNCTION auth_login_google(
    p_email TEXT, p_google_sub TEXT, p_token_hash TEXT,
    p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL, p_ttl_minutes INT DEFAULT 720
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users;
BEGIN
    SELECT * INTO v_user FROM users u
     WHERE (p_google_sub IS NOT NULL AND u.google_sub = p_google_sub)
        OR lower(u.email) = lower(trim(p_email))
     ORDER BY (u.google_sub = p_google_sub) DESC NULLS LAST LIMIT 1;

    IF v_user.user_id IS NULL THEN
        RETURN QUERY SELECT 'UNKNOWN_ACCOUNT'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF NOT v_user.is_active THEN
        RETURN QUERY SELECT 'INACTIVE'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    -- Bind the Google subject on first successful sign-in so later logins match on
    -- the immutable subject id rather than on a mutable email address.
    IF p_google_sub IS NOT NULL AND v_user.google_sub IS DISTINCT FROM p_google_sub THEN
        UPDATE users SET google_sub = p_google_sub WHERE user_id = v_user.user_id;
    END IF;

    INSERT INTO login_attempts (identifier, ip_address, succeeded) VALUES (lower(p_email), p_ip, TRUE);
    RETURN QUERY SELECT * FROM auth__issue_session(
        v_user, p_token_hash, 'GOOGLE', p_ip, p_user_agent, p_device_id, p_ttl_minutes);
END;
$$;

-- Phone + OTP (7.2). Step 1: issue. Returns FALSE for an unknown phone but the
-- endpoint still reports success to the caller, again to prevent enumeration.
CREATE OR REPLACE FUNCTION auth_otp_issue(
    p_phone TEXT, p_purpose TEXT, p_otp_plain TEXT, p_expiry_minutes INT DEFAULT 5
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_exists BOOLEAN;
BEGIN
    SELECT TRUE INTO v_exists FROM users WHERE phone = trim(p_phone) AND is_active LIMIT 1;
    IF NOT COALESCE(v_exists, FALSE) THEN RETURN FALSE; END IF;

    -- Any earlier unconsumed OTP for this phone+purpose is invalidated first, so
    -- only one code is ever live at a time.
    UPDATE otp_requests SET consumed_at = now()
     WHERE phone = trim(p_phone) AND purpose = p_purpose AND consumed_at IS NULL;

    INSERT INTO otp_requests (phone, otp_hash, purpose, expires_at)
    VALUES (trim(p_phone), crypt(p_otp_plain, gen_salt('bf', 10)), p_purpose,
            now() + make_interval(mins => p_expiry_minutes));
    RETURN TRUE;
END;
$$;

-- Step 2: verify and log in. Single-use and attempt-capped.
CREATE OR REPLACE FUNCTION auth_otp_verify(
    p_phone TEXT, p_otp_plain TEXT, p_token_hash TEXT,
    p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL, p_ttl_minutes INT DEFAULT 720
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_otp otp_requests; v_user users;
BEGIN
    SELECT * INTO v_otp FROM otp_requests o
     WHERE o.phone = trim(p_phone) AND o.purpose = 'LOGIN' AND o.consumed_at IS NULL
     ORDER BY o.created_at DESC LIMIT 1;

    IF v_otp.otp_id IS NULL OR v_otp.expires_at < now()
       OR v_otp.attempts >= auth_policy_max_attempts() THEN
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    IF v_otp.otp_hash <> crypt(p_otp_plain, v_otp.otp_hash) THEN
        UPDATE otp_requests SET attempts = attempts + 1 WHERE otp_id = v_otp.otp_id;
        PERFORM auth__fail(NULL, p_phone, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;

    UPDATE otp_requests SET consumed_at = now() WHERE otp_id = v_otp.otp_id;
    SELECT * INTO v_user FROM users u WHERE u.phone = trim(p_phone) AND u.is_active LIMIT 1;
    IF v_user.user_id IS NULL THEN
        RETURN QUERY SELECT 'INACTIVE'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    -- [FIX] A locked account used to be able to walk straight past the lockout by
    -- switching to OTP, and issuing the session then cleared the lockout entirely.
    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > now() THEN
        RETURN QUERY SELECT 'LOCKED'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, v_user.locked_until;
        RETURN;
    END IF;

    RETURN QUERY SELECT * FROM auth__issue_session(
        v_user, p_token_hash, 'PHONE_OTP', p_ip, p_user_agent, p_device_id, p_ttl_minutes);
END;
$$;

-- Resolve a bearer token on each request. Also slides last_seen_at, and refuses
-- expired or revoked sessions (7.2 session timeout).
CREATE OR REPLACE FUNCTION auth_session_resolve(p_token_hash TEXT)
RETURNS TABLE (
    session_id UUID, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
    UPDATE user_sessions s SET last_seen_at = now()
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now();

    RETURN QUERY
    SELECT s.session_id, u.user_id, u.role::TEXT, u.branch_id, u.full_name, u.email, u.phone,
           u.language_pref, u.must_change_password, s.expires_at
      FROM user_sessions s JOIN users u ON u.user_id = s.user_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active;
END;
$$;

-- Hashes a new password or PIN for the API (user creation and Owner resets). The
-- running app role may not be able to see pgcrypto directly (Supabase keeps it in
-- an `extensions` schema the app role has no USAGE on), so hashing goes through
-- this definer function, with the same bcrypt cost as every other credential.
CREATE OR REPLACE FUNCTION erp_hash_secret(p_secret TEXT)
RETURNS TEXT LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT crypt(p_secret, gen_salt('bf', 12))
$$;

-- Is this phone or email already used by ANOTHER user, anywhere in the chain?
-- Row-level security hides other branches' staff from a Branch Manager, so the
-- check runs as definer; it returns only an id, never the other person's details.
CREATE OR REPLACE FUNCTION auth_contact_taken(p_user_id UUID, p_phone TEXT, p_email TEXT)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT user_id FROM users
     WHERE user_id IS DISTINCT FROM p_user_id
       AND ((p_phone IS NOT NULL AND phone = p_phone)
            OR (p_email IS NOT NULL AND lower(email) = lower(p_email)))
     LIMIT 1
$$;

-- The sign-up form is shown BEFORE anyone is signed in, so it cannot read `branches`
-- (row-level security hides every row from an anonymous connection). This exposes
-- exactly the id, name and code of active branches and nothing else.
CREATE OR REPLACE FUNCTION auth_public_branches()
RETURNS TABLE (branch_id UUID, name TEXT, code TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT b.branch_id, b.name, b.code FROM branches b WHERE b.is_active ORDER BY b.name
$$;

-- The branches a user may act at: an Owner every active branch; anyone else their
-- home branch plus any granted in user_branch_access. The API calls this before it
-- honours a requested active branch, so a branch id in a request header is a
-- REQUEST that the database has to agree to, never a fact the client asserts.
CREATE OR REPLACE FUNCTION auth_user_branches(p_user_id UUID)
RETURNS TABLE (branch_id UUID, name TEXT, code TEXT, is_home BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT b.branch_id, b.name, b.code, (b.branch_id IS NOT DISTINCT FROM u.branch_id) AS is_home
      FROM users u
      JOIN branches b ON b.is_active
       AND (u.role = 'OWNER_ADMIN'
            OR b.branch_id = u.branch_id
            OR EXISTS (SELECT 1 FROM user_branch_access a
                        WHERE a.user_id = u.user_id AND a.branch_id = b.branch_id))
     WHERE u.user_id = p_user_id AND u.is_active
     ORDER BY (b.branch_id IS NOT DISTINCT FROM u.branch_id) DESC, b.name
$$;

CREATE OR REPLACE FUNCTION auth_logout(p_token_hash TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    UPDATE user_sessions SET revoked_at = now()
     WHERE token_hash = p_token_hash AND revoked_at IS NULL;
$$;

-- Revoke every session for a user -- used on password reset and on deactivation,
-- so a stolen session cannot outlive the credential that created it.
CREATE OR REPLACE FUNCTION auth_revoke_user_sessions(p_user_id UUID)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    UPDATE user_sessions SET revoked_at = now()
     WHERE user_id = p_user_id AND revoked_at IS NULL;
$$;

-- Self-service signup -> pending request, never a live account (7.2).
CREATE OR REPLACE FUNCTION auth_register(
    p_full_name TEXT, p_email TEXT, p_phone TEXT,
    p_role TEXT, p_branch_id UUID, p_password TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE phone = trim(p_phone)
               OR (p_email IS NOT NULL AND lower(email) = lower(trim(p_email)))) THEN
        RETURN 'ALREADY_REGISTERED';
    END IF;
    IF EXISTS (SELECT 1 FROM registration_requests
               WHERE phone = trim(p_phone) AND status = 'PENDING') THEN
        RETURN 'ALREADY_PENDING';
    END IF;
    -- Nobody can request the Owner role through public signup.
    IF p_role = 'OWNER_ADMIN' THEN RETURN 'ROLE_NOT_ALLOWED'; END IF;

    INSERT INTO registration_requests (full_name, email, phone, requested_role,
                                       requested_branch_id, password_hash)
    VALUES (p_full_name, NULLIF(trim(p_email), ''), trim(p_phone), p_role::user_role, p_branch_id,
            CASE WHEN p_password IS NULL THEN NULL ELSE crypt(p_password, gen_salt('bf', 12)) END);
    RETURN 'PENDING';
END;
$$;

-- Admin approves a signup: this is the only path that turns a request into a user.
CREATE OR REPLACE FUNCTION auth_approve_registration(
    p_request_id UUID, p_reviewer UUID, p_role TEXT, p_branch_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r registration_requests; v_new UUID;
BEGIN
    SELECT * INTO r FROM registration_requests WHERE request_id = p_request_id AND status = 'PENDING';
    IF r.request_id IS NULL THEN RAISE EXCEPTION 'Registration request not found or already reviewed'; END IF;
    IF p_role = 'OWNER_ADMIN' AND p_branch_id IS NOT NULL THEN
        RAISE EXCEPTION 'OWNER_ADMIN is chain-wide and must not be pinned to a branch';
    END IF;
    IF p_role <> 'OWNER_ADMIN' AND p_branch_id IS NULL THEN
        RAISE EXCEPTION 'A branch role must be assigned to a branch';
    END IF;

    INSERT INTO users (branch_id, role, full_name, phone, email, password_hash, must_change_password)
    VALUES (p_branch_id, p_role::user_role, r.full_name, r.phone, r.email, r.password_hash,
            r.password_hash IS NULL)
    RETURNING user_id INTO v_new;

    UPDATE registration_requests SET status = 'APPROVED', reviewed_by = p_reviewer,
           reviewed_at = now(), created_user_id = v_new
     WHERE request_id = p_request_id;
    RETURN v_new;
END;
$$;

-- Forgot password / forgot PIN. Always returns TRUE to the caller regardless of
-- whether the account exists; only a real account actually gets a token row.
CREATE OR REPLACE FUNCTION auth_request_reset(
    p_identifier TEXT, p_kind TEXT, p_token_hash TEXT, p_expiry_minutes INT DEFAULT 30
) RETURNS TABLE (issued BOOLEAN, user_id UUID, email TEXT, phone TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users;
BEGIN
    SELECT * INTO v_user FROM users u
     WHERE (lower(u.email) = lower(trim(p_identifier)) OR u.phone = trim(p_identifier))
       AND u.is_active LIMIT 1;
    IF v_user.user_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT; RETURN;
    END IF;

    UPDATE password_reset_tokens SET consumed_at = now()
     WHERE password_reset_tokens.user_id = v_user.user_id
       AND reset_kind = p_kind AND consumed_at IS NULL;

    INSERT INTO password_reset_tokens (user_id, token_hash, reset_kind, expires_at)
    VALUES (v_user.user_id, p_token_hash, p_kind, now() + make_interval(mins => p_expiry_minutes));
    RETURN QUERY SELECT TRUE, v_user.user_id, v_user.email, v_user.phone;
END;
$$;

-- Consume a reset token and set the new secret. Every existing session for that
-- user is revoked in the same transaction.
CREATE OR REPLACE FUNCTION auth_perform_reset(p_token_hash TEXT, p_new_secret TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE t password_reset_tokens;
BEGIN
    SELECT * INTO t FROM password_reset_tokens
     WHERE token_hash = p_token_hash AND consumed_at IS NULL AND expires_at > now();
    IF t.reset_id IS NULL THEN RETURN 'INVALID_OR_EXPIRED'; END IF;

    IF t.reset_kind = 'PIN' THEN
        IF p_new_secret !~ '^[0-9]{4,6}$' THEN RETURN 'WEAK'; END IF;
        UPDATE users SET pin_hash = crypt(p_new_secret, gen_salt('bf', 12)),
               failed_attempts = 0, locked_until = NULL
         WHERE user_id = t.user_id;
    ELSE
        IF length(p_new_secret) < 8 THEN RETURN 'WEAK'; END IF;
        UPDATE users SET password_hash = crypt(p_new_secret, gen_salt('bf', 12)),
               failed_attempts = 0, locked_until = NULL, must_change_password = FALSE
         WHERE user_id = t.user_id;
    END IF;

    UPDATE password_reset_tokens SET consumed_at = now() WHERE reset_id = t.reset_id;
    PERFORM auth_revoke_user_sessions(t.user_id);
    RETURN 'OK';
END;
$$;

-- Change your own password while logged in (requires the current one).
CREATE OR REPLACE FUNCTION auth_change_password(
    p_user_id UUID, p_current TEXT, p_new TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users;
BEGIN
    SELECT * INTO v_user FROM users WHERE user_id = p_user_id;
    IF v_user.user_id IS NULL THEN RETURN 'INVALID'; END IF;
    -- A user with no password yet (PIN-only staff) is setting one for the first
    -- time; anyone who has one must prove they know it.
    IF v_user.password_hash IS NOT NULL
       AND v_user.password_hash <> crypt(p_current, v_user.password_hash) THEN
        RETURN 'INVALID';
    END IF;
    IF length(p_new) < 8 THEN RETURN 'WEAK'; END IF;
    UPDATE users SET password_hash = crypt(p_new, gen_salt('bf', 12)),
           must_change_password = FALSE WHERE user_id = p_user_id;
    RETURN 'OK';
END;
$$;

-- Set or rotate a staff PIN (self, or an admin/manager acting for a staff member).
--
-- [FIX] This is SECURITY DEFINER and takes a target user id, so trusting the
-- application to have checked the caller made it a privilege-escalation primitive
-- one bug away from being reachable. The authority check now lives here, where it
-- cannot be forgotten: you may set your own PIN, an Owner may set anyone's, and a
-- Branch Manager may set one for staff at their own branch.
CREATE OR REPLACE FUNCTION auth_set_pin(p_user_id UUID, p_pin TEXT, p_actor UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_actor users; v_target users;
BEGIN
    IF p_pin !~ '^[0-9]{4,6}$' THEN RETURN 'WEAK'; END IF;   -- 7.4: PIN length 4-6 digits

    SELECT * INTO v_actor FROM users WHERE user_id = p_actor AND is_active;
    SELECT * INTO v_target FROM users WHERE user_id = p_user_id;
    IF v_actor.user_id IS NULL OR v_target.user_id IS NULL THEN RETURN 'FORBIDDEN'; END IF;

    IF NOT (
        p_actor = p_user_id
        OR v_actor.role = 'OWNER_ADMIN'
        OR (v_actor.role = 'BRANCH_MANAGER'
            AND v_target.branch_id IS NOT DISTINCT FROM v_actor.branch_id
            AND v_target.role <> 'OWNER_ADMIN')
    ) THEN
        RETURN 'FORBIDDEN';
    END IF;

    UPDATE users SET pin_hash = crypt(p_pin, gen_salt('bf', 12)),
           failed_attempts = 0, locked_until = NULL WHERE user_id = p_user_id;
    RETURN 'OK';
END;
$$;

-- [FIX] Verifying the PIN and minting the grant are ONE function.
--
-- As two, auth_issue_override took an approver id as a raw argument and checked
-- nothing, so the unforgeability of every override in the system rested on one
-- call site remembering to verify first. That is precisely the shape this codebase
-- avoids elsewhere — the check belongs where it cannot be skipped.
--
-- It also throttles on the REQUESTING user, because until a guess succeeds there
-- is no way to know which manager was being guessed at. Without a counter a
-- 4-digit PIN falls in minutes, and a correct guess stamps the audit log with a
-- manager's name.
CREATE OR REPLACE FUNCTION auth_request_override(
    p_pin TEXT, p_purpose TEXT, p_branch_id UUID, p_requested_by UUID,
    p_ip INET DEFAULT NULL, p_ttl_minutes INT DEFAULT 10
) RETURNS TABLE (status TEXT, approval_id UUID, approver_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
    v_user users;
    v_recent_failures INT;
    v_key TEXT := 'override-pin:' || COALESCE(p_requested_by::text, COALESCE(host(p_ip), 'unknown'));
    v_id UUID;
BEGIN
    IF p_purpose NOT IN ('DISCOUNT','NEGATIVE_STOCK','CREDIT_LIMIT','RETURN_WINDOW','CASH_DROP') THEN
        RETURN QUERY SELECT 'INVALID_PURPOSE'::TEXT, NULL::UUID, NULL::TEXT; RETURN;
    END IF;

    SELECT count(*) INTO v_recent_failures FROM login_attempts
     WHERE identifier = v_key AND NOT succeeded
       AND attempted_at > now() - make_interval(mins => auth_policy_lockout_minutes());
    IF v_recent_failures >= auth_policy_max_attempts() THEN
        RETURN QUERY SELECT 'LOCKED'::TEXT, NULL::UUID, NULL::TEXT; RETURN;
    END IF;

    SELECT * INTO v_user FROM users u
     WHERE u.is_active AND u.pin_hash IS NOT NULL
       AND (u.role = 'OWNER_ADMIN' OR (u.role = 'BRANCH_MANAGER' AND u.branch_id = p_branch_id))
       AND u.pin_hash = crypt(p_pin, u.pin_hash)
     LIMIT 1;

    INSERT INTO login_attempts (identifier, ip_address, succeeded)
    VALUES (v_key, p_ip, v_user.user_id IS NOT NULL);

    IF v_user.user_id IS NULL THEN
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT; RETURN;
    END IF;

    -- Qualified, because the function's own OUT parameter is also called
    -- approval_id and an unqualified reference is ambiguous.
    INSERT INTO override_approvals AS oa (purpose, branch_id, approver_id, requested_by, expires_at)
    VALUES (p_purpose, p_branch_id, v_user.user_id, p_requested_by,
            now() + make_interval(mins => p_ttl_minutes))
    RETURNING oa.approval_id INTO v_id;

    RETURN QUERY SELECT 'OK'::TEXT, v_id, v_user.full_name;
END;
$$;

-- Consumes a grant. Single-use, time-boxed, and bound to the branch, the purpose
-- AND the person who asked for it, so an approval cannot be replayed or shared.
CREATE OR REPLACE FUNCTION auth_consume_override(
    p_approval_id UUID, p_purpose TEXT, p_branch_id UUID, p_requested_by UUID
) RETURNS TABLE (ok BOOLEAN, approver_id UUID, approver_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE r override_approvals;
BEGIN
    UPDATE override_approvals SET consumed_at = now()
     WHERE approval_id = p_approval_id
       AND purpose = p_purpose
       AND branch_id = p_branch_id
       AND requested_by = p_requested_by
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING * INTO r;

    IF r.approval_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT;
    ELSE
        RETURN QUERY SELECT TRUE, r.approver_id, (SELECT full_name FROM users WHERE user_id = r.approver_id);
    END IF;
END;
$$;

-- Queues an auth message into the outbox the app role cannot read.
CREATE OR REPLACE FUNCTION auth_queue_message(
    p_to_phone TEXT, p_purpose TEXT, p_body TEXT, p_to_email TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    INSERT INTO auth_message_outbox (to_phone, to_email, purpose, body)
    VALUES (p_to_phone, p_to_email, p_purpose, p_body);
$$;

-- The delivery worker's only view of the outbox: it gets the body to send, and
-- nothing else can.
-- Claims a batch rather than merely reading one. Without the claim, two API
-- instances running the same 30-second timer both pick up the same row, and the
-- customer gets the same verification code twice — or two different codes, of
-- which only one works.
CREATE OR REPLACE FUNCTION auth_outbox_take(p_batch INT DEFAULT 25)
RETURNS TABLE (id UUID, to_phone TEXT, body TEXT, attempts SMALLINT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    UPDATE auth_message_outbox o SET status = 'SENDING'
     WHERE o.id IN (
        SELECT c.id FROM auth_message_outbox c
         WHERE c.status = 'QUEUED' AND c.attempts < 5
         ORDER BY c.queued_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_batch
     )
    RETURNING o.id, o.to_phone, o.body, o.attempts;
$$;

-- Returns anything stuck in SENDING to the queue, for a worker that claimed a
-- batch and then died before reporting a result.
CREATE OR REPLACE FUNCTION auth_outbox_requeue_stale(p_older_than_minutes INT DEFAULT 5)
RETURNS INT LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    WITH stale AS (
        UPDATE auth_message_outbox SET status = 'QUEUED'
         WHERE status = 'SENDING' AND queued_at < now() - make_interval(mins => p_older_than_minutes)
        RETURNING 1
    ) SELECT count(*)::int FROM stale;
$$;

CREATE OR REPLACE FUNCTION auth_outbox_result(p_id UUID, p_ok BOOLEAN, p_error TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    UPDATE auth_message_outbox
       SET attempts = attempts + 1,
           last_error = p_error,
           status = CASE WHEN p_ok THEN 'SENT'
                         WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'QUEUED' END,
           sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END
     WHERE id = p_id;
$$;

-- ============================================================================
-- LEDGER SERIALISATION
-- ============================================================================
-- [FIX] The customer credit ledger is chain-wide (Section 0) — that is what makes
-- one credit limit mean one limit across the whole chain. It also means
-- balance_after is a single running total that two branches can try to extend at
-- the same instant. Read-then-insert without a lock lets both read the old
-- balance, both pass the limit check, and the second silently overwrite the first.
--
-- Every writer goes through this function. It takes a row lock on the CUSTOMER,
-- which serialises that one customer's ledger activity chain-wide while leaving
-- every other customer free to transact in parallel.
CREATE OR REPLACE FUNCTION customer_credit_post(
    p_customer_id UUID, p_branch_id UUID, p_entry_type credit_ledger_entry_type,
    p_amount NUMERIC, p_ref_table TEXT DEFAULT NULL, p_ref_id UUID DEFAULT NULL,
    p_enforce_limit BOOLEAN DEFAULT FALSE
) RETURNS TABLE (entry_id UUID, balance_after NUMERIC, credit_limit NUMERIC, over_limit BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
    v_customer customers;
    v_prior NUMERIC;
    v_next  NUMERIC;
    v_id    UUID;
BEGIN
    SELECT * INTO v_customer FROM customers WHERE customer_id = p_customer_id FOR UPDATE;
    IF v_customer.customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer not found';
    END IF;

    SELECT l.balance_after INTO v_prior FROM customer_credit_ledger l
     WHERE l.customer_id = p_customer_id
     ORDER BY l.created_at DESC, l.entry_id DESC LIMIT 1;
    v_prior := COALESCE(v_prior, 0);
    v_next := round(v_prior + p_amount, 2);

    -- The limit is checked under the same lock that will write the row, so the
    -- answer cannot go stale between the check and the insert.
    IF p_enforce_limit AND v_next > v_customer.credit_limit THEN
        RETURN QUERY SELECT NULL::UUID, v_next, v_customer.credit_limit, TRUE;
        RETURN;
    END IF;

    -- clock_timestamp(), not now(): now() is when the TRANSACTION began, and
    -- transactions that queued on the lock above began in a different order from
    -- the order they write in. "The latest entry" (by created_at) would then not
    -- be the one holding the true running balance. Stamped here, under the lock,
    -- created_at order IS posting order.
    INSERT INTO customer_credit_ledger (customer_id, branch_id, entry_type, amount,
                                        balance_after, ref_table, ref_id, created_at)
    VALUES (p_customer_id, p_branch_id, p_entry_type, p_amount, v_next, p_ref_table, p_ref_id, clock_timestamp())
    RETURNING customer_credit_ledger.entry_id INTO v_id;

    -- 6.1.1 — the offline cache is refreshed in the same breath, so a till that
    -- goes offline carries the balance that was true when it last synced.
    INSERT INTO customer_credit_cache (customer_id, cached_credit_limit, cached_balance_owed, cached_at)
    VALUES (p_customer_id, v_customer.credit_limit, v_next, now())
    ON CONFLICT (customer_id) DO UPDATE
      SET cached_credit_limit = EXCLUDED.cached_credit_limit,
          cached_balance_owed = EXCLUDED.cached_balance_owed, cached_at = now();

    RETURN QUERY SELECT v_id, v_next, v_customer.credit_limit, FALSE;
END;
$$;

-- The payables mirror, locking the vendor row for the same reason.
CREATE OR REPLACE FUNCTION vendor_ledger_post(
    p_vendor_id UUID, p_branch_id UUID, p_entry_type vendor_ledger_entry_type,
    p_amount NUMERIC, p_ref_table TEXT DEFAULT NULL, p_ref_id UUID DEFAULT NULL
) RETURNS TABLE (entry_id UUID, balance_after NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_prior NUMERIC; v_next NUMERIC; v_id UUID;
BEGIN
    PERFORM 1 FROM vendors WHERE vendor_id = p_vendor_id FOR UPDATE;

    SELECT l.balance_after INTO v_prior FROM vendor_ledger l
     WHERE l.vendor_id = p_vendor_id
     ORDER BY l.created_at DESC, l.entry_id DESC LIMIT 1;
    v_next := round(COALESCE(v_prior, 0) + p_amount, 2);

    -- clock_timestamp(): stamped under the lock, so created_at order is posting
    -- order (see customer_credit_post).
    INSERT INTO vendor_ledger (vendor_id, branch_id, entry_type, amount, balance_after, ref_table, ref_id, created_at)
    VALUES (p_vendor_id, p_branch_id, p_entry_type, p_amount, v_next, p_ref_table, p_ref_id, clock_timestamp())
    RETURNING vendor_ledger.entry_id INTO v_id;

    RETURN QUERY SELECT v_id, v_next;
END;
$$;

-- ============================================================================
-- MIGRATION HISTORY
-- ============================================================================
-- This file is always the COMPLETE current schema, for a fresh install. A
-- database that already holds data is upgraded with db/migrations/NNN_*.sql
-- instead (npm run db:upgrade), and this table records which of those it has
-- had. A fresh install already contains everything, so every migration that
-- exists today is recorded as applied. Add the new version here whenever a
-- migration file is added.
CREATE TABLE schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES
    ('001_baseline'),
    ('002_concurrency_and_performance'),
    ('003_lock_down_functions');

-- ============================================================================
-- APPLICATION ROLE & GRANTS
-- ============================================================================
-- The API must NOT connect as the owner of these tables, or RLS would be
-- bypassed and every branch-scoping policy above would be decorative.
-- The password comes from a psql variable so this file does not ship one:
--     psql -v erp_app_password="$(openssl rand -base64 24)" -f db/schema.sql
-- Without the variable a development default is used AND the role is marked as
-- needing a password change, so an unrotated credential is visible rather than silent.
\if :{?erp_app_password}
\else
\set erp_app_password 'CHANGE_ME_dev_only'
\endif

-- \gexec rather than a DO block: psql does not substitute :variables inside a
-- dollar-quoted string, so the password would arrive as the literal text ":var".
SELECT format('%s ROLE erp_app LOGIN PASSWORD %L',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app')
                   THEN 'ALTER' ELSE 'CREATE' END,
              :'erp_app_password')
\gexec

GRANT USAGE ON SCHEMA public TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO erp_app;

-- Deletes are never legitimate on the immutable audit/compliance trail (7.3, 15).
REVOKE DELETE, UPDATE ON audit_log, stock_ledger, login_attempts FROM erp_app;
REVOKE INSERT, UPDATE, DELETE ON backups FROM erp_app;
-- Money vouchers are corrected by a reversing entry, never edited or removed.
REVOKE UPDATE, DELETE ON customer_payments, vendor_payments, stock_adjustments, payment_cancellations FROM erp_app;
-- The migration history is written by the upgrade script (as the owner), never by the app.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM erp_app;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- The app role must not be able to reach auth message bodies by any route.
REVOKE ALL ON auth_message_outbox FROM erp_app;
REVOKE ALL ON override_approvals FROM erp_app;
REVOKE DELETE ON invoices, invoice_lines, credit_notes, credit_note_lines FROM erp_app;

-- ── Draft bills are editable; finalised ones are not (Sections 3.x, 11, 12) ──
-- A draft is a working document: the cashier adds, removes and re-prices lines
-- on it before the bill becomes a commercial record. That needs DELETE on the
-- line tables, which the blanket REVOKE above rightly withheld — its purpose was
-- to make a FINAL invoice physically unalterable, and that must survive.
--
-- So the privilege is granted back and then narrowed by a trigger, which is
-- strictly stronger than leaving it revoked and doing the check in application
-- code: a bug in a route, or a second service connecting with the same role,
-- still cannot delete a line off a finalised invoice.
GRANT DELETE ON invoices, invoice_lines TO erp_app;

CREATE OR REPLACE FUNCTION erp_only_drafts_are_mutable() RETURNS TRIGGER AS $$
DECLARE
    v_status invoice_status;
BEGIN
    IF TG_TABLE_NAME = 'invoices' THEN
        v_status := OLD.status;
    ELSE
        SELECT status INTO v_status FROM invoices WHERE invoice_id = OLD.invoice_id;
    END IF;

    -- A missing parent means the invoice row itself is being removed in the same
    -- statement, which only the draft path can do (the invoices trigger below has
    -- already vetted it).
    IF v_status IS NULL OR v_status = 'DRAFT' THEN
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'Invoice % is % and cannot be altered. Use a void, a sales return or a credit note instead.',
        COALESCE((SELECT invoice_number FROM invoices WHERE invoice_id = OLD.invoice_id), OLD.invoice_id::text),
        v_status
        USING ERRCODE = 'restrict_violation';
END;
-- SECURITY DEFINER with a PINNED search_path, like every other definer function
-- in this file. Without the pin, the app role could create a temp table called
-- `invoices`, put it ahead of public on its search_path, and have this trigger
-- read a fabricated status — turning the guard that protects finalised invoices
-- into the thing that waves the delete through.
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp;

-- Lines and payments of a finalised bill can be neither deleted NOR edited.
CREATE TRIGGER trg_invoice_lines_draft_only
    BEFORE UPDATE OR DELETE ON invoice_lines
    FOR EACH ROW EXECUTE FUNCTION erp_only_drafts_are_mutable();

CREATE TRIGGER trg_invoice_payments_draft_only
    BEFORE UPDATE OR DELETE ON invoice_payments
    FOR EACH ROW EXECUTE FUNCTION erp_only_drafts_are_mutable();

CREATE TRIGGER trg_invoices_draft_only
    BEFORE DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION erp_only_drafts_are_mutable();

-- Section 22 — "after finalisation, do NOT silently overwrite financial history".
-- A FINAL invoice's commercial content is frozen at the database, where no route,
-- script or second service using the app role can get round it. What may still
-- change is operational metadata: FINAL -> VOID (the void workflow, which posts
-- its own reversals), the offline-conflict flags, and the e-invoice IRN. A
-- customer merge may re-point customer_id, and only when the merge path has set
-- its transaction-local flag. Everything else is a correction, and corrections
-- go through a return, a credit note or a void.
CREATE OR REPLACE FUNCTION erp_protect_final_invoice() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'DRAFT' THEN
        RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'FINAL' AND NEW.status = 'VOID') THEN
        RAISE EXCEPTION 'Invoice % is % and its status cannot change to %.',
            OLD.invoice_number, OLD.status, NEW.status USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.invoice_number, NEW.branch_id, NEW.invoice_type, NEW.subtotal, NEW.discount_total,
        NEW.cgst_total, NEW.sgst_total, NEW.igst_total, NEW.grand_total, NEW.round_off,
        NEW.place_of_supply_state_code, NEW.server_received_at, NEW.device_created_at,
        NEW.till_session_id, NEW.created_by, NEW.notes, NEW.due_date, NEW.order_no,
        NEW.challan_no, NEW.challan_date, NEW.vehicle_no, NEW.place_of_delivery,
        NEW.sold_by_employee_id, NEW.client_txn_id, NEW.source_quotation_id)
       IS DISTINCT FROM
       (OLD.invoice_number, OLD.branch_id, OLD.invoice_type, OLD.subtotal, OLD.discount_total,
        OLD.cgst_total, OLD.sgst_total, OLD.igst_total, OLD.grand_total, OLD.round_off,
        OLD.place_of_supply_state_code, OLD.server_received_at, OLD.device_created_at,
        OLD.till_session_id, OLD.created_by, OLD.notes, OLD.due_date, OLD.order_no,
        OLD.challan_no, OLD.challan_date, OLD.vehicle_no, OLD.place_of_delivery,
        OLD.sold_by_employee_id, OLD.client_txn_id, OLD.source_quotation_id) THEN
        RAISE EXCEPTION 'Invoice % is % and cannot be altered. Use a void, a sales return or a credit note instead.',
            OLD.invoice_number, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       AND COALESCE(current_setting('erp.customer_merge', true), '') <> 'on' THEN
        RAISE EXCEPTION 'Invoice % is % and its customer cannot be changed.',
            OLD.invoice_number, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoices_protect_final
    BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION erp_protect_final_invoice();

-- ── Business day boundaries ───────────────────────────────────────────────────
-- "Today's sales", the fiscal year a number is drawn from, and every date filter
-- in a report are all questions about the SHOP's calendar. Pinning the database's
-- timezone makes CURRENT_DATE and ::date mean an Indian business day regardless of
-- where the server runs. The API also sets it per connection (BUSINESS_TIMEZONE),
-- so a managed database that refuses ALTER DATABASE is still correct.
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Kolkata');
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Could not set the database timezone; the API sets it per connection instead.';
END $$;

-- ============================================================================
-- FUNCTION LOCKDOWN — last, so it covers every function defined above.
-- ============================================================================
-- Functions: callable by erp_app only. Postgres lets PUBLIC execute every new
-- function, and on Supabase PUBLIC includes the anon/authenticated roles behind
-- its REST API — which would reach the SECURITY DEFINER auth functions directly,
-- skipping every check the API makes first. This app never uses that REST API.
-- (Same as migration 003; extension functions are left alone.)
DO $$
DECLARE
    r RECORD;
    has_anon BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
    has_auth BOOLEAN := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated');
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
        IF has_anon THEN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig); END IF;
        IF has_auth THEN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig); END IF;
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_app', r.sig);
    END LOOP;
    IF has_anon THEN REVOKE ALL ON SCHEMA public FROM anon; END IF;
    IF has_auth THEN REVOKE ALL ON SCHEMA public FROM authenticated; END IF;
END $$;
