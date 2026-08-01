-- Discord announcement fields on Giveaway, so a giveaway created in the admin
-- dashboard can be posted to the community server by the bot (bot/).
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- Four nullable/defaulted columns on one existing table. Nothing is dropped,
-- retyped or backfilled, so this is safe to apply against the live server
-- while it is serving traffic, and every statement is IF NOT EXISTS so a rerun
-- or a partially-applied deploy is a no-op rather than a failure. Same shape
-- as 20260729120000_add_away_progress.
--
-- ── WHY THE DEFAULTS ARE THE CORRECT STATE FOR EVERY EXISTING ROW ────
-- `announceToDiscord = false` means "this giveaway is not a Discord giveaway",
-- which is true of every giveaway that has ever existed here — the bot did not
-- exist when they were drawn. No backfill is possible or wanted: announcing a
-- giveaway that was drawn months ago would post a result for a prize the
-- winner already spent.
--
-- The three NULLs mean "not yet posted", which is likewise true of all of them
-- and, combined with `announceToDiscord = false`, keeps them out of the bot's
-- poll entirely.
--
-- ── WHY discordMessageId IS THE IDEMPOTENCY MARKER ───────────────────
-- The bot polls on a timer. Without a durable "already posted" marker, every
-- tick would post the same giveaway again — the same failure mode
-- PendingGrant.deliveredAt exists to prevent for prizes, and solved the same
-- way: the poll filters on `discordMessageId IS NULL`, and the bot writes the
-- id back the moment the message exists. A crash between posting and writing
-- costs one duplicate post, which is recoverable by a human deleting a
-- message; the alternative ordering (mark, then post) costs a giveaway that is
-- never announced at all, which nobody notices until entries are zero.
--
-- discordResultsAt is the same marker for the RESULT post, kept separate
-- because they are two posts at two different times: a giveaway drawn from the
-- dashboard has an announcement long before it has a result.
--
-- ── WHY NO INDEX ─────────────────────────────────────────────────────
-- The bot's poll filters on announceToDiscord + status + these NULLs. Giveaway
-- is a handful of rows — it is an operator-created table, not a player-created
-- one — so a sequential scan every 30 seconds is cheaper than the index would
-- be to maintain. The existing @@index([status, createdAt]) already narrows it.

ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "announceToDiscord" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "discordChannelId" TEXT;
ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "discordMessageId" TEXT;
ALTER TABLE "Giveaway" ADD COLUMN IF NOT EXISTS "discordResultsAt" TIMESTAMP(3);
