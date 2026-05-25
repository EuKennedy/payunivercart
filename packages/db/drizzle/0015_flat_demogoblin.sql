CREATE TYPE "public"."marketplace_category" AS ENUM('cursos', 'mentorias', 'comunidades', 'software', 'ebooks', 'consultorias', 'eventos', 'servicos', 'outros');--> statement-breakpoint
CREATE TYPE "public"."marketplace_listing_status" AS ENUM('draft', 'pending_review', 'live', 'paused', 'rejected');--> statement-breakpoint
CREATE TABLE "marketplace_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"click_date" text NOT NULL,
	"ip_hash" text NOT NULL,
	"referrer" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"converted_to_order" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "marketplace_listing_status" DEFAULT 'draft' NOT NULL,
	"category" "marketplace_category" DEFAULT 'outros' NOT NULL,
	"headline" text NOT NULL,
	"pitch" text DEFAULT '' NOT NULL,
	"cover_image_url" text,
	"search_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_boost" integer DEFAULT 0 NOT NULL,
	"cached_clicks" integer DEFAULT 0 NOT NULL,
	"cached_purchases" integer DEFAULT 0 NOT NULL,
	"contact_email" text,
	"moderation_note" text,
	"published_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketplace_clicks" ADD CONSTRAINT "marketplace_clicks_listing_id_marketplace_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."marketplace_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_clicks_unique_per_day" ON "marketplace_clicks" USING btree ("listing_id","click_date","ip_hash");--> statement-breakpoint
CREATE INDEX "marketplace_clicks_listing_idx" ON "marketplace_clicks" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_listings_workspace_product_unique" ON "marketplace_listings" USING btree ("workspace_id","product_id");--> statement-breakpoint
CREATE INDEX "marketplace_listings_status_idx" ON "marketplace_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "marketplace_listings_category_idx" ON "marketplace_listings" USING btree ("category");--> statement-breakpoint
CREATE INDEX "marketplace_listings_sort_idx" ON "marketplace_listings" USING btree ("sort_boost","cached_purchases");