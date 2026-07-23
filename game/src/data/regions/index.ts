import type { Region, RegionId } from "./types";
import type { Route, GymLeader, TrainerEncounter, ShopDef } from "../../types";
import { kanto } from "./kanto";
import { johto } from "./johto";

// Region registry. Adding a region here automatically merges its data
// into every flat dict the rest of the app reads, so callers like
// PartyColumn, BottomTabs, ContextPanel, etc. don't need changes.
//
// Iteration order matters only when two regions accidentally share an
// id (they shouldn't — namespace your route ids with a region prefix
// like "johto_" if there's any overlap). Later regions win in conflicts.
//
// Gym/Elite Four/Champion ids ARE checked for cross-region collisions —
// johto/eliteFour.ts's Koga/Bruno/Lance are suffixed "Johto" specifically
// because Kanto already uses those exact ids (Koga is a Kanto gym leader;
// Bruno and Lance are both Kanto Elite Four members). Without the suffix,
// beating Kanto's Bruno would satisfy state.defeatedEliteFour.includes("bruno")
// for Johto's Bruno too, letting players skip fighting him entirely.

export const regions: Record<RegionId, Region> = {
  kanto,
  johto,
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

// Unified mart inventory — the player no longer has to traipse to a
// specific town to access a stone or a Great Ball. Once they've visited
// a town that stocks an item, that item is available from every mart in
// the region. The per-item `unlockWildBattlesWon` gate still fires on
// top so progression unlocks aren't bypassed.
//
// Returns the merged ShopDef so the UI can render one tidy list keyed
// by itemId, plus a `unlockedAt` map naming the first town that sold
// each item (used for "First spotted at Cerulean Mart"-style hints).
export interface UnifiedShopItem {
  itemId: string;
  unlockWildBattlesWon?: number;
  firstSoldAt: string;        // canonical locationId of the earliest stocking town
  firstSoldAtName: string;    // its display name (e.g. "Cerulean Mart")
}
export interface UnifiedShop {
  items: UnifiedShopItem[];
  visitedTownsWithMart: number;
}
export function buildUnifiedShop(visitedLocationIds: readonly string[]): UnifiedShop {
  const visited = new Set(visitedLocationIds);
  const map = new Map<string, UnifiedShopItem>();
  let visitedTownsWithMart = 0;
  for (const [locationId, shop] of Object.entries(mergedShops)) {
    if (!visited.has(locationId)) continue;
    visitedTownsWithMart++;
    for (const entry of shop.items) {
      const existing = map.get(entry.itemId);
      if (existing) {
        // Keep the lower wildBattlesWon gate (whichever town unlocked
        // it first wins) — caps are union-of-easiest.
        const existingGate = existing.unlockWildBattlesWon ?? 0;
        const newGate = entry.unlockWildBattlesWon ?? 0;
        if (newGate < existingGate) {
          existing.unlockWildBattlesWon = entry.unlockWildBattlesWon;
          existing.firstSoldAt = locationId;
          existing.firstSoldAtName = shop.name;
        }
      } else {
        map.set(entry.itemId, {
          itemId: entry.itemId,
          unlockWildBattlesWon: entry.unlockWildBattlesWon,
          firstSoldAt: locationId,
          firstSoldAtName: shop.name,
        });
      }
    }
  }
  return { items: Array.from(map.values()), visitedTownsWithMart };
}

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
