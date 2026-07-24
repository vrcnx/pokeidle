import { pokemonTable } from "../data/pokemon";
import { encounters } from "../data/encounters";
import { evolutions } from "../data/evolutions";
import type { GameState, Pokemon } from "../types";

// Team selection for the autonomous stream account.
//
// Left to itself the account keeps whatever it happened to catch first, so the
// party fills with Rattatas while a Dragonair sits forgotten in the PC. This
// scores every Pokémon it owns and keeps the best six in the party, which is
// both stronger (it stops losing gyms) and far better television.
//
// Score blends four things a viewer would also judge a mon on:
//   * raw power        — base stat total, the single biggest factor
//   * investment       — its level, so we don't bench a trained mon for a
//                        freshly caught one that is merely rarer
//   * rarity           — how uncommon it is in the wild (a species that
//                        appears nowhere in any encounter table is a
//                        legendary/raid catch and scores highest)
//   * room to grow     — fully evolved mons are worth more than a stage-1
//                        that is about to be outclassed
// Shinies get a deliberate bonus: they are the moments people clip.

/** Rarest wild weight per species; absent = never appears in the wild. */
const wildRarity: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (const loc of Object.values(encounters)) {
    for (const e of loc?.encounters ?? []) {
      const prev = m.get(e.speciesKey);
      if (prev == null || e.weight < prev) m.set(e.speciesKey, e.weight);
    }
  }
  return m;
})();

function baseStatTotal(speciesKey: string): number {
  const b = pokemonTable[speciesKey]?.baseStats;
  if (!b) return 0;
  return b.hp + b.attack + b.defense + b.spAttack + b.spDefense + b.speed;
}

/** 0 when the species still evolves, 1 when it's the end of its line. */
function isFullyEvolved(speciesKey: string): number {
  return (evolutions[speciesKey]?.length ?? 0) === 0 ? 1 : 0;
}

function rarityBonus(speciesKey: string): number {
  const w = wildRarity.get(speciesKey);
  // Never found in the wild → a raid legendary or a starter. Top billing.
  if (w == null) return 220;
  // Wild weights run ~1 (very rare) to ~28 (everywhere).
  return Math.max(0, Math.round((30 - w) * 6));
}

export function scoreMon(p: Pokemon): number {
  return (
    baseStatTotal(p.speciesKey) * 1.0 +
    p.level * 7 +
    rarityBonus(p.speciesKey) +
    isFullyEvolved(p.speciesKey) * 90 +
    (p.isShiny ? 260 : 0)
  );
}

export interface TeamSwap { partyIndex: number; boxIndex: number; reason: string }

/**
 * The single most valuable party↔PC swap available, or null when the party is
 * already the best six. One swap at a time keeps the change legible on stream
 * and avoids thrashing the save.
 *
 * `margin` is hysteresis: a box mon must be meaningfully better than the party
 * mon it would replace, otherwise two similar mons would trade places forever.
 */
export function bestTeamSwap(state: GameState, margin = 60): TeamSwap | null {
  if (state.party.length === 0 || state.box.length === 0) return null;

  let worstPartyIdx = -1;
  let worstPartyScore = Infinity;
  state.party.forEach((p, i) => {
    // Never bench the mon that's currently out — swapping the active fighter
    // mid-stream is jarring and can drop the battle.
    if (i === state.activePlayerPokemonIndex) return;
    const s = scoreMon(p);
    if (s < worstPartyScore) { worstPartyScore = s; worstPartyIdx = i; }
  });
  if (worstPartyIdx === -1) return null;

  let bestBoxIdx = -1;
  let bestBoxScore = -Infinity;
  state.box.forEach((p, i) => {
    const s = scoreMon(p);
    if (s > bestBoxScore) { bestBoxScore = s; bestBoxIdx = i; }
  });
  if (bestBoxIdx === -1) return null;

  if (bestBoxScore <= worstPartyScore + margin) return null;
  return {
    partyIndex: worstPartyIdx,
    boxIndex: bestBoxIdx,
    reason: `${state.box[bestBoxIdx].name} (${Math.round(bestBoxScore)}) replaces ${state.party[worstPartyIdx].name} (${Math.round(worstPartyScore)})`,
  };
}

/**
 * Which party slot should be out front. Prefers a healthy mon that is BEHIND
 * the party's best level — that's how the team levels evenly instead of one
 * carry running away with every EXP drop while the rest stay useless.
 * Falls back to the strongest healthy mon when everything is level.
 */
export function bestLeadIndex(state: GameState, underLevelGap = 3): number {
  const healthy = state.party
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.currentHp > 0);
  if (healthy.length === 0) return -1;
  const topLevel = healthy.reduce((m, { p }) => Math.max(m, p.level), 0);

  // Anyone lagging the leader by more than the gap gets trained up first.
  const laggards = healthy.filter(({ p }) => topLevel - p.level > underLevelGap);
  if (laggards.length > 0) {
    // Train the strongest laggard — it survives longest and catches up fastest.
    return laggards.reduce((a, b) => (scoreMon(b.p) > scoreMon(a.p) ? b : a)).i;
  }
  return healthy.reduce((a, b) => (scoreMon(b.p) > scoreMon(a.p) ? b : a)).i;
}
