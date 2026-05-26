-- Backfill default workspace-wide affiliate program for every workspace
-- that already has a live marketplace listing but no default program.
-- Forward-fixes the bug where marketplace.publish (before commit X)
-- didn't auto-provision the program, leaving listings invisible to the
-- /afiliar shop.
--
-- Idempotent — repeated runs are no-ops because the WHERE clause filters
-- out workspaces that already have a default program. Same row shape as
-- the runtime `ensureDefaultAffiliateProgram` helper.

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
  NULL,
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
