import type { GameState, Pokemon } from "../types";
import type { TrainerEncounter } from "../types";
import { trainerEncounters } from "../data/trainerEncounters";
import { gymLeaders } from "../data/gymLeaders";
import { trainerClassSprites } from "../data/trainerClassSprites";
import { createPokemon } from "./pokemon";

// Build a Pokemon[] team for an opponent (trainer / gym leader). Their IDs
// don't need to be globally unique (they're never written into party / box),
// so we tag them with a prefix to avoid collision with the player's counter.
export function buildTeam(
  defs: { speciesKey: string; level: number }[],
  prefix: string
): { team: Pokemon[] } {
  const team: Pokemon[] = defs.map((d, i) => {
    const p = createPokemon(d.speciesKey, d.level, 0);
    return { ...p, id: `${prefix}_${i}` };
  });
  return { team };
}

export function getRouteTrainers(routeKey: string): TrainerEncounter[] {
  return trainerEncounters[routeKey] ?? [];
}

export function defeatedTrainerIds(state: GameState): Set<string> {
  // We persist defeated trainers as a side-channel inside battlesWonByLocation
  // when the original tracked it explicitly. For now, use an inferred check:
  // a trainer is "defeated" if their location's battlesWonByLocation > 0
  // BUT we want per-trainer granularity. We'll store as a simple key set.
  // Falling back to the existing pattern: re-fightable for now.
  // (See PROGRESS for a follow-up to add `defeatedTrainers: string[]` to state.)
  void state;
  return new Set();
}

export function getGymLeaderForLocation(locationKey: string) {
  return gymLeaders.find((g) => g.locationKey === locationKey);
}

export function trainerSprite(trainerClass: string): string {
  return trainerClassSprites[trainerClass] ?? "youngster";
}
