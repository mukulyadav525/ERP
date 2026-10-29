-- ============================================================================
-- 007 — HSN code is optional on a product.
--
-- A product with no HSN (or with an HSN whose rate is not on the GST rates tab)
-- carries its own GST rate in products.gst_rate_pct. Billing, quotations and
-- purchases take the HSN's effective-dated rate when there is one, and this
-- rate otherwise. No functions change, so no lockdown block is needed. Idempotent.
-- ============================================================================
ALTER TABLE products ALTER COLUMN hsn_code DROP NOT NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_rate_pct NUMERIC(5,2);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_gst_rate') THEN
        ALTER TABLE products ADD CONSTRAINT chk_products_gst_rate
            CHECK (gst_rate_pct IS NULL OR (gst_rate_pct >= 0 AND gst_rate_pct <= 100));
    END IF;
END $$;
