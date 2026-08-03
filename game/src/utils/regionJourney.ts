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
