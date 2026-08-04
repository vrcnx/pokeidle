// Every region its own journey.
//
// See docs/region-journeys.md for the full design and why it is shaped this
// way. The short version, because it is the thing to hold in your head:
//
//   ONE FLAG DRIVES EVERYTHING — has this player completed this region?
//
//     UNCOMPLETED  →  journey mode: a region-locked team
//     COMPLETED    →  farm mode:    no restrictions at all
//
// That is why the level change and the usage restriction are not two features
// to balance against each other. They are two readings of the same state, so
// an established player's Johto stays exactly the farm it is today (they
// completed it) while a new player's Johto is a real region.

import { regions, regionForLocation, mergedRoutes, type RegionId } from "../data/regions";
import type { GameState, Pokemon } from "../types";

/**
 * The regions that existed when journeys shipped.
 *
 * ── THE DECISION THE WHOLE FEATURE RESTS ON ───────────────────────────────
 * A Pokémon caught before this feature has no `caughtIn`. The tempting
 * reading of that is "unrestricted", and it is wrong: it would let every
 * existing box walk into Hoenn and flatten it, which is precisely the
 * "future regions become irrelevant" failure this is meant to fix.
 *
 * So a Pokémon with no recorded origin counts as native to these regions and
 * no others. Nobody loses access to anything they already own, Kanto and
 * Johto behave for existing players exactly as they do today, and every
 * region added after this is a genuine fresh start for new and old players
 * alike.
 *
 * FROZEN. This never grows. Adding Hoenn to it would hand every legacy box a
 * free pass into Hoenn and undo the feature — the whole mechanism for keeping
 * future regions meaningful is that this list stopped growing.
 */
export const LEGACY_REGIONS: ReadonlySet<RegionId> = new Set(["kanto", "johto"]);

/**
 * Is this location outside every region's journey?
 *
 * Keyed on the route's TYPE, not on its id or which region file it happens to
 * live in. Raid Island is filed under Kanto and reachable from everywhere, so
 * an id check would exempt it while silently failing to exempt the next
 * region's raid area. `type: "raid"` is the property that actually means
 * "endgame content that belongs to nobody's journey".
 */
export function isOutsideJourneys(locationId: string): boolean {
  return mergedRoutes[locationId]?.type === "raid";
}

/** Has this player finished this region? */
export function regionCompleted(regionId: RegionId, state: GameState): boolean {
  const region = regions[regionId];
  // A region nobody has heard of is not a place, and cannot be "done". This
  // matters for exactly one case and it is the important one: it is what makes
  // the legacy rule refuse a region that has not shipped yet, rather than
  // waving it through because the lookup missed.
  if (!region) return false;
  // A KNOWN region with no champion has no completion condition, so it can
  // never gate anything. Treating that as complete is the safe reading — the
  // alternative locks players out of a region they cannot finish.
  if (!region.champion) return true;
  return state.defeatedChampions.includes(region.champion.id);
}

export type UseVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * May this Pokémon be used in this region?
 *
 * The mirror rule the proposal asks for — a Pokémon caught in an uncompleted
 * region cannot be taken OUT of it — needs no second rule. It is this same
 * predicate evaluated against the destination: a Johto-caught Pokémon fails
 * `canUseInRegion(mon, "kanto")` while Johto is uncompleted, which is what
 * closes the "level it up in Kanto with an Exp. Share" round trip.
 */
export function canUseInRegion(
  mon: Pokemon,
  regionId: RegionId | undefined,
  state: GameState,
): UseVerdict {
  // A location the region map does not know. Never refuse on a lookup miss.
  if (!regionId) return { ok: true };

  // FARM MODE. Once you have beaten a region it stops asking questions.
  if (regionCompleted(regionId, state)) return { ok: true };

  const here = regions[regionId]?.name ?? regionId;

  // Native to the region you are standing in.
  if (mon.caughtIn === regionId) return { ok: true };

  // Legacy: caught before journeys existed. Native to the old regions only.
  if (mon.caughtIn === undefined) {
    if (LEGACY_REGIONS.has(regionId)) return { ok: true };
    return {
      ok: false,
      reason: `${here} is a fresh start — catch a team here to take it on.`,
    };
  }

  // Caught somewhere else, and this region is not finished yet.
  const home = regions[mon.caughtIn]?.name ?? mon.caughtIn;
  return {
    ok: false,
    reason: `Caught in ${home}. ${here} has to be earned with a ${here} team.`,
  };
}

/** The same question for wherever the player is standing right now. */
export function canUseHere(mon: Pokemon, state: GameState): UseVerdict {
  if (isOutsideJourneys(state.currentLocation)) return { ok: true };
  return canUseInRegion(mon, regionForLocation(state.currentLocation), state);
}

/**
 * ── PvP IS EXEMPT, DELIBERATELY ───────────────────────────────────────────
 * The ladder is level-capped and cross-region by construction: it is a format,
 * not a place. Applying journey rules there would mean a player mid-Johto
 * could not ladder with the team they spent Kanto building, which punishes
 * them for starting a second region.
 *
 * This exists as a named function rather than as "we simply never call
 * canUseInRegion from the PvP code" so that the exemption is a decision
 * somebody made, findable by grep, instead of an omission nobody noticed.
 */
export function pvpIgnoresJourneyRules(): true {
  return true;
}

/**
 * Which of a party is not allowed where the player is standing.
 *
 * Returned as the offending members rather than a boolean because every
 * caller needs to SAY which ones — a blocked action that will not name what
 * blocked it is the failure mode this codebase keeps rediscovering.
 */
export function illegalPartyMembers(state: GameState): { mon: Pokemon; reason: string }[] {
  const out: { mon: Pokemon; reason: string }[] = [];
  for (const mon of state.party) {
    if (!mon) continue;
    const v = canUseHere(mon, state);
    if (!v.ok) out.push({ mon, reason: v.reason });
  }
  return out;
}

// ── JOURNEY LEVELS ────────────────────────────────────────────────────────
//
// Johto's encounters were authored by adding a FLAT OFFSET to the Gold/Silver
// levels, and the offset is exactly 38. That is not a guess — subtracting it
// reproduces the canon curve precisely across all 34 areas:
//
//     Route 29     40-42  ->   2-4      (canon Sentret/Pidgey Lv 2-4)
//     Route 31     42-44  ->   4-6
//     Union Cave   46-49  ->   8-11
//     National Pk  52-55  ->  14-17
//     Dragon's Den 68-71  ->  30-33
//     Mt Silver    75-80  ->  37-42
//
// So the original data is recoverable arithmetically and there is nothing to
// fetch, map or hand-author. That matters beyond convenience: a PokéAPI pull
// would have needed every one of those 34 areas matched to a location-area
// name, by hand, and re-matched for every region added afterwards.
//
// Kanto is absent because Kanto was never inflated — its encounters already
// start at Lv 2.
const JOURNEY_LEVEL_OFFSET: Record<RegionId, number> = {
  johto: 38,
};

/** Nothing is ever rolled below this, whatever the arithmetic says. */
const MIN_JOURNEY_LEVEL = 2;

/**
 * How much to take off this route's encounter levels for this player.
 *
 * Zero in farm mode, which is what keeps an established player's Johto the
 * Lv 40-80 grind it is today — they completed it, so nothing moves. Zero for
 * Kanto always, and zero for anywhere outside a journey.
 */
export function journeyLevelOffset(routeId: string, state: GameState): number {
  if (isOutsideJourneys(routeId)) return 0;
  const regionId = regionForLocation(routeId);
  if (!regionId) return 0;
  if (regionCompleted(regionId, state)) return 0;
  return JOURNEY_LEVEL_OFFSET[regionId] ?? 0;
}

/**
 * Apply an offset to a level band.
 *
 * Shared by the roller and by every screen that PRINTS a band — the Map card,
 * the dex sheet, the catch-settings list. If the map says Lv 40-42 and you
 * meet a Lv 3 Sentret, the map is lying, and that is a worse bug than the one
 * this feature set out to fix.
 */
export function applyJourneyOffset<T extends { minLevel: number; maxLevel: number }>(
  enc: T,
  offset: number,
): T {
  if (offset <= 0) return enc;
  return {
    ...enc,
    minLevel: Math.max(MIN_JOURNEY_LEVEL, enc.minLevel - offset),
    maxLevel: Math.max(MIN_JOURNEY_LEVEL, enc.maxLevel - offset),
  };
}

// ── WHAT CLEARING A REGION IS WORTH ───────────────────────────────────────
//
// Journeys take things away — a region you have not finished will not accept
// an outside team, and its levels drop to the real curve. Without something
// on the other side of the ledger the whole design reads as a nerf, which is
// the objection the proposal itself raised.
//
// So every champion you have beaten pays out, permanently and account-wide.
// Small per region and cumulative, so it is a reason to finish a region
// rather than a reason to rush one: three regions is +30% EXP, not triple.
export const REGION_CLEAR_BONUS = {
  /** Extra EXP from every battle, per region cleared. */
  exp: 0.10,
  /** Extra prize money from every trainer, per region cleared. */
  money: 0.10,
  /** Extra catch chance, per region cleared. Half the others deliberately —
   *  catch rate compounds with every ball thrown, and a big number here
   *  trivialises the Pokédex the journey rules exist to protect. */
  catch: 0.05,
} as const;

/** How many regions this player has finished. */
export function regionsCleared(state: GameState): number {
  return Object.keys(regions).filter((id) => regionCompleted(id, state)).length;
}

export interface RegionBonuses {
  cleared: number;
  /** Multipliers, 1 = no change. */
  exp: number;
  money: number;
  catch: number;
}

/**
 * The standing bonus from every region cleared.
 *
 * Read at the point of use rather than stored on the save: it is a pure
 * function of `defeatedChampions`, and a stored copy is a second source of
 * truth that can drift from the first.
 */
export function regionBonuses(state: GameState): RegionBonuses {
  const cleared = regionsCleared(state);
  return {
    cleared,
    exp: 1 + cleared * REGION_CLEAR_BONUS.exp,
    money: 1 + cleared * REGION_CLEAR_BONUS.money,
    catch: 1 + cleared * REGION_CLEAR_BONUS.catch,
  };
}
