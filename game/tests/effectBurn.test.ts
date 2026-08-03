// When an active effect spends a charge, and how to get rid of one.
//
// Both halves come from the same report. An effect is per-species AND
// per-route, so a Honey set on Rattata at Route 3 does nothing on Route 12 —
// but it was still charged a battle there, so wandering off burned 500
// battles of something that never fired. The only defence was remembering to
// pause it by hand before travelling.
//
// The second half is Sak4i's: "I click the wrong thing and have to wait 500
// matches to switch." Pause keeps a mistake; it does not undo one.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { makeState, makeMon } from "./helpers";
import type { ActiveEffect, GameState } from "../src/types";

const honey = (over: Partial<ActiveEffect> = {}): ActiveEffect => ({
  itemId: "honey",
  battlesRemaining: 100,
  speciesKey: "rattata",
  routeKey: "route3",
  ...over,
});

/** One encounter resolved. A catch is the shortest real route to
 *  applyCatchSuccess, which is where end-of-encounter effect bookkeeping
 *  runs — the same harness tests/boxSortCaught.test.ts uses.
 *  (An earlier version of this file dispatched a made-up "END_BATTLE" and
 *  every assertion "failed" simply because the reducer ignored it. The tests
 *  were wrong, not the code — worth saying, because three red tests that all
 *  say "nothing happened" look exactly like a broken feature.) */
function afterOneBattle(state: GameState): GameState {
  return reducer(
    { ...state, enemyPokemon: makeMon({ id: "wild", currentHp: 1 }), phase: "battle" } as GameState,
    { type: "CATCH_POKEMON", payload: { ballId: "pokeball" } } as never,
  );
}

const remaining = (s: GameState, itemId = "honey") =>
  s.activeEffects.find((e) => e.itemId === itemId)?.battlesRemaining;

describe("an effect is only charged where it applies", () => {
  it("spends a charge on the route it was set on", () => {
    const s = afterOneBattle(makeState({
      currentLocation: "route3",
      activeEffects: [honey()],
      party: [makeMon()],
    }));
    expect(remaining(s)).toBe(99);
  });

  it("spends nothing on a different route", () => {
    const s = afterOneBattle(makeState({
      currentLocation: "route12",
      activeEffects: [honey()],
      party: [makeMon()],
    }));
    expect(remaining(s)).toBe(100);
  });

  // Exp Share has no route — it works everywhere, so it is charged
  // everywhere. The rule is "charge an effect where it can act", not
  // "pause anything off-route".
  it("still spends a route-less effect anywhere", () => {
    const s = afterOneBattle(makeState({
      currentLocation: "route12",
      activeEffects: [honey({ itemId: "expShare", speciesKey: "", routeKey: "" })],
      party: [makeMon()],
    }));
    expect(remaining(s, "expShare")).toBe(99);
  });

  it("charges the one that applies and leaves the one that does not", () => {
    const s = afterOneBattle(makeState({
      currentLocation: "route3",
      activeEffects: [honey(), honey({ speciesKey: "pidgey", routeKey: "route12" })],
      party: [makeMon()],
    }));
    const [here, there] = s.activeEffects;
    expect(here.battlesRemaining).toBe(99);
    expect(there.battlesRemaining).toBe(100);
  });

  it("still honours pause on the route it applies to", () => {
    const s = afterOneBattle(makeState({
      currentLocation: "route3",
      activeEffects: [honey({ paused: true })],
      party: [makeMon()],
    }));
    expect(remaining(s)).toBe(100);
  });
});

describe("CANCEL_EFFECT", () => {
  const cancel = (s: GameState, p: Record<string, string>) =>
    reducer(s, { type: "CANCEL_EFFECT", payload: p } as never);

  it("removes the one effect it names", () => {
    const s = cancel(makeState({
      activeEffects: [honey(), honey({ speciesKey: "pidgey", routeKey: "route12" })],
    }), { itemId: "honey", speciesKey: "rattata", routeKey: "route3" });
    expect(s.activeEffects).toHaveLength(1);
    expect(s.activeEffects[0].speciesKey).toBe("pidgey");
  });

  // The bug this shape exists to avoid: an id-only match would cancel every
  // Honey on every species on every route at once — the same mistake the
  // pause toggle had to fix.
  it("does not take every effect sharing the item id", () => {
    const s = cancel(makeState({
      activeEffects: [
        honey({ routeKey: "route3" }),
        honey({ routeKey: "route12" }),
        honey({ routeKey: "route14" }),
      ],
    }), { itemId: "honey", speciesKey: "rattata", routeKey: "route12" });
    expect(s.activeEffects.map((e) => e.routeKey)).toEqual(["route3", "route14"]);
  });

  it("is a no-op when nothing matches", () => {
    const before = makeState({ activeEffects: [honey()] });
    const after = cancel(before, { itemId: "honey", speciesKey: "rattata", routeKey: "nowhere" });
    expect(after).toBe(before);
  });
});
