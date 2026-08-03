// All 25 Pokemon natures. Each (except neutrals) boosts one stat by 10% and
// reduces another by 10%. HP is never modified by nature.
//   plus  → +10% to this stat
//   minus → -10% to this stat
// Neutral natures (Hardy/Docile/Bashful/Quirky/Serious) have plus===minus.

export type StatKey = "attack" | "defense" | "spAttack" | "spDefense" | "speed";

export interface Nature {
  name: string;
  plus: StatKey;
  minus: StatKey;
}

export const natures: Nature[] = [
  // Attack-boosting
  { name: "Hardy",   plus: "attack",    minus: "attack"    },
  { name: "Lonely",  plus: "attack",    minus: "defense"   },
  { name: "Brave",   plus: "attack",    minus: "speed"     },
  { name: "Adamant", plus: "attack",    minus: "spAttack"  },
  { name: "Naughty", plus: "attack",    minus: "spDefense" },
  // Defense-boosting
  { name: "Bold",    plus: "defense",   minus: "attack"    },
  { name: "Docile",  plus: "defense",   minus: "defense"   },
  { name: "Relaxed", plus: "defense",   minus: "speed"     },
  { name: "Impish",  plus: "defense",   minus: "spAttack"  },
  { name: "Lax",     plus: "defense",   minus: "spDefense" },
  // Speed-boosting
  { name: "Timid",   plus: "speed",     minus: "attack"    },
  { name: "Hasty",   plus: "speed",     minus: "defense"   },
  { name: "Serious", plus: "speed",     minus: "speed"     },
  { name: "Jolly",   plus: "speed",     minus: "spAttack"  },
  { name: "Naive",   plus: "speed",     minus: "spDefense" },
  // Sp. Attack-boosting
  { name: "Modest",  plus: "spAttack",  minus: "attack"    },
  { name: "Mild",    plus: "spAttack",  minus: "defense"   },
  { name: "Quiet",   plus: "spAttack",  minus: "speed"     },
  { name: "Bashful", plus: "spAttack",  minus: "spAttack"  },
  { name: "Rash",    plus: "spAttack",  minus: "spDefense" },
  // Sp. Defense-boosting
  { name: "Calm",    plus: "spDefense", minus: "attack"    },
  { name: "Gentle",  plus: "spDefense", minus: "defense"   },
  { name: "Sassy",   plus: "spDefense", minus: "speed"     },
  { name: "Careful", plus: "spDefense", minus: "spAttack"  },
  { name: "Quirky",  plus: "spDefense", minus: "spDefense" },
];

export function randomNature(): Nature {
  return natures[Math.floor(Math.random() * natures.length)];
}

export function natureMultiplier(nature: Nature, stat: StatKey): number {
  if (nature.plus === nature.minus) return 1;          // neutral
  if (nature.plus === stat) return 1.1;
  if (nature.minus === stat) return 0.9;
  return 1;
}

export function findNature(name: string): Nature | undefined {
  return natures.find((n) => n.name === name);
}

/** Just the names, for anything that needs to offer a choice of nature —
 *  the auto-catch filter, today. Derived from the table so a nature can
 *  never exist in the game and be missing from the picker. */
export const NATURE_NAMES: string[] = natures.map((n) => n.name);
