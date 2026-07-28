import { evolutions } from "../data/evolutions";
import { pokemonTable } from "../data/pokemon";
import type {
  EvolutionStatCondition,
  EvolutionStatKey,
  EvolutionTrigger,
  Pokemon,
} from "../types";

// ONE place that knows how a branching evolution is decided.
//
// Level evolutions are dispatched from five separate entry points (the party
// row context menu, the detail modal, the auto-evolve hook, the stream
// auto-player, and the reducer itself). Before branch predicates existed each
// of those just took the FIRST level trigger it found, which is why adding a
// second trigger to a species would have been dead code. Everything now goes
// through the helpers here so a branch is decided by the Pokémon's stats,
// identically, no matter who asked.

/** The level-threshold member of the trigger union. */
export type LevelEvolutionTrigger = Extract<EvolutionTrigger, { level: number }>;

/** A pure level evolution — not a stone, not a trade catalyst. */
export function isLevelTrigger(t: EvolutionTrigger): t is LevelEvolutionTrigger {
  return "level" in t && !("item" in t) && !("trade" in t);
}

const STAT_LABEL: Record<EvolutionStatKey, string> = {
  hp: "HP",
  attack: "Attack",
  defense: "Defense",
  spAttack: "Sp. Atk",
  spDefense: "Sp. Def",
  speed: "Speed",
};

const OP_SYMBOL: Record<EvolutionStatCondition["op"], string> = {
  gt: ">",
  lt: "<",
  eq: "=",
};

// The live stat, i.e. after IVs, EVs and nature — the same number the player
// reads on the Pokémon's own stat panel, so "Attack > Defense" means what it
// looks like it means. HP is stored as maxHp on Pokemon rather than `hp`.
function statValue(p: Pokemon, key: EvolutionStatKey): number {
  return key === "hp" ? p.maxHp : p[key];
}

/** Absent predicate = unconditional, which is what every pre-existing entry is. */
export function statConditionMet(p: Pokemon, when?: EvolutionStatCondition): boolean {
  if (!when) return true;
  const [left, right] = when.compare;
  const a = statValue(p, left);
  const b = statValue(p, right);
  switch (when.op) {
    case "gt": return a > b;
    case "lt": return a < b;
    case "eq": return a === b;
  }
}

/**
 * "Attack = Defense (23 vs 23)" — shown verbatim in the detail modal so the
 * player can see which branch this individual is on, and why, BEFORE hitting
 * Evolve. Without it a three-way split is indistinguishable from a bug.
 */
export function describeStatCondition(p: Pokemon, when: EvolutionStatCondition): string {
  const [left, right] = when.compare;
  return `${STAT_LABEL[left]} ${OP_SYMBOL[when.op]} ${STAT_LABEL[right]} (${statValue(p, left)} vs ${statValue(p, right)})`;
}

/**
 * The level evolution this Pokémon has earned RIGHT NOW — level threshold met
 * and branch predicate satisfied — or null. Also refuses targets missing from
 * `pokemonTable`, matching the guard every caller already had, so nothing is
 * ever offered that COMPLETE_EVOLUTION would have to bail out of.
 */
export function levelEvolutionFor(p: Pokemon): LevelEvolutionTrigger | null {
  for (const t of evolutions[p.speciesKey] ?? []) {
    if (!isLevelTrigger(t)) continue;
    if (p.level < t.level) continue;
    if (!statConditionMet(p, t.when)) continue;
    if (!pokemonTable[t.into]) continue;
    return t;
  }
  return null;
}

/** Every level target of this species, regardless of eligibility (for UI hints). */
export function levelEvolutionTargets(speciesKey: string): LevelEvolutionTrigger[] {
  return (evolutions[speciesKey] ?? []).filter(isLevelTrigger);
}

/**
 * Is this Pokémon's evolve lock set?
 *
 * The lock stops the AUTOMATIC path (hooks/useAutoEvolve) and nothing else. A
 * click on Evolve, a stone, a Link Cable and a trade all still work: those are
 * the player asking for this Pokémon, right now, and a standing "leave it
 * alone" preference has no business overruling a direct instruction.
 *
 * Written as a predicate rather than read inline so that distinction is stated
 * once, and so `undefined` (every save that predates the field) is definitively
 * "not locked" everywhere.
 */
export function evolutionLocked(p: Pokemon): boolean {
  return p.noEvolve === true;
}

/** One branch of a split level evolution, described against a live Pokémon. */
export interface LevelBranch {
  into: string;
  /** `describeStatCondition` output — the rule AND this individual's numbers. */
  requirement: string;
  /** True for the single branch this individual is on right now. */
  met: boolean;
}

/**
 * Every branch of this Pokémon's level evolution, with what each one needs and
 * which one it is currently on. Empty for anything that does not actually
 * split, so a caller can render it unconditionally and get nothing for the
 * ~90 single-target level evolutions that have nothing to explain.
 *
 * This exists because auto-evolve fires the instant the threshold is reached,
 * which for Tyrogue is the moment the outcome stops being changeable. The
 * player should be able to see the comparison that decided it — before, during
 * and after — so a three-way split never reads as a coin flip. It is pure
 * composition over `levelEvolutionTargets` / `describeStatCondition` /
 * `statConditionMet`; nothing here re-implements the branch rules.
 */
export function levelEvolutionBranches(p: Pokemon): LevelBranch[] {
  const branching = levelEvolutionTargets(p.speciesKey).filter((t) => t.when);
  if (branching.length < 2) return [];
  return branching.map((t) => ({
    into: t.into,
    requirement: describeStatCondition(p, t.when!),
    met: statConditionMet(p, t.when),
  }));
}

/**
 * Canonicalise a requested evolution target against the Pokémon's own stats.
 *
 * Callers name a target; some of them (notably the stream auto-player, which
 * scans for the first satisfied level trigger and cannot be taught about
 * predicates) can name a SIBLING branch that this particular Pokémon does not
 * qualify for. Rejecting would strand the mon un-evolved forever, so instead
 * we re-resolve to the sibling it does qualify for: the branch is decided by
 * the Pokémon, never by the caller.
 *
 * Untouched for every non-branching trigger — an unconditional target, a stone
 * target, or a species with no such trigger comes back exactly as passed in.
 */
export function resolveEvolutionTarget(p: Pokemon, requestedInto: string): string {
  const requested = (evolutions[p.speciesKey] ?? []).find((t) => t.into === requestedInto);
  if (!requested || !isLevelTrigger(requested) || !requested.when) return requestedInto;
  if (statConditionMet(p, requested.when)) return requestedInto;
  return levelEvolutionFor(p)?.into ?? requestedInto;
}
