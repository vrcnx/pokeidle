// What the save actually carries.
//
// ── THE BUG THIS EXISTS FOR ───────────────────────────────────────────────
// Route Mastery shipped with a reducer guard that refused a second claim, a
// save-merge rule that unioned claims from both lineages, and seventeen tests
// covering both. It was still an infinite-item exploit within hours, reported
// by Gshow: "it delivers the prize every time one refreshes (F5) the page."
//
// `claimedMastery` was never added to PERSISTENT_KEYS. The list of tiers
// already paid out was dropped on every save, so each reload started from an
// empty list and re-offered everything. Every guard was correct and none of
// them mattered, because the state they guarded did not survive a refresh.
//
// A guard that is not persisted is not a guard. This file pins that as a
// property rather than trusting anybody to remember it for the next field.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initialState } from "../src/state/initialState";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcDir, ...p), "utf8");

/** The string entries of a `const NAME: ... = [ ... ]` array literal.
 *
 *  Comments are stripped FIRST. These lists are heavily commented — including,
 *  now, with a quoted bug report — and scraping quoted strings out of the raw
 *  text pulls the prose in as if it were a key. That is not hypothetical: it
 *  broke this file the moment the comment explaining the bug was added. */
function stringList(src: string, declaration: string): string[] {
  const at = src.indexOf(declaration);
  if (at < 0) throw new Error(`could not find ${declaration}`);
  const open = src.indexOf("[", at);
  const close = src.indexOf("];", open);
  const body = src.slice(open, close)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const PERSISTENT = stringList(read("state", "GameContext.tsx"), "const PERSISTENT_KEYS");
const MONOTONIC = stringList(read("state", "saveReconcile.ts"), "const MONOTONIC_KEYS");
const SPENDABLE = stringList(read("state", "saveReconcile.ts"), "export const SPENDABLE_KEYS");

describe("everything the merge reasons about is actually saved", () => {
  it("persists every MONOTONIC key", () => {
    // These are the append-only records — badges, dex, claims. Unioning them
    // across two save lineages is meaningless if they are not written in the
    // first place, and for a CLAIM list the failure is not "progress is lost",
    // it is "the reward pays again".
    const missing = MONOTONIC.filter((k) => !PERSISTENT.includes(k));
    expect(missing, `not in PERSISTENT_KEYS: ${missing.join(", ")}`).toEqual([]);
  });

  it("persists every SPENDABLE key", () => {
    // Money, inventory, party, box. A spendable key that is not saved is
    // either a resource that resets or one that cannot be spent down.
    const missing = SPENDABLE.filter((k) => !PERSISTENT.includes(k));
    expect(missing, `not in PERSISTENT_KEYS: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the lists refer to real state", () => {
  it("names only fields that exist on a fresh game", () => {
    // A typo'd key silently persists `undefined` and reads back as absent,
    // which is the same failure with a different cause.
    for (const list of [PERSISTENT, MONOTONIC, SPENDABLE]) {
      for (const k of list) {
        expect(k in initialState, `${k} is not a GameState field`).toBe(true);
      }
    }
  });

  it("still carries the claim lists specifically", () => {
    // Named rather than left to the property above, because these two are the
    // ones where a miss hands out free items rather than losing progress.
    expect(PERSISTENT).toContain("claimedMastery");
    expect(PERSISTENT).toContain("claimedRegionStarters");
  });
});
