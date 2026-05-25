CREATE TYPE "public"."tracking_dispatch_status" AS ENUM('pending', 'sent', 'failed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."tracking_event_type" AS ENUM('page_view', 'view_content', 'add_to_cart', 'initiate_checkout', 'add_payment_info', 'purchase', 'subscribe', 'subscription_renew', 'lead', 'complete_registration');--> statement-breakpoint
CREATE TYPE "public"."tracking_provider" AS ENUM('meta', 'google_ads', 'ga4', 'tiktok', 'pinterest', 'kwai');--> statement-breakpoint
CREATE TABLE "tracking_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pixel_id" uuid NOT NULL,
	"event_type" "tracking_event_type" NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"provider_event_id" text,
	"payload" jsonb NOT NULL,
	"response" jsonb,
	"http_status" integer,
	"status" "tracking_dispatch_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp (3) with time zone,
	"sent_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_pixels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "tracking_provider" NOT NULL,
	"label" text NOT NULL,
	"public_pixel_id" text NOT NULL,
	"credentials_encrypted" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"enc_version" smallint DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"test_mode" boolean DEFAULT false NOT NULL,
	"events_enabled" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_validated_at" timestamp (3) with time zone,
	"last_error_message" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "tracking_dispatches" ADD CONSTRAINT "tracking_dispatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_dispatches" ADD CONSTRAINT "tracking_dispatches_pixel_id_tracking_pixels_id_fk" FOREIGN KEY ("pixel_id") REFERENCES "public"."tracking_pixels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_pixels" ADD CONSTRAINT "tracking_pixels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_dispatch_unique" ON "tracking_dispatches" USING btree ("workspace_id","pixel_id","source_type","source_id","event_type");--> statement-breakpoint
CREATE INDEX "tracking_dispatch_workspace_status_idx" ON "tracking_dispatches" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "tracking_dispatch_next_attempt_idx" ON "tracking_dispatches" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "tracking_pixels_workspace_idx" ON "tracking_pixels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tracking_pixels_provider_idx" ON "tracking_pixels" USING btree ("workspace_id","provider");