// False Swipe leaves the target standing.
//
// Reported by pani: "Should never reduce the target below 1 HP. If the target
// already has 1 HP, the move should deal 0 damage." It was doing full damage
// and knocking things out, which makes the one move designed for catching
// actively worse at it than any other.
//
// The cap is applied to the DAMAGE, not to the HP afterwards, so the damage
// event reports what was really dealt — a log claiming a big hit on a target
// that did not move is its own small lie.

import { describe, expect, it, vi, afterEach } from "vitest";
import { executeTurn, type BattleSide } from "../src/utils/battle";
import { canonicalMoveId } from "../src/utils/moves";
import { makeMon } from "./helpers";

function side(over: Partial<BattleSide> = {}): BattleSide {
  return { ...makeMon(), types: ["Normal"], statStages: {}, ...over } as BattleSide;
}

/** One turn where the player moves first and cannot miss. */
function swipe(defenderHp: number, moveId = "falseswipe") {
  vi.spyOn(Math, "random").mockReturnValue(0); // land it, minimum roll
  const player = side({
    speed: 999, attack: 9999, level: 100,
    moves: [{ id: moveId, pp: 40, maxPp: 40 }],
  });
  const enemy = side({
    speed: 1, maxHp: 400, currentHp: defenderHp, defense: 1,
    moves: [{ id: "tackle", pp: 35, maxPp: 35 }],
  });
  const events = executeTurn(player, enemy, false, moveId);
  return { enemy, events };
}

afterEach(() => vi.restoreAllMocks());

describe("False Swipe", () => {
  it("cannot knock a healthy target out, however hard it hits", () => {
    const { enemy, events } = swipe(400);
    expect(enemy.currentHp).toBe(1);
    // The foe must not be the one that fainted. (The player can still faint
    // to the return attack — that is not this move's business.)
    expect(events.some((e) => e.type === "faint" && (e.payload as { target?: string })?.target === "enemy")).toBe(false);
  });

  it("deals 0 to a target already on 1 HP", () => {
    const { enemy } = swipe(1);
    expect(enemy.currentHp).toBe(1);
  });

  it("reports the damage it actually dealt, not the damage it wanted to", () => {
    const { events } = swipe(10);
    // The FOE's damage event — the first one belongs to whoever moved first,
    // and the return attack lands in the same turn.
    const dmg = events.find(
      (e) => e.type === "damage" && (e.payload as { target?: string })?.target === "enemy",
    );
    // 10 HP target, so at most 9 can land.
    expect((dmg?.payload as { damage?: number } | undefined)?.damage).toBe(9);
  });

  it("is matched through canonicalMoveId, so either spelling reaches the rule", () => {
    // The learnsets only spell it `falseswipe` today, but the guard is keyed
    // on the canonical id so a camelCase entry would hit the same rule rather
    // than silently bypassing it.
    expect(canonicalMoveId("falseSwipe")).toBe(canonicalMoveId("falseswipe"));
    expect(canonicalMoveId("falseSwipe")).toBe("falseswipe");
  });

  it("does NOT spare the target for an ordinary move", () => {
    // The guard must be this move, not every move.
    const { enemy } = swipe(400, "tackle");
    expect(enemy.currentHp).toBeLessThan(400);
  });
});
