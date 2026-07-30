// The Master Ball must never be spent by automation.
//
// br_3a5bc2b26425b58611 (ma62087, 2026-07-30): "When I left everything in
// capture mode and only selected the Poke Ball (from normal to ultra) and ran
// out of Poke Balls, my Master Ball was used directly. The thing is, I never
// selected it to catch any Pokemon."
//
// Root cause: ballForAutoCatch's emergency fallback for a shiny read
// `BALL_ORDER.find((b) => inventory[b] > 0)`, and BALL_ORDER is
// ["pokeball", "greatball", "ultraball", "masterball"] — so with the first
// three exhausted, `.find` returned the Master Ball. The fallback's intent is
// sound (better the wrong ball than losing a shiny) but the Master Ball is the
// rarest item in the game: the largest holding anywhere in production is 9,
// and it is unbuyable (buyPrice null) and unsellable. Spending one with no
// prompt is not a recoverable mistake.
//
// These pin the boundary in both directions: automation may never reach for
// it, and a player who deliberately enables it still gets it.

import { describe, expect, it } from "vitest";
import { ballForAutoCatch } from "../src/utils/catching";
import type { GameState } from "../src/types";

/** Minimal state for the ball picker: inventory + catch settings. */
function stateWith(
  inventory: Record<string, number>,
  over: Partial<GameState> = {},
): GameState {
  return {
    alwaysCatchShinies: true,
    inventory,
    catchSettings: {},
    globalCatchDefaults: {
      enabled: true,
      mode: "always",
      levelThreshold: 1,
      enabledBalls: ["pokeball"],
    },
    party: [],
    box: [],
    pokedexCaught: [],
    ...over,
  } as unknown as GameState;
}

describe("ballForAutoCatch — the Master Ball is never spent by automation", () => {
  it("does NOT reach for the Master Ball when the enabled balls are exhausted", () => {
    // ma62087's exact situation: only Poke Ball selected, zero left, one
    // Master Ball banked, a shiny appears with alwaysCatchShinies on.
    const s = stateWith({ pokeball: 0, greatball: 0, ultraball: 0, masterball: 1 });
    expect(ballForAutoCatch(s, "route1", "pidgey", true)).toBeNull();
  });

  it("still falls back to a lesser ball rather than losing the shiny", () => {
    // The fallback's purpose is intact: an Ultra Ball is fair game.
    const s = stateWith({ pokeball: 0, greatball: 0, ultraball: 4, masterball: 1 });
    expect(ballForAutoCatch(s, "route1", "pidgey", true)).toBe("ultraball");
  });

  it("prefers the enabled ball when it IS in stock", () => {
    const s = stateWith({ pokeball: 5, greatball: 0, ultraball: 0, masterball: 1 });
    expect(ballForAutoCatch(s, "route1", "pidgey", true)).toBe("pokeball");
  });

  it("DOES use the Master Ball when the player enabled it themselves", () => {
    // The other half of the boundary. Excluding it from the fallback must not
    // make it unusable — a deliberate choice is still honoured.
    const s = stateWith(
      { pokeball: 0, greatball: 0, ultraball: 0, masterball: 1 },
      {
        globalCatchDefaults: {
          enabled: true,
          mode: "always",
          levelThreshold: 1,
          enabledBalls: ["masterball"],
        },
      } as Partial<GameState>,
    );
    expect(ballForAutoCatch(s, "route1", "pidgey", true)).toBe("masterball");
  });

  it("never returns the Master Ball for a NON-shiny either", () => {
    // The non-shiny path goes straight to pickAutoBall, which filters on
    // enabledBalls — so an unselected Master Ball is already unreachable
    // there. Pinned so a future "helpful" fallback on this path cannot be
    // added without failing a test.
    const s = stateWith({ pokeball: 0, greatball: 0, ultraball: 0, masterball: 3 });
    expect(ballForAutoCatch(s, "route1", "rattata", false)).toBeNull();
  });

  it("returns null rather than any ball when the bag is empty", () => {
    const s = stateWith({ pokeball: 0, greatball: 0, ultraball: 0, masterball: 0 });
    expect(ballForAutoCatch(s, "route1", "pidgey", true)).toBeNull();
  });
});
