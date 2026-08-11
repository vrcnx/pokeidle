// The Hoenn raid tier, and the gate that is easy to get wrong.
//
// `state.championDefeated` is a SINGLE GLOBAL BOOLEAN — beating any champion
// anywhere sets it. Gating the Hoenn pool on that would have opened it the
// moment somebody beat Kanto's Blue, which for an established player is years
// of play before they reach Hoenn, and the failure is invisible: the tier
// simply appears, unlocked, and nobody files a bug about being given
// something.
//
// So it gates on `defeatedChampions.includes("steven")` instead — the same
// per-champion list `regionCompleted` already uses. These tests exist because
// that distinction is one word in a predicate and reads identically either
// way at a glance.

import { describe, expect, it } from "vitest";
import { raidTiers, raidTiersOrdered, isTierUnlocked } from "../src/data/raidLegendaries";
import { hoenn } from "../src/data/regions/hoenn";
import { pokemonTable } from "../src/data/pokemon";

const tier = raidTiers.hoennLegends;

/** A save with eight badges and whatever champions you name. */
const save = (champions: string[]) => ({
  defeatedGyms: ["a", "b", "c", "d", "e", "f", "g", "h"],
  // TRUE in every case below, deliberately: the whole point is that this flag
  // must not be what opens the tier.
  championDefeated: true,
  defeatedChampions: champions,
});

describe("the gate is Steven, not any champion", () => {
  it("stays locked for a player who has beaten Kanto and Johto", () => {
    expect(isTierUnlocked(tier, save(["blue", "lanceJohto"]))).toBe(false);
  });

  it("opens once Steven is beaten", () => {
    expect(isTierUnlocked(tier, save(["blue", "lanceJohto", "steven"]))).toBe(true);
  });

  it("names a champion that actually exists", () => {
    // A typo here fails CLOSED — the tier would never open and nothing would
    // say why. Pinning it to the region's own champion means a rename breaks
    // the test rather than the game.
    expect(tier.unlockChampionId).toBe(hoenn.champion?.id);
  });

  it("fails closed when a caller forgets to pass the list", () => {
    // `defeatedChampions` is optional so existing callers kept compiling. If
    // that had defaulted to "unlocked" the omission would be invisible.
    expect(isTierUnlocked(tier, { defeatedGyms: save([]).defeatedGyms, championDefeated: true }))
      .toBe(false);
  });

  it("does not disturb any other tier", () => {
    const eight = save(["blue"]);
    for (const t of raidTiersOrdered) {
      if (t.id === "hoennLegends") continue;
      // Every other tier gates on badges and/or the global flag, both of which
      // this save satisfies.
      expect(isTierUnlocked(t, eight), t.id).toBe(true);
    }
  });
});

describe("what is in it", () => {
  it("is the Hoenn legends and nothing else", () => {
    expect(new Set(Object.keys(tier.pool))).toEqual(new Set([
      "regirock", "regice", "registeel",
      "latias", "latios",
      "kyogre", "groudon", "rayquaza",
      "jirachi", "deoxys",
    ]));
  });

  it("only lists species the game has, all of them Gen 3", () => {
    for (const k of Object.keys(tier.pool)) {
      const p = pokemonTable[k];
      expect(p, k).toBeTruthy();
      expect(p.id, k).toBeGreaterThanOrEqual(252);
      expect(p.id, k).toBeLessThanOrEqual(386);
    }
  });

  it("starts above the level Hoenn ends at", () => {
    // Steven's ace is Lv 115. A raid that opens by beating him and starts
    // below his team would be a step down from the fight that unlocked it.
    const stevenTop = Math.max(...(hoenn.champion?.team ?? []).map((m) => m.level));
    expect(tier.startLevel).toBeGreaterThan(stevenTop - 20);
  });

  it("makes the rarest ones rarest", () => {
    // Rayquaza, Jirachi and Deoxys should not fall out at the same rate as a
    // Regi. Weight order is the only thing expressing that.
    const w = tier.pool;
    expect(w.regirock).toBeGreaterThan(w.rayquaza);
    expect(w.rayquaza).toBeGreaterThan(w.deoxys);
  });
});
