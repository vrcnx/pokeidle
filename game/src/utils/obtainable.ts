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
