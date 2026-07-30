// Bulk release + the confirmation policy — br_ff6112fc5180462b81.
//
// Two players asked for this (pani, and gshow twice, with 500 Magikarp to
// clear). It is also the single most dangerous thing in the batch: releasing is
// the only irreversible action in the game, and a filter-driven multi-select is
// precisely the shape of mistake that sweeps up something precious.
//
// The obvious implementation — loop the existing index-addressed
// RELEASE_POKEMON over the selection — is provably WRONG, and the first test
// below is that proof. RELEASE_MANY is addressed by id for that reason.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import {
  bulkReleaseConfirmMessage, isBulkReleasable, needsReleaseConfirm,
} from "../src/utils/releaseConfirm";
import { initialState } from "../src/state/initialState";
import type { GameState, Pokemon } from "../src/types";
import { makeMon, makeState } from "./helpers";

const ids = (list: Pokemon[]) => list.map((p) => p.id);

function boxOf(n: number, over: (i: number) => Partial<Pokemon> = () => ({})): Pokemon[] {
  return Array.from({ length: n }, (_, i) => makeMon({ id: `r${i}`, ...over(i) }));
}

describe("why RELEASE_MANY exists at all", () => {
  it("a loop of index-addressed releases destroys the WRONG Pokémon", () => {
    // Ascending indices shift under each other. Asked for r0,r1,r2 it removes
    // r0, r2 and r4. This is the reason the bulk action is id-addressed, and it
    // is worth keeping executable so nobody "simplifies" it back into a loop.
    let s: GameState = makeState({ box: boxOf(10) });
    for (const index of [0, 1, 2]) {
      s = reducer(s, { type: "RELEASE_POKEMON", payload: { source: "box", index } });
    }
    expect(ids(s.box)).toEqual(["r1", "r3", "r5", "r6", "r7", "r8", "r9"]);
  });

  it("RELEASE_MANY removes exactly the ids asked for, id-for-id", () => {
    const s = reducer(makeState({ box: boxOf(10) }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: ["r0", "r1", "r2"] },
    });
    expect(ids(s.box)).toEqual(["r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
  });

  it("is order-insensitive — the same set in any order gives the same box", () => {
    const orders = [
      ["r0", "r4", "r8"], ["r8", "r4", "r0"], ["r4", "r8", "r0"],
    ];
    const results = orders.map((pokemonIds) =>
      ids(reducer(makeState({ box: boxOf(10) }), {
        type: "RELEASE_MANY", payload: { source: "box", pokemonIds },
      }).box),
    );
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toEqual(["r1", "r2", "r3", "r5", "r6", "r7", "r9"]);
  });

  it("ignores ids that are already gone instead of hitting a bystander", () => {
    const s = reducer(makeState({ box: boxOf(4) }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: ["r1", "ghost", "r3"] },
    });
    expect(ids(s.box)).toEqual(["r0", "r2"]);
  });

  it("clears the reporter's actual case: 500 Magikarp", () => {
    const box = Array.from({ length: 500 }, (_, i) =>
      makeMon({ id: `k${i}`, speciesKey: "magikarp", name: "Magikarp" }),
    );
    const s = reducer(makeState({ box }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: box.map((p) => p.id) },
    });
    expect(s.box).toHaveLength(0);
    expect(s.battleLog.some((l) => l.includes("Released 500"))).toBe(true);
  });

  it("an empty selection is a no-op by identity", () => {
    const s = makeState({ box: boxOf(3) });
    expect(reducer(s, { type: "RELEASE_MANY", payload: { source: "box", pokemonIds: [] } })).toBe(s);
  });
});

describe("the shiny guard cannot be bypassed", () => {
  it("never bulk-releases a shiny, even when explicitly selected", () => {
    const box = boxOf(6, (i) => (i === 2 || i === 4 ? { isShiny: true } : {}));
    const s = reducer(makeState({ box }), {
      type: "RELEASE_MANY",
      payload: { source: "box", pokemonIds: box.map((p) => p.id) },
    });
    expect(ids(s.box)).toEqual(["r2", "r4"]);
    expect(s.box.every((p) => p.isShiny)).toBe(true);
  });

  it("says out loud how many it kept back", () => {
    const box = boxOf(3, (i) => (i === 0 ? { isShiny: true } : {}));
    const s = reducer(makeState({ box }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: ["r0", "r1", "r2"] },
    });
    expect(s.battleLog.some((l) => l.includes("Released 2"))).toBe(true);
    expect(s.battleLog.some((l) => l.includes("1 shiny"))).toBe(true);
  });

  it("a shiny-only selection releases nothing at all", () => {
    const box = boxOf(3, () => ({ isShiny: true }));
    const s = reducer(makeState({ box }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: ["r0", "r1", "r2"] },
    });
    expect(ids(s.box)).toEqual(["r0", "r1", "r2"]);
  });

  it("the UI helper refuses the same Pokémon the reducer would", () => {
    // Two copies of the rule on purpose: this one keeps the UI from offering
    // what the reducer would refuse, the reducer's keeps a Pokémon alive if
    // this one is ever wrong.
    expect(isBulkReleasable(makeMon({ id: "a", isShiny: true }), [])).toBe(false);
    expect(isBulkReleasable(makeMon({ id: "b" }), ["b"])).toBe(false);
    expect(isBulkReleasable(makeMon({ id: "c" }), ["b"])).toBe(true);
  });
});

describe("auction escrow is respected", () => {
  it("never releases a Pokémon that is listed at the auction house", () => {
    // The server escrows on createAuction but the client keeps the mon in the
    // box, so it stayed visible and releasable while already sold.
    const box = boxOf(3);
    const s = reducer(makeState({ box, listedPokemonIds: ["r1"] }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: ["r0", "r1", "r2"] },
    });
    expect(ids(s.box)).toEqual(["r1"]);
    expect(s.battleLog.some((l) => l.includes("auction house"))).toBe(true);
  });

  it("blocks the SINGLE release of a listed Pokémon too", () => {
    const s = reducer(makeState({ box: boxOf(2), listedPokemonIds: ["r0"] }), {
      type: "RELEASE_POKEMON", payload: { source: "box", index: 0, pokemonId: "r0" },
    });
    expect(ids(s.box)).toEqual(["r0", "r1"]);
    expect(s.battleLog.some((l) => l.includes("auction house"))).toBe(true);
  });

  it("stops blocking once the listing settles", () => {
    // AUCTION_SETTLED drops the lock as well as removing the mon, so a
    // cancelled or expired listing cannot leave a Pokémon locked forever.
    const s = makeState({ box: boxOf(2), listedPokemonIds: ["r0"], money: 100 });
    const settled = reducer(s, {
      type: "AUCTION_SETTLED",
      payload: { role: "seller", removedPokemonId: "r0", money: 5000, logMessage: "sold" },
    });
    expect(settled.listedPokemonIds).not.toContain("r0");
    expect(ids(settled.box)).toEqual(["r1"]);
  });
});

describe("the party keeps something that can battle", () => {
  it("refuses to release the last HEALTHY member (single)", () => {
    // Guarded only by `party.length <= 1` before, so this left playerPokemon at
    // 0 HP and every encounter unwinnable until a Centre visit.
    const fainted = makeMon({ id: "f1", currentHp: 0 });
    const healthy = makeMon({ id: "h1", currentHp: 100 });
    const s = reducer(makeState({ party: [fainted, healthy], playerPokemon: fainted }), {
      type: "RELEASE_POKEMON", payload: { source: "party", index: 1, pokemonId: "h1" },
    });
    expect(ids(s.party)).toEqual(["f1", "h1"]);
    expect(s.battleLog.some((l) => l.includes("last healthy"))).toBe(true);
  });

  it("still allows releasing a fainted member while a healthy one remains", () => {
    const fainted = makeMon({ id: "f1", currentHp: 0 });
    const healthy = makeMon({ id: "h1", currentHp: 100 });
    const s = reducer(makeState({ party: [fainted, healthy], playerPokemon: healthy }), {
      type: "RELEASE_POKEMON", payload: { source: "party", index: 0, pokemonId: "f1" },
    });
    expect(ids(s.party)).toEqual(["h1"]);
  });

  it("still allows pruning an ALL-fainted party — nothing healthy to protect", () => {
    const a = makeMon({ id: "a", currentHp: 0 });
    const b = makeMon({ id: "b", currentHp: 0 });
    const s = reducer(makeState({ party: [a, b], playerPokemon: a }), {
      type: "RELEASE_POKEMON", payload: { source: "party", index: 1, pokemonId: "b" },
    });
    expect(ids(s.party)).toEqual(["a"]);
  });

  it("bulk-releasing the whole party keeps one healthy member back", () => {
    const party = [
      makeMon({ id: "p0", currentHp: 0 }),
      makeMon({ id: "p1", currentHp: 50 }),
      makeMon({ id: "p2", currentHp: 0 }),
    ];
    const s = reducer(makeState({ party, playerPokemon: party[1] }), {
      type: "RELEASE_MANY", payload: { source: "party", pokemonIds: ["p0", "p1", "p2"] },
    });
    expect(ids(s.party)).toEqual(["p1"]);
    expect(s.party[0].currentHp).toBeGreaterThan(0);
    expect(s.playerPokemon?.id).toBe("p1");
    expect(s.battleLog.some((l) => l.includes("last healthy"))).toBe(true);
  });

  it("leaves a valid active index and playerPokemon after a party bulk release", () => {
    const party = [
      makeMon({ id: "p0", currentHp: 10 }),
      makeMon({ id: "p1", currentHp: 20 }),
      makeMon({ id: "p2", currentHp: 30 }),
      makeMon({ id: "p3", currentHp: 40 }),
    ];
    const s = reducer(
      makeState({ party, playerPokemon: party[3], activePlayerPokemonIndex: 3 }),
      { type: "RELEASE_MANY", payload: { source: "party", pokemonIds: ["p0", "p1"] } },
    );
    expect(ids(s.party)).toEqual(["p2", "p3"]);
    expect(s.activePlayerPokemonIndex).toBeLessThan(s.party.length);
    expect(s.playerPokemon).toBe(s.party[s.activePlayerPokemonIndex]);
  });

  it("never empties the party, even asked to release every member", () => {
    const party = [makeMon({ id: "p0", currentHp: 10 }), makeMon({ id: "p1", currentHp: 10 })];
    const s = reducer(makeState({ party, playerPokemon: party[0] }), {
      type: "RELEASE_MANY", payload: { source: "party", pokemonIds: ["p0", "p1"] },
    });
    expect(s.party.length).toBeGreaterThanOrEqual(1);
    expect(s.playerPokemon).not.toBeNull();
  });

  it("the box has no such guard — an empty box is a legal state", () => {
    const s = reducer(makeState({ box: boxOf(3) }), {
      type: "RELEASE_MANY", payload: { source: "box", pokemonIds: ["r0", "r1", "r2"] },
    });
    expect(s.box).toEqual([]);
  });
});

describe("the confirmation policy", () => {
  it("defaults to asking", () => {
    expect(initialState.skipReleaseConfirm).toBe(false);
  });

  it("the toggle suppresses the prompt for an ordinary Pokémon", () => {
    const plain = makeMon({ id: "a" });
    expect(needsReleaseConfirm(plain, false)).toBe(true);
    expect(needsReleaseConfirm(plain, true)).toBe(false);
  });

  it("a SHINY always asks, whatever the toggle says", () => {
    // The toggle is enabled once for bulk chaff and then forgotten, months
    // before the 1/8192 encounter shows up.
    const shiny = makeMon({ id: "s", isShiny: true });
    expect(needsReleaseConfirm(shiny, false)).toBe(true);
    expect(needsReleaseConfirm(shiny, true)).toBe(true);
  });

  it("the bulk message always names the exact count", () => {
    expect(bulkReleaseConfirmMessage(1)).toContain("1 Pokémon");
    expect(bulkReleaseConfirmMessage(499)).toContain("499 Pokémon");
    for (const n of [1, 2, 37, 500]) {
      expect(bulkReleaseConfirmMessage(n)).toContain(String(n));
      expect(bulkReleaseConfirmMessage(n)).toContain("cannot be undone");
    }
  });

  it("SET_SKIP_RELEASE_CONFIRM round-trips", () => {
    const on = reducer(makeState(), { type: "SET_SKIP_RELEASE_CONFIRM", payload: { value: true } });
    expect(on.skipReleaseConfirm).toBe(true);
    const off = reducer(on, { type: "SET_SKIP_RELEASE_CONFIRM", payload: { value: false } });
    expect(off.skipReleaseConfirm).toBe(false);
  });
});

describe("the stream director's index-only batch still works unchanged", () => {
  it("a descending index burst removes exactly its targets", () => {
    // worstBoxReleases returns strictly DESCENDING indices and passes no id.
    // Re-anchoring must not have changed that behaviour.
    let s: GameState = makeState({ box: boxOf(10) });
    for (const index of [4, 2, 0]) {
      s = reducer(s, { type: "RELEASE_POKEMON", payload: { source: "box", index } });
    }
    expect(ids(s.box)).toEqual(["r1", "r3", "r5", "r6", "r7", "r8", "r9"]);
  });
});

describe("the escrow lock is tracked", () => {
  it("MARK_POKEMON_LISTED adds once and is idempotent", () => {
    const s1 = reducer(makeState(), { type: "MARK_POKEMON_LISTED", payload: { pokemonId: "x" } });
    expect(s1.listedPokemonIds).toEqual(["x"]);
    const s2 = reducer(s1, { type: "MARK_POKEMON_LISTED", payload: { pokemonId: "x" } });
    expect(s2).toBe(s1); // identity — no churn
  });

  it("SET_LISTED_POKEMON_IDS replaces, and is identity-stable when unchanged", () => {
    const s1 = reducer(makeState(), {
      type: "SET_LISTED_POKEMON_IDS", payload: { ids: ["a", "b"] },
    });
    expect(s1.listedPokemonIds).toEqual(["a", "b"]);
    expect(reducer(s1, { type: "SET_LISTED_POKEMON_IDS", payload: { ids: ["a", "b"] } })).toBe(s1);
    const s2 = reducer(s1, { type: "SET_LISTED_POKEMON_IDS", payload: { ids: ["c"] } });
    expect(s2.listedPokemonIds).toEqual(["c"]);
  });
});

describe("a skipped release cannot corrupt a descending index burst", () => {
  it("the stream trim stays correct when the escrow guard no-ops one entry", () => {
    // New interaction: RELEASE_POKEMON is now a no-op for an auction-listed mon.
    // The stream director's trim burst is index-addressed, so a mid-burst no-op
    // would be catastrophic if it shifted the remaining indices. It cannot,
    // because the burst is strictly DESCENDING and a no-op leaves the box
    // unchanged — every later (smaller) index still addresses the same mon.
    const box = boxOf(10);
    let s: GameState = makeState({ box, listedPokemonIds: ["r4"] });
    for (const index of [8, 6, 4, 2, 0]) {
      s = reducer(s, { type: "RELEASE_POKEMON", payload: { source: "box", index } });
    }
    // r4 survives (escrowed); every other target is gone and no bystander is.
    expect(ids(s.box)).toEqual(["r1", "r3", "r4", "r5", "r7", "r9"]);
  });

  it("worstBoxReleases-style descending bursts are unaffected without listings", () => {
    const box = boxOf(10);
    let s: GameState = makeState({ box });
    for (const index of [8, 6, 4, 2, 0]) {
      s = reducer(s, { type: "RELEASE_POKEMON", payload: { source: "box", index } });
    }
    expect(ids(s.box)).toEqual(["r1", "r3", "r5", "r7", "r9"]);
  });
});
