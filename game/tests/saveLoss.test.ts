// The save-loss reports of 2026-08-06 → 08-11.
//
// Three players, one shape. Gshow described it precisely:
//
//   "only the Pokémon (Pokédex/shiny) and levels were reset; everything else
//    (League, auctions, money…) seemed the same"
//
// That is `sigOf` inverted. The signature that decides which copy of a save
// survives measured badges, Elite Four, champion, dex COUNT, party+box COUNT,
// locations and money — and nothing else. Everything it could see survived.
// Everything it could not see was thrown away.
//
// A save an hour behind on levelling adds no dex entry, no badge and no box
// slot, so the two copies were indistinguishable to it and the older one could
// win. It then uploaded over the newer one with a version the server accepts,
// because the version proves the client has SEEN the current save, not that
// its bytes derive from it.
//
// Every test below is a save that used to lose.

import { describe, expect, it } from "vitest";
import { cloudHasMoreProgress, localHasMoreMilestones } from "../src/state/saveReconcile";
import type { GameState } from "../src/types";

const mon = (level: number) => ({ id: `m${level}`, level });

/** Two copies of one account that agree on everything the old signature saw. */
const copy = (over: Record<string, unknown> = {}) => ({
  defeatedGyms: ["a", "b", "c"],
  defeatedEliteFour: ["w", "x"],
  championDefeated: true,
  pokedexCaught: ["bulbasaur", "charmander", "squirtle"],
  shinyCaught: [],
  unlockedLocations: ["r1", "r2"],
  party: [mon(50)],
  box: [mon(50)],
  money: 10_000,
  ...over,
}) as unknown as GameState;

describe("an hour of levelling is no longer invisible", () => {
  it("lets the cloud win when it is well ahead on levels and nothing else differs", () => {
    // The reported case. Same badges, same dex, same box size, same money —
    // the older copy used to win a coin flip and delete the levelling.
    const local = copy({ party: [mon(50)], box: [mon(50)] });
    const cloud = copy({ party: [mon(74)], box: [mon(70)] });
    expect(cloudHasMoreProgress(cloud, local)).toBe(true);
  });

  it("ignores a difference too small to be evidence", () => {
    // One evolution, or a released runt. Not a fresher save, and treating it
    // as one would make the boot jitter between two copies.
    const local = copy({ party: [mon(50)], box: [mon(50)] });
    const cloud = copy({ party: [mon(54)], box: [mon(50)] });
    expect(cloudHasMoreProgress(cloud, local)).toBe(false);
  });

  it("never lets levels override money going backwards", () => {
    // A copy with more levels but LESS money is not unambiguously fresher —
    // it may be the one that has not seen a purchase. Money still gates.
    const local = copy({ money: 900_000 });
    const cloud = copy({ party: [mon(99)], box: [mon(99)], money: 10 });
    expect(cloudHasMoreProgress(cloud, local)).toBe(false);
  });
});

describe("shinies count, in both directions", () => {
  it("lets the cloud win when it holds a shiny local has never seen", () => {
    const local = copy({ shinyCaught: [] });
    const cloud = copy({ shinyCaught: ["pelipper"] });
    expect(cloudHasMoreProgress(cloud, local)).toBe(true);
  });

  it("vetoes adopting a cloud copy that would delete a local shiny", () => {
    // The other half, and the one that protects the fresher device: shinyCaught
    // is append-only, so local holding one cloud lacks means local is ahead.
    const local = copy({ shinyCaught: ["pelipper", "scyther"] });
    const cloud = copy({ shinyCaught: ["pelipper"] });
    expect(localHasMoreMilestones(local, cloud)).toBe(true);
  });

  it("does NOT veto on levels", () => {
    // Deliberate. Levels fall when a Pokemon is released, traded or auctioned,
    // so a veto on them would let a stale device refuse every authoritative
    // server write — including the settlement that took the Pokemon whose
    // levels are missing. They break ties; they do not block.
    const local = copy({ party: [mon(99)], box: [mon(99)] });
    const cloud = copy({ party: [mon(5)], box: [mon(5)] });
    expect(localHasMoreMilestones(local, cloud)).toBe(false);
  });
});

describe("nothing that used to work stopped working", () => {
  it("still lets a genuinely ahead cloud win on a real milestone", () => {
    const local = copy();
    const cloud = copy({ defeatedGyms: ["a", "b", "c", "d"] });
    expect(cloudHasMoreProgress(cloud, local)).toBe(true);
  });

  it("still refuses a cloud copy that is behind on the dex", () => {
    const local = copy({ pokedexCaught: ["bulbasaur", "charmander", "squirtle", "pikachu"] });
    const cloud = copy();
    expect(cloudHasMoreProgress(cloud, local)).toBe(false);
    expect(localHasMoreMilestones(local, cloud)).toBe(true);
  });

  it("calls two identical copies a draw", () => {
    expect(cloudHasMoreProgress(copy(), copy())).toBe(false);
    expect(localHasMoreMilestones(copy(), copy())).toBe(false);
  });

  it("survives a save with no party or box at all", () => {
    // Older blobs omit keys they never had; sumLevels must not throw on them.
    const bare = { money: 0 } as unknown as GameState;
    expect(() => cloudHasMoreProgress(bare, bare)).not.toThrow();
    expect(cloudHasMoreProgress(bare, bare)).toBe(false);
  });
});
