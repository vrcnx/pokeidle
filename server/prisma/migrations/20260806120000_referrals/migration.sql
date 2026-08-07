-- The referral programme: share a link, get a Master Ball per signup, with
-- $1,000,000 and a shiny at the tenth.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- Three new tables. Nothing existing is touched, so this is safe to apply
-- while the server is running, and IF NOT EXISTS makes a rerun or a partially
-- applied deploy a no-op.
--
-- ── WHY A CODE RATHER THAN THE USERNAME ──────────────────────────────
-- `?ref=<username>` needs no table and reads better, and it is wrong here:
-- usernames are mutable (lib/nameChange.ts). A rename silently breaks every
-- link already shared, and the freed username can then be claimed by someone
-- else who would inherit the first player's referrals. A code is issued once
-- and never changes hands.
CREATE TABLE IF NOT EXISTS "ReferralCode" (
  "userId"    TEXT NOT NULL,
  "code"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("userId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReferralCode_code_key" ON "ReferralCode"("code");

-- ── WHY referredUserId IS THE PRIMARY KEY ────────────────────────────
-- An account has exactly one referrer, decided at signup, forever. As the
-- primary key that stops being a rule the application has to remember and
-- becomes one the database will not let it break: a second attribution for
-- the same account fails loudly instead of quietly paying a second referrer
-- for the same person.
CREATE TABLE IF NOT EXISTS "Referral" (
  "referredUserId" TEXT NOT NULL,
  "referrerUserId" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 1-based position in the referrer's list. The unique index below is what
  -- makes the cap race-safe: COUNT(*)+1 read before an insert is a
  -- time-of-check/time-of-use bug, where two signups landing together both
  -- read 9, both claim slot 10, and the milestone is paid twice. Here the
  -- second insert loses and retries.
  "ordinal"        INTEGER NOT NULL,
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("referredUserId")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Referral_referrerUserId_ordinal_key"
  ON "Referral"("referrerUserId", "ordinal");
CREATE INDEX IF NOT EXISTS "Referral_referrerUserId_idx" ON "Referral"("referrerUserId");
CREATE INDEX IF NOT EXISTS "Referral_createdAt_idx" ON "Referral"("createdAt");

-- Programme content, in the database rather than the environment for the same
-- reason the Discord link reward is: an operator changes it as a judgement
-- call, and env would put it behind a redeploy, somewhere the dashboard
-- cannot show it. Starts DISABLED — a promotion that turns itself on at
-- deploy is one nobody decided to run.
CREATE TABLE IF NOT EXISTS "ReferralConfig" (
  "id"             TEXT NOT NULL DEFAULT 'singleton',
  "enabled"        BOOLEAN NOT NULL DEFAULT false,
  "perReferral"    TEXT,
  "milestone"      TEXT,
  -- Every entry a `pokemon` prize. A POOL because the server cannot build a
  -- Pokémon: it has no species table and no stat formula, so a mon it
  -- invented would have invented stats. The admin builds real ones with the
  -- real formula in the existing PrizeBuilder; the server only picks an index.
  "shinyPool"      TEXT,
  "perReferralCap" INTEGER NOT NULL DEFAULT 10,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"      TEXT,
  CONSTRAINT "ReferralConfig_pkey" PRIMARY KEY ("id")
);

-- Foreign keys last, so a failure here leaves no half-built table behind.
-- ON DELETE CASCADE throughout: deleting an account should not strand rows
-- pointing at it, and a referral to a deleted account is not a referral.
DO $$ BEGIN
  ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerUserId_fkey"
    FOREIGN KEY ("referrerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredUserId_fkey"
    FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
