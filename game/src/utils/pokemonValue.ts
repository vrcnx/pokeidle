import { pokemonTable } from "../data/pokemon";
import type { Pokemon } from "../types";

// What a Pokémon is worth, as a suggestion.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────
// A seller opening the auction house has no idea what to ask. The result is
// a market where a 90% IV shiny goes for 5,000 because its owner guessed
// low, and an ordinary Rattata sits at 500,000 because its owner guessed
// high. Neither is a pricing problem — both are an INFORMATION problem, and
// a number on the screen fixes more of it than any amount of balancing.
//
// ── WHAT IT IS NOT ──────────────────────────────────────────────────
// Not a price floor, not a cap, and not enforced anywhere. Players may list
// at whatever they like; this only suggests, and the UI says "suggested".
// A market where the game sets the price is not a market.
//
// ── WHY IT IS TRANSPARENT ───────────────────────────────────────────
// It returns its own reasoning — every multiplier, named. A suggested price
// a player cannot interrogate is a number they will assume is rigged the
// first time it disagrees with them. `explain()` turns that into a list they
// can read: "shiny x12, IVs 94% x2.4".

export interface Valuation {
  /** The suggestion, in currency. */
  value: number;
  /** Every factor that moved it, in the order applied. */
  factors: { label: string; multiplier: number }[];
}

/** Baseline for an ordinary level-1 Pokémon of an unremarkable species. */
const BASE = 800;

/** Six stats at 31. */
const IV_MAX_TOTAL = 31 * 6;

/**
 * How hard a species is to get, from its own base stat total.
 *
 * A proxy, and deliberately a crude one: the alternative is a hand-kept
 * rarity table for 900+ species that goes stale the moment an encounter
 * table changes. BST is already in the data, already correlates with
 * legendaries and fully-evolved forms, and is never wrong in an
 * embarrassing direction — nothing cheap has a 700 BST.
 */
function speciesFactor(speciesKey: string): number {
  const sp = pokemonTable[speciesKey];
  if (!sp) return 1;
  const bst =
    sp.baseStats.hp + sp.baseStats.attack + sp.baseStats.defense +
    sp.baseStats.spAttack + sp.baseStats.spDefense + sp.baseStats.speed;
  // 300 BST (a Caterpie) -> ~0.6; 600 (a starter's final form) -> ~2.4;
  // 680 (a box legend) -> ~3.2.
  return Math.max(0.5, Math.min(4, (bst / 300) ** 1.6 / 1.4));
}

export function ivTotalOf(p: Pokemon): number {
  const iv = p.ivs;
  if (!iv) return 0;
  return iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed;
}

export function valuePokemon(p: Pokemon): Valuation {
  const factors: { label: string; multiplier: number }[] = [];
  const push = (label: string, multiplier: number) => {
    // Only record what actually moved the number. A list of "x1.00" rows is
    // noise that makes the real factors harder to find.
    if (Math.abs(multiplier - 1) > 0.001) factors.push({ label, multiplier });
  };

  const species = speciesFactor(p.speciesKey);
  push(pokemonTable[p.speciesKey]?.name ?? p.speciesKey, species);

  // Shiny is the single biggest multiplier by a distance, and it should be:
  // it is a 1-in-4096 event that no amount of play reliably produces.
  const shiny = p.isShiny ? 12 : 1;
  push("Shiny", shiny);

  // IVs, as a curve rather than a line. The difference between 50% and 60%
  // is nearly nothing to a player; between 90% and 100% it is the whole
  // reason to buy. A linear scale prices those the same distance apart.
  const ivPct = ivTotalOf(p) / IV_MAX_TOTAL;
  const iv = 0.6 + 2.4 * ivPct ** 3;
  push(`IVs ${Math.round(ivPct * 100)}%`, iv);

  // Level matters, but far less than the two above — levels are the one
  // thing a buyer can add themselves just by playing.
  const level = 0.8 + (p.level / 100) * 0.6;
  push(`Lv ${p.level}`, level);

  const raw = BASE * species * shiny * iv * level;
  // Round to something a person would type. An auction suggested at 43,718
  // reads as a machine's answer; 44,000 reads as a price.
  const value = roundToNice(raw);
  return { value, factors };
}

/** Round to 2 significant-ish figures, so suggestions look like prices. */
export function roundToNice(n: number): number {
  if (n < 100) return Math.max(10, Math.round(n / 10) * 10);
  const mag = 10 ** Math.floor(Math.log10(n) - 1);
  return Math.round(n / mag) * mag;
}

/** One line per factor, for a tooltip or a hint under the field. */
export function explain(v: Valuation): string[] {
  return v.factors.map((f) => `${f.label} ×${f.multiplier.toFixed(2)}`);
}

/**
 * The suggested OPENING bid — deliberately below the valuation.
 *
 * An auction that opens at what the thing is worth has no room to run, and
 * the seller carries all the risk of a wrong guess. Opening at 60% lets the
 * bidding find the number, which is the entire point of an auction.
 */
export function suggestedStartingBid(p: Pokemon): number {
  return roundToNice(valuePokemon(p).value * 0.6);
}
