-- =========================================================================
-- packages/db — Postgres role provisioning
-- -------------------------------------------------------------------------
-- One-shot script to create the three runtime roles described in the
-- RLS docs (02_rls_policies.sql). Run as a superuser on the target
-- cluster; subsequent re-runs are idempotent (CREATE ROLE IF NOT
-- EXISTS via DO block).
--
-- After running this, set the connection strings:
--
--   apps/api      → DATABASE_URL=postgres://payunivercart_app:...
--   apps/workers  → DATABASE_URL=postgres://payunivercart_worker:...
--
-- The `payunivercart_owner` role keeps owning the schema for migrations
-- and is the one drizzle-kit connects with.
--
-- IMPORTANT: this file does NOT GRANT individual table privileges. It
-- ALTER DEFAULTs the privileges so any table the owner creates next is
-- automatically readable/writable by app+worker. Re-run after a fresh
-- migration drops new tables to apply the defaults to those too.
-- =========================================================================

-- 1. Create roles if they don't exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payunivercart_owner') THEN
    CREATE ROLE payunivercart_owner LOGIN PASSWORD 'CHANGE_ME_owner';
    COMMENT ON ROLE payunivercart_owner IS
      'Owns the public schema. Runs migrations. Subject to RLS via FORCE.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payunivercart_app') THEN
    CREATE ROLE payunivercart_app LOGIN PASSWORD 'CHANGE_ME_app';
    COMMENT ON ROLE payunivercart_app IS
      'apps/api runtime. NO BYPASSRLS — must use withWorkspace(...) for '
      'every tenant query.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payunivercart_worker') THEN
    CREATE ROLE payunivercart_worker LOGIN PASSWORD 'CHANGE_ME_worker' BYPASSRLS;
    COMMENT ON ROLE payunivercart_worker IS
      'apps/workers runtime. HAS BYPASSRLS because sweep jobs (recovery, '
      'webhook outbox, tracking dispatch, marketplace rollup) are '
      'intentionally cross-tenant. MUST NOT serve user requests.';
  END IF;
END$$;

-- 2. Grant schema access to non-owner roles.
GRANT USAGE ON SCHEMA public TO payunivercart_app, payunivercart_worker;

-- 3. Existing tables — bulk grant. Future tables get covered by the
--    ALTER DEFAULT PRIVILEGES below.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;

GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;

GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA public
  TO payunivercart_app, payunivercart_worker;

-- 4. ALTER DEFAULT PRIVILEGES — anything `payunivercart_owner` creates
--    next inherits the same grants without needing a manual GRANT pass.
ALTER DEFAULT PRIVILEGES FOR ROLE payunivercart_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO payunivercart_app, payunivercart_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE payunivercart_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES
  TO payunivercart_app, payunivercart_worker;

ALTER DEFAULT PRIVILEGES FOR ROLE payunivercart_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS
  TO payunivercart_app, payunivercart_worker;

-- 5. Make sure the owner role actually OWNS every existing object so
--    the ALTER DEFAULTs above apply. Idempotent.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schemaname, c.relname AS tablename, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'S', 'v', 'm')
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO payunivercart_owner',
      CASE r.relkind
        WHEN 'r' THEN 'TABLE'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
      END,
      r.tablename
    );
  END LOOP;
END$$;

-- 6. Public marketplace browse — explicit GRANT on the path the
--    anonymous reader needs even when app.workspace_id is NOT set.
--    Permissive RLS policy on marketplace_listings (03_rls_policies_pilars.sql)
--    handles the row filter; this GRANT just lets the role read the
--    rows the policy would allow.
GRANT SELECT ON
  public.marketplace_listings,
  public.products,
  public.workspaces
  TO payunivercart_app;
