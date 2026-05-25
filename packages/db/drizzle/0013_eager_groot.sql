CREATE TYPE "public"."affiliate_approval_policy" AS ENUM('automatic', 'manual', 'invite_only');--> statement-breakpoint
CREATE TYPE "public"."affiliate_commission_status" AS ENUM('pending', 'available', 'paid', 'reversed', 'void');--> statement-breakpoint
CREATE TYPE "public"."affiliate_commission_type" AS ENUM('percent', 'flat', 'recurring', 'lifetime');--> statement-breakpoint
CREATE TYPE "public"."affiliate_fraud_severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."affiliate_membership_status" AS ENUM('pending', 'approved', 'rejected', 'suspended', 'left');--> statement-breakpoint
CREATE TYPE "public"."affiliate_payout_status" AS ENUM('requested', 'reviewing', 'approved', 'processing', 'paid', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "affiliate_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"link_id" uuid,
	"click_id" uuid,
	"order_id" uuid,
	"subscription_id" uuid,
	"attributed_seconds" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"target_table" text NOT NULL,
	"target_id" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"product_id" uuid,
	"ip_hash" text NOT NULL,
	"fingerprint" text,
	"user_agent" text,
	"referrer" text,
	"country" text,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attribution_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"order_id" uuid,
	"subscription_id" uuid,
	"cycle_number" integer,
	"gross_amount_cents" bigint NOT NULL,
	"commission_amount_cents" bigint NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"status" "affiliate_commission_status" DEFAULT 'pending' NOT NULL,
	"available_at" timestamp (3) with time zone,
	"paid_at" timestamp (3) with time zone,
	"reversal_reason" text,
	"payout_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_fraud_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"click_id" uuid,
	"attribution_id" uuid,
	"signal_type" text NOT NULL,
	"severity" "affiliate_fraud_severity" DEFAULT 'info' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp (3) with time zone,
	"resolved_by_user_id" uuid,
	"resolution_note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"message" text,
	"expires_at" timestamp (3) with time zone,
	"accepted_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"product_id" uuid,
	"slug" text NOT NULL,
	"label" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"click_count" bigint DEFAULT 0 NOT NULL,
	"attribution_count" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"is_active" jsonb DEFAULT 'true'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"status" "affiliate_membership_status" DEFAULT 'pending' NOT NULL,
	"producer_note" text,
	"applied_at" timestamp (3) with time zone,
	"decided_at" timestamp (3) with time zone,
	"decided_by_user_id" uuid,
	"suspended_at" timestamp (3) with time zone,
	"suspended_reason" text,
	"left_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"status" "affiliate_payout_status" DEFAULT 'requested' NOT NULL,
	"total_amount_cents" bigint NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"payout_method_snapshot_encrypted" text,
	"payout_method_type" text,
	"included_commission_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp (3) with time zone,
	"reviewed_by_user_id" uuid,
	"paid_at" timestamp (3) with time zone,
	"gateway_transaction_id" text,
	"failure_reason" text,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"approval_policy" "affiliate_approval_policy" DEFAULT 'manual' NOT NULL,
	"is_public" jsonb DEFAULT 'false'::jsonb NOT NULL,
	"commission_type" "affiliate_commission_type" NOT NULL,
	"commission_percent" integer,
	"commission_flat_cents" bigint,
	"recurring_cycle_limit" integer,
	"refund_window_days" integer DEFAULT 30 NOT NULL,
	"attribution_window_days" integer DEFAULT 60 NOT NULL,
	"allow_paid_traffic" jsonb DEFAULT 'true'::jsonb NOT NULL,
	"forbidden_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" jsonb DEFAULT 'true'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"public_code" text NOT NULL,
	"payout_method_encrypted" text,
	"payout_method_type" text,
	"lifetime_earned_cents" bigint DEFAULT 0 NOT NULL,
	"lifetime_paid_cents" bigint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_link_id_affiliate_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."affiliate_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_click_id_affiliate_clicks_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."affiliate_clicks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_attributions" ADD CONSTRAINT "affiliate_attributions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_audit_log" ADD CONSTRAINT "affiliate_audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_audit_log" ADD CONSTRAINT "affiliate_audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_link_id_affiliate_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."affiliate_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_clicks" ADD CONSTRAINT "affiliate_clicks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_attribution_id_affiliate_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."affiliate_attributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_fraud_signals" ADD CONSTRAINT "affiliate_fraud_signals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_fraud_signals" ADD CONSTRAINT "affiliate_fraud_signals_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_fraud_signals" ADD CONSTRAINT "affiliate_fraud_signals_click_id_affiliate_clicks_id_fk" FOREIGN KEY ("click_id") REFERENCES "public"."affiliate_clicks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_fraud_signals" ADD CONSTRAINT "affiliate_fraud_signals_attribution_id_affiliate_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."affiliate_attributions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_fraud_signals" ADD CONSTRAINT "affiliate_fraud_signals_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_invitations" ADD CONSTRAINT "affiliate_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_invitations" ADD CONSTRAINT "affiliate_invitations_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_invitations" ADD CONSTRAINT "affiliate_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_memberships" ADD CONSTRAINT "affiliate_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_memberships" ADD CONSTRAINT "affiliate_memberships_program_id_affiliate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."affiliate_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_memberships" ADD CONSTRAINT "affiliate_memberships_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_memberships" ADD CONSTRAINT "affiliate_memberships_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_payouts" ADD CONSTRAINT "affiliate_payouts_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_attributions_workspace_idx" ON "affiliate_attributions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "affiliate_attributions_affiliate_idx" ON "affiliate_attributions" USING btree ("affiliate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_attributions_order_unique" ON "affiliate_attributions" USING btree ("order_id") WHERE "affiliate_attributions"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_attributions_subscription_unique" ON "affiliate_attributions" USING btree ("subscription_id") WHERE "affiliate_attributions"."subscription_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "affiliate_audit_log_workspace_idx" ON "affiliate_audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "affiliate_audit_log_target_idx" ON "affiliate_audit_log" USING btree ("target_table","target_id");--> statement-breakpoint
CREATE INDEX "affiliate_clicks_workspace_idx" ON "affiliate_clicks" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "affiliate_clicks_link_idx" ON "affiliate_clicks" USING btree ("link_id","occurred_at");--> statement-breakpoint
CREATE INDEX "affiliate_clicks_affiliate_idx" ON "affiliate_clicks" USING btree ("affiliate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "affiliate_clicks_ip_hash_idx" ON "affiliate_clicks" USING btree ("ip_hash","occurred_at");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_workspace_idx" ON "affiliate_commissions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_affiliate_status_idx" ON "affiliate_commissions" USING btree ("affiliate_id","status","available_at");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_payout_idx" ON "affiliate_commissions" USING btree ("payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_commissions_attribution_cycle_unique" ON "affiliate_commissions" USING btree ("attribution_id","cycle_number");--> statement-breakpoint
CREATE INDEX "affiliate_fraud_signals_workspace_idx" ON "affiliate_fraud_signals" USING btree ("workspace_id","severity","created_at");--> statement-breakpoint
CREATE INDEX "affiliate_fraud_signals_affiliate_idx" ON "affiliate_fraud_signals" USING btree ("affiliate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_invitations_token_unique" ON "affiliate_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "affiliate_invitations_program_email_idx" ON "affiliate_invitations" USING btree ("program_id","email");--> statement-breakpoint
CREATE INDEX "affiliate_invitations_workspace_idx" ON "affiliate_invitations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_links_slug_unique" ON "affiliate_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "affiliate_links_program_idx" ON "affiliate_links" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "affiliate_links_affiliate_idx" ON "affiliate_links" USING btree ("affiliate_id");--> statement-breakpoint
CREATE INDEX "affiliate_links_workspace_idx" ON "affiliate_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_memberships_program_affiliate_unique" ON "affiliate_memberships" USING btree ("program_id","affiliate_id");--> statement-breakpoint
CREATE INDEX "affiliate_memberships_workspace_idx" ON "affiliate_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "affiliate_memberships_affiliate_idx" ON "affiliate_memberships" USING btree ("affiliate_id");--> statement-breakpoint
CREATE INDEX "affiliate_memberships_status_idx" ON "affiliate_memberships" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "affiliate_payouts_workspace_idx" ON "affiliate_payouts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "affiliate_payouts_affiliate_idx" ON "affiliate_payouts" USING btree ("affiliate_id","requested_at");--> statement-breakpoint
CREATE INDEX "affiliate_programs_workspace_idx" ON "affiliate_programs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "affiliate_programs_product_idx" ON "affiliate_programs" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliate_programs_workspace_default_unique" ON "affiliate_programs" USING btree ("workspace_id") WHERE "affiliate_programs"."product_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "affiliates_user_unique" ON "affiliates" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "affiliates_public_code_unique" ON "affiliates" USING btree ("public_code");--> statement-breakpoint
CREATE INDEX "affiliates_lifetime_earned_idx" ON "affiliates" USING btree ("lifetime_earned_cents");