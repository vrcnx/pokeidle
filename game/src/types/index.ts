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
  // `chance` is the SECONDARY-effect probability (0-1) for a stat change
  // riding on a damaging move — Psychic's 10% Sp. Def drop, Charge Beam's
  // 70% Sp. Atk raise. Absent means "always", which is what every status
  // move that exists to change stats (Swords Dance, Calm Mind) wants.
  | { type: "statChange"; target: "self" | "opponent"; changes: Partial<StatStages>; chance?: number }
  // `ofMaxHp` switches the recoil base from "damage dealt" (Double-Edge,
  // Take Down) to "the user's own max HP" (Struggle).
  | { type: "recoil"; fraction: number; ofMaxHp?: boolean }
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
  /** "M" | "F", or null for a genderless species. Optional because every
   *  save written before it existed has none — anything reading it has to
   *  tolerate `undefined`, which is NOT the same as null: undefined means
   *  "we never rolled one", null means "this species has no gender". */
  gender?: "M" | "F" | null;
  /**
   * The region this was caught in — the origin that region journeys read.
   *
   * Optional for the same reason `caughtAt` and `gender` are: every save
   * written before journeys existed has none, and there is no data to
   * backfill it from. Absent does NOT mean "unrestricted" — see
   * LEGACY_REGIONS in utils/regionJourney.ts, where that distinction is the
   * decision the whole feature rests on.
   */
  caughtIn?: string;
  /** When this Pokemon was obtained, epoch ms. Optional because every save
   *  written before it existed has none — sorting falls back to box order
   *  for those, which is close to the truth: the box is append-only, so a
   *  Pokemon's position in it already IS roughly its catch order. */
  caughtAt?: number;
  /**
   * The ball this was caught in — an item id from data/itemsCatalog.ts.
   *
   * Optional, and absent on two quite different things: every Pokemon caught
   * before this field existed, and everything that was never CAUGHT at all —
   * a starter, a gift, a trade, a giveaway prize.
   *
   * Both display as a Poké Ball (see `caughtBallOf`), which is the answer the
   * mainline games give too: a gift Pokemon arrives in a Poké Ball. That is a
   * display default and nothing more — NOTHING writes "pokeball" into a save
   * to make it true. Stamping the guess into the data would turn "we don't
   * know" into "we know it was a Poké Ball", and the player who remembers
   * spending a Master Ball on a legendary would be looking at a record that
   * says otherwise, with no way to tell it had been invented.
   */
  caughtBall?: string;
  ability?: string;    // canonical ability id (rolled at creation; see data/speciesAbilities.ts)
  status?: StatusCondition;  // major status condition; null/undefined = healthy
  sleepTurns?: number;       // remaining sleep turns (decremented at turn start)
  toxicTurns?: number;       // counter for badly poisoned damage scaling (1, 2, 3...)
  confusedTurns?: number;    // volatile status (stacks with major); 1-4 turns; ticks down each attack
  statStages?: Partial<StatStages>; // -6..+6 per stat; mutated during battle, cleared on switch
  heldItem?: string;         // held item id (see data/itemsCatalog.ts heldItem entries)
  /**
   * Per-Pokémon evolve lock — this game's Everstone.
   *
   * ABSENT (the shape every existing save has) means "not locked", which is
   * why this is optional and why `true` is the only value ever written: a save
   * from before the field existed needs no migration to mean the right thing.
   *
   * It gates the AUTOMATIC level-evolution path only (see hooks/useAutoEvolve).
   * A deliberate click — the party row's Evolve entry, the detail modal's
   * Evolve button, a stone, a Link Cable — is the player asking directly and
   * is never blocked by a standing preference. Read it through
   * `evolutionLocked()` in utils/evolution so that meaning lives in one place.
   */
  noEvolve?: boolean;
}

/** The stats a branching evolution is allowed to read off the evolving mon. */
export type EvolutionStatKey =
  | "hp" | "attack" | "defense" | "spAttack" | "spDefense" | "speed";

/**
 * A branch predicate on the evolving Pokémon's OWN stats, compared against
 * each other at the moment the evolution fires.
 *
 * This exists because canon has level evolutions that split several ways off
 * one threshold, and the trigger union previously had no way to express a
 * predicate at all — so Tyrogue's three-way split was flattened to a single
 * hardcoded target and two thirds of the line simply did not exist.
 *
 * `gt`/`lt`/`eq` over one stat pair PARTITION every possible pair of values,
 * so a well-formed branch set always has exactly one match: no Pokémon can
 * get stuck un-evolved, and no branch target is unreachable.
 */
export interface EvolutionStatCondition {
  /** [left, right] — read off the live Pokémon, not the species base stats. */
  compare: [EvolutionStatKey, EvolutionStatKey];
  op: "gt" | "lt" | "eq";
}

export type EvolutionTrigger =
  // `when` is optional so every pre-existing single-target level evolution
  // keeps its exact shape and meaning — an absent predicate is "always true".
  | { into: string; level: number; when?: EvolutionStatCondition }
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
  /**
   * "Not registered" — catch only species the Pokédex has never registered.
   *
   * THE KEY IS DELIBERATELY NOT RENAMED. It reads like it might mean "not
   * owned", and once the dex started distinguishing registered from currently
   * owned that ambiguity became a bug report (br_cb4d83f3ada30b1ec4). The
   * behaviour it has always had is the REGISTERED one — `pokedexCaught` is
   * append-only, so releasing or trading a species never brings it back into
   * scope — and the label now says so.
   *
   * Renaming the stored value would be a migration for no gain and real risk:
   * every save in the wild carries this string, GameContext keys two
   * exact-match one-time migrations on the literal, and useStreamAutoPlay
   * writes it in four places. Keeping the value is what makes the split a
   * pure addition with a no-op migration — see `not_owned` below.
   */
  | "pokedex_new"
  /**
   * "Not owned" — catch anything not currently in the party or the PC.
   *
   * The genuinely new option, and the one most players asking for "not caught
   * yet" actually meant: re-catch a species after releasing, trading or
   * evolving away the only one you had. Never assigned by a migration; a save
   * only holds it once the player picks it.
   */
  | "not_owned";

export interface CatchSettings {
  enabled: boolean;
  mode: CatchMode;
  levelThreshold: number;
  enabledBalls: string[];
  /** Auto-battle chips the wild Pokémon down to low HP before throwing a
   *  ball (the low-HP catch bonus then makes the throw far more likely).
   *  Never applies to shinies — those are caught immediately so weakening
   *  can't accidentally faint one. Optional for back-compat; absent = off. */
  weakenFirst?: boolean;
  /**
   * EXTRA CONDITIONS, all of which must hold on top of `mode`.
   *
   * `mode` is one rule and only one — "always", "shiny only", "above level
   * N". The request was explicitly about COMBINING conditions ("Adamant male
   * Charmander with IVs above 85%"), which that shape cannot express, so
   * these AND together with it rather than replacing it.
   *
   * Every one is optional and absent means "do not care", so an existing
   * save with none of them behaves exactly as it did.
   */
  filters?: CatchFilters;
}

export interface CatchFilters {
  /** Minimum IV total as a PERCENT of perfect (0-100). Players think in
   *  "85% IVs", not "158 of 186". */
  minIvPct?: number;
  /** Nature names, any of which qualifies. Empty/absent = any. */
  natures?: string[];
  /** "M" | "F". Genderless species are matched by neither, which is
   *  correct: a gender filter is a statement about gender. */
  gender?: "M" | "F";
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
  // Set by applyExp the moment this effect actually pays out, cleared when the
  // charge is billed at the end of the battle. It exists because payout and
  // billing are decided at different times: Exp Share paid on every KO but was
  // only charged once, at battle end, and `paused` effects were skipped there —
  // so pausing after the last KO of a trainer battle banked six payouts for
  // zero charges, forever (br_e84825db52e3431dc9). A billed effect ticks down
  // even while paused; nothing else does.
  billedThisBattle?: boolean;
}

export interface EvolutionState {
  partyIndex: number;
  toSpeciesKey: string;
  step: number;
  /** Id of the Pokémon being evolved. The cinematic runs for ~3.7s while
   *  `partyIndex` sits in state, so COMPLETE_EVOLUTION re-anchors on this and
   *  bails if the id is gone — see the reducer case. Optional so a save
   *  written mid-evolution before the field existed still completes by index. */
  pokemonId?: string;
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
  | "regionStarterSelect"
  | "idle"
  | "battle"
  | "trainerBattle"
  | "bossBattle"
  | "victory"
  | "evolution"
  | "healing"
  | "raid";

export interface GameState {
  /** Bumped on every LOAD_SAVE. Session-scoped, never persisted — see the
   *  reducer's LOAD_SAVE case for why id-keyed caches need it. */
  saveGen?: number;
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
  // Total lines ever pushed into `battleLog`, never trimmed. `battleLog`
  // itself keeps only the last 50, so its LENGTH saturates at 50 and stops
  // being usable as a "what's new since I last looked" cursor — three float
  // layers (+EXP, effectiveness, BattleJuice) each used length as one and all
  // three went permanently silent after ~8 battles (br_15040fe48311121a4a).
  // Read it through utils/battleLogCursor.ts, never by hand.
  battleLogSeq: number;
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
  /** Per-champion defeat tracking (champion.id values), added alongside
   *  Johto so a second region's League gauntlet has its own beaten-state
   *  instead of being permanently "beaten" the moment ANY champion falls.
   *  championDefeated itself stays a simple "beaten at least one champion"
   *  flag — that's still the right gate for cross-region endgame content
   *  (raids, the reward shop), it just can't answer "beaten THIS one" for
   *  a specific region's League screen, which is what this is for. */
  defeatedChampions: string[];
  /** Region ids for which the player has already claimed their "second
   *  starter" gift (region.starters) at that region's startingLocation.
   *  Never includes the default region — Kanto's starter is chosen via
   *  the pre-game starterSelect phase, not this flow. Drives whether
   *  arriving at a new region's starting town re-offers the choice. */
  claimedRegionStarters: string[];
  /** Route-mastery tiers already taken, as `${routeId}:${level}`.
   *
   *  APPEND-ONLY, and listed in saveReconcile's MONOTONIC_KEYS for the same
   *  reason `claimedRegionStarters` is: it is the record of a one-off payout,
   *  so a save merge has to UNION it. Taking one lineage's copy wholesale
   *  would let a tier claimed on the other be claimed a second time. */
  claimedMastery: string[];
  victoryTokens: number;
  autoProceed: boolean;
  /**
   * Global default for automatic LEVEL evolutions. `true` for everyone,
   * including every save written before this field existed: absent keys are
   * dropped by JSON.stringify, so `{...initialState, ...parsed}` (loadSaved)
   * and `{...state, ...payload}` (LOAD_SAVE) both fall through to
   * initialState's `true` with no migration step.
   *
   * Level-only, deliberately. Stones and the Link Cable consume an item, so
   * they stay a real choice and are never automated by this.
   */
  autoEvolve: boolean;
  /** Skip the "Release X? This cannot be undone." prompt for SINGLE releases.
   *  Off by default. It deliberately does NOT apply to two cases, both enforced
   *  at the call sites: a shiny always asks, and the BULK confirmation is never
   *  skippable and always names the exact count. Requested alongside bulk
   *  release in br_ff6112fc5180462b81 by a player clearing 500 Magikarp. */
  skipReleaseConfirm: boolean;
  /** Ids currently escrowed in a live auction listing. The server escrows on
   *  createAuction but the client keeps the Pokémon in the box, so without this
   *  it could be released, deposited or bulk-swept while already sold. Refreshed
   *  authoritatively whenever the auction board's "mine" tab loads. */
  listedPokemonIds: string[];
  /** Auto-Heal (br_27cfd612ddd30485fc). When on, the idle loop walks the player
   *  to a heal once the party's total HP falls to `autoHealThreshold` percent or
   *  a member has fainted. */
  autoHeal: boolean;
  /** Percent of party HP at or below which Auto-Heal triggers (1–99). */
  autoHealThreshold: number;
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
  // NOTE: there is deliberately NO field here recording which prize grants
  // this save has received. There was one (`grantReceipts`) and it was an
  // exploit: the server folded a grant whenever the uploaded blob lacked its
  // id, which made the delivery decision a field the CLIENT supplies — clear
  // it in localStorage and every recent grant is paid again on every upload.
  // Delivery state lives in PendingGrant.deliveredAt, in the database, and
  // nowhere else. Do not add anything like it back.
  //
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
  // The most recent successful catch, for anything outside the reducer that
  // has to REACT to one rather than read the result of one.
  //
  // NOTHING READS IT TODAY. Its only subscriber was the shiny announcement
  // in global chat, which was removed for flooding the feed. Kept because it
  // is transient, costs one object per catch, and is the correct shape for
  // the next thing that needs to hear about a catch — but it is a hook with
  // nothing on the end of it, not something in use.
  //
  // Transient — deliberately absent from PERSISTED_KEYS, so it never
  // survives a reload. If it did, every refresh would re-announce the last
  // shiny you ever caught.
  //
  // `key` is what makes two catches of the same species distinguishable:
  // shinyCaught is an append-only SET, so watching it would announce only
  // the first Gyarados and stay silent for the second. A monotonic counter
  // changes on every catch, which is the event this describes.
  lastCatch: {
    key: number;
    speciesKey: string;
    name: string;
    level: number;
    isShiny: boolean;
  } | null;
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
  | { type: "SELECT_REGION_STARTER"; payload: { region: string; speciesKey: string; isShiny?: boolean } }
  | { type: "START_ENCOUNTER"; payload: { pokemon: Pokemon } }
  | { type: "START_TRAINER_BATTLE"; payload: { trainerId: string; trainerName: string; trainerClass: string; trainerTeam: Pokemon[]; spriteKey: string } }
  | { type: "START_BOSS_BATTLE"; payload: { bossId: string; bossType: BossType; trainerName: string; trainerClass: string; trainerTeam: Pokemon[]; spriteKey: string; bossQueue?: BossBattle[] } }
  | { type: "EXECUTE_TURN"; payload?: { playerMoveId?: string } }
  | { type: "SET_BATTLE_MODE"; payload: { mode: "manual" | "auto" } }
  | { type: "TRY_CATCH"; payload: { ballId: string } }
  | { type: "CATCH_RESOLVE" }
  | { type: "APPLY_DAILY_REWARD"; payload: { money: number; items: { itemId: string; quantity: number }[] } }
  /** Take one earned route-mastery tier. `key` is `${routeId}:${level}`. */
  | { type: "CLAIM_MASTERY"; payload: { key: string } }
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
  // `pokemonId`, when given, is the id the caller BELIEVES sits at
  // `partyIndex`. The reducer re-finds the slot by id and ignores the action
  // if that Pokémon is no longer in the party. Automatic callers must pass it:
  // an effect computes its index from a committed render that can already be
  // a party reorder behind, and evolving the wrong slot is unrecoverable.
  // Click handlers omit it — a click and its dispatch share a frame.
  | { type: "START_EVOLUTION"; payload: { partyIndex: number; toSpeciesKey: string; pokemonId?: string } }
  | { type: "EVOLUTION_STEP" }
  | { type: "COMPLETE_EVOLUTION" }
  | { type: "SET_CATCH_RULE"; payload: { routeKey: string; speciesKey: string; settings: CatchSettings } }
  | { type: "CLEAR_CATCH_RULE"; payload: { routeKey: string; speciesKey: string } }
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
  // No MARK_CAUGHT / MARK_SHINY_CAUGHT / MARK_SHINY_SEEN / MARK_SEEN. They had
  // zero dispatchers and MARK_CAUGHT registered by species KEY, which cannot
  // carry shininess — the exact shape of br_2f7754077bfd6e9629. Dex writes go
  // through registerAcquired(state, mon) inside the reducer; see that helper.
  | { type: "START_HEALING" }
  | { type: "HEALING_STEP" }
  | { type: "COMPLETE_HEALING" }
  | { type: "REORDER_BOX"; payload: { from: number; to: number } }
  | { type: "SORT_BOX"; payload: { mode: string } }
  | { type: "CANCEL_EFFECT"; payload: { itemId: string; speciesKey?: string; routeKey?: string } }
  // `pokemonId` is optional and advisory-overriding: when present the reducer
  // re-anchors `index` by id and DROPS the action if that id is gone. Every
  // caller that snapshots an index before the user confirms should pass it —
  // see the comment on the reducer case.
  | {
      type: "RELEASE_POKEMON";
      payload: { source: "party" | "box"; index: number; pokemonId?: string };
    }
  // Bulk release, addressed ONLY by id — a loop of the index-addressed
  // RELEASE_POKEMON over a selection provably deletes the wrong Pokémon, since
  // ascending indices shift under each other. See the reducer case for the
  // shiny / auction-listed / last-healthy guards, all of which are enforced
  // there rather than in the UI.
  | { type: "RELEASE_MANY"; payload: { source: "party" | "box"; pokemonIds: string[] } }
  | { type: "SET_SKIP_RELEASE_CONFIRM"; payload: { value: boolean } }
  | { type: "MARK_POKEMON_LISTED"; payload: { pokemonId: string } }
  | { type: "SET_LISTED_POKEMON_IDS"; payload: { ids: string[] } }
  | { type: "SET_AUTO_HEAL"; payload: { enabled?: boolean; threshold?: number } }
  | { type: "TRADE_COMPLETE"; payload: { sentMonId: string; received: Pokemon } }
  | {
      type: "AUCTION_SETTLED";
      payload:
        | { role: "seller"; removedPokemonId: string; money: number; logMessage: string }
        | { role: "buyer"; pokemon: Pokemon; money: number; logMessage: string };
    }
  // `assignedId` is the id POST /api/saves stamped on a prize mon when it
  // folded the grant into cloud saveData. Present only on the grant-echo path
  // (absorbGrants); the legacy `gift:received` socket path omits it and the
  // reducer mints a local id instead. Client and server MUST agree on this id
  // — the box reconcile dedupes by id, so two ids for one mon is a duplicated
  // prize.
  //
  // Applying this is an OPTIMISATION, not the delivery mechanism: the prize is
  // already in the cloud copy and the same response's bumped saveAdoptSeq
  // would make this client adopt that copy anyway. Applying it here just saves
  // the winner's own tab a round trip and the play it would lose to one.
  | { type: "RECEIVE_GIFT"; payload: { prizes: Array<{ kind: "item"; itemId: string; quantity: number } | { kind: "money"; amount: number } | { kind: "pokemon"; label?: string; mon: Record<string, unknown>; assignedId?: string }> } }
  | { type: "SET_NICKNAME"; payload: { pokemonId: string; nickname: string } }
  | { type: "TOGGLE_EFFECT_PAUSED"; payload: { itemId: string; speciesKey?: string; routeKey?: string } }
  | { type: "SET_ALWAYS_CATCH_SHINIES"; payload: { value: boolean } }
  | { type: "RESET_ELITE_FOUR" }
  | { type: "TOGGLE_AUTO_PROCEED" }
  | { type: "SET_AUTO_EVOLVE"; payload: { value: boolean } }
  // Per-Pokémon evolve lock. Keyed by id, not by index, because it is settable
  // from the party row AND from the detail modal opened on a box Pokémon.
  | { type: "SET_EVOLVE_LOCK"; payload: { pokemonId: string; locked: boolean } }
  | { type: "BUY_REWARD_ITEM"; payload: { itemId: string; cost: number } }
  | { type: "START_RAID"; payload?: { speciesKey?: string; level?: number; tier?: import("../data/raidLegendaries").RaidTierId } }
  | { type: "END_RAID" }
  | { type: "UPDATE_VOLATILE"; payload: Partial<PlayerVolatile> }
  | { type: "USE_EFFECT_ITEM"; payload: { itemId: string; speciesKey: string; routeKey?: string } }
  | { type: "APPLY_SHARED_EXP"; payload: { exp: number } }
  | { type: "GIVE_HELD_ITEM"; payload: { pokemonId: string; itemId: string } }
  | { type: "TAKE_HELD_ITEM"; payload: { pokemonId: string } }
  | { type: "USE_LINK_CABLE"; payload: { partyIndex: number } }
  | { type: "USE_STONE"; payload: { itemId: string; partyIndex: number } }
  | { type: "USE_BOTTLE_CAP"; payload: { itemId: string; source: "party" | "box"; index: number; stat?: keyof Stats } }
  | { type: "USE_EV_BERRY"; payload: { itemId: string; source: "party" | "box"; index: number } }
  | { type: "USE_EXP_SHARE" }
  | { type: "SELL_ITEM"; payload: { itemId: string; quantity: number } }
  | { type: "LOAD_SAVE"; payload: { state: Partial<GameState> } };

export type Dispatch = (action: Action) => void;
