import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { describePrizes } from "./giveaway.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import { recordError } from "./errorReporting.js";
import {
  tiersReachedAt, levelForTier, nextTierLevel, rewardForTier, rewardsBetween,
} from "./progressionTiers.js";

// Paying out the level ladder.
//
// The curve lives in progressionTiers.ts and is pure. This file is the part
// that touches the database, and it has exactly one hard job: pay each tier
// once, ever, for an account whose level can go DOWN.
//
// ── WHY THAT IS THE HARD PART ───────────────────────────────────────
// `accountLevel` is derived from the Pokemon a player currently holds, so
// releasing a boxful lowers it. Anything that pays against the live level is a
// loop the player can run: level up, collect, release, re-level, collect the
// same tiers again. `ProgressionClaim.paidTier` is a high-water mark and only
// ever moves up.

/** Audit label on the grant. */
export const PROGRESSION_SOURCE = "progression";

export interface ProgressionAward {
  /** Tiers crossed by this award. */
  from: number;
  to: number;
  /** The level that unlocked the highest tier paid. */
  level: number;
  /** True when this was an account's first award and it covered tiers passed
   *  before the feature existed. */
  backfilled: boolean;
  summary: string;
}

/**
 * Pay whatever `level` has earned that has not been paid yet.
 *
 * Returns null when there is nothing owed, which is the overwhelmingly common
 * case — this runs on every save upload, and a player crosses a tier every few
 * hours at best.
 *
 * ── THE COMPARE-AND-SWAP IS THE WHOLE SAFETY ARGUMENT ───────────────
 * Two save uploads can land together (two tabs, a retry, a reconnect flush).
 * Read-then-write would let both see `paidTier: 40`, both compute the same
 * span, and both pay it. The update is therefore conditional on
 * `paidTier < tiersNow`, and the grant is only enqueued if that update
 * actually moved a row. The loser pays nothing and returns null, which is
 * correct: somebody already paid it.
 *
 * Runs INSIDE the caller's transaction when given a runner, so a save write
 * that rolls back takes the award with it. A grant that survived a rolled-back
 * save would be owed against a level the player no longer has.
 */
export async function awardProgression(
  userId: string,
  level: number,
  runner: Prisma.TransactionClient = prisma,
): Promise<ProgressionAward | null> {
  const tiersNow = tiersReachedAt(level);
  if (tiersNow <= 0) return null;

  try {
    const existing = await runner.progressionClaim.findUnique({
      where: { userId },
      select: { paidTier: true },
    });
    const paidTier = existing?.paidTier ?? 0;
    if (tiersNow <= paidTier) return null;

    // An account with no row has never been paid, so its first award covers
    // everything it had already passed. For a player who was level 1,200 when
    // this shipped that is 53 tiers in ONE grant — see rewardsBetween, which
    // merges rather than emitting a prize per tier.
    const backfilled = !existing;

    if (existing) {
      // CAS. `updateMany` rather than `update` because it reports a count, and
      // the count is the answer to "did I win the race".
      const moved = await runner.progressionClaim.updateMany({
        where: { userId, paidTier: { lt: tiersNow } },
        data: { paidTier: tiersNow, paidAtLevel: level },
      });
      if (moved.count === 0) return null;
    } else {
      try {
        await runner.progressionClaim.create({
          data: { userId, paidTier: tiersNow, paidAtLevel: level, backfilled: true },
        });
      } catch (e) {
        // Another upload created the row first. It has already paid this span
        // or more; there is nothing left to do and nothing to report.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
        throw e;
      }
    }

    const prizes = rewardsBetween(paidTier, tiersNow);
    if (prizes.length === 0) return null;

    // sourceId is the tier reached, so the (source, sourceId) index is a
    // second receipt independent of the claim row — a belt to the CAS's
    // braces, and the thing an operator can query when asking "was tier 53
    // ever paid to this account".
    await enqueuePrizeGrant(userId, prizes, {
      source: PROGRESSION_SOURCE,
      sourceId: `${userId}:${tiersNow}`,
    }, runner);

    return {
      from: paidTier, to: tiersNow, level: levelForTier(tiersNow),
      backfilled, summary: describePrizes(prizes),
    };
  } catch (e) {
    // Never fatal to a save upload. A player must not lose their progress
    // because a reward failed to compute.
    void recordError({
      kind: "server",
      message: "progression_award_failed",
      source: "awardProgression",
      userId,
      meta: { level, error: String((e as Error)?.message ?? e) },
    });
    return null;
  }
}

export interface ProgressionStatus {
  level: number;
  /** Tiers this account has been PAID for — not tiers its level implies. */
  paidTier: number;
  /** Tiers its level implies, which is higher when an award is pending. */
  reachedTier: number;
  nextLevel: number;
  /** 0..1 across the current gap, for a progress bar. */
  progress: number;
  nextSummary: string;
}

/**
 * Where the player stands, for the Rewards card.
 *
 * Read-only, and deliberately reports BOTH marks. They differ in the window
 * between crossing a tier and the save upload that pays it, and a card that
 * only showed one would either claim an unpaid reward was collected or hide a
 * tier the player has visibly reached.
 */
export async function getProgressionStatus(
  userId: string,
  level: number,
): Promise<ProgressionStatus> {
  const row = await prisma.progressionClaim.findUnique({
    where: { userId },
    select: { paidTier: true },
  });
  const reachedTier = tiersReachedAt(level);
  const nextLevel = nextTierLevel(level);
  const prevLevel = levelForTier(reachedTier);
  const span = Math.max(1, nextLevel - prevLevel);

  return {
    level,
    paidTier: row?.paidTier ?? 0,
    reachedTier,
    nextLevel,
    progress: Math.min(1, Math.max(0, (level - prevLevel) / span)),
    nextSummary: describePrizes(rewardForTier(reachedTier + 1)),
  };
}
