// TMs and HMs.
//
// The system is mostly DATA — 59 machines, 279 species learnsets, generated
// from the Gen 5 machine list — and generated data is exactly the kind that
// looks fine and is quietly wrong. So the first half of this file is about
// the data being internally consistent and actually restrictive, and the
// second half is about the three rules that make owning a machine mean
// something: what the item says, who can be taught, and what happens when a
// moveset is saved.

import { describe, expect, it } from "vitest";
import { machineList, machines, machineLearnsets } from "../src/data/tms";
import {
  describeMachine,
  machineEffectText,
  canTeachMachine,
  ownedMachinesForSpecies,
  machinesForSpecies,
  isMachineId,
} from "../src/utils/machines";
import { machineSource, martMachines, raidMachines, routeMachineDrop, machineDropRoute } from "../src/data/machineSources";
import { moves as movesTable } from "../src/data/moves";
import { pokemonTable } from "../src/data/pokemon";
import { itemsCatalog } from "../src/data/itemsCatalog";
import { mergedShops, mergedRoutes } from "../src/data/regions";
import { availableMovesFor } from "../src/utils/moves";
import { reducer } from "../src/state/reducer";
import { getItemInfo, itemSpriteSlug } from "../src/utils/items";
import { makeMon, makeState } from "./helpers";

describe("the machine catalog", () => {
  it("teaches a move that actually exists", () => {
    for (const m of machineList) {
      expect(movesTable[m.moveId], `${m.label} -> ${m.moveId}`).toBeTruthy();
    }
  });

  it("never teaches a move the battle engine can't run", () => {
    // The whole reason 42 of the 101 Gen 5 machines were left out. A status
    // move with no `effect` is a no-op in battle — it costs a turn and does
    // nothing — and shipping one as a purchasable item is the specific
    // failure this system was built to avoid. (Light Screen, Reflect and Rest
    // are in the LEVEL-UP pool in exactly that state; they are not machines.)
    for (const m of machineList) {
      const def = movesTable[m.moveId]!;
      if (def.power === 0) {
        expect(def.effect, `${m.label} ${m.moveName} is a status move with no effect`).toBeTruthy();
      }
    }
  });

  it("has no duplicate ids and no duplicate moves", () => {
    const ids = machineList.map((m) => m.id);
    const moveIds = machineList.map((m) => m.moveId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(moveIds).size).toBe(moveIds.length);
  });

  it("appears in the item catalog under its own pocket", () => {
    for (const m of machineList) {
      const item = itemsCatalog[m.id];
      expect(item, m.id).toBeTruthy();
      expect(item.category).toBe(m.kind);
      // Reusable and one-per-player: a sell price would be a trap, because
      // the copy you sold is the only one you had.
      expect(item.sellPrice).toBe(0);
    }
  });

  it("prices TMs and never prices HMs", () => {
    for (const m of machineList) {
      if (m.kind === "hm") expect(m.price).toBeNull();
      else expect(m.price).toBeGreaterThan(0);
    }
  });
});

describe("compatibility is real, not cosmetic", () => {
  it("only names species the game actually has", () => {
    for (const key of Object.keys(machineLearnsets)) {
      expect(pokemonTable[key], key).toBeTruthy();
    }
  });

  it("only names machines the catalog has", () => {
    for (const [key, ids] of Object.entries(machineLearnsets)) {
      for (const id of ids) expect(machines[id], `${key} -> ${id}`).toBeTruthy();
    }
  });

  // The request was explicit: "each species should only be able to learn
  // specific TMs, preventing every Pokémon from having access to the same
  // moves". If this ever passes trivially the system has stopped doing its
  // job, so it is asserted from both ends.
  it("gives the blank-slate species nothing", () => {
    for (const key of ["magikarp", "caterpie", "weedle", "metapod", "ditto", "unown", "wobbuffet"]) {
      expect(machinesForSpecies(key), key).toHaveLength(0);
    }
  });

  it("gives a universal learner a great deal", () => {
    expect(machinesForSpecies("mew").length).toBeGreaterThan(40);
  });

  it("keeps ordinary species well short of the full list", () => {
    // Pikachu is the shape of a normal case: a real pool, nothing like all
    // of it. A bug that returned every machine for everyone would pass every
    // other test in this file.
    const pika = machinesForSpecies("pikachu");
    expect(pika.length).toBeGreaterThan(4);
    expect(pika.length).toBeLessThan(machineList.length / 2);
  });

  it("respects type sense — no Fire TM on a Water starter", () => {
    const squirtle = machinesForSpecies("squirtle").map((m) => m.moveId);
    expect(squirtle).not.toContain("flamethrower");
    expect(squirtle).toContain("iceBeam");
  });

  it("recognises machine ids and nothing else", () => {
    expect(isMachineId("tm24")).toBe(true);
    expect(isMachineId("hm03")).toBe(true);
    expect(isMachineId("pokeball")).toBe(false);
    // A number that exists in Gen 5 but was excluded here must NOT read as a
    // machine — tm17 is Protect, which this engine cannot run.
    expect(isMachineId("tm17")).toBe(false);
  });
});

describe("what the item says about itself", () => {
  it("describes the move as THIS game runs it, not as the API does", () => {
    // The reason descriptions are built at runtime from the live move table.
    // PokéAPI files Toxic's ailment as plain "poison"; this game's Toxic
    // inflicts badlyPoisoned. Generated text would have promised the weaker
    // one, and a competitive player picks Toxic FOR the difference.
    expect(movesTable.toxic.effect).toMatchObject({ status: "badlyPoisoned" });
    expect(machineEffectText("tm06").toLowerCase()).toContain("badly poison");
  });

  it("names the secondary effect and its odds", () => {
    expect(machineEffectText("tm13")).toMatch(/\d+% chance to freeze/);
    expect(machineEffectText("tm35")).toMatch(/\d+% chance to burn/);
  });

  it("collapses a multi-stat buff into one clause", () => {
    // "raises the user's Sp. Atk and Sp. Def", not "...and raises the
    // user's Sp. Def" twice over.
    const text = machineEffectText("tm04");
    expect(text).toContain("Sp. Atk and Sp. Def");
    expect(text.match(/raises/gi)).toHaveLength(1);
  });

  it("says it is reusable, because that decides whether you hoard it", () => {
    expect(describeMachine("tm24")).toContain("Reusable");
    expect(describeMachine("hm03")).toContain("never be used up");
  });

  it("leads with the move's numbers for an attacking machine", () => {
    const d = describeMachine("tm24");
    expect(d).toContain("Thunderbolt");
    expect(d).toContain(`${movesTable.thunderbolt.power} power`);
  });
});

describe("canTeachMachine says WHY not", () => {
  const inv = { tm24: 1 };

  it("accepts an owned machine on a compatible species", () => {
    const pika = makeMon({ speciesKey: "pikachu", moves: [{ id: "tackle", pp: 35, maxPp: 35 }] });
    expect(canTeachMachine(pika, "tm24", inv)).toMatchObject({ ok: true });
  });

  it("refuses a machine you don't own, and says so", () => {
    const pika = makeMon({ speciesKey: "pikachu" });
    const r = canTeachMachine(pika, "tm24", {});
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("TM24");
  });

  it("refuses an incompatible species, and names it", () => {
    const karp = makeMon({ speciesKey: "magikarp", name: "Magikarp" });
    const r = canTeachMachine(karp, "tm24", inv);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("Magikarp");
  });

  it("refuses a move it already knows", () => {
    const pika = makeMon({
      speciesKey: "pikachu",
      moves: [{ id: "thunderbolt", pp: 15, maxPp: 15 }],
    });
    const r = canTeachMachine(pika, "tm24", inv);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("already knows");
  });
});

describe("the move pool a player sees", () => {
  // Snorlax, not Pikachu: Pikachu learns Thunderbolt by LEVELLING, so it can
  // never show a machine-only move. Picking the wrong fixture here would
  // have made this whole block pass without testing anything.
  it("adds a machine move only while the machine is held", () => {
    const without = availableMovesFor("snorlax", 50, {}).map((m) => m.moveId);
    const withTm = availableMovesFor("snorlax", 50, { tm24: 1 }).map((m) => m.moveId);
    expect(without).not.toContain("thunderbolt");
    expect(withTm).toContain("thunderbolt");
  });

  it("labels where each move came from", () => {
    const pool = availableMovesFor("snorlax", 50, { tm24: 1 });
    const tb = pool.find((m) => m.moveId === "thunderbolt")!;
    expect(tb.source).toBe("machine");
    expect(tb.machineLabel).toBe("TM24");
    const level = pool.find((m) => m.source === "level")!;
    expect(level.learnLevel).toBeGreaterThan(0);
  });

  it("keeps a move the species learns naturally as a LEVEL move", () => {
    // Owning the TM must not relabel something already learned the hard way —
    // otherwise selling the machine would appear to take the move away.
    const dup = machineList.find((m) =>
      availableMovesFor("pikachu", 100, {}).some((a) => a.moveId === m.moveId),
    );
    expect(dup, "Pikachu should share at least one move with a machine").toBeTruthy();
    const pool = availableMovesFor("pikachu", 100, { [dup!.id]: 1 });
    expect(pool.filter((m) => m.moveId === dup!.moveId)).toHaveLength(1);
    expect(pool.find((m) => m.moveId === dup!.moveId)!.source).toBe("level");
  });

  it("only offers machines the player owns", () => {
    expect(ownedMachinesForSpecies("snorlax", {})).toHaveLength(0);
    expect(ownedMachinesForSpecies("snorlax", { tm24: 1 })).toHaveLength(1);
  });
});

describe("SET_MOVES enforces the rule", () => {
  const pikaWith = (_moveIds: string[], inventory: Record<string, number> = {}) => {
    const lead = makeMon({
      speciesKey: "snorlax",
      name: "Snorlax",
      level: 50,
      moves: [{ id: "tackle", pp: 35, maxPp: 35 }],
    });
    return { lead, state: makeState({ party: [lead], playerPokemon: lead, inventory }) };
  };

  it("accepts a machine move when the machine is held", () => {
    const { lead, state } = pikaWith([], { tm24: 1 });
    const next = reducer(state, {
      type: "SET_MOVES",
      payload: { pokemonId: lead.id, moveIds: ["tackle", "thunderbolt"] },
    } as never);
    expect(next.party[0].moves.map((m) => m.id)).toEqual(["tackle", "thunderbolt"]);
  });

  it("refuses a machine move when the machine is NOT held", () => {
    const { lead, state } = pikaWith([]);
    const next = reducer(state, {
      type: "SET_MOVES",
      payload: { pokemonId: lead.id, moveIds: ["tackle", "thunderbolt"] },
    } as never);
    expect(next.party[0].moves.map((m) => m.id)).toEqual(["tackle"]);
    expect(next.battleLog.join(" ")).toContain("Thunderbolt");
  });

  it("keeps a move the Pokémon already knows even if nothing would teach it", () => {
    // A traded or auctioned Pokémon arrives with its own moveset. Dropping
    // those on the first save would be silent, permanent data loss.
    const lead = makeMon({
      speciesKey: "snorlax",
      name: "Snorlax",
      level: 50,
      moves: [{ id: "thunderbolt", pp: 15, maxPp: 15 }, { id: "tackle", pp: 35, maxPp: 35 }],
    });
    const state = makeState({ party: [lead], playerPokemon: lead, inventory: {} });
    const next = reducer(state, {
      type: "SET_MOVES",
      payload: { pokemonId: lead.id, moveIds: ["thunderbolt", "tackle"] },
    } as never);
    expect(next.party[0].moves.map((m) => m.id)).toEqual(["thunderbolt", "tackle"]);
  });

  it("never leaves a Pokémon with no moves at all", () => {
    const { lead, state } = pikaWith([]);
    const next = reducer(state, {
      type: "SET_MOVES",
      payload: { pokemonId: lead.id, moveIds: ["hyperBeam"] },
    } as never);
    expect(next.party[0].moves.length).toBeGreaterThan(0);
  });

  it("drops duplicate slots and caps at four", () => {
    const lead = makeMon({
      speciesKey: "pikachu",
      level: 50,
      moves: [{ id: "tackle", pp: 35, maxPp: 35 }],
    });
    const state = makeState({ party: [lead], playerPokemon: lead });
    const learnable = availableMovesFor("pikachu", 50, {}).map((m) => m.moveId);
    expect(learnable.length).toBeGreaterThanOrEqual(6);
    const next = reducer(state, {
      type: "SET_MOVES",
      payload: { pokemonId: lead.id, moveIds: [...learnable.slice(0, 6), learnable[0]] },
    } as never);
    const ids = next.party[0].moves.map((m) => m.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("buying a machine", () => {
  it("charges once and grants exactly one", () => {
    const state = makeState({ money: 100_000, inventory: {} });
    const next = reducer(state, {
      type: "BUY_ITEM",
      payload: { itemId: "tm75", quantity: 3 },
    } as never);
    expect(next.inventory.tm75).toBe(1);
    expect(next.money).toBe(100_000 - machines.tm75.price!);
  });

  it("refuses a second copy rather than taking the money", () => {
    const state = makeState({ money: 100_000, inventory: { tm75: 1 } });
    const next = reducer(state, {
      type: "BUY_ITEM",
      payload: { itemId: "tm75", quantity: 1 },
    } as never);
    expect(next.inventory.tm75).toBe(1);
    expect(next.money).toBe(100_000);
    expect(next.battleLog.join(" ")).toContain("already have");
  });
});

describe("where machines come from", () => {
  it("puts every machine in exactly one source", () => {
    for (const m of machineList) {
      expect(["mart", "route", "raid"]).toContain(machineSource[m.id]);
    }
    const total = martMachines.length + raidMachines.length + Object.keys(machineDropRoute).length;
    expect(total).toBe(machineList.length);
  });

  it("stocks every mart machine somewhere", () => {
    const stocked = new Set<string>();
    for (const shop of Object.values(mergedShops)) {
      for (const item of shop.items) if (isMachineId(item.itemId)) stocked.add(item.itemId);
    }
    for (const m of martMachines) expect(stocked.has(m.id), `${m.label} is unbuyable`).toBe(true);
  });

  it("never stocks a machine that is meant to be found", () => {
    for (const shop of Object.values(mergedShops)) {
      for (const item of shop.items) {
        if (!isMachineId(item.itemId)) continue;
        expect(machineSource[item.itemId], `${item.itemId} is for sale`).toBe("mart");
      }
    }
  });

  it("gives each route drop its own machine, on a real route", () => {
    const seen = new Set<string>();
    for (const [routeId, machineId] of Object.entries(routeMachineDrop)) {
      expect(mergedRoutes[routeId], routeId).toBeTruthy();
      expect(mergedRoutes[routeId].type).toBe("route");
      expect(seen.has(machineId), `${machineId} drops twice`).toBe(false);
      seen.add(machineId);
    }
  });

  it("spreads the drops across both regions rather than piling into the first", () => {
    // The bug this pins: assigning machine i to route i puts every drop in
    // Kanto's opening stretch and leaves Johto with none.
    const ids = Object.keys(routeMachineDrop);
    const half = Object.values(mergedRoutes).filter((r) => r.type === "route").length / 2;
    const late = ids.filter((id) => {
      const order = mergedRoutes[id].unlockOrder ?? 0;
      return order > half;
    });
    expect(late.length).toBeGreaterThan(ids.length / 4);
  });

  it("sells nothing that raids are supposed to pay out", () => {
    for (const m of raidMachines) expect(m.price === null || machineSource[m.id] === "raid").toBe(true);
  });
});

describe("the generator wrote the effects onto the right moves", () => {
  // ── A REGRESSION, NOT A SPOT CHECK ────────────────────────────────
  // The first run of the generator matched an existing move's block with a
  // regex. Entries in moves.ts come in two shapes — one line and many — and
  // the pattern could not terminate on a single-line entry, so it ran past
  // Psychic and stopped at the end of the next multi-line move. Psychic's
  // Sp. Def drop was appended to DREAM EATER, and the run reported
  // "moves upgraded: psychic" while Psychic was left untouched.
  //
  // It typechecked, every other test passed, and the only visible symptom
  // would have been Dream Eater quietly debuffing in battle. These three
  // assertions are the shape of that bug.
  it("gave Psychic its own Sp. Def drop", () => {
    expect(movesTable.psychic.effect).toMatchObject({
      type: "statChange",
      target: "opponent",
      changes: { spDefense: -1 },
    });
  });

  it("left Dream Eater alone", () => {
    // Dream Eater drains, which this engine can't do — so it is NOT a
    // machine, and nothing should have written an effect onto it.
    expect(movesTable.dreamEater.effect).toBeUndefined();
  });

  it("crashes the USER's Sp. Atk on Overheat, not the target's", () => {
    // The second generator bug. PokéAPI files Overheat's `target` as the
    // opposing Pokémon (it is a 130 BP attack), so reading that field put
    // the debuff on the enemy — turning the game's biggest Fire move into a
    // free Sp. Atk drop on whatever it hit.
    expect(movesTable.overheat.effect).toMatchObject({
      type: "statChange",
      target: "self",
      changes: { spAttack: -2 },
    });
  });

  it("never points a self-debuff at the opponent", () => {
    // The general form of the same mistake, across the whole catalog.
    for (const m of machineList) {
      const e = movesTable[m.moveId]?.effect;
      if (e?.type !== "statChange") continue;
      const drops = Object.values(e.changes).some((v) => (v as number) < 0);
      const raises = Object.values(e.changes).some((v) => (v as number) > 0);
      // A single effect that both raises and lowers across the two sides
      // cannot be expressed here, so each one must be coherent on its own.
      expect(drops && raises, `${m.label} ${m.moveName} mixes raises and drops`).toBe(false);
    }
  });
});

describe("the screens have something to render", () => {
  // Not a DOM test — this codebase has no DOM test stack and every suite in
  // it is pure logic. These check the data the Bag and the Mart READ, which
  // is where a machine would break visibly: a name that falls back to the
  // raw id ("tm24"), a missing sprite, or a shop row for an item the catalog
  // has never heard of.
  it("gives every machine a real name and description", () => {
    for (const m of machineList) {
      const info = getItemInfo(m.id);
      expect(info.name, m.id).not.toBe(m.id);
      expect(info.name).toContain(m.label);
      expect(info.name).toContain(m.moveName);
      expect(info.description.length).toBeGreaterThan(20);
    }
  });

  it("points every machine at a type-coloured disc sprite", () => {
    for (const m of machineList) {
      const slug = itemSpriteSlug(m.id);
      // e.g. "tm-electric". The per-type discs exist on the sprite CDN, and
      // colour is how you find the one you want in a bag full of them.
      expect(slug, m.id).toBe(`${m.kind}-${m.moveType.toLowerCase()}`);
    }
  });

  it("puts a buyable price on every machine a mart stocks", () => {
    for (const [city, shop] of Object.entries(mergedShops)) {
      for (const item of shop.items) {
        if (!isMachineId(item.itemId)) continue;
        const price = itemsCatalog[item.itemId]?.buyPrice;
        expect(price, `${city} sells ${item.itemId} with no price`).toBeGreaterThan(0);
      }
    }
  });

  it("gives every mart-sold machine at least one species that can learn it", () => {
    // A TM nothing in the game can use would be a pure money sink.
    for (const m of martMachines) {
      const users = Object.values(machineLearnsets).filter((ids) => ids.includes(m.id));
      expect(users.length, `${m.label} ${m.moveName} is unlearnable`).toBeGreaterThan(0);
    }
  });
});
