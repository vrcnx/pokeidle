-- Away-time catch-up progress (server/src/lib/awayProgress.ts).
--
-- Additive ONLY: one nullable timestamp on User. Nothing is dropped, retyped
-- or backfilled, so this is safe to apply against a live server while it is
-- serving traffic, and IF NOT EXISTS makes a rerun or a partially applied
-- deploy a no-op rather than a failure.
--
-- NULL is the correct starting value for every existing row: it means "has
-- never claimed away progress", which is true of all 2,317 of them. The claim
-- route measures away time from max(saveUpdatedAt, awayClaimedAt), so a NULL
-- here simply falls back to the account's last accepted save upload — which is
-- the honest anchor for "when did this account last prove it was playing".
--
-- This column is the ATOMIC GATE for the feature. The claim is a conditional
-- UPDATE against the value the request observed, so two concurrent claims
-- cannot both be paid. It is deliberately NOT part of any save write: the
-- reward is delivered through the existing PendingGrant inbox, which already
-- owns exactly-once payment and the saveAdoptSeq discipline that protects it.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "awayClaimedAt" TIMESTAMP(3);
