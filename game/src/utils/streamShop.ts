import { buildUnifiedShop } from "../data/regions";
import { itemsCatalog } from "../data/itemsCatalog";
import { pokeballs } from "../data/pokeballs";
import { BALL_ORDER } from "./items";
import type { GameState } from "../types";
import { stampActive, type StreamMemory } from "./streamMemory";

// Restock policy for the 24/7 stream account.
//
// The single worst failure this account has is running out of Poké Balls:
// auto-catch stops without a word, the Pokédex stalls forever, the box never
// gains a better mon, and the stream quietly becomes a level-100 Bulbasaur
// hitting Rattatas until someone notices days later. Money, meanwhile, only
// ever goes up. So the director buys.
//
// Two facts about BUY_ITEM shape everything here (reducer.ts:1027):
//   * it has NO location guard, NO mart guard and NO `unlockWildBattlesWon`
//     guard — the reducer will happily sell an Ultra Ball to a bot standing
//     in a cave. The mart is already the union of every unlocked town
//     (`buildUnifiedShop`), so we never have to travel to shop. We re-check
//     shop membership and the battle gate here purely to stay honest: the
//     stream should be seen doing only what a player could do.
//   * it has NO negative-quantity guard — a negative quantity would ADD money
//     and SUBTRACT inventory. Every quantity we hand it is clamped to >= 1.

/** Balls the director is willing to stock and use.
 *
 *  Master Ball is deliberately absent: `buyPrice` is null so it can never be
 *  bought, and `pickAutoBall` walks BALL_ORDER cheapest-first and returns the
 *  first ball that GUARANTEES a catch — a Master Ball in the enabled list
 *  would still only be reached as the last resort, but on the one encounter
 *  that matters it would be spent on whatever happened to be in front of us. */
export const BALL_POLICY: readonly string[] = BALL_ORDER.filter((b) => b !== "masterball");

// `buildUnifiedShop` walks every town's stock list, and the director asks it
// several times a tick, forever. `unlockedLocations` is only ever replaced
// wholesale when it grows, so caching on reference identity is exact.
let shopCacheKey: readonly string[] | null = null;
let shopCache: Map<string, { itemId: string; unlockWildBattlesWon?: number }> | null = null;

function shopIndex(state: GameState) {
  if (shopCacheKey !== state.unlockedLocations || !shopCache) {
    const m = new Map<string, { itemId: string; unlockWildBattlesWon?: number }>();
    for (const i of buildUnifiedShop(state.unlockedLocations).items) m.set(i.itemId, i);
    shopCacheKey = state.unlockedLocations;
    shopCache = m;
  }
  return shopCache;
}

/** Everything in the unified mart the account can legitimately buy today. */
export function shopEntry(
  state: GameState,
  itemId: string,
): { itemId: string; unlockWildBattlesWon?: number } | null {
  const entry = shopIndex(state).get(itemId);
  if (!entry) return null;
  if (state.wildBattlesWon < (entry.unlockWildBattlesWon ?? 0)) return null;
  return entry;
}

/** Catalog price. Catalog wins over the legacy tables, exactly as BUY_ITEM
 *  resolves it — never price a purchase off `consumables.ts`, which the shop
 *  UI still does and which is why Repel *displays* at $2,000 and *charges*
 *  $350. */
export function buyPrice(itemId: string): number | null {
  return itemsCatalog[itemId]?.buyPrice ?? pokeballs[itemId]?.buyPrice ?? null;
}

/** Balls we own that auto-catch is actually allowed to throw. Anything
 *  outside `enabledBalls` is dead stock as far as `pickAutoBall` is
 *  concerned, so it must not count toward "are we stocked". */
export function usableBallCount(state: GameState): number {
  const enabled = state.globalCatchDefaults.enabledBalls ?? [];
  return BALL_POLICY.reduce(
    (n, b) => n + (enabled.includes(b) ? state.inventory[b] ?? 0 : 0),
    0,
  );
}

/** The ball list the account SHOULD have enabled: every policy ball it either
 *  already owns or can buy today. Enabling more is strictly better, not
 *  wasteful — `pickAutoBall` (catching.ts:41-49) walks cheapest-first and
 *  returns the first ball that guarantees the catch, so Rattatas still get
 *  Poké Balls and only a Dratini reaches for the Ultra Ball. */
export function policyEnabledBalls(state: GameState): string[] {
  return BALL_POLICY.filter(
    (b) => (state.inventory[b] ?? 0) > 0 || shopEntry(state, b) !== null,
  );
}

/** Order-insensitive set comparison, so re-asserting the ball policy doesn't
 *  fire forever just because the array was built in a different order. */
export function sameBallSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export interface RestockPick {
  itemId: string;
  unitPrice: number;
  quantity: number;
  total: number;
}

/**
 * What to buy to get back to `target` usable balls, or null when we should
 * not buy at all this tick.
 *
 * Cheapest first: a stream that spends its whole float on Ultra Balls has
 * nothing left for the Exp Share, and Poké Balls already guarantee most
 * common species. Anything we tried to buy and did NOT receive is skipped
 * (see `unbuyable`) so a mispriced or gated item can't become an infinite
 * buy loop on camera.
 */
export function pickBallRestock(
  state: GameState,
  memory: StreamMemory,
  opts: { target: number; moneyFloor: number },
): RestockPick | null {
  const deficit = opts.target - usableBallCount(state);
  if (deficit <= 0) return null;
  const spendable = state.money - opts.moneyFloor;
  if (spendable <= 0) return null;

  const enabled = state.globalCatchDefaults.enabledBalls ?? [];
  for (const itemId of BALL_POLICY) {
    if (!enabled.includes(itemId)) continue;
    if (stampActive(memory.unbuyable, itemId)) continue;
    if (!shopEntry(state, itemId)) continue;
    const unitPrice = buyPrice(itemId);
    if (unitPrice == null || unitPrice <= 0) continue;
    const affordable = Math.floor(spendable / unitPrice);
    if (affordable < 1) continue;
    const quantity = Math.max(1, Math.min(deficit, affordable));
    return { itemId, unitPrice, quantity, total: unitPrice * quantity };
  }
  return null;
}
