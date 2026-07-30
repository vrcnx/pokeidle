import type { GameState } from "../types";

/**
 * Auto-Heal — br_27cfd612ddd30485fc.
 *
 * A pure predicate rather than inline logic in useBattleLoop, because every
 * interesting thing about this feature is a case where it must NOT fire, and
 * those are only testable if they live somewhere the node test suite can reach.
 *
 * The dangerous one is the raid. HEAL_PARTY doubles as a panic button: it bails
 * out of a live battle, and if the player is in a raid it ENDS the raid and
 * stamps a cooldown on that tier. An auto-heal that fired during a raid would
 * silently burn a raid attempt and a cooldown the player never spent. So the
 * gate is idle-only and raid-never, and neither is negotiable.
 */

/** Party HP as a percentage of the party's total max HP. 100 when empty. */
export function partyHpPercent(party: GameState["party"]): number {
  let cur = 0;
  let max = 0;
  for (const p of party) {
    cur += Math.max(0, p.currentHp);
    max += Math.max(0, p.maxHp);
  }
  if (max <= 0) return 100;
  return (cur / max) * 100;
}

export function shouldAutoHeal(state: GameState): boolean {
  if (!state.autoHeal) return false;
  // Idle only. Anywhere else HEAL_PARTY is a retreat, not a heal.
  if (state.phase !== "idle") return false;
  // Never in a raid: HEAL_PARTY would end it and stamp the tier's cooldown.
  if (state.inRaid) return false;
  // A pending encounter/animation is still "in flight" even at phase idle.
  if (state.catchAnim || state.whiteoutAnim) return false;
  if (state.pendingEvents.length > 0) return false;
  if (state.evolutionState) return false;
  if (state.healingState) return false;
  if (state.party.length === 0) return false;
  // The all-fainted case belongs to the existing defensive heal in
  // useBattleLoop, which runs whether or not this setting is on. Claiming it
  // here too would have two dispatchers racing for the same transition.
  if (state.party.every((p) => p.currentHp <= 0)) return false;
  // A fainted member is always worth healing regardless of the percentage: a
  // five-mon party with one corpse can sit well above any sane threshold.
  if (state.party.some((p) => p.currentHp <= 0)) return true;
  return partyHpPercent(state.party) <= state.autoHealThreshold;
}
