ALTER TABLE "orders" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cycle_number" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_subscription_idx" ON "orders" USING btree ("subscription_id","cycle_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_subscription_cycle_unique" ON "orders" USING btree ("subscription_id","cycle_number") WHERE "orders"."subscription_id" IS NOT NULL;