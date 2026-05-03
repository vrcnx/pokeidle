import { levelUpMoves } from "../data/levelUpMoves";
import { evolutions } from "../data/evolutions";
import { expForLevel } from "./stats";
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
