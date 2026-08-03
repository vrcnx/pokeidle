// The auction's suggested value.
//
// This is a SUGGESTION, never a floor or a cap, so the tests are not about
// hitting particular numbers — a valuation nobody can tune is worse than one
// nobody agrees with. They are about the ORDERING holding: the things a
// player believes make a Pokémon valuable must actually move the number, in
// the right direction, by an amount that matches how rare they are.
//
// If any of these ever flips, the suggestion is actively misleading, which
// is worse than showing nothing.

import { describe, expect, it } from "vitest";
import { valuePokemon, suggestedStartingBid, roundToNice, explain } from "../src/utils/pokemonValue";
import { makeMon } from "./helpers";
import type { Pokemon } from "../src/types";

const ivs = (n: number) => ({
  hp: n, attack: n, defense: n, spAttack: n, spDefense: n, speed: n,
});
const mon = (o: Partial<Pokemon> = {}) => makeMon({ ivs: ivs(15), level: 50, ...o });
const val = (o: Partial<Pokemon> = {}) => valuePokemon(mon(o)).value;

describe("the ordering a player would expect", () => {
  it("prices a shiny far above the same Pokémon that is not", () => {
    const plain = val();
    const shiny = val({ isShiny: true });
    expect(shiny).toBeGreaterThan(plain * 5);
  });

  it("prices better IVs higher", () => {
    expect(val({ ivs: ivs(31) })).toBeGreaterThan(val({ ivs: ivs(20) }));
    expect(val({ ivs: ivs(20) })).toBeGreaterThan(val({ ivs: ivs(5) }));
  });

  // The whole reason IVs are a curve and not a line: the top of the range is
  // where players actually care, and a linear scale prices 50->60 and
  // 90->100 as the same step.
  it("makes the TOP of the IV range matter more than the middle", () => {
    const lowStep = val({ ivs: ivs(18) }) - val({ ivs: ivs(15) });
    const highStep = val({ ivs: ivs(31) }) - val({ ivs: ivs(28) });
    expect(highStep).toBeGreaterThan(lowStep);
  });

  it("prices a higher level higher, but not by much", () => {
    const lo = val({ level: 5 });
    const hi = val({ level: 100 });
    expect(hi).toBeGreaterThan(lo);
    // Levels are the one thing a buyer can add themselves just by playing,
    // so they must not dominate. Under 2x across the whole range.
    expect(hi).toBeLessThan(lo * 2);
  });

  it("prices a rarer species higher than a common one, all else equal", () => {
    const rat = valuePokemon(mon({ speciesKey: "rattata", name: "Rattata" })).value;
    const drag = valuePokemon(mon({ speciesKey: "dragonite", name: "Dragonite" })).value;
    expect(drag).toBeGreaterThan(rat);
  });

  // Shiny should beat IVs. A perfect-IV ordinary Pokémon is reachable by
  // grinding; a shiny is not.
  it("ranks a shiny with poor IVs above a perfect-IV non-shiny", () => {
    expect(val({ isShiny: true, ivs: ivs(3) })).toBeGreaterThan(val({ ivs: ivs(31) }));
  });
});

describe("the number is usable", () => {
  it("suggests an opening bid BELOW the valuation", () => {
    const p = mon({ isShiny: true });
    expect(suggestedStartingBid(p)).toBeLessThan(valuePokemon(p).value);
  });

  it("never suggests zero or a negative", () => {
    // The floor case: worst species, no IVs, level 1.
    const p = makeMon({ speciesKey: "magikarp", name: "Magikarp", ivs: ivs(0), level: 1 });
    expect(valuePokemon(p).value).toBeGreaterThan(0);
    expect(suggestedStartingBid(p)).toBeGreaterThan(0);
  });

  it("survives a Pokémon with no IVs recorded", () => {
    // Old saves. It must produce a number rather than NaN.
    const p = makeMon({ ivs: undefined, level: 30 });
    expect(Number.isFinite(valuePokemon(p).value)).toBe(true);
    expect(valuePokemon(p).value).toBeGreaterThan(0);
  });

  it("survives an unknown species", () => {
    const p = makeMon({ speciesKey: "notarealpokemon" });
    expect(Number.isFinite(valuePokemon(p).value)).toBe(true);
  });

  it("rounds to something a person would type", () => {
    expect(roundToNice(43718)).toBe(44000);
    expect(roundToNice(1234)).toBe(1200);
    expect(roundToNice(47)).toBe(50);
    // Never below the floor, however small the input.
    expect(roundToNice(0)).toBe(10);
  });
});

describe("it shows its working", () => {
  // A suggested price a player cannot interrogate is one they will assume is
  // rigged the first time it disagrees with them.
  it("names every factor that moved the number", () => {
    const lines = explain(valuePokemon(mon({ isShiny: true, ivs: ivs(29) })));
    expect(lines.some((l) => l.startsWith("Shiny"))).toBe(true);
    expect(lines.some((l) => l.startsWith("IVs"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Lv"))).toBe(true);
  });

  it("omits factors that did nothing", () => {
    // A non-shiny must not carry a "Shiny ×1.00" row.
    const lines = explain(valuePokemon(mon({ isShiny: false })));
    expect(lines.some((l) => l.startsWith("Shiny"))).toBe(false);
  });
});
