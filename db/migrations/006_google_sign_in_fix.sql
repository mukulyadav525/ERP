-- ============================================================================
-- 006 — Google sign-in: fix "column reference user_id is ambiguous".
--
-- The first Google sign-in of an account saves the Google subject id on the user
-- (so later sign-ins match on that immutable id, not on a changeable email). That
-- UPDATE named a bare `user_id`, which clashes with the function's own output
-- column of the same name, so Postgres refused it and the API answered 500.
-- Password, PIN, email-code and phone-code sign-in were not affected. Idempotent.
-- ============================================================================
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
        UPDATE users u SET google_sub = p_google_sub WHERE u.user_id = v_user.user_id;
    END IF;

    INSERT INTO login_attempts (identifier, ip_address, succeeded) VALUES (lower(p_email), p_ip, TRUE);
    RETURN QUERY SELECT * FROM auth__issue_session(
        v_user, p_token_hash, 'GOOGLE', p_ip, p_user_agent, p_device_id, p_ttl_minutes);
END;
$$;

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
