import { routes } from "../data/routes";
import { regions, regionForLocation, DEFAULT_REGION, type Region } from "../data/regions";
import type { GameState } from "../types";

// How many of the player's defeated-gym ids belong to ONE specific
// region's own gymLeaders roster. Never use state.defeatedGyms.length
// directly for a region-specific badge check — a player who already has
// all 8 Kanto badges arrives in Johto already "holding" 8 badges, so any
// Johto-scoped badge gate compared against the raw global count would be
// trivially satisfied before they've beaten a single Johto gym. Used by
// both route-unlock gating (below) and the League card's "all badges
// earned" check (ContextPanel.tsx).
export function regionBadgeCount(state: GameState, region: Region): number {
  return state.defeatedGyms.filter((gid) => region.gymLeaders.some((g) => g.id === gid)).length;
}

// Same reasoning as regionBadgeCount, for the Elite Four: state.defeated
// EliteFour is one flat array across every region, so a raw .length
// would count Kanto's 4 E4 wins toward "have I cleared Johto's E4" too.
export function regionEliteFourCount(state: GameState, region: Region): number {
  return state.defeatedEliteFour.filter((mid) => region.eliteFour.some((m) => m.id === mid)).length;
}

// A non-default region's own starting town doubles as the "meet the
// professor" moment — the player should be offered a choice of that
// region's three starters exactly once, the first time they're standing
// there after the region unlocks. Never fires for the default region;
// its starter was already chosen via the pre-game starterSelect phase.
// Takes the raw fields rather than a full GameState so callers that are
// still assembling state (save load, LOAD_SAVE merges) don't need one.
export function pendingRegionStarter(claimedRegionStarters: string[], locationId: string): Region | null {
  for (const region of Object.values(regions)) {
    if (region.id === DEFAULT_REGION) continue;
    if (region.startingLocation !== locationId) continue;
    if (claimedRegionStarters.includes(region.id)) continue;
    return region;
  }
  return null;
}

// Recompute the set of unlocked locations from progress flags.
export function unlockedFromProgress(state: GameState): string[] {
  const unlocked = new Set(state.unlockedLocations);
  for (const [id, route] of Object.entries(routes)) {
    if (unlocked.has(id)) continue;
    const u = route.unlock;
    const region = regions[regionForLocation(id) ?? ""];
    const badges = region ? regionBadgeCount(state, region) : state.defeatedGyms.length;
    if (
      (u.battlesAtLocation &&
        u.battlesAtLocation.some(
          (req) => (state.battlesWonByLocation[req.locationId] ?? 0) < req.count
        )) ||
      (u.badgesRequired && badges < u.badgesRequired) ||
      (u.championDefeated && !state.championDefeated)
    ) {
      continue;
    }
    unlocked.add(id);
  }
  return Array.from(unlocked);
}
