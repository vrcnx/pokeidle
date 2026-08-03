import { levelUpMoves } from "../data/levelUpMoves";
import { evolutions } from "../data/evolutions";
import { expForLevel } from "./stats";
import { ownedMachinesForSpecies } from "./machines";
import type { GrowthRate } from "../types";

// Reverse-evolution lookup: { ivysaur: "bulbasaur", venusaur: "ivysaur", ... }
const preEvolution: Record<string, string> = Object.fromEntries(
  Object.entries(evolutions).flatMap(([from, triggers]) =>
    triggers.map((t) => [t.into, from])
  )
);

export function evolutionChain(speciesKey: string): string[] {
  const chain: string[] = [speciesKey];
  let cur: string | undefined = speciesKey;
  while (preEvolution[cur]) {
    cur = preEvolution[cur];
    chain.unshift(cur);
  }
  return chain;
}

export function preEvolutionOf(speciesKey: string): string | undefined {
  return preEvolution[speciesKey];
}

export interface LearnedMove {
  moveId: string;
  learnLevel: number;
  fromSpecies: string;
}

export function learnableMovesUpToLevel(speciesKey: string, level: number): LearnedMove[] {
  const chain = evolutionChain(speciesKey);
  const seen = new Set<string>();
  const out: LearnedMove[] = [];
  for (const sp of chain) {
    const list = levelUpMoves[sp] || [];
    for (const [lvl, moveId] of list) {
      if (lvl <= level && !seen.has(moveId)) {
        seen.add(moveId);
        out.push({ moveId, learnLevel: lvl, fromSpecies: sp });
      }
    }
  }
  return out;
}

/**
 * Everything a Pokémon could have in a slot right now, from both places a
 * move can come from.
 *
 * The two sources are deliberately kept distinguishable rather than flattened
 * to a list of ids. "Where did this come from" is the question the move
 * dialog exists to answer once TMs are in play: a level-up move is free and
 * permanent, a machine move lasts exactly as long as you hold the machine.
 * A player deciding between them needs to see which is which.
 */
export interface AvailableMove {
  moveId: string;
  source: "level" | "machine";
  /** Level it was learned at — level-up moves only. */
  learnLevel?: number;
  /** Which species in the evolution chain taught it — level-up moves only. */
  fromSpecies?: string;
  /** e.g. "TM24" — machine moves only. */
  machineLabel?: string;
  machineId?: string;
}

export function availableMovesFor(
  speciesKey: string,
  level: number,
  inventory: Record<string, number>,
): AvailableMove[] {
  const out: AvailableMove[] = [];
  const seen = new Set<string>();
  for (const lm of learnableMovesUpToLevel(speciesKey, level)) {
    seen.add(lm.moveId);
    out.push({
      moveId: lm.moveId,
      source: "level",
      learnLevel: lm.learnLevel,
      fromSpecies: lm.fromSpecies,
    });
  }
  // A move on both lists stays a LEVEL move. Owning TM24 shouldn't relabel a
  // Thunderbolt the Pokémon already learned the hard way — and it must not
  // vanish from the pool the day the machine is sold or traded away.
  for (const m of ownedMachinesForSpecies(speciesKey, inventory)) {
    if (seen.has(m.moveId)) continue;
    seen.add(m.moveId);
    out.push({
      moveId: m.moveId,
      source: "machine",
      machineLabel: m.label,
      machineId: m.id,
    });
  }
  return out;
}

// Default moveset: last 4 moves the species learns by `level`.
export function defaultMoves(speciesKey: string, level: number): string[] {
  return (levelUpMoves[speciesKey] || [])
    .filter(([lvl]) => lvl <= level)
    .map(([, id]) => id)
    .slice(-4);
}

export function levelUpsForExp(
  speciesKey: string,
  growthRate: GrowthRate,
  fromLevel: number,
  totalExp: number
): { newLevel: number; newMoves: string[] }[] {
  const out: { newLevel: number; newMoves: string[] }[] = [];
  let lvl = fromLevel;
  while (lvl < 100) {
    const need = expForLevel(lvl + 1, growthRate);
    if (totalExp >= need) {
      lvl++;
      const newMoves = (levelUpMoves[speciesKey] || [])
        .filter(([l]) => l === lvl)
        .map(([, id]) => id);
      out.push({ newLevel: lvl, newMoves });
    } else break;
  }
  return out;
}
