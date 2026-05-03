// Rarity tier from encounter rate %, matching the original game:
//   ≥20% common, ≥10% uncommon, ≥5% rare, ≥1% very_rare, <1% ultra_rare
export type Rarity = "common" | "uncommon" | "rare" | "very_rare" | "ultra_rare";

export function rarityFromRate(ratePct: number): Rarity {
  if (ratePct >= 20) return "common";
  if (ratePct >= 10) return "uncommon";
  if (ratePct >= 5) return "rare";
  if (ratePct >= 1) return "very_rare";
  return "ultra_rare";
}

export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  very_rare: "Very Rare",
  ultra_rare: "Ultra Rare",
};

export const RARITY_COLOR: Record<Rarity, string> = {
  common:     "#9aa6b6",
  uncommon:   "#5fa830",
  rare:       "#3a7ce0",
  very_rare:  "#a84cd4",
  ultra_rare: "#e8a224",
};

// Compute % rate of each species at a route (sum of weights = 100%).
export function rateForSpecies(
  speciesKey: string,
  encounters: { speciesKey: string; weight: number }[]
): number {
  const total = encounters.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return 0;
  const e = encounters.find((x) => x.speciesKey === speciesKey);
  return e ? (e.weight / total) * 100 : 0;
}
