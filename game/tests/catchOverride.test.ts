// Per-species catch rules, and being able to get rid of one.
//
// `resolveCatchSettings` is
//     catchSettings[route]?.[species] ?? globalCatchDefaults
// so an override COMPLETELY shadows the default, and SET_GLOBAL_CATCH_DEFAULTS
// only refreshes overrides on the route currently being viewed.
//
// That is correct — a rule you set for one species should not be silently
// rewritten from somewhere else. What was missing is any way to SEE that it
// was happening or to undo it: a player who set a rule for Zubat on Mt. Moon
// at some point, then switched everything to "only shinies", kept catching
// Zubat, and the screen showed them the setting they had chosen while the game
// obeyed a different one.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { initialState } from "../src/state/initialState";
import { resolveCatchSettings } from "../src/utils/catchSettings";
import type { GameState, CatchSettings } from "../src/types";

const SHINY_ONLY: CatchSettings = {
  ...initialState.globalCatchDefaults,
  mode: "shiny_only",
};
const ALWAYS: CatchSettings = {
  ...initialState.globalCatchDefaults,
  mode: "always",
};

/** A save whose default is "only shinies" but which has an old Zubat rule. */
const withOverride = (): GameState => ({
  ...initialState,
  globalCatchDefaults: SHINY_ONLY,
  catchSettings: { mtMoon: { zubat: ALWAYS, geodude: ALWAYS } },
});

describe("the shadowing that caused the report", () => {
  it("really does ignore the default — this is the reported behaviour", () => {
    const s = withOverride();
    expect(resolveCatchSettings(s, "mtMoon", "zubat").mode).toBe("always");
    // And the species with no override follows it, which is why the screen
    // looked correct: most rows agreed.
    expect(resolveCatchSettings(s, "mtMoon", "paras").mode).toBe("shiny_only");
  });
});

describe("clearing an override", () => {
  it("hands the species back to the default", () => {
    const s = reducer(withOverride(), {
      type: "CLEAR_CATCH_RULE",
      payload: { routeKey: "mtMoon", speciesKey: "zubat" },
    } as never);
    expect(resolveCatchSettings(s, "mtMoon", "zubat").mode).toBe("shiny_only");
  });

  it("leaves the other overrides alone", () => {
    const s = reducer(withOverride(), {
      type: "CLEAR_CATCH_RULE",
      payload: { routeKey: "mtMoon", speciesKey: "zubat" },
    } as never);
    expect(resolveCatchSettings(s, "mtMoon", "geodude").mode).toBe("always");
  });

  it("keeps FOLLOWING the default afterwards", () => {
    // The reason this deletes rather than writing the current default in: an
    // override that merely agrees today would stop following the default the
    // next time it changed, which is the same bug again one step later.
    let s = reducer(withOverride(), {
      type: "CLEAR_CATCH_RULE",
      payload: { routeKey: "mtMoon", speciesKey: "zubat" },
    } as never);
    s = { ...s, globalCatchDefaults: ALWAYS };
    expect(resolveCatchSettings(s, "mtMoon", "zubat").mode).toBe("always");
  });

  it("drops the route bucket once it is empty", () => {
    // Otherwise catchSettings accumulates a key for every route the player
    // ever opened the screen on, forever, in every save upload.
    let s = withOverride();
    for (const sp of ["zubat", "geodude"]) {
      s = reducer(s, { type: "CLEAR_CATCH_RULE", payload: { routeKey: "mtMoon", speciesKey: sp } } as never);
    }
    expect(s.catchSettings.mtMoon).toBeUndefined();
  });

  it("is a no-op when there is nothing to clear", () => {
    const s = withOverride();
    expect(reducer(s, {
      type: "CLEAR_CATCH_RULE",
      payload: { routeKey: "mtMoon", speciesKey: "paras" },
    } as never)).toBe(s);
    expect(reducer(s, {
      type: "CLEAR_CATCH_RULE",
      payload: { routeKey: "viridianForest", speciesKey: "pikachu" },
    } as never)).toBe(s);
  });
});
