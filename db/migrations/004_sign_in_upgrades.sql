-- ============================================================================
-- 004 — sign-in upgrades (2026-10-02)
--
--  * Codes by EMAIL: the auth outbox carries a channel (EMAIL / WHATSAPP), an
--    email-only recipient, and a NOT_CONFIGURED outcome — a code that could not
--    be sent is never recorded as SENT.
--  * Sign in with a code sent to your email (otp_requests keyed by user).
--  * Two-step sign-in: authenticator-app (TOTP) codes and one-time recovery
--    codes, verified inside the database; a session stays unusable until the
--    second step passes (user_sessions.mfa_pending).
--  * Your own sign-in history, readable through a definer function.
-- Idempotent.
-- ============================================================================

-- ── Auth outbox: email channel ─────────────────────────────────────────────
ALTER TABLE auth_message_outbox ALTER COLUMN to_phone DROP NOT NULL;
ALTER TABLE auth_message_outbox ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'WHATSAPP';
ALTER TABLE auth_message_outbox DROP CONSTRAINT IF EXISTS chk_auth_outbox_channel;
ALTER TABLE auth_message_outbox ADD CONSTRAINT chk_auth_outbox_channel CHECK (channel IN ('WHATSAPP', 'EMAIL'));
ALTER TABLE auth_message_outbox DROP CONSTRAINT IF EXISTS chk_auth_outbox_status;
ALTER TABLE auth_message_outbox ADD CONSTRAINT chk_auth_outbox_status
    CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED'));

-- ── Codes by email ─────────────────────────────────────────────────────────
ALTER TABLE otp_requests ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE otp_requests ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE CASCADE;
ALTER TABLE otp_requests DROP CONSTRAINT IF EXISTS chk_otp_purpose;
ALTER TABLE otp_requests ADD CONSTRAINT chk_otp_purpose
    CHECK (purpose IN ('LOGIN', 'LOGIN_EMAIL', 'RESET_PIN', 'RESET_PASSWORD', 'RESTORE_BACKUP'));
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_requests(user_id, purpose, created_at DESC) WHERE user_id IS NOT NULL;

-- ── Sessions: email-code method, pending second step ───────────────────────
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS mfa_pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_sessions DROP CONSTRAINT IF EXISTS chk_session_login_method;
ALTER TABLE user_sessions ADD CONSTRAINT chk_session_login_method
    CHECK (login_method IN ('GOOGLE', 'PHONE_OTP', 'PIN', 'PASSWORD', 'EMAIL_CODE'));

-- ── Two-step sign-in ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_mfa (
    user_id         UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    secret          BYTEA NOT NULL,                -- TOTP key; read only by the definer functions
    enabled_at      TIMESTAMPTZ,                   -- NULL while being set up
    last_used_step  BIGINT,                        -- a code is never accepted twice
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_mfa_recovery (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    code_hash       TEXT NOT NULL,                 -- bcrypt; shown once, never stored in the clear
    used_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON user_mfa_recovery(user_id) WHERE used_at IS NULL;
-- No policy for the app role: only the SECURITY DEFINER functions touch these.
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_mfa, user_mfa_recovery FROM erp_app;

-- Functions changing their signature are dropped first (CREATE OR REPLACE
-- cannot change a return type or argument list).
DROP FUNCTION IF EXISTS auth_queue_message(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS auth_outbox_take(INT);
DROP FUNCTION IF EXISTS auth_outbox_result(UUID, BOOLEAN, TEXT);

-- ── Auth outbox (codes by WhatsApp or email) ───────────────────────────────
CREATE OR REPLACE FUNCTION auth_queue_message(
    p_to_phone TEXT, p_purpose TEXT, p_body TEXT, p_to_email TEXT DEFAULT NULL, p_channel TEXT DEFAULT 'WHATSAPP'
) RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    INSERT INTO auth_message_outbox (to_phone, to_email, purpose, body, channel)
    VALUES (p_to_phone, p_to_email, p_purpose, p_body, p_channel)
    RETURNING id;
$$;

CREATE OR REPLACE FUNCTION auth_outbox_take(p_batch INT DEFAULT 25)
RETURNS TABLE (id UUID, channel TEXT, to_phone TEXT, to_email TEXT, purpose TEXT, body TEXT, attempts SMALLINT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    UPDATE auth_message_outbox o SET status = 'SENDING'
     WHERE o.id IN (
        SELECT c.id FROM auth_message_outbox c
         WHERE c.status = 'QUEUED' AND c.attempts < 5
         ORDER BY c.queued_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_batch
     )
    RETURNING o.id, o.channel, o.to_phone, o.to_email, o.purpose, o.body, o.attempts;
$$;

-- A code that could not be sent because no channel is set up is closed as
-- NOT_CONFIGURED — never SENT, and never retried.
CREATE OR REPLACE FUNCTION auth_outbox_result(
    p_id UUID, p_ok BOOLEAN, p_error TEXT DEFAULT NULL, p_not_configured BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    UPDATE auth_message_outbox
       SET attempts = attempts + 1,
           last_error = p_error,
           status = CASE WHEN p_ok THEN 'SENT'
                         WHEN p_not_configured THEN 'NOT_CONFIGURED'
                         WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'QUEUED' END,
           sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END
     WHERE id = p_id;
$$;

-- ── Sign in with a code sent by email ──────────────────────────────────────
CREATE OR REPLACE FUNCTION auth_email_code_issue(p_email TEXT, p_code TEXT, p_expiry_minutes INT DEFAULT 10)
RETURNS TABLE (issued BOOLEAN, user_id UUID, full_name TEXT, email TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users;
BEGIN
    SELECT * INTO v_user FROM users u WHERE lower(u.email) = lower(trim(p_email)) AND u.is_active LIMIT 1;
    IF v_user.user_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT; RETURN;
    END IF;
    -- One code a minute per person: repeated requests cannot flood their inbox.
    IF EXISTS (SELECT 1 FROM otp_requests o WHERE o.user_id = v_user.user_id AND o.purpose = 'LOGIN_EMAIL'
                AND o.created_at > now() - interval '60 seconds') THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::TEXT; RETURN;
    END IF;
    UPDATE otp_requests o SET consumed_at = now()
     WHERE o.user_id = v_user.user_id AND o.purpose = 'LOGIN_EMAIL' AND o.consumed_at IS NULL;
    INSERT INTO otp_requests (user_id, phone, otp_hash, purpose, expires_at)
    VALUES (v_user.user_id, v_user.phone, crypt(p_code, gen_salt('bf', 10)), 'LOGIN_EMAIL',
            now() + make_interval(mins => p_expiry_minutes));
    RETURN QUERY SELECT TRUE, v_user.user_id, v_user.full_name, v_user.email;
END;
$$;

CREATE OR REPLACE FUNCTION auth_email_code_verify(
    p_email TEXT, p_code TEXT, p_token_hash TEXT,
    p_ip INET DEFAULT NULL, p_user_agent TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL, p_ttl_minutes INT DEFAULT 720
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_user users; v_otp otp_requests;
BEGIN
    SELECT * INTO v_user FROM users u WHERE lower(u.email) = lower(trim(p_email)) LIMIT 1;
    IF v_user.user_id IS NOT NULL THEN
        SELECT * INTO v_otp FROM otp_requests o
         WHERE o.user_id = v_user.user_id AND o.purpose = 'LOGIN_EMAIL' AND o.consumed_at IS NULL
         ORDER BY o.created_at DESC LIMIT 1;
    END IF;
    IF v_otp.otp_id IS NULL OR v_otp.expires_at < now() OR v_otp.attempts >= auth_policy_max_attempts() THEN
        PERFORM auth__fail(NULL, p_email, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF v_otp.otp_hash <> crypt(p_code, v_otp.otp_hash) THEN
        UPDATE otp_requests SET attempts = attempts + 1 WHERE otp_id = v_otp.otp_id;
        PERFORM auth__fail(v_user.user_id, p_email, p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    UPDATE otp_requests SET consumed_at = now() WHERE otp_id = v_otp.otp_id;
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
    INSERT INTO login_attempts (identifier, ip_address, succeeded) VALUES (lower(trim(p_email)), p_ip, TRUE);
    RETURN QUERY SELECT * FROM auth__issue_session(
        v_user, p_token_hash, 'EMAIL_CODE', p_ip, p_user_agent, p_device_id, p_ttl_minutes);
END;
$$;

-- ── Two-step sign-in (TOTP, RFC 6238: SHA-1, 6 digits, 30 s) ────────────────
CREATE OR REPLACE FUNCTION erp_totp(p_secret BYTEA, p_step BIGINT) RETURNS INT
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = public, extensions, pg_temp AS $$
DECLARE h BYTEA; o INT;
BEGIN
    h := hmac(int8send(p_step), p_secret, 'sha1');
    o := get_byte(h, 19) & 15;
    RETURN (((get_byte(h, o) & 127) << 24) | (get_byte(h, o + 1) << 16)
            | (get_byte(h, o + 2) << 8) | get_byte(h, o + 3)) % 1000000;
END;
$$;

-- The step a 6-digit code matches (one 30-second step of clock drift either
-- way), or NULL. A step already used is refused, so a code cannot be replayed.
CREATE OR REPLACE FUNCTION erp_totp_match(p_secret BYTEA, p_code TEXT, p_after_step BIGINT)
RETURNS BIGINT LANGUAGE plpgsql STABLE SET search_path = public, extensions, pg_temp AS $$
DECLARE v_now BIGINT := floor(extract(epoch FROM clock_timestamp()) / 30); i INT;
BEGIN
    IF p_code !~ '^[0-9]{6}$' THEN RETURN NULL; END IF;
    FOR i IN -1..1 LOOP
        IF erp_totp(p_secret, v_now + i) = p_code::INT AND v_now + i > COALESCE(p_after_step, 0) THEN
            RETURN v_now + i;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION auth_mfa_status(p_user_id UUID)
RETURNS TABLE (enabled BOOLEAN, enabled_at TIMESTAMPTZ, recovery_codes_left INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT m.enabled_at IS NOT NULL, m.enabled_at,
           (SELECT count(*)::INT FROM user_mfa_recovery r WHERE r.user_id = p_user_id AND r.used_at IS NULL)
      FROM (SELECT 1) one LEFT JOIN user_mfa m ON m.user_id = p_user_id;
$$;

-- Starts (or restarts) setup: a fresh key, not yet in force. Refused while
-- two-step is already on — it has to be turned off with a code first.
CREATE OR REPLACE FUNCTION auth_mfa_begin(p_user_id UUID) RETURNS BYTEA
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_secret BYTEA := gen_random_bytes(20);
BEGIN
    IF EXISTS (SELECT 1 FROM user_mfa WHERE user_id = p_user_id AND enabled_at IS NOT NULL) THEN
        RETURN NULL;
    END IF;
    INSERT INTO user_mfa (user_id, secret) VALUES (p_user_id, v_secret)
    ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, enabled_at = NULL, last_used_step = NULL, created_at = now();
    RETURN v_secret;
END;
$$;

-- Confirms setup with a code from the app and returns ten one-time recovery
-- codes, in the clear, this once. NULL if the code is wrong.
CREATE OR REPLACE FUNCTION auth_mfa_enable(p_user_id UUID, p_code TEXT) RETURNS TEXT[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_mfa user_mfa; v_step BIGINT; v_codes TEXT[] := '{}'; v_code TEXT; i INT;
BEGIN
    SELECT * INTO v_mfa FROM user_mfa WHERE user_id = p_user_id AND enabled_at IS NULL FOR UPDATE;
    IF v_mfa.user_id IS NULL THEN RETURN NULL; END IF;
    v_step := erp_totp_match(v_mfa.secret, p_code, NULL);
    IF v_step IS NULL THEN RETURN NULL; END IF;
    UPDATE user_mfa SET enabled_at = now(), last_used_step = v_step WHERE user_id = p_user_id;
    DELETE FROM user_mfa_recovery WHERE user_id = p_user_id;
    FOR i IN 1..10 LOOP
        v_code := upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 5) || '-' || substr(encode(gen_random_bytes(5), 'hex'), 1, 5));
        INSERT INTO user_mfa_recovery (user_id, code_hash) VALUES (p_user_id, crypt(v_code, gen_salt('bf', 8)));
        v_codes := v_codes || v_code;
    END LOOP;
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
    VALUES (p_user_id, 'TWO_STEP_ENABLED', 'users', p_user_id, '{}'::jsonb);
    RETURN v_codes;
END;
$$;

-- Checks a second-step code (authenticator or recovery) for a user and spends it.
CREATE OR REPLACE FUNCTION auth__mfa_check(p_user_id UUID, p_code TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_mfa user_mfa; v_step BIGINT; v_code TEXT := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')); v_rec UUID;
BEGIN
    SELECT * INTO v_mfa FROM user_mfa WHERE user_id = p_user_id AND enabled_at IS NOT NULL FOR UPDATE;
    IF v_mfa.user_id IS NULL THEN RETURN FALSE; END IF;
    v_step := erp_totp_match(v_mfa.secret, v_code, v_mfa.last_used_step);
    IF v_step IS NOT NULL THEN
        UPDATE user_mfa SET last_used_step = v_step WHERE user_id = p_user_id;
        RETURN TRUE;
    END IF;
    IF v_code ~ '^[0-9A-F]{5}-?[0-9A-F]{5}$' THEN
        IF length(v_code) = 10 THEN v_code := substr(v_code, 1, 5) || '-' || substr(v_code, 6); END IF;
        SELECT r.id INTO v_rec FROM user_mfa_recovery r
         WHERE r.user_id = p_user_id AND r.used_at IS NULL AND r.code_hash = crypt(v_code, r.code_hash) LIMIT 1;
        IF v_rec IS NOT NULL THEN
            UPDATE user_mfa_recovery SET used_at = now() WHERE id = v_rec;
            RETURN TRUE;
        END IF;
    END IF;
    RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION auth_mfa_disable(p_user_id UUID, p_code TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
    IF NOT auth__mfa_check(p_user_id, p_code) THEN RETURN FALSE; END IF;
    DELETE FROM user_mfa_recovery WHERE user_id = p_user_id;
    DELETE FROM user_mfa WHERE user_id = p_user_id;
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
    VALUES (p_user_id, 'TWO_STEP_DISABLED', 'users', p_user_id, '{}'::jsonb);
    RETURN TRUE;
END;
$$;

-- The Owner turns two-step off for someone who lost their phone (the route
-- checks manage_users). Their sessions end, so they sign in afresh.
CREATE OR REPLACE FUNCTION auth_mfa_admin_reset(p_user_id UUID, p_actor UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
    DELETE FROM user_mfa_recovery WHERE user_id = p_user_id;
    DELETE FROM user_mfa WHERE user_id = p_user_id;
    UPDATE user_sessions SET revoked_at = now() WHERE user_id = p_user_id AND revoked_at IS NULL;
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, new_value)
    VALUES (p_actor, 'TWO_STEP_RESET', 'users', p_user_id, '{}'::jsonb);
END;
$$;

-- Completes a sign-in that is waiting for its second step. Wrong codes count
-- towards the same lockout as wrong passwords; the half-open session expires
-- after ten minutes.
CREATE OR REPLACE FUNCTION auth_mfa_verify_session(p_token_hash TEXT, p_code TEXT, p_ip INET DEFAULT NULL)
RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_s user_sessions; v_user users;
BEGIN
    SELECT * INTO v_s FROM user_sessions s
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.mfa_pending
       AND s.expires_at > now() AND s.created_at > now() - interval '10 minutes'
     FOR UPDATE;
    IF v_s.session_id IS NULL THEN
        RETURN QUERY SELECT 'EXPIRED'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    SELECT * INTO v_user FROM users u WHERE u.user_id = v_s.user_id;
    IF NOT v_user.is_active THEN
        UPDATE user_sessions SET revoked_at = now() WHERE session_id = v_s.session_id;
        RETURN QUERY SELECT 'INACTIVE'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    END IF;
    IF v_user.locked_until IS NOT NULL AND v_user.locked_until > now() THEN
        UPDATE user_sessions SET revoked_at = now() WHERE session_id = v_s.session_id;
        RETURN QUERY SELECT 'LOCKED'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, v_user.locked_until;
        RETURN;
    END IF;
    -- Two-step was switched off for this person meanwhile: nothing left to check.
    IF NOT EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = v_user.user_id AND m.enabled_at IS NOT NULL) THEN
        UPDATE user_sessions SET mfa_pending = FALSE WHERE session_id = v_s.session_id;
    ELSIF NOT auth__mfa_check(v_user.user_id, p_code) THEN
        PERFORM auth__fail(v_user.user_id, coalesce(v_user.email, v_user.phone, 'two-step'), p_ip);
        RETURN QUERY SELECT 'INVALID'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
        RETURN;
    ELSE
        UPDATE user_sessions SET mfa_pending = FALSE WHERE session_id = v_s.session_id;
    END IF;
    UPDATE users u SET failed_attempts = 0, locked_until = NULL WHERE u.user_id = v_user.user_id;
    RETURN QUERY SELECT 'OK'::TEXT, v_user.user_id, v_user.role::TEXT, v_user.branch_id,
        v_user.full_name, v_user.email, v_user.phone, v_user.language_pref,
        v_user.must_change_password, v_s.expires_at;
END;
$$;

-- ── Sign-in history ────────────────────────────────────────────────────────
-- Successful and failed attempts against this person's email or phone (failed
-- attempts are kept by what was typed, so they exist even for wrong passwords).
CREATE OR REPLACE FUNCTION auth_sign_in_history(p_user_id UUID, p_limit INT DEFAULT 30)
RETURNS TABLE (attempted_at TIMESTAMPTZ, succeeded BOOLEAN, ip TEXT, identifier TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT a.attempted_at, a.succeeded, host(a.ip_address), a.identifier
      FROM login_attempts a, users u
     WHERE u.user_id = p_user_id
       AND (a.identifier = lower(u.email) OR a.identifier = lower(u.phone) OR a.identifier = u.phone)
     ORDER BY a.attempted_at DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;

-- How many signed-in sessions a person has (the Owner's view of a user).
CREATE OR REPLACE FUNCTION auth_session_count(p_user_id UUID) RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
    SELECT count(*)::INT FROM user_sessions s
     WHERE s.user_id = p_user_id AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending;
$$;

-- ── Session issue / resolve, aware of the second step ──────────────────────
CREATE OR REPLACE FUNCTION auth__issue_session(
    p_user users, p_token_hash TEXT, p_method TEXT, p_ip INET,
    p_user_agent TEXT, p_device_id TEXT, p_ttl_minutes INT
) RETURNS TABLE (
    status TEXT, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
    v_expires TIMESTAMPTZ := now() + make_interval(mins => p_ttl_minutes);
    -- With two-step on, the session is created but unusable until the code is
    -- checked (auth_mfa_verify_session); auth_session_resolve ignores it till then.
    v_mfa BOOLEAN := EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = p_user.user_id AND m.enabled_at IS NOT NULL);
BEGIN
    UPDATE users u SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
     WHERE u.user_id = p_user.user_id;

    INSERT INTO user_sessions (user_id, token_hash, device_id, branch_id, login_method,
                               ip_address, user_agent, expires_at, mfa_pending)
    VALUES (p_user.user_id, p_token_hash, p_device_id, p_user.branch_id, p_method,
            p_ip, p_user_agent, v_expires, v_mfa);

    -- Section 43 — a successful sign-in is a security event the owner can see in
    -- the audit log. Failed attempts are in login_attempts (keyed on the typed
    -- identifier, so they exist even for accounts that do not).
    INSERT INTO audit_log (user_id, branch_id, action, entity_type, entity_id, new_value)
    VALUES (p_user.user_id, p_user.branch_id, 'LOGIN', 'users', p_user.user_id,
            jsonb_build_object('method', p_method, 'ip', host(p_ip), 'two_step', v_mfa));

    RETURN QUERY SELECT CASE WHEN v_mfa THEN 'MFA_REQUIRED' ELSE 'OK' END, p_user.user_id, p_user.role::TEXT,
        p_user.branch_id, p_user.full_name, p_user.email, p_user.phone, p_user.language_pref,
        p_user.must_change_password, v_expires;
END;
$$;

CREATE OR REPLACE FUNCTION auth_session_resolve(p_token_hash TEXT)
RETURNS TABLE (
    session_id UUID, user_id UUID, role TEXT, branch_id UUID, full_name TEXT,
    email TEXT, phone TEXT, language_pref TEXT, must_change_password BOOLEAN,
    expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
    UPDATE user_sessions s SET last_seen_at = now()
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending;

    RETURN QUERY
    SELECT s.session_id, u.user_id, u.role::TEXT, u.branch_id, u.full_name, u.email, u.phone,
           u.language_pref, u.must_change_password, s.expires_at
      FROM user_sessions s JOIN users u ON u.user_id = s.user_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL AND s.expires_at > now() AND NOT s.mfa_pending AND u.is_active;
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
