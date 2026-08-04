// The vendored effect sprites and the tables that reference them.
//
// Two failure modes here are silent, which is why they are tested rather than
// eyeballed:
//
//   A sprite NAME that was never vendored. showEffect skips an unknown name
//   on purpose — several are deliberately not shipped because their art is
//   GPL — so a typo does not throw, it just makes the move's effect quietly
//   disappear, and you only find out by watching that one move.
//
//   A GPL file sneaking back in. The exclusions live in scripts/pull-fx.mjs,
//   but a hand-copied PNG or a careless re-run would not be noticed by
//   anything else. public/fx/PROVENANCE.md is the promise; this checks it.

import { describe, expect, it } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FX_SPRITES } from "../src/data/battleFxSprites";
import { BEAM_MOVES, TYPE_SPRITE } from "../src/utils/battleFxMoves";
import { moves as movesTable } from "../src/data/moves";
import { canonicalMoveId } from "../src/utils/moves";

const fxDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "fx");

/** Carved out of Showdown's CC0 grant — see the header of their
 *  battle-animations.ts, quoted in PROVENANCE.md. */
const MUST_NOT_SHIP = [
  "icicle.png", "icicle-pink.png", "lightning.png", "bone.png",
  "rocks.png", "rock1.png", "rock2.png",
];

describe("what we shipped", () => {
  it("has a real file behind every entry in the table", () => {
    for (const [name, s] of Object.entries(FX_SPRITES)) {
      expect(s.url.startsWith("/fx/"), `${name}: ${s.url}`).toBe(true);
      expect(existsSync(join(fxDir, s.url.slice("/fx/".length))), `${name} missing`).toBe(true);
    }
  });

  it("ships no GPL or unlicensed art", () => {
    const onDisk = new Set(readdirSync(fxDir));
    for (const f of MUST_NOT_SHIP) {
      expect(onDisk.has(f), `${f} must not be vendored — see public/fx/PROVENANCE.md`).toBe(false);
    }
  });

  it("keeps a provenance file next to the art", () => {
    // CC0 needs no attribution, but "where did these come from and what was
    // deliberately left out" is the question somebody will have later.
    expect(existsSync(join(fxDir, "PROVENANCE.md"))).toBe(true);
  });

  it("gives every sprite a positive display size", () => {
    // showEffect scales by these, not by the file's intrinsic size, so a zero
    // collapses the sprite to nothing with no error anywhere.
    for (const [name, s] of Object.entries(FX_SPRITES)) {
      expect(s.w, name).toBeGreaterThan(0);
      expect(s.h, name).toBeGreaterThan(0);
    }
  });
});

describe("the tables only name sprites we have", () => {
  it("resolves every type's projectile", () => {
    // THE typo test. A name not in FX_SPRITES makes that whole type's special
    // moves lose their effect, silently.
    for (const [type, sprite] of Object.entries(TYPE_SPRITE)) {
      expect(FX_SPRITES[sprite!], `${type} -> ${sprite}`).toBeTruthy();
    }
  });

  it("covers every type that has a special move in the game", () => {
    const needed = new Set(
      Object.values(movesTable)
        .filter((m) => m.category === "special")
        .map((m) => m.type),
    );
    const missing = [...needed].filter((t) => !TYPE_SPRITE[t]);
    expect(missing, `types with special moves but no projectile: ${missing.join(", ")}`)
      .toEqual([]);
  });
});

describe("the beam list is real moves", () => {
  it("names only moves that exist", () => {
    // These ids are hand-written. A misspelt one is not an error — it just
    // means that move quietly throws a ball instead of firing a beam.
    const unknown = [...BEAM_MOVES].filter((id) => !movesTable[id]);
    expect(unknown, `not in the move table: ${unknown.join(", ")}`).toEqual([]);
  });

  it("names only SPECIAL moves", () => {
    // A physical move in here would be given a projectile and never lunge.
    const wrong = [...BEAM_MOVES].filter((id) => movesTable[id]?.category !== "special");
    expect(wrong, `not special: ${wrong.join(", ")}`).toEqual([]);
  });

  it("is stored canonically, so lookups cannot miss on spelling", () => {
    for (const id of BEAM_MOVES) expect(canonicalMoveId(id)).toBe(id);
  });
});
