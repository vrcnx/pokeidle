-- Discord account linking for the community bot (server/src/lib/discordLink.ts,
-- server/src/routes/bot.ts, server/src/routes/discord.ts).
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- One NEW table and nothing else. No existing table is touched: no column
-- added, nothing retyped, nothing dropped, no backfill, no data rewritten. So
-- this is safe to apply against the live server while it is serving traffic,
-- and every statement is IF NOT EXISTS so a rerun or a partially-applied
-- deploy is a no-op rather than a failure. Modelled on
-- 20260730120000_add_pvp_ladder and 20260729120000_add_away_progress.
--
-- Hand-written rather than generated, for the same reason those two were:
-- DATABASE_URL points at the production Railway database, and `prisma migrate
-- dev` wants a shadow database it is allowed to drop and recreate. There is no
-- local Postgres to give it. `migrate deploy` applies this file verbatim.
--
-- ── WHY BOTH SIDES ARE UNIQUE ───────────────────────────────────────
-- "discordId" is the PRIMARY KEY and "userId" carries a UNIQUE constraint, so
-- the binding is one-to-one in BOTH directions and the database is what
-- enforces it. This is deliberately not an application-level check, because
-- both failure modes it prevents are races that a check-then-insert loses:
--
--   * One Discord account claiming several game accounts turns every
--     per-account limit the bot enforces — a giveaway entry, a trade listing,
--     a role — into a per-account-times-N limit. A giveaway is the obvious
--     one: N linked alts is N tickets in a draw that is supposed to be one
--     ticket per person.
--   * One game account claimed by several Discord accounts means a prize
--     drawn for "that player" has no single Discord recipient to announce or
--     DM, and role sync has no single guild member to reconcile against.
--
-- Two concurrent redeems of two different codes for the same account
-- therefore end with exactly one row and one 409, decided by Postgres,
-- regardless of how the route is written.
--
-- ── WHY ON DELETE CASCADE ───────────────────────────────────────────
-- Deleting a game account removes its Discord binding. There is nothing to
-- preserve: the row is a lookup key, not a record of anything that happened,
-- and an orphaned binding pointing at a deleted account is strictly worse
-- than no binding — the bot would resolve a Discord user to an id that no
-- longer exists and report it as "linked but broken" forever. The role
-- reconciler treats a missing row as "not linked" and strips the Trainer
-- role on its next pass, which is the correct outcome.
--
-- No FK on the Discord side is possible or wanted: Discord accounts are not
-- rows in this database. A binding whose Discord account was deleted is
-- detected by the bot (the member resolve fails) and cleaned up by /unlink.
--
-- ── WHY NO INDEX BEYOND THE TWO CONSTRAINTS ─────────────────────────
-- Every query this table serves is a point lookup on one of the two unique
-- columns — "who is this Discord user" (PK) or "is this account linked"
-- (UNIQUE) — and both constraints are backed by an index already. The role
-- reconciler's full scan is bounded by the number of LINKED accounts, which
-- is a Discord-server-sized number, not a player-base-sized one.

CREATE TABLE IF NOT EXISTS "DiscordLink" (
    "discordId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordLink_pkey" PRIMARY KEY ("discordId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DiscordLink_userId_key" ON "DiscordLink"("userId");

-- Guarded so a rerun against a database that already has the constraint is a
-- no-op. Postgres has no ADD CONSTRAINT IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'DiscordLink_userId_fkey'
    ) THEN
        ALTER TABLE "DiscordLink"
            ADD CONSTRAINT "DiscordLink_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
