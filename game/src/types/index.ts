// Type definitions for the Pokemon Idle game state.
// Reverse-engineered from the production bundle.

export type PokemonType =
  | "Normal"
  | "Fire"
  | "Water"
  | "Electric"
  | "Grass"
  | "Ice"
  | "Fighting"
  | "Poison"
  | "Ground"
  | "Flying"
  | "Psychic"
  | "Bug"
  | "Rock"
  | "Ghost"
  | "Dragon"
  | "Dark"
  | "Steel"
  | "Fairy";

export type GrowthRate =
  | "fast"
  | "mediumFast"
  | "mediumSlow"
  | "slow"
  | "erratic"
  | "fluctuating";

export type MoveCategory = "physical" | "special" | "status";

export interface Stats {
  hp: number;
  attack: number;
  defense: number;
  spAttack: number;
  spDefense: number;
  speed: number;
}

export type IVs = Stats;

export type StatStages = Omit<Stats, "hp">;

export interface PokemonSpecies {
  id: number;
  name: string;
  types: PokemonType[];
  baseStats: Stats;
  baseExpYield: number;
  growthRate: GrowthRate;
}

export type StatusCondition =
  | "paralyzed"
  | "asleep"
  | "burned"
  | "frozen"
  | "poisoned"
  | "badlyPoisoned";

export type WeatherCondition = "sun" | "rain" | "sand" | "hail";

export interface WeatherState {
  type: WeatherCondition;
  turnsRemaining: number;
}

export type MoveEffect =
  | { type: "statChange"; target: "self" | "opponent"; changes: Partial<StatStages> }
  | { type: "recoil"; fraction: number }
  | { type: "recharge" }
  | { type: "selfDestruct" }
  | { type: "multiTurnLock"; minTurns: number; maxTurns: number; selfDamage: number }
  | { type: "crashOnMiss"; fraction: number }
  | { type: "inflictStatus"; status: StatusCondition; chance: number; target?: "opponent" | "self" }
  | { type: "confuse"; chance: number; target?: "opponent" | "self" }
  | { type: "multiHit"; minHits: number; maxHits: number }
  | { type: "setWeather"; weather: WeatherCondition; turns: number };

export interface MoveDef {
  name: string;
  type: PokemonType;
  category: MoveCategory;
  power: number;
  accuracy: number;
  pp: number;
  priority: number;
  effect?: MoveEffect;
  effectChance?: number;
  critRatio?: number;     // 1 = default 1/16; 2 = 1/8; 3 = 1/4 (Slash, Razor Leaf, Karate Chop, Crabhammer)
  isPunch?: boolean;      // for Iron Fist boost
  isContact?: boolean;    // for contact-only ability triggers (defaults true for physical)
}

export interface Move {
  id: string;
  pp: number;
  maxPp: number;
}

export interface Pokemon {
  id: string;
  speciesKey: string;
  name: string;        // species display name (does not change on rename)
  nickname?: string;   // player-given nickname; falls back to `name` if absent
  nature?: string;     // one of the 25 natures (assigned at creation)
  level: number;
  totalExp: number;
  moves: Move[];
  currentHp: number;
  maxHp: number;
  attack: number;
  defense: number;
  spAttack: number;
  spDefense: number;
  speed: number;
  ivs: IVs;
  evs?: Stats;         // 0–252 each, 510 total cap; gained per defeated foe
  isShiny: boolean;
  ability?: string;    // canonical ability id (rolled at creation; see data/speciesAbilities.ts)
  status?: StatusCondition;  // major status condition; null/undefined = healthy
  sleepTurns?: number;       // remaining sleep turns (decremented at turn start)
  toxicTurns?: number;       // counter for badly poisoned damage scaling (1, 2, 3...)
  confusedTurns?: number;    // volatile status (stacks with major); 1-4 turns; ticks down each attack
  statStages?: Partial<StatStages>; // -6..+6 per stat; mutated during battle, cleared on switch
  heldItem?: string;         // held item id (see data/itemsCatalog.ts heldItem entries)
}

export type EvolutionTrigger =
  | { into: string; level: number }
  | { into: string; item: string }
  | { into: string; trade: true }
  // Gen 4+ trade-with-item evolutions: the Pokémon must be holding the
  // named item at the moment it is traded. The item is consumed in
  // canon — the receiver gets the evolved species without the held
  // item. Example: Onix holding a Metal Coat → Steelix.
  | { into: string; trade: true; item: string };

export interface RouteEncounter {
  speciesKey: string;
  weight: number;
  minLevel: number;
  maxLevel: number;
}

export interface RouteUnlock {
  battlesAtLocation?: { locationId: string; count: number }[];
  badgesRequired?: number;
  championDefeated?: boolean;
}

export type RouteType = "town" | "route" | "cave" | "victoryRoad" | "raid";

export interface Route {
  id: string;
  name: string;
  type: RouteType;
  description?: string;
  connections: string[];
  routeKey?: string;
  unlock: RouteUnlock;
  unlockOrder: number;
  position: { x: number; y: number };
}

export interface BallDef {
  id: string;
  name: string;
  description: string;
  buyPrice: number | null;
  ballModifier: number;
}

export interface ConsumableDef {
  id: string;
  name: string;
  description: string;
  duration: number;
  buyPrice: number | null;
}

export interface EvolutionStone {
  id: string;
  name: string;
  description: string;
}

export type CatchMode =
  | "always"
  | "shiny_only"
  | "level_threshold"
  | "pokedex_new";

export interface CatchSettings {
  enabled: boolean;
  mode: CatchMode;
  levelThreshold: number;
  enabledBalls: string[];
}

export interface BattleEvent {
  type: string;
  payload?: any;
  message?: string;
}

export interface BattleLogEntry {
  text: string;
  ts: number;
}

export interface TrainerEncounter {
  id: string;
  name: string;
  trainerClass: string;
  team: { speciesKey: string; level: number }[];
  // Optional: original supports specific sprite override
  spriteKey?: string;
}

export interface TrainerBattle {
  trainerId: string;
  trainerName: string;
  trainerClass: string;
  trainerTeam: Pokemon[];
  currentTrainerPokemonIndex: number;
  spriteKey: string;
}

export type BossType = "gym" | "e4" | "champion";

export interface BossBattle {
  bossId: string;
  bossType: BossType;
  trainerName: string;
  trainerClass: string;
  trainerTeam: Pokemon[];
  currentTrainerPokemonIndex: number;
  spriteKey: string;
}

export interface ActiveEffect {
  itemId: string;
  speciesKey: string;
  routeKey?: string;
  battlesRemaining: number;
  // When true, the effect doesn't tick down OR contribute its bonus —
  // useful for Exp Share, which is a temporary buff the player may want
  // to pause when grinding a single Pokémon.
  paused?: boolean;
}

export interface EvolutionState {
  partyIndex: number;
  toSpeciesKey: string;
  step: number;
}

export interface HealingState {
  step: number;
}

export interface LevelUpNotification {
  pokemonId: string;
  level: number;
  newMoves: string[];
}

export interface PlayerVolatile {
  statStages: StatStages;
  mustRecharge: boolean;
  lockedMove: string | null;
  lockTurnsRemaining: number;
}

export type GamePhase =
  | "starterSelect"
  | "idle"
  | "battle"
  | "trainerBattle"
  | "bossBattle"
  | "victory"
  | "evolution"
  | "healing"
  | "raid";

export interface GameState {
  phase: GamePhase;
  playerPokemon: Pokemon | null;
  enemyPokemon: Pokemon | null;
  currentRoute: string;
  battleEvents: BattleEvent[];
  pendingEvents: BattleEvent[];
  currentEventIndex: number;
  speed: number;
  battleWeather?: WeatherState | null;
  paused: boolean;
  battleLog: string[];
  levelUpNotification: LevelUpNotification | null;
  wildBattlesWon: number;
  trainerBattlesWon: number;
  battlesWonByLocation: Record<string, number>;
  party: Pokemon[];
  box: Pokemon[];
  autoCatch: boolean;
  nextPokemonId: number;
  currentLocation: string;
  unlockedLocations: string[];
  evolutionState: EvolutionState | null;
  catchSettings: Record<string, Record<string, CatchSettings>>;
  globalCatchDefaults: CatchSettings;
  money: number;
  inventory: Record<string, number>;
  trainerBattle: TrainerBattle | null;
  bossBattle: BossBattle | null;
  bossQueue: BossBattle[];
  activePlayerPokemonIndex: number;
  healingState: HealingState | null;
  // Boss data parked here while the pre-battle heal animation plays.
  // START_BOSS_BATTLE stashes this and transitions to "healing"; when
  // COMPLETE_HEALING fires we drain it back into bossBattle/bossQueue.
  pendingBossBattle: { battle: BossBattle; queue: BossBattle[] } | null;
  alwaysCatchShinies: boolean;
  pokedexSeen: string[];
  pokedexCaught: string[];
  shinyCaught: string[];
  shinySeen: string[];
  defeatedGyms: string[];
  defeatedEliteFour: string[];
  championDefeated: boolean;
  victoryTokens: number;
  autoProceed: boolean;
  raidCooldownEnd: number | null;
  /** Per-tier raid cooldowns (epoch ms when each tier becomes
   *  available again). Replaces the single global raidCooldownEnd
   *  for the gating UX — clearing one tier no longer locks the rest. */
  raidCooldowns: Record<string, number>;
  raidLegendary: { speciesKey: string; level: number; tier?: import("../data/raidLegendaries").RaidTierId } | null;
  inRaid: boolean;
  raidLevel: number;
  preRaidLocation: string | null;
  playerVolatile: PlayerVolatile | null;
  activeEffects: ActiveEffect[];
  // Set when the active player's Pokemon faints in a wild/trainer/boss battle
  // and there's at least one healthy mon. Pauses the simulation until the
  // player picks a switch via SWITCH_PLAYER_POKEMON.
  awaitingSwitch: boolean;
  // IDs of trainers (non-gym) that have been defeated. Re-fightable if the
  // player resets, but otherwise greyed out in the LocationPanel.
  defeatedTrainers: string[];
  // "manual" → player picks each move; "auto" → smart AI picks. Default
  // "manual"; persisted across sessions.
  battleMode: "manual" | "auto";
  // Active catch animation. Set by TRY_CATCH (manual ball throw) and
  // cleared by CATCH_RESOLVE after the throw + 3-shake animation finishes.
  // The result is rolled at TRY_CATCH time so the animation can lie in
  // step with the truth (e.g. shake then fail vs shake then succeed).
  catchAnim: {
    ballId: string;
    success: boolean;
    key: number;
  } | null;
  // Brief "You fainted!" overlay that plays whenever the team gets wiped
  // out (white-out / raid wipe / defensive auto-heal). Cleared by the
  // overlay component itself after ~1.6s.
  whiteoutAnim: { key: number } | null;
}

export interface GymLeader {
  id: string;
  name: string;
  title: string;
  locationKey: string;
  badgeName: string;
  badgeColor: string;
  spriteKey: string;
  team: { speciesKey: string; level: number }[];
}

export interface ShopDef {
  name: string;
  items: { itemId: string; unlockWildBattlesWon?: number }[];
}

export interface ChangelogEntry {
  version: string;
  subtitle?: string;
  /** ISO date the version shipped. Shown in the changelog so players can
   *  see how actively the game is being worked on. */
  date?: string;
  /** Marks a headline release — rendered with the accent treatment. */
  highlight?: boolean;
  sections: { heading: string; items: string[] }[];
}

// ---------- Action types ----------

export type Action =
  | { type: "SELECT_STARTER"; payload: { speciesKey: string; isShiny?: boolean } }
  | { type: "START_ENCOUNTER"; payload: { pokemon: Pokemon } }
  | { type: "START_TRAINER_BATTLE"; payload: { trainerId: string; trainerName: string; trainerClass: string; trainerTeam: Pokemon[]; spriteKey: string } }
  | { type: "START_BOSS_BATTLE"; payload: { bossId: string; bossType: BossType; trainerName: string; trainerClass: string; trainerTeam: Pokemon[]; spriteKey: string; bossQueue?: BossBattle[] } }
  | { type: "EXECUTE_TURN"; payload?: { playerMoveId?: string } }
  | { type: "SET_BATTLE_MODE"; payload: { mode: "manual" | "auto" } }
  | { type: "TRY_CATCH"; payload: { ballId: string } }
  | { type: "CATCH_RESOLVE" }
  | { type: "APPLY_DAILY_REWARD"; payload: { money: number; items: { itemId: string; quantity: number }[] } }
  | { type: "CLEAR_WHITEOUT_ANIM" }
  | { type: "CONSUME_EVENT" }
  | { type: "APPLY_EXP"; payload: { exp: number } }
  | { type: "HEAL" }
  | { type: "SET_SPEED"; payload: { speed: number } }
  | { type: "TOGGLE_PAUSE" }
  | { type: "CLEAR_LEVEL_UP" }
  | { type: "PHASE_IDLE" }
  | { type: "ADD_LOG"; payload: { text: string } }
  | { type: "SET_MOVES"; payload: { pokemonId: string; moveIds: string[] } }
  | { type: "CATCH_POKEMON"; payload: { ballId: string } }
  | { type: "TOGGLE_AUTO_CATCH" }
  | { type: "REORDER_PARTY"; payload: { from: number; to: number } }
  | { type: "SWAP_PARTY"; payload: { a: number; b: number } }
  | { type: "PARTY_TO_BOX"; payload: { partyIndex: number } }
  | { type: "BOX_TO_PARTY"; payload: { boxIndex: number } }
  | { type: "SWAP_PARTY_BOX"; payload: { partyIndex: number; boxIndex: number } }
  | { type: "TRAVEL"; payload: { locationId: string } }
  | { type: "START_EVOLUTION"; payload: { partyIndex: number; toSpeciesKey: string } }
  | { type: "EVOLUTION_STEP" }
  | { type: "COMPLETE_EVOLUTION" }
  | { type: "SET_CATCH_RULE"; payload: { routeKey: string; speciesKey: string; settings: CatchSettings } }
  | { type: "TOGGLE_ROUTE_CATCH_ALL"; payload: { routeKey: string; enabled: boolean } }
  // routeKey is optional and, when given, also refreshes mode/
  // levelThreshold/enabledBalls (never `enabled`) on every existing
  // per-species override for that route — see reducer.ts's case for why.
  | { type: "SET_GLOBAL_CATCH_DEFAULTS"; payload: { settings: CatchSettings; routeKey?: string } }
  | { type: "SWITCH_PLAYER_POKEMON"; payload: { partyIndex: number } }
  | { type: "TRAINER_SEND_NEXT_POKEMON"; payload: { newPokemonIndex: number } }
  | { type: "TRAINER_BATTLE_END"; payload: { won: boolean; moneyDelta: number } }
  | { type: "BOSS_BATTLE_END"; payload: { won: boolean; moneyDelta: number } }
  | { type: "HEAL_PARTY" }
  | { type: "BUY_ITEM"; payload: { itemId: string; quantity: number } }
  | { type: "CONSUME_ITEM"; payload: { itemId: string; quantity?: number } }
  | { type: "USE_POKEBALL"; payload: { ballId: string } }
  | { type: "MARK_SEEN"; payload: { speciesKey: string } }
  | { type: "MARK_CAUGHT"; payload: { speciesKey: string } }
  | { type: "MARK_SHINY_CAUGHT"; payload: { speciesKey: string } }
  | { type: "MARK_SHINY_SEEN"; payload: { speciesKey: string } }
  | { type: "START_HEALING" }
  | { type: "HEALING_STEP" }
  | { type: "COMPLETE_HEALING" }
  | { type: "REORDER_BOX"; payload: { from: number; to: number } }
  | { type: "SORT_BOX"; payload: { mode: string } }
  | { type: "RELEASE_POKEMON"; payload: { source: "party" | "box"; index: number } }
  | { type: "TRADE_COMPLETE"; payload: { sentMonId: string; received: Pokemon } }
  | {
      type: "AUCTION_SETTLED";
      payload:
        | { role: "seller"; removedPokemonId: string; money: number; logMessage: string }
        | { role: "buyer"; pokemon: Pokemon; money: number; logMessage: string };
    }
  | { type: "SET_NICKNAME"; payload: { pokemonId: string; nickname: string } }
  | { type: "TOGGLE_EFFECT_PAUSED"; payload: { itemId: string } }
  | { type: "SET_ALWAYS_CATCH_SHINIES"; payload: { value: boolean } }
  | { type: "RESET_ELITE_FOUR" }
  | { type: "TOGGLE_AUTO_PROCEED" }
  | { type: "BUY_REWARD_ITEM"; payload: { itemId: string; cost: number } }
  | { type: "START_RAID"; payload?: { speciesKey?: string; level?: number; tier?: import("../data/raidLegendaries").RaidTierId } }
  | { type: "END_RAID" }
  | { type: "UPDATE_VOLATILE"; payload: Partial<PlayerVolatile> }
  | { type: "USE_EFFECT_ITEM"; payload: { itemId: string; speciesKey: string; routeKey?: string } }
  | { type: "APPLY_SHARED_EXP"; payload: { exp: number } }
  | { type: "GIVE_HELD_ITEM"; payload: { pokemonId: string; itemId: string } }
  | { type: "TAKE_HELD_ITEM"; payload: { pokemonId: string } }
  | { type: "USE_LINK_CABLE"; payload: { partyIndex: number } }
  | { type: "SELL_ITEM"; payload: { itemId: string; quantity: number } }
  | { type: "LOAD_SAVE"; payload: { state: Partial<GameState> } };

export type Dispatch = (action: Action) => void;
