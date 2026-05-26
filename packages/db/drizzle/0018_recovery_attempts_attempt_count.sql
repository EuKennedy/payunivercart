-- Add transient-retry counter to recovery_attempts so the worker can
-- re-queue a row on a WAHA blip instead of marking it permanently
-- failed. Idempotent (`IF NOT EXISTS`) so a partial re-run doesn't
-- abort the migration on a column that already landed.
ALTER TABLE "recovery_attempts" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;
