// The advanced auto-catch conditions.
//
// This predicate decides whether a ball gets thrown, so its failure mode is
// the expensive one: a rule that is accidentally too strict does not look
// broken, it looks like the game quietly stopped auto-catching. That is the
// exact bug the shiny override at the top of shouldAutoCatch exists to
// prevent, and it happened once already.
//
// So the tests below are mostly about what must PASS, not what must match.

import { describe, expect, it } from "vitest";
import { passesFilters, ivPercent, IV_TOTAL_MAX } from "../src/utils/catching";
import { makeMon } from "./helpers";
import type { Pokemon } from "../src/types";

const ivs = (n: number) => ({
  hp: n, attack: n, defense: n, spAttack: n, spDefense: n, speed: n,
});
/** n per stat → n/31 of perfect. 31 is 100%, 16 is ~51.6%. */
const mon = (over: Partial<Pokemon> = {}) => makeMon({ ivs: ivs(20), ...over });

describe("nothing set", () => {
  it("passes when there are no filters", () => {
    expect(passesFilters(undefined, mon())).toBe(true);
    expect(passesFilters({}, mon())).toBe(true);
  });

  // The migration case: a caller that has no encounter object must not stop
  // throwing balls. A filter that cannot be judged is not one that failed.
  it("passes when there is no encounter to judge", () => {
    expect(passesFilters({ minIvPct: 90, gender: "M" }, undefined)).toBe(true);
  });
});

describe("IV percentage", () => {
  it("measures against a perfect 186", () => {
    expect(IV_TOTAL_MAX).toBe(186);
    expect(ivPercent(mon({ ivs: ivs(31) }))).toBe(100);
    expect(Math.round(ivPercent(mon({ ivs: ivs(0) }))!)).toBe(0);
  });

  it("keeps one at or above the bar and refuses one below", () => {
    expect(passesFilters({ minIvPct: 60 }, mon({ ivs: ivs(20) }))).toBe(true);  // ~64.5%
    expect(passesFilters({ minIvPct: 70 }, mon({ ivs: ivs(20) }))).toBe(false);
  });

  // Older saves have Pokemon with no IVs at all. Judging them as failures
  // would silently narrow the rule for exactly the players least able to
  // work out why.
  it("passes a Pokemon with no IVs recorded", () => {
    expect(passesFilters({ minIvPct: 90 }, mon({ ivs: undefined }))).toBe(true);
  });
});

describe("nature", () => {
  it("keeps a listed nature and refuses an unlisted one", () => {
    expect(passesFilters({ natures: ["Adamant", "Jolly"] }, mon({ nature: "Adamant" }))).toBe(true);
    expect(passesFilters({ natures: ["Adamant", "Jolly"] }, mon({ nature: "Modest" }))).toBe(false);
  });

  it("an empty list is not a filter", () => {
    // "nature is one of NOTHING" matches nothing, which would stop
    // auto-catch dead. The UI never writes this, and the predicate refuses
    // to read it that way either.
    expect(passesFilters({ natures: [] }, mon({ nature: "Modest" }))).toBe(true);
  });

  it("passes a Pokemon with no nature recorded", () => {
    expect(passesFilters({ natures: ["Adamant"] }, mon({ nature: undefined }))).toBe(true);
  });
});

describe("gender", () => {
  it("keeps the asked-for gender and refuses the other", () => {
    expect(passesFilters({ gender: "M" }, mon({ gender: "M" }))).toBe(true);
    expect(passesFilters({ gender: "M" }, mon({ gender: "F" }))).toBe(false);
  });

  // null and undefined are NOT the same thing here, and the difference is
  // the whole reason the field is typed the way it is.
  it("refuses a genderless species — asking for males is a claim about gender", () => {
    expect(passesFilters({ gender: "M" }, mon({ gender: null }))).toBe(false);
  });

  it("passes a Pokemon caught before the field existed", () => {
    expect(passesFilters({ gender: "M" }, mon({ gender: undefined }))).toBe(true);
  });
});

describe("combining them", () => {
  // The request, verbatim: "Adamant male Charmander with IVs above 85%".
  const rule = { minIvPct: 85, natures: ["Adamant"], gender: "M" as const };

  it("keeps one that matches every condition", () => {
    expect(passesFilters(rule, mon({ ivs: ivs(28), nature: "Adamant", gender: "M" }))).toBe(true);
  });

  it("refuses one that misses any single condition", () => {
    expect(passesFilters(rule, mon({ ivs: ivs(20), nature: "Adamant", gender: "M" }))).toBe(false);
    expect(passesFilters(rule, mon({ ivs: ivs(28), nature: "Modest",  gender: "M" }))).toBe(false);
    expect(passesFilters(rule, mon({ ivs: ivs(28), nature: "Adamant", gender: "F" }))).toBe(false);
  });
});
