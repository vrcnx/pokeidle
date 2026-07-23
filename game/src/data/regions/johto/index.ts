import type { Region } from "../types";
import { routes } from "./routes";
import { encounters } from "./encounters";
import { gymLeaders } from "./gymLeaders";
import { eliteFour, champion } from "./eliteFour";
import { trainerEncounters } from "./trainerEncounters";
import { shops } from "./shops";

// Johto — unlocked after beating Kanto's Champion (see New Bark Town's own
// `unlock: { championDefeated: true }` in routes.ts, which is the actual
// gate; unlockCondition below just documents the same relationship on the
// Region object itself, per regions/types.ts's own suggested checklist).
// No townMapImage — the graphical map (TownMap.tsx) is currently unmounted
// in favor of RouteCardList, so there's no asset to point at.
export const johto: Region = {
  id: "johto",
  name: "Johto",
  starters: ["chikorita", "cyndaquil", "totodile"],
  startingLocation: "newBarkTown",
  unlockCondition: { championDefeatedIn: "kanto" },
  routes,
  encounters,
  gymLeaders,
  eliteFour,
  champion,
  trainerEncounters,
  shops,
};
