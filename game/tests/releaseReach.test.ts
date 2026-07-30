// Releasing is the only irreversible action in the game, and the owner
// reported that clicking a Pokémon to release it "does nothing". Two separate
// mechanisms produced that report, and this file pins the one that is pure:
// the UI's copy of the reducer's refusal rules.
//
// The other mechanism — the drag controller arming a 180 ms long-press timer
// for the MOUSE and then swallowing the click that pointerup synthesises — is
// a pointer-event race and is verified by driving the running app, not here.
// See dragController.ts.
//
// What is testable here is that the UI never OFFERS a release the reducer will
// refuse. It used to: the detail modal put a Release button on an
// auction-listed Pokémon, asked "this cannot be undone", took the
// confirmation, dispatched, and the reducer correctly refused it — so the
// player confirmed a permanent deletion and watched nothing happen. Same for
// the last party member and the last HEALTHY party member.
//
// releaseBlockedReason is that copy. The reducer keeps its own guards on
// purpose: this one is about not showing the player a lie, that one is about
// not losing a Pokémon if this one is ever wrong. The final describe block
// below is what stops the two drifting apart.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import {
  bulkReleaseConfirmMessage,
  isBulkReleasable,
  needsReleaseConfirm,
  releaseBlockedReason,
  releaseConfirmMessage,
} from "../src/utils/releaseConfirm";
import { makeMon, makeState } from "./helpers";
import type { Pokemon } from "../src/types";

const noCtx = (over: { listedPokemonIds?: string[]; party?: Pokemon[] } = {}) => ({
  listedPokemonIds: over.listedPokemonIds ?? [],
  party: over.party ?? [],
});

describe("releaseBlockedReason — box", () => {
  it("lets an ordinary box Pokémon through", () => {
    const mon = makeMon({ id: "junk" });
    expect(releaseBlockedReason(mon, "box", noCtx())).toBeNull();
  });

  it("refuses an auction-listed Pokémon, and says why", () => {
    const mon = makeMon({ id: "listed" });
    const reason = releaseBlockedReason(mon, "box", noCtx({ listedPokemonIds: ["listed"] }));
    expect(reason).toMatch(/auction house/i);
  });

  it("does NOT block a shiny — a shiny is single-releasable, it just always asks", () => {
    // The shiny rule lives in needsReleaseConfirm (a confirmation) and in
    // isBulkReleasable (a hard refusal for BULK only). Blocking it here would
    // be a third, wrong rule: a player who deliberately releases one shiny is
    // allowed to.
    const shiny = makeMon({ id: "shiny", isShiny: true });
    expect(releaseBlockedReason(shiny, "box", noCtx())).toBeNull();
    expect(needsReleaseConfirm(shiny, true)).toBe(true);
    expect(isBulkReleasable(shiny, [])).toBe(false);
  });
});

describe("releaseBlockedReason — party", () => {
  it("refuses the last party member", () => {
    const solo = makeMon({ id: "solo" });
    expect(releaseBlockedReason(solo, "party", noCtx({ party: [solo] }))).toMatch(/last Pokémon/i);
  });

  it("refuses the last HEALTHY member while a fainted one is still there", () => {
    const healthy = makeMon({ id: "healthy", currentHp: 100 });
    const fainted = makeMon({ id: "fainted", currentHp: 0 });
    const party = [healthy, fainted];
    expect(releaseBlockedReason(healthy, "party", noCtx({ party }))).toMatch(/last healthy/i);
    // …and the fainted one is fine to let go of.
    expect(releaseBlockedReason(fainted, "party", noCtx({ party }))).toBeNull();
  });

  it("allows pruning an all-fainted party down", () => {
    const a = makeMon({ id: "a", currentHp: 0 });
    const b = makeMon({ id: "b", currentHp: 0 });
    expect(releaseBlockedReason(a, "party", noCtx({ party: [a, b] }))).toBeNull();
  });

  it("allows a release when another healthy member remains", () => {
    const a = makeMon({ id: "a", currentHp: 100 });
    const b = makeMon({ id: "b", currentHp: 100 });
    expect(releaseBlockedReason(a, "party", noCtx({ party: [a, b] }))).toBeNull();
  });

  it("anchors on id, not on position — a menu's frozen index means nothing here", () => {
    const healthy = makeMon({ id: "healthy", currentHp: 100 });
    const fainted = makeMon({ id: "fainted", currentHp: 0 });
    // Same two Pokémon, opposite order. The answer must not move with them.
    expect(releaseBlockedReason(healthy, "party", noCtx({ party: [healthy, fainted] })))
      .toMatch(/last healthy/i);
    expect(releaseBlockedReason(healthy, "party", noCtx({ party: [fainted, healthy] })))
      .toMatch(/last healthy/i);
  });

  it("says nothing when the Pokémon has already left the party", () => {
    // The reducer drops the action; inventing a reason here would put a
    // sentence on screen about a Pokémon that is not there.
    const gone = makeMon({ id: "gone" });
    const a = makeMon({ id: "a" });
    const b = makeMon({ id: "b" });
    expect(releaseBlockedReason(gone, "party", noCtx({ party: [a, b] }))).toBeNull();
  });

  it("the auction guard outranks the party guards", () => {
    const solo = makeMon({ id: "solo" });
    expect(
      releaseBlockedReason(solo, "party", noCtx({ party: [solo], listedPokemonIds: ["solo"] })),
    ).toMatch(/auction house/i);
  });
});

describe("releaseConfirmMessage", () => {
  it("is the full warning whenever the surface is going to ask", () => {
    const mon = makeMon({ id: "m", name: "Magikarp" });
    expect(releaseConfirmMessage(mon, false)).toBe("Release Magikarp? This cannot be undone.");
  });

  it("is the full warning for a SHINY even with skip-confirmation on", () => {
    const shiny = makeMon({ id: "s", name: "Magikarp", isShiny: true });
    expect(needsReleaseConfirm(shiny, true)).toBe(true);
    expect(releaseConfirmMessage(shiny, true)).toBe("Release Magikarp? This cannot be undone.");
  });

  it("drops to the short form only where the toggle actually applies", () => {
    const mon = makeMon({ id: "m", name: "Magikarp" });
    expect(needsReleaseConfirm(mon, true)).toBe(false);
    expect(releaseConfirmMessage(mon, true)).toBe("Release Magikarp?");
  });

  it("uses the nickname the player gave it, not the species", () => {
    const mon = makeMon({ id: "m", name: "Magikarp", nickname: "Splashy" });
    expect(releaseConfirmMessage(mon, false)).toBe("Release Splashy? This cannot be undone.");
    // A whitespace-only nickname is not a name.
    expect(releaseConfirmMessage(makeMon({ name: "Magikarp", nickname: "   " }), false))
      .toBe("Release Magikarp? This cannot be undone.");
  });

  it("leaves the bulk wording alone — never skippable, always counted", () => {
    expect(bulkReleaseConfirmMessage(1)).toBe("Release 1 Pokémon? This cannot be undone.");
    expect(bulkReleaseConfirmMessage(37)).toBe("Release 37 Pokémon? This cannot be undone.");
  });
});

// The point of the whole file. Every case below runs BOTH the predicate the UI
// uses to decide whether to offer Release and the reducer that actually
// performs it, and asserts they agree. A disagreement in either direction is a
// bug: offering what will be refused is the reported "confirmed it and nothing
// happened", and refusing what would have worked silently removes a legal
// action from the player.
describe("releaseBlockedReason agrees with RELEASE_POKEMON", () => {
  const cases: {
    name: string;
    source: "party" | "box";
    party?: Pokemon[];
    box?: Pokemon[];
    listed?: string[];
    targetId: string;
  }[] = [
    {
      name: "ordinary box mon",
      source: "box",
      box: [makeMon({ id: "b1" }), makeMon({ id: "b2" })],
      targetId: "b1",
    },
    {
      name: "shiny box mon",
      source: "box",
      box: [makeMon({ id: "bs", isShiny: true }), makeMon({ id: "b2" })],
      targetId: "bs",
    },
    {
      name: "auction-listed box mon",
      source: "box",
      box: [makeMon({ id: "bl" }), makeMon({ id: "b2" })],
      listed: ["bl"],
      targetId: "bl",
    },
    {
      name: "one-member party",
      source: "party",
      party: [makeMon({ id: "p1", currentHp: 100 })],
      targetId: "p1",
    },
    {
      name: "last healthy member, fainted friend present",
      source: "party",
      party: [makeMon({ id: "ph", currentHp: 100 }), makeMon({ id: "pf", currentHp: 0 })],
      targetId: "ph",
    },
    {
      name: "the fainted friend itself",
      source: "party",
      party: [makeMon({ id: "ph", currentHp: 100 }), makeMon({ id: "pf", currentHp: 0 })],
      targetId: "pf",
    },
    {
      name: "one of two healthy members",
      source: "party",
      party: [makeMon({ id: "pa", currentHp: 100 }), makeMon({ id: "pb", currentHp: 100 })],
      targetId: "pa",
    },
    {
      name: "all-fainted party, pruning one",
      source: "party",
      party: [makeMon({ id: "pa", currentHp: 0 }), makeMon({ id: "pb", currentHp: 0 })],
      targetId: "pa",
    },
    {
      name: "auction-listed party member",
      source: "party",
      party: [makeMon({ id: "pl", currentHp: 100 }), makeMon({ id: "pb", currentHp: 100 })],
      listed: ["pl"],
      targetId: "pl",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const party = c.party ?? [makeMon({ id: "keeper", currentHp: 100 }), makeMon({ id: "keeper2", currentHp: 100 })];
      const state = makeState({
        party,
        playerPokemon: party[0],
        activePlayerPokemonIndex: 0,
        box: c.box ?? [],
        listedPokemonIds: c.listed ?? [],
      });
      const list = c.source === "party" ? state.party : state.box;
      const target = list.find((m) => m.id === c.targetId)!;
      expect(target).toBeDefined();

      const uiWouldOffer =
        releaseBlockedReason(target, c.source, {
          listedPokemonIds: state.listedPokemonIds ?? [],
          party: state.party,
        }) === null;

      const after = reducer(state, {
        type: "RELEASE_POKEMON",
        payload: {
          source: c.source,
          index: list.findIndex((m) => m.id === c.targetId),
          pokemonId: c.targetId,
        },
      });
      const afterList = c.source === "party" ? after.party : after.box;
      const reducerRemovedIt = !afterList.some((m) => m.id === c.targetId);

      expect(uiWouldOffer).toBe(reducerRemovedIt);
    });
  }
});
