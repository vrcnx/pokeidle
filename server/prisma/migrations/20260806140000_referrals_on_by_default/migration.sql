-- The referral programme runs unless somebody turns it off.
--
-- ── WHY THIS IS A SECOND MIGRATION ───────────────────────────────────
-- 20260806120000_referrals created this column with DEFAULT false, and that
-- migration has already been applied. Prisma stores a checksum per applied
-- migration, so editing the original in place turns the next deploy into
-- "migration file has been modified" — the fix for a shipped default is
-- always a new migration, never a correction to the old one.
--
-- ── WHY THE DEFAULT CHANGED ──────────────────────────────────────────
-- It shipped disabled, reasoning that a promotion minting tradeable items
-- should not switch itself on at deploy. Sound instinct, wrong call here: the
-- programme was asked for, "off" was a condition nobody requested, and the
-- player-facing card hides itself entirely when the programme is off. The
-- result was a feature that was built, deployed, correct and invisible —
-- which is precisely the failure the Discord link reward suffered and that
-- this codebase already has essays about. A default that must be undone
-- before the feature works is the wrong default.
--
-- The kill switch is unaffected: `enabled = false` still stops payment
-- immediately and keeps recording where accounts came from.
ALTER TABLE "ReferralConfig" ALTER COLUMN "enabled" SET DEFAULT true;

-- Nothing seeds this table, so in practice the row does not exist and the
-- application's own fallback (`row?.enabled ?? true`, lib/referrals.ts) is
-- what every deployment actually reads. This statement covers the other case:
-- an operator who opened the panel while the default was false and saved,
-- storing an `enabled = false` they never chose. It deliberately does NOT
-- touch a row that has been edited since — `updatedBy IS NULL` is the test
-- for "written by a default, not by a person".
UPDATE "ReferralConfig" SET "enabled" = true
WHERE "enabled" = false AND "updatedBy" IS NULL;
