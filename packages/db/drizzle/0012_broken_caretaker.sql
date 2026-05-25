ALTER TABLE "workspaces" ADD COLUMN "onboarding_completed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "onboarding_minimized_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "onboarding_dismissed_at" timestamp (3) with time zone;