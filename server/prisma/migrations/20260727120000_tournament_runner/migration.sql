-- Tournament round runner support.
--
-- Additive ONLY: six nullable/defaulted columns on Tournament and one on
-- TournamentEntry. No column is dropped, retyped or backfilled, so this is
-- safe to apply against a live server while it is serving traffic. Every
-- statement is IF NOT EXISTS so a rerun or a partially applied deploy does
-- not fail `prisma migrate deploy`.
--
-- Why each column exists:
--   roundWindowMinutes  how long a ROUND stays open. The knob that makes a
--                       bracket asynchronous instead of requiring N players
--                       in the same 20 minutes.
--   autoRun             lets lib/tournamentRunner.ts drive the event
--                       (auto-start, auto-advance, no-show walkovers).
--   championId /        denormalised winner, so a rename or a deleted
--   championUsername    account still renders in history.
--   prizes /            optional champion prize, paid through the durable
--   prizeGrantedAt      PendingGrant inbox exactly once.
--   ratingAtSeed        the ELO the seed was computed from, kept for
--                       after-the-fact explanation of the draw.

ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "roundWindowMinutes" INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "autoRun" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "championId" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "championUsername" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "prizes" TEXT;
ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "prizeGrantedAt" TIMESTAMP(3);

ALTER TABLE "TournamentEntry" ADD COLUMN IF NOT EXISTS "ratingAtSeed" INTEGER;
