// Releasing is the one irreversible action in the game, and every menu that
// offers it snapshots its index when the menu OPENS, not when it is confirmed:
// openContextMenu freezes the item array with its onClick closures inside, and
// PokemonDetailModal keeps its {type, index} in a module-level store.
//
// The box can move under that snapshot with no input from the player —
// AUCTION_SETTLED filters a sold box mon out by id and shifts every later index
// down by one, a mid-session LOAD_SAVE cloud reconcile replaces the box
// outright, and SORT_BOX reorders it. RELEASE_POKEMON therefore accepts an
// optional `pokemonId` that re-anchors the slot and drops the action if the id
// is gone, the same way START_EVOLUTION does (whose comment already named "a
// release landing in between" as the hazard).
//
// Index-only callers must keep their old behaviour byte for byte: the stream
// director orders its burst DESCENDING behind a render sentinel and passes no
// id, and re-anchoring is what would break it.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState } from "./helpers";
import type { GameState } from "../src/types";

const ids = (s: GameState) => s.box.map((m) => m.id);

// "sold" sits BEFORE the mon the player picked, so settling the auction pulls
// everything after it down one slot and the shiny lands on the frozen index.
const boxOf = () => [
  makeMon({ id: "sold", speciesKey: "abra", name: "Abra", level: 10 }),
  makeMon({ id: "junk", speciesKey: "rattata", name: "Rattata", level: 3 }),
  makeMon({ id: "shiny", speciesKey: "dratini", name: "Dratini", level: 40, isShiny: true }),
  makeMon({ id: "keep", speciesKey: "lapras", name: "Lapras", level: 35 }),
];

describe("RELEASE_POKEMON id anchoring", () => {
  it("releases the Pokemon the player was looking at, not the shiny that slid into its slot", () => {
    // The player right-clicked the Rattata at index 1 and the menu froze that
    // index. Before they confirmed, their Abra auction settled.
    const before = makeState({ box: boxOf() });
    const snapshotIndex = 1;
    expect(before.box[snapshotIndex].id).toBe("junk");

    const shifted = reducer(before, {
      type: "AUCTION_SETTLED",
      payload: { role: "seller", removedPokemonId: "sold", money: 5000, logMessage: "sold" },
    } as never);
    expect(ids(shifted)).toEqual(["junk", "shiny", "keep"]);
    // The frozen index now points at the SHINY DRATINI.
    expect(shifted.box[snapshotIndex].id).toBe("shiny");

    const released = reducer(shifted, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: snapshotIndex, pokemonId: "junk" },
    });
    expect(ids(released)).toEqual(["shiny", "keep"]);
    expect(released.box.some((m) => m.isShiny)).toBe(true);
  });

  it("and the same dispatch WITHOUT the id is what destroys that shiny", () => {
    // The counterfactual, pinned so the anchor cannot be quietly removed:
    // index-only addressing releases the wrong Pokémon here, irreversibly.
    const shifted = reducer(makeState({ box: boxOf() }), {
      type: "AUCTION_SETTLED",
      payload: { role: "seller", removedPokemonId: "sold", money: 5000, logMessage: "sold" },
    } as never);
    const released = reducer(shifted, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: 1 },
    });
    expect(ids(released)).toEqual(["junk", "keep"]);
    expect(released.box.some((m) => m.isShiny)).toBe(false);
  });

  it("a stale index cannot destroy a shiny bystander", () => {
    const before = makeState({ box: boxOf() });
    // Snapshot taken over "keep" (index 3); a SORT_BOX reorders underneath.
    const sorted = reducer(before, { type: "SORT_BOX", payload: { mode: "level" } } as never);
    const occupant = sorted.box[3];
    const released = reducer(sorted, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: 3, pokemonId: "keep" },
    });
    expect(released.box.some((m) => m.id === "keep")).toBe(false);
    expect(released.box.some((m) => m.isShiny)).toBe(true);
    // And if the sort happened to move a different mon into slot 3, that mon
    // is still there.
    if (occupant.id !== "keep") {
      expect(released.box.some((m) => m.id === occupant.id)).toBe(true);
    }
  });

  it("drops the action when the id is already gone rather than hitting a neighbour", () => {
    // Two tabs, or a double-fire: the mon was released once already.
    const s = makeState({ box: boxOf() });
    const once = reducer(s, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: 3, pokemonId: "keep" },
    });
    const twice = reducer(once, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: 3, pokemonId: "keep" },
    });
    expect(ids(twice)).toEqual(["sold", "junk", "shiny"]);
    expect(twice).toBe(once);
  });

  it("anchors party releases too", () => {
    const a = makeMon({ id: "a" });
    const b = makeMon({ id: "b" });
    const c = makeMon({ id: "c" });
    const s = makeState({ party: [a, b, c], playerPokemon: a, activePlayerPokemonIndex: 0 });
    // Snapshot over "c" at index 2, then the party is reordered.
    const reordered = reducer(s, { type: "REORDER_PARTY", payload: { from: 2, to: 0 } } as never);
    expect(reordered.party.map((m) => m.id)).toEqual(["c", "a", "b"]);
    const released = reducer(reordered, {
      type: "RELEASE_POKEMON",
      payload: { source: "party", index: 2, pokemonId: "c" },
    });
    expect(released.party.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("still refuses to release the last party member, id or not", () => {
    const solo = makeMon({ id: "solo" });
    const s = makeState({ party: [solo], playerPokemon: solo });
    const out = reducer(s, {
      type: "RELEASE_POKEMON",
      payload: { source: "party", index: 0, pokemonId: "solo" },
    });
    expect(out.party.map((m) => m.id)).toEqual(["solo"]);
  });

  it("leaves index-only callers untouched — the stream director's descending burst", () => {
    // No pokemonId: pure index addressing, exactly as before. Descending order
    // is what makes a run of single dispatches remove the chosen mons.
    const box = Array.from({ length: 6 }, (_, i) => makeMon({ id: `r${i}` }));
    let s = makeState({ box });
    for (const index of [4, 2, 0]) {
      s = reducer(s, { type: "RELEASE_POKEMON", payload: { source: "box", index } });
    }
    expect(ids(s)).toEqual(["r1", "r3", "r5"]);
  });

  it("an out-of-range index with no id is still a no-op", () => {
    const s = makeState({ box: boxOf() });
    for (const index of [-1, 99]) {
      expect(ids(reducer(s, { type: "RELEASE_POKEMON", payload: { source: "box", index } }))).toEqual(
        ["sold", "junk", "shiny", "keep"]
      );
    }
  });
});
