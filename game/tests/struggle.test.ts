// Struggle at 0 PP. The regression this pins: a spent moveset used to
// re-pick from the full move list at full strength forever, and the manual
// battle UI had no legal action at 0 PP. Now:
//   * out of PP → Struggle, with the Gen-5 quarter-of-max-HP recoil,
//   * a manual "struggle" override is honoured ONLY when genuinely out of
//     PP (never a free extra attack),
//   * dispatching the manual turn does not flip the player out of manual
//     mode and never drives PP negative.

import { describe, expect, it } from "vitest";
import { executeTurn, isOutOfPP, STRUGGLE_ID, type BattleSide } from "../src/utils/battle";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState, freshVolatile } from "./helpers";

function side(overrides: Partial<BattleSide> = {}): BattleSide {
  return {
    ...makeMon(),
    types: ["Electric"],
    ...overrides,
  } as BattleSide;
}

const spentMoves = () => [
  { id: "tackle", pp: 0, maxPp: 35 },
  { id: "thunderShock", pp: 0, maxPp: 30 },
];

describe("isOutOfPP", () => {
  it("is true only when every slot is spent (and vacuously for no moves)", () => {
    expect(isOutOfPP(spentMoves())).toBe(true);
    expect(isOutOfPP([{ pp: 1 }, { pp: 0 }])).toBe(false);
    expect(isOutOfPP([])).toBe(true);
  });
});

describe("executeTurn — Struggle", () => {
  it("manual Struggle override at 0 PP is honoured and bills quarter-max-HP recoil", () => {
    const player = side({ moves: spentMoves(), maxHp: 100, currentHp: 100, speed: 999 });
    // Enemy at 1 HP: the Struggle KOs it before it can act, so the only HP
    // the player loses is the recoil — which Gen 5 bills as 1/4 of the
    // USER'S OWN max HP, independent of damage dealt.
    const enemy = side({ speciesKey: "rattata", name: "Rattata", currentHp: 1, maxHp: 60, speed: 1, types: ["Normal"] });
    const events = executeTurn(player, enemy, false, STRUGGLE_ID);
    expect(events.some((e) => e.message?.includes("used Struggle!"))).toBe(true);
    expect(enemy.currentHp).toBe(0);
    expect(player.currentHp).toBe(100 - Math.floor(100 * 0.25)); // 75
    // No PP went negative — Struggle occupies no slot.
    expect(player.moves.every((m) => m.pp === 0)).toBe(true);
  });

  it("a 'struggle' override with PP remaining is NOT honoured (no free extra attack)", () => {
    const player = side({
      moves: [{ id: "tackle", pp: 5, maxPp: 35 }],
      speed: 999,
    });
    const enemy = side({ speciesKey: "rattata", name: "Rattata", currentHp: 200, maxHp: 200, speed: 1, types: ["Normal"] });
    const events = executeTurn(player, enemy, false, STRUGGLE_ID);
    expect(events.some((e) => e.message?.includes("used Struggle!"))).toBe(false);
    // Fell through to a real (PP-paying) pick instead.
    expect(player.moves[0].pp).toBe(4);
  });

  it("auto mode at 0 PP also resolves to Struggle (AI cannot fire spent moves)", () => {
    const player = side({ moves: spentMoves(), speed: 999 });
    const enemy = side({ speciesKey: "rattata", name: "Rattata", currentHp: 500, maxHp: 500, speed: 1, types: ["Normal"] });
    const events = executeTurn(player, enemy, false, undefined);
    expect(events.some((e) => e.message?.includes("used Struggle!"))).toBe(true);
    // The spent moves were not fired and not decremented below zero.
    expect(player.moves.every((m) => m.pp === 0)).toBe(true);
  });
});

describe("reducer EXECUTE_TURN — manual stays manual", () => {
  it("a manual Struggle turn keeps battleMode manual and PP non-negative", () => {
    const lead = makeMon({ moves: spentMoves(), currentHp: 100, maxHp: 100, speed: 999 });
    const enemy = makeMon({ speciesKey: "rattata", name: "Rattata", currentHp: 30, maxHp: 30, speed: 1 });
    const state = makeState({
      phase: "battle",
      battleMode: "manual",
      party: [lead],
      playerPokemon: lead,
      enemyPokemon: enemy,
      playerVolatile: freshVolatile(),
    });
    const next = reducer(state, { type: "EXECUTE_TURN", payload: { playerMoveId: STRUGGLE_ID } });
    expect(next.battleMode).toBe("manual"); // running out of PP never flips the mode
    expect(next.pendingEvents.length).toBeGreaterThan(0);
    expect(next.pendingEvents.some((e) => e.message?.includes("used Struggle!"))).toBe(true);
    expect(next.playerPokemon!.moves.every((m) => m.pp === 0)).toBe(true);
    // The party mirror agrees with the active mon.
    expect(next.party[0].moves.every((m) => m.pp === 0)).toBe(true);
  });
});
