import type { Region, RegionId } from "./types";
import type { Route, GymLeader, TrainerEncounter, ShopDef } from "../../types";
import { kanto } from "./kanto";

// Region registry. Adding a region here automatically merges its data
// into every flat dict the rest of the app reads, so callers like
// PartyColumn, BottomTabs, ContextPanel, etc. don't need changes.
//
// Iteration order matters only when two regions accidentally share an
// id (they shouldn't — namespace your route ids with a region prefix
// like "johto_" if there's any overlap). Later regions win in conflicts.

export const regions: Record<RegionId, Region> = {
  kanto,
};

export type { Region, RegionId } from "./types";

export const DEFAULT_REGION: RegionId = "kanto";

// Iterate once at module-load time and stash merged views. The rest of
// the app re-imports these as if they were the originals.
function mergeRoutes(): Record<string, Route> {
  const out: Record<string, Route> = {};
  for (const r of Object.values(regions)) Object.assign(out, r.routes);
  return out;
}
function mergeEncounters() {
  const out: Region["encounters"] = {};
  for (const r of Object.values(regions)) Object.assign(out, r.encounters);
  return out;
}
function mergeTrainerEncounters(): Record<string, TrainerEncounter[]> {
  const out: Record<string, TrainerEncounter[]> = {};
  for (const r of Object.values(regions)) Object.assign(out, r.trainerEncounters);
  return out;
}
function mergeShops(): Record<string, ShopDef> {
  const out: Record<string, ShopDef> = {};
  for (const r of Object.values(regions)) Object.assign(out, r.shops);
  return out;
}
function concatLeaders(pick: (r: Region) => GymLeader[]): GymLeader[] {
  return Object.values(regions).flatMap(pick);
}

export const mergedRoutes = mergeRoutes();
export const mergedEncounters = mergeEncounters();
export const mergedGymLeaders = concatLeaders((r) => r.gymLeaders);
export const mergedEliteFour = concatLeaders((r) => r.eliteFour);
export const mergedTrainerEncounters = mergeTrainerEncounters();
export const mergedShops = mergeShops();

// Reverse lookups — given a location id, what region does it belong to?
const locationToRegion: Record<string, RegionId> = {};
for (const region of Object.values(regions)) {
  for (const id of Object.keys(region.routes)) locationToRegion[id] = region.id;
}
export function regionForLocation(locationId: string): RegionId | undefined {
  return locationToRegion[locationId];
}

// Apply admin-edited positions on top of the in-code defaults. Called
// once at app boot from main.tsx. Mutates the shared `mergedRoutes`
// dict so every existing import keeps working without changes.
export function applyMapPositionOverrides(
  positions: Record<string, { x: number; y: number }>
) {
  for (const [id, pos] of Object.entries(positions)) {
    const r = mergedRoutes[id];
    if (r && pos && typeof pos.x === "number" && typeof pos.y === "number") {
      r.position = { x: pos.x, y: pos.y };
    }
  }
}
