-- ============================================================================
-- 005 — everyone edits their own details (name, phone, email, language).
--
-- Through one SECURITY DEFINER function: row-level security lets only the Owner
-- (and a manager, for their counter staff) write user rows, and a cashier
-- changing their own phone must not need either. Phone/email changes require the
-- current password or PIN. Idempotent.
-- ============================================================================
-- ── Your own details (any role) ────────────────────────────────────────────
-- Name and language change freely. Phone and email are what you sign in with,
-- so changing either needs your current password (or, for PIN-only staff, your
-- PIN); a wrong one counts towards the lockout like a wrong password. Role,
-- branch and designation are not here: they stay the Owner's / manager's.
CREATE OR REPLACE FUNCTION auth_update_profile(
    p_user_id UUID, p_secret TEXT, p_full_name TEXT, p_phone TEXT, p_email TEXT, p_language TEXT,
    p_ip INET DEFAULT NULL
) RETURNS TABLE (status TEXT, old_email TEXT, changed TEXT[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
    v_user users;
    v_changed TEXT[] := '{}';
    v_phone TEXT := NULLIF(trim(p_phone), '');
    v_email TEXT := NULLIF(lower(trim(p_email)), '');
    v_contact BOOLEAN;
BEGIN
    SELECT * INTO v_user FROM users u WHERE u.user_id = p_user_id AND u.is_active FOR UPDATE;
    IF v_user.user_id IS NULL THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::TEXT, NULL::TEXT[]; RETURN;
    END IF;
    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > now() THEN
        RETURN QUERY SELECT 'LOCKED'::TEXT, NULL::TEXT, NULL::TEXT[]; RETURN;
    END IF;

    v_contact := v_phone IS DISTINCT FROM v_user.phone OR v_email IS DISTINCT FROM lower(v_user.email);
    IF v_contact THEN
        IF v_user.password_hash IS NULL AND v_user.pin_hash IS NULL THEN
            RETURN QUERY SELECT 'NO_CREDENTIAL'::TEXT, NULL::TEXT, NULL::TEXT[]; RETURN;
        END IF;
        IF p_secret IS NULL OR p_secret = '' OR NOT (
               (v_user.password_hash IS NOT NULL AND v_user.password_hash = crypt(p_secret, v_user.password_hash))
            OR (v_user.pin_hash IS NOT NULL AND p_secret ~ '^[0-9]{4,6}$' AND v_user.pin_hash = crypt(p_secret, v_user.pin_hash))) THEN
            PERFORM auth__fail(v_user.user_id, coalesce(v_user.email, v_user.phone, 'profile'), p_ip);
            RETURN QUERY SELECT 'WRONG_SECRET'::TEXT, NULL::TEXT, NULL::TEXT[]; RETURN;
        END IF;
        IF auth_contact_taken(v_user.user_id, v_phone, v_email) IS NOT NULL THEN
            RETURN QUERY SELECT 'TAKEN'::TEXT, NULL::TEXT, NULL::TEXT[]; RETURN;
        END IF;
        -- Someone who signs in by phone must keep a phone; by email/Google, an email.
        IF v_phone IS NULL AND v_email IS NULL THEN
            RETURN QUERY SELECT 'NEED_CONTACT'::TEXT, NULL::TEXT, NULL::TEXT[]; RETURN;
        END IF;
    END IF;

    IF trim(p_full_name) IS DISTINCT FROM v_user.full_name THEN v_changed := v_changed || 'name'::TEXT; END IF;
    IF v_phone IS DISTINCT FROM v_user.phone THEN v_changed := v_changed || 'phone'::TEXT; END IF;
    IF v_email IS DISTINCT FROM lower(v_user.email) THEN v_changed := v_changed || 'email'::TEXT; END IF;
    IF p_language IS DISTINCT FROM v_user.language_pref THEN v_changed := v_changed || 'language'::TEXT; END IF;
    IF array_length(v_changed, 1) IS NULL THEN
        RETURN QUERY SELECT 'OK'::TEXT, NULL::TEXT, v_changed; RETURN;
    END IF;

    UPDATE users u SET full_name = trim(p_full_name), phone = v_phone, email = v_email, language_pref = p_language,
           -- A new email belongs to a different Google account: bind afresh on next Google sign-in.
           google_sub = CASE WHEN v_email IS DISTINCT FROM lower(v_user.email) THEN NULL ELSE u.google_sub END
     WHERE u.user_id = p_user_id;

    INSERT INTO audit_log (user_id, branch_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (p_user_id, v_user.branch_id, 'PROFILE_UPDATED', 'users', p_user_id,
            jsonb_build_object('full_name', v_user.full_name, 'phone', v_user.phone, 'email', v_user.email, 'language', v_user.language_pref),
            jsonb_build_object('full_name', trim(p_full_name), 'phone', v_phone, 'email', v_email, 'language', p_language, 'changed', to_jsonb(v_changed)));

    RETURN QUERY SELECT 'OK'::TEXT, v_user.email, v_changed;
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
