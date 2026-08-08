// Paying out the Discord rank ladder.
//
// The curve lives in discordRankTiers.ts and is pure. This file is the part
// that touches the database, and it is the file lib/discordXp.ts's header
// warns about — the one that makes community XP observable to the game
// economy. Read the "why every prize here is an item" section of
// discordRankTiers.ts before changing anything in here; it is the argument
// that made this allowed at all.
//
// ── WHY THIS IS HARDER THAN THE ACCOUNT-LEVEL LADDER ────────────────
// ProgressionClaim only has to survive an account level that can go DOWN. This
// has to survive something worse: the identity the reward is earned against
// can be DETACHED and reattached at will. /unlink is a button, and every
// version of the exploit starts by pressing it.
//
// So the high-water mark is not keyed on the game account. It is keyed on the
// Discord account, with the game account carrying a unique constraint beside
// it — see the model comment in schema.prisma. Between them, both directions
// of unlink-and-relink hit a database constraint rather than a payout.

import { prisma } from "../db.js";
import { describePrizes, type Prize } from "./giveaway.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import { recordError } from "./errorReporting.js";
import { levelFromXp } from "./discordXp.js";
import { DISCORD_INVITE_URL } from "./discordInvite.js";
import {
  tiersReachedAtRank, rankForTier, nextTierRank, rewardForTier, rewardsBetween,
  MASTERBALL_EVERY,
} from "./discordRankTiers.js";

/** Audit label on the grant. */
export const DISCORD_RANK_SOURCE = "discord-rank";

export interface DiscordRankAward {
  from: number;
  to: number;
  /** The rank that unlocked the highest tier paid. */
  rank: number;
  summary: string;
}

/**
 * Pay whatever `rank` has earned for this pair of accounts that has not been
 * paid yet.
 *
 * Returns null when there is nothing owed, which is almost always — this runs
 * on Discord level-ups, and the ladder only pays every fifth rank early on and
 * every tenth after that.
 *
 * Never throws. Callers are a chat-message handler and a page load; neither
 * should be able to fail because a promotion did.
 */
export async function awardDiscordRank(
  userId: string,
  discordId: string,
  rank: number,
): Promise<DiscordRankAward | null> {
  const tiersNow = tiersReachedAtRank(rank);
  if (tiersNow <= 0) return null;

  try {
    const existing = await prisma.discordRankClaim.findUnique({
      where: { discordId },
      select: { userId: true, paidTier: true },
    });

    // Captured BEFORE the compare-and-swap. Reading it afterwards works only
    // because Prisma hands back a detached object; anything that ever aliased
    // the row would turn this into "what am I being paid to", and the span
    // would compute as empty — a silent no-payout on a successful claim.
    const paidBefore = existing?.paidTier ?? 0;

    if (existing) {
      // This Discord account is bound to a DIFFERENT game account. Somebody
      // has unlinked and rebound it; the ranks were already paid out once and
      // are not paid again. Silent, because the honest case for this is rare
      // and the dishonest one does not deserve a diagnostic.
      if (existing.userId !== userId) return null;
      if (tiersNow <= existing.paidTier) return null;

      // CAS. `updateMany` rather than `update` because it reports a count, and
      // the count is the answer to "did I win the race" when two level-ups
      // land together.
      const moved = await prisma.discordRankClaim.updateMany({
        where: { discordId, paidTier: { lt: tiersNow } },
        data: { paidTier: tiersNow, paidAtRank: rank },
      });
      if (moved.count === 0) return null;
    } else {
      try {
        await prisma.discordRankClaim.create({
          data: { discordId, userId, paidTier: tiersNow, paidAtRank: rank },
        });
      } catch (e) {
        // P2002 on either key, and both mean the same thing: pay nothing.
        //
        //   discordId — another award for this Discord account created the row
        //   first. It covered this span or more.
        //
        //   userId — this GAME account has already been paid by a different
        //   Discord account. This is the unlink-relink-with-a-second-account
        //   path, and refusing it here is the constraint doing its job.
        //
        // Deliberately not distinguished: neither is an error, and the caller
        // has nothing different to do about them.
        if (isUniqueViolation(e)) return null;
        throw e;
      }
    }

    const prizes = rewardsBetween(paidBefore, tiersNow);
    if (prizes.length === 0) return null;

    // sourceId carries BOTH ids because either one alone is ambiguous in the
    // ledger: the Discord account is what earned it and the game account is
    // what received it, and an operator asking "was this paid" is usually
    // holding only one of them.
    await enqueuePrizeGrant(userId, prizes, {
      source: DISCORD_RANK_SOURCE,
      sourceId: `${discordId}:${tiersNow}`,
    });

    return {
      from: paidBefore,
      to: tiersNow,
      rank: rankForTier(tiersNow),
      summary: describePrizes(prizes),
    };
  } catch (e) {
    void recordError({
      kind: "server",
      message: "discord_rank_award_failed",
      source: "awardDiscordRank",
      userId,
      meta: { discordId, rank, error: String((e as Error)?.message ?? e) },
    });
    return null;
  }
}

/** Prisma's unique-constraint code, without importing the error class into
 *  every call site. */
function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";
}

/**
 * Pay a linked account whatever its CURRENT Discord rank has earned.
 *
 * The self-heal. The timely path is the level-up hook in routes/bot.ts, but it
 * only fires for someone who is linked AT THE MOMENT they level up — which
 * misses everyone who chatted their way to rank 20 and linked afterwards, and
 * that is the common order of events, not an edge case.
 *
 * Safe to call on a read because every guard above is idempotent: a caller
 * with nothing owed does one indexed lookup and returns null.
 */
export async function settleDiscordRank(userId: string, discordId: string): Promise<void> {
  const row = await prisma.discordXp.findUnique({
    where: { discordId },
    select: { xp: true },
  });
  if (!row) return;
  await awardDiscordRank(userId, discordId, levelFromXp(row.xp).level);
}

// ── The status a player sees ────────────────────────────────────────

/** One stop on the track. Deliberately the same shape as ProgressionStop, so
 *  the client can draw both ladders with one component. */
export interface DiscordRankStop {
  tier: number;
  /** The Discord rank this stop sits at. Named `level` to match
   *  ProgressionStop — the client's track renderer reads this field. */
  level: number;
  prizes: Prize[];
  state: "paid" | "queued" | "next" | "future";
  milestone: boolean;
}

export interface DiscordRankStatus {
  /** False when the account has no DiscordLink. The card renders an invite
   *  rather than a ladder, because an unlinked player cannot earn any of
   *  this and should be told how to start. */
  linked: boolean;
  /** Current Discord rank. 0 for a linked account that has never spoken. */
  rank: number;
  paidTier: number;
  reachedTier: number;
  nextRank: number;
  /** 0..1 across the current gap between paying ranks. */
  progress: number;
  nextSummary: string;
  /**
   * True when this game account has already been paid by a DIFFERENT Discord
   * account. The ladder is over for them and saying so is much better than
   * showing a track that will never advance — that reads as a broken feature
   * rather than as a rule.
   */
  claimedByAnother: boolean;
  /** Rides along so the unlinked card can offer the door in the same fetch.
   *  Served rather than hardcoded in the client for the same reason
   *  /link/me serves it: one source (lib/discordInvite.ts), and rotating the
   *  invite does not need a client rebuild. */
  inviteUrl: string;
  track: DiscordRankStop[];
}

const BEHIND = 2;
const AHEAD = 7;

export async function getDiscordRankStatus(userId: string): Promise<DiscordRankStatus> {
  const empty: DiscordRankStatus = {
    linked: false, rank: 0, paidTier: 0, reachedTier: 0,
    nextRank: rankForTier(1), progress: 0,
    nextSummary: describePrizes(rewardForTier(1)),
    claimedByAnother: false, inviteUrl: DISCORD_INVITE_URL, track: [],
  };

  const link = await prisma.discordLink.findUnique({
    where: { userId },
    select: { discordId: true },
  });
  if (!link) return empty;

  // Settle before reading, so the numbers below describe a state that has
  // already been acted on. Reading first would show "reward on its way" for a
  // tier this very call is about to pay, which is true but needlessly stale.
  await settleDiscordRank(userId, link.discordId).catch(() => undefined);

  const [xpRow, claim] = await Promise.all([
    prisma.discordXp.findUnique({ where: { discordId: link.discordId }, select: { xp: true } }),
    prisma.discordRankClaim.findUnique({
      where: { discordId: link.discordId },
      select: { userId: true, paidTier: true },
    }),
  ]);

  const rank = levelFromXp(xpRow?.xp ?? 0).level;
  const reachedTier = tiersReachedAtRank(rank);
  const nextRank = nextTierRank(rank);
  const prevRank = rankForTier(reachedTier);
  const span = Math.max(1, nextRank - prevRank);

  // A claim belonging to somebody else pays this account nothing, so its
  // paidTier is not this account's paidTier. Reporting it as such would draw
  // ticks against stops that were never paid here.
  const mine = claim && claim.userId === userId ? claim : null;
  const paidTier = mine?.paidTier ?? 0;

  // Separately: has this GAME account been bound by another Discord account?
  // Only worth asking when the current Discord account has no claim of its
  // own, since a claim of its own already proves the unique index is satisfied.
  const claimedByAnother = !mine
    ? (await prisma.discordRankClaim.count({ where: { userId } })) > 0
    : false;

  const first = Math.max(1, reachedTier - BEHIND + 1);
  const last = reachedTier + AHEAD;
  const track: DiscordRankStop[] = [];
  for (let tier = first; tier <= last; tier++) {
    const stopRank = rankForTier(tier);
    track.push({
      tier,
      level: stopRank,
      prizes: rewardForTier(tier),
      state:
        tier <= paidTier ? "paid"
        : tier <= reachedTier ? "queued"
        : tier === reachedTier + 1 ? "next"
        : "future",
      milestone: stopRank % MASTERBALL_EVERY === 0,
    });
  }

  return {
    linked: true,
    rank,
    paidTier,
    reachedTier,
    nextRank,
    progress: Math.min(1, Math.max(0, (rank - prevRank) / span)),
    nextSummary: describePrizes(rewardForTier(reachedTier + 1)),
    claimedByAnother,
    inviteUrl: DISCORD_INVITE_URL,
    track,
  };
}
