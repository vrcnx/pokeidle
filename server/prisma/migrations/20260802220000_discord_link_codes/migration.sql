-- Pending /link codes move from an in-memory Map into the database.
--
-- ── WHY, WITH THE RECEIPT ────────────────────────────────────────────
-- lib/discordLink.ts kept outstanding codes in a Map, and argued the case: a
-- lost code costs one re-run of /link, so persisting them would buy a table of
-- ten-minute garbage, a sweeper and a migration for nothing. It reserved the
-- move for the day the server ran multiple replicas.
--
-- Right about the cost, wrong about the trigger. It is not replicas — it is
-- that ANY restart empties the Map, and a deploy is a restart. On 2026-08-02 a
-- code was minted at 2:29pm, a deploy landed at 2:29pm, and the player was told
-- "that code is wrong or has expired" about a code that was neither. During
-- active development, with pushes minutes apart, a ten-minute code is more
-- likely to be destroyed than redeemed.
--
-- The failure shape is the reason this is worth a table. It is silent, it
-- blames the player's typing, and it leaves no trace in the logs, because
-- nothing threw — the code genuinely was not there any more.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- One new table. Nothing existing is touched, so this is safe to apply while
-- the server is running, and IF NOT EXISTS makes a rerun or a partially
-- applied deploy a no-op.
--
-- ── WHY code IS THE PRIMARY KEY ──────────────────────────────────────
-- Redeem looks a code up by value, so making it the key turns that into an
-- indexed lookup and makes uniqueness a database guarantee rather than a
-- re-roll loop that hoped. Two mints colliding is now an insert that fails and
-- is retried, not a silent overwrite of somebody else's pending link.
--
-- ── WHY discordId IS UNIQUE ──────────────────────────────────────────
-- One live code per Discord account. Running /link five times leaves ONE
-- redeemable code, not five, so a code someone has forgotten about cannot
-- still bind their account ten minutes later. The Map enforced this with a
-- second lookaside map; the constraint does it properly.
--
-- ── NO SWEEPER JOB ───────────────────────────────────────────────────
-- Expired rows are deleted opportunistically on the next mint, and every read
-- filters on expiresAt anyway, so a row that outlives its TTL is inert rather
-- than dangerous. The index on expiresAt is what makes that sweep cheap.

CREATE TABLE IF NOT EXISTS "DiscordLinkCode" (
  "code"         TEXT NOT NULL,
  "discordId"    TEXT NOT NULL,
  "discordLabel" TEXT NOT NULL,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscordLinkCode_pkey" PRIMARY KEY ("code")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DiscordLinkCode_discordId_key"
  ON "DiscordLinkCode" ("discordId");

CREATE INDEX IF NOT EXISTS "DiscordLinkCode_expiresAt_idx"
  ON "DiscordLinkCode" ("expiresAt");
