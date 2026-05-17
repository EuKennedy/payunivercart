ALTER TABLE "recovery_attempts" ALTER COLUMN "cart_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_attempts_order_idx" ON "recovery_attempts" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "recovery_attempts" ADD CONSTRAINT "recovery_attempts_subject_present" CHECK ("recovery_attempts"."cart_id" IS NOT NULL OR "recovery_attempts"."order_id" IS NOT NULL);