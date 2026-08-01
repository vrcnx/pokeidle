-- Operator-editable Discord settings (server/src/lib/discordConfig.ts).
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- One NEW table. No existing table is touched, nothing is dropped, retyped or
-- backfilled, and the statement is IF NOT EXISTS so a rerun or a partially
-- applied deploy is a no-op. Safe to apply while serving traffic.
--
-- ── WHY A SINGLETON TABLE AND NOT A KEY-VALUE STORE ─────────────────
-- Same shape as BroadcastState: one row, id defaulted to 'singleton', columns
-- with real types. A generic settings(key, value) table would make every read
-- a string parse with no schema, and Prisma could not type any of it — which
-- matters most for the one column here that holds structured data.
--
-- ── WHY NO ROW IS SEEDED ────────────────────────────────────────────
-- Absent is a meaningful and correct state: no reward configured, promotion
-- off. lib/discordConfig.ts treats a missing row exactly as it treats a row
-- with linkRewardEnabled = false, so there is nothing to insert here and no
-- ordering dependency between this migration and the first save. The admin
-- endpoint upserts on write.
--
-- ── WHAT MOVED HERE FROM ENV, AND WHY ───────────────────────────────
-- DISCORD_LINK_REWARD was an environment variable for exactly one commit.
-- Env is right for deployment config (tokens, URLs, origins) and wrong for
-- anything an operator changes as a judgement call: it put "which prize does
-- linking give?" behind a Railway edit and a redeploy, and it put the value
-- somewhere the admin dashboard could not display. The eligibility gate
-- (DISCORD_LINK_REWARD_MIN_LEVEL) stays in env, because it is a policy lever
-- rather than content and should be harder to change on a whim.

CREATE TABLE IF NOT EXISTS "DiscordConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "linkReward" TEXT,
    "linkRewardEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "DiscordConfig_pkey" PRIMARY KEY ("id")
);
