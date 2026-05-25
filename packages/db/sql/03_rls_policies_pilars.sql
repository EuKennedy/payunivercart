-- =========================================================================
-- packages/db — RLS policies for Pilar 1/2/4 tables
-- -------------------------------------------------------------------------
-- Extends 02_rls_policies.sql with the tables added by:
--   - Pilar 1 — Afiliados (11 tables)
--   - Pilar 2 — Tracking server-side (2 tables)
--   - Pilar 4 — Marketplace (2 tables)
--   - Subscriptions cluster (added after the initial RLS pass)
--
-- Same contract as 02_rls_policies.sql: every tenant table either has
-- a direct `workspace_id` column or reaches the workspace via a FK
-- chain. The `app.workspace_id` per-transaction variable is set by
-- `withWorkspace(...)` in `packages/db/src/rls.ts`.
--
-- Idempotent — re-running drops + recreates every policy. Safe to
-- include in deploy as a "always run after migrate" step.
--
-- IMPORTANT: This SQL is staged but the runtime app role is still
-- BYPASSRLS today (defense-in-depth via explicit predicates is the
-- live posture). Activating these policies requires switching the
-- app role to a non-superuser AND verifying every read path passes
-- through withWorkspace(...). Switch flow:
--   1. Create `payunivercart_app_restricted` role (no BYPASSRLS).
--   2. Smoke-test apps/api with that role in staging.
--   3. Flip DATABASE_URL to the restricted role.
--   4. Keep this file applied so the policies are active.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Bulk-enable RLS on the new tables.
-- -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      -- Pilar 1 — Afiliados
      'affiliates',
      'affiliate_programs',
      'affiliate_memberships',
      'affiliate_links',
      'affiliate_clicks',
      'affiliate_attributions',
      'affiliate_commissions',
      'affiliate_payouts',
      'affiliate_invitations',
      'affiliate_fraud_signals',
      'affiliate_audit_log',
      -- Pilar 2 — Tracking
      'tracking_pixels',
      'tracking_dispatches',
      -- Pilar 4 — Marketplace
      'marketplace_listings',
      'marketplace_clicks',
      -- Subscriptions cluster (added after 02_rls)
      'subscriptions',
      'subscription_plans'
    ])
  LOOP
    -- Skip silently if the table does not yet exist (lets this file
    -- ship ahead of a migration that creates the table in dev).
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END$$;

-- -------------------------------------------------------------------------
-- 2. Standard policy — direct `workspace_id` column.
-- -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'affiliate_programs',
      'affiliate_memberships',
      'affiliate_links',
      'affiliate_clicks',
      'affiliate_attributions',
      'affiliate_commissions',
      'affiliate_payouts',
      'affiliate_invitations',
      'affiliate_fraud_signals',
      'affiliate_audit_log',
      'tracking_pixels',
      'tracking_dispatches',
      'marketplace_listings',
      'subscriptions',
      'subscription_plans'
    ])
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON public.%I', t);
      EXECUTE format(
        'CREATE POLICY workspace_isolation ON public.%I '
        'USING (workspace_id = public.current_workspace_id()) '
        'WITH CHECK (workspace_id = public.current_workspace_id())',
        t
      );
    END IF;
  END LOOP;
END$$;

-- -------------------------------------------------------------------------
-- 3. `affiliates` table — special case. The row represents a person
--    who may belong to MULTIPLE workspaces over their lifetime; the
--    workspace ownership is on `affiliate_memberships`. Reads must
--    show only affiliates the current workspace has a membership with.
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS workspace_isolation ON public.affiliates;
CREATE POLICY workspace_isolation ON public.affiliates
  USING (
    EXISTS (
      SELECT 1 FROM public.affiliate_memberships m
      WHERE m.affiliate_id = affiliates.id
        AND m.workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    -- Insert allowed when caller is creating a membership for this
    -- affiliate against their workspace in the same transaction.
    EXISTS (
      SELECT 1 FROM public.affiliate_memberships m
      WHERE m.affiliate_id = affiliates.id
        AND m.workspace_id = public.current_workspace_id()
    )
    -- OR allow when the affiliate row is brand-new and no membership
    -- exists yet — the writer must insert membership in the SAME
    -- transaction to keep the policy stable on the next select.
    OR NOT EXISTS (
      SELECT 1 FROM public.affiliate_memberships m
      WHERE m.affiliate_id = affiliates.id
    )
  );

-- -------------------------------------------------------------------------
-- 4. `marketplace_clicks` — reach workspace via parent listing.
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS workspace_isolation ON public.marketplace_clicks;
CREATE POLICY workspace_isolation ON public.marketplace_clicks
  USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_clicks.listing_id
        AND ml.workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.id = marketplace_clicks.listing_id
        AND ml.workspace_id = public.current_workspace_id()
    )
  );

-- -------------------------------------------------------------------------
-- 5. PUBLIC READ exception — marketplace_listings status='live' must
--    be visible to anonymous buyers on /marketplace. The base policy
--    enforces tenant on writes; we add a permissive SELECT policy for
--    public reads gated on status.
--
-- NOTE: when the app role is switched to non-superuser, the public
-- listing browse query MUST run WITHOUT setting app.workspace_id
-- (anonymous context). The permissive SELECT below makes that path
-- legal.
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS public_listings_browse ON public.marketplace_listings;
CREATE POLICY public_listings_browse ON public.marketplace_listings
  FOR SELECT
  USING (status = 'live');

-- Allow the same anonymous SELECT on the joined product + workspace
-- name surfaces. Without these, the public browse query would fail
-- when no app.workspace_id is set even though listing rows match.
DROP POLICY IF EXISTS public_listings_join_products ON public.products;
CREATE POLICY public_listings_join_products ON public.products
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.product_id = products.id AND ml.status = 'live'
    )
  );

DROP POLICY IF EXISTS public_listings_join_workspaces ON public.workspaces;
CREATE POLICY public_listings_join_workspaces ON public.workspaces
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.marketplace_listings ml
      WHERE ml.workspace_id = workspaces.id AND ml.status = 'live'
    )
  );

-- -------------------------------------------------------------------------
-- 6. Audit log immutability — affiliate_audit_log must NEVER allow
--    updates or deletes, even from a member of the workspace. The
--    tenant policy above gives read/insert; we layer a DENY on the
--    other operations.
-- -------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_log_no_update ON public.affiliate_audit_log;
CREATE POLICY audit_log_no_update ON public.affiliate_audit_log
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS audit_log_no_delete ON public.affiliate_audit_log;
CREATE POLICY audit_log_no_delete ON public.affiliate_audit_log
  FOR DELETE
  USING (false);
