// Ball throws and raid continuation.
//
// Regressions pinned here:
//   * A ball thrown at a FAINTED target used to be spent — and a Master
//     Ball would happily "catch" the corpse. Both paths must refuse before
//     the ball leaves the inventory.
//   * Catching the raid legendary used to strand the raid (`inRaid: true`,
//     no enemy, silent stall) because only the KO path spawned the next
//     wave. Both wave-clear outcomes must continue the raid.

import { describe, expect, it } from "vitest";
import { reducer } from "../src/state/reducer";
import { makeMon, makeState, battleState, freshVolatile } from "./helpers";
import type { GameState } from "../src/types";

const raidState = (enemyHp = 200): GameState =>
  battleState(
    makeMon({ speciesKey: "articuno", name: "Articuno", level: 70, currentHp: enemyHp, maxHp: 200 }),
    {
      inRaid: true,
      raidLegendary: { speciesKey: "articuno", level: 70, tier: "birdsBeasts" },
      raidLevel: 1,
      preRaidLocation: "palletTown",
      inventory: { masterball: 2, pokeball: 5 },
      nextPokemonId: 100,
    },
  );

describe("balls are refused on fainted targets", () => {
  it("CATCH_POKEMON on a fainted enemy is a no-op — even with a Master Ball", () => {
    const state = battleState(makeMon({ currentHp: 0 }), { inventory: { masterball: 1 } });
    const next = reducer(state, { type: "CATCH_POKEMON", payload: { ballId: "masterball" } });
    expect(next).toBe(state); // identity: nothing changed, ball not spent
  });

  it("TRY_CATCH (animated path) refuses a fainted target the same way", () => {
    const state = battleState(makeMon({ currentHp: 0 }), { inventory: { pokeball: 3 } });
    const next = reducer(state, { type: "TRY_CATCH", payload: { ballId: "pokeball" } });
    expect(next).toBe(state);
    expect(next.catchAnim).toBeNull();
  });

  it("a live target spends the ball normally", () => {
    const state = battleState(makeMon({ currentHp: 50, maxHp: 100 }), { inventory: { masterball: 1 } });
    const next = reducer(state, { type: "CATCH_POKEMON", payload: { ballId: "masterball" } });
    expect(next.inventory.masterball ?? 0).toBe(0);
  });
});

describe("raid continuation — catching continues the raid", () => {
  it("a Master Ball catch clears the wave and summons the next legendary at +5 levels", () => {
    const state = raidState();
    const next = reducer(state, { type: "CATCH_POKEMON", payload: { ballId: "masterball" } });

    // Caught mon landed with the player.
    const owned = [...next.party, ...next.box];
    expect(owned.some((m) => m.speciesKey === "articuno")).toBe(true);
    expect(next.pokedexCaught).toContain("articuno");

    // THE regression: the raid must CONTINUE, not stall.
    expect(next.inRaid).toBe(true);
    expect(next.phase).toBe("battle");
    expect(next.enemyPokemon).not.toBeNull();
    expect(next.enemyPokemon!.level).toBe(75); // 70 + 5
    expect(next.raidLevel).toBe(2);
    expect(next.raidLegendary!.level).toBe(75);
    expect(next.raidLegendary!.tier).toBe("birdsBeasts");
    expect(next.battleLog.some((l) => l.includes("Wave 2"))).toBe(true);
  });

  it("CATCH_RESOLVE (animated path) continues the raid identically", () => {
    const state: GameState = {
      ...raidState(),
      catchAnim: { ballId: "masterball", success: true, key: 1 },
    };
    const next = reducer(state, { type: "CATCH_RESOLVE" });
    expect(next.inRaid).toBe(true);
    expect(next.phase).toBe("battle");
    expect(next.raidLevel).toBe(2);
    expect(next.enemyPokemon!.level).toBe(75);
    expect(next.catchAnim).toBeNull();
  });

  it("a KO clears the wave through the same path (CONSUME_EVENT drain)", () => {
    const state: GameState = {
      ...raidState(),
      pendingEvents: [
        { type: "damage", payload: { target: "enemy", hpAfter: 0 }, message: "It landed!" },
      ],
    };
    const next = reducer(state, { type: "CONSUME_EVENT" });
    expect(next.inRaid).toBe(true);
    expect(next.phase).toBe("battle");
    expect(next.raidLevel).toBe(2);
    expect(next.enemyPokemon!.level).toBe(75);
    expect(next.battleLog.some((l) => l.includes("Wave 2"))).toBe(true);
  });

  it("the wave level caps at 100", () => {
    const state = battleState(
      makeMon({ speciesKey: "articuno", name: "Articuno", level: 99, currentHp: 300, maxHp: 300 }),
      {
        inRaid: true,
        raidLegendary: { speciesKey: "articuno", level: 99, tier: "birdsBeasts" },
        raidLevel: 7,
        inventory: { masterball: 1 },
      },
    );
    const next = reducer(state, { type: "CATCH_POKEMON", payload: { ballId: "masterball" } });
    expect(next.enemyPokemon!.level).toBe(100);
  });

  it("outside a raid, a catch ends the encounter and returns to idle", () => {
    const state = battleState(makeMon({ speciesKey: "eevee", name: "Eevee", currentHp: 40, maxHp: 40 }), {
      inventory: { masterball: 1 },
    });
    const next = reducer(state, { type: "CATCH_POKEMON", payload: { ballId: "masterball" } });
    expect(next.phase).toBe("idle");
    expect(next.enemyPokemon).toBeNull();
    expect(next.inRaid).toBe(false);
    expect(next.wildBattlesWon).toBe(state.wildBattlesWon + 1);
  });
});
