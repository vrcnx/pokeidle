// Load-time save integrity: the two repairs in utils/dexRepair.ts, the
// COMPLETE_EVOLUTION id anchor, and the Shiny Charm the gift path used to eat.
//
// All four are about SILENT, PERMANENT loss — a dex entry that can never be
// re-earned (pokedexCaught is append-only), a Pokémon transformed into the wrong
// species, a one-time charm grant logged but not delivered. None of them throw,
// none of them show up in a screenshot, and three of them were only visible by
// querying production.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import {
  pokemonIdFloor, repairDexFromOwned, repairLoadedSave,
} from "../src/utils/dexRepair";
import { obtainableSpecies } from "../src/utils/obtainable";
import { SHINY_CHARM_ITEM } from "../src/utils/shinyCharm";
import type { GameState } from "../src/types";
import { makeMon, makeState } from "./helpers";

function loadSave(into: GameState, blob: Partial<GameState>): GameState {
  return reducer(into, { type: "LOAD_SAVE", payload: { state: blob as GameState } });
}

// ---------------------------------------------------------------------------
// Anything you HOLD is registered.
//
// The reducer's registerAcquired covers every path where the CLIENT hands you a
// Pokémon. The SERVER has its own: auction settlement and prize grants write a
// mon straight into the stored save. If the player was offline for the socket
// echo, the cloud adopt is the only thing that ever sees it — and LOAD_SAVE
// registered nothing. Production had 39 such species across 28 accounts,
// including legendaries (reshiram, lugia, entei, raikou, genesect, deoxys) that
// have no local registration path at all.
// ---------------------------------------------------------------------------
describe("LOAD_SAVE registers what the save holds", () => {
  it("registers a server-authored shiny that arrived with an empty dex", () => {
    const shiny = makeMon({ id: "99", speciesKey: "lapras", name: "Lapras", isShiny: true });
    const state = makeState();
    const loaded = loadSave(state, {
      ...state,
      party: [makeMon({ id: "1", speciesKey: "pikachu" })],
      box: [shiny],
      pokedexCaught: [], pokedexSeen: [], shinyCaught: [], shinySeen: [],
    });
    expect(loaded.pokedexCaught).toContain("lapras");
    expect(loaded.pokedexSeen).toContain("lapras");
    expect(loaded.shinyCaught).toContain("lapras");
    expect(loaded.shinySeen).toContain("lapras");
  });

  it("registers a legendary the client could never have registered itself", () => {
    const state = makeState();
    const loaded = loadSave(state, {
      ...state,
      party: [makeMon({ id: "1", speciesKey: "reshiram", name: "Reshiram" })],
      box: [],
      pokedexCaught: [], pokedexSeen: [], shinyCaught: [], shinySeen: [],
    });
    expect(loaded.pokedexCaught).toContain("reshiram");
  });

  it("repairs the historical shiny loss — the evolved form you still hold", () => {
    // br_2f7754077bfd6e9629: the old evolution path called markCaught, so a
    // shiny Growlithe that became an Arcanine registered "arcanine" as ordinary.
    // 163 entries across 70 real saves. Every one of those mons is still owned,
    // so walking what the player holds restores the entry with no migration.
    const state = makeState();
    const loaded = loadSave(state, {
      ...state,
      party: [makeMon({ id: "5", speciesKey: "arcanine", name: "Arcanine", isShiny: true })],
      box: [],
      pokedexCaught: ["growlithe", "arcanine"],
      pokedexSeen: ["growlithe", "arcanine"],
      shinyCaught: ["growlithe"], // arcanine missing — exactly pani's save
      shinySeen: ["growlithe"],
    });
    expect(loaded.shinyCaught).toContain("arcanine");
    expect(loaded.shinySeen).toContain("arcanine");
  });

  it("is strictly ADDITIVE — never drops an entry for a species no longer owned", () => {
    const state = makeState();
    const loaded = loadSave(state, {
      ...state,
      party: [makeMon({ id: "1", speciesKey: "pikachu" })],
      box: [],
      // Registered from a mon since released/traded/evolved away. Append-only
      // means these must survive.
      pokedexCaught: ["mew", "dratini"],
      pokedexSeen: ["mew", "dratini"],
      shinyCaught: ["mew"],
      shinySeen: ["mew"],
    });
    expect(loaded.pokedexCaught).toContain("mew");
    expect(loaded.pokedexCaught).toContain("dratini");
    expect(loaded.shinyCaught).toContain("mew");
  });

  it("never invents a shiny entry from a non-shiny or legacy mon", () => {
    const state = makeState();
    const loaded = loadSave(state, {
      ...state,
      party: [
        makeMon({ id: "1", speciesKey: "pidgey", isShiny: false }),
        // `isShiny` absent entirely, as on pre-field saves.
        { ...makeMon({ id: "2", speciesKey: "rattata" }), isShiny: undefined } as never,
      ],
      box: [],
      pokedexCaught: [], pokedexSeen: [], shinyCaught: [], shinySeen: [],
    });
    expect(loaded.pokedexCaught).toEqual(expect.arrayContaining(["pidgey", "rattata"]));
    expect(loaded.shinyCaught).toEqual([]);
    expect(loaded.shinySeen).toEqual([]);
  });

  it("keeps array identity when there is nothing to repair", () => {
    // This runs on every load over a box that can hold 9,999 mons; a healthy
    // save must not churn four arrays and re-render everything keyed on them.
    const healthy = makeState({
      party: [makeMon({ id: "1", speciesKey: "pikachu" })],
      box: [],
      pokedexCaught: ["pikachu"], pokedexSeen: ["pikachu"],
      shinyCaught: [], shinySeen: [],
    });
    expect(repairDexFromOwned(healthy)).toBe(healthy);
  });

  it("grants the Shiny Charm if the repair itself completes the dex", () => {
    const all = [...obtainableSpecies()];
    const last = all[all.length - 1];
    const state = makeState();
    const loaded = loadSave(state, {
      ...state,
      party: [makeMon({ id: "1", speciesKey: last })],
      box: [],
      pokedexCaught: all.slice(0, -1),
      pokedexSeen: all.slice(0, -1),
      shinyCaught: [], shinySeen: [],
      inventory: {},
    });
    expect(loaded.pokedexCaught).toContain(last);
    expect(loaded.inventory[SHINY_CHARM_ITEM]).toBe(1);
  });

  it("handles a 9,999-mon box without blowing up", () => {
    const box = Array.from({ length: 9999 }, (_, i) =>
      makeMon({ id: String(i + 1), speciesKey: i % 2 ? "pidgey" : "rattata", isShiny: i === 4242 }),
    );
    const state = makeState();
    const loaded = loadSave(state, {
      ...state, party: [], box,
      pokedexCaught: [], pokedexSeen: [], shinyCaught: [], shinySeen: [],
    });
    expect(loaded.pokedexCaught.sort()).toEqual(["pidgey", "rattata"]);
    expect(loaded.shinyCaught).toEqual(["rattata"]); // index 4242 is even
  });
});

// ---------------------------------------------------------------------------
// nextPokemonId must never sink below a live id.
//
// Ids are String(nextPokemonId) from a per-save counter that RESTARTS at 1 after
// an admin reset or a cloud-lineage adopt. If the counter regresses below mons
// already in the party/box, two Pokémon eventually share an id and every
// id-addressed operation targets the wrong one — the release re-anchor, both
// evolution anchors, and the auction/gift dedupe.
// ---------------------------------------------------------------------------
describe("LOAD_SAVE clamps nextPokemonId monotone", () => {
  it("refuses a counter that would collide with a live id", () => {
    const state = makeState({ party: [makeMon({ id: "7" })], box: [makeMon({ id: "12" })] });
    const loaded = loadSave(state, { ...state, nextPokemonId: 1 });
    expect(loaded.nextPokemonId).toBe(13); // one past the highest live id
  });

  it("keeps a counter that is already ahead", () => {
    const state = makeState({ party: [makeMon({ id: "3" })], box: [] });
    const loaded = loadSave(state, { ...state, nextPokemonId: 500 });
    expect(loaded.nextPokemonId).toBe(500);
  });

  it("ignores non-numeric ids so a gift id cannot inflate the counter", () => {
    // `gift12` / server grant ids live outside the counter's space on purpose.
    const state = makeState({
      party: [makeMon({ id: "2" })],
      box: [makeMon({ id: "gift99" }), makeMon({ id: "a4242" })],
    });
    expect(pokemonIdFloor(state)).toBe(3);
  });

  it("the clamped counter cannot mint an id something already holds", () => {
    // The whole point, stated as the property. After the clamp, minting ids
    // upward from nextPokemonId can never hit a live one.
    const state = makeState({
      party: [makeMon({ id: "4" }), makeMon({ id: "9" })],
      box: [makeMon({ id: "17" })],
      nextPokemonId: 1,
    });
    const repaired = repairLoadedSave(state);
    const live = new Set([...repaired.party, ...repaired.box].map((p) => p.id));
    for (let i = 0; i < 50; i++) {
      expect(live.has(String(repaired.nextPokemonId + i))) .toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The evolution cinematic runs ~3.7s with only an INDEX in state.
// ---------------------------------------------------------------------------
describe("COMPLETE_EVOLUTION re-anchors on the Pokémon's id", () => {
  function startShinyGrowlitheEvolution() {
    const shiny = makeMon({
      id: "g1", speciesKey: "growlithe", name: "Growlithe", isShiny: true, level: 40,
    });
    const plain = makeMon({ id: "b1", speciesKey: "bulbasaur", name: "Bulbasaur", level: 40 });
    const s = makeState({ party: [shiny, plain], playerPokemon: shiny, nextPokemonId: 50 });
    return reducer(s, {
      type: "START_EVOLUTION",
      payload: { partyIndex: 0, toSpeciesKey: "arcanine", pokemonId: "g1" },
    });
  }

  it("records the id when the evolution starts", () => {
    expect(startShinyGrowlitheEvolution().evolutionState?.pokemonId).toBe("g1");
  });

  it("evolves the right Pokémon after a party swap mid-cinematic", () => {
    // Index-only, this turned the BULBASAUR into an Arcanine, registered
    // "arcanine" as non-shiny, and left the shiny Growlithe untouched — the
    // br_2f7754077bfd6e9629 loss plus a destroyed bystander.
    let s = startShinyGrowlitheEvolution();
    s = reducer(s, { type: "SWAP_PARTY", payload: { a: 0, b: 1 } });
    expect(s.party.map((p) => p.speciesKey)).toEqual(["bulbasaur", "growlithe"]);

    const done = reducer(s, { type: "COMPLETE_EVOLUTION" });
    expect(done.party[0].speciesKey).toBe("bulbasaur"); // bystander survives
    expect(done.party[1].speciesKey).toBe("arcanine");
    expect(done.party[1].isShiny).toBe(true);
    expect(done.shinyCaught).toContain("arcanine");
  });

  it("drops the evolution if the Pokémon left in the meantime", () => {
    let s = startShinyGrowlitheEvolution();
    s = reducer(s, {
      type: "RELEASE_POKEMON", payload: { source: "party", index: 0, pokemonId: "g1" },
    });
    const done = reducer(s, { type: "COMPLETE_EVOLUTION" });
    // Nothing transformed, and the state is clean rather than stuck.
    expect(done.party.map((p) => p.speciesKey)).toEqual(["bulbasaur"]);
    expect(done.evolutionState).toBeNull();
    expect(done.phase).toBe("idle");
    expect(done.pokedexCaught).not.toContain("arcanine");
  });

  it("still completes by index for a save written before the field existed", () => {
    // Backward compatibility: evolutionState with no pokemonId falls back.
    const mon = makeMon({ id: "x1", speciesKey: "growlithe", name: "Growlithe", level: 40 });
    const s = makeState({
      party: [mon], playerPokemon: mon,
      phase: "evolution",
      evolutionState: { partyIndex: 0, toSpeciesKey: "arcanine", step: 0 },
    });
    const done = reducer(s, { type: "COMPLETE_EVOLUTION" });
    expect(done.party[0].speciesKey).toBe("arcanine");
  });
});

// ---------------------------------------------------------------------------
// The gift path logged the Shiny Charm and delivered nothing.
// ---------------------------------------------------------------------------
describe("RECEIVE_GIFT does not eat the Shiny Charm", () => {
  function giftCompletingDex(extraPrizes: unknown[] = []) {
    const all = [...obtainableSpecies()];
    const last = all[all.length - 1];
    const state = makeState({
      pokedexCaught: all.slice(0, -1), pokedexSeen: all.slice(0, -1), inventory: {},
    });
    return reducer(state, {
      type: "RECEIVE_GIFT",
      payload: {
        prizes: [
          { kind: "pokemon", mon: { ...makeMon({ speciesKey: last }) }, assignedId: "g1" },
          ...extraPrizes,
        ],
      } as never,
    });
  }

  it("delivers the charm the log promises", () => {
    // `inventory` was snapshotted at the top of the case and written back
    // wholesale at the end, clobbering registerAcquired's grant. The player saw
    // "✨ Pokédex complete! The Shiny Charm was added to your Bag" and got
    // nothing — unrecoverable, since pokedexCaught is append-only.
    const next = giftCompletingDex();
    expect(next.battleLog.some((l) => l.includes("Pokédex complete"))).toBe(true);
    expect(next.inventory[SHINY_CHARM_ITEM]).toBe(1);
  });

  it("still applies item prizes in the same gift", () => {
    const next = giftCompletingDex([{ kind: "item", itemId: "pokeball", quantity: 5 }]);
    expect(next.inventory.pokeball).toBe(5);
    expect(next.inventory[SHINY_CHARM_ITEM]).toBe(1);
  });

  it("still applies money prizes", () => {
    const before = makeState().money;
    const next = giftCompletingDex([{ kind: "money", amount: 250 }]);
    expect(next.money).toBe(before + 250);
  });
});
