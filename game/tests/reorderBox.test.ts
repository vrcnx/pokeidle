// REORDER_BOX bounds. With drag-and-drop feeding this action, an
// out-of-range index must be a no-op — a stray splice would silently
// destroy (or duplicate) a boxed mon.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState } from "./helpers";

const boxed = () => [
  makeMon({ id: "b0", speciesKey: "eevee", name: "Eevee" }),
  makeMon({ id: "b1", speciesKey: "dratini", name: "Dratini" }),
  makeMon({ id: "b2", speciesKey: "lapras", name: "Lapras" }),
];

describe("REORDER_BOX", () => {
  it("moves a mon and keeps every id exactly once", () => {
    const state = makeState({ box: boxed() });
    const next = reducer(state, { type: "REORDER_BOX", payload: { from: 0, to: 2 } });
    expect(next.box.map((m) => m.id)).toEqual(["b1", "b2", "b0"]);
  });

  it("moves backwards too", () => {
    const state = makeState({ box: boxed() });
    const next = reducer(state, { type: "REORDER_BOX", payload: { from: 2, to: 0 } });
    expect(next.box.map((m) => m.id)).toEqual(["b2", "b0", "b1"]);
  });

  it.each([
    { from: -1, to: 0 },
    { from: 0, to: -1 },
    { from: 3, to: 0 },   // from === length
    { from: 0, to: 3 },   // to === length
    { from: 99, to: 98 },
  ])("out-of-bounds ($from → $to) is an identity no-op", ({ from, to }) => {
    const state = makeState({ box: boxed() });
    const next = reducer(state, { type: "REORDER_BOX", payload: { from, to } });
    expect(next).toBe(state); // nothing lost, nothing duplicated, no new object
  });

  it("an empty box tolerates any indices", () => {
    const state = makeState({ box: [] });
    expect(reducer(state, { type: "REORDER_BOX", payload: { from: 0, to: 0 } })).toBe(state);
  });
});
