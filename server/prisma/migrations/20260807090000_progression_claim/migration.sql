-- Level rewards: how far up the ladder each account has been paid.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- One new table, nothing existing touched, IF NOT EXISTS throughout — safe to
-- apply while the server is running and a no-op on a rerun.
--
-- ── WHY THE MARK ONLY EVER GOES UP ───────────────────────────────────
-- `accountLevel` is DERIVED from the Pokemon a player currently holds (sum of
-- party + box levels / 10), so it drops when they release. Paying against the
-- live level would be a loop: level up, collect, release, re-level, collect
-- the same tiers again. `paidTier` is a high-water mark and the application
-- moves it with a compare-and-swap on `paidTier <`, so a concurrent pair of
-- save uploads cannot both award the same span.
CREATE TABLE IF NOT EXISTS "ProgressionClaim" (
  "userId"      TEXT NOT NULL,
  "paidTier"    INTEGER NOT NULL DEFAULT 0,
  -- Display and ops only. The tier index is the authority; this is what makes
  -- a row legible without re-deriving the ladder by hand.
  "paidAtLevel" INTEGER NOT NULL DEFAULT 0,
  -- True when the first award for this account was a back-pay of tiers it had
  -- already passed before the feature existed. Without it, "earned 53 tiers by
  -- playing" and "was handed 53 tiers on launch day" are indistinguishable in
  -- PendingGrant, and only one of those is a signal about the game.
  "backfilled"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProgressionClaim_pkey" PRIMARY KEY ("userId")
);

DO $$ BEGIN
  ALTER TABLE "ProgressionClaim" ADD CONSTRAINT "ProgressionClaim_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- NOTHING IS SEEDED. Every existing account gets its row on its next save
-- upload, and that first award is the full back-pay of what it had already
-- passed. Seeding marks here instead would mean deciding the back-pay policy
-- in SQL, where it cannot be read alongside the curve that computes it.
