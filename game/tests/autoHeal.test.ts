// Auto-Heal — br_27cfd612ddd30485fc.
//
// Almost everything interesting about this feature is a case where it must NOT
// fire, which is why the predicate lives in utils/autoHeal.ts instead of inline
// in useBattleLoop (the game suite has no DOM and cannot run the hook).
//
// The dangerous case is the raid: HEAL_PARTY doubles as a panic button that
// retreats from a battle, and in a raid it ENDS the raid and stamps that tier's
// cooldown. An auto-heal firing there would silently burn a raid attempt and a
// cooldown the player never chose to spend.

import { describe, expect, it } from "vitest";
import { partyHpPercent, shouldAutoHeal } from "../src/utils/autoHeal";
import { reducer } from "../src/state/reducer";
import { initialState } from "../src/state/initialState";
import type { GameState, Pokemon } from "../src/types";
import { makeMon, makeState } from "./helpers";

/** An idle state with auto-heal ON and a party at the given HP values. */
function healState(hps: number[], over: Partial<GameState> = {}): GameState {
  const party: Pokemon[] = hps.map((hp, i) =>
    makeMon({ id: `p${i}`, currentHp: hp, maxHp: 100 }),
  );
  return makeState({
    party,
    playerPokemon: party[0],
    phase: "idle",
    autoHeal: true,
    autoHealThreshold: 35,
    ...over,
  });
}

describe("partyHpPercent", () => {
  it("is the party total, not a per-member average", () => {
    expect(partyHpPercent([
      makeMon({ currentHp: 100, maxHp: 100 }),
      makeMon({ currentHp: 0, maxHp: 100 }),
    ])).toBe(50);
  });

  it("weights by max HP — a big fainted mon counts for more", () => {
    expect(partyHpPercent([
      makeMon({ currentHp: 10, maxHp: 10 }),
      makeMon({ currentHp: 0, maxHp: 190 }),
    ])).toBe(5);
  });

  it("is 100 for an empty party and never divides by zero", () => {
    expect(partyHpPercent([])).toBe(100);
    expect(partyHpPercent([makeMon({ currentHp: 0, maxHp: 0 })])).toBe(100);
  });
});

describe("it fires when the party is worn down", () => {
  it("heals at or below the threshold", () => {
    expect(shouldAutoHeal(healState([30]))).toBe(true);        // 30% <= 35%
    expect(shouldAutoHeal(healState([35]))).toBe(true);        // boundary is inclusive
  });

  it("does not heal above the threshold", () => {
    expect(shouldAutoHeal(healState([36]))).toBe(false);
    expect(shouldAutoHeal(healState([100]))).toBe(false);
  });

  it("heals on ANY fainted member regardless of the percentage", () => {
    // A five-mon party with one corpse sits at 80%, well above any sane
    // threshold, and would otherwise keep fighting a man down forever.
    const s = healState([100, 100, 100, 100, 0]);
    expect(partyHpPercent(s.party)).toBeGreaterThan(s.autoHealThreshold);
    expect(shouldAutoHeal(s)).toBe(true);
  });

  it("respects a custom threshold", () => {
    expect(shouldAutoHeal(healState([50], { autoHealThreshold: 45 }))).toBe(false);
    expect(shouldAutoHeal(healState([50], { autoHealThreshold: 60 }))).toBe(true);
  });
});

describe("every case where it must NOT fire", () => {
  it("is off by default", () => {
    expect(initialState.autoHeal).toBe(false);
    expect(shouldAutoHeal(healState([1], { autoHeal: false }))).toBe(false);
  });

  it("NEVER during a raid — it would end the raid and stamp the cooldown", () => {
    expect(shouldAutoHeal(healState([1], { inRaid: true }))).toBe(false);
  });

  it("never mid-battle — HEAL_PARTY there is a retreat, not a heal", () => {
    for (const phase of ["battle", "trainerBattle", "bossBattle", "healing", "evolution"] as const) {
      expect(shouldAutoHeal(healState([1], { phase }))).toBe(false);
    }
  });

  it("never while an animation or event queue is still draining", () => {
    expect(shouldAutoHeal(healState([1], { catchAnim: { key: 1 } as never }))).toBe(false);
    expect(shouldAutoHeal(healState([1], { whiteoutAnim: { key: 1 } as never }))).toBe(false);
    expect(shouldAutoHeal(healState([1], { pendingEvents: [{} as never] }))).toBe(false);
    expect(shouldAutoHeal(healState([1], {
      evolutionState: { partyIndex: 0, toSpeciesKey: "arcanine", step: 0 },
    }))).toBe(false);
    expect(shouldAutoHeal(healState([1], { healingState: { step: 0 } }))).toBe(false);
  });

  it("leaves the ALL-fainted case to the loop's own defensive heal", () => {
    // useBattleLoop heals an all-fainted party whether or not this setting is
    // on. Claiming it here as well would put two dispatchers on one transition.
    expect(shouldAutoHeal(healState([0, 0]))).toBe(false);
    expect(shouldAutoHeal(healState([0]))).toBe(false);
  });

  it("does nothing with an empty party", () => {
    expect(shouldAutoHeal(healState([]))).toBe(false);
  });

  it("stops asking once the heal has landed — no dispatch loop", () => {
    const worn = healState([10, 10]);
    expect(shouldAutoHeal(worn)).toBe(true);
    const healed = reducer(worn, { type: "HEAL_PARTY" });
    expect(shouldAutoHeal(healed)).toBe(false);
  });
});

describe("SET_AUTO_HEAL", () => {
  it("toggles without touching the threshold", () => {
    const s = reducer(makeState(), { type: "SET_AUTO_HEAL", payload: { enabled: true } });
    expect(s.autoHeal).toBe(true);
    expect(s.autoHealThreshold).toBe(initialState.autoHealThreshold);
  });

  it("sets the threshold without touching the toggle", () => {
    const s = reducer(makeState({ autoHeal: true }), {
      type: "SET_AUTO_HEAL", payload: { threshold: 60 },
    });
    expect(s.autoHeal).toBe(true);
    expect(s.autoHealThreshold).toBe(60);
  });

  it("clamps the threshold into 1–99", () => {
    // 0 would mean "only when the whole party is down", which the defensive
    // heal already covers; 100 would heal after every single hit.
    const lo = reducer(makeState(), { type: "SET_AUTO_HEAL", payload: { threshold: 0 } });
    expect(lo.autoHealThreshold).toBe(1);
    const hi = reducer(makeState(), { type: "SET_AUTO_HEAL", payload: { threshold: 400 } });
    expect(hi.autoHealThreshold).toBe(99);
    const neg = reducer(makeState(), { type: "SET_AUTO_HEAL", payload: { threshold: -20 } });
    expect(neg.autoHealThreshold).toBe(1);
  });

  it("is identity-stable when nothing changes", () => {
    const s = makeState({ autoHeal: true, autoHealThreshold: 35 });
    expect(reducer(s, { type: "SET_AUTO_HEAL", payload: { enabled: true, threshold: 35 } })).toBe(s);
  });
});
