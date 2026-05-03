import { encounters as encounterTable } from "../data/encounters";
import type { ActiveEffect } from "../types";

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
      if (eff.itemId === "repel") weight *= 0.5;
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
