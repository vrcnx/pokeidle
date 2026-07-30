// Which Pokémon a release actually destroys.
//
// Three defects lived here, all of the same shape: a surface froze a POSITION
// and then acted on it after the list underneath had moved. Releasing is the
// only irreversible action in the game, so "acted on the wrong slot" means a
// Pokémon the player never chose is gone with no undo.
//
//   1. PokemonDetailModal addressed its subject by index alone. A cloud
//      reconcile landing while the sheet was open re-aimed the header, the
//      sprite and every footer button — Release included — at whoever now
//      occupied that slot. Reproduced in the running app: opened on BOX003,
//      dispatched LOAD_SAVE with the box reversed, the header changed to
//      BOX396 by itself and Release destroyed b396.
//
//   2. RELEASE_POKEMON re-anchors with `findIndex(p => p.id === pokemonId)`,
//      which resolves to the FIRST match. Two Pokémon sharing an id — which
//      dexRepair's `pokemonIdFloor` exists because saves genuinely produce —
//      meant releasing the later one destroyed the earlier one. Reproduced in
//      the running app too: DUPE-LATER named in the modal and in the
//      confirmation, DUPE-FIRST the one that died.
//
//   3. A context menu left open while its subject was deposited, sold or
//      listed still asked "this cannot be undone", took the yes, and dispatched
//      into a reducer that correctly refused it. Nothing was destroyed, which
//      is the only reason that one was a papercut — but confirming a permanent
//      deletion and watching nothing happen is indistinguishable from a lost
//      save.
//
// The reducer is not ours to change and its guards are correct; these are the
// UI-side anchors and refusals that keep the wrong Pokémon out of reach of it.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { reducer } from "../src/state/reducer";
import { resolveAnchoredIndex } from "../src/utils/pokemonAnchor";
import { decideRelease } from "../src/utils/releaseAtClick";
import {
  AMBIGUOUS_ID_REASON,
  duplicateIdSet,
  isBulkReleasable,
  releaseBlockedReason,
} from "../src/utils/releaseConfirm";
import { makeMon, makeState } from "./helpers";
import type { GameState, Pokemon } from "../src/types";

const ids = (s: GameState) => s.box.map((m) => m.id);
const partyIds = (s: GameState) => s.party.map((m) => m.id);

/** A box whose entries are trivially identifiable by id. */
function boxOf(n: number, over: (i: number) => Partial<Pokemon> = () => ({})): Pokemon[] {
  return Array.from({ length: n }, (_, i) => makeMon({ id: `b${i}`, nickname: `BOX${i}`, ...over(i) }));
}

// ---------------------------------------------------------------------------
// 1. The anchor itself
// ---------------------------------------------------------------------------

describe("resolveAnchoredIndex", () => {
  it("keeps the frozen index while it still holds that id", () => {
    const box = boxOf(5);
    expect(resolveAnchoredIndex(box, { index: 3, pokemonId: "b3" })).toBe(3);
  });

  it("re-finds the subject after the list moves underneath it", () => {
    const box = boxOf(5);
    // An auction settles: the entry BEFORE the subject leaves, pulling it down.
    const after = box.filter((p) => p.id !== "b1");
    expect(resolveAnchoredIndex(after, { index: 3, pokemonId: "b3" })).toBe(2);
    // A cloud reconcile replaces the box outright, reversed.
    expect(resolveAnchoredIndex([...box].reverse(), { index: 3, pokemonId: "b3" })).toBe(1);
  });

  it("reports -1 when the subject has left the list, rather than the stranger in its slot", () => {
    const box = boxOf(5);
    const after = box.filter((p) => p.id !== "b3");
    expect(resolveAnchoredIndex(after, { index: 3, pokemonId: "b3" })).toBe(-1);
    // The slot is NOT empty — b4 moved into it. That is the whole hazard.
    expect(after[3].id).toBe("b4");
  });

  it("passes an index-only anchor through untouched", () => {
    const box = boxOf(5);
    expect(resolveAnchoredIndex(box, { index: 2 })).toBe(2);
    expect(resolveAnchoredIndex([], { index: 7 })).toBe(7);
  });

  it("prefers the frozen index over the first match when ids collide", () => {
    // Otherwise a sheet opened on the SECOND of two identical ids would
    // silently jump to the first on the next render.
    const box = boxOf(5);
    box[4] = makeMon({ id: "b1", nickname: "COLLIDES" });
    expect(resolveAnchoredIndex(box, { index: 4, pokemonId: "b1" })).toBe(4);
    expect(resolveAnchoredIndex(box, { index: 1, pokemonId: "b1" })).toBe(1);
  });
});

describe("the modal's anchor and RELEASE_POKEMON agree on the target", () => {
  // What the modal does, condensed: resolve, read the mon at the resolved
  // index, dispatch that mon's id.
  const releaseThroughModal = (
    state: GameState,
    anchor: { index: number; pokemonId?: string },
  ): GameState => {
    const index = resolveAnchoredIndex(state.box, anchor);
    const p = index < 0 ? undefined : state.box[index];
    if (!p) return state; // the sheet renders nothing
    return reducer(state, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index, pokemonId: p.id },
    });
  };

  it("releases the mon the sheet was opened on, after the box is reversed", () => {
    const opened = makeState({ box: boxOf(6) });
    const reconciled = { ...opened, box: [...opened.box].reverse() };
    const after = releaseThroughModal(reconciled, { index: 1, pokemonId: "b1" });
    expect(ids(after)).not.toContain("b1");
    expect(ids(after)).toHaveLength(5);
    // The occupant of the frozen index survives — that is the regression.
    expect(ids(after)).toContain("b4");
  });

  it("releases the mon the sheet was opened on, after earlier entries are sold", () => {
    const opened = makeState({ box: boxOf(6) });
    const settled = { ...opened, box: opened.box.filter((p) => !["b0", "b1"].includes(p.id)) };
    const after = releaseThroughModal(settled, { index: 4, pokemonId: "b4" });
    expect(ids(after)).toEqual(["b2", "b3", "b5"]);
  });

  it("destroys nothing when the subject has already left", () => {
    const opened = makeState({ box: boxOf(6) });
    const gone = { ...opened, box: opened.box.filter((p) => p.id !== "b4") };
    const after = releaseThroughModal(gone, { index: 4, pokemonId: "b4" });
    expect(ids(after)).toEqual(ids(gone));
  });

  it("would have destroyed a bystander without the anchor — the bug, pinned", () => {
    // Exactly the pre-change path: index only, no id.
    const opened = makeState({ box: boxOf(6) });
    const reconciled = { ...opened, box: [...opened.box].reverse() };
    const after = releaseThroughModal(reconciled, { index: 1 });
    expect(ids(after)).not.toContain("b4"); // the stranger in the slot
    expect(ids(after)).toContain("b1"); // the mon the player opened, untouched
  });
});

// ---------------------------------------------------------------------------
// 2. Colliding ids
// ---------------------------------------------------------------------------

describe("duplicate ids are refused rather than risked", () => {
  const withDuplicate = () => {
    const box = boxOf(8);
    box[6] = makeMon({ id: "b2", nickname: "DUPE-LATER", level: 92 });
    return box;
  };

  it("duplicateIdSet finds exactly the shared ids", () => {
    expect([...duplicateIdSet(withDuplicate())]).toEqual(["b2"]);
    expect(duplicateIdSet(boxOf(8)).size).toBe(0);
    expect(duplicateIdSet([]).size).toBe(0);
  });

  it("blocks BOTH Pokémon of a colliding pair, with a reason", () => {
    const box = withDuplicate();
    const duplicateIds = duplicateIdSet(box);
    for (const mon of [box[2], box[6]]) {
      expect(
        releaseBlockedReason(mon, "box", { listedPokemonIds: [], party: [], duplicateIds }),
      ).toBe(AMBIGUOUS_ID_REASON);
    }
    // Nobody else is caught by it.
    expect(
      releaseBlockedReason(box[3], "box", { listedPokemonIds: [], party: [], duplicateIds }),
    ).toBeNull();
  });

  it("keeps a colliding pair out of the bulk selection", () => {
    const box = withDuplicate();
    const duplicateIds = duplicateIdSet(box);
    expect(isBulkReleasable(box[2], [], duplicateIds)).toBe(false);
    expect(isBulkReleasable(box[6], [], duplicateIds)).toBe(false);
    expect(isBulkReleasable(box[3], [], duplicateIds)).toBe(true);
    // Omitting the set keeps the old behaviour for callers that have no list.
    expect(isBulkReleasable(box[6], [])).toBe(true);
  });

  it("is why the block exists: the reducer would take the FIRST match", () => {
    // Not a wish — this is what the reducer does today, and it is correct for
    // unique ids. The UI refusal above is what keeps it out of this situation.
    const state = makeState({ box: withDuplicate() });
    const after = reducer(state, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: 6, pokemonId: "b2" },
    });
    expect(after.box.find((p) => p.nickname === "DUPE-LATER")).toBeTruthy();
    expect(after.box.find((p) => p.nickname === "BOX2")).toBeUndefined();
  });

  it("is why the block exists for BULK too: RELEASE_MANY takes both", () => {
    const state = makeState({ box: withDuplicate(), party: [makeMon({ id: "lead" })] });
    const after = reducer(state, {
      type: "RELEASE_MANY",
      payload: { source: "box", pokemonIds: ["b2"] },
    });
    expect(after.box).toHaveLength(6);
    expect(after.box.some((p) => p.id === "b2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Deciding at click time, not at menu-open time
// ---------------------------------------------------------------------------

describe("decideRelease", () => {
  let confirmCalls: string[];
  let answer: boolean;
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    confirmCalls = [];
    answer = true;
    (globalThis as { window?: unknown }).window = {
      confirm: (msg: string) => { confirmCalls.push(msg); return answer; },
    };
  });
  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    vi.restoreAllMocks();
  });

  it("skips silently — and asks NOTHING — when the subject has left the box", () => {
    const live = makeState({ box: boxOf(4).filter((p) => p.id !== "b2") });
    const d = decideRelease("b2", "box", live);
    expect(d).toEqual({ act: "skip", note: "That Pokémon has already left your PC." });
    expect(confirmCalls).toEqual([]);
  });

  it("skips when the subject has left the party", () => {
    const live = makeState({ party: [makeMon({ id: "lead" })] });
    const d = decideRelease("gone", "party", live);
    expect(d.act).toBe("skip");
    expect(confirmCalls).toEqual([]);
  });

  it("skips, without asking, when a guard now refuses it", () => {
    const box = boxOf(4);
    const listed = makeState({ box, listedPokemonIds: ["b1"] });
    expect(decideRelease("b1", "box", listed)).toEqual({
      act: "skip",
      note: "Listed at the auction house — cancel the listing first.",
    });

    const healthy = makeMon({ id: "healthy", currentHp: 30 });
    const fainted = makeMon({ id: "fainted", currentHp: 0 });
    const party = makeState({ party: [healthy, fainted], playerPokemon: healthy });
    expect(decideRelease("healthy", "party", party).act).toBe("skip");
    // The fainted one is genuinely releasable, so it DOES ask — proof the
    // skips above are the guards talking and not a dead code path.
    expect(decideRelease("fainted", "party", party).act).toBe("release");
    expect(confirmCalls).toHaveLength(1);
    confirmCalls = [];

    const dup = boxOf(4);
    dup[3] = makeMon({ id: "b1", nickname: "DUPE" });
    expect(decideRelease("b1", "box", makeState({ box: dup }))).toEqual({
      act: "skip",
      note: AMBIGUOUS_ID_REASON,
    });
    expect(confirmCalls).toEqual([]);
  });

  it("asks with the LIVE Pokémon's name, not the one frozen when the menu opened", () => {
    const box = boxOf(3);
    const live = makeState({
      box: box.map((p) => (p.id === "b1" ? { ...p, nickname: "Renamed" } : p)),
    });
    const d = decideRelease("b1", "box", live);
    expect(d.act).toBe("release");
    expect(confirmCalls).toEqual(["Release Renamed? This cannot be undone."]);
  });

  it("reports the player's no as cancelled, and dispatches nothing", () => {
    answer = false;
    const d = decideRelease("b1", "box", makeState({ box: boxOf(3) }));
    expect(d).toEqual({ act: "cancelled" });
    expect(confirmCalls).toHaveLength(1);
  });

  it("keeps the shiny exception with skip-confirmation ON", () => {
    const box = boxOf(3);
    box[1] = makeMon({ id: "b1", nickname: "Sparkle", isShiny: true });
    const live = makeState({ box, skipReleaseConfirm: true });
    expect(decideRelease("b1", "box", live).act).toBe("release");
    expect(confirmCalls).toEqual(["Release Sparkle? This cannot be undone."]);

    // A plain one with the toggle on still goes through with no dialog — the
    // menu path is unchanged, and the toggle keeps buying what it always did.
    confirmCalls = [];
    expect(decideRelease("b0", "box", live).act).toBe("release");
    expect(confirmCalls).toEqual([]);
  });

  it("hands back the live Pokémon, whose id is what the caller must dispatch", () => {
    const live = makeState({ box: boxOf(3) });
    const d = decideRelease("b2", "box", live);
    expect(d.act === "release" && d.mon.id).toBe("b2");
    // And that dispatch removes exactly it.
    const after = reducer(live, {
      type: "RELEASE_POKEMON",
      payload: { source: "box", index: 0, pokemonId: "b2" },
    });
    expect(ids(after)).toEqual(["b0", "b1"]);
  });

  it("end to end: a menu opened on b1, the box reversed under it, still kills b1", () => {
    const opened = makeState({ box: boxOf(5) });
    const live = { ...opened, box: [...opened.box].reverse() };
    const d = decideRelease("b1", "box", live);
    expect(d.act).toBe("release");
    const after = reducer(live, {
      type: "RELEASE_POKEMON",
      // The frozen index the menu captured, which now points elsewhere.
      payload: { source: "box", index: 1, pokemonId: "b1" },
    });
    expect(ids(after)).toEqual(["b4", "b3", "b2", "b0"]);
  });

  it("end to end: a party menu that went stale releases nothing and asks nothing", () => {
    const a = makeMon({ id: "pa", currentHp: 30 });
    const b = makeMon({ id: "pb", currentHp: 30 });
    const c = makeMon({ id: "pc", currentHp: 30 });
    const opened = makeState({ party: [a, b, c], playerPokemon: a });
    // pb is deposited while the menu is open.
    const live = reducer(opened, { type: "PARTY_TO_BOX", payload: { partyIndex: 1 } });
    expect(partyIds(live)).toEqual(["pa", "pc"]);
    const d = decideRelease("pb", "party", live);
    expect(d.act).toBe("skip");
    expect(confirmCalls).toEqual([]);
    expect(partyIds(live)).toEqual(["pa", "pc"]);
  });
});
