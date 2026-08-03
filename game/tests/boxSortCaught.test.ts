// Sorting the PC by catch date.
//
// The interesting cases are not "does it sort" — they are the two states a
// real save is actually in on the day this ships:
//
//   1. Every Pokemon in the box predates the field, so every caughtAt is
//      undefined. The sort still has to produce a sensible order, and
//      currentSortMode must NOT claim the box is sorted by catch date just
//      because a list of undefineds is trivially "in order".
//   2. A mix — some caught before today, some after. The dated ones have to
//      come first (newest first) and the undated ones must keep the relative
//      order they already had, because in an append-only box that order IS
//      approximately their catch order.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState } from "./helpers";
import type { Pokemon } from "../src/types";

const ids = (list: Pokemon[]) => list.map((p) => p.id);
const sortBox = (box: Pokemon[]) =>
  reducer(makeState({ box }), { type: "SORT_BOX", payload: { mode: "caught" } } as never).box;

// Fixed instants — the reducer reads Date.now() only on a CATCH, never here.
const T = (n: number) => 1_700_000_000_000 + n * 60_000;

describe("SORT_BOX by catch date", () => {
  it("puts the most recently caught first", () => {
    const out = sortBox([
      makeMon({ id: "old", caughtAt: T(1) }),
      makeMon({ id: "new", caughtAt: T(9) }),
      makeMon({ id: "mid", caughtAt: T(5) }),
    ]);
    expect(ids(out)).toEqual(["new", "mid", "old"]);
  });

  // The case every existing save is in.
  it("leaves an entirely undated box in a stable order", () => {
    const box = [
      makeMon({ id: "a" }), makeMon({ id: "b" }), makeMon({ id: "c" }),
    ];
    const out = sortBox(box);
    expect(out).toHaveLength(3);
    expect(new Set(ids(out))).toEqual(new Set(["a", "b", "c"]));
    // Sorting it twice must not shuffle it again.
    expect(ids(sortBox(out))).toEqual(ids(out));
  });

  it("puts dated Pokemon above undated ones", () => {
    const out = sortBox([
      makeMon({ id: "legacy1" }),
      makeMon({ id: "dated", caughtAt: T(3) }),
      makeMon({ id: "legacy2" }),
    ]);
    expect(ids(out)[0]).toBe("dated");
    expect(ids(out).slice(1).sort()).toEqual(["legacy1", "legacy2"]);
  });

  it("keeps every Pokemon — a sort must never lose one", () => {
    const box = Array.from({ length: 40 }, (_, i) =>
      makeMon({ id: `m${i}`, caughtAt: i % 3 === 0 ? undefined : T(i) }));
    const out = sortBox(box);
    expect(out).toHaveLength(40);
    expect(new Set(ids(out))).toEqual(new Set(ids(box)));
  });

  it("is a real reordering, not a no-op", () => {
    const box = [
      makeMon({ id: "first", caughtAt: T(1) }),
      makeMon({ id: "last", caughtAt: T(2) }),
    ];
    expect(ids(sortBox(box))).toEqual(["last", "first"]);
  });
});

describe("a catch stamps the date", () => {
  it("sets caughtAt on the Pokemon that lands in the box", () => {
    // The whole feature rests on this: without a stamp on catch, every
    // Pokemon is undated forever and the sort is decorative.
    const before = Date.now();
    const st = makeState({
      party: [makeMon(), makeMon(), makeMon(), makeMon(), makeMon(), makeMon()],
      box: [],
      enemyPokemon: makeMon({ id: "wild", currentHp: 1 }),
      phase: "battle",
    });
    const after = reducer(st, {
      type: "CATCH_POKEMON",
      payload: { ballId: "pokeball" },
    } as never);
    const caught = after.box[after.box.length - 1];
    expect(caught).toBeTruthy();
    expect(typeof caught.caughtAt).toBe("number");
    expect(caught.caughtAt!).toBeGreaterThanOrEqual(before);
  });
});
