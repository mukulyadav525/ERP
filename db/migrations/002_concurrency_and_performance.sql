-- ============================================================================
-- 002 — concurrency and performance (zero-blind-spots audit, 2026-10-02)
--
--  * Ledger rows are stamped with clock_timestamp() under the posting lock, so
--    "the latest entry" is the one holding the true running balance even when
--    two postings for one customer/vendor queued on the lock.
--  * Indexes for the bill list, movement log and returns lookups.
--  * Drops an index that duplicated the unique constraint on client_txn_id.
-- Idempotent: safe to run on a database that already has any of it.
-- ============================================================================
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


CREATE INDEX IF NOT EXISTS idx_invoices_received ON invoices(server_received_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_created ON stock_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_branch_created ON stock_ledger(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_returns_invoice ON sales_returns(invoice_id);
DROP INDEX IF EXISTS idx_invoices_client_txn;
