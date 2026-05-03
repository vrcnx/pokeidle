import { routes } from "../data/routes";
import type { GameState } from "../types";

// Recompute the set of unlocked locations from progress flags.
export function unlockedFromProgress(state: GameState): string[] {
  const unlocked = new Set(state.unlockedLocations);
  const badges = state.defeatedGyms.length;
  for (const [id, route] of Object.entries(routes)) {
    if (unlocked.has(id)) continue;
    const u = route.unlock;
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
