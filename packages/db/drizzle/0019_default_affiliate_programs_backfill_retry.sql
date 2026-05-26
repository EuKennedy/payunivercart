-- Second-pass backfill of the workspace-wide default affiliate program
-- for every workspace that has a `live` marketplace listing but no
-- default program yet.
--
-- Why a duplicate of 0017: the first backfill landed during a series
-- of failed deploys (migrate succeeded but API healthcheck blew up),
-- and we lost visibility into whether the INSERT actually committed
-- or got rolled back in the surrounding transaction. Adding a fresh
-- migration with a NEW hash forces drizzle to re-execute the INSERT
-- on the next deploy regardless of what `__drizzle_migrations`
-- recorded earlier. Idempotent (`NOT EXISTS` guard) so a workspace
-- that already has a default program is left alone.
--
-- The runtime worker `affiliate-program-backfill` covers ongoing
-- drift (a producer who created a workspace AFTER this migration ran
-- still gets a program auto-provisioned within an hour).

DO $$
BEGIN
  INSERT INTO affiliate_programs (
    workspace_id,
    product_id,
    name,
    description,
    approval_policy,
    is_public,
    is_active,
    commission_type,
    commission_percent,
    refund_window_days,
    attribution_window_days
  )
  SELECT DISTINCT
    ml.workspace_id,
    NULL::uuid,
    'Programa padrão',
    'Criado automaticamente para o seu primeiro listing público no marketplace. Edite as regras em Afiliados → Programas.',
    'manual'::affiliate_approval_policy,
    'true'::jsonb,
    'true'::jsonb,
    'percent'::affiliate_commission_type,
    30,
    30,
    60
  FROM marketplace_listings ml
  WHERE ml.status = 'live'
    AND NOT EXISTS (
      SELECT 1 FROM affiliate_programs ap
      WHERE ap.workspace_id = ml.workspace_id
        AND ap.product_id IS NULL
    );
END$$;
