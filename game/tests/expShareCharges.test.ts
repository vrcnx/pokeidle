// "Exp. Share charges are only consumed after you defeat the trainer's LAST
// Pokemon, which makes it much more efficient and pretty unbalanced."
// (br_e84825db52e3431dc9)
//
// The report contains two different things and only one of them is a bug.
//
// NOT a bug: one charge per BATTLE. The item says "for 300 battles", and a
// trainer fight is one battle — the six payouts are the fight being worth more,
// the same shape as trainer battles paying more money. Changing that is a nerf
// to every live Exp Share and belongs in a changelog, not in a bug fix, so the
// per-battle economics are pinned below and must not move.
//
// IS a bug: payout and billing were decided by different predicates at
// different times. applyExp paid on every KO; decrementEffects billed once at
// battle end and SKIPPED paused effects. So pausing after the last KO of a
// trainer battle banked every payout for zero charges — unpause and the counter
// was untouched. Infinite Exp Share, one click, repeatable forever.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { createPokemon } from "../src/utils/pokemon";
import type { ActiveEffect, GameState, Pokemon } from "../src/types";
import { makeMon, makeState } from "./helpers";

const expShare = (over: Partial<ActiveEffect> = {}): ActiveEffect => ({
  itemId: "expShare", speciesKey: "", battlesRemaining: 300, ...over,
});

function charges(s: GameState): number {
  return s.activeEffects.find((e) => e.itemId === "expShare")?.battlesRemaining ?? 0;
}

/** Two-mon party so Exp Share has a backline to pay. */
function partyState(over: Partial<GameState> = {}): GameState {
  const lead = makeMon({ id: "lead", level: 60, currentHp: 500, maxHp: 500, attack: 400 });
  const bench = makeMon({ id: "bench", speciesKey: "bulbasaur", name: "Bulbasaur", level: 5 });
  return makeState({
    party: [lead, bench],
    playerPokemon: lead,
    activeEffects: [expShare()],
    ...over,
  });
}

/** Fight to the end of the current battle. `onKo` runs after each enemy faint,
 *  which is the window the exploit used. */
function fightOut(state: GameState, onKo?: (s: GameState) => GameState): GameState {
  let s = state;
  let guard = 0;
  const wasEnemy = () => s.enemyPokemon?.id ?? null;
  while ((s.phase === "battle" || s.phase === "trainerBattle") && guard++ < 200) {
    const before = wasEnemy();
    s = reducer(s, { type: "EXECUTE_TURN" });
    let drain = 0;
    while (s.pendingEvents.length > 0 && drain++ < 80) {
      s = reducer(s, { type: "CONSUME_EVENT" });
    }
    if (onKo && wasEnemy() !== before) s = onKo(s);
  }
  return s;
}

function trainerTeam(n: number): Pokemon[] {
  return Array.from({ length: n }, (_, i) => createPokemon("caterpie", 3, 7000 + i));
}

function startTrainer(state: GameState, n: number): GameState {
  return reducer(state, {
    type: "START_TRAINER_BATTLE",
    payload: {
      trainerId: `t_${n}`,
      trainerName: "Youngster Joey",
      trainerClass: "youngster",
      trainerTeam: trainerTeam(n),
      spriteKey: "youngster",
    },
  });
}

describe("the economics do not move — one charge per battle, exactly as before", () => {
  it("spends one charge for a wild battle", () => {
    let s = partyState();
    s = reducer(s, { type: "START_ENCOUNTER", payload: { pokemon: createPokemon("pidgey", 3, 7100) } });
    s = fightOut(s);
    expect(s.phase).toBe("idle");
    expect(charges(s)).toBe(299);
  });

  it("spends one charge for a six-Pokémon trainer battle, not six", () => {
    let s = partyState();
    s = startTrainer(s, 6);
    s = fightOut(s);
    expect(s.phase).toBe("idle");
    // Six payouts, one charge. This is the "unbalanced" half of the report and
    // it stays: a trainer fight is one battle. Do not "fix" this here.
    expect(s.battleLog.filter((l) => /from Exp Share/.test(l)).length).toBeGreaterThanOrEqual(6);
    expect(charges(s)).toBe(299);
  });

  it("still bills a battle where Exp Share paid nothing (solo party)", () => {
    // Unchanged behaviour: an unpaused effect ticks every battle whether or not
    // there was a backline to pay. Making that conditional is a balance change.
    const lead = makeMon({ id: "solo", level: 60, currentHp: 500, maxHp: 500, attack: 400 });
    let s = makeState({ party: [lead], playerPokemon: lead, activeEffects: [expShare()] });
    s = reducer(s, { type: "START_ENCOUNTER", payload: { pokemon: createPokemon("pidgey", 3, 7101) } });
    s = fightOut(s);
    expect(charges(s)).toBe(299);
  });

  it("does not bill a battle while genuinely paused the whole way through", () => {
    let s = partyState({ activeEffects: [expShare({ paused: true })] });
    s = reducer(s, { type: "START_ENCOUNTER", payload: { pokemon: createPokemon("pidgey", 3, 7102) } });
    s = fightOut(s);
    expect(charges(s)).toBe(300);
    expect(s.battleLog.some((l) => /from Exp Share/.test(l))).toBe(false);
  });
});

describe("the pause exploit is closed", () => {
  it("bills the charge even if the player pauses after the last KO", () => {
    let s = partyState();
    s = startTrainer(s, 3);
    // Pause the moment the trainer's last Pokémon goes down — the window the
    // exploit lived in. Before the fix this returned 300 with every payout kept.
    s = fightOut(s, (mid) =>
      mid.trainerBattle && mid.trainerBattle.currentTrainerPokemonIndex >= 2
        ? reducer(mid, { type: "TOGGLE_EFFECT_PAUSED", payload: { itemId: "expShare" } })
        : mid,
    );
    expect(s.phase).toBe("idle");
    expect(s.battleLog.some((l) => /from Exp Share/.test(l))).toBe(true);
    expect(charges(s)).toBe(299);
  });

  it("bills at most ONE charge no matter how many KOs paid out", () => {
    let s = partyState();
    s = startTrainer(s, 6);
    s = fightOut(s, (mid) => {
      // Pause and unpause repeatedly mid-fight: the stamp is a boolean, so it
      // cannot be turned into a double charge.
      const p = reducer(mid, { type: "TOGGLE_EFFECT_PAUSED", payload: { itemId: "expShare" } });
      return reducer(p, { type: "TOGGLE_EFFECT_PAUSED", payload: { itemId: "expShare" } });
    });
    expect(charges(s)).toBe(299);
  });

  it("clears the stamp between battles, so the next one starts owing nothing", () => {
    let s = partyState();
    s = startTrainer(s, 2);
    s = fightOut(s);
    expect(charges(s)).toBe(299);
    expect(s.activeEffects[0].billedThisBattle).toBeUndefined();

    // Now pause BEFORE anything pays out — that must still be free.
    s = reducer(s, { type: "TOGGLE_EFFECT_PAUSED", payload: { itemId: "expShare" } });
    s = reducer(s, { type: "START_ENCOUNTER", payload: { pokemon: createPokemon("pidgey", 3, 7103) } });
    s = fightOut(s);
    expect(charges(s)).toBe(299);
  });

  it("leaves a paused Repel alone — the stamp is not a general 'ignore paused'", () => {
    const repel: ActiveEffect = {
      itemId: "repel", speciesKey: "pidgey", routeKey: "route1",
      battlesRemaining: 100, paused: true,
    };
    let s = partyState({ activeEffects: [expShare(), repel] });
    s = startTrainer(s, 2);
    s = fightOut(s);
    expect(charges(s)).toBe(299);
    expect(s.activeEffects.find((e) => e.itemId === "repel")!.battlesRemaining).toBe(100);
  });
});

describe("the array identity that keeps cloud saves alive", () => {
  it("does not re-allocate activeEffects on every KO once stamped", () => {
    // decrementEffects documents why this matters: state.activeEffects is a
    // reference dependency of the cloud-save effect, and a fresh array on every
    // KO resets the 1.5s debounce faster than it can ever fire — which is how
    // "the game never saved" happened the first time. Stamping is guarded by a
    // .some() precisely so the identity holds after the first payout.
    let s = partyState();
    s = startTrainer(s, 6);
    const identities = new Set<ActiveEffect[]>();
    let guard = 0;
    while (s.phase === "trainerBattle" && guard++ < 200) {
      s = reducer(s, { type: "EXECUTE_TURN" });
      let drain = 0;
      while (s.pendingEvents.length > 0 && drain++ < 80) {
        s = reducer(s, { type: "CONSUME_EVENT" });
        identities.add(s.activeEffects);
      }
      identities.add(s.activeEffects);
    }
    // One array for the stamp, one for the end-of-battle decrement. Six KOs
    // must not mean six arrays.
    expect(identities.size).toBeLessThanOrEqual(3);
  });

  it("returns the identical array when there is nothing at all to change", () => {
    let s = partyState({ activeEffects: [expShare({ paused: true })] });
    const before = s.activeEffects;
    s = reducer(s, { type: "START_ENCOUNTER", payload: { pokemon: createPokemon("pidgey", 3, 7104) } });
    s = fightOut(s);
    expect(s.activeEffects).toBe(before);
  });
});
