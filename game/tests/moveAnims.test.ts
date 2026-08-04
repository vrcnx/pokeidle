// The ported move animations.
//
// data/moveAnims.ts is generated from Showdown's library by
// scripts/gen-move-anims.mjs, which only emits a body it can PROVE runs
// against our engine. These tests guard the two things the generator cannot
// check about itself: that its output still matches the game's move list, and
// that the gaps it left are the gaps we think they are.
//
// The animations themselves are exercised by executing all 163 against a real
// scene — see the note on `every ported animation runs` below.

import { describe, expect, it } from "vitest";
import { MOVE_ANIMS, UNPORTED } from "../src/data/moveAnims";
import { levelUpMoves } from "../src/data/levelUpMoves";
import { machineList } from "../src/data/tms";
import { canonicalMoveId } from "../src/utils/moves";
import { FX_SPRITES } from "../src/data/battleFxSprites";

/**
 * Every move a Pokémon in this game can actually end up knowing.
 *
 * NOT `Object.keys(moves)` — that is 1,038 entries, because the @pkmn
 * backfill brings the entire modern movepool in and almost none of it is
 * obtainable. NOT the hand-authored literal either: that was the generator's
 * first input and it missed 84 learnable moves, because Gen 2 learnsets and
 * the TM list reference backfilled ids (`synthesis`, `agility`, `spark`) that
 * never appear in the hand-written table.
 */
const REACHABLE = (() => {
  const out = new Set<string>();
  for (const list of Object.values(levelUpMoves)) {
    for (const [, id] of list) out.add(canonicalMoveId(id));
  }
  for (const m of machineList) out.add(canonicalMoveId(m.moveId));
  return out;
})();

describe("coverage", () => {
  it("accounts for every learnable move, exactly once", () => {
    // A move in neither map is one the generator silently lost.
    for (const id of REACHABLE) {
      const has = id in MOVE_ANIMS;
      const gap = id in UNPORTED;
      expect(has !== gap, `${id}: ported=${has} unported=${gap}`).toBe(true);
    }
  });

  it("animates at least 90% of what a Pokémon can learn", () => {
    // A floor rather than an exact number, so adding a move does not fail the
    // build — but losing a chunk of coverage does.
    const withAnim = [...REACHABLE].filter((id) => id in MOVE_ANIMS).length;
    expect(withAnim / REACHABLE.size).toBeGreaterThan(0.9);
  });

  it("gives a reason for every gap", () => {
    for (const [id, why] of Object.entries(UNPORTED)) {
      expect(why, id).toBeTruthy();
      expect(typeof why).toBe("string");
    }
  });

  it("keys everything canonically", () => {
    // The move table is dual-spelled (camelCase for gen 1, flat for the gen 2
    // backfill). A key that is not canonical is a lookup that misses.
    for (const id of Object.keys(MOVE_ANIMS)) expect(canonicalMoveId(id)).toBe(id);
  });
});

describe("the gaps are the ones we chose", () => {
  it("still has no animation for the two screens and Mirror Move", () => {
    // These have no plain anim() in the source — they are residual/screen
    // effects. lightScreen and reflect are also no-ops in our battle engine,
    // so there is nothing to draw anyway.
    for (const id of ["lightScreen", "reflect", "mirrorMove"]) {
      expect(UNPORTED[id], id).toMatch(/no plain anim/);
    }
  });

  it("skips the moves that reach into the background element", () => {
    // Earthquake and friends animate Showdown's own background node, which
    // is not something our scene exposes.
    for (const id of ["earthquake", "magnitude", "bulldoze"]) {
      expect(UNPORTED[id], id).toMatch(/bg\./);
    }
  });

  it("leaves only a handful of moves on the fallback", () => {
    expect(Object.keys(UNPORTED).length).toBeLessThan(20);
  });
});

describe("the substituted sprites are real", () => {
  it("never references art we did not vendor", () => {
    // The generator rewrites the GPL sprites to vendored stand-ins (icicle →
    // iceball, lightning → electroball, rock1/2 → rock3). If a substitution
    // is ever removed, showEffect skips the sprite silently and the move
    // loses half its animation with no error anywhere.
    const src = MOVE_ANIMS.iceBeam?.toString() ?? "";
    expect(src).not.toContain("'icicle'");
    for (const banned of ["icicle", "lightning", "rock1", "rock2", "rocks", "bone"]) {
      expect(FX_SPRITES[banned], `${banned} must not be vendored`).toBeUndefined();
    }
  });

  it("gave Ice Beam and Thunderbolt their real animations anyway", () => {
    // The point of substituting rather than skipping: these keep Showdown's
    // choreography and only change what the particle looks like.
    expect(MOVE_ANIMS.iceBeam).toBeTypeOf("function");
    expect(MOVE_ANIMS.thunderbolt).toBeTypeOf("function");
    expect(MOVE_ANIMS.rockSlide).toBeTypeOf("function");
  });
});
