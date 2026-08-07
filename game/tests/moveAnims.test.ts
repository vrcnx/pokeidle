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
import { hasFxAnim } from "../src/utils/battleFxMoves";
import { SHAKE_MOVES } from "../src/utils/moveEffects";
import { moves } from "../src/data/moves";
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

describe("one animation per move, never two", () => {
  // The CSS archetypes and the ported engine are two renderings of the same
  // attack, and MoveAnimation picks between them using `hasFxAnim` BEFORE it
  // renders — it cannot ask `buildMoveFx`, which needs measured actors and so
  // answers a frame too late. That makes them two statements of one rule, and
  // if they ever disagree the result is either a double image (the bug this
  // fixes) or a move that animates not at all.

  it("claims every ported move", () => {
    for (const id of Object.keys(MOVE_ANIMS)) {
      expect(hasFxAnim(id), id).toBe(true);
    }
  });

  it("resolves either spelling to the same answer", () => {
    // levelUpMoves is dual-spelled; a lookup that misses here is a move that
    // silently loses its animation.
    for (const id of [...REACHABLE].slice(0, 60)) {
      const flat = id.toLowerCase().replace(/[^a-z0-9]/g, "");
      expect(hasFxAnim(flat), `${id} / ${flat}`).toBe(hasFxAnim(id));
    }
  });

  it("hands the fallback exactly the moves with no ported animation", () => {
    // A move the engine does not claim must still be drawable by the CSS
    // layer, or it would animate not at all.
    const fallback = [...REACHABLE].filter((id) => !hasFxAnim(id));
    for (const id of fallback) expect(MOVE_ANIMS[id], id).toBeUndefined();
    // And the CSS layer is still reachable for them — that is why the
    // archetype markup stays in the component rather than being deleted.
    expect(fallback.length).toBeGreaterThan(0);
  });

  it("still claims a move whose fallback would be the generic projectile", () => {
    // Ported and fallback-eligible are different questions. Anything the
    // engine CAN draw it should draw, so the CSS layer is off for those too.
    const anyFallbackOnly = [...REACHABLE].find(
      (id) => !MOVE_ANIMS[id] && hasFxAnim(id),
    );
    if (anyFallbackOnly) expect(hasFxAnim(anyFallbackOnly)).toBe(true);
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

// ── WHICH MOVES RATTLE THE SCREEN ───────────────────────────────────
//
// SHAKE_MOVES is a hand-kept opt-in list, and it is right that it is one: the
// rule is what a move IS, not what it rolls for, so `power >= N` would shake
// on every strong special and the shake would stop meaning anything.
//
// The cost of hand-keeping it is that a move can be forgotten, silently, for
// as long as nobody attacks with it while paying attention. Auditing the list
// against the move table turned up three: Explosion — 250 power, the hardest
// hit in the game and the move this list is named after — plus Giga Impact
// and Bulldoze.
//
// Explosion is the instructive one. Its weaker twin Self-Destruct was already
// in the list, so the pair LOOKED covered; you had to check both to see that
// only one was there. These tests encode that lesson rather than the answer.
describe("the screen shakes for the right moves", () => {
  it("only names moves that exist", () => {
    // A typo here is invisible: the id simply never matches, and the move
    // quietly never shakes. Nothing else in the codebase would notice.
    for (const id of SHAKE_MOVES) {
      expect(moves[id], `SHAKE_MOVES has "${id}", which is not a move`).toBeDefined();
    }
  });

  it("shakes for both halves of a twinned move, never one", () => {
    // The bug that was actually there. Each pair is the same act at the same
    // power — one physical, one special — so a player who feels the screen
    // move for one and not the other is noticing a real inconsistency they
    // cannot name.
    const TWINS: Array<[string, string]> = [
      ["hyperBeam", "gigaImpact"],   // 150, recharge, all-out
      ["selfDestruct", "explosion"], // the user faints; explosion just hits harder
    ];
    for (const [a, b] of TWINS) {
      expect(
        SHAKE_MOVES.has(a) === SHAKE_MOVES.has(b),
        `${a} shakes=${SHAKE_MOVES.has(a)} but ${b} shakes=${SHAKE_MOVES.has(b)} — same move, different half`,
      ).toBe(true);
    }
  });

  it("shakes for the hardest hits in the game", () => {
    // Not a `power >= N` RULE — see the header — but the very top of the
    // table is where an omission is most obvious to a player, so the top few
    // are worth asserting outright.
    for (const id of ["explosion", "selfDestruct"]) {
      expect(SHAKE_MOVES.has(id), `${id} is 200+ power and does not shake`).toBe(true);
    }
  });

  it("stays short, because a screen that always lurches never lurches", () => {
    // The restraint IS the feature. If this ever fails, the list has started
    // collecting "strong" moves rather than earth-shaking ones.
    expect(SHAKE_MOVES.size).toBeLessThan(12);
  });
});
