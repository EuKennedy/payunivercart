CREATE TYPE "public"."partner_key_mode" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."partner_status" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."partner_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."partner_event_type" AS ENUM('entitlement.granted', 'entitlement.role_changed', 'entitlement.suspended', 'entitlement.reactivated', 'entitlement.revoked');--> statement-breakpoint
CREATE TABLE "partner_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"contact_email" text NOT NULL,
	"status" "partner_status" DEFAULT 'pending' NOT NULL,
	"trial_access_enabled" boolean DEFAULT true NOT NULL,
	"jwt_signing_secret" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" "partner_key_mode" NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"url" text NOT NULL,
	"mode" "partner_key_mode" NOT NULL,
	"description" text,
	"event_types" jsonb DEFAULT '["entitlement.granted","entitlement.role_changed","entitlement.suspended","entitlement.reactivated","entitlement.revoked"]'::jsonb NOT NULL,
	"signing_secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subscription_id" uuid,
	"type" "partner_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" "partner_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp (3) with time zone,
	"next_attempt_at" timestamp (3) with time zone,
	"last_response_status" integer,
	"last_response_body" text,
	"delivered_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_tokens" (
	"jti" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"issued_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"redeemed_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "partner_account_id" uuid;--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "partner_role_slug" text;--> statement-breakpoint
ALTER TABLE "partner_api_keys" ADD CONSTRAINT "partner_api_keys_partner_id_partner_accounts_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_roles" ADD CONSTRAINT "partner_roles_partner_id_partner_accounts_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_webhook_endpoints" ADD CONSTRAINT "partner_webhook_endpoints_partner_id_partner_accounts_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_events" ADD CONSTRAINT "connect_events_partner_id_partner_accounts_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_events" ADD CONSTRAINT "connect_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_events" ADD CONSTRAINT "connect_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_webhook_deliveries" ADD CONSTRAINT "connect_webhook_deliveries_event_id_connect_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."connect_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_webhook_deliveries" ADD CONSTRAINT "connect_webhook_deliveries_endpoint_id_partner_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."partner_webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_tokens" ADD CONSTRAINT "entitlement_tokens_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_tokens" ADD CONSTRAINT "entitlement_tokens_partner_id_partner_accounts_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partner_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_accounts_slug_unique" ON "partner_accounts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "partner_api_keys_partner_idx" ON "partner_api_keys" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_api_keys_active_idx" ON "partner_api_keys" USING btree ("partner_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_api_keys_prefix_unique" ON "partner_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_roles_slug_unique" ON "partner_roles" USING btree ("partner_id","slug");--> statement-breakpoint
CREATE INDEX "partner_webhook_endpoints_partner_idx" ON "partner_webhook_endpoints" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_webhook_endpoints_active_idx" ON "partner_webhook_endpoints" USING btree ("partner_id","is_active");--> statement-breakpoint
CREATE INDEX "connect_events_partner_idx" ON "connect_events" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "connect_events_workspace_idx" ON "connect_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "connect_events_subscription_idx" ON "connect_events" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "connect_events_type_created_idx" ON "connect_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "connect_deliveries_event_idx" ON "connect_webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "connect_deliveries_endpoint_idx" ON "connect_webhook_deliveries" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "connect_deliveries_status_next_idx" ON "connect_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "entitlement_tokens_subscription_idx" ON "entitlement_tokens" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "entitlement_tokens_partner_idx" ON "entitlement_tokens" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "entitlement_tokens_expires_idx" ON "entitlement_tokens" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_partner_account_id_partner_accounts_id_fk" FOREIGN KEY ("partner_account_id") REFERENCES "public"."partner_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_plans_partner_idx" ON "subscription_plans" USING btree ("partner_account_id");