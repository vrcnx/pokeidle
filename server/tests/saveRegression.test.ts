// The versionless-write regression guard: a blind write (no
// expectedSaveVersion) may ADD, never SUBTRACT. This session watched a
// versionless POST of a pre-prize blob erase a delivered Master Ball, take
// a wallet from 900,000 to 1 and empty a three-Pokémon box — while leaving
// every milestone field identical. These tests pin both comparators.
//
// Pure module — no DB, no socket, nothing to stub.

import { describe, expect, it } from "vitest";
import {
  milestoneSig,
  milestoneRegressed,
  destructiveLosses,
} from "../src/lib/saveRegression.js";

const mon = (id: string) => ({ id, speciesKey: "pikachu", level: 5 });

describe("milestoneSig / milestoneRegressed", () => {
  const before = milestoneSig({
    defeatedGyms: ["g1", "g2"],
    defeatedEliteFour: ["e1"],
    championDefeated: true,
    pokedexCaught: ["a", "b", "c"],
  });

  it("flags losing a badge / E4 / champion / dex entry", () => {
    expect(milestoneRegressed(before, { ...before, badges: 1 })).toBe(true);
    expect(milestoneRegressed(before, { ...before, e4: 0 })).toBe(true);
    expect(milestoneRegressed(before, { ...before, champion: false })).toBe(true);
    expect(milestoneRegressed(before, { ...before, caught: 2 })).toBe(true);
  });

  it("allows pure progress", () => {
    expect(milestoneRegressed(before, { badges: 3, e4: 2, champion: true, caught: 4 })).toBe(false);
    expect(milestoneRegressed(before, before)).toBe(false);
  });
});

describe("destructiveLosses — blind write may add, never subtract", () => {
  const prior = {
    money: 900_000,
    victoryTokens: 7,
    inventory: { masterball: 5, pokeball: 10 },
    party: [mon("p1")],
    box: [mon("b1"), mon("b2")],
    pokedexSeen: ["a", "b", "c"],
    shinyCaught: ["a"],
    shinySeen: ["a", "b"],
    claimedRegionStarters: ["johto"],
  };

  it("reports every dimension the measured incident actually destroyed", () => {
    const next = {
      ...prior,
      money: 1,                                  // wallet 900,000 → 1
      inventory: { masterball: 4, pokeball: 210 }, // the prize ball, gone —
      party: [mon("p1")],                          // even though pokeballs GREW
      box: [],                                     // box emptied
    };
    const losses = destructiveLosses(prior, next);
    const fields = losses.map((l) => l.field);
    expect(fields).toContain("money");
    expect(fields).toContain("inventory.masterball");
    expect(fields).toContain("pokemon");
    const money = losses.find((l) => l.field === "money")!;
    expect(money).toMatchObject({ before: 900_000, after: 1 });
  });

  it("per item KEY, not total count: +200 pokeballs cannot hide -1 masterball", () => {
    const next = { ...prior, inventory: { masterball: 4, pokeball: 999 } };
    const losses = destructiveLosses(prior, next);
    expect(losses).toEqual([
      { field: "inventory.masterball", before: 5, after: 4 },
    ]);
  });

  it("identity, not headcount: swapping a mon keeps box length but is still a loss", () => {
    const next = { ...prior, box: [mon("b1"), mon("rattata999")] };
    const losses = destructiveLosses(prior, next);
    expect(losses).toEqual([{ field: "pokemon", before: 3, after: 2 }]);
  });

  it("append-only lists shrinking is a loss", () => {
    const next = { ...prior, pokedexSeen: ["a"] };
    expect(destructiveLosses(prior, next).map((l) => l.field)).toEqual(["pokedexSeen"]);
  });

  it("pure addition is never a loss", () => {
    const next = {
      ...prior,
      money: 950_000,
      victoryTokens: 8,
      inventory: { ...prior.inventory, masterball: 6, greatball: 3 },
      box: [...prior.box, mon("b3")],
      pokedexSeen: [...prior.pokedexSeen, "d"],
    };
    expect(destructiveLosses(prior, next)).toEqual([]);
  });

  it("is defensive about garbage shapes on both sides", () => {
    expect(destructiveLosses({}, {})).toEqual([]);
    expect(destructiveLosses({ money: "lots" as never, inventory: [] as never }, { money: 0 })).toEqual([]);
    // Mons without a string id are untracked and must not manufacture a loss.
    expect(
      destructiveLosses({ box: [{ speciesKey: "x" }, null] }, { box: [] }),
    ).toEqual([]);
  });
});
