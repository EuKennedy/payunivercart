-- =========================================================================
-- packages/audit — events_audit lockdown
-- -------------------------------------------------------------------------
-- This migration runs AFTER the Drizzle-generated migration that creates
-- the `events_audit` table (the one produced by `pnpm db:generate` from
-- the schema in `packages/db/src/schema/audit.ts`).
--
-- Goal: make `events_audit` physically append-only at the Postgres level,
-- not just by convention. The hash chain (see `packages/audit/src/hash.ts`)
-- is tamper-evident; this trigger turns "tamper-evident" into
-- "tamper-prevented" for the in-band path. An attacker with `superuser` or
-- the ability to `ALTER TABLE ... DISABLE TRIGGER` can still bypass it,
-- but that is a separate compromise level than "any app role with UPDATE
-- can rewrite history."
--
-- Pair with the Postgres role policy described in `packages/db/README` —
-- the app role is granted SELECT + INSERT on this table only.
-- =========================================================================

-- 1. Revoke direct UPDATE / DELETE / TRUNCATE from every role except the
--    table owner (typically the migration role, e.g. `payunivercart_admin`).
--    This is belt-and-braces alongside the trigger.
REVOKE UPDATE, DELETE, TRUNCATE ON public.events_audit FROM PUBLIC;

-- 2. Trigger function that refuses any mutation regardless of who issues
--    it (TG_OP covers UPDATE, DELETE, TRUNCATE). We `RAISE` instead of
--    silently dropping the operation so the failure is visible in logs.
CREATE OR REPLACE FUNCTION public.events_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'events_audit is append-only — % is forbidden by trigger events_audit_immutable',
    TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- 3. Drop the triggers first in case this migration is re-run (idempotent).
DROP TRIGGER IF EXISTS events_audit_no_update ON public.events_audit;
DROP TRIGGER IF EXISTS events_audit_no_delete ON public.events_audit;
DROP TRIGGER IF EXISTS events_audit_no_truncate ON public.events_audit;

-- 4. Attach BEFORE-action triggers for every mutation kind.
CREATE TRIGGER events_audit_no_update
  BEFORE UPDATE ON public.events_audit
  FOR EACH ROW EXECUTE FUNCTION public.events_audit_immutable();

CREATE TRIGGER events_audit_no_delete
  BEFORE DELETE ON public.events_audit
  FOR EACH ROW EXECUTE FUNCTION public.events_audit_immutable();

-- TRUNCATE is a statement-level event; it does not have a per-row variant.
CREATE TRIGGER events_audit_no_truncate
  BEFORE TRUNCATE ON public.events_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.events_audit_immutable();

-- 5. Comment for forensic clarity in pg_dump / introspection.
COMMENT ON TABLE public.events_audit IS
  'Append-only audit log. UPDATE/DELETE/TRUNCATE blocked by triggers; '
  'hash-chained per workspace by packages/audit. Do NOT add columns '
  'without bumping the chain payload schema and re-keying.';
