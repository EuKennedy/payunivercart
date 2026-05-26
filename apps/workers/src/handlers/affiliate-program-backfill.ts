import { type DatabaseClient, schema } from '@payunivercart/db';
import { sql } from 'drizzle-orm';

/**
 * Ongoing self-heal for the workspace-wide default affiliate program.
 *
 * The runtime path `marketplace.publish → ensureDefaultAffiliateProgram`
 * provisions the program at the moment a listing goes live. Two
 * failure modes leave a workspace without a program despite having a
 * live listing:
 *
 *   1. A pre-existing listing that flipped to live BEFORE the
 *      auto-provisioner shipped. The 0017/0019 backfill migrations
 *      cover this on deploy, but if a migration race left
 *      `__drizzle_migrations` recording success without the INSERT
 *      committing (rare; possible during the unhealthy-API churn of
 *      late May), this worker catches it within an hour.
 *
 *   2. Direct SQL inserts into `marketplace_listings` (admin tooling,
 *      future bulk-import flow) that don't go through the publish
 *      mutation. The runtime path can't cover them; this worker does.
 *
 * Idempotent: a single SQL statement, `NOT EXISTS` guard against
 * duplicates, no in-application loop. Runs hourly; empty result set
 * is the steady state.
 */

const SQL_BACKFILL = sql`
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
    )
  RETURNING workspace_id
`;

export interface AffiliateBackfillResult {
  provisioned: number;
}

export async function runAffiliateProgramBackfill(ctx: {
  db: DatabaseClient;
}): Promise<AffiliateBackfillResult> {
  const result = await ctx.db.execute(SQL_BACKFILL);
  const rowCount = Number((result as { rowCount?: number })?.rowCount ?? 0);
  // Reference schema so the import isn't tree-shaken in a future
  // refactor that splits this file. Cheap.
  void schema.affiliatePrograms;
  return { provisioned: rowCount };
}
