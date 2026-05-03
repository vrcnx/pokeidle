import type { Route, GymLeader, TrainerEncounter, ShopDef } from "../../types";

// A "region" in this codebase is a self-contained world chunk: its own
// routes, encounters, gym leaders, Elite Four, trainer encounters, and
// mart inventories. Regions are stitched together by the registry in
// `regions/index.ts` so the rest of the app can keep treating these
// dicts as flat lookups by id.
//
// Adding a new region (say Johto):
//   1. Drop a `regions/johto/` folder with the same six data files.
//   2. Create `regions/johto/index.ts` exporting a Region object.
//   3. Add it to the `regions` registry in `regions/index.ts`.
//   4. Update unlockCondition if the region gates behind another region's
//      Champion fight (e.g. Johto unlocks after Kanto Champion).

export type RegionId = string;

export interface Region {
  id: RegionId;
  name: string;
  // Three species keys players can pick from when starting the region's
  // story for the first time. Currently only used for the global
  // STARTER_KEYS export, but a future "second starter at the new region"
  // feature would key off these.
  starters: string[];
  // The location id the player lands at when entering this region.
  // For Kanto that's "palletTown". A future Johto would land at
  // "newBarkTown".
  startingLocation: string;
  // Optional bespoke town map asset. Fallback is /ui/townmap.png.
  townMapImage?: string;
  routes: Record<string, Route>;
  encounters: Record<string, EncountersEntry>;
  gymLeaders: GymLeader[];
  eliteFour: GymLeader[];
  champion?: GymLeader;
  trainerEncounters: Record<string, TrainerEncounter[]>;
  shops: Record<string, ShopDef>;
  // Region-traversal gating. Empty means the region is always accessible.
  // `championDefeatedIn` waits until that region's `championDefeated`
  // flag flips — once we have multiple regions this is how Johto unlocks
  // post-Kanto.
  unlockCondition?: { championDefeatedIn?: RegionId };
}

export interface EncountersEntry {
  name: string;
  encounters: {
    speciesKey: string;
    weight: number;
    minLevel: number;
    maxLevel: number;
  }[];
}
