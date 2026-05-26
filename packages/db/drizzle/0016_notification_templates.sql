CREATE TYPE "public"."notification_channel" AS ENUM('email', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."notification_event" AS ENUM('order_paid_buyer', 'order_paid_producer', 'subscription_activated_buyer', 'subscription_activated_producer', 'entitlement_granted', 'cart_recovery');--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_key" "notification_event" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_workspace_event_channel_unique" ON "notification_templates" USING btree ("workspace_id","event_key","channel");--> statement-breakpoint
CREATE INDEX "notification_templates_workspace_idx" ON "notification_templates" USING btree ("workspace_id");