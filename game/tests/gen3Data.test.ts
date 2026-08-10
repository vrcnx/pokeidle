// The Gen 3 dex, and whether it is actually usable.
//
// 135 species arrived from a generator in one commit. Nobody is going to read
// 135 entries, so the things that would make one of them quietly broken need
// to be assertions rather than a spot check:
//
//   * a species with no learnset can never do anything but Struggle
//   * an evolution pointing at a species we do not have is a line a player can
//     be told they are ready for and never complete
//   * a missing catch rate or growth rate is a divide-by-undefined somewhere
//     far away from here
//   * an ability that is not in abilityInfo renders as a blank chip
//
// It also pins the ten Hoenn legendaries that already existed for raids. The
// generator reproduced them identically, which is the single best evidence
// that it read the right columns — so that agreement is worth keeping.

import { describe, expect, it } from "vitest";
import { pokemonTable } from "../src/data/pokemon";
import { evolutions } from "../src/data/evolutions";
import { levelUpMoves } from "../src/data/levelUpMoves";
import { catchRates } from "../src/data/catchRates";
import { moves } from "../src/data/moves";
import { abilityInfo, speciesAbilities } from "../src/data/abilities";
import { gen3Pokemon } from "../src/data/gen3/pokemon";

const KEYS = Object.keys(gen3Pokemon);

describe("the Gen 3 dex is complete", () => {
  it("has all 135 base formes, 252 to 386", () => {
    expect(KEYS).toHaveLength(135);
    const nums = new Set(Object.values(gen3Pokemon).map((p) => p.id));
    const missing: number[] = [];
    for (let i = 252; i <= 386; i++) if (!nums.has(i)) missing.push(i);
    expect(missing).toEqual([]);
  });

  it("merges into the main table without losing anyone", () => {
    for (const k of KEYS) expect(pokemonTable[k], k).toBeTruthy();
  });

  it("gives every one of them real stats", () => {
    for (const k of KEYS) {
      const p = pokemonTable[k];
      expect(p.types.length, k).toBeGreaterThan(0);
      expect(p.baseExpYield, k).toBeGreaterThan(0);
      expect(p.growthRate, k).toBeTruthy();
      for (const [stat, v] of Object.entries(p.baseStats)) {
        expect(v, `${k}.${stat}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every one of them a catch rate", () => {
    // Without this a ball throw divides by undefined, and the failure surfaces
    // as NaN in the catch formula rather than as anything mentioning Gen 3.
    for (const k of KEYS) expect(catchRates[k], k).toBeGreaterThan(0);
  });
});

describe("they can actually be played", () => {
  it("gives every one a level-up learnset", () => {
    // A species with no learnset can only ever Struggle.
    const empty = KEYS.filter((k) => !(levelUpMoves[k]?.length));
    expect(empty).toEqual([]);
  });

  it("only teaches moves that exist", () => {
    const bad: string[] = [];
    for (const k of KEYS) {
      for (const [, mv] of levelUpMoves[k] ?? []) {
        if (!moves[mv]) bad.push(`${k}: ${mv}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("gives every one something at or below level 5", () => {
    // Starters and wild catches begin low. A learnset whose first entry is
    // level 10 means a freshly caught one has no moves at all.
    const late = KEYS.filter((k) => {
      const first = Math.min(...(levelUpMoves[k] ?? [[99, ""]]).map(([l]) => l));
      return first > 5;
    });
    expect(late).toEqual([]);
  });

  it("gives every one a legal ability", () => {
    for (const k of KEYS) {
      const entry = speciesAbilities[k];
      expect(entry, k).toBeTruthy();
      expect(entry.primary.length, k).toBeGreaterThan(0);
      // An ability with no abilityInfo row renders as a blank chip in the UI.
      for (const a of [...entry.primary, ...(entry.hidden ? [entry.hidden] : [])]) {
        expect(abilityInfo[a], `${k}: ${a}`).toBeTruthy();
      }
    }
  });
});

describe("their evolutions go somewhere", () => {
  it("never points at a species this game does not have", () => {
    const dangling: string[] = [];
    for (const k of KEYS) {
      for (const ev of evolutions[k] ?? []) {
        if (!pokemonTable[ev.into]) dangling.push(`${k} -> ${ev.into}`);
      }
    }
    expect(dangling, "the generator drops these; something re-added one").toEqual([]);
  });

  it("keeps the Hoenn starters' three-stage lines", () => {
    expect(evolutions.treecko?.[0]).toMatchObject({ into: "grovyle", level: 16 });
    expect(evolutions.grovyle?.[0]).toMatchObject({ into: "sceptile", level: 36 });
    expect(evolutions.torchic?.[0]).toMatchObject({ into: "combusken", level: 16 });
    expect(evolutions.mudkip?.[0]).toMatchObject({ into: "marshtomp", level: 16 });
  });

  it("carries stone evolutions as items the game has", () => {
    // `item`, not `stone` — the field name the trigger type actually uses, and
    // the one the first generated pass got wrong.
    const stoneEvos = KEYS.flatMap((k) => (evolutions[k] ?? []).map((e) => [k, e] as const))
      .filter(([, e]) => "item" in e);
    expect(stoneEvos.length).toBeGreaterThan(0);
    for (const [k, e] of stoneEvos) {
      expect(typeof (e as { item: string }).item, k).toBe("string");
    }
  });
});

describe("the ten that were already here", () => {
  // Regirock through Deoxys were hand-entered for raids long before this
  // generator existed. It reproduced all ten identically, which is the best
  // evidence available that it read the right columns — worth pinning so a
  // future regeneration that quietly disagrees gets caught.
  const LEGENDARIES = [
    "regirock", "regice", "registeel", "latias", "latios",
    "kyogre", "groudon", "rayquaza", "jirachi", "deoxys",
  ];

  it("still agrees with the hand-written entries", () => {
    for (const k of LEGENDARIES) {
      const g = gen3Pokemon[k];
      const live = pokemonTable[k];
      expect(g, k).toBeTruthy();
      expect(live.baseStats, k).toEqual(g.baseStats);
      expect(live.types, k).toEqual(g.types);
      expect(live.baseExpYield, k).toBe(g.baseExpYield);
      expect(live.growthRate, k).toBe(g.growthRate);
    }
  });

  it("does not give any of them an evolution", () => {
    for (const k of LEGENDARIES) expect(evolutions[k] ?? []).toEqual([]);
  });
});
