-- Bot liveness, so the admin dashboard can say whether the Discord bot is
-- actually running.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- Two nullable columns on the DiscordConfig singleton. Nothing dropped,
-- retyped or backfilled; IF NOT EXISTS makes a rerun a no-op. Safe against a
-- live server.
--
-- ── WHY LIVENESS IS REPORTED, NOT PROBED ────────────────────────────
-- The game server cannot ask whether the bot is alive. It holds no Discord
-- token, it does not know where the bot is deployed, and there is no inbound
-- address to hit — the bot makes only outbound connections. So the bot checks
-- in on its own reconcile tick and this column is the record.
--
-- Same direction, and the same reason, as BroadcastState.lastStatusAt: the
-- renderer reports to the server because the server has no way to reach into
-- the renderer.
--
-- NULL means "has never checked in", which is true of every deployment until
-- the first tick after this ships. The dashboard renders that as "never seen"
-- rather than as an error, because a bot that has not been deployed yet is not
-- a fault.
--
-- Staleness IS the signal. If the bot dies, this stops moving and the
-- dashboard shows "last seen 2 hours ago" — which is more useful than a
-- boolean, because it distinguishes "restarting" from "gone since Tuesday".

ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "botLastSeenAt" TIMESTAMP(3);
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "botStatus" TEXT;
