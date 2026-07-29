// The Shiny Charm grant. Regression history: the charm was a phantom —
// a hardcoded `>= 245` predicate with no item, no grant, no notification.
// Now it is granted exactly once as a real Bag item when the dex is
// actually complete, and the grandfather clause keeps the doubled rate for
// saves that had earned it under the old rule.

import { describe, expect, it } from "vitest";
import {
  grantShinyCharmIfEarned,
  grandfatherShinyCharm,
  hasShinyCharm,
  SHINY_CHARM_ITEM,
  LEGACY_SHINY_CHARM_THRESHOLD,
} from "../src/utils/shinyCharm";
import { obtainableSpecies, isDexComplete } from "../src/utils/obtainable";
import { reducer } from "../src/state/reducer";
import { makeState } from "./helpers";

const allObtainable = () => [...obtainableSpecies()];

describe("completion grant — exactly once, through markCaught", () => {
  it("catching the LAST obtainable species grants the charm, with a log line", () => {
    const all = allObtainable();
    const last = all[all.length - 1];
    const state = makeState({
      pokedexCaught: all.slice(0, -1),
      pokedexSeen: all.slice(0, -1),
      inventory: {},
    });
    expect(isDexComplete(state.pokedexCaught)).toBe(false);

    const next = reducer(state, { type: "MARK_CAUGHT", payload: { speciesKey: last } });
    expect(next.inventory[SHINY_CHARM_ITEM]).toBe(1);
    expect(hasShinyCharm(next)).toBe(true);
    expect(next.battleLog.some((l) => l.includes("Pokédex complete"))).toBe(true);
  });

  it("never grants a second charm", () => {
    const all = allObtainable();
    const state = makeState({
      pokedexCaught: all,
      pokedexSeen: all,
      inventory: { [SHINY_CHARM_ITEM]: 1 },
    });
    // Registering anything further (even an unobtainable oddity) is a no-op
    // for the charm.
    const next = reducer(state, { type: "MARK_CAUGHT", payload: { speciesKey: "someLegacyKey" } });
    expect(next.inventory[SHINY_CHARM_ITEM]).toBe(1);
  });

  it("an incomplete dex grants nothing", () => {
    const state = makeState({ pokedexCaught: allObtainable().slice(0, 10), inventory: {} });
    const next = reducer(state, { type: "MARK_CAUGHT", payload: { speciesKey: "pikachu" } });
    expect(next.inventory[SHINY_CHARM_ITEM]).toBeUndefined();
  });

  it("grantShinyCharmIfEarned is idempotent", () => {
    const s = { inventory: { [SHINY_CHARM_ITEM]: 1 }, pokedexCaught: allObtainable() };
    expect(grantShinyCharmIfEarned(s)).toBe(s); // no-op by identity once held
  });
});

describe("the grandfather clause", () => {
  it("a save at the OLD 245 threshold gets the charm materialised on load", () => {
    // Raw length check by design: the legacy rule was an unfiltered
    // pokedexCaught.length >= 245, raid legendaries and all.
    const legacy = {
      inventory: {},
      pokedexCaught: Array.from({ length: LEGACY_SHINY_CHARM_THRESHOLD }, (_, i) => `sp${i}`),
    };
    const out = grandfatherShinyCharm(legacy);
    expect(out.inventory[SHINY_CHARM_ITEM]).toBe(1);
  });

  it("below the old threshold the new (derived) rule applies — no charm", () => {
    const save = {
      inventory: {},
      pokedexCaught: Array.from({ length: LEGACY_SHINY_CHARM_THRESHOLD - 1 }, (_, i) => `sp${i}`),
    };
    const out = grandfatherShinyCharm(save);
    expect(out.inventory[SHINY_CHARM_ITEM]).toBeUndefined();
  });

  it("is idempotent and tolerant of missing fields (boot path must never throw)", () => {
    expect(() => grandfatherShinyCharm({})).not.toThrow();
    const once = grandfatherShinyCharm({
      inventory: {},
      pokedexCaught: Array.from({ length: 300 }, (_, i) => `sp${i}`),
    });
    const twice = grandfatherShinyCharm(once);
    expect(twice.inventory[SHINY_CHARM_ITEM]).toBe(1);
  });
});
