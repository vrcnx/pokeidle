import { pokemonTable } from "../data/pokemon";
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
  };
}

export function toMove(moveId: string): Move {
  const def = movesTable[moveId];
  return { id: moveId, pp: def?.pp ?? 0, maxPp: def?.pp ?? 0 };
}

// Display label — falls back to species name when no nickname is set.
export function displayName(p: { nickname?: string; name: string }): string {
  return p.nickname ?? p.name;
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
