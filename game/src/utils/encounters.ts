import { encounters as encounterTable } from "../data/encounters";
import type { ActiveEffect } from "../types";

// Every id in the repel line. Kept beside the logic that consumes it
// so adding a new tier to consumables.ts without adding it here is an
// obvious omission rather than a silent no-op.
export const REPEL_IDS = new Set(["repel", "superrepel", "maxrepel"]);

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
    let weight = e.weight;
    for (const eff of effects) {
      if (eff.routeKey && eff.routeKey !== routeKey) continue;
      if (eff.speciesKey !== e.speciesKey) continue;
      // Match the repel FAMILY, not the literal id. Super Repel and Max
      // Repel are sold in five marts but were only ever compared against
      // "repel" here, so they applied no weighting — players paid $500 /
      // $700 for an item that did nothing. The tiers differ in duration
      // (see data/consumables.ts), not in strength.
      if (REPEL_IDS.has(eff.itemId)) weight *= 0.5;
      else if (eff.itemId === "honey") weight *= 2;
    }
    return { ...e, weight };
  });
}

export function rollEncounter(
  routeKey: string,
  effects: ActiveEffect[] = []
): { speciesKey: string; level: number } | null {
  const route = encounterTable[routeKey];
  if (!route) return null;
  const adjusted = adjustWeights(route.encounters, routeKey, effects);
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
