// Dex registration for Pokémon that ARRIVE rather than being caught —
// trades, auction wins, gifts/prizes. The regression: these paths pushed
// the mon into party/box without registering the species, so a player
// finishing the dex by trading (the point of trading) could never complete
// it — and dex completion now gates the Shiny Charm.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState } from "./helpers";

describe("TRADE_COMPLETE", () => {
  it("registers the received species (and its shiny flag) in the dex", () => {
    const mine = makeMon({ id: "mine1" });
    const spare = makeMon({ id: "spare1" });
    const state = makeState({ party: [mine, spare], playerPokemon: mine });
    const received = makeMon({ id: "theirs", speciesKey: "lapras", name: "Lapras", isShiny: true });
    const next = reducer(state, {
      type: "TRADE_COMPLETE",
      payload: { sentMonId: "mine1", received },
    });
    expect(next.pokedexCaught).toContain("lapras");
    expect(next.pokedexSeen).toContain("lapras");
    expect(next.shinyCaught).toContain("lapras");
    // The mon itself landed in the vacated slot with a fresh local id.
    expect(next.party.some((m) => m.speciesKey === "lapras")).toBe(true);
    expect(next.party.some((m) => m.id === "theirs")).toBe(false);
  });

  it("drops the trade cleanly when the sent mon is not found (stale tab)", () => {
    const state = makeState();
    const next = reducer(state, {
      type: "TRADE_COMPLETE",
      payload: { sentMonId: "not-here", received: makeMon({ speciesKey: "lapras" }) },
    });
    expect(next.party).toEqual(state.party);
    expect(next.battleLog.at(-1)).toContain("Trade failed");
  });
});

describe("AUCTION_SETTLED (buyer)", () => {
  it("registers the won species and sets money to the server's authoritative value", () => {
    const state = makeState({ money: 999 });
    const won = makeMon({ id: "srv-id", speciesKey: "dratini", name: "Dratini" });
    const next = reducer(state, {
      type: "AUCTION_SETTLED",
      payload: { role: "buyer", pokemon: won, money: 499, logMessage: "You won the auction!" },
    });
    expect(next.pokedexCaught).toContain("dratini");
    expect(next.money).toBe(499); // set, not added — server is the sole writer here
    expect([...next.party, ...next.box].some((m) => m.speciesKey === "dratini")).toBe(true);
  });
});

describe("RECEIVE_GIFT", () => {
  it("registers a prize mon under the server-assigned id and dedupes a re-echo", () => {
    const state = makeState();
    const prize = {
      kind: "pokemon" as const,
      label: "Dratini",
      mon: makeMon({ speciesKey: "dratini", name: "Dratini" }) as unknown as Record<string, unknown>,
      assignedId: "pgGrant1_0",
    };
    const once = reducer(state, { type: "RECEIVE_GIFT", payload: { prizes: [prize] } });
    expect(once.box.some((m) => m.id === "pgGrant1_0")).toBe(true);
    expect(once.pokedexCaught).toContain("dratini");

    // A re-delivered echo (or the copy arriving via the cloud first) must
    // not hand out a one-off prize twice.
    const twice = reducer(once, { type: "RECEIVE_GIFT", payload: { prizes: [prize] } });
    expect(twice.box.filter((m) => m.id === "pgGrant1_0")).toHaveLength(1);
  });

  it("adds money/items with the same ceilings the server clamps to", () => {
    const state = makeState({ money: 999_999_990, inventory: { masterball: 999_998 } });
    const next = reducer(state, {
      type: "RECEIVE_GIFT",
      payload: {
        prizes: [
          { kind: "money", amount: 500 },
          { kind: "item", itemId: "masterball", quantity: 5 },
        ],
      },
    });
    expect(next.money).toBe(999_999_999);
    expect(next.inventory.masterball).toBe(999_999);
  });
});
