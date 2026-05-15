CREATE TYPE "public"."currency" AS ENUM('BRL', 'USD', 'EUR');--> statement-breakpoint
CREATE TYPE "public"."gateway_id" AS ENUM('mercadopago', 'pagarme', 'pagseguro', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('pt-BR', 'en', 'es');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'pending_payment', 'paid', 'partially_refunded', 'refunded', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('pix', 'credit_card', 'boleto', 'stripe_card_usd');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('one_time', 'subscription', 'course', 'physical');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'past_due', 'cancelled', 'paused', 'trialing');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'processing', 'authorized', 'paid', 'refunded', 'partially_refunded', 'chargedback', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('gateway', 'whatsapp', 'email', 'webhook', 'tracking');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('pending', 'connected', 'failed', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."recovery_channel" AS ENUM('whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."webhook_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."webhook_signature_state" AS ENUM('unknown', 'valid', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('pending', 'processing', 'delivered', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_password_argon2id_format" CHECK (password IS NULL OR password LIKE '$argon2id$%')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"legal_document" text,
	"website_url" text,
	"onboarding_completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'viewer' NOT NULL,
	"invited_by_id" uuid,
	"accepted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"brand_logo_url" text,
	"brand_primary_color" text,
	"locale" "locale" DEFAULT 'pt-BR' NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "gateway_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"gateway_id" "gateway_id" NOT NULL,
	"label" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"credentials_encrypted" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"enc_version" text DEFAULT 'v1' NOT NULL,
	"public_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_validated_at" timestamp (3) with time zone,
	"validation_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_credentials_encrypted_not_empty" CHECK (octet_length(credentials_encrypted) > 0)
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"provider" text NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"connected_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_chat_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"chat_id" text NOT NULL,
	"resolved_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "whatsapp_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"waha_session_id" text NOT NULL,
	"phone_number" text,
	"status" text DEFAULT 'STARTING' NOT NULL,
	"qr_last_issued_at" timestamp (3) with time zone,
	"connected_at" timestamp (3) with time zone,
	"disconnected_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_category_mappings" (
	"workspace_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "product_category_mappings_workspace_not_null" CHECK ("product_category_mappings"."workspace_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "product_coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"discount_type" text NOT NULL,
	"discount_value" bigint NOT NULL,
	"max_redemptions" integer,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"max_installments" integer DEFAULT 12 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "product_type" DEFAULT 'one_time' NOT NULL,
	"cover_image_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"primary_product_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_methods" jsonb DEFAULT '["pix","credit_card","boleto"]'::jsonb NOT NULL,
	"pixels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_domain" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"offer_id" uuid,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"checkout_id" uuid,
	"public_reference" text NOT NULL,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_document" text NOT NULL,
	"customer_phone_raw" text NOT NULL,
	"customer_phone_e_164" text NOT NULL,
	"customer_waha_chat_id" text,
	"shipping_address" jsonb,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"shipping_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paid_at" timestamp (3) with time zone,
	"cancelled_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"gateway_refund_id" text,
	"amount_cents" bigint NOT NULL,
	"reason" text,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"raw_response" jsonb,
	"requested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"gateway_id" "gateway_id" NOT NULL,
	"gateway_charge_id" text,
	"gateway_request_id" text,
	"method" "payment_method" NOT NULL,
	"status" "transaction_status" DEFAULT 'pending' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"captured_cents" bigint DEFAULT 0 NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"installments" integer,
	"idempotency_key" text NOT NULL,
	"pix_qr_code" text,
	"pix_qr_code_image" text,
	"pix_copy_paste" text,
	"boleto_url" text,
	"boleto_barcode" text,
	"card_brand" text,
	"card_last4" text,
	"failure_code" text,
	"failure_message" text,
	"raw_response" jsonb,
	"authorized_at" timestamp (3) with time zone,
	"paid_at" timestamp (3) with time zone,
	"refunded_at" timestamp (3) with time zone,
	"chargedback_at" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"checkout_id" uuid,
	"customer_email" text,
	"customer_phone_raw" text,
	"customer_phone_e_164" text,
	"customer_waha_chat_id" text,
	"customer_name" text,
	"items_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"abandoned_at" timestamp (3) with time zone,
	"recovered_at" timestamp (3) with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"channel" "recovery_channel" NOT NULL,
	"target_identifier" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"scheduled_for" timestamp (3) with time zone NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"opened_at" timestamp (3) with time zone,
	"clicked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger_window_minutes" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks_inbound" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"raw_headers" jsonb NOT NULL,
	"raw_body" text NOT NULL,
	"signature_valid" "webhook_signature_state" DEFAULT 'unknown' NOT NULL,
	"processed_at" timestamp (3) with time zone,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks_inbound_gateway" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbound_id" uuid NOT NULL,
	"gateway_id" "gateway_id" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"status" "webhook_status" DEFAULT 'pending' NOT NULL,
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
CREATE TABLE "events_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"actor_ip" text,
	"actor_user_agent" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"diff" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subscription_id" uuid,
	"gateway_invoice_id" text,
	"amount_cents" bigint NOT NULL,
	"currency" "currency" DEFAULT 'BRL' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"period_start" timestamp (3) with time zone NOT NULL,
	"period_end" timestamp (3) with time zone NOT NULL,
	"paid_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"gateway_subscription_id" text,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"current_period_start" timestamp (3) with time zone NOT NULL,
	"current_period_end" timestamp (3) with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp (3) with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_credentials" ADD CONSTRAINT "gateway_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_chat_ids" ADD CONSTRAINT "whatsapp_chat_ids_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_coupons" ADD CONSTRAINT "product_coupons_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_offers" ADD CONSTRAINT "product_offers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_primary_product_id_products_id_fk" FOREIGN KEY ("primary_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_offer_id_product_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."product_offers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_campaign_id_recovery_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."recovery_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_campaigns" ADD CONSTRAINT "recovery_campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_inbound" ADD CONSTRAINT "webhooks_inbound_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_inbound_gateway" ADD CONSTRAINT "webhooks_inbound_gateway_inbound_id_webhooks_inbound_id_fk" FOREIGN KEY ("inbound_id") REFERENCES "public"."webhooks_inbound"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks_outbox" ADD CONSTRAINT "webhooks_outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_audit" ADD CONSTRAINT "events_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_audit" ADD CONSTRAINT "events_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_subscription_id_platform_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."platform_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_unique" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_unique" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_user_unique" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_owner_idx" ON "organizations" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_user_unique" ON "memberships" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_slug_unique" ON "workspaces" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "workspaces_org_idx" ON "workspaces" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_credentials_default_unique" ON "gateway_credentials" USING btree ("workspace_id","gateway_id") WHERE is_default = true;--> statement-breakpoint
CREATE INDEX "gateway_credentials_workspace_idx" ON "gateway_credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_workspace_kind_provider_unique" ON "integrations" USING btree ("workspace_id","kind","provider");--> statement-breakpoint
CREATE INDEX "integrations_workspace_idx" ON "integrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "integrations_status_idx" ON "integrations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_chat_ids_workspace_e164_unique" ON "whatsapp_chat_ids" USING btree ("workspace_id","e164");--> statement-breakpoint
CREATE INDEX "whatsapp_chat_ids_workspace_idx" ON "whatsapp_chat_ids" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_sessions_waha_id_unique" ON "whatsapp_sessions" USING btree ("waha_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_sessions_workspace_unique" ON "whatsapp_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_workspace_slug_unique" ON "product_categories" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "product_category_mappings_pk" ON "product_category_mappings" USING btree ("product_id","category_id");--> statement-breakpoint
CREATE INDEX "product_category_mappings_workspace_idx" ON "product_category_mappings" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_coupons_workspace_code_unique" ON "product_coupons" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE INDEX "product_coupons_workspace_active_idx" ON "product_coupons" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE INDEX "product_offers_product_idx" ON "product_offers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_offers_workspace_idx" ON "product_offers" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_workspace_slug_unique" ON "products" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "products_workspace_idx" ON "products" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_workspace_slug_unique" ON "checkouts" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_custom_domain_unique" ON "checkouts" USING btree ("custom_domain");--> statement-breakpoint
CREATE INDEX "checkouts_workspace_idx" ON "checkouts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_workspace_reference_unique" ON "orders" USING btree ("workspace_id","public_reference");--> statement-breakpoint
CREATE INDEX "orders_workspace_idx" ON "orders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("workspace_id","customer_email");--> statement-breakpoint
CREATE INDEX "orders_workspace_expires_idx" ON "orders" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "refunds_transaction_idx" ON "refunds" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_idempotency_unique" ON "transactions" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_gateway_charge_unique" ON "transactions" USING btree ("workspace_id","gateway_id","gateway_charge_id") WHERE gateway_charge_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_order_idx" ON "transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "transactions_workspace_status_idx" ON "transactions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "transactions_workspace_expires_idx" ON "transactions" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "carts_workspace_idx" ON "carts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_workspace_email_unique" ON "carts" USING btree ("workspace_id","customer_email","checkout_id") WHERE customer_email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "carts_workspace_abandoned_idx" ON "carts" USING btree ("workspace_id","abandoned_at");--> statement-breakpoint
CREATE INDEX "recovery_attempts_cart_idx" ON "recovery_attempts" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "recovery_attempts_workspace_status_idx" ON "recovery_attempts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "recovery_attempts_scheduled_idx" ON "recovery_attempts" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_campaigns_workspace_name_unique" ON "recovery_campaigns" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "recovery_campaigns_workspace_idx" ON "recovery_campaigns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_active_idx" ON "webhook_endpoints" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_inbound_source_event_unique" ON "webhooks_inbound" USING btree ("source","event_id");--> statement-breakpoint
CREATE INDEX "webhooks_inbound_workspace_idx" ON "webhooks_inbound" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhooks_inbound_processed_idx" ON "webhooks_inbound" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "webhooks_outbox_workspace_idx" ON "webhooks_outbox" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhooks_outbox_status_idx" ON "webhooks_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "events_audit_workspace_idx" ON "events_audit" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "events_audit_resource_idx" ON "events_audit" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "events_audit_action_idx" ON "events_audit" USING btree ("action");--> statement-breakpoint
CREATE INDEX "events_audit_workspace_time_idx" ON "events_audit" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_audit_hash_unique" ON "events_audit" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "platform_invoices_workspace_idx" ON "platform_invoices" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_invoices_gateway_invoice_unique" ON "platform_invoices" USING btree ("gateway_invoice_id");--> statement-breakpoint
CREATE INDEX "platform_invoices_period_idx" ON "platform_invoices" USING btree ("workspace_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_subscriptions_workspace_unique" ON "platform_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "platform_subscriptions_org_idx" ON "platform_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "platform_subscriptions_status_idx" ON "platform_subscriptions" USING btree ("status","current_period_end");