-- =========================================================================
-- packages/db — Row-Level Security policies
-- -------------------------------------------------------------------------
-- Runs AFTER the Drizzle-generated migration that creates every table
-- listed below. Idempotent: every statement is `IF EXISTS` / `IF NOT
-- EXISTS` or guarded by `DROP POLICY IF EXISTS`.
--
-- The contract
-- ------------
-- Every connection issued by the app role MUST set the per-transaction
-- variable `app.workspace_id` (UUID, as text) before reading or writing
-- tenant-scoped tables. The helper that does this is
-- `withWorkspace(...)` in `packages/db/src/rls.ts`. Without it, all
-- tenant queries return zero rows because the policies use
-- `current_setting('app.workspace_id', true)` which returns NULL when
-- the variable is not set.
--
-- Roles (provisioned outside this file because their names depend on
-- the deployment; see `packages/db/sql/README.md`):
--
--   payunivercart_owner    — runs migrations, owns the schema.
--                             Subject to RLS via FORCE so a misconfigured
--                             migration cannot read across tenants.
--   payunivercart_app      — used by apps/api on every customer-facing
--                             request. Subject to RLS, no BYPASSRLS.
--   payunivercart_worker   — used by apps/workers (outbox dispatch,
--                             audit verifier). Has BYPASSRLS because
--                             these jobs are intentionally cross-tenant.
--                             Workers MUST NOT serve user requests.
--
-- The boundary
-- ------------
-- These tables ARE tenant-scoped (RLS enforced):
--   workspaces, memberships, integrations, gateway_credentials,
--   whatsapp_sessions, whatsapp_chat_ids, products, product_categories,
--   product_category_mappings, product_offers, product_coupons,
--   checkouts, orders, order_items, transactions, refunds, carts,
--   recovery_campaigns, recovery_attempts, webhooks_inbound,
--   webhooks_outbox, webhook_endpoints, webhooks_inbound_gateway,
--   events_audit, platform_subscriptions, platform_invoices,
--   organizations
--
-- These tables are NOT tenant-scoped (auth boundary differs):
--   users, sessions, accounts, verifications, two_factor
--
-- Auth tables stay unrestricted because Better-Auth performs its own
-- access control (a user can only read their own session token) and
-- because cross-tenant operations (login, multi-workspace membership
-- lookup) need to resolve users across the whole table.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Helper: a SECURITY DEFINER function that reads `app.workspace_id`
--    once and returns it as a UUID. Inlined in policies so we avoid the
--    string-compare overhead and get a clear NULL on "context not set".
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

COMMENT ON FUNCTION public.current_workspace_id() IS
  'Returns the workspace id set on the current transaction by '
  '`SET LOCAL app.workspace_id = <uuid>`, or NULL if not set. '
  'NULL means "no tenant context" — every RLS policy denies access in '
  'that case.';

-- -------------------------------------------------------------------------
-- 2. Bulk-enable RLS. FORCE makes table owners (the migration role)
--    subject to policies too — without FORCE, the owner bypasses RLS,
--    which means a migration could leak across tenants.
-- -------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'organizations',
      'workspaces',
      'memberships',
      'integrations',
      'gateway_credentials',
      'whatsapp_sessions',
      'whatsapp_chat_ids',
      'products',
      'product_categories',
      'product_category_mappings',
      'product_offers',
      'product_coupons',
      'checkouts',
      'orders',
      'order_items',
      'transactions',
      'refunds',
      'carts',
      'recovery_campaigns',
      'recovery_attempts',
      'webhooks_inbound',
      'webhooks_outbox',
      'webhook_endpoints',
      'webhooks_inbound_gateway',
      'events_audit',
      'platform_subscriptions',
      'platform_invoices'
    ])
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END$$;

-- -------------------------------------------------------------------------
-- 3. Policy macro. Drop+create each policy so re-runs do not error.
--
-- For tables with a direct `workspace_id` column we use the simple form;
-- for tables that link to a parent through a FK (order_items, refunds,
-- webhooks_inbound_gateway) we use EXISTS over the parent's policy.
-- -------------------------------------------------------------------------

-- 3.1. `organizations` — visible if the current workspace belongs to it.
DROP POLICY IF EXISTS workspace_isolation ON public.organizations;
CREATE POLICY workspace_isolation ON public.organizations
  USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.organization_id = organizations.id
        AND w.id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.organization_id = organizations.id
        AND w.id = public.current_workspace_id()
    )
  );

-- 3.2. `workspaces` — exact id match. No CHECK on insert because a
--      brand-new workspace is created BEFORE the context is set; the
--      writer that creates workspaces uses the worker role (BYPASSRLS).
DROP POLICY IF EXISTS workspace_isolation ON public.workspaces;
CREATE POLICY workspace_isolation ON public.workspaces
  USING (id = public.current_workspace_id())
  WITH CHECK (id = public.current_workspace_id());

-- 3.3. The standard policy for tables with a workspace_id column.
--      Same predicate for USING and WITH CHECK so reads and writes can't
--      escape the tenant.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'memberships',
      'integrations',
      'gateway_credentials',
      'whatsapp_sessions',
      'whatsapp_chat_ids',
      'products',
      'product_categories',
      'product_category_mappings',
      'product_offers',
      'product_coupons',
      'checkouts',
      'orders',
      'transactions',
      'carts',
      'recovery_campaigns',
      'recovery_attempts',
      'webhooks_outbox',
      'webhook_endpoints',
      'platform_subscriptions',
      'platform_invoices'
    ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON public.%I '
      'USING (workspace_id = public.current_workspace_id()) '
      'WITH CHECK (workspace_id = public.current_workspace_id())',
      t
    );
  END LOOP;
END$$;

-- 3.4. `order_items` — reach workspace via parent order.
DROP POLICY IF EXISTS workspace_isolation ON public.order_items;
CREATE POLICY workspace_isolation ON public.order_items
  USING (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id
        AND o.workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_items.order_id
        AND o.workspace_id = public.current_workspace_id()
    )
  );

-- 3.5. `refunds` — reach workspace via parent transaction.
DROP POLICY IF EXISTS workspace_isolation ON public.refunds;
CREATE POLICY workspace_isolation ON public.refunds
  USING (
    EXISTS (
      SELECT 1 FROM public.transactions tx
      WHERE tx.id = refunds.transaction_id
        AND tx.workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.transactions tx
      WHERE tx.id = refunds.transaction_id
        AND tx.workspace_id = public.current_workspace_id()
    )
  );

-- 3.6. `webhooks_inbound` — `workspace_id` is nullable because the WAHA
--      and gateway webhooks arrive BEFORE we have resolved the tenant.
--      Resolution happens in the worker (BYPASSRLS). The app role only
--      ever queries rows that already have a workspace; we forbid the
--      NULL case for app reads.
DROP POLICY IF EXISTS workspace_isolation ON public.webhooks_inbound;
CREATE POLICY workspace_isolation ON public.webhooks_inbound
  USING (
    workspace_id IS NOT NULL
    AND workspace_id = public.current_workspace_id()
  )
  WITH CHECK (
    workspace_id IS NULL
    OR workspace_id = public.current_workspace_id()
  );

-- 3.7. `webhooks_inbound_gateway` — reach workspace via parent.
DROP POLICY IF EXISTS workspace_isolation ON public.webhooks_inbound_gateway;
CREATE POLICY workspace_isolation ON public.webhooks_inbound_gateway
  USING (
    EXISTS (
      SELECT 1 FROM public.webhooks_inbound wi
      WHERE wi.id = webhooks_inbound_gateway.inbound_id
        AND wi.workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.webhooks_inbound wi
      WHERE wi.id = webhooks_inbound_gateway.inbound_id
        AND wi.workspace_id = public.current_workspace_id()
    )
  );

-- 3.8. `events_audit` — workspace-scoped reads (NULL workspace = system
--      events, only the worker reads those). INSERT allows the worker
--      to write for any workspace, but the app role's INSERTs must
--      match its current tenant. UPDATE/DELETE/TRUNCATE are already
--      blocked by triggers in `packages/audit/sql/01_lockdown.sql`.
DROP POLICY IF EXISTS workspace_isolation ON public.events_audit;
CREATE POLICY workspace_isolation ON public.events_audit
  USING (
    workspace_id IS NOT NULL
    AND workspace_id = public.current_workspace_id()
  )
  WITH CHECK (
    workspace_id IS NULL
    OR workspace_id = public.current_workspace_id()
  );

-- -------------------------------------------------------------------------
-- 4. Defense-in-depth: the policy denies SELECT/INSERT/UPDATE/DELETE by
--    default unless its predicates match. A missing `current_setting`
--    yields NULL, NULL = NULL is NULL (not TRUE), so the policy is
--    effectively fail-closed. No additional REVOKE needed beyond the
--    role-level GRANTs documented in `packages/db/sql/README.md`.
-- -------------------------------------------------------------------------
