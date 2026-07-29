// The opponent-trainer slide-in ignored the game-speed setting
// (br_7362030de4444c8da8): "when the opponent trainer briefly appears at the
// start of battle and when swapping pokemon, that animation isnt affected by
// the game speed". At ×5 the loop ticks every 200ms and everything else is
// fast, but every trainer mon — the first AND every send-next — still cost a
// flat 1.8 seconds of nothing happening.
//
// The timing was hardcoded THREE times in two languages (the CSS animation
// duration, the CSS delay holding the Pokémon off-screen, and the loop's own
// settle window) with nothing linking them. These tests pin the two properties
// that matter: ×1 is unchanged, and the three numbers stay in step at every
// speed — including speed values stream chat can set, which the reducer does
// not clamp.

import { describe, expect, it } from "vitest";
import {
  battleSpeedScale, enemySettleMs, tickIntervalFor,
  trainerIntroMs, trainerIntroPokemonDelayMs,
  TRAINER_INTRO_BASE_MS, TRAINER_INTRO_POKEMON_DELAY_BASE_MS, WILD_APPEAR_BASE_MS,
} from "../src/utils/battleTiming";

describe("x1 is byte-for-byte the old behaviour", () => {
  it("keeps the original intro, entrance delay and settle windows", () => {
    expect(trainerIntroMs(1)).toBe(TRAINER_INTRO_BASE_MS);
    expect(trainerIntroMs(1)).toBe(1500);
    expect(trainerIntroPokemonDelayMs(1)).toBe(TRAINER_INTRO_POKEMON_DELAY_BASE_MS);
    expect(trainerIntroPokemonDelayMs(1)).toBe(1100);
    // The loop waited a flat 1800 / 700ms before firing the first turn.
    expect(enemySettleMs(1, true)).toBe(1800);
    expect(enemySettleMs(1, false)).toBe(700);
    expect(WILD_APPEAR_BASE_MS).toBe(700);
  });
});

describe("the intro scales with game speed", () => {
  it("tracks the simulation tick rather than a private curve", () => {
    expect(battleSpeedScale(1)).toBe(tickIntervalFor(1) / 1000);
    expect(battleSpeedScale(2)).toBe(0.5);
    expect(battleSpeedScale(5)).toBe(0.2);
  });

  it("compresses at x2", () => {
    expect(trainerIntroMs(2)).toBe(750);
    expect(enemySettleMs(2, true)).toBe(900);
    expect(enemySettleMs(2, false)).toBe(350);
  });

  it("compresses at x5 — the reported case", () => {
    expect(trainerIntroMs(5)).toBe(300);
    expect(enemySettleMs(5, true)).toBe(360);
    expect(enemySettleMs(5, false)).toBe(140);
  });

  it("reclaims most of the dead time at x5", () => {
    // 1800 -> 360ms per trainer mon: 1.44s, or ~7 ticks at a 200ms tick.
    const reclaimed = enemySettleMs(1, true) - enemySettleMs(5, true);
    expect(reclaimed).toBe(1440);
    expect(reclaimed / tickIntervalFor(5)).toBeGreaterThan(5);
  });

  it("is monotonic — faster is never slower", () => {
    expect(trainerIntroMs(1)).toBeGreaterThan(trainerIntroMs(2));
    expect(trainerIntroMs(2)).toBeGreaterThan(trainerIntroMs(5));
    expect(enemySettleMs(1, true)).toBeGreaterThan(enemySettleMs(2, true));
    expect(enemySettleMs(2, true)).toBeGreaterThan(enemySettleMs(5, true));
  });
});

describe("the loop and the sprite stay in step", () => {
  it("never fires a turn before the Pokemon has finished appearing", () => {
    // This is the invariant that breaks if only ONE of the three numbers is
    // scaled: the loop would swing at a sprite still off-screen.
    for (const speed of [1, 2, 3, 5, 7, 10]) {
      expect(enemySettleMs(speed, true)).toBeGreaterThanOrEqual(trainerIntroPokemonDelayMs(speed));
    }
  });

  it("holds a trainer mon longer than a wild one at every speed", () => {
    for (const speed of [1, 2, 5]) {
      expect(enemySettleMs(speed, true)).toBeGreaterThan(enemySettleMs(speed, false));
    }
  });
});

describe("speed values the reducer does not clamp", () => {
  // utils/streamCommands.ts dispatches SET_SPEED with whatever chat sent, and
  // SET_SPEED stores it as-is. A class-per-speed CSS ruleset would have fallen
  // back to full speed for these; anchoring to the tick cannot.
  it("never produces a zero, negative or non-finite duration", () => {
    for (const speed of [0, -3, 0.5, 3, 7, 1000, NaN, Infinity]) {
      for (const fromTrainer of [true, false]) {
        const v = enemySettleMs(speed, fromTrainer);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      expect(trainerIntroMs(speed)).toBeGreaterThan(0);
      expect(trainerIntroPokemonDelayMs(speed)).toBeGreaterThan(0);
    }
  });

  it("treats an unknown fast speed like the fastest known one", () => {
    expect(enemySettleMs(1000, true)).toBe(enemySettleMs(5, true));
  });
});
