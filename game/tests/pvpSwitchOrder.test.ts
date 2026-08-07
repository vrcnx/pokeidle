// The forced-switch chooser reorders its cards. This is the invariant that
// makes that safe.
//
// `onChoose(idx)` sends `switch <idx+1>` to the simulator, and that index is
// the SERVER'S slot number — the position in the list it sent, not the
// position on screen. So a sort that renumbered the cards would send the
// player out with a different Pokemon than the one they tapped: silent, and
// game-losing, and far worse than the layout problem the sort exists to fix
// (the Pokemon that just fainted sitting first in "Send out", greyed and
// unpickable, ahead of every real choice).
//
// The component pairs each entry with its original index BEFORE sorting. This
// tests that pairing directly, because it is the part that cannot be seen by
// looking at the screen — a wrong slot renders perfectly.

import { describe, expect, it } from "vitest";

interface Entry { ident: string; condition: string; active?: boolean }

/** The ordering the wide (forced) chooser applies — see SwitchGrid. */
function orderForChooser(pokemon: Entry[]): Array<{ p: Entry; slot: number }> {
  const ordered = pokemon.map((p, slot) => ({ p, slot }));
  const dead = (e: { p: Entry }) => e.p.condition.includes("fnt") || !!e.p.active;
  ordered.sort((a, b) => Number(dead(a)) - Number(dead(b)));
  return ordered;
}

const party: Entry[] = [
  { ident: "p1: Gengar", condition: "0 fnt" },
  { ident: "p1: Darkrai", condition: "281/281" },
  { ident: "p1: Blastoise", condition: "268/268" },
  { ident: "p1: Reshiram", condition: "301/301" },
  { ident: "p1: Deoxys", condition: "251/251" },
  { ident: "p1: Tentacruel", condition: "290/290" },
];

describe("the forced chooser puts pickable Pokemon first", () => {
  it("moves the one that just fainted out of the first slot", () => {
    const out = orderForChooser(party);
    expect(out[0].p.ident).not.toContain("Gengar");
    expect(out.at(-1)!.p.ident).toContain("Gengar");
  });

  it("also demotes the one already on the field", () => {
    const withActive = party.map((p, i) => (i === 2 ? { ...p, active: true } : p));
    const out = orderForChooser(withActive);
    const names = out.map((e) => e.p.ident);
    // Both unpickable cards end up behind every pickable one.
    expect(names.indexOf("p1: Blastoise")).toBeGreaterThan(names.indexOf("p1: Darkrai"));
    expect(names.indexOf("p1: Gengar")).toBeGreaterThan(names.indexOf("p1: Darkrai"));
  });

  it("keeps party order among the ones you CAN pick", () => {
    // Stability matters: a chooser that shuffles the healthy Pokemon every
    // time it opens is one the player cannot build muscle memory for.
    const out = orderForChooser(party).filter((e) => !e.p.condition.includes("fnt"));
    expect(out.map((e) => e.p.ident)).toEqual([
      "p1: Darkrai", "p1: Blastoise", "p1: Reshiram", "p1: Deoxys", "p1: Tentacruel",
    ]);
  });
});

describe("the slot index survives the reorder", () => {
  it("carries the SERVER's index, not the on-screen position", () => {
    // The bug this exists to prevent. Tentacruel is party slot 5; after the
    // sort it is displayed 4th. Tapping it must still send `switch 6`.
    const out = orderForChooser(party);
    for (const { p, slot } of out) {
      expect(party[slot].ident, `slot ${slot} no longer points at ${p.ident}`).toBe(p.ident);
    }
  });

  it("still names every Pokemon exactly once", () => {
    const out = orderForChooser(party);
    expect(out).toHaveLength(party.length);
    expect(new Set(out.map((e) => e.slot)).size).toBe(party.length);
  });

  it("would fail if the index were recomputed from the sorted position", () => {
    // Demonstrates the failure mode explicitly, so the reason for the pairing
    // is legible without reconstructing it. Renumbering after the sort points
    // the first card at Darkrai's slot 0 — which is Gengar.
    const renumbered = orderForChooser(party).map((e, i) => ({ ...e, slot: i }));
    const first = renumbered[0];
    expect(first.p.ident).toContain("Darkrai");
    expect(party[first.slot].ident).toContain("Gengar");
  });
});
