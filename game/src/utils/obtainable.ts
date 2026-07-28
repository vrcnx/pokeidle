import { encounters } from "../data/encounters";
import { evolutions } from "../data/evolutions";
import { regions } from "../data/regions";
import { pokemonTable } from "../data/pokemon";
import { raidTiersOrdered } from "../data/raidLegendaries";

// Which species a player can actually OBTAIN right now.
//
// The Pokédex used to count every species in pokemonTable (288), but a chunk
// of the Johto entries were added for dex numbering without ever being given
// an encounter table — so they cannot be caught by any means. Players who had
// genuinely caught everything available were shown ~234/288 and told they were
// short, and the "Master" milestone sat above the reachable ceiling forever.
//
// This derives the reachable set from the data itself rather than hardcoding a
// number, so the moment an unreleased species is given encounters (or added to
// a raid tier) the dex total grows on its own — no second place to update.

function computeObtainable(): Set<string> {
  const seed = new Set<string>();

  // Anything that appears in a wild encounter table, anywhere.
  for (const loc of Object.values(encounters)) {
    for (const e of loc?.encounters ?? []) seed.add(e.speciesKey);
  }
  // Raid-only legendaries (pool is speciesKey -> weight).
  for (const tier of raidTiersOrdered) {
    for (const key of Object.keys(tier.pool ?? {})) seed.add(key);
  }
  // Every region's starters (gifted, never found in the wild).
  for (const region of Object.values(regions)) {
    for (const key of region.starters ?? []) seed.add(key);
  }

  // Close over evolutions: if you can obtain it, you can obtain what it
  // becomes. Iterate to a fixed point so 3-stage lines resolve fully.
  let grew = true;
  while (grew) {
    grew = false;
    for (const key of [...seed]) {
      for (const evo of evolutions[key] ?? []) {
        const into = (evo as { into?: string }).into;
        // Only count targets that actually exist in the dex data — a bad
        // evolution entry pointing at an unimplemented species shouldn't
        // inflate the total.
        if (into && pokemonTable[into] && !seed.has(into)) {
          seed.add(into);
          grew = true;
        }
      }
    }
  }

  // Never report a species the dex doesn't know about.
  for (const key of [...seed]) {
    if (!pokemonTable[key]) seed.delete(key);
  }
  return seed;
}

let cached: Set<string> | null = null;

/** Species obtainable through any implemented path. Computed once. */
export function obtainableSpecies(): Set<string> {
  if (!cached) cached = computeObtainable();
  return cached;
}

export function isObtainable(speciesKey: string): boolean {
  return obtainableSpecies().has(speciesKey);
}

/** The dex denominator: how many species can actually be caught. */
export function obtainableCount(): number {
  return obtainableSpecies().size;
}

/**
 * The dex numerator: how many of the player's registrations count toward
 * completion. Filters to the obtainable set and de-duplicates, so neither a
 * legacy duplicate entry nor a species that has since become unobtainable can
 * push a player "past" 100%.
 */
export function caughtObtainableCount(pokedexCaught: string[] | null | undefined): number {
  // Tolerates a missing/!Array value on purpose: this runs on the save-load
  // path, where a legacy or truncated cloud blob may not carry the field at
  // all, and throwing here would fail the boot rather than the feature.
  if (!Array.isArray(pokedexCaught)) return 0;
  const reachable = obtainableSpecies();
  const counted = new Set<string>();
  for (const key of pokedexCaught) {
    if (reachable.has(key)) counted.add(key);
  }
  return counted.size;
}

/**
 * THE definition of "completed the Pokédex": every species the game can
 * actually hand you is registered.
 *
 * Everything that gates on dex completion (the Shiny Charm, the full-dex
 * trophy, the Dex tab's top milestone) resolves through this instead of
 * carrying its own literal. Four different numbers used to be live at once —
 * 245 in the charm and the achievement, 288 in the ring and in Settings — so
 * the Settings panel could tell a player "44 left" for a charm that was about
 * to unlock on their next catch, and the "Master" milestone fired 43 species
 * before the completion ring reached 100%.
 */
export function isDexComplete(pokedexCaught: string[] | null | undefined): boolean {
  return caughtObtainableCount(pokedexCaught) >= obtainableCount();
}
