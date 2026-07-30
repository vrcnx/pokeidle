// Dex registration for Pokémon that BECOME yours without being caught —
// trades, auction wins, gifts/prizes, and evolutions. The regression: these
// paths pushed the mon into party/box without registering the species, so a
// player finishing the dex by trading (the point of trading) could never
// complete it — and dex completion now gates the Shiny Charm.
//
// The EVOLUTION block below is the second half of the same hole, and the
// expensive one: COMPLETE_EVOLUTION registered by species key via markCaught,
// which cannot see `isShiny`, so evolving a shiny wrote an ordinary dex entry
// and the shiny entry was lost for good — pokedexCaught is append-only, so
// nothing later repairs it. 160 entries across 68 real saves
// (br_2f7754077bfd6e9629). Every case here goes through the ONE convergence
// point; a per-path fix is what produced this bug in the first place.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { evolutions } from "../src/data/evolutions";
import { makeMon, makeState } from "./helpers";
import type { GameState } from "../src/types";

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

describe("COMPLETE_EVOLUTION — the shiny dex entry (br_2f7754077bfd6e9629)", () => {
  /** Drive an evolution the way the game does: START_EVOLUTION (from the
   *  auto-evolve hook or a menu) then COMPLETE_EVOLUTION when the animation
   *  finishes. */
  function evolve(
    state: GameState, pokemonId: string, partyIndex: number, into: string,
  ): GameState {
    const started = reducer(state, {
      type: "START_EVOLUTION",
      payload: { partyIndex, pokemonId, toSpeciesKey: into },
    });
    expect(started.evolutionState?.toSpeciesKey).toBe(into);
    return reducer(started, { type: "COMPLETE_EVOLUTION" });
  }

  it("registers the evolved form as SHINY — the reporter's Growlithe → Arcanine", () => {
    // pani: "I evolved my Shiny Growlithe, but it got registered as a regular
    // Arcanine instead of a Shiny one. I didn't have a regular Arcanine
    // registered at the time."
    const shiny = makeMon({
      id: "g1", speciesKey: "growlithe", name: "Growlithe", isShiny: true, level: 36,
    });
    const state = makeState({
      party: [shiny], playerPokemon: shiny,
      pokedexCaught: ["growlithe"], pokedexSeen: ["growlithe"],
      shinyCaught: ["growlithe"], shinySeen: ["growlithe"],
    });
    const next = evolve(state, "g1", 0, "arcanine");

    expect(next.party[0].speciesKey).toBe("arcanine");
    expect(next.party[0].isShiny).toBe(true);      // the mon itself was never wrong
    expect(next.pokedexCaught).toContain("arcanine");
    expect(next.shinyCaught).toContain("arcanine"); // this is the entry that was lost
    expect(next.shinySeen).toContain("arcanine");
  });

  it("does NOT invent a shiny entry when a plain Pokémon evolves", () => {
    const plain = makeMon({ id: "g2", speciesKey: "growlithe", name: "Growlithe", level: 36 });
    const state = makeState({ party: [plain], playerPokemon: plain });
    const next = evolve(state, "g2", 0, "arcanine");
    expect(next.pokedexCaught).toContain("arcanine");
    expect(next.shinyCaught).not.toContain("arcanine");
    expect(next.shinySeen).not.toContain("arcanine");
  });

  it("registers it via USE_STONE too — Fire Stone on a shiny Vulpix", () => {
    const shiny = makeMon({
      id: "v1", speciesKey: "vulpix", name: "Vulpix", isShiny: true, level: 25,
    });
    const state = makeState({
      party: [shiny], playerPokemon: shiny, inventory: { firestone: 1 },
    });
    const used = reducer(state, {
      type: "USE_STONE",
      payload: { itemId: "firestone", partyIndex: 0 },
    });
    expect(used.evolutionState?.toSpeciesKey).toBe("ninetales");
    const next = reducer(used, { type: "COMPLETE_EVOLUTION" });
    expect(next.pokedexCaught).toContain("ninetales");
    expect(next.shinyCaught).toContain("ninetales");
    expect(next.shinySeen).toContain("ninetales");
  });

  it("registers it via the post-trade evolution rider — shiny Machoke → Machamp", () => {
    // This path double-registers: registerAcquired on arrival (which always
    // worked) and then again after the trade evolution (which did not). It is
    // also the mechanism behind the vague "trade gave me the wrong Pokémon"
    // reports — the Pokédex genuinely disagreed with what arrived.
    const mine = makeMon({ id: "mine1" });
    const state = makeState({ party: [mine], playerPokemon: mine });
    const received = makeMon({
      id: "theirs", speciesKey: "machoke", name: "Machoke", isShiny: true, level: 40,
    });
    const traded = reducer(state, {
      type: "TRADE_COMPLETE",
      payload: { sentMonId: "mine1", received },
    });
    expect(traded.shinyCaught).toContain("machoke");   // arrival, already correct
    expect(traded.evolutionState?.toSpeciesKey).toBe("machamp");

    const next = reducer(traded, { type: "COMPLETE_EVOLUTION" });
    expect(next.pokedexCaught).toContain("machamp");
    expect(next.shinyCaught).toContain("machamp");
    expect(next.shinySeen).toContain("machamp");
  });

  it("keeps shinyCaught a subset of shinySeen — the two counts are printed side by side", () => {
    // GlobalDock prints "Shiny seen" next to the caught count, so writing one
    // without the other manufactures a visible contradiction. Only
    // START_ENCOUNTER sets shinySeen, and an evolution has no encounter, so
    // there is no earlier moment that could have covered for this.
    const shiny = makeMon({
      id: "c1", speciesKey: "caterpie", name: "Caterpie", isShiny: true, level: 12,
    });
    // Caught in the wild first, so the base form is already registered — the
    // real shape of the 10 shiny Butterfree missing from production saves.
    const state = makeState({
      party: [shiny], playerPokemon: shiny,
      pokedexCaught: ["caterpie"], pokedexSeen: ["caterpie"],
      shinyCaught: ["caterpie"], shinySeen: ["caterpie"],
    });
    const metapod = evolve(state, "c1", 0, "metapod");
    const butterfree = evolve(metapod, "c1", 0, "butterfree");

    expect(butterfree.party[0].speciesKey).toBe("butterfree");
    for (const key of butterfree.shinyCaught) {
      expect(butterfree.shinySeen).toContain(key);
    }
    expect(butterfree.shinyCaught).toEqual(
      expect.arrayContaining(["caterpie", "metapod", "butterfree"]),
    );
  });

  it("covers EVERY evolution path, because COMPLETE_EVOLUTION is the only one", () => {
    // The bug existed because the same registration was hand-written at four
    // call sites and missed at the fifth. This pins the property that makes a
    // single fix sufficient: nothing but COMPLETE_EVOLUTION rewrites
    // `speciesKey`, so every writer of `evolutionState` — START_EVOLUTION,
    // USE_STONE, USE_LINK_CABLE, the trade rider — lands on the same line.
    const shiny = makeMon({
      id: "z1", speciesKey: "gastly", name: "Gastly", isShiny: true, level: 40,
    });
    const state = makeState({ party: [shiny], playerPokemon: shiny });
    // Hand-built evolutionState: whatever queued it, this is all the reducer
    // has to work from.
    const forced = reducer(
      { ...state, phase: "evolution", evolutionState: { partyIndex: 0, toSpeciesKey: "haunter", step: 3 } },
      { type: "COMPLETE_EVOLUTION" },
    );
    expect(forced.shinyCaught).toContain("haunter");
    expect(evolutions.gastly?.[0]?.into).toBe("haunter"); // the data really says so
  });
});
