// The move table is generation 9, and stays generation 9.
//
// ══ WHY THIS EXISTS ═════════════════════════════════════════════════
//
// Move rows get edited one field at a time, and a row that is updated
// partially looks exactly like a row that was updated fully. Two had already
// drifted before anyone checked:
//
//   Fire Blast      Gen 9 power (110) beside Gen 1's 30% burn chance
//   High Jump Kick  still on the Gen 4 power of 100; it has been 130 since
//                   Gen 5
//
// Neither is visible by reading the file. Both are obvious the moment the row
// is compared against the generation it claims to be.
//
// It matters more now than it did, because src/data/moveDescriptions.ts turns
// every one of these rows into a SENTENCE SHOWN TO PLAYERS. "10% chance to
// burn the target" on a move that burns 30% of the time is not a stale
// constant, it is the game telling somebody something untrue. This test is
// what lets those descriptions be imported wholesale instead of hand-checked.
//
// The house rule is the latest generation, always. When @pkmn/dex ships a
// generation 10, changing GEN below turns this into the complete list of rows
// that need attention.

import { describe, expect, it } from "vitest";
import { Dex } from "@pkmn/dex";
import { moves } from "../src/data/moves";
import { moveDescriptions } from "../src/data/moveDescriptions";

const GEN = 9;
const dex = Dex.forGen(GEN);

/** Showdown's key for a move: display name, lowercased, alphanumerics only. */
const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Moves this game defines that Showdown has never heard of.
 *
 * Original content, so there is nothing to compare them against and nothing
 * to import a description from. Listed explicitly rather than skipped by a
 * `!exists` check, so that a move failing to match because of a TYPO in its
 * name is a failure rather than a silent exemption.
 */
const OURS_ALONE = new Set(["Nihil Light"]);

/**
 * Moves whose power we store as a number and Showdown stores as 0.
 *
 * Not a disagreement about behaviour — a disagreement about representation.
 * These deal fixed, level-based or weight-based damage, which Showdown
 * computes in code and flags with `basePower: 0`. Our engine carries a
 * nominal figure instead.
 *
 * Kept as an explicit list, and asserted to be EXACTLY right below, so a
 * genuine power drift cannot hide behind "oh, that one's special".
 */
const COMPUTED_POWER = new Set([
  "Dragon Rage",   // fixed 40
  "Sonic Boom",    // fixed 20
  "Seismic Toss",  // user's level
  "Low Kick",      // target's weight
  "Magnitude",     // random 10–150
  "Counter",       // 2× damage taken
]);

const rows = Object.entries(moves).filter(([, m]) => !OURS_ALONE.has(m.name));

describe(`every move matches generation ${GEN}`, () => {
  it("finds all of them in the dex — a miss means a typo, not a new move", () => {
    const missing = rows
      .filter(([, m]) => !dex.moves.get(keyOf(m.name))?.exists)
      .map(([, m]) => m.name);
    expect(missing, "add to OURS_ALONE only if genuinely original").toEqual([]);
  });

  it("agrees on power", () => {
    const off = rows
      .filter(([, m]) => !COMPUTED_POWER.has(m.name))
      .map(([, m]) => [m, dex.moves.get(keyOf(m.name))] as const)
      .filter(([m, t]) => t?.exists && (t.basePower ?? 0) !== (m.power ?? 0))
      .map(([m, t]) => `${m.name}: ours ${m.power}, gen${GEN} ${t!.basePower}`);
    expect(off).toEqual([]);
  });

  it("agrees on accuracy", () => {
    const off = rows
      .map(([, m]) => [m, dex.moves.get(keyOf(m.name))] as const)
      .filter(([m, t]) => {
        if (!t?.exists) return false;
        const theirs = t.accuracy === true ? 100 : t.accuracy;
        return theirs !== m.accuracy;
      })
      .map(([m, t]) => `${m.name}: ours ${m.accuracy}, gen${GEN} ${t!.accuracy}`);
    expect(off).toEqual([]);
  });

  it("agrees on type and category", () => {
    const off = rows
      .map(([, m]) => [m, dex.moves.get(keyOf(m.name))] as const)
      .filter(([m, t]) => t?.exists && (
        String(t.type) !== String(m.type) ||
        String(t.category).toLowerCase() !== String(m.category).toLowerCase()
      ))
      .map(([m, t]) => `${m.name}: ours ${m.type}/${m.category}, gen${GEN} ${t!.type}/${t!.category}`);
    expect(off).toEqual([]);
  });

  it("agrees on secondary-effect chance — the numbers descriptions quote", () => {
    const off: string[] = [];
    for (const [, m] of rows) {
      const eff = (m as { effect?: { type: string; chance?: number } }).effect;
      if (!eff || (eff.type !== "inflictStatus" && eff.type !== "confuse")) continue;
      const t = dex.moves.get(keyOf(m.name));
      if (!t?.exists) continue;
      // A PRIMARY effect (Thunder Wave, Toxic, Sleep Powder, and — via
      // `volatileStatus` rather than `status` — Supersonic and Confuse Ray)
      // lands whenever the move hits, so Showdown records no secondary chance
      // at all. Ours is 100%, and that agrees.
      //
      // Checking only `status` was this test's own bug: it read the two
      // confusion moves as 100%-vs-nothing drift when they are modelled
      // correctly on both sides. Compare `Confusion`, which really does carry
      // a 10% secondary volatileStatus and belongs on the branch below.
      if (t.status || t.volatileStatus) {
        if (Math.round((eff.chance ?? 0) * 100) !== 100) {
          off.push(`${m.name}: primary status but ours is ${Math.round((eff.chance ?? 0) * 100)}%`);
        }
        continue;
      }
      const theirs = t.secondary?.chance ?? t.secondaries?.[0]?.chance ?? null;
      const ours = Math.round((eff.chance ?? 0) * 100);
      if (theirs !== ours) off.push(`${m.name}: ours ${ours}%, gen${GEN} ${theirs ?? "none"}%`);
    }
    expect(off).toEqual([]);
  });

  it("keeps COMPUTED_POWER honest — every entry really is one", () => {
    // Otherwise the exemption list becomes a place to hide a real drift. If
    // Showdown ever gives one of these a real base power, this fails and the
    // name has to come off the list.
    const notActually = [...COMPUTED_POWER].filter((name) => {
      const t = dex.moves.get(keyOf(name));
      return t?.exists && (t.basePower ?? 0) !== 0;
    });
    expect(notActually, "these have a real base power now").toEqual([]);
  });
});

describe("descriptions describe THIS game", () => {
  it("has a line for every move that is not ours alone", () => {
    const without = rows.filter(([id]) => !moveDescriptions[id]).map(([, m]) => m.name);
    expect(without, "re-run scripts/gen-move-descriptions.mjs").toEqual([]);
  });

  it("quotes a percentage that matches the move's own chance", () => {
    // The specific failure this is here for: importing "10% chance to burn"
    // onto a Fire Blast that burns 30% of the time. The generation checks
    // above are what make this pass; this asserts the CONSEQUENCE directly, so
    // the reason the import is safe is stated where the import happens.
    const lies: string[] = [];
    for (const [id, m] of rows) {
      const eff = (m as { effect?: { type: string; chance?: number } }).effect;
      const desc = moveDescriptions[id];
      if (!eff || !desc || eff.chance === undefined) continue;
      if (eff.type !== "inflictStatus" && eff.type !== "confuse") continue;
      const quoted = desc.match(/(\d+)%/);
      if (!quoted) continue;
      const ours = Math.round(eff.chance * 100);
      if (Number(quoted[1]) !== ours) lies.push(`${m.name}: says ${quoted[1]}%, is ${ours}%`);
    }
    expect(lies).toEqual([]);
  });
});
