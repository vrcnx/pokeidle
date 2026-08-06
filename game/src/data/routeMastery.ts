/**
 * ROUTE MASTERY — the idle loop's own reward track.
 *
 * ── THE GAP THIS FILLS ────────────────────────────────────────────────────
 * Everything in this game that pays out is attached to something you do
 * ONCE: a gym gives a badge, the Elite Four gives tokens, the daily gives a
 * daily. The thing a player actually spends their hours on — grinding wild
 * battles on a route — pays nothing but EXP and money, and by the mid-game
 * money is meaningless (a real save is sitting on $209,000,000). Achievements
 * look like the answer and are not: they are pure predicates over state,
 * deliberately grant nothing, and exist to be a trophy cabinet.
 *
 * So the loop had no reward track at all. This is that track.
 *
 * ── IT REWARDS THE THING YOU ARE ALREADY DOING ────────────────────────────
 * Keyed on `battlesWonByLocation`, which the reducer has always kept and
 * nothing has ever read. No new counter, no new event, and every existing
 * save already has years of progress banked in it — a returning player finds
 * milestones waiting rather than a track that starts at zero and asks them to
 * grind it again.
 *
 * ── AND IT PAYS IN THINGS THAT ARE WORTH SOMETHING ────────────────────────
 * Not money. Money is the one resource an established player cannot use, so
 * paying in it would make the whole track read as nothing. Every tier pays
 * something you cannot simply buy: rare balls, a Bottle Cap for Hyper
 * Training, and at the top a Victory Token, which is the Reward Shop's
 * currency and otherwise only comes from beating a champion.
 */

import type { GameState } from "../types";
import { mergedRoutes } from "../data/regions";

/**
 * What a tier pays.
 *
 * Two shapes because Victory Tokens are NOT an inventory item — they are a
 * number on GameState with their own spend path at the Reward Shop. Modelling
 * them as `{ itemId: "victoryToken" }` would have written a key the item
 * catalog has never heard of into the player's bag, where nothing would
 * render it and nothing could spend it.
 */
export type MasteryReward =
  | { kind: "item"; itemId: string; quantity: number }
  | { kind: "tokens"; amount: number };

export interface MasteryTier {
  /** 1-based, and the numeral shown to the player. */
  level: number;
  /** Wins on a single route to reach it. */
  wins: number;
  reward: MasteryReward;
  label: string;
}

/**
 * Three tiers, spaced so the first is reachable in an evening and the last is
 * a genuine commitment.
 *
 * 60 is roughly an hour of idling at ×5 on a populated route, so the first
 * one lands inside a single session — a track whose first reward is a week
 * away is a track nobody discovers. The 5× and 4× steps after it keep the
 * later ones meaningful without turning the third into a second job.
 */
export const MASTERY_TIERS: readonly MasteryTier[] = [
  { level: 1, wins: 60,   label: "Familiar", reward: { kind: "item", itemId: "ultraball", quantity: 5 } },
  { level: 2, wins: 300,  label: "Seasoned", reward: { kind: "item", itemId: "silverbottlecap", quantity: 1 } },
  { level: 3, wins: 1200, label: "Mastered", reward: { kind: "tokens", amount: 1 } },
];

/** `${routeId}:${level}` — the id a claim is recorded under. */
export function masteryKey(routeId: string, level: number): string {
  return `${routeId}:${level}`;
}

/**
 * Routes that can be mastered.
 *
 * Towns are excluded: their battles are trainer rematches on a fixed roster,
 * so mastery there would reward re-fighting the same four people rather than
 * working a route. Raids are excluded because they already have their own
 * reward table and lockouts.
 */
export function isMasterable(routeId: string): boolean {
  const r = mergedRoutes[routeId];
  return !!r && r.type !== "town" && r.type !== "raid";
}

/** Wins banked on a route. */
export function winsOn(state: GameState, routeId: string): number {
  return state.battlesWonByLocation[routeId] ?? 0;
}

/** The highest tier EARNED on a route, whether or not it has been claimed. */
export function earnedLevel(wins: number): number {
  let level = 0;
  for (const t of MASTERY_TIERS) if (wins >= t.wins) level = t.level;
  return level;
}

/** The next tier to work toward, or null once a route is fully mastered. */
export function nextTier(wins: number): MasteryTier | null {
  return MASTERY_TIERS.find((t) => wins < t.wins) ?? null;
}

export interface ClaimableMastery {
  routeId: string;
  routeName: string;
  tier: MasteryTier;
  key: string;
}

/**
 * Everything earned and not yet taken, oldest tier first.
 *
 * Ordered by tier and then by route so the list is stable between renders —
 * a "claim" button that reorders under the thumb as rewards arrive is how a
 * player claims the wrong one.
 */
export function claimable(state: GameState): ClaimableMastery[] {
  const claimed = new Set(state.claimedMastery ?? []);
  const out: ClaimableMastery[] = [];
  for (const [routeId, wins] of Object.entries(state.battlesWonByLocation)) {
    if (!isMasterable(routeId)) continue;
    for (const tier of MASTERY_TIERS) {
      if (wins < tier.wins) break;
      const key = masteryKey(routeId, tier.level);
      if (claimed.has(key)) continue;
      out.push({ routeId, routeName: mergedRoutes[routeId]?.name ?? routeId, tier, key });
    }
  }
  return out.sort((a, b) => a.tier.level - b.tier.level || a.routeId.localeCompare(b.routeId));
}

/** How many tiers have been claimed across every route — the headline number. */
export function masteryScore(state: GameState): number {
  return (state.claimedMastery ?? []).length;
}

/** Total tiers available, so the score has a denominator. */
export function masteryTotal(): number {
  return Object.keys(mergedRoutes).filter(isMasterable).length * MASTERY_TIERS.length;
}
