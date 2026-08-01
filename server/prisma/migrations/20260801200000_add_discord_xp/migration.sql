-- Community XP: levels earned by talking and taking part in the Discord.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- One new table and six nullable/defaulted columns on the DiscordConfig
-- singleton. Nothing dropped, retyped or backfilled; every statement is
-- IF NOT EXISTS so a rerun or a partially applied deploy is a no-op.
--
-- ── WHY THE TABLE KEYS ON discordId, NOT userId ─────────────────────
-- XP is earned by DISCORD accounts, linked or not. Someone who has never
-- played the game can join the server, talk, and level up — which is the whole
-- point, because the community has to be worth being in before you have linked
-- anything. Keying on userId would mean the exact people you are trying to
-- convert earn nothing until after they convert.
--
-- Consequently there is no foreign key to User and no cascade. A Discord
-- account that leaves keeps its row and its level if it returns. The row is
-- tiny and the population is Discord-sized, not player-base-sized.
--
-- ── WHY LEVEL IS NOT A COLUMN ───────────────────────────────────────
-- Level is a pure function of xp (see lib/discordXp.ts). Storing it would
-- create a second source of truth that silently disagrees with the first the
-- moment the curve is ever tuned, and every row would need a migration to
-- re-derive. One number, computed on read.
--
-- ── WHY XP DOES NOT TOUCH THE GAME ECONOMY ──────────────────────────
-- This is a separate currency by design. XP buys Discord standing and nothing
-- else: no money, no items, no account level, nothing PendingGrant can see.
--
-- The alternative — chat XP paying out in-game currency — puts a faucet on the
-- economy whose tap is "type in a text box". No cooldown makes that safe
-- against somebody who wants it badly enough, and the blast radius of getting
-- it wrong is inflation across 2,442 accounts. Keeping the currencies separate
-- means the worst case for an XP exploit is a wrong number on a leaderboard.
--
-- ── WHY THE COOLDOWN TIMESTAMP LIVES HERE ───────────────────────────
-- `lastAwardAt` is the anti-spam gate and it is SERVER-side on purpose. Held
-- in the bot's memory it would reset on every redeploy, handing anyone who
-- noticed a free burst of XP per deploy. In a column it survives restarts and
-- cannot be influenced by anything the bot sends.

CREATE TABLE IF NOT EXISTS "DiscordXp" (
    "discordId" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "lastAwardAt" TIMESTAMP(3),
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordXp_pkey" PRIMARY KEY ("discordId")
);

-- The leaderboard query, and the only ordering this table is ever read in.
CREATE INDEX IF NOT EXISTS "DiscordXp_xp_idx" ON "DiscordXp"("xp");

-- Settings. All nullable/defaulted, so this changes no behaviour until an
-- operator turns XP on from the dashboard.
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "xpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "xpPerMessageMin" INTEGER;
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "xpPerMessageMax" INTEGER;
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "xpCooldownSec" INTEGER;
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "xpIgnoredChannels" TEXT;
ALTER TABLE "DiscordConfig" ADD COLUMN IF NOT EXISTS "xpAnnounceChannelId" TEXT;
