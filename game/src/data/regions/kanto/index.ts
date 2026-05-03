import type { Region } from "../types";
import { routes } from "./routes";
import { encounters } from "./encounters";
import { gymLeaders } from "./gymLeaders";
import { eliteFour, champion } from "./eliteFour";
import { trainerEncounters } from "./trainerEncounters";
import { shops } from "./shops";

// Kanto — the original region. Always unlocked, ships as the default
// starting region for every new save. The starting location and starter
// species lived in `state/initialState` before the region split; they
// now live here so a future second region can carry its own equivalents.

export const kanto: Region = {
  id: "kanto",
  name: "Kanto",
  starters: ["bulbasaur", "charmander", "squirtle"],
  startingLocation: "palletTown",
  townMapImage: "/ui/townmap.png",
  routes,
  encounters,
  gymLeaders,
  eliteFour,
  champion,
  trainerEncounters,
  shops,
};
