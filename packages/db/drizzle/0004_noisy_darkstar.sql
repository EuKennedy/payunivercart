ALTER TABLE "workspaces" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "brand_logo" "bytea";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "brand_logo_mime" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cover_image" "bytea";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "cover_image_mime" text;