CREATE TYPE "public"."subscription_cycle_status" AS ENUM('paid', 'pending_pix', 'overdue', 'cancelled_by_grace');--> statement-breakpoint
CREATE TYPE "public"."subscription_payment_method" AS ENUM('card', 'pix', 'both');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'subscription_renewal_reminder';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'subscription_renewal_due';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'subscription_renewal_overdue';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'subscription_grace_expired';--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD COLUMN "payment_method" "subscription_payment_method" DEFAULT 'card' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "payment_method" "subscription_payment_method" DEFAULT 'card' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "pix_current_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "grace_period_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "current_cycle_status" "subscription_cycle_status" DEFAULT 'paid' NOT NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_pix_cycle_idx" ON "subscriptions" USING btree ("payment_method","current_cycle_status","next_charge_at");