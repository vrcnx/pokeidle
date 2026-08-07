import { pokemonTable } from "../data/pokemon";
import { genderFor } from "../data/gender";
import type { Move, Pokemon, Stats } from "../types";
import { calcAllStats, expForLevel, randomIVs } from "./stats";
import { defaultMoves } from "./moves";
import { moves as movesTable } from "../data/moves";
import { randomNature } from "../data/natures";
import { pickAbility } from "../data/abilities";

export const ZERO_EVS: Stats = {
  hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0,
};

export function createPokemon(
  speciesKey: string,
  level: number,
  nextId: number,
  isShiny = false
): Pokemon {
  const species = pokemonTable[speciesKey];
  if (!species) throw new Error(`unknown species: ${speciesKey}`);
  const ivs = randomIVs();
  const evs: Stats = { ...ZERO_EVS };
  const nature = randomNature().name;
  const stats = calcAllStats(species, level, ivs, evs, nature);
  const moveset = defaultMoves(speciesKey, level).map(toMove);
  const ability = pickAbility(speciesKey) ?? undefined;
  const gender = genderFor(speciesKey, ivs as unknown as Record<string, number>);
  return {
    id: String(nextId),
    speciesKey,
    name: species.name,
    nature,
    level,
    totalExp: expForLevel(level, species.growthRate),
    moves: moveset,
    currentHp: stats.hp,
    maxHp: stats.hp,
    attack: stats.attack,
    defense: stats.defense,
    spAttack: stats.spAttack,
    spDefense: stats.spDefense,
    speed: stats.speed,
    ivs,
    evs,
    isShiny,
    ability,
    gender,
  };
}

export function toMove(moveId: string): Move {
  const def = movesTable[moveId];
  return { id: moveId, pp: def?.pp ?? 0, maxPp: def?.pp ?? 0 };
}

// Display label — falls back to species name when no nickname is set.
/**
 * Species the player is HOLDING right now, which is a different question
 * from what the Pokédex has registered. Registration is permanent —
 * releasing, trading away or evolving a Pokémon never un-registers the
 * species — so a dex that only knows "caught" cannot tell "I have one of
 * these" from "I had one once".
 *
 * Party + PC only. A Pokémon sitting in auction escrow is deliberately not
 * counted: it is out of the player's hands until the auction settles, and
 * claiming otherwise would be the same kind of half-truth this exists to
 * fix.
 */
export function ownedSpecies(party: Pokemon[], box: Pokemon[]): Set<string> {
  const owned = new Set<string>();
  for (const p of party) owned.add(p.speciesKey);
  for (const p of box) owned.add(p.speciesKey);
  return owned;
}

/**
 * Single-species form of {@link ownedSpecies}. A full PC holds up to 9,999
 * Pokémon, so a caller that only asks about one species shouldn't build a
 * set of every species it owns to answer it — this short-circuits on the
 * first match instead.
 */
export function ownsSpecies(party: Pokemon[], box: Pokemon[], speciesKey: string): boolean {
  return party.some((p) => p.speciesKey === speciesKey)
    || box.some((p) => p.speciesKey === speciesKey);
}

/**
 * What to call this Pokémon in the UI: its nickname if it has one, otherwise
 * its species name.
 *
 * Trims and falls back on BLANK, not just on null/undefined. `??` alone lets
 * an empty or all-whitespace nickname through, and the result is a Pokémon
 * with no name at all in the party row, the HP card and the battle text. Two
 * shapes reach here that `??` would not catch: a `""` written by any save
 * predating SET_NICKNAME's sanitize step, and the `nickname: string | null`
 * that arrives over the trade wire (state/trade.ts).
 *
 * The truthiness check is also what NicknameField already did inline; this is
 * the same rule in the one place every caller shares.
 */
export function displayName(p: { nickname?: string | null; name: string }): string {
  const nick = p.nickname?.trim();
  return nick ? nick : p.name;
}

/**
 * The ball a Pokemon was caught in, for display.
 *
 * ── WHY THE DEFAULT LIVES HERE AND NOT IN THE SAVE ──────────────────
 * `caughtBall` is absent on everything caught before the field existed, and
 * on everything that was never caught at all — starters, gifts, trades,
 * giveaway prizes. Both show a Poké Ball, which is the answer the mainline
 * games give as well: a gift Pokemon arrives in one.
 *
 * It is resolved on READ, every time, and nothing ever writes the guess into
 * a save. A migration stamping "pokeball" onto a few hundred thousand existing
 * Pokemon would be quick and would be a lie told permanently: it turns "we do
 * not know" into "we know it was a Poké Ball", with no way afterwards to tell
 * a recorded ball from an invented one. Someone who spent a Master Ball on a
 * legendary before today would be reading a record that contradicts them.
 *
 * Resolving on read costs one `??` at the one place that displays it, keeps
 * the save honest, and means changing this decision later is changing this
 * function.
 */
export function caughtBallOf(p: { caughtBall?: string }): string {
  return p.caughtBall ?? "pokeball";
}

// Base shiny rate is 1/8192 (Gen V). With the Shiny Charm — granted for
// completing the Pokédex — the rate doubles to 1/4096.
//
// `hasShinyCharm` used to live here as a hardcoded `pokedexCaught.length >= 245`
// check. It now reads whether the player HOLDS the charm item; see
// utils/shinyCharm.ts for why that moved and how the threshold is derived.
export function rollShiny(hasShinyCharm: boolean): boolean {
  const denom = hasShinyCharm ? 4096 : 8192;
  return Math.random() * denom < 1;
}
