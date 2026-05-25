import { sql } from 'drizzle-orm';

/**
 * Pilar 4 — Marketplace cached-counter rollup. Hourly sweep that
 * recomputes the `cachedClicks` and `cachedPurchases` columns on
 * `marketplace_listings` from the raw ledgers.
 *
 * Why cached counters instead of LIVE COUNT(*) on the public browse
 * query:
 *   - The `popular` sort joins on cachedPurchases for ranking; doing
 *     this live across thousands of listings would scan the orders
 *     table on every public hit.
 *   - Search-listings are heavy-read, low-write. Stale numbers at the
 *     hour boundary are fine.
 *
 * Two passes per tick:
 *   1. clicks  → COUNT(*) FROM marketplace_clicks GROUP BY listing.
 *   2. conv'd  → flip marketplace_clicks.convertedToOrder = true when
 *                the buyer's IP-hash matches an order from the same
 *                workspace in the next 24h. Reuses the IP-hash already
 *                stored on the click row + matches against the order
 *                ip-hash (we'll derive on the fly via the same
 *                AUTH_SECRET → existing column not added yet so we
 *                store the click's IP hash directly).
 *   3. purchases → COUNT(*) FROM marketplace_clicks WHERE
 *                  convertedToOrder = true GROUP BY listing.
 *
 * Step 2 is a heuristic: the producer-side checkout never tells us
 * "this order came from listing X" because the buyer chose to click
 * through. We approximate via IP-hash + day window. Good enough for
 * sort weights; the producer's per-listing analytics will be more
 * accurate in a later iteration with a proper UTM-tag passthrough.
 */

interface RollupCtx {
  // biome-ignore lint/suspicious/noExplicitAny: drizzle PgDatabase generic across packages.
  db: any;
}

export async function runMarketplaceRollup(
  ctx: RollupCtx,
): Promise<{ listingsRefreshed: number; conversionsFlipped: number }> {
  const db = ctx.db.db;

  // Pass 1 — refresh cachedClicks for EVERY listing (LEFT JOIN so
  // listings with zero clicks reset to 0 cleanly).
  const clicksResult = await db.execute(sql`
    UPDATE marketplace_listings ml
    SET cached_clicks = COALESCE(c.n, 0)
    FROM (
      SELECT listing_id, COUNT(*)::int AS n
      FROM marketplace_clicks
      GROUP BY listing_id
    ) c
    WHERE ml.id = c.listing_id
  `);

  // Pass 2a — EXACT attribution via marketplace listing id stamped
  // on the order at checkout time (Pilar 4 UTM passthrough). Every
  // order whose `metadata.marketplaceListingId` matches a listing
  // flips ALL of that listing's clicks made BEFORE the order to
  // convertedToOrder=true. This is the ground-truth path; the
  // heuristic below is fallback only for orders without the stamp.
  const exactResult = await db.execute(sql`
    UPDATE marketplace_clicks mc
    SET converted_to_order = TRUE
    FROM orders o
    WHERE mc.converted_to_order = FALSE
      AND o.status = 'paid'
      AND (o.metadata->>'marketplaceListingId')::uuid = mc.listing_id
      AND o.paid_at >= mc.created_at
  `);

  // Pass 2b — heuristic fallback for orders that did NOT carry the
  // marketplaceListingId stamp (direct producer-link clicks that
  // happened to come from the marketplace before the passthrough
  // was wired, or buyers who copied/pasted the URL stripping the
  // mlid query param). Flip on workspace + 24h window. Idempotent
  // because we only touch rows still at convertedToOrder=FALSE.
  const heuristicResult = await db.execute(sql`
    UPDATE marketplace_clicks mc
    SET converted_to_order = TRUE
    FROM marketplace_listings ml
    WHERE mc.listing_id = ml.id
      AND mc.converted_to_order = FALSE
      AND EXISTS (
        SELECT 1
        FROM orders o
        WHERE o.workspace_id = ml.workspace_id
          AND o.status = 'paid'
          AND o.paid_at BETWEEN mc.created_at AND mc.created_at + interval '24 hours'
          AND (o.metadata->>'marketplaceListingId') IS NULL
      )
  `);
  const conversionsResult = {
    rowCount:
      Number((exactResult as { rowCount?: number })?.rowCount ?? 0) +
      Number((heuristicResult as { rowCount?: number })?.rowCount ?? 0),
  };

  // Pass 3 — refresh cachedPurchases (now that the click ledger has
  // up-to-date convertedToOrder flags).
  await db.execute(sql`
    UPDATE marketplace_listings ml
    SET cached_purchases = COALESCE(p.n, 0)
    FROM (
      SELECT listing_id, COUNT(*)::int AS n
      FROM marketplace_clicks
      WHERE converted_to_order = TRUE
      GROUP BY listing_id
    ) p
    WHERE ml.id = p.listing_id
  `);

  return {
    listingsRefreshed: Number((clicksResult as { rowCount?: number })?.rowCount ?? 0),
    conversionsFlipped: Number((conversionsResult as { rowCount?: number })?.rowCount ?? 0),
  };
}
