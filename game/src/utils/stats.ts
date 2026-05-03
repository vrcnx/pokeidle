import type { GrowthRate, IVs, PokemonSpecies, Stats } from "../types";
import { findNature, natureMultiplier, type Nature, type StatKey } from "../data/natures";

// Gen 3+ stat formula (the standard one used since Ruby/Sapphire):
//   HP   = floor((2·base + IV + floor(EV/4)) · level / 100) + level + 10
//   stat = floor(floor((2·base + IV + floor(EV/4)) · level / 100) + 5) · nature
// Nature multiplies the final non-HP stat by 0.9 / 1.0 / 1.1.

export function calcHpStat(base: number, level: number, iv: number, ev = 0): number {
  return (
    Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) +
    level +
    10
  );
}

export function calcStat(
  base: number,
  level: number,
  iv: number,
  ev = 0,
  natureMult = 1
): number {
  return Math.floor(
    (Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * natureMult
  );
}

export function calcAllStats(
  species: PokemonSpecies,
  level: number,
  ivs: IVs,
  evs?: Stats,
  natureName?: string
): Stats {
  const nature: Nature | undefined = natureName ? findNature(natureName) : undefined;
  const m = (k: StatKey) => (nature ? natureMultiplier(nature, k) : 1);
  const ev = evs ?? { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  return {
    hp:        calcHpStat(species.baseStats.hp,        level, ivs.hp,        ev.hp),
    attack:    calcStat(species.baseStats.attack,      level, ivs.attack,    ev.attack,    m("attack")),
    defense:   calcStat(species.baseStats.defense,     level, ivs.defense,   ev.defense,   m("defense")),
    spAttack:  calcStat(species.baseStats.spAttack,    level, ivs.spAttack,  ev.spAttack,  m("spAttack")),
    spDefense: calcStat(species.baseStats.spDefense,   level, ivs.spDefense, ev.spDefense, m("spDefense")),
    speed:     calcStat(species.baseStats.speed,       level, ivs.speed,     ev.speed,     m("speed")),
  };
}

export function randomIVs(): IVs {
  return {
    hp: Math.floor(Math.random() * 32),
    attack: Math.floor(Math.random() * 32),
    defense: Math.floor(Math.random() * 32),
    spAttack: Math.floor(Math.random() * 32),
    spDefense: Math.floor(Math.random() * 32),
    speed: Math.floor(Math.random() * 32),
  };
}

export function perfectIVs(): IVs {
  return { hp: 31, attack: 31, defense: 31, spAttack: 31, spDefense: 31, speed: 31 };
}

// Total EXP required to reach a given level on each growth curve.
// Formulas match Bulbapedia / canonical Gen-3+ values:
//   fast       = 4n³/5
//   mediumFast = n³
//   mediumSlow = 6n³/5 − 15n² + 100n − 140  (negative below level ~4; clamped to 0)
//   slow       = 5n³/4
//   erratic    = piecewise (Caterpie line and a few legendaries)
//   fluctuating= piecewise (rare; e.g. Magikarp historically)
// `expForLevel(100)` should give: fast=800000, mediumFast=1000000,
// mediumSlow=1059860, slow=1250000, erratic=600000, fluctuating=1640000.
export function expForLevel(level: number, growthRate: GrowthRate): number {
  if (level <= 1) return 0;
  const n = level;
  const cube = n * n * n;
  let exp: number;
  switch (growthRate) {
    case "fast":
      exp = (4 * cube) / 5;
      break;
    case "mediumFast":
      exp = cube;
      break;
    case "mediumSlow":
      exp = (6 / 5) * cube - 15 * n * n + 100 * n - 140;
      break;
    case "slow":
      exp = (5 * cube) / 4;
      break;
    case "erratic":
      if (n <= 50) exp = (cube * (100 - n)) / 50;
      else if (n <= 68) exp = (cube * (150 - n)) / 100;
      else if (n <= 98) exp = (cube * Math.floor((1911 - 10 * n) / 3)) / 500;
      else exp = (cube * (160 - n)) / 100;
      break;
    case "fluctuating":
      if (n <= 15) exp = cube * ((Math.floor((n + 1) / 3) + 24) / 50);
      else if (n <= 36) exp = cube * ((n + 14) / 50);
      else exp = cube * ((Math.floor(n / 2) + 32) / 50);
      break;
    default:
      exp = cube; // unknown growth rate → mediumFast as a safe default
  }
  return Math.max(0, Math.floor(exp));
}

export function expYield(species: PokemonSpecies, level: number): number {
  return Math.floor((species.baseExpYield * level) / 7);
}
