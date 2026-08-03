// Pokémon gender.
//
// ── WHY THIS FILE AND NOT A COLUMN IN pokemonTable ─────────────────
// The species table carries no gender data at all — no ratio, no genderless
// flag, nothing. Adding a per-species ratio would mean sourcing 900+ real
// values, and a table of made-up ratios is worse than no table: it looks
// authoritative and is wrong in a way nobody can see.
//
// So this encodes only what is CERTAIN and defaults the rest to an even
// split. The certain part is the set of species with a fixed answer, which
// is small, well known, and the part players actually notice — nobody
// complains that Pidgey skews 51/49, everybody notices a female Tauros.
//
// When real per-species ratios arrive, they replace ODDS below and nothing
// else in the app has to change.

export type Gender = "M" | "F" | null; // null = genderless

/** No gender at all. Legendaries, the Magnemite/Voltorb/Porygon lines, and
 *  the ones that reproduce by other means. */
const GENDERLESS = new Set<string>([
  "magnemite", "magneton", "magnezone",
  "voltorb", "electrode",
  "staryu", "starmie",
  "porygon", "porygon2", "porygonz",
  "ditto",
  "unown",
  "beldum", "metang", "metagross",
  "baltoy", "claydol",
  "bronzor", "bronzong",
  "rotom", "klink", "klang", "klinklang",
  "golett", "golurk",
  "carbink", "minior", "dhelmise",
  // Box legends and mythicals. Not exhaustive across every generation, but
  // the ones this game's raid tiers actually hand out.
  "articuno", "zapdos", "moltres", "mewtwo", "mew",
  "raikou", "entei", "suicune", "lugia", "hooh", "celebi",
  "regirock", "regice", "registeel", "latias", "latios",
  "kyogre", "groudon", "rayquaza", "jirachi", "deoxys",
  "uxie", "mesprit", "azelf", "dialga", "palkia", "heatran",
  "regigigas", "giratina", "cresselia", "phione", "manaphy",
  "darkrai", "shaymin", "arceus",
  "victini", "cobalion", "terrakion", "virizion", "tornadus",
  "thundurus", "reshiram", "zekrom", "landorus", "kyurem",
  "keldeo", "meloetta", "genesect",
]);

/** Always male. */
const ALWAYS_MALE = new Set<string>([
  "nidoranm", "nidorino", "nidoking",
  "hitmonlee", "hitmonchan", "hitmontop",
  "tauros", "tyrogue", "throh", "sawk", "rufflet", "braviary",
]);

/** Always female. */
const ALWAYS_FEMALE = new Set<string>([
  "nidoranf", "nidorina", "nidoqueen",
  "chansey", "blissey", "happiny",
  "kangaskhan", "jynx", "smoochum",
  "miltank", "illumise", "wormadam", "vespiquen",
  "cresselia", "petilil", "lilligant", "vullaby", "mandibuzz",
]);

/**
 * The odds a given species is male, 0..1. `null` means genderless.
 *
 * Only the certainties are encoded (see the note at the top). Everything
 * else is an even split, which is the real ratio for the large majority of
 * species and never claims more precision than this file has.
 */
export function maleOdds(speciesKey: string): number | null {
  const k = speciesKey.toLowerCase();
  if (GENDERLESS.has(k)) return null;
  if (ALWAYS_MALE.has(k)) return 1;
  if (ALWAYS_FEMALE.has(k)) return 0;
  return 0.5;
}

/**
 * A gender for a newly created Pokémon, derived from its IVs.
 *
 * ── WHY NOT Math.random() ──────────────────────────────────────────
 * Because it does not need to, and using it broke two unrelated tests. Any
 * extra draw inside createPokemon shifts the shared random stream, so a
 * seeded test that pins the SECOND Pokémon it builds starts failing for a
 * reason that has nothing to do with what it is testing. Re-pinning those
 * fixtures would have accommodated the change instead of avoiding the
 * problem — and left the same trap for the next person to add a roll.
 *
 * The IVs are already random and already unique to this Pokémon, so a hash
 * of them is a perfectly good coin. It is also faithful to how the real
 * games work: gender there is derived from a per-individual value, not
 * rolled separately.
 *
 * The consequence is that two Pokémon with byte-identical IVs share a
 * gender. That is invisible in play (a 1-in-31^6 collision that also has to
 * match species) and worth the determinism.
 */
export function genderFor(speciesKey: string, ivs: Record<string, number>): Gender {
  const odds = maleOdds(speciesKey);
  if (odds === null) return null;
  if (odds === 1) return "M";
  if (odds === 0) return "F";
  // Mix the six IVs so no single stat dominates the low bits — an unmixed
  // sum is 0..186 and biases hard toward the middle.
  let h = 0;
  for (const k of ["hp", "attack", "defense", "spAttack", "spDefense", "speed"]) {
    h = (h * 33 + (ivs[k] ?? 0)) | 0;
  }
  return (Math.abs(h) % 100) / 100 < odds ? "M" : "F";
}

/** For display. Genderless shows nothing rather than a placeholder — an
 *  absent symbol reads as "not applicable"; a "—" reads as "missing". */
export function genderSymbol(g: Gender | undefined): string {
  return g === "M" ? "♂" : g === "F" ? "♀" : "";
}
