-- Producer-customised sales-page URL for marketplace listings.
-- NULL = affiliate lands on the default checkout /c/<slug>; non-null
-- overrides to whatever VSL/longform page the producer runs ahead of
-- their funnel.
-- `IF NOT EXISTS` keeps a re-run idempotent if a partial deploy
-- already landed the column.
ALTER TABLE "marketplace_listings" ADD COLUMN IF NOT EXISTS "sales_page_url" text;
