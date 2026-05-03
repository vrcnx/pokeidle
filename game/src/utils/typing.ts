import { typeChart } from "../data/typeChart";
import type { PokemonType } from "../types";

// Damage multiplier for `attackType` against a defender with `defenderTypes`.
export function typeEffectiveness(
  attackType: PokemonType,
  defenderTypes: PokemonType[]
): number {
  let mult = 1;
  const row = typeChart[attackType] ?? {};
  for (const dt of defenderTypes) {
    const m = row[dt];
    if (m !== undefined) mult *= m;
  }
  return mult;
}

export function effectivenessLabel(mult: number): string {
  if (mult === 0) return "no effect";
  if (mult >= 2) return "super effective";
  if (mult <= 0.5) return "not very effective";
  return "";
}
