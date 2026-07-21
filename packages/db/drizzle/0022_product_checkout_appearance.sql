-- Per-product checkout appearance: an evergreen scarcity countdown
-- and a full-width promotional top banner, both configured on the
-- product edit screen and rendered on the public checkout at
-- /c/<slug>.
--
-- The countdown is per-visitor, not a shared deadline: the clock
-- starts on that buyer's first open and lives in their localStorage,
-- so `checkout_timer_minutes` is a duration and there is deliberately
-- no `expires_at` column here to keep in sync. At 00:00 the producer
-- picks `restart` (loop the cycle) or `last_chance` (freeze the
-- counter, swap in the last-chance copy, and optionally apply the
-- discount held in the three `checkout_timer_discount_*` columns).
-- The public checkout never sends an amount over the wire, so those
-- columns are the only source of any price reduction — which is what
-- the CHECKs are for: they are this table's last line of defence
-- against a bad direct UPDATE. The percent ceiling is 90 and not 100
-- on purpose: a full discount produces `amount: 0`, which every
-- gateway rejects AFTER the order row already exists.
--
-- NULL means "not configured, fall back to the app default" for every
-- nullable column here — both message columns, both banner colours,
-- the banner text and the banner link. A NULL
-- `checkout_timer_discount_type` means no discount at all. The two
-- `*_mime` columns are NULL iff their bytea twin is NULL; the public
-- checkout query keys the image URL off that MIME sentinel so it
-- never has to select the bytes on its hottest read path.
--
-- Both features ship as text() + CHECK instead of new pg types:
-- Postgres has no `CREATE TYPE IF NOT EXISTS`, and keeping every
-- ADD COLUMN idempotent matters more than a native enum when a
-- partial deploy can land half of this file. `NOT NULL DEFAULT` is
-- metadata-only in PG 11+, so none of the 18 columns rewrites the
-- table. The six ADD CONSTRAINTs are NOT idempotent (Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`) — accepted, same as 0003.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_message" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_expired_behavior" text DEFAULT 'restart' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_expired_message" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_discount_type" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_discount_percent" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_timer_discount_cents" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_type" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_image" "bytea";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_image_mime" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_image_mobile" "bytea";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_image_mobile_mime" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_text" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_bg_color" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_text_color" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "checkout_banner_link_url" text;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_checkout_timer_minutes_range" CHECK (checkout_timer_minutes BETWEEN 1 AND 1440);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_checkout_timer_expired_behavior_valid" CHECK (checkout_timer_expired_behavior IN ('restart', 'last_chance'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_checkout_timer_discount_type_valid" CHECK (checkout_timer_discount_type IS NULL OR checkout_timer_discount_type IN ('percent', 'fixed'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_checkout_timer_discount_percent_range" CHECK (checkout_timer_discount_percent IS NULL OR checkout_timer_discount_percent BETWEEN 1 AND 90);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_checkout_timer_discount_cents_nonneg" CHECK (checkout_timer_discount_cents IS NULL OR checkout_timer_discount_cents >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_checkout_banner_type_valid" CHECK (checkout_banner_type IN ('image', 'text'));
