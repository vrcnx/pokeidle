// Stat changes riding on a DAMAGING move.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────
// executeTurn handled `statChange` in one place: the branch for status moves
// (`power === 0`). The effect switch that runs after damage knew about
// recoil, recharge, self-destruct, multi-turn lock, confusion and status —
// and had no case for stat changes at all. So a stat change attached to an
// attacking move was read, matched nothing, and was silently dropped.
//
// Nothing in the game exercised it, because no move in the table had that
// shape. That is what made it invisible rather than harmless: it meant the
// entire `damage-lower` and `damage-raise` half of the TM list — Psychic,
// Shadow Ball, Overheat, Charge Beam, Flash Cannon, Bulldoze and nine others
// — could not be shipped until it existed.

import { describe, expect, it, vi, afterEach } from "vitest";
import { executeTurn, type BattleSide } from "../src/utils/battle";
import { moves as movesTable } from "../src/data/moves";
import { makeMon } from "./helpers";

function side(overrides: Partial<BattleSide> = {}): BattleSide {
  return {
    ...makeMon(),
    types: ["Normal"],
    statStages: {},
    ...overrides,
  } as BattleSide;
}

/** Run one turn where the player is guaranteed to move first and land it. */
function turn(moveId: string, playerOver: Partial<BattleSide> = {}, enemyOver: Partial<BattleSide> = {}) {
  const player = side({
    speed: 999,
    maxHp: 400,
    currentHp: 400,
    moves: [{ id: moveId, pp: 20, maxPp: 20 }],
    ...playerOver,
  });
  const enemy = side({
    speed: 1,
    maxHp: 999,
    currentHp: 999,
    moves: [{ id: "tackle", pp: 35, maxPp: 35 }],
    ...enemyOver,
  });
  const events = executeTurn(player, enemy, false, moveId);
  return { player, enemy, events };
}

afterEach(() => vi.restoreAllMocks());

describe("a guaranteed stat change on an attacking move", () => {
  it("Overheat crashes the user's own Sp. Atk two stages", () => {
    expect(movesTable.overheat.effect).toMatchObject({
      type: "statChange",
      target: "self",
      changes: { spAttack: -2 },
    });
    // Overheat is 90% accurate, so the roll has to be pinned — without this
    // the test fails roughly one run in ten, which is worse than not having
    // it. `0` misses nothing: the engine's check is `random * 100 >= acc`.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { player, events } = turn("overheat");
    expect(player.statStages?.spAttack).toBe(-2);
    expect(events.some((e) => e.type === "statChange" && /sharply fell/.test(e.message))).toBe(true);
  });

  it("Flame Charge raises the user's Speed", () => {
    const { player } = turn("flameCharge");
    expect(player.statStages?.speed).toBe(1);
  });

  it("still deals its damage — the effect does not replace the hit", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // 90% accurate; pin the roll
    const { enemy } = turn("overheat");
    expect(enemy.currentHp).toBeLessThan(999);
  });
});

describe("a CHANCE-based stat change", () => {
  it("lands when the roll passes", () => {
    // Psychic: 10% to drop the target's Sp. Def.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { enemy } = turn("psychic");
    expect(enemy.statStages?.spDefense).toBe(-1);
  });

  it("does nothing when the roll fails", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { enemy } = turn("psychic");
    expect(enemy.statStages?.spDefense ?? 0).toBe(0);
  });

  it("treats an absent chance as always — a status move is not a coin flip", () => {
    // Swords Dance has no `chance`, so it must land on any roll at all.
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const { player } = turn("swordsDance");
    expect(player.statStages?.attack).toBe(2);
  });
});

describe("the edges", () => {
  it("clamps at +6 and says so instead of claiming a raise", () => {
    const { player, events } = turn("swordsDance", { statStages: { attack: 6 } });
    expect(player.statStages?.attack).toBe(6);
    const msg = events.find((e) => e.type === "statChange")?.message ?? "";
    expect(msg).toMatch(/won't go higher/);
  });

  it("clamps at -6 for a drop", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { enemy, events } = turn("psychic", {}, { statStages: { spDefense: -6 } });
    expect(enemy.statStages?.spDefense).toBe(-6);
    expect(events.some((e) => /won't go lower/.test(e.message))).toBe(true);
  });

  it("does not move the stages of a Pokémon that just fainted", () => {
    // "The fainted Pokémon's Sp. Def fell!" reads as a bug, and the stages
    // are discarded on switch-in anyway.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { enemy, events } = turn("psychic", { spAttack: 999 }, { maxHp: 1, currentHp: 1, defense: 1, spDefense: 1 });
    expect(enemy.currentHp).toBe(0);
    expect(enemy.statStages?.spDefense ?? 0).toBe(0);
    expect(events.some((e) => e.type === "faint")).toBe(true);
  });
});

describe("the status-move path still behaves", () => {
  it("keeps applying multi-stat buffs", () => {
    const { player } = turn("calmMind");
    expect(player.statStages?.spAttack).toBe(1);
    expect(player.statStages?.spDefense).toBe(1);
  });

  it("lowers the opponent from a status move", () => {
    const { enemy } = turn("growl");
    expect(enemy.statStages?.attack).toBe(-1);
  });
});
