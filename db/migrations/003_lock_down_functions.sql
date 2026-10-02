-- ============================================================================
-- 003 — the app's functions are callable by the app role only.
--
-- Postgres lets PUBLIC execute every new function. On Supabase that includes the
-- `anon` and `authenticated` roles behind its auto-generated REST API, so the
-- SECURITY DEFINER auth functions (sign-in, set PIN, issue a session, approve a
-- sign-up…) were reachable at /rest/v1/rpc/… by anyone holding the project's
-- anon key — bypassing every check the API makes before calling them. This app
-- never uses that REST API: only erp_app (the Railway API) calls these.
--
--  * EXECUTE on every function this schema defines is revoked from PUBLIC (and
--    anon/authenticated where they exist) and granted to erp_app. Extension
--    functions (pg_trgm, btree_gist) are left alone.
--  * anon/authenticated lose USAGE on the public schema, so the REST API sees
--    nothing here at all.
--  * schema_migrations gets row-level security like every other table.
-- Idempotent; harmless on a server without Supabase's roles.
-- ============================================================================
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

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
