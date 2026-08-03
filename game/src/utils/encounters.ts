import { encounters as encounterTable } from "../data/encounters";
import { applyJourneyOffset } from "./regionJourney";
import { consumables } from "../data/consumables";
import type { ActiveEffect } from "../types";

// Every id in the repel line. Kept beside the logic that consumes it
// so adding a new tier to consumables.ts without adding it here is an
// obvious omission rather than a silent no-op.
export const REPEL_IDS = new Set(["repel", "superrepel", "maxrepel"]);

// The same line as an ordered array, cheapest/shortest first, derived from
// the consumables table rather than typed out again. Any UI that offers a
// repel control MUST build its buttons from this — the previous UI hardcoded
// the literal "repel", which is exactly why Super/Max Repel were purchasable
// but had no way to be used for two releases running.
export const REPEL_TIERS: string[] = [...REPEL_IDS]
  .filter((id) => id in consumables)
  .sort((a, b) => consumables[a].duration - consumables[b].duration);

// The two families that pull on an encounter weight. They pull the SAME
// number in OPPOSITE directions, which is why nothing may ever run both on
// one species+route — see the conflict guard in USE_EFFECT_ITEM. Every
// caller that needs to reason about "is this a repel or a honey" goes
// through here so the reducer, the roll and the UI can't drift apart.
export type WeightFamily = "repel" | "honey";

export function weightFamily(itemId: string): WeightFamily | null {
  if (REPEL_IDS.has(itemId)) return "repel";
  if (itemId === "honey") return "honey";
  return null;
}

interface RouteEncounter {
  speciesKey: string;
  weight: number;
  minLevel: number;
  maxLevel: number;
}

// Apply repel/honey active effects to a route's encounter weights for
// a single encounter roll. Repel halves; honey doubles.
function adjustWeights(
  list: RouteEncounter[],
  routeKey: string,
  effects: ActiveEffect[]
): RouteEncounter[] {
  if (effects.length === 0) return list;
  return list.map((e) => {
    let repel = false;
    let honey = false;
    for (const eff of effects) {
      // A paused effect keeps its remaining battles but contributes
      // nothing, matching the Exp. Share rule in reducer.ts. Without this
      // the Bag could show a repel as "paused" while it was still quietly
      // halving encounters.
      if (eff.paused) continue;
      if (eff.routeKey && eff.routeKey !== routeKey) continue;
      if (eff.speciesKey !== e.speciesKey) continue;
      // Match the repel FAMILY, not the literal id. Super Repel and Max
      // Repel are sold in five marts but were only ever compared against
      // "repel" here, so they applied no weighting — players paid $500 /
      // $700 for an item that did nothing. The tiers differ in duration
      // (see data/consumables.ts), not in strength — so the halving lands
      // at most once per species even if several tiers are running.
      const family = weightFamily(eff.itemId);
      if (family === "repel") repel = true;
      else if (family === "honey") honey = true;
    }
    // Halving and doubling at once is a contradiction, and USE_EFFECT_ITEM
    // now refuses to create one. Saves written before that guard existed can
    // still hold the pair, so spell out what happens instead of leaving it to
    // fall out of 0.5 × 2: they cancel, exactly as they always silently did.
    // Picking a winner here would quietly change the encounter rates of every
    // save already in that state; leaving the wash and NAMING it in the wild
    // detail panel lets the player undo it themselves.
    if (repel && honey) return e;
    if (repel) return { ...e, weight: e.weight * 0.5 };
    if (honey) return { ...e, weight: e.weight * 2 };
    return e;
  });
}

export function rollEncounter(
  routeKey: string,
  effects: ActiveEffect[] = [],
  /** Levels to take off — see journeyLevelOffset. Passed in rather than
   *  derived here so this module stays free of GameState, and so the screens
   *  that PRINT a band can apply the identical transform. */
  levelOffset = 0,
): { speciesKey: string; level: number } | null {
  const route = encounterTable[routeKey];
  if (!route) return null;
  const adjusted = adjustWeights(route.encounters, routeKey, effects)
    .map((e) => applyJourneyOffset(e, levelOffset));
  const total = adjusted.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const e of adjusted) {
    r -= e.weight;
    if (r <= 0) {
      const level = e.minLevel + Math.floor(Math.random() * (e.maxLevel - e.minLevel + 1));
      return { speciesKey: e.speciesKey, level };
    }
  }
  const last = adjusted[adjusted.length - 1];
  return {
    speciesKey: last.speciesKey,
    level: last.minLevel + Math.floor(Math.random() * (last.maxLevel - last.minLevel + 1)),
  };
}

export function routeHasEncounters(routeKey: string): boolean {
  return !!encounterTable[routeKey];
}
