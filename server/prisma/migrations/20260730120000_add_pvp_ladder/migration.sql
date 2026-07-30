-- PvP ladder rewards (server/src/lib/pvpLadder.ts, server/src/lib/pvpBadge.ts).
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- Three NEW tables and nothing else. No existing table is touched: no column
-- added, nothing retyped, nothing dropped, no backfill, no data rewritten. So
-- this is safe to apply against the live server while it is serving traffic,
-- and every statement is IF NOT EXISTS so a rerun or a partially-applied deploy
-- is a no-op rather than a failure. Modelled on
-- 20260729120000_add_away_progress.
--
-- Verified read-only against production on 2026-07-30 before this file was
-- written: none of these three tables exists, and "_prisma_migrations" has no
-- row for 20260730120000, so this migration has never been applied anywhere.
--
-- ── WHY THERE IS NO BACKFILL, AND WHY ABSENCE IS THE CORRECT STATE ───
-- There is no correct value for the 55 PvpMatch rows that predate this. None of
-- them carried the `provenance` flag, because it did not exist; 46 of them are
-- the fixed `|tier|`-parse ties with 0 turns; and paying any of them would mint
-- currency for matches nobody played for a reward. The absence of a
-- PvpLadderEarn row means "this account earned nothing", which is both true and
-- the correct starting state for all 2,394 existing accounts — exactly the
-- reasoning that made NULL right for User.awayClaimedAt.
--
-- ── WHY BOTH USER COLUMNS ARE FOREIGN KEYS ───────────────────────────
-- This is the structural gate that makes an AI/bot opponent unable to pay,
-- and it is the single most important line in this file.
--
-- Bot identities are synthetic strings and nothing stops that today —
-- PvpMatch.userBId has NO foreign key, so a synthetic id already persists
-- happily. A synthetic id violates the constraints below: Postgres raises 23503
-- and the ENTIRE payout transaction rolls back — both sides' ledger rows AND
-- both PendingGrant rows. The human's reward is inseparable from the bot's;
-- there is no partial success.
--
-- It is a CONSTRAINT, not an if-statement. It cannot be forgotten by a
-- refactor, and it does not care whether whoever wrote the bot feature had ever
-- heard of rewards. Compare the alternative that was rejected — a
-- `room.format !== "bot"` denylist in application code — which a second bot
-- format or a rename turns into an infinite money printer.
--
-- ON DELETE CASCADE on "opponentUserId" means deleting an account prunes rows
-- where it was the opponent, costing some of the SURVIVING player's audit
-- history. That is a deliberate trade: the foreign key IS the bot gate, and the
-- gate is worth more than perfect audit retention. Account deletion is
-- admin-only and rare.
--
-- ── WHAT PRISMA CANNOT SEE IN THIS FILE ──────────────────────────────
-- The three CHECK constraints below cannot be expressed in schema.prisma.
-- Prisma does not model CHECK constraints at all, so `prisma migrate dev` will
-- neither recreate nor DROP them — they are invisible to its diff, which is
-- what makes them safe to keep here. They are listed verbatim in a
-- RAW-SQL-ONLY block in schema.prisma so a reader of the schema knows they
-- exist, and tests/pvpLadderSchemaDrift.test.ts fails if either file loses them.
--
-- A PARTIAL unique index is NOT safe in the same way: Prisma DOES introspect
-- indexes, cannot express a WHERE clause, and can therefore emit a DROP for one.
-- An earlier version of this migration carried
-- `UNIQUE ("userId","day") WHERE "firstWinOfDay"` as a "fail-closed second
-- opinion" on the daily cash bonus, and claimed the additive-only policy
-- protected it. That was a convention, not a mechanism. It is gone, and the
-- invariant it was guarding is now expressed two ways that Prisma cannot touch:
-- a CHECK ("moneyAwarded" = 0 OR "winBonusPaid"), and a single-row arbiter table
-- whose conditional upsert takes a row lock.

-- ════════════════════════════════════════════════════════════════════
-- PvpLadderEarn — one row per (battle, participant). Append-only audit.
-- ════════════════════════════════════════════════════════════════════
-- Deliberately NOT a second authoritative balance. The spendable Battle Point
-- balance lives in the player's save (`inventory.battlepoint`), delivered by the
-- PendingGrant inbox; this table records what was MINTED and why. Two stores
-- for one spendable currency is the reconciliation bug class the save-CAS work
-- removed.
CREATE TABLE IF NOT EXISTS "PvpLadderEarn" (
    "id"             TEXT         NOT NULL,

    -- The idempotency key, together with "userId". Deliberately NOT a foreign
    -- key to PvpMatch: that insert is fire-and-forget and its .catch swallows
    -- failures (pvp.ts), so an FK here would make the reward depend on a write
    -- that is explicitly allowed to be dropped.
    "matchId"        TEXT         NOT NULL,

    "userId"         TEXT         NOT NULL,
    "opponentUserId" TEXT         NOT NULL,

    -- UTC calendar day. REPORTING ONLY — no gate reads it. It used to key the
    -- daily cap and the daily cash bonus, and that was measured to be
    -- straddleable: two matches at 23:59:30Z and 00:00:30Z paid one account
    -- $50,000 and 16 BP inside 61 seconds. Both windows are now rolling and
    -- measured from "createdAt", which has no boundary to sit on.
    "day"            DATE         NOT NULL,

    -- THE BOT GATE'S APPLICATION HALF: 'queue' | 'invite'. Positively asserted
    -- at room-construction time by the two human pairing paths and by nothing
    -- else, so a bot/tournament/admin room carries no provenance and is refused
    -- with no code of its own. Stored so "which pairing path is actually paying
    -- out?" is a query rather than a guess.
    "provenance"     TEXT         NOT NULL,

    "result"         TEXT         NOT NULL,   -- 'win' | 'loss' | 'tie'
    "endReason"      TEXT         NOT NULL,   -- 'ko' | 'tie' (the payable allowlist)

    -- MEASURED AT PAYOUT, NOT DERIVABLE LATER. PvpMatch.createdAt is stamped at
    -- row-insert time inside endBattle, so finishedAt - createdAt is 0 seconds
    -- for all 55 production rows; the real start time exists only in
    -- room.createdAt, and the turn count only in room.log. Both are gone the
    -- moment the room is dropped, so they are captured here or not at all.
    --
    -- "durationMs" is also the data that RE-TUNES LADDER_MIN_DURATION_MS: the
    -- floor is currently an untested 20s because production has no usable match
    -- timing, and this column is how that stops being a guess.
    "turns"          INTEGER      NOT NULL,
    "durationMs"     INTEGER      NOT NULL,

    -- Both sides of the Elo move. "ratingBefore" is load-bearing, not
    -- decoration: a milestone bonus is paid only on the match that CROSSES a
    -- threshold, so this is the audit of that claim.
    "ratingBefore"   INTEGER      NOT NULL,
    "ratingAfter"    INTEGER      NOT NULL,
    "ratingDelta"    INTEGER      NOT NULL,

    -- What was ACTUALLY paid, given the ledger state at that instant.
    -- Recomputing these later under a changed policy would produce numbers
    -- nobody was ever paid, which makes an audit worthless.
    "meetingIndex"   INTEGER      NOT NULL,
    "bpBeforeDecay"  INTEGER      NOT NULL,
    -- The badge tier that PRICED the cash bonus (lib/pvpBadge.ts). Cash scales
    -- with rating because rating is the one PvP quantity a collusion ring
    -- cannot manufacture — Elo is zero-sum.
    "tier"           TEXT         NOT NULL,

    -- CAPPED BP: the battle plus the once-per-cooldown bonus. The rolling cap
    -- read is SUM("bp") over the window, so this column and only this column is
    -- what the cap sees.
    "bp"             INTEGER      NOT NULL DEFAULT 0,
    -- UNCAPPED, ONCE-EVER milestone BP. A SEPARATE COLUMN ON PURPOSE. When
    -- milestone BP was booked into "bp", a 98-BP rank-up match exhausted the
    -- 25-BP cap for every legitimate battle for the rest of that day: the code
    -- comment promised the exemption and the SQL took it away. Splitting the
    -- column is what makes the exemption true rather than documented.
    "milestoneBp"    INTEGER      NOT NULL DEFAULT 0,

    "moneyAwarded"   INTEGER      NOT NULL DEFAULT 0,
    -- Did this row claim the once-per-cooldown cash+BP bonus? PvpWinBonusClaim
    -- is the arbiter; this is the record.
    "winBonusPaid"   BOOLEAN      NOT NULL DEFAULT false,

    -- Links "earned" to "paid" so ops can follow an earn into
    -- PendingGrant.deliveredAt. Nullable: a row that legitimately earned zero
    -- has no grant, and is still recorded so the meeting count keeps climbing.
    "grantId"        TEXT,

    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PvpLadderEarn_pkey"     PRIMARY KEY ("id"),
    -- A self-play room cannot be recorded at all.
    CONSTRAINT "PvpLadderEarn_not_self" CHECK ("userId" <> "opponentUserId"),
    -- A negative payout is a currency SINK the player never agreed to. The
    -- same shape awayProgress refuses in code; here the database refuses it.
    CONSTRAINT "PvpLadderEarn_nonneg"   CHECK ("bp" >= 0 AND "milestoneBp" >= 0 AND "moneyAwarded" >= 0),
    -- Money is ONLY ever minted by the once-per-cooldown bonus. This is the
    -- fail-closed second opinion that replaced the partial unique index: if a
    -- future edit ever paid cash on some other path, the finalising UPDATE
    -- raises 23514, the transaction rolls back, and NOTHING is paid. Prisma
    -- cannot see, and therefore cannot drop, a CHECK.
    CONSTRAINT "PvpLadderEarn_money_needs_bonus" CHECK ("moneyAwarded" = 0 OR "winBonusPaid"),
    CONSTRAINT "PvpLadderEarn_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    -- THE BOT GATE. See the header block above.
    CONSTRAINT "PvpLadderEarn_opponentUserId_fkey"
        FOREIGN KEY ("opponentUserId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- EXACTLY-ONCE PER SIDE PER BATTLE. endBattle has many callers (the omniscient
-- pump, the AFK watchdog, battle:cancel, the reconnect-grace timers, the
-- shutdown drain, the admin force-end) and a replayed settle must pay nothing.
-- This constraint — not any in-process guard — is what arbitrates: the settle
-- inserts with ON CONFLICT DO NOTHING and rolls the whole transaction back when
-- it affects zero rows, so a second attempt cannot create a second grant.
CREATE UNIQUE INDEX IF NOT EXISTS "PvpLadderEarn_matchId_userId_key"
    ON "PvpLadderEarn" ("matchId", "userId");

-- The rolling-cap read, on every payout. On "createdAt", not "day" — see the
-- column comment for the 61-second $50,000 measurement that changed this.
CREATE INDEX IF NOT EXISTS "PvpLadderEarn_userId_createdAt_idx"
    ON "PvpLadderEarn" ("userId", "createdAt");
-- The per-opponent decay read, on every payout. Also THE collusion query:
--   SELECT "userId","opponentUserId",count(*),sum("bp"),sum("moneyAwarded")
--     FROM "PvpLadderEarn" GROUP BY 1,2 HAVING count(*) > 20 ORDER BY 5 DESC;
CREATE INDEX IF NOT EXISTS "PvpLadderEarn_userId_opponent_createdAt_idx"
    ON "PvpLadderEarn" ("userId", "opponentUserId", "createdAt");
-- Ops: "what did the ladder mint today?", against the measured $736,890,844
-- float.
CREATE INDEX IF NOT EXISTS "PvpLadderEarn_day_idx"
    ON "PvpLadderEarn" ("day");

-- ════════════════════════════════════════════════════════════════════
-- PvpWinBonusClaim — THE ATOMIC GATE for the once-per-cooldown cash bonus.
-- ════════════════════════════════════════════════════════════════════
-- ONE ROW PER ACCOUNT, holding the timestamp of its last claim. The settle
-- claims with:
--
--   INSERT … VALUES (…) ON CONFLICT ("userId") DO UPDATE SET …
--     WHERE "PvpWinBonusClaim"."claimedAt" <= <now - cooldown>
--
-- and reads the affected-row count. Three properties, all of them the reason
-- this shape was chosen:
--
--   1. IT CANNOT BE STRADDLED. The predecessor was PvpDailyFirstWin with
--      PRIMARY KEY ("userId","day"), and a calendar key is satisfiable twice by
--      two different day values: measured, two matches 61 seconds apart across
--      00:00Z paid one account $50,000 — double the advertised daily maximum, in
--      a burst. A cooldown has no boundary to sit on, so the per-account
--      per-HOUR ceiling is exactly one bonus.
--   2. IT IS ATOMIC UNDER CONCURRENCY. ON CONFLICT DO UPDATE takes a row lock
--      on the conflicting row, so two battles finishing in the same instant
--      serialise; the second evaluates the WHERE against the first's committed
--      timestamp and affects zero rows.
--   3. IT IS EXCEPTION-FREE. A lost race is 0 rows, not a 23505 — and in
--      Postgres an error poisons the whole transaction, so an exception here
--      would lose the entire match reward to a race that cost only the bonus.
--
-- The row is OVERWRITTEN on each claim rather than appended to: this table is an
-- arbiter, not a history. The history is PvpLadderEarn."winBonusPaid" +
-- "moneyAwarded", which is append-only.
CREATE TABLE IF NOT EXISTS "PvpWinBonusClaim" (
    "userId"    TEXT         NOT NULL,
    -- The gate. Compared against (now - LADDER_WIN_BONUS_COOLDOWN_MS).
    "claimedAt" TIMESTAMP(3) NOT NULL,
    -- Ops/audit only, all four: which UTC day and battle claimed it, and what
    -- the rating and tier were when it was priced.
    "day"       DATE         NOT NULL,
    "matchId"   TEXT         NOT NULL,
    "rating"    INTEGER      NOT NULL,
    "tier"      TEXT         NOT NULL,
    "money"     INTEGER      NOT NULL,

    CONSTRAINT "PvpWinBonusClaim_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "PvpWinBonusClaim_nonneg" CHECK ("money" >= 0),
    CONSTRAINT "PvpWinBonusClaim_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PvpWinBonusClaim_claimedAt_idx"
    ON "PvpWinBonusClaim" ("claimedAt");

-- ════════════════════════════════════════════════════════════════════
-- PvpBadgeMilestone — one row per (account, rating threshold) ever crossed.
-- ════════════════════════════════════════════════════════════════════
-- NOT derivable from PlayerRating, and the reason matters. peakRating is a
-- high-water mark, not a payment record: an account whose rating oscillates
-- across a threshold would be paid on every crossing.
--
-- The composite primary key is HALF the gate. The other half is in code and it
-- is just as important: a milestone is paid only on the match that actually
-- CROSSES the threshold (ratingBefore < threshold <= ratingAfter, see
-- pvpBadge.milestonesCrossed). Without it, rewards defaulting OFF meant the day
-- PVP_LADDER_REWARDS is switched on, every account already above a threshold
-- would collect its entire back-catalogue on its next win — which is exactly
-- what this table was supposed to prevent, defeated by keying on the live rating
-- instead of on the movement. "ratingBefore" is stored so that claim is
-- auditable after the fact.
--
-- PlayerRating is deliberately left completely untouched by this migration, so
-- there is no schema conflict with the concurrent PvP work.
CREATE TABLE IF NOT EXISTS "PvpBadgeMilestone" (
    "userId"        TEXT         NOT NULL,
    "threshold"     INTEGER      NOT NULL,
    -- The rating this account held BEFORE the crossing match. Proof that the
    -- threshold was crossed rather than merely stood above.
    "ratingBefore"  INTEGER      NOT NULL,
    "ratingAtAward" INTEGER      NOT NULL,
    "bp"            INTEGER      NOT NULL,
    -- Reserved, and NULL for every row the current code writes. A milestone is
    -- paid as part of the SAME grant as the battle that triggered it (one grant
    -- per side per battle, so the player gets one toast rather than three), and
    -- that grant id is already recorded on the PvpLadderEarn row this milestone
    -- was awarded from. Kept because a future standalone milestone payment would
    -- need somewhere to record it, and adding a column later is a migration
    -- while leaving a nullable one is free.
    "grantId"       TEXT,
    "awardedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PvpBadgeMilestone_pkey" PRIMARY KEY ("userId", "threshold"),
    CONSTRAINT "PvpBadgeMilestone_nonneg" CHECK ("bp" >= 0),
    CONSTRAINT "PvpBadgeMilestone_crossed" CHECK ("ratingBefore" < "threshold"),
    CONSTRAINT "PvpBadgeMilestone_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
