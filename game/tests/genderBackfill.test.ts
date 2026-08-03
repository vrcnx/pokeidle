// Gender on Pokémon caught before the field existed.
//
// The obvious migration is "call them all male". It is wrong in a way you
// can SEE — it puts a male Chansey, a male Miltank and a male Nidoran♀ in
// the box, for three species with exactly one possible answer that the game
// already knows.
//
// So they are derived instead, by the same function that runs at creation.
// An old Pokémon ends up with the gender it would have been given had the
// field existed when it was caught.

import { describe, expect, it } from "vitest";
import { genderFor, maleOdds, genderSymbol } from "../src/data/gender";

const ivs = (n: number) => ({
  hp: n, attack: n, defense: n, spAttack: n, spDefense: n, speed: n,
});

describe("species with only one possible answer", () => {
  it("keeps the always-female ones female", () => {
    for (const k of ["chansey", "blissey", "miltank", "kangaskhan", "nidoranf"]) {
      expect(genderFor(k, ivs(20))).toBe("F");
      expect(maleOdds(k)).toBe(0);
    }
  });

  it("keeps the always-male ones male", () => {
    for (const k of ["tauros", "hitmonlee", "hitmonchan", "nidoranm"]) {
      expect(genderFor(k, ivs(20))).toBe("M");
      expect(maleOdds(k)).toBe(1);
    }
  });

  it("leaves genderless species genderless", () => {
    for (const k of ["magnemite", "voltorb", "ditto", "mewtwo", "metagross"]) {
      expect(genderFor(k, ivs(20))).toBeNull();
      expect(maleOdds(k)).toBeNull();
    }
  });

  // null and undefined display identically, which is the point: an absent
  // symbol reads as "not applicable" either way.
  it("shows nothing for genderless and nothing for unknown", () => {
    expect(genderSymbol(null)).toBe("");
    expect(genderSymbol(undefined)).toBe("");
    expect(genderSymbol("M")).toBe("♂");
    expect(genderSymbol("F")).toBe("♀");
  });
});

describe("everything else", () => {
  it("is stable — the same Pokémon derives the same gender every time", () => {
    const a = genderFor("pikachu", ivs(17));
    for (let i = 0; i < 50; i++) expect(genderFor("pikachu", ivs(17))).toBe(a);
  });

  // The reason this is a derivation and not a coin flip: it has to survive a
  // reload. A random backfill would re-roll on every save load and a
  // player's Pokémon would change gender when they refreshed.
  it("does not depend on call order or on Math.random", () => {
    const before = genderFor("eevee", ivs(9));
    Math.random(); Math.random(); Math.random();
    expect(genderFor("eevee", ivs(9))).toBe(before);
  });

  it("splits a normal species roughly evenly across IV spreads", () => {
    let m = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const spread = {
        hp: i % 32, attack: (i * 7) % 32, defense: (i * 13) % 32,
        spAttack: (i * 17) % 32, spDefense: (i * 23) % 32, speed: (i * 29) % 32,
      };
      if (genderFor("pikachu", spread) === "M") m++;
    }
    const pct = (m / N) * 100;
    expect(pct).toBeGreaterThan(42);
    expect(pct).toBeLessThan(58);
  });

  it("handles an all-zero IV block without throwing", () => {
    expect(["M", "F"]).toContain(genderFor("pikachu", ivs(0)));
  });
});
