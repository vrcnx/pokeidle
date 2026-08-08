// What each Discord rank pays, as pure arithmetic.
//
// The DB half is discordRankRewards.ts. This file is the curve, and it is
// pure so the reward for rank 40 can be asserted in a test without a database
// and without a Discord account.
//
// ══ WHY EVERY PRIZE HERE IS AN ITEM AND NONE OF THEM IS MONEY ═══════
//
// lib/discordXp.ts opens by saying XP must never convert into anything the
// game economy can observe, and names the reason: chat XP paying game currency
// puts a faucet on the economy whose tap is "type in a text box". Its own
// comment asks that any change argue with it first, so here is the argument.
//
// The concern is inflation, and inflation is a MONEY problem. Money is
// fungible, unbounded in effect, and lands in the same pool every price in
// the game is denominated against — a farmed million devalues every other
// player's million. An Ultra Ball does not: it is consumed on use, it buys
// exactly one improved catch chance, and a player who farms a hundred of them
// has a hundred catch attempts rather than leverage over the market.
//
// So the compromise is that the faucet stays shut on currency and opens only
// on consumables. The worst case for an XP exploit is still a wrong number on
// a leaderboard, plus some Poké Balls.
//
// If money is ever added here, the anti-farm story has to be rebuilt from
// scratch, because the double receipt in discordRankRewards.ts bounds how
// often ONE pair of accounts can claim — it does nothing about N throwaway
// pairs, and that is precisely the exposure money would make matter.
//
// ══ AND WHY THE TAIL IS OPEN ════════════════════════════════════════
//
// The XP curve is MEE6's, 5L² + 50L + 100 per level, so rank 100 is roughly
// 1.9M lifetime XP — about 66 days of nonstop chatting at the 60-second
// cooldown. Nobody will reach it. But "nobody will reach it" is how the
// account-level ladder ended up with a ceiling somebody hit, so the tail here
// keeps stepping rather than stopping at a number chosen by guessing.

import type { Prize } from "./giveaway.js";

/**
 * The hand-placed early ranks.
 *
 * Tight at the start because the first few are the ones that decide whether a
 * new member comes back tomorrow, and rank 5 is roughly an evening of talking
 * rather than a project.
 */
export const EARLY_RANKS = [5, 10, 15, 20, 25, 30] as const;

/** Past the hand-placed ranks, one tier every this many ranks, forever. */
export const TAIL_STEP = 10;

/** A Master Ball at every rank divisible by this. */
export const MASTERBALL_EVERY = 25;

/** Item quantities are capped at 999 by PrizeSchema, so a merged back-pay
 *  splits rather than silently losing the excess. */
const MAX_STACK = 999;

const LAST_EARLY = EARLY_RANKS[EARLY_RANKS.length - 1];

/**
 * How many tiers a member at `rank` has reached. O(1) — no loop over the
 * ladder, because the ladder has no end to loop to.
 */
export function tiersReachedAtRank(rank: number): number {
  const r = Math.floor(rank);
  if (r < EARLY_RANKS[0]) return 0;
  if (r <= LAST_EARLY) {
    let n = 0;
    for (const e of EARLY_RANKS) if (r >= e) n++;
    return n;
  }
  return EARLY_RANKS.length + Math.floor((r - LAST_EARLY) / TAIL_STEP);
}

/** The rank that unlocks tier `tier`. Inverse of the above. */
export function rankForTier(tier: number): number {
  const t = Math.floor(tier);
  if (t <= 0) return 0;
  if (t <= EARLY_RANKS.length) return EARLY_RANKS[t - 1];
  return LAST_EARLY + (t - EARLY_RANKS.length) * TAIL_STEP;
}

/** The next rank that pays, from where a member stands now. */
export function nextTierRank(rank: number): number {
  return rankForTier(tiersReachedAtRank(rank) + 1);
}

/**
 * What one tier pays.
 *
 * Balls band by rank rather than growing without bound: the reward for being
 * a long-standing member is a better ball, not an ever-larger pile of the
 * same one.
 */
export function rewardForTier(tier: number): Prize[] {
  const rank = rankForTier(tier);
  if (rank <= 0) return [];

  const prizes: Prize[] = [];
  const ball = rank < 10 ? "pokeball" : rank < 25 ? "greatball" : "ultraball";
  prizes.push({ kind: "item", itemId: ball, quantity: 10 });

  // The thing worth staying for. Every 25 ranks, so it is visible on the
  // track from a long way below it.
  if (rank % MASTERBALL_EVERY === 0) {
    prizes.push({ kind: "item", itemId: "masterball", quantity: 1 });
  }
  return prizes;
}

/**
 * Everything owed for crossing from tier `from` to tier `to`, MERGED.
 *
 * A member who links at rank 40 is owed seven tiers at once. Emitting seven
 * separate prize entries would be seven "10x pokeball" lines in one grant
 * summary; merging makes it one readable "60x greatball + 1x masterball".
 *
 * Merged quantities are then SPLIT at the 999 cap rather than clamped. The
 * account-level ladder shipped with a clamp on money and it silently deleted
 * about $40M of back-pay from everyone past level 1,150 — a clamp on a
 * back-pay path is a quiet way to pay less than you said you would.
 */
export function rewardsBetween(from: number, to: number): Prize[] {
  const start = Math.max(0, Math.floor(from));
  const end = Math.floor(to);
  if (end <= start) return [];

  // Insertion-ordered, so the summary reads in the order the tiers were
  // earned rather than in whatever order a hash landed them.
  const byItem = new Map<string, number>();
  for (let tier = start + 1; tier <= end; tier++) {
    for (const p of rewardForTier(tier)) {
      if (p.kind !== "item") continue;
      byItem.set(p.itemId, (byItem.get(p.itemId) ?? 0) + p.quantity);
    }
  }

  const out: Prize[] = [];
  for (const [itemId, total] of byItem) {
    let left = total;
    while (left > 0) {
      const take = Math.min(MAX_STACK, left);
      out.push({ kind: "item", itemId, quantity: take });
      left -= take;
    }
  }
  return out;
}
