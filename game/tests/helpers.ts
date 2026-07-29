// Shared fixtures for the reducer tests. Everything is built on the real
// initialState and real Pokemon shapes so the tests exercise the same data
// paths the game does — no mocking anywhere in the game suite.

import type { GameState, Pokemon, PlayerVolatile } from "../src/types";
import { initialState } from "../src/state/initialState";

let nextTestId = 1;

/** A deterministic Pokemon — fixed stats, no random IV/nature rolls — so
 *  battle math and evolution-branch assertions are exact. */
export function makeMon(overrides: Partial<Pokemon> = {}): Pokemon {
  return {
    id: `test${nextTestId++}`,
    speciesKey: "pikachu",
    name: "Pikachu",
    level: 20,
    totalExp: 8000,
    moves: [{ id: "tackle", pp: 35, maxPp: 35 }],
    currentHp: 100,
    maxHp: 100,
    attack: 50,
    defense: 40,
    spAttack: 45,
    spDefense: 40,
    speed: 90,
    ivs: { hp: 15, attack: 15, defense: 15, spAttack: 15, spDefense: 15, speed: 15 },
    evs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
    isShiny: false,
    ...overrides,
  };
}

export function freshVolatile(): PlayerVolatile {
  return {
    statStages: { attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
    mustRecharge: false,
    lockedMove: null,
    lockTurnsRemaining: 0,
  } as PlayerVolatile;
}

/** Game state with a one-mon party, idling. */
export function makeState(overrides: Partial<GameState> = {}): GameState {
  const lead = makeMon();
  return {
    ...initialState,
    phase: "idle",
    party: [lead],
    playerPokemon: lead,
    activePlayerPokemonIndex: 0,
    battleLog: [],
    ...overrides,
  };
}

/** Game state mid wild battle against `enemy`. */
export function battleState(enemy: Pokemon, overrides: Partial<GameState> = {}): GameState {
  const s = makeState({
    phase: "battle",
    enemyPokemon: enemy,
    playerVolatile: freshVolatile(),
    ...overrides,
  });
  return s;
}
