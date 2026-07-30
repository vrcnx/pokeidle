-- PvP ladder rewards, part 2: the baseline that stops anybody being paid for the
-- past (server/src/lib/pvpLadder.ts, server/src/lib/pvpBadge.ts).
--
-- ── THE DEFECT THIS TABLE EXISTS TO PREVENT ──────────────────────────
-- Milestone BP is paid on the match that CROSSES a rating threshold, never for
-- merely standing above one. That rule is what stops the day PVP_LADDER_REWARDS
-- is switched on from paying every already-high account its entire
-- back-catalogue at once, and 20260730120000's own header says so.
--
-- It does not stop the same money arriving one loss later. Every account sitting
-- above a threshold is a single defeat away from RE-crossing it, and
-- PvpBadgeMilestone's once-ever primary key pays that first re-crossing quite
-- happily. So keying on the movement bought a STAGGERED dump, not no dump: over
-- the days following the switch, every account above 1100 would collect its whole
-- stack anyway, for battles fought before rewards existed.
--
-- ── WHY peakRating IS THE HONEST BASELINE ────────────────────────────
-- It is not a number invented for this feature. PlayerRating."peakRating" has
-- been maintained by pvp.ts's applyEloUpdate since long before rewards existed,
-- so the database already records exactly how high every account climbed for
-- free. A threshold at or below that mark is not an achievement this feature
-- witnessed. Everything above it is.
--
-- Measured read-only against production on 2026-07-30, which is why this is
-- being applied NOW rather than after a ladder has formed: FOUR PlayerRating rows
-- exist, ratings 984–1016, max peakRating 1016, and ZERO accounts are at or above
-- the first payable threshold of 1100. So this backfill freezes 4 rows and
-- forgives 0 BP — it costs nobody anything today, and it is unimplementable at
-- this precision once accounts have started climbing under a live faucet.
--
-- Same probe: 20260730120000_add_pvp_ladder is already applied (06:14Z) and its
-- three tables exist, while "PvpLadderBaseline" does not. PVP_LADDER_REWARDS must
-- therefore not be set to 1 until THIS file has been applied — the settle reads
-- the baseline inside its transaction, so a missing table raises 42P01, pays
-- nothing and logs pvp_ladder_settle_failed on every rated battle. Fail-closed,
-- loud, and entirely avoidable by migrating first.
--
-- ── ADDITIVE, AND THE ONE INSERT IS EXPLAINED ────────────────────────
-- One NEW table. No existing table is altered, retyped, dropped or rewritten;
-- "PlayerRating" is READ and never written. Every CREATE is IF NOT EXISTS and the
-- INSERT is ON CONFLICT DO NOTHING, so a rerun, a partially-applied deploy or a
-- concurrent server writing its own lazy baseline are all no-ops rather than
-- failures.
--
-- The sibling migration 20260730120000 states it contains no INSERT, and
-- tests/pvpLadderSchemaDrift.test.ts holds it to that. This one does contain an
-- INSERT, and the distinction is the point: it writes ONLY into the empty table
-- it just created, from data the server already owns. It rewrites no player state
-- and it cannot lose any — the failure mode of NOT running it is paying real
-- currency for progress made before the feature shipped.
--
-- ── NO CHECK CONSTRAINT, DELIBERATELY ────────────────────────────────
-- "rating" is written as GREATEST() of three server-owned, already-non-negative
-- integers (peakRating, rating, and the post-match rating, all of which
-- applyEloUpdate floors at 0). There is no predicate a CHECK could add that the
-- writer does not already guarantee, so the RAW-SQL-ONLY inventory in
-- schema.prisma stays exactly as long as it was.

-- ════════════════════════════════════════════════════════════════════
-- PvpLadderBaseline — one row per account, written ONCE, never revised.
-- ════════════════════════════════════════════════════════════════════
-- NEVER UPDATE A ROW IN THIS TABLE. A baseline that follows the player upward
-- would make every subsequent milestone unpayable — the opposite failure, and a
-- silent one.
CREATE TABLE IF NOT EXISTS "PvpLadderBaseline" (
    "userId"    TEXT         NOT NULL,

    -- The high-water rating this account had reached before the ladder paid it
    -- anything. lib/pvpLadder.ts refuses every milestone threshold <= this.
    "rating"    INTEGER      NOT NULL,

    -- 'migration' = frozen by this backfill, i.e. EXACT: the value predates any
    -- payout. 'settle'  = seeded lazily by the first payout for an account the
    -- backfill never saw, which is read AFTER applyEloUpdate has already moved
    -- the peak and is therefore CONSERVATIVE by up to one match. Recorded so the
    -- difference is queryable rather than folklore.
    "source"    TEXT         NOT NULL DEFAULT 'settle',

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PvpLadderBaseline_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "PvpLadderBaseline_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- THE FREEZE. Every account that has ever played a rated match, at the mark it
-- had already reached. GREATEST because a live rating above the recorded peak
-- would mean peakRating had drifted, and the baseline must never be the smaller
-- of the two.
--
-- Accounts with no PlayerRating row are deliberately left out: they have never
-- played a rated match, so they cannot have reached any threshold, and the
-- absence of a row reads as baseline 0 — exact rather than lenient.
INSERT INTO "PvpLadderBaseline" ("userId", "rating", "source", "createdAt")
SELECT pr."userId", GREATEST(pr."peakRating", pr."rating"), 'migration', CURRENT_TIMESTAMP
  FROM "PlayerRating" pr
  JOIN "User" u ON u."id" = pr."userId"
ON CONFLICT ("userId") DO NOTHING;
