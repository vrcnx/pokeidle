import type { GameState } from "../types";
import { DEFAULT_CATCH_SETTINGS } from "../data/raidLegendaries";
import { regions, DEFAULT_REGION } from "../data/regions";

// First-time game state lives in the default region (Kanto today). Any
// "starting Pokémon" / "starting location" defaults are read from the
// region definition so adding a new region doesn't require touching
// this file — only the registry.
const startingRegion = regions[DEFAULT_REGION];

export const initialState: GameState = {
  phase: "starterSelect",
  playerPokemon: null,
  enemyPokemon: null,
  currentRoute: "route1",
  battleEvents: [],
  pendingEvents: [],
  currentEventIndex: 0,
  speed: 1,
  paused: false,
  battleLog: [],
  levelUpNotification: null,
  offlineSummary: null,
  wildBattlesWon: 0,
  trainerBattlesWon: 0,
  battlesWonByLocation: {},
  party: [],
  box: [],
  autoCatch: true,
  nextPokemonId: 1,
  currentLocation: startingRegion.startingLocation,
  unlockedLocations: [startingRegion.startingLocation, "route1"],
  evolutionState: null,
  catchSettings: {},
  globalCatchDefaults: DEFAULT_CATCH_SETTINGS,
  money: 3000,
  inventory: { pokeball: 20 },
  trainerBattle: null,
  bossBattle: null,
  bossQueue: [],
  activePlayerPokemonIndex: 0,
  healingState: null,
  pendingBossBattle: null,
  alwaysCatchShinies: true,
  pokedexSeen: [],
  pokedexCaught: [],
  shinyCaught: [],
  shinySeen: [],
  defeatedGyms: [],
  defeatedEliteFour: [],
  championDefeated: false,
  victoryTokens: 0,
  autoProceed: false,
  raidCooldownEnd: null,
  raidCooldowns: {},
  raidLegendary: null,
  inRaid: false,
  raidLevel: 0,
  preRaidLocation: null,
  playerVolatile: null,
  activeEffects: [],
  awaitingSwitch: false,
  defeatedTrainers: [],
  battleMode: "auto",
  catchAnim: null,
  whiteoutAnim: null,
};

// STARTER_KEYS is sourced from the default region. Kept as a named
// export so the StarterSelect UI and Pokédex lookups don't need to
// understand the region system yet.
export const STARTER_KEYS = startingRegion.starters;
