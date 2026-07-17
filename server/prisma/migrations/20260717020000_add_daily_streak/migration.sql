-- AlterTable
-- Additive columns for daily rewards / login streak. All have defaults (or
-- are nullable), so existing rows are valid without a backfill. IF NOT
-- EXISTS keeps a rerun idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "dailyStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "longestDailyStreak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastDailyClaimAt" TIMESTAMP(3);
