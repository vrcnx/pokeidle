// "Not caught yet" was ONE auto-catch option meaning "not registered in the
// Pokédex". Once the dex started showing "registered" and "currently owned" as
// separate facts, that label stopped being answerable — pani filed it as
// br_cb4d83f3ada30b1ec4.
//
// It is two options now. The critical property, and the reason these tests
// exist: the stored value for "not registered" is UNCHANGED (`pokedex_new`), so
// no existing save's auto-catch behaviour changes. 5 of 9 real player saves
// pulled for this work used `pokedex_new` as their global default and 221
// per-species rules carried it; every one of them must keep behaving exactly as
// before. The equivalence test below is that guarantee, written against the OLD
// decision function inlined verbatim.

import { describe, expect, it } from "vitest";
import { shouldAutoCatch } from "../src/utils/catching";
import { CATCH_MODE_OPTIONS, catchModeHint } from "../src/utils/catchSettings";
import { ownsSpecies } from "../src/utils/pokemon";
import type { CatchSettings, GameState } from "../src/types";
import { makeMon, makeState } from "./helpers";

const RULE = (over: Partial<CatchSettings> = {}): CatchSettings => ({
  enabled: true,
  mode: "always",
  levelThreshold: 1,
  enabledBalls: ["pokeball"],
  ...over,
});

/** The decision function EXACTLY as it read before the split. Any divergence
 *  from the current one on a `pokedex_new` rule is a silent behaviour change
 *  for a real player, which is the thing this file forbids. */
function shouldAutoCatchBeforeTheSplit(
  state: GameState, routeKey: string, speciesKey: string, level: number, isShiny: boolean,
): boolean {
  if (isShiny && state.alwaysCatchShinies) return true;
  const settings = state.catchSettings[routeKey]?.[speciesKey] ?? state.globalCatchDefaults;
  if (!settings.enabled || settings.enabledBalls.length === 0) return false;
  switch (settings.mode) {
    case "always": return true;
    case "shiny_only": return isShiny;
    case "level_threshold": return level >= settings.levelThreshold;
    case "pokedex_new": return !state.pokedexCaught.includes(speciesKey);
    default: return true;
  }
}

describe("the option list", () => {
  it("offers both readings, each with a disambiguating hint", () => {
    const values = CATCH_MODE_OPTIONS.map((o) => o.value);
    expect(values).toContain("not_owned");
    expect(values).toContain("pokedex_new");
    expect(CATCH_MODE_OPTIONS.every((o) => o.hint.length > 0)).toBe(true);
  });

  it("is a SINGLE list — the modal and the panel each used to keep their own", () => {
    // Two copies is how a new mode ends up reachable in one surface and not the
    // other, which is exactly what happened to the label wording before this.
    const values = CATCH_MODE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(catchModeHint("not_owned")).not.toBe(catchModeHint("pokedex_new"));
  });

  it("names pokedex_new after what it actually does", () => {
    expect(CATCH_MODE_OPTIONS.find((o) => o.value === "pokedex_new")!.label).toBe("Not registered");
    expect(CATCH_MODE_OPTIONS.find((o) => o.value === "not_owned")!.label).toBe("Not owned");
  });
});

describe("migration: pokedex_new keeps its exact meaning", () => {
  // A save whose rules say `pokedex_new` needs NO migration, because the value
  // is untouched. Prove the behaviour is identical rather than asserting it.
  it("decides identically to the pre-split function across every mode and input", () => {
    const lead = makeMon({ id: "p1", speciesKey: "pikachu", name: "Pikachu" });
    const boxed = makeMon({ id: "b1", speciesKey: "gastly", name: "Gastly" });
    const base = makeState({
      party: [lead], playerPokemon: lead, box: [boxed],
      // registered: one held in party, one held in box, one long gone
      pokedexCaught: ["pikachu", "gastly", "rattata"],
    });

    const modes: CatchSettings["mode"][] = ["always", "shiny_only", "level_threshold", "pokedex_new"];
    const species = ["pikachu", "gastly", "rattata", "lapras"];
    let compared = 0;
    for (const mode of modes) {
      for (const enabled of [true, false]) {
        for (const balls of [["pokeball"], []]) {
          for (const shinyOverride of [true, false]) {
            const state = {
              ...base,
              alwaysCatchShinies: shinyOverride,
              globalCatchDefaults: RULE({ mode, enabled, enabledBalls: balls, levelThreshold: 25 }),
              catchSettings: { r1: { pikachu: RULE({ mode, enabled, enabledBalls: balls, levelThreshold: 25 }) } },
            } as GameState;
            for (const route of ["r1", "no-rule-here"]) {
              for (const sp of species) {
                for (const level of [1, 25, 100]) {
                  for (const shiny of [true, false]) {
                    compared++;
                    expect(shouldAutoCatch(state, route, sp, level, shiny))
                      .toBe(shouldAutoCatchBeforeTheSplit(state, route, sp, level, shiny));
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it("still skips a species the dex registered but the player no longer holds", () => {
    const lead = makeMon({ id: "p1", speciesKey: "pikachu", name: "Pikachu" });
    const state = makeState({
      party: [lead], playerPokemon: lead, box: [],
      pokedexCaught: ["pikachu", "rattata"],           // rattata released long ago
      globalCatchDefaults: RULE({ mode: "pokedex_new" }),
    });
    expect(shouldAutoCatch(state, "r", "rattata", 10, false)).toBe(false);
  });
});

describe("not_owned: the new reading", () => {
  const lead = makeMon({ id: "p1", speciesKey: "pikachu", name: "Pikachu" });
  const boxed = makeMon({ id: "b1", speciesKey: "gastly", name: "Gastly" });
  const state = makeState({
    party: [lead], playerPokemon: lead, box: [boxed],
    pokedexCaught: ["pikachu", "gastly", "rattata"],
    globalCatchDefaults: RULE({ mode: "not_owned" }),
  });

  it("skips a species held in the party", () => {
    expect(shouldAutoCatch(state, "r", "pikachu", 10, false)).toBe(false);
  });

  it("skips a species held in the PC", () => {
    expect(shouldAutoCatch(state, "r", "gastly", 10, false)).toBe(false);
  });

  it("RE-CATCHES a registered species the player no longer holds — the whole request", () => {
    expect(shouldAutoCatch(state, "r", "rattata", 10, false)).toBe(true);
  });

  it("catches a species never seen at all", () => {
    expect(shouldAutoCatch(state, "r", "lapras", 10, false)).toBe(true);
  });

  it("agrees with ownsSpecies", () => {
    expect(ownsSpecies(state.party, state.box, "pikachu")).toBe(true);
    expect(ownsSpecies(state.party, state.box, "rattata")).toBe(false);
  });

  it("still yields to the always-catch-shinies override", () => {
    const s = { ...state, alwaysCatchShinies: true } as GameState;
    expect(shouldAutoCatch(s, "r", "pikachu", 10, true)).toBe(true);
  });

  it("respects the per-route disable like every other mode", () => {
    const s = {
      ...state,
      catchSettings: { r1: { lapras: RULE({ mode: "not_owned", enabled: false }) } },
    } as GameState;
    expect(shouldAutoCatch(s, "r1", "lapras", 10, false)).toBe(false);
  });
});
