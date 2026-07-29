// Repel + Honey conflict rules. They pull the SAME encounter weight in
// OPPOSITE directions (×0.5 vs ×2), so running both on one species+route
// cancels to nothing while both timers burn — the player pays twice for
// zero effect. The reducer must refuse to create that state, refuse to
// resume into it, and the item must never be consumed by a refusal.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { weightFamily } from "../src/utils/encounters";
import { makeState } from "./helpers";

const repelActive = {
  itemId: "repel", speciesKey: "pidgey", routeKey: "route1", battlesRemaining: 100,
};

describe("weightFamily", () => {
  it("classifies the whole repel line and honey, and nothing else", () => {
    expect(weightFamily("repel")).toBe("repel");
    expect(weightFamily("superrepel")).toBe("repel");
    expect(weightFamily("maxrepel")).toBe("repel");
    expect(weightFamily("honey")).toBe("honey");
    expect(weightFamily("pokeball")).toBeNull();
  });
});

describe("USE_EFFECT_ITEM — repel + honey refusal", () => {
  it("refuses honey where a repel is running on the same species+route, item not consumed", () => {
    const state = makeState({
      inventory: { honey: 1 },
      activeEffects: [repelActive],
    });
    const next = reducer(state, {
      type: "USE_EFFECT_ITEM",
      payload: { itemId: "honey", speciesKey: "pidgey", routeKey: "route1" },
    });
    expect(next.inventory.honey).toBe(1); // refusal must not eat the item
    expect(next.activeEffects).toEqual([repelActive]);
    expect(next.battleLog.at(-1)).toContain("cancel out");
  });

  it("refuses a repel where honey is running (symmetric)", () => {
    const state = makeState({
      inventory: { repel: 1 },
      activeEffects: [{ itemId: "honey", speciesKey: "pidgey", routeKey: "route1", battlesRemaining: 50 }],
    });
    const next = reducer(state, {
      type: "USE_EFFECT_ITEM",
      payload: { itemId: "repel", speciesKey: "pidgey", routeKey: "route1" },
    });
    expect(next.inventory.repel).toBe(1);
    expect(next.activeEffects).toHaveLength(1);
  });

  it("a PAUSED opposite effect does not block — pausing is the documented way out", () => {
    const state = makeState({
      inventory: { honey: 1 },
      activeEffects: [{ ...repelActive, paused: true }],
    });
    const next = reducer(state, {
      type: "USE_EFFECT_ITEM",
      payload: { itemId: "honey", speciesKey: "pidgey", routeKey: "route1" },
    });
    expect(next.inventory.honey ?? 0).toBe(0); // consumed — the use went through
    expect(next.activeEffects).toHaveLength(2);
  });

  it("honey on a DIFFERENT route is no conflict", () => {
    const state = makeState({
      inventory: { honey: 1 },
      activeEffects: [repelActive],
    });
    const next = reducer(state, {
      type: "USE_EFFECT_ITEM",
      payload: { itemId: "honey", speciesKey: "pidgey", routeKey: "route2" },
    });
    expect(next.inventory.honey ?? 0).toBe(0);
    expect(next.activeEffects).toHaveLength(2);
  });
});

describe("TOGGLE_EFFECT_PAUSED — the resume gate", () => {
  it("refuses to RESUME a paused honey while the opposing repel is live", () => {
    const paused = { itemId: "honey", speciesKey: "pidgey", routeKey: "route1", battlesRemaining: 50, paused: true };
    const state = makeState({ activeEffects: [repelActive, paused] });
    const next = reducer(state, {
      type: "TOGGLE_EFFECT_PAUSED",
      payload: { itemId: "honey", speciesKey: "pidgey", routeKey: "route1" },
    });
    expect(next.activeEffects.find((e) => e.itemId === "honey")!.paused).toBe(true); // still paused
    expect(next.battleLog.at(-1)).toContain("stays paused");
  });

  it("pausing is always allowed", () => {
    const state = makeState({
      activeEffects: [repelActive, { itemId: "honey", speciesKey: "pidgey", routeKey: "route1", battlesRemaining: 50, paused: true }],
    });
    const next = reducer(state, {
      type: "TOGGLE_EFFECT_PAUSED",
      payload: { itemId: "repel", speciesKey: "pidgey", routeKey: "route1" },
    });
    expect(next.activeEffects.find((e) => e.itemId === "repel")!.paused).toBe(true);
  });
});
