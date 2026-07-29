-- Self-service renaming of the two names other players see.
--
-- Additive ONLY: two nullable timestamps on User. No column is dropped,
-- retyped or backfilled, so this is safe to apply against a live server
-- while it is serving traffic. Both statements are IF NOT EXISTS so a
-- rerun or a partially applied deploy does not fail `prisma migrate deploy`.
--
-- NULL is the correct starting value for every existing row: it means
-- "has never renamed", which is exactly true of the accounts that need
-- this most — an OAuth signup was ASSIGNED its handle and its display
-- name (the latter being the account holder's real name off the Google
-- profile) and has never had a say in either. A never-renamed account is
-- therefore never on cooldown; the window only starts once the player
-- has actually chosen something.
--
-- These have to be durable rather than a process-local rate-limit
-- bucket: an in-memory cooldown resets on every deploy, which would hand
-- anyone cycling identities to impersonate a fresh switch every time we
-- ship. See server/src/lib/nameChange.ts.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "usernameChangedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "nameChangedAt" TIMESTAMP(3);
