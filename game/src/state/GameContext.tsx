import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Action, CatchSettings, Dispatch, GameState, Pokemon } from "../types";
import { reducer } from "./reducer";
import { initialState } from "./initialState";
import { SAVE_KEY } from "../data/raidLegendaries";
import { pokemonTable } from "../data/pokemon";
import { genderFor } from "../data/gender";
import { expForLevel } from "../utils/stats";
import { pickAbility } from "../data/abilities";
import { routes } from "../data/routes";
import { recordBattle } from "../utils/battleHistory";
import { api } from "../net/api";
import { useAuth } from "../auth/AuthContext";
import { reportClientError } from "../net/errorReporter";
import { getSocket } from "../net/socket";
import { pushToast } from "../components/Toast";
import { pushAuctionNotification } from "./auctions";
import { settleAwayProgress } from "./awayProgress";
import { captureBootGift } from "./welcomeBack";
import { pendingRegionStarter } from "../utils/unlocks";
import {
  adoptCloudWholesale, cloudShouldWin, lineageCasualties, lostMonsMessage, mergeCloudAdvance,
} from "./saveReconcile";
import { grandfatherShinyCharm } from "../utils/shinyCharm";
import { repairLoadedSave } from "../utils/dexRepair";
import { isStreamMode } from "./streamMode";
import { executeStreamCommand } from "../utils/streamCommands";

// Defensive normalization on save load:
//   1. totalExp >= the level baseline (guards against hand-edited saves)
//   2. ivs present (older builds may not have generated them)
//   3. evs present (added in the natures/EVs feature)
//   4. nature present (added in the natures feature)
function normalizePokemon(p: Pokemon): Pokemon {
  const sp = pokemonTable[p.speciesKey];
  if (!sp) return p;
  const baseline = expForLevel(p.level, sp.growthRate);
  let next: Pokemon = p;
  if (next.totalExp < baseline) next = { ...next, totalExp: baseline };
  if (!next.ivs || typeof next.ivs.hp !== "number") {
    // Re-roll missing IVs deterministically as zeros so saves stay consistent.
    next = {
      ...next,
      ivs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
    };
  }
  if (!next.evs) {
    next = {
      ...next,
      evs: { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 },
    };
  }
  // BACKFILL GENDER, rather than defaulting it.
  //
  // Every Pokemon caught before the field existed has none. The tempting fix
  // is "call them all male", and it is wrong in a way you can see: it puts a
  // male Chansey, a male Miltank and a male Nidoran-F in the box. Those
  // species have exactly one possible answer and the game already knows it.
  //
  // genderFor is pure and reads only the IVs — which are on the Pokemon
  // already, and which this function has just guaranteed exist. So an old
  // Pokemon gets the SAME gender it would have been given had the field
  // existed when it was caught: genderless species stay genderless, the
  // fixed ones come out right, and the rest split evenly and stably.
  //
  // Runs AFTER the IV fill above, deliberately. The other order would hash a
  // missing IV block for anything that needed one.
  if (next.gender === undefined) {
    next = { ...next, gender: genderFor(next.speciesKey, next.ivs as unknown as Record<string, number>) };
  }
  if (!next.nature) {
    // Pick a neutral-ish default: Hardy (no stat impact). Keeps legacy stats
    // unchanged for old saves.
    next = { ...next, nature: "Hardy" };
  }
  if (!next.ability) {
    // Back-fill ability for legacy Pokemon predating the abilities system.
    // Roll from the species' primary list; null if the species has no
    // entry in speciesAbilities (shouldn't happen for the 151 dex).
    const ab = pickAbility(next.speciesKey);
    if (ab) next = { ...next, ability: ab };
  }
  return next;
}

export type SaveStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error"       // transient: offline / 5xx / rate-limited. Retries.
  | "conflict"    // another device wrote. Needs the player to choose.
  | "rejected";   // permanent: the server will never accept this save.

interface GameContextValue {
  state: GameState;
  dispatch: Dispatch;
  /** Coarse-grained cloud-sync status for the UI. `pending` while the
   *  debounce timer is running; `saving` while putSave is in flight;
   *  `saved` when the most recent flush succeeded; `error` when it
   *  failed (most often: offline). */
  saveStatus: SaveStatus;
  /** Wall-clock timestamp of the last successful putSave, or null if
   *  no save has succeeded this session. Lets the indicator show
   *  "Saved · 12s ago" instead of a static "Saved". */
  lastSavedAt: number | null;
  /** Force an immediate cloud flush and resolve when it settles. Call before
   *  a server action validated against the cloud save (auction bid / listing)
   *  so it sees the player's live money / Pokémon, not a stale autosave. */
  syncNow: () => Promise<void>;
}

const GameContext = createContext<GameContextValue | null>(null);

function loadSaved(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as Partial<GameState>;
    if (!parsed.playerPokemon) return initialState;
    // Drop the blob's envelope fields (owner, timestamp, sync bookkeeping)
    // before they get spread into GameState. pickPersistent would filter them
    // out of any upload anyway, but they have no business travelling through
    // the reducer or through mergeCloudAdvance's `{...base}`.
    delete (parsed as Record<string, unknown>)[OWNER_KEY];
    delete (parsed as Record<string, unknown>)[SNAPSHOT_TS_KEY];
    delete (parsed as Record<string, unknown>)[CLOUD_VERSION_FIELD];
    delete (parsed as Record<string, unknown>)[ADOPT_SEQ_FIELD];
    // Normalize totalExp on every Pokemon — guards against legacy / hacked saves.
    const normalizedParty = (parsed.party ?? []).map(normalizePokemon);
    const normalizedBox = (parsed.box ?? []).map(normalizePokemon);
    // Reconcile activePlayerPokemonIndex with playerPokemon — older saves
    // didn't persist the index, and a mismatched index breaks syncPlayerToParty,
    // which means the active Pokémon's EXP/HP gains never propagate to the
    // party row. Look the playerPokemon up by id; fall back to slot 0.
    const persistedIdx = parsed.activePlayerPokemonIndex;
    let activeIdx =
      typeof persistedIdx === "number" &&
      persistedIdx >= 0 &&
      persistedIdx < normalizedParty.length &&
      normalizedParty[persistedIdx]?.id === parsed.playerPokemon.id
        ? persistedIdx
        : normalizedParty.findIndex((p) => p.id === parsed.playerPokemon!.id);
    if (activeIdx < 0) activeIdx = 0;
    const activeFromParty = normalizedParty[activeIdx] ?? normalizePokemon(parsed.playerPokemon);
    // Migration: existing players inherited the old DEFAULT_CATCH_SETTINGS
    // (mode "pokedex_new") which silently stopped throwing balls once
    // a species was caught. Veterans flooded global chat with "auto-
    // catch doesn't work on Gastly / Porygon / Eevee dupes" reports.
    // We flipped the default to "always" but baked-in saves still
    // carry "pokedex_new". One-time flip ONLY when the save shows the
    // exact factory-default shape — never overrides an opt-in choice
    // (e.g. ball list other than ["pokeball"] or non-default threshold).
    // Naturally idempotent: once flipped to "always", the condition no
    // longer matches, so no flag needed.
    let migratedGlobalCatchDefaults = parsed.globalCatchDefaults;
    if (
      parsed.globalCatchDefaults
      && parsed.globalCatchDefaults.mode === "pokedex_new"
      && parsed.globalCatchDefaults.enabled === true
      && parsed.globalCatchDefaults.levelThreshold === 1
      && Array.isArray(parsed.globalCatchDefaults.enabledBalls)
      && parsed.globalCatchDefaults.enabledBalls.length === 1
      && parsed.globalCatchDefaults.enabledBalls[0] === "pokeball"
    ) {
      migratedGlobalCatchDefaults = { ...parsed.globalCatchDefaults, mode: "always" };
    }

    // Same migration, but for per-species overrides. These are full
    // snapshots taken at the moment a player toggled a species or hit
    // "All"/"None" — NOT synced from globalCatchDefaults afterward (see
    // reducer.ts's SET_GLOBAL_CATCH_DEFAULTS/TOGGLE_ROUTE_CATCH_ALL doc
    // comments for the bug this used to cause: a species whose override
    // was created back when the factory default was "pokedex_new" stays
    // frozen on it forever, immune to every later settings change).
    // Multiple bug reports of "Safari Zone / Route 3 won't catch
    // anything, JSON still shows pokedex_new" traced back here. Same
    // exact-match, idempotent, opt-in-preserving guard as above.
    let migratedCatchSettings = parsed.catchSettings;
    if (parsed.catchSettings && typeof parsed.catchSettings === "object") {
      let anyChanged = false;
      const nextRoutes: typeof parsed.catchSettings = {};
      for (const [routeKey, speciesRules] of Object.entries(parsed.catchSettings)) {
        const nextSpecies: Record<string, CatchSettings> = {};
        for (const [speciesKey, rule] of Object.entries(speciesRules ?? {})) {
          if (
            rule
            && rule.mode === "pokedex_new"
            && rule.enabled === true
            && rule.levelThreshold === 1
            && Array.isArray(rule.enabledBalls)
            && rule.enabledBalls.length === 1
            && rule.enabledBalls[0] === "pokeball"
          ) {
            nextSpecies[speciesKey] = { ...rule, mode: "always" };
            anyChanged = true;
          } else {
            nextSpecies[speciesKey] = rule;
          }
        }
        nextRoutes[routeKey] = nextSpecies;
      }
      if (anyChanged) migratedCatchSettings = nextRoutes;
    }

    // Dedupe Pokédex arrays. DrWhy reported "rankings show 151 for
    // pokédex but profile goes up to 194" — the server's pokedexCaughtCount
    // already runs through `new Set(...)` (level.ts) but the client
    // reads `state.pokedexCaught.length` directly in 4 places
    // (BottomTabs DexTab, GlobalDock Settings, PokedexPanel,
    // TrainerCardModal), so duplicate entries inflate the displayed
    // count out of sync with the server view. Strip dupes once on
    // load; subsequent dispatches that add to these arrays already
    // guard against re-adds via .includes() — this catches legacy
    // saves from before that guard existed.
    const dedupeStrings = (arr: unknown): string[] => {
      if (!Array.isArray(arr)) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const v of arr) {
        if (typeof v !== "string") continue;
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
      return out;
    };

    const mergedLocation = parsed.currentLocation ?? initialState.currentLocation;
    const mergedClaimedRegionStarters = parsed.claimedRegionStarters ?? initialState.claimedRegionStarters;
    const hasPendingRegionStarter = !!pendingRegionStarter(mergedClaimedRegionStarters, mergedLocation);

    // repairLoadedSave runs on the OTHER entry point too (the reducer's
    // LOAD_SAVE), and has to run on both: this boot path never touches the
    // reducer, so a purely-local player would otherwise keep a dex that is
    // missing species they hold. It clamps nextPokemonId above every live id and
    // registers every owned mon (species + shiny). Additive and idempotent —
    // see utils/dexRepair.ts for why that is safe to do unconditionally.
    return grandfatherShinyCharm(repairLoadedSave({
      ...initialState,
      ...parsed,
      playerPokemon: activeFromParty,
      party: normalizedParty,
      box: normalizedBox,
      activePlayerPokemonIndex: activeIdx,
      pokedexCaught: dedupeStrings(parsed.pokedexCaught),
      pokedexSeen:   dedupeStrings(parsed.pokedexSeen),
      shinyCaught:   dedupeStrings(parsed.shinyCaught),
      shinySeen:     dedupeStrings(parsed.shinySeen),
      globalCatchDefaults: migratedGlobalCatchDefaults ?? initialState.globalCatchDefaults,
      catchSettings: migratedCatchSettings ?? initialState.catchSettings,
      // Defensively reset transient fields we never want to restore
      phase: hasPendingRegionStarter ? "regionStarterSelect" : "idle",
      enemyPokemon: null,
      battleEvents: [],
      pendingEvents: [],
      currentEventIndex: 0,
      battleLog: ["Game loaded!"],
      evolutionState: null,
      trainerBattle: null,
      bossBattle: null,
      bossQueue: [],
      healingState: null,
      pendingBossBattle: null,
      playerVolatile: null,
      paused: false,
      awaitingSwitch: false,
      defeatedTrainers: parsed.defeatedTrainers ?? [],
      // grandfatherShinyCharm (above): the charm is now a held item gated on
      // full completion of the obtainable dex, where it used to be an
      // invisible multiplier gated on `pokedexCaught.length >= 245`. Saves
      // written under the old rule have no item to read, so anyone who was
      // already getting the doubled rate is handed the real charm here rather
      // than silently losing it. Idempotent — a no-op once the item is held.
    }));
  } catch {
    return initialState;
  }
}

// Reconciliation decision (cloudShouldWin / cloudHasMoreProgress / the
// version signal) lives in ./saveReconcile so it can be unit-tested in
// isolation — see saveReconcile.ts and its standalone edge-case tests.

// ── THE SYNC BOOKKEEPING, AND WHY IT LIVES INSIDE THE BLOB ──────────────
//
// Two numbers describe this browser's relationship to the cloud copy:
//
//   * the cloud `saveVersion` it last synced with. If the live cloud version
//     is higher, the server made writes (auction settlement, admin gift,
//     another device) this browser never saw, so cloud must win.
//   * the server-owned `saveAdoptSeq` it last ADOPTED. When the server reports
//     a higher value it AUTHORITATIVELY rewrote this save — an admin edit /
//     restore / item-set, an auction escrow or settlement, or a prize fold —
//     and the client must adopt the cloud copy WHOLESALE, bypassing the
//     protective merge. Otherwise the merge or a plain re-upload would undo
//     the server's write: that is how an auctioned Pokémon never reached its
//     buyer, and how a giveaway prize was destroyed by the winner's second
//     tab. See server/src/lib/saveAdopt.ts.
//
// Both used to be their own standalone localStorage key, and that is a
// SESSION-BOUNDARY PRIZE KILLER, because localStorage is shared by every tab:
//
//   tab A uploads; the server folds a Master Ball into that upload and bumps
//   the version and the seq. A writes the prize-bearing blob to SAVE_KEY, and
//   :cloudv=11 and :adoptseq=4.
//   tab B knows nothing about any of it. Its next state change (or its
//   pagehide) overwrites SAVE_KEY with its own prize-less blob and touches
//   NEITHER counter.
//
// The persisted seq now describes a blob that no longer exists. The next
// session seeds `adoptedSeqRef` from it, concludes it has already adopted seq
// 4, SKIPS the adopt, takes the "local extends cloud" branch and uploads B's
// blob straight over the prize. Delivery happens exactly once; the Master Ball
// is gone permanently, and no later boot can recover it.
//
// So the bookkeeping is STAMPED INTO THE BLOB, in the same `setItem` as the
// bytes it describes. localStorage has no multi-key transaction — one key IS
// the only atomic unit available — so the record has to be one key. Whichever
// tab writes SAVE_KEY last necessarily writes ITS OWN view of the version and
// seq with it, and the persisted seq can therefore never over-claim relative
// to the persisted bytes. In the scenario above B stamps {v:10, seq:3}, the
// next boot sees the server at seq 4, adopts wholesale, and finds the prize.
//
// Rejected alternatives:
//   * per-tab keys (`:adoptseq:<tabId>`) — a tab that never reopens leaks its
//     key forever, and boot would still have to guess which tab's bookkeeping
//     belongs to the one shared blob. Same ambiguity, more state.
//   * a BroadcastChannel lock — requires every tab alive and cooperating; a
//     tab killed by the OS mid-write leaves exactly the split state again.
//   * writing the three keys "together" — not atomic, so the crash window it
//     is meant to close simply moves.
//
// The standalone keys are still read as a FALLBACK (a blob written before this
// change carries no stamp) and still written, so an old tab left open across a
// rolling deploy keeps behaving exactly as it does today. A stamped blob
// always wins over them, and `__adoptseq`'s PRESENCE — not its value — is what
// marks a blob as stamped, so a stamped "never synced" blob is not mistaken
// for a legacy one and quietly handed a sibling's counter.
const SYNC_VERSION_KEY = SAVE_KEY + ":cloudv";
const ADOPT_SEQ_KEY = SAVE_KEY + ":adoptseq";
/** In-blob field names. Prefixed like __savedAt / __owner so they can never
 *  collide with a GameState key. */
const CLOUD_VERSION_FIELD = "__cloudv";
const ADOPT_SEQ_FIELD = "__adoptseq";

function readBlobRaw(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function legacyNum(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export interface SyncBookkeeping {
  /** Cloud saveVersion this blob is synced to; null = never synced. */
  version: number | null;
  /** saveAdoptSeq the writer of this blob had adopted. */
  adoptSeq: number;
}

/** Read the bookkeeping that belongs to the blob currently on disk. */
function readSyncBookkeeping(): SyncBookkeeping {
  const blob = readBlobRaw();
  if (blob !== null && ADOPT_SEQ_FIELD in blob) {
    return {
      version: numOrNull(blob[CLOUD_VERSION_FIELD]),
      adoptSeq: numOrNull(blob[ADOPT_SEQ_FIELD]) ?? 0,
    };
  }
  return { version: legacyNum(SYNC_VERSION_KEY), adoptSeq: legacyNum(ADOPT_SEQ_KEY) ?? 0 };
}

// Legacy mirrors. Written so a pre-deploy tab sharing this browser keeps
// seeing accurate values; never read when the blob carries its own stamp.
function writeLegacySyncVersion(v: number): void {
  try { localStorage.setItem(SYNC_VERSION_KEY, String(v)); } catch { /* */ }
}
function writeLegacyAdoptSeq(v: number): void {
  try { localStorage.setItem(ADOPT_SEQ_KEY, String(v)); } catch { /* */ }
}
function clearSyncVersion(): void {
  try {
    localStorage.removeItem(SYNC_VERSION_KEY);
    localStorage.removeItem(ADOPT_SEQ_KEY);
  } catch { /* */ }
}

// The state to LOAD when adopting a cloud copy wholesale. Lives in
// ./saveReconcile (pure, dependency-free, unit-testable) — see
// adoptCloudWholesale there for why the spendable set must be materialised in
// full and why the active mon has to be re-anchored.
function stateFromCloud(cloudData: any): GameState {
  // Same Shiny Charm migration loadSaved applies to the local blob. Cloud
  // adoption is the path a veteran on a fresh device takes, and it is the
  // path the players who reported the missing charm are on — skipping it here
  // would hand them the new (higher) threshold without the item they earned
  // under the old one. saveReconcile stays dependency-free, so it goes here.
  return grandfatherShinyCharm(adoptCloudWholesale(cloudData, normalizePokemon)) as GameState;
}

// Which account's progress the local blob holds.
//
// SAVE_KEY is one global string for the whole browser and is never cleared
// — not on sign-out, not on account switch. So the blob outlives the
// session that wrote it, and the next account to sign in read it as its
// own: a veteran's save would be adopted by a newbie's session and then
// uploaded over the newbie's cloud row, destroying it. Both the client's
// progress check and the server's anti-regression guard PASS that write,
// because the veteran's save is greater on every milestone they compare.
//
// We stamp the owner in the blob rather than scoping the key, deliberately.
// Re-keying to `save:${userId}` would leave every existing player's save at
// the old key, so their first boot after deploy would read an empty scoped
// key, conclude "no local save", and take the cloud-wins branch — silently
// discarding local progress for anyone whose cloud had fallen behind. That
// is the exact loss this is meant to prevent. An in-blob marker needs no
// migration: unowned legacy blobs keep today's behaviour precisely.
const OWNER_KEY = "__owner";

// Upper bound on how long a change can sit unsent. Not a "wait for quiet"
// window — see the uploader effect for why that distinction matters.
//
// 2500ms = 24 writes/min, deliberately under the server's own 30/min save
// limiter (server/src/routes/saves.ts). At the old 1500ms the client could
// ask for 40/min and earn itself 429s, which it then rendered to the player
// as "Offline" — a self-inflicted failure blamed on their internet.
const CLOUD_THROTTLE_MS = 2500;

const PERSISTENT_KEYS: (keyof GameState)[] = [
  "playerPokemon",
  "activePlayerPokemonIndex",
  "currentRoute",
  "speed",
  "wildBattlesWon",
  "trainerBattlesWon",
  "battlesWonByLocation",
  "party",
  "box",
  "autoCatch",
  "nextPokemonId",
  "currentLocation",
  "unlockedLocations",
  "catchSettings",
  "globalCatchDefaults",
  "alwaysCatchShinies",
  "money",
  "inventory",
  "pokedexSeen",
  "pokedexCaught",
  "shinyCaught",
  "shinySeen",
  "defeatedGyms",
  "defeatedEliteFour",
  "championDefeated",
  "defeatedChampions",
  "claimedRegionStarters",
  // Reported by Gshow within hours of Route Mastery shipping: "it delivers
  // the prize every time one refreshes (F5) the page". Correct, and the cause
  // was this list. The reducer guarded the claim, the merge unioned it, and
  // 17 tests covered both — but the record of WHICH tiers had been paid was
  // never written to the save, so every reload started from an empty list and
  // re-offered the lot. An infinite Silver Bottle Cap tap.
  //
  // A guard that is not persisted is not a guard. See tests/saveKeys.test.ts,
  // which now fails if anything in MONOTONIC_KEYS is missing from here.
  "claimedMastery",
  "victoryTokens",
  "autoProceed",
  "autoEvolve",
  "skipReleaseConfirm",
  "autoHeal",
  "autoHealThreshold",
  // Deliberately persisted even though the SERVER is authoritative for it: a
  // reload would otherwise un-guard every listed Pokémon until the player
  // happened to open the auction board's "mine" tab, and the whole point is
  // that the box cannot delete something already sold. A stale id whose mon is
  // gone is harmless — the guards look the id up in party/box first.
  "listedPokemonIds",
  "raidCooldownEnd",
  "raidCooldowns",
  "raidLegendary",
  "inRaid",
  "raidLevel",
  "preRaidLocation",
  "activeEffects",
  "defeatedTrainers",
  "battleMode",
];

// How long to wait before re-offering a save the rate-of-gain guard refused.
// The guard's allowance grows at MONEY_RATE_PER_HOUR, so every minute spent
// here buys back real headroom; ten of them is enough to clear an ordinary
// burst without hammering a server that has just said no.
const GAIN_RETRY_BACKOFF_MS = 10 * 60 * 1000;

export function GameProvider({ children }: { children: ReactNode }) {
  // Initial state still seeds from localStorage so the player sees their
  // game instantly. Cloud sync hydrates over it once the network call
  // returns (cloud wins if it has data; otherwise local migrates up).
  const [state, dispatch] = useReducer(reducer, undefined, loadSaved);
  const cloudReadyRef = useRef(false);
  // The bookkeeping that came off disk with the blob we booted from. Read
  // ONCE — `readSyncBookkeeping` parses the whole save blob, and a ref's
  // initialiser argument is evaluated on every render.
  const bootSyncRef = useRef<SyncBookkeeping | null>(null);
  if (bootSyncRef.current === null) bootSyncRef.current = readSyncBookkeeping();
  // The cloud `saveVersion` that LIVE STATE is known to incorporate — i.e. the
  // version an upload composed from the current state may legitimately claim.
  // -1 means "we have never successfully talked to the cloud this session";
  // in that state we MUST NOT push local state up at all (it might be stale,
  // and with no version the server's compare-and-swap degrades to an
  // unconditional write that cannot miss).
  //
  // It is deliberately NOT "the newest version the server has told us about".
  // When the server rewrites a save — a prize fold, a wholesale adopt, an
  // auction settlement — the new version describes bytes that are still
  // travelling to live state through a dispatch. Advancing this ref at that
  // moment would let a snapshot taken microseconds later, before React
  // committed the change, claim a version whose bytes it does not contain:
  // stale bytes, fresh version, CAS passes, prize erased. Those sites set
  // `deferredCloudVersionRef` instead, and the local-save effect promotes it
  // AT THE COMMIT that carries the bytes.
  const cloudVersionRef = useRef<number>(-1);
  // A cloud version whose bytes have been DISPATCHED but have not yet reached
  // live state. Promoted into cloudVersionRef (and the persisted stamp) by the
  // local-save effect. Until then every upload keeps claiming the OLD version,
  // so it 409s and adopts — the fail-safe direction, and the one that cannot
  // destroy a prize.
  const deferredCloudVersionRef = useRef<number | null>(null);
  const lastUploadedRef = useRef<string>("");
  // True while flushCloud's request is awaiting a response. The
  // pagehide/visibilitychange beacon below checks this to avoid racing an
  // already-in-flight upload that's using the same cloudVersionRef — see
  // that effect's comment for the failure mode this prevents.
  const uploadInFlightRef = useRef(false);
  // A `gift:pending` nudge that arrived while an upload was already on the
  // wire. That upload is NOT guaranteed to collect the grant: the server reads
  // what is owed outside the save transaction, so a row that commits after
  // that read is invisible to it. Re-fire once the wire is clear instead of
  // assuming it was collected — see onGiftPending.
  const grantNudgeRef = useRef(false);
  // The `saveAdoptSeq` THIS TAB has adopted, in memory.
  //
  // Deliberately not read back out of localStorage on each check: two tabs of
  // the same account share that key, so the tab that uploaded and skipped its
  // own adopt would otherwise disarm the sibling tab that still has to take
  // one — and the sibling is precisely the tab whose stale blob would destroy
  // the prize. Seeded from storage once, for the offline/boot case.
  const adoptedSeqRef = useRef<number>(bootSyncRef.current.adoptSeq);
  // What is currently STAMPED (or about to be stamped) into the local blob.
  // Distinct from the two refs above: those describe LIVE STATE, these
  // describe the bytes on disk, and the local-save effect is the only thing
  // that makes them agree.
  const persistedCloudVersionRef = useRef<number | null>(bootSyncRef.current.version);
  const persistedAdoptSeqRef = useRef<number>(bootSyncRef.current.adoptSeq);
  // The newest snapshot that has not reached the cloud yet, THE CLOUD VERSION
  // IT WAS COMPOSED AGAINST, and the timer that will send it. See the uploader
  // below for why this is a throttle and not a debounce.
  //
  // ── WHY THE VERSION IS PART OF THIS RECORD ──────────────────────────
  // flushCloud used to pair `pending.snapshot` with `cloudVersionRef.current`
  // AT FLUSH TIME. Those are two independently updated values, so a snapshot
  // composed BEFORE a server-authoritative rewrite could be uploaded with a
  // version learned AFTER it. The compare-and-swap passed because the version
  // was fresh while the bytes were stale, and the prize the rewrite had just
  // added was erased. Every hole found in four review rounds — the mid-session
  // adopt that left the throttle timer armed on a pre-adopt snapshot, the
  // sibling tab across a session boundary, the 409 body that taught a version
  // with no adopt seq attached — was one instance of that one pairing.
  //
  // Capturing the version WITH the bytes makes the pairing structural instead
  // of a rule every future edit has to remember: stale bytes ALWAYS carry a
  // stale version, so the CAS always rejects them and the client 409s and
  // adopts. No code path can hand fresh bytes' version to stale bytes, because
  // exactly one function composes the pair and it reads both at the same
  // instant. `capturePending` is that function.
  const pendingRef = useRef<{
    snapshot: Partial<GameState>; serialized: string; baseVersion: number;
  } | null>(null);
  const uploadTimerRef = useRef<number | undefined>(undefined);
  // Set once a permanent rejection (400/413/403) is seen. The save we are
  // producing is one the server will never accept, so retrying it forever
  // just burns the rate limit and lies to the player with "Offline".
  const permanentlyRejectedRef = useRef<string | null>(null);
  // ── THE RATE GUARD IS A DELAY, NOT A VERDICT ──────────────────────────
  // The server's rate-of-gain guard refuses with 400, and 400 used to mean
  // "this server will never accept this save" — the client stopped uploading
  // for the entire session. But that guard's allowance is
  //     MONEY_BURST + MONEY_RATE_PER_HOUR x hoursSinceLastAcceptedSave
  // which GROWS with time. A refusal is inherently temporary: wait, and the
  // same bytes become acceptable. Turning the first one into a permanent stop
  // is what guaranteed it could never heal.
  //
  // What that cost, from one report: "my account level is frozen no matter
  // how much pokemons i level up or catch" AND "it reseted my progress after
  // i posted pokemon in auction". Both, from this one ref. Uploads stop, so
  // the server-derived accountLevel never moves again; then any of the
  // remaining saveAdoptSeq bump sites makes the client adopt the last
  // ACCEPTED save wholesale, and every hour played since the lockout is gone.
  // The server comment reasoned "the player loses nothing but the cloud copy",
  // which is true only in a world with no adopts.
  //
  // So this one is a timestamp, not a latch.
  const gainBackoffUntilRef = useRef<number>(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Ref twin of lastSavedAt. The socket effect mounts with [] deps, so it
  // closes over the FIRST render's state forever — reading `lastSavedAt`
  // there would report null on every socket-driven adopt, which is exactly
  // the case the adopt-loss telemetry below needs it for.
  const lastSavedAtRef = useRef<number | null>(null);
  const { refresh: refreshProfile, me } = useAuth();
  // The signed-in account. GameProvider only mounts when authenticated, so
  // this is set for every save this provider will ever write.
  const myIdRef = useRef<string | null>(me?.id ?? null);
  myIdRef.current = me?.id ?? null;

  // The ONE place a snapshot and the cloud version it is valid against are
  // paired. Both are read here, at the same instant, and travel together from
  // here on. See pendingRef for what pairing them later cost.
  const capturePending = (snapshot: Partial<GameState>, serialized: string) => {
    pendingRef.current = { snapshot, serialized, baseVersion: cloudVersionRef.current };
  };

  // ── THE ONLY WAY A BOUND VERSION MAY EVER BE RAISED ──────────────────────
  //
  // Advance the version live state — and anything captured from it — may
  // claim. There is exactly one precondition, and every caller must have
  // established it:
  //
  //   THE CLOUD AT `v` CONTAINS NO SERVER-AUTHORITATIVE BYTES THIS SESSION HAS
  //   NOT ALREADY INCORPORATED.
  //
  // Two situations satisfy it, and they are the only two:
  //   * an accepted upload whose response certifies the server added nothing
  //     (no `grantsApplied`, no `saveAdoptSeq` past what we adopted) — the
  //     cloud at `v` is literally the bytes we just sent;
  //   * a 409 whose re-read found no adopt to take — everything between the
  //     old version and `v` was a plain client upload, ours or a sibling's,
  //     and overwriting a sibling is the documented last-writer-wins
  //     behaviour. A sibling upload that COLLECTED A PRIZE bumps the adopt
  //     seq, so it can never reach this branch.
  //
  // Raising `pendingRef.baseVersion` here is not a loophole in the binding, it
  // is the binding staying live: without it, a snapshot captured while a
  // request was in flight would be refused by this client's own write and the
  // client would 409 forever whenever state stopped changing.
  //
  // The deferred guard is load-bearing. While `deferredCloudVersionRef` is
  // set, a server-authoritative rewrite is still travelling to live state
  // through a dispatch — so live state does NOT yet contain the bytes at that
  // version, and neither does anything captured from it. Advancing then would
  // recreate the exact pairing this file exists to prevent.
  const advanceUploadBase = (v: number) => {
    if (deferredCloudVersionRef.current !== null) return;
    if (v <= cloudVersionRef.current) return;
    cloudVersionRef.current = v;
    const p = pendingRef.current;
    if (p && p.baseVersion < v) p.baseVersion = v;
  };

  // Record the sync point we are now at, WITHOUT writing the blob. Safe
  // whenever the blob is about to be (re)written by the local-save effect: a
  // stamp that lags the truth only ever makes the next boot conclude "the
  // server advanced past us" and take the cloud copy, which is the
  // conservative direction. A stamp that RUNS AHEAD of the bytes it describes
  // is what destroys prizes, and nothing here can produce one.
  //
  // Both values are MONOTONIC here. A response that was already in flight when
  // an adopt landed can arrive carrying an older version, and letting it walk
  // the stamp backwards would describe the blob as less synced than it is. It
  // would still be the safe direction (an under-claim only makes the next boot
  // prefer the cloud), but there is no reason to allow it. A deliberate reset
  // clears the refs directly rather than going through here.
  const recordSyncPoint = (version: number | null, seq: number | null) => {
    if (typeof version === "number" && version > (persistedCloudVersionRef.current ?? -1)) {
      persistedCloudVersionRef.current = version;
      writeLegacySyncVersion(version);
    }
    if (typeof seq === "number" && seq > persistedAdoptSeqRef.current) {
      persistedAdoptSeqRef.current = seq;
      writeLegacyAdoptSeq(seq);
    }
  };

  // Record the sync point AND the exact bytes it describes, in one setItem.
  // Used by every path that replaces live state from the cloud, where the
  // local-save effect cannot be relied on to run before the tab dies.
  const commitSyncPoint = (
    snapshot: Partial<GameState>,
    version: number | null,
    seq: number | null,
  ) => {
    recordSyncPoint(version, seq);
    writeLocalSave(
      snapshot, myIdRef.current,
      persistedCloudVersionRef.current, persistedAdoptSeqRef.current,
    );
  };

  // Adopt the cloud copy WHOLESALE if the server has authoritatively rewritten
  // this save since this tab last adopted (admin edit / restore / item-set,
  // auction escrow or settlement, prize fold).
  //
  // Takes an ALREADY-FETCHED getSave result on purpose: the seq and the
  // saveVersion must come from the same response. Learning the version without
  // the seq is exactly what let a losing tab push its stale blob past the
  // server's compare-and-swap and destroy a prize that had just been folded in.
  //
  // Returns true if it adopted. A no-op when the seq has not moved, so every
  // caller can hand it any getSave result unconditionally.
  const adoptIfServerRewrote = (fresh: {
    saveData: unknown; saveVersion: number; saveAdoptSeq?: number;
  }): boolean => {
    const seq = typeof fresh.saveAdoptSeq === "number" ? fresh.saveAdoptSeq : 0;
    if (seq <= adoptedSeqRef.current) return false;
    const fd = fresh.saveData as Partial<GameState> | null;
    // Nothing usable to adopt (a wiped account). Leave the seq UNRECORDED so a
    // later fetch that does carry data still adopts; a reset has its own paths
    // (`save:reset`, and the cloud-version-went-backwards check at boot).
    if (!fd || !(fd as any).playerPokemon) return false;
    const nextState = stateFromCloud(fd);

    // ── WHAT THIS ADOPT IS ABOUT TO THROW AWAY ────────────────────────────
    // An adopt is a WHOLESALE replacement: LOAD_SAVE, no comparison, by
    // design — the server made an authoritative change this client cannot
    // know about, so its bytes win. The cost is that anything played since
    // the last upload goes with it, and that cost was completely unmeasured.
    // Every report of it arrived as "my Pokémon reset" days later, with no
    // way to tell which of the ten bump sites had done it.
    //
    // So measure it at the only place that can see both copies. This is
    // reported, not prevented: refusing the adopt would leave the client
    // holding money the server already spent, which is the dupe this whole
    // mechanism exists to stop. A zero-delta adopt is the normal case and
    // stays silent, so anything that shows up here is real loss.
    try {
      const local = stateRef.current;
      const levelsOf = (s: any) =>
        [...(s?.party ?? []), ...(s?.box ?? [])]
          .reduce((n: number, m: any) => n + (Number(m?.level) || 0), 0);
      const lost = {
        dex: (local?.pokedexCaught?.length ?? 0) - (nextState?.pokedexCaught?.length ?? 0),
        shinies: (local?.shinyCaught?.length ?? 0) - (nextState?.shinyCaught?.length ?? 0),
        levels: levelsOf(local) - levelsOf(nextState),
        mons: ((local?.party?.length ?? 0) + (local?.box?.length ?? 0))
          - ((nextState?.party?.length ?? 0) + (nextState?.box?.length ?? 0)),
      };
      if (lost.dex > 0 || lost.shinies > 0 || lost.levels > 0 || lost.mons > 0) {
        reportClientError({
          source: "save-adopt-loss",
          // Fixed string: this is the (kind, message) group key server-side,
          // so putting the numbers in it would fragment one problem into a
          // separate dashboard row per player. They go in meta.
          message: "adopt discarded local progress",
          meta: {
            ...lost,
            // The two fields that identify WHICH writer did it: how long this
            // client had been playing unsynced, and the seq it jumped to.
            secondsSinceUpload: lastSavedAtRef.current
              ? Math.round((Date.now() - lastSavedAtRef.current) / 1000)
              : null,
            seq,
          },
        });
      }
    } catch { /* never let telemetry break an adopt */ }

    const snapshot = pickPersistent(nextState);
    dispatch({ type: "LOAD_SAVE", payload: { state: nextState } });
    // Mark it already-uploaded so the autosave diff does not immediately push
    // it straight back.
    lastUploadedRef.current = JSON.stringify(snapshot);
    // The in-memory gate moves NOW: a socket `save:adopt`, a 409 re-read and
    // the boot check can all fire within one tick, and re-adopting the same
    // copy would throw away the play in between for nothing.
    adoptedSeqRef.current = seq;
    // ── BLOB FIRST, THEN THE BOOKKEEPING — here, literally one write. ──
    // The old order was INVERTED: it persisted the seq and the sync version
    // immediately and left the ADOPTED BYTES to be written later by the
    // local-save effect. A tab that died in that window came back claiming to
    // have adopted seq N while still holding the PRE-adopt blob, so boot
    // skipped the adopt, took the "local extends cloud" branch, and uploaded
    // the pre-adopt bytes straight over the prize. commitUploadResult has
    // always been careful about exactly this hazard; the adopt path was not.
    commitSyncPoint(snapshot, fresh.saveVersion ?? 0, seq);
    // The UPLOAD base, by contrast, must wait for the dispatch to reach live
    // state — otherwise a snapshot taken before React commits would claim the
    // adopted version while holding pre-adopt bytes. See cloudVersionRef.
    deferredCloudVersionRef.current = fresh.saveVersion ?? 0;
    return true;
  };

  // ── Server-owed prizes (PendingGrant) ──
  // The server no longer writes giveaway / gift prizes straight into cloud
  // saveData. It owes them, and folds them into whatever blob we upload, in
  // the transaction that accepts that upload — so a stale push from us can no
  // longer overwrite a prize (it used to, and Master Balls were silently
  // destroyed for every winner who was mid-session at draw time).
  //
  // Our half of that contract: every putSave response that reports
  // `grantsApplied` describes bytes the server has ALREADY stored on top of
  // ours. Apply exactly those to live state, or our next autosave — which is
  // built from live state and knows nothing about them — clobbers the prize
  // 2.5s later. This must therefore run at EVERY putSave call site, which is
  // why it lives here rather than inside flushCloud.
  //
  // Applying it is an OPTIMISATION, not the safety net. The same response
  // carries a bumped `saveAdoptSeq`, so if this dispatch never happened — a
  // dropped response, a tab that died mid-request — this client would adopt
  // the cloud copy (which holds the prize) on its next 409, its next
  // `save:adopt`, or its next boot. What applying it here buys is that the
  // WINNER'S OWN tab does not have to take that round trip and lose the play
  // it has not uploaded yet.
  //
  // There is deliberately nothing here that records the delivery. Delivery
  // lives in PendingGrant.deliveredAt on the server; a copy of it in the save
  // blob would be a payment gate the client supplies, which is exactly the
  // exploit that was removed.
  const absorbGrants = (res: { grantsApplied?: unknown; grantsSummary?: string }) => {
    const prizes = Array.isArray(res?.grantsApplied) ? res.grantsApplied : [];
    if (prizes.length === 0) return;
    dispatch({ type: "RECEIVE_GIFT", payload: { prizes: prizes as any } });
    const summary = res.grantsSummary ?? "a gift";
    // A grant folded in during boot is part of coming back, so it goes in the
    // welcome dialog rather than firing a toast over the top of a dialog that
    // is about the same thing. captureBootGift returns false once that window
    // has passed (or once the dialog decided not to show), and then this is an
    // ordinary live event and a toast is exactly right.
    if (captureBootGift(summary)) return;
    pushToast({
      kind: "success",
      icon: "🎁",
      text: res.grantsSummary ? `You received ${res.grantsSummary}!` : "You received a gift!",
    });
  };

  // A saveAdoptSeq accepted in memory but NOT yet safe to persist. See
  // commitUploadResult.
  const deferredAdoptSeqRef = useRef<number | null>(null);

  // What to do with an ACCEPTED putSave response. Every upload site goes
  // through this. `uploadedBaseVersion` is the version the accepted request
  // CAS'd against — it has to be passed in rather than re-read, because the
  // whole point of this file is that a version and the bytes it belongs to are
  // one value.
  //
  // Everything below turns on one question: DID THE SERVER STORE BYTES WE DID
  // NOT SEND? If it did not, the cloud at `res.saveVersion` is exactly our own
  // upload and live state trivially incorporates it. If it did — a folded
  // prize, or an adopt seq past what this tab has adopted — the cloud holds
  // something we do not, and every version-advancing side effect has to wait
  // for those bytes to reach live state.
  const commitUploadResult = (
    res: {
      saveVersion: number; saveAdoptSeq?: number;
      grantsApplied?: unknown; grantsSummary?: string;
    },
    uploadedBaseVersion: number,
  ) => {
    const seqBefore = adoptedSeqRef.current;
    const echoed = Array.isArray(res?.grantsApplied) && res.grantsApplied.length > 0;
    // Two independent signals, either of which is enough: an echoed prize
    // list, or an adopt seq past what this tab has adopted (which also catches
    // a bump this tab never accounted for — an admin edit, an auction escrow).
    // A response with no `saveAdoptSeq` at all is a pre-inbox server, which
    // has no fold and therefore never adds bytes on POST.
    const serverWroteBytes =
      echoed || (typeof res.saveAdoptSeq === "number" && res.saveAdoptSeq > seqBefore);

    if (!serverWroteBytes) {
      // The server certified it added nothing: the cloud at `res.saveVersion`
      // is exactly the bytes we sent, which live state (and any snapshot
      // captured while this request was in flight) descends from. That is
      // advanceUploadBase's precondition — see it for why this is the only
      // shape of promotion that is sound, and why it must NOT be relaxed to
      // "promote whenever the CAS succeeded".
      void uploadedBaseVersion;
      advanceUploadBase(res.saveVersion);
      // Stamp the new sync point onto the blob NOW rather than waiting for the
      // next state change. This response only arrives after an await, so React
      // has committed and `stateRef.current` is a superset of the bytes the
      // cloud now holds at `res.saveVersion` — which is exactly the claim the
      // stamp makes. Leaving it to drift is safe (an under-claim only makes
      // the next boot prefer the cloud) but pointless.
      if (stateRef.current.playerPokemon) {
        commitSyncPoint(pickPersistent(stateRef.current), res.saveVersion, null);
      } else {
        recordSyncPoint(res.saveVersion, null);
      }
      return;
    }

    // The server added bytes on top of ours. `cloudVersionRef` stays where it
    // is until the dispatch below reaches live state — see the ref's comment
    // and deferredCloudVersionRef. Note this deliberately does NOT promote
    // `pendingRef`: a snapshot composed before the fold does not contain the
    // prize, so it must keep its stale base version, 409, and adopt.
    deferredCloudVersionRef.current = res.saveVersion;
    // The fold bumped `saveAdoptSeq` in the same write, which is what makes
    // every OTHER session of this account adopt the cloud copy instead of
    // pushing its stale blob over the prize. This session does not need to:
    // it already has the bytes (its own upload) plus the prize (absorbed just
    // below), so re-fetching would only cost it the play since this request.
    //
    // Recorded ONLY when the seq moved by exactly one from what we last
    // adopted, i.e. the bump is provably OUR OWN fold. If anything else bumped
    // it in the same window — an admin edit, an auction settlement — the value
    // jumps by more and we deliberately do NOT record it, so the adopt paths
    // still fire and this client takes the server's copy of that other change.
    // Skipping is the optimisation; adopting is the correct fallback.
    //
    // The in-memory ref moves now (it only suppresses a redundant re-fetch),
    // but the PERSISTED value waits for the blob: until the local save holding
    // the prize is written, claiming "already adopted seq N" would disarm the
    // boot adopt that is the recovery path if this tab dies right here.
    if (echoed && typeof res.saveAdoptSeq === "number"
        && res.saveAdoptSeq === seqBefore + 1) {
      adoptedSeqRef.current = res.saveAdoptSeq;
      deferredAdoptSeqRef.current = res.saveAdoptSeq;
    }
    absorbGrants(res);
  };

  // ── Initial cloud sync ──
  // Reconciliation rules (corrects the v1 timestamp-tiebreak bug that
  // silently regressed cross-device players):
  //
  //   1. Cloud is the source of truth. We trust the server's monotonic
  //      saveVersion over any client-supplied __savedAt, since client
  //      clocks drift between devices.
  //   2. Local can only win if it strictly *adds* progress on top of
  //      what cloud already had. We measure that via milestone counts
  //      (defeatedEliteFour, defeatedGyms, pokedexCaught, championDefeated,
  //      raidLegendary count). If applying local would LOSE any milestone
  //      vs cloud, we discard local and load cloud.
  //   3. On cloud-fetch failure we do NOT enable autosave. The user keeps
  //      seeing their local state, but uploads are blocked until we
  //      can confirm what's in the cloud. Prevents the
  //      "transient-network-blip → overwrite cloud with stale local"
  //      regression class.
  //   4. A failed fetch RETRIES with backoff. It must never be a
  //      permanent give-up: that stranded players with saving disabled
  //      for their whole session.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    let attempt = 0;

    // Exponential backoff, capped at 30s and retrying indefinitely. The
    // player may sit here for a long time on a bad connection or during
    // a deploy; giving up is exactly the failure we are fixing. Local
    // saving is unaffected throughout (see the autosave effect), so the
    // only thing being deferred is the cloud round-trip.
    const scheduleRetry = () => {
      if (cancelled) return;
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      retryTimer = window.setTimeout(() => { void sync(); }, delay);
    };

    const sync = async () => {
      try {
        // ── AWAY-TIME CATCH-UP, AND WHY IT GOES HERE ────────────────────
        // The server measures away time from its own record of this account's
        // last accepted upload. The reconcile below UPLOADS, so the claim has
        // to finish first — otherwise the anchor moves to "now", the gap
        // measures ~0, and the player silently forfeits the night they were
        // away. See state/awayProgress.ts.
        //
        // Started BEFORE getSave and awaited AFTER it: getSave is a pure read
        // and cannot move the anchor, so the two overlap and boot pays one
        // round trip instead of two — while still completing before any
        // putSave. settleAwayProgress never throws, so a failure here can
        // never take the save path down with it.
        const awaySettled = settleAwayProgress();
        const cloud = await api.getSave();
        if (cancelled) return;
        await awaySettled;
        if (cancelled) return;
        const cloudData = cloud.saveData as any;
        const cloudOk = cloudData
          && typeof cloudData === "object"
          && cloudData.playerPokemon
          && typeof cloudData.playerPokemon.speciesKey === "string";
        // The version the cloud is at RIGHT NOW. Deliberately a local const
        // and NOT assigned to `cloudVersionRef` here.
        //
        // It used to be locked into the ref at this point, "before any
        // potential upload". That made the ref mean "the newest version the
        // server mentioned" while live state was still the LOCAL blob — so any
        // upload composed from live state in the next few milliseconds (a
        // `syncNow` fired by an auction bid placed on first paint, the gift
        // nudge) would carry local bytes stamped with a cloud version they
        // have never seen. Each branch below now pairs the version with the
        // state it actually settled on, which is the same discipline
        // pendingRef enforces for the throttled uploader.
        const cloudVersion = cloud.saveVersion ?? 0;

        // The cloud version this browser was synced to at the end of its last
        // session. If the live cloud version is higher, the server made an
        // authoritative write (auction settlement, gift, another device) that
        // local never saw — see cloudShouldWin / saveReconcile.ts. Read off
        // the blob we booted from, so it describes THOSE bytes and not a
        // sibling tab's.
        const persistedSyncVersion = bootSyncRef.current!.version;

        const local = loadSaved();

        // Whose save is sitting in this browser?
        const myId = myIdRef.current;
        const localOwner = readLocalOwner();
        // Unowned = legacy blob from before this check existed. We cannot
        // know whose it is, so we treat it exactly as before and let the
        // reconcile decide. Anything explicitly stamped for someone ELSE is
        // not ours to read, upload, or even display.
        const localIsForeign = localOwner !== null && myId !== null && localOwner !== myId;
        const localOk = !!local.playerPokemon && !localIsForeign;

        if (localIsForeign) {
          // Drop it now so no later code path can read it back. The rightful
          // owner's copy is safe in their own cloud row; this is only a cache.
          try { localStorage.removeItem(SAVE_KEY); } catch { /* */ }
          // The persisted sync version belonged to that other account too —
          // clear it so it can't be compared against this account's cloud.
          clearSyncVersion();
          reportClientError({
            source: "save-foreign-local",
            message: "local save belonged to a different account; discarded before boot reconcile",
          });
        }

        // Server-authoritative adopt. The server bumped saveAdoptSeq past what
        // we last adopted, so this cloud copy holds a deliberate rewrite —
        // an admin edit / restore / item-set, an auction escrow or settlement,
        // or a prize the fold added on top of some session's upload. Adopt it
        // WHOLESALE, bypassing the protective merge, so the server's write
        // sticks instead of being undone by this browser's copy.
        //
        // It is unconditional by design: no milestone veto, no spendable-side
        // heuristic. A prize that reached the cloud must not be able to lose a
        // popularity contest against a stale local blob, because delivery
        // happens exactly once and there is nothing to re-deliver it.
        const forcedAdopt = cloudOk && adoptIfServerRewrote(cloud as any);

        if (forcedAdopt) {
          /* adoptIfServerRewrote did the load, the version and the seq. */
        } else if (!cloudOk) {
          // Empty/garbage cloud row: either a brand-new account, or a
          // returning player whose cloud was somehow wiped. We may ONLY seed
          // this empty cloud from the browser's local save if that save is
          // PROVABLY ours — i.e. it carries our own owner stamp.
          //
          // The old test was merely "not foreign", which treated an UNSTAMPED
          // (legacy / null-owner) blob as adoptable. That is exactly how a new
          // account created in a browser that had just played a different
          // account inherited — and re-uploaded — that account's Pokémon and
          // money: log out of A, sign up B, B's cloud is empty, A's local blob
          // reads "not foreign", B adopts it → dupe. Require a positive match.
          const localOwnedByMe = localOk && myId !== null && localOwner === myId;
          // Admin reset detection (offline case): the server wiped this
          // account's save (saveData null, saveVersion reset to 0). If we last
          // synced to a HIGHER version, the cloud version went BACKWARDS — that
          // only happens on a deliberate reset, never on normal play. Honor it:
          // drop local and start fresh instead of re-uploading and undoing the
          // reset. (Online clients also get a `save:reset` socket event.)
          const cloudWasReset =
            localOwnedByMe &&
            typeof persistedSyncVersion === "number" &&
            cloudVersion < persistedSyncVersion;
          if (cloudWasReset) {
            dispatch({ type: "LOAD_SAVE", payload: { state: pickPersistent(initialState) } });
            try { localStorage.removeItem(SAVE_KEY); } catch { /* */ }
            clearSyncVersion();
            persistedCloudVersionRef.current = null;
            persistedAdoptSeqRef.current = 0;
            adoptedSeqRef.current = 0;
            // A fresh game against a wiped cloud row: live state and the cloud
            // agree, so this version is safe to claim immediately.
            cloudVersionRef.current = cloudVersion;
          } else if (localOwnedByMe) {
            const snapshot = pickPersistent(local);
            try {
              const res = await api.putSave(snapshot, cloudVersion);
              commitUploadResult(res, cloudVersion);
            } catch {
              // Offline. The GET succeeded, so we know what the cloud holds
              // (nothing) and live state is a strict superset of it — safe to
              // claim, and without it this session could never upload at all,
              // because an upload with no version is refused outright.
              cloudVersionRef.current = cloudVersion;
            }
          } else {
            // Not provably ours (foreign OR unstamped OR unknown-me). The
            // reducer was seeded from localStorage at init, so it may be
            // showing someone else's save — reset it to a fresh game and drop
            // the cache so nothing can read or upload it.
            dispatch({ type: "LOAD_SAVE", payload: { state: pickPersistent(initialState) } });
            try { localStorage.removeItem(SAVE_KEY); } catch { /* */ }
            clearSyncVersion();
            persistedCloudVersionRef.current = null;
            persistedAdoptSeqRef.current = 0;
            adoptedSeqRef.current = 0;
            cloudVersionRef.current = cloudVersion;
          }
        } else if (cloudShouldWin({
          localUsable: localOk,
          cloudData,
          cloudSaveVersion: cloud.saveVersion,
          local,
          persistedSyncVersion,
        })) {
          // Cloud wins — but HOW depends on whether we have a real local save
          // to protect.
          //
          //  * No usable local (fresh tab / cleared storage / foreign blob):
          //    adopt cloud wholesale — there's nothing local to lose.
          //  * Usable local: the server advanced our save (auction / another
          //    device) but we may also hold progress it never saw. MERGE —
          //    which now means "keep the whole spendable set from whichever
          //    lineage holds more play, and union the monotonic milestones
          //    from both", NOT the old per-field max. Resolving money by max
          //    while keeping the goods the other side bought refunded the
          //    purchase; see mergeCloudAdvance in saveReconcile.
          //
          // Both branches go through stateFromCloud, which materialises the
          // WHOLE spendable set from the blob it is given and re-anchors the
          // active mon. That matters just as much on the no-local branch: the
          // reducer merges LOAD_SAVE into live state, so handing it a raw
          // cloud blob that omits `inventory` would keep the items this
          // session already had next to the cloud's money — the same mix the
          // merge exists to prevent.
          const base: any = localOk ? mergeCloudAdvance(local, cloudData) : cloudData;
          const nextState = stateFromCloud(base);
          const snapshot = pickPersistent(nextState);
          dispatch({ type: "LOAD_SAVE", payload: { state: nextState } });
          // ── SAY WHAT THE MERGE COST ──────────────────────────────────
          // The merge keeps one lineage's Pokémon and unions both lineages'
          // dex entries, so a Pokémon caught on the losing side leaves its
          // Pokédex entry behind and takes the Pokémon with it. That is the
          // design (see saveReconcile — every alternative duplicates), but
          // until now it happened in silence, and a player who finds a shiny
          // in their dex with nothing in their PC has no way to read that as
          // anything but the game losing their Pokémon. It is what the
          // "shiny Scyther in my dex but not my PC" report actually was.
          //
          // The log line is the durable half — toasts self-dismiss in 2.5s,
          // which is not long enough for news like this.
          if (localOk) {
            const notice = lostMonsMessage(lineageCasualties(local, cloudData));
            if (notice) {
              dispatch({ type: "ADD_LOG", payload: { text: notice } });
              pushToast({ kind: "warn", icon: "☁️", text: notice });
            }
          }
          // The bytes we are switching to, written WITH the sync point that
          // describes them, in one setItem — before the upload, and without
          // waiting for React to commit. If the tab dies anywhere after this
          // line, the next boot reads a blob and a sync point that agree.
          lastUploadedRef.current = JSON.stringify(snapshot);
          commitSyncPoint(snapshot, cloudVersion, null);
          if (localOk) {
            // The merged result differs from cloud (it carries our local
            // progress), so push it back up so cloud reflects the merge.
            // CAS on the version we just read; a concurrent write 409s and
            // the next boot reconciles again.
            try {
              const res = await api.putSave(snapshot, cloudVersion);
              // The uploaded bytes ARE the state we just dispatched, so the
              // version this returns is one live state incorporates.
              commitUploadResult(res, cloudVersion);
            } catch {
              deferredCloudVersionRef.current = cloudVersion;
            }
          } else {
            // Wholesale cloud adoption. The version waits for the dispatch to
            // land — live state is still the pre-adopt blob until it does.
            deferredCloudVersionRef.current = cloudVersion;
          }
        } else {
          // Local strictly extends cloud (more milestones / equal +
          // local-only changes). Push local up with the cloud version
          // as expectedSaveVersion so a concurrent write from another
          // device can still 409 us and prevent a clobber.
          const snapshot = pickPersistent(local);
          try {
            const res = await api.putSave(snapshot, cloudVersion);
            commitUploadResult(res, cloudVersion);
          } catch (err: any) {
            // 409 means another device wrote in between — re-pull cloud and
            // load it rather than retrying our stale view. Wholesale, through
            // stateFromCloud: the reducer merges LOAD_SAVE into live state, so
            // a raw spread would leave this session's own money or items
            // sitting next to the cloud's, which is how a lineage mix (and a
            // refund) gets created.
            if (err?.status === 409) {
              try {
                const fresh = await api.getSave();
                // Record the seq if the server had also authoritatively
                // rewritten this save: we are taking that exact copy, so the
                // adopt is genuinely done.
                const seq = typeof fresh.saveAdoptSeq === "number" ? fresh.saveAdoptSeq : 0;
                const freshVersion = fresh.saveVersion ?? cloudVersion;
                const fd = fresh.saveData as Partial<GameState> | null;
                if (fd && (fd as any).playerPokemon) {
                  const adopted = stateFromCloud(fd);
                  const adoptedSnapshot = pickPersistent(adopted);
                  dispatch({ type: "LOAD_SAVE", payload: { state: adopted } });
                  lastUploadedRef.current = JSON.stringify(adoptedSnapshot);
                  if (seq > adoptedSeqRef.current) adoptedSeqRef.current = seq;
                  // Blob and bookkeeping in one write, same as every other
                  // adopt path. The seq used to be persisted here while the
                  // ADOPTED BYTES waited on the local-save effect.
                  commitSyncPoint(adoptedSnapshot, freshVersion, seq > 0 ? seq : null);
                  deferredCloudVersionRef.current = freshVersion;
                } else {
                  // Nothing to adopt — the cloud row is empty. Live state is
                  // unchanged, so this version is safe to claim now.
                  cloudVersionRef.current = freshVersion;
                }
              } catch { /* */ }
            }
            // else: silent retry on next autosave cycle.
          }
        }

        cloudReadyRef.current = true;
      } catch {
        // A cloud fetch failure must NOT let the uploader push possibly
        // stale local state over a good cloud save, so cloudReadyRef
        // stays false and the CLOUD upload stays disabled.
        //
        // But it must also not be permanent. The first version of this
        // just gave up here — and claimed in a comment that it would
        // "retry on next mount", which was false: this effect has []
        // deps and runs exactly once. So a single blip (a timeout, a
        // deploy restarting, a flaky phone connection) disabled saving
        // for the WHOLE session, and because the localStorage write
        // lived behind the same gate, it killed local saving too.
        // Players reported "every time i come it goes back to the
        // start". That was this.
        //
        // Retry with backoff instead. The player keeps playing on local
        // state the entire time, and the moment the server answers we
        // reconcile properly and re-enable cloud saves.
        setSaveStatus("error");
        if (!cancelled) scheduleRetry();
      }
    };

    void sync();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirrors `state` for callbacks that outlive a render (the unload flush).
  const stateRef = useRef(state);
  stateRef.current = state;

  // The single cloud writer. Everything that uploads goes through here.
  const flushCloud = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (permanentlyRejectedRef.current) return;
    // Backing off after a rate-guard refusal. Deliberately does NOT clear
    // `pendingRef` — these bytes stay queued and go up on the first tick past
    // the window, by which point the elapsed-time allowance has grown.
    if (Date.now() < gainBackoffUntilRef.current) return;
    // Never synced this session, so we have no idea what the cloud holds.
    // Uploading anyway would mean sending no `expectedSaveVersion`, and the
    // server's compare-and-swap then degrades to `where: { id }` — an
    // unconditional write that cannot miss and would happily overwrite a save
    // this client has never read. LEAVE it pending: the boot reconcile learns
    // a real version within a round trip and the next capture supersedes this
    // one. (`syncNow` is best-effort by contract, and the server re-validates
    // auctions and bids authoritatively anyway, so nothing depends on this
    // upload happening.)
    if (pending.baseVersion < 0) return;
    pendingRef.current = null;

    // Optimistic: blocks a duplicate in-flight write of the same bytes.
    // Cleared again on any failure so the next tick retries.
    lastUploadedRef.current = pending.serialized;
    uploadInFlightRef.current = true;
    setSaveStatus("saving");
    try {
      // THE BOUND VERSION — the one captured with these exact bytes, never
      // `cloudVersionRef.current` as it stands at this instant. That
      // substitution is what let a snapshot composed before an adopt / a fold
      // / a sibling's write be uploaded with a version learned after it, pass
      // the CAS, and erase a prize.
      const res = await api.putSave(pending.snapshot, pending.baseVersion);
      // Advances the version, and — if the server folded prizes it owed us
      // into this very upload — takes them into live state and holds the
      // persisted sync point back until they are durable. See
      // commitUploadResult.
      commitUploadResult(res, pending.baseVersion);
      setSaveStatus("saved");
      setLastSavedAt(Date.now());
      lastSavedAtRef.current = Date.now();
      void refreshProfile();
    } catch (err: any) {
      lastUploadedRef.current = "";
      const status: number | undefined = err?.status;

      if (status === 409) {
        // The cloud moved under us — another device wrote. We do NOT adopt
        // cloud here any more. The old code pulled cloud, dispatched
        // LOAD_SAVE over the live session, and then called
        // setSaveStatus("saved") at the exact instant the write had been
        // REJECTED and this session's progress discarded. api.ts's own
        // docstring says a 409 must "surface a conflict — never silently
        // overwrite". Report it and stop; the player keeps playing on local
        // state, which is written unconditionally and loses nothing.
        setSaveStatus("conflict");
        // BOTH 409 bodies now carry `serverSaveAdoptSeq` alongside
        // `serverSaveVersion` — the invariant "a client cannot learn the new
        // version without seeing the adopt seq that came with it" is finally
        // true in the wire format and not only in the design doc. We use it
        // for exactly one thing here, and it must never grow into a second:
        // TELLING THE TWO KINDS OF 409 APART. A seq past what this tab adopted
        // means the SERVER rewrote the save (a folded prize, an admin edit, an
        // auction escrow) — routine, self-healing, and not worth an error row.
        // Anything else is a genuine second device, which is worth one.
        //
        // The version in that body is deliberately NOT used. Learning a
        // version from a rejection is precisely how stale bytes acquire a
        // fresh version, and `pendingRef` is bound to its own base anyway.
        const bodySeq = typeof err?.details?.serverSaveAdoptSeq === "number"
          ? (err.details.serverSaveAdoptSeq as number)
          : null;
        const authoritative = bodySeq !== null && bodySeq > adoptedSeqRef.current;
        if (!authoritative) {
          // Keep `message` a fixed type-string — it's the (kind, message) group
          // key server-side. localVersion differs on nearly every occurrence,
          // so embedding it here used to fragment one conflict type into a
          // separate dashboard group per version number.
          reportClientError({
            source: "save-conflict",
            message: "putSave 409 — another device wrote",
            meta: { localVersion: cloudVersionRef.current },
          });
        }
        // Re-read the cloud's VERSION only — not its data. A plain version
        // mismatch then resolves on the next attempt, while the player's
        // actual progress stays untouched by a device they are not using.
        //
        // DO NOT merge cloud data into live state here. A per-field max — the
        // shape this used to have, and the shape anyone "fixing" a 409 reaches
        // for — is a duplication exploit on this path: a 409 means a SECOND
        // SESSION wrote, so "cloud" is a sibling tab's branch that simply
        // lacks whatever this session has spent. Spend 900k in tab A, let a
        // minute-old tab B upload, and A's next 409 restores the 900k by max()
        // while a box union keeps everything the money bought. It repeats on
        // every conflict — and conflicts recur every couple of seconds for as
        // long as two sessions are live. The same mechanism refunds every
        // consumed Poké Ball and potion. A three-way diff against the last
        // snapshot the server accepted does not rescue it either: it cannot
        // tell a server credit from a stale sibling's write, so the same two
        // tabs produce the same refund.
        //
        // Nor should mergeCloudAdvance be reused here now that it picks one
        // lineage's spendable set wholesale. It is the right call ONCE at boot,
        // where the two sides forked from a known common ancestor; mid-session
        // it would swap the live session's wallet and team out from under the
        // player every couple of seconds.
        //
        // ── BUT A WHOLESALE ADOPT IS NOT A MERGE, AND THIS IS WHERE IT
        //    HAS TO HAPPEN ──
        // This is the exact moment a prize gets destroyed. A sibling session
        // won the version CAS and the server folded a grant into ITS upload;
        // we 409'd. If all we did here was learn the new version, our very
        // next upload would carry these stale bytes, pass the CAS, and erase
        // the prize from the cloud — and delivery happens once, so nothing
        // would ever bring it back. That is the original incident.
        //
        // So the version is not learned in isolation. The same response
        // carries `saveAdoptSeq`, which the server bumped in the same database
        // update as the version. If it has moved past what this tab adopted,
        // the cloud copy is authoritative and we take it WHOLESALE — no
        // per-field max, no union, nothing from local survives. That can only
        // ever discard this session's unsynced play; it cannot mint or
        // duplicate anything, because the result is exactly the server's copy.
        //
        // Ordering is load-bearing: `adoptIfServerRewrote` sets the version
        // itself, and on a failed fetch we set NOTHING. A tab that cannot read
        // therefore keeps 409ing instead of pushing stale bytes — it is
        // structurally unable to advance its expected version without seeing
        // the adopt seq that goes with it.
        try {
          const fresh = await api.getSave();
          if (adoptIfServerRewrote(fresh)) {
            // Not a conflict the player has to resolve — the server rewrote
            // the save and we took its copy. An upload of the adopted bytes
            // follows on the next state change.
            setSaveStatus("pending");
          } else {
            // Ordinary conflict — another device simply uploaded. Learn the
            // version and keep playing on local state, which is written
            // unconditionally and loses nothing.
            //
            // `adoptIfServerRewrote` returning false IS advanceUploadBase's
            // precondition: the cloud holds no authoritative rewrite this
            // session has not incorporated, so everything between our version
            // and this one was a plain client upload. Without promoting the
            // snapshot captured during this round trip, a client whose state
            // then stops changing would 409 forever against a version it has
            // already learned.
            if (typeof fresh.saveVersion === "number") advanceUploadBase(fresh.saveVersion);
          }
        } catch { /* transient; the next change retries */ }
        return;
      }

      // RATE-GUARD REFUSAL — a 400, but not a contract violation. See
      // gainBackoffUntilRef above: the server's allowance scales with time
      // since the last accepted save, so this exact blob becomes acceptable
      // on its own. Retry on a backoff rather than latching off for good.
      //
      // Checked BEFORE the permanent branch because it is a strict subset of
      // it — status 400 — and the wrong one wins if the order is reversed.
      if (status === 400 && err?.details?.error === "gain_implausible") {
        gainBackoffUntilRef.current = Date.now() + GAIN_RETRY_BACKOFF_MS;
        // "conflict", not "rejected": the player IS still backed up, just not
        // this second. "rejected" says "not backing up" and latches an alarm
        // for a condition that clears itself in a few minutes.
        setSaveStatus("conflict");
        reportClientError({
          source: "save-gain-refused",
          message: "putSave 400 — rate guard refused, backing off",
          meta: {
            reason: err?.details?.reason ?? null,
            violationCount: err?.details?.violationCount ?? null,
            backoffMs: GAIN_RETRY_BACKOFF_MS,
          },
        });
        return;
      }

      // Permanent vs transient. A 413/403, or a 400 that is a genuine
      // contract violation (a save shape this server will never accept),
      // means retrying is pure noise and "Offline" is an outright lie that
      // sends the player to check a router that is working fine.
      if (status === 400 || status === 413 || status === 403) {
        permanentlyRejectedRef.current = err?.message ?? `HTTP ${status}`;
        setSaveStatus("rejected");
        // The team finds out, not the player. Until now the only way anyone
        // learned saves were failing was a player typing "its possible to
        // save your progress ????" into global chat.
        reportClientError({
          source: "save-rejected",
          // Fixed type-string only — status is bounded to {400,413,403} so
          // it's safe to keep in the group key, but err.message is NOT
          // bounded (whatever text the server/fetch layer produced) and
          // used to be concatenated straight into message, fragmenting
          // this group the same way the 409 case above did.
          message: `putSave ${status}: rejected`,
          // err.details is the full response body (api.ts's request() stores
          // it verbatim on ApiError) — saves.ts's 400 response carries the
          // actual validation failure as `reason` (e.g. "party > 6"), which
          // `err.message` alone never surfaces since it just resolves to the
          // generic "save rejected" string.
          meta: {
            status, code: err?.code ?? null, reason: err?.details?.reason ?? null,
            serverMessage: err?.message ?? null,
          },
        });
        return;
      }

      // Everything else (429/500/502/network/DNS/CORS) is transient and
      // self-heals on the next state change, which an idle game produces
      // constantly.
      setSaveStatus("error");
    } finally {
      uploadInFlightRef.current = false;
      // A nudge landed while this request was in flight. It may have arrived
      // after the server took its snapshot of what we are owed, so that grant
      // could still be sitting in the inbox. Collect it now rather than
      // waiting for the next state change — which, on a paused or idle tab,
      // may never come.
      if (grantNudgeRef.current) {
        grantNudgeRef.current = false;
        // setTimeout, not a direct call: syncNow re-enters flushCloud, and
        // doing that from inside this finally would run it while the current
        // invocation is still unwinding.
        window.setTimeout(() => { void syncNowRef.current(true); }, 0);
      }
    }
  }, [refreshProfile]);

  // Force an immediate cloud flush of the CURRENT state and resolve when it
  // settles. Callers use this before a server action that validates against
  // the last-uploaded save — an auction bid checks the bidder's money and a
  // listing checks Pokémon ownership against cloud saveData, so between
  // autosave ticks the server can see stale numbers and wrongly reject a
  // player who actually has the money / the mon (the "no funds despite 67M"
  // report). Best-effort: on 409/offline it still resolves and the caller
  // proceeds; the server re-validates authoritatively anyway.
  //
  // `force` skips the "nothing changed since the last upload" short-circuit.
  // Needed by the `gift:pending` nudge: the server is holding a prize for us
  // and the only way to collect it is to upload something for it to be folded
  // into, even if our state is byte-identical to the last push.
  const syncNow = useCallback(async (force = false): Promise<void> => {
    try {
      const snapshot = pickPersistent(stateRef.current);
      const serialized = JSON.stringify(snapshot);
      if (force || serialized !== lastUploadedRef.current) {
        capturePending(snapshot, serialized);
      }
      await flushCloud();
    } catch { /* best effort — never block the caller on a sync failure */ }
  }, [flushCloud]);
  // Lets the socket effect (which mounts once, with [] deps) reach the CURRENT
  // syncNow rather than the one captured on first render.
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;

  // ── Local save (ALWAYS, unconditionally) ──
  // Writing localStorage is local-only. It cannot clobber the cloud, it
  // cannot lose anyone else's data, and it is the player's safety net when
  // the network is gone. So it is gated on nothing at all.
  //
  // There used to be a `phase !== "idle" && phase !== "victory"` gate here.
  // It meant nothing was written during a battle — and in an idle game the
  // battle IS the game. The Elite Four gauntlet chains five boss fights
  // without ever passing through idle, so a player could clear it and have
  // written literally nothing, anywhere, for minutes.
  //
  // The gate was also redundant: PERSISTENT_KEYS contains no battle
  // transients (no phase, enemyPokemon, bossBattle, healingState,
  // evolutionState), so pickPersistent CANNOT capture mid-battle state. The
  // snapshot is coherent by construction whatever the phase, and the load
  // path forces phase back to "idle" anyway.
  //
  // Cost of doing this every single state change, measured against the
  // largest of all 1679 real saves (129 KB): 0.33ms to serialize, versus a
  // 200ms battle tick at max speed. It is 0.17% of a tick. There is no
  // performance reason to skip a single save.
  useEffect(() => {
    if (!state.playerPokemon) return;
    // PROMOTE FIRST, THEN WRITE — and the write is a single setItem carrying
    // both the bytes and the bookkeeping.
    //
    // This used to be the other way round (write the blob, then write the
    // version key) because they were two separate localStorage keys and the
    // blob had to land first: recording "synced to version N" before the state
    // holding N's prize was durable would disarm the boot adopt that is the
    // only recovery left if this tab then dies. That ordering rule is gone,
    // not weakened — there is nothing left to order. One key, one write, and
    // the crash window it guarded closes with it.
    //
    // The dispatches that set these deferred values (RECEIVE_GIFT, LOAD_SAVE,
    // AUCTION_SETTLED) all return a fresh state object, so this effect is
    // guaranteed to run on the commit that carries their bytes.
    const deferredVersion = deferredCloudVersionRef.current;
    if (deferredVersion !== null) {
      deferredCloudVersionRef.current = null;
      // Live state now holds the bytes, so the UPLOAD base may finally move.
      cloudVersionRef.current = deferredVersion;
      recordSyncPoint(deferredVersion, null);
    }
    const deferredSeq = deferredAdoptSeqRef.current;
    if (deferredSeq !== null) {
      deferredAdoptSeqRef.current = null;
      recordSyncPoint(null, deferredSeq);
    }
    writeLocalSave(
      pickPersistent(state), myIdRef.current,
      persistedCloudVersionRef.current, persistedAdoptSeqRef.current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ── Cloud upload (throttled) ──
  // Gated on cloudReadyRef ONLY: pushing before we know what the cloud
  // holds risks overwriting a good save with stale local state. That gate
  // defers the cloud write and nothing else.
  //
  // THIS IS A THROTTLE, NOT A DEBOUNCE, AND THAT IS THE WHOLE POINT.
  //
  // A debounce waits for changes to STOP. An idle game's state never stops
  // changing, so the wait never ends. Worse, the old implementation cleared
  // its pending timer from the effect cleanup, which React runs on every
  // dependency change — so each change destroyed the timer the previous
  // change had armed. Measured: 37 resets, 0 saves, in 30 seconds.
  //
  // Patching that with a max-wait escape hatch (which I did) treated the
  // symptom: the max-wait lived below the phase gate, so it was void during
  // exactly the battles that caused the churn. The comment I wrote claiming
  // "a dep churning at any rate can delay a save by at most 10s" was false.
  //
  // A throttle has no such failure mode. The first change arms a timer; the
  // timer is NEVER cleared, so it always fires; subsequent changes just
  // update what it will send. Latency is bounded at CLOUD_THROTTLE_MS by
  // construction, for any change rate, with no escape hatch to get wrong.
  useEffect(() => {
    if (!cloudReadyRef.current) return;
    if (!state.playerPokemon) return;

    const snapshot = pickPersistent(state);
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastUploadedRef.current) return;
    // A save the server has already refused by contract will be refused
    // again. Retrying it forever burns a 30/min rate limit and shows the
    // player "Offline" while their wifi is demonstrably fine.
    if (permanentlyRejectedRef.current) return;

    // Bytes AND the version they were composed against, captured together.
    // The local-save effect above runs first (it is declared first, and React
    // runs passive effects in declaration order), so if this commit carried a
    // deferred version it has already been promoted and this capture is bound
    // to it rather than to the one it superseded.
    capturePending(snapshot, serialized);
    if (uploadTimerRef.current !== undefined) return;   // already armed — never re-arm, never clear
    setSaveStatus("pending");
    uploadTimerRef.current = window.setTimeout(() => {
      uploadTimerRef.current = undefined;
      void flushCloud();
    }, CLOUD_THROTTLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ── Flush on the way out ──
  // React unmount cleanup does NOT run when a tab closes, so the pending
  // throttle window dies with the page. pagehide covers close/navigate/
  // bfcache; visibilitychange covers mobile backgrounding, which on iOS is
  // frequently the last callback a page ever gets.
  //
  // The localStorage write is the load-bearing half: synchronous, and it
  // cannot fail to run. The cloud beacon is best-effort — keepalive fetch
  // caps the body at 64KB and our p99 save is 70KB, so the largest saves
  // will not fit. That is acceptable precisely BECAUSE localStorage is
  // written unconditionally above: the device always holds the newest copy,
  // and the boot sync reconciles it on the next visit.
  useEffect(() => {
    const flush = () => {
      const st = stateRef.current;
      if (!st.playerPokemon) return;
      const snapshot = pickPersistent(st);
      // Stamped with the PERSISTED (already-safe) bookkeeping, never with a
      // deferred value. `stateRef.current` may predate a dispatch that has not
      // committed yet — a prize absorbed microseconds ago, an adopt in flight
      // — and stamping the version that describes THOSE bytes onto a blob that
      // does not contain them is exactly how the recovery path gets disarmed.
      // Under-claiming here is free: the next boot simply sees the server
      // ahead and takes the cloud copy.
      writeLocalSave(
        snapshot, myIdRef.current,
        persistedCloudVersionRef.current, persistedAdoptSeqRef.current,
      );
      if (!cloudReadyRef.current) return;
      if (permanentlyRejectedRef.current) return;
      if (JSON.stringify(snapshot) === lastUploadedRef.current) return;
      // Same rule as flushCloud: with no version the server's CAS degrades to
      // an unconditional write. localStorage above already holds these bytes.
      if (cloudVersionRef.current < 0) return;
      // flushCloud is already mid-request against the same cloudVersionRef.
      // Firing a second write now would race it for that version — the
      // loser gets a spurious 409 "another device wrote" even though it's
      // this same device (root cause of the vast majority of that error
      // group). localStorage above already has the newest data either way;
      // let the in-flight request finish and update cloudVersionRef itself.
      if (uploadInFlightRef.current) return;
      // `cloudVersionRef` is the version LIVE STATE incorporates, and
      // `snapshot` is live state, so these two are a matched pair by
      // construction — the same binding the throttled uploader gets from
      // pendingRef, obtained here without a capture because there is no delay
      // between composing and sending.
      api.putSaveBeacon(snapshot, cloudVersionRef.current);
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  // Auction settlements (server/src/lib/auctionSettlement.ts) can land
  // while this client is open, whether or not this session placed the
  // winning bid or made the sale. Bound directly here rather than in
  // state/auctions.ts because reconciling needs dispatch AND the private
  // cloudVersionRef — the server just wrote a new saveVersion for this
  // account, and without adopting it here the NEXT autosave would 409
  // against the settlement it just applied (comparing against a version
  // this client never knew about).
  useEffect(() => {
    const sock = getSocket();
    const onSold = (payload: {
      auctionId: string; pokemon: any; amount: number; buyerUsername: string;
    }) => {
      // NO version defer and NO money here, unlike the buyer below. Selling no
      // longer rewrites the seller's save at all — the proceeds are a
      // PendingGrant that folds in on the next save round-trip — so there is no
      // new cloud version to defer to and no authoritative total to adopt.
      // Taking one would re-introduce the bug this shape exists to remove.
      const label = payload.pokemon?.nickname ?? payload.pokemon?.name ?? "Pokémon";
      dispatch({
        type: "AUCTION_SETTLED",
        payload: {
          role: "seller",
          removedPokemonId: payload.pokemon?.id,
          logMessage: `Sold your ${label} to ${payload.buyerUsername} for $${payload.amount}!`,
        },
      });
      pushAuctionNotification("sold", payload.auctionId, `Sold to ${payload.buyerUsername} for $${payload.amount}!`);
    };
    const onWon = (payload: {
      auctionId: string; pokemon: Pokemon; amount: number; sellerUsername: string;
      newSaveVersion: number; newMoney: number;
    }) => {
      // Deferred — see onSold.
      deferredCloudVersionRef.current = payload.newSaveVersion;
      const label = payload.pokemon?.nickname ?? payload.pokemon?.name ?? "a Pokémon";
      dispatch({
        type: "AUCTION_SETTLED",
        payload: {
          role: "buyer",
          pokemon: payload.pokemon,
          money: payload.newMoney,
          logMessage: `Won the auction for ${label}!`,
        },
      });
      pushAuctionNotification("won", payload.auctionId, `You won ${label} for $${payload.amount}!`);
    };
    // The server is holding a prize for us (giveaway win / admin gift). It is
    // already durable in the PendingGrant inbox and will be folded into our
    // next upload whether or not this event ever arrives — so this handler is
    // purely a latency optimisation: push now, collect now, instead of waiting
    // out the autosave throttle.
    //
    // It deliberately does NOT apply anything itself. Applying prizes locally
    // AND leaving them owed server-side would double them the moment the fold
    // lands. Exactly one component applies a prize: the server, on the upload
    // it folded it into, echoed back through absorbGrants.
    const onGiftPending = (payload: { grantId?: string; summary?: string }) => {
      if (!cloudReadyRef.current) return;   // boot reconcile will upload anyway
      // Do not race an upload that is already on the wire: it carries the same
      // cloudVersionRef, so a second POST would earn a self-inflicted 409 and
      // churn live state for nothing.
      //
      // But do not assume it collects this grant either. The server reads what
      // an account is owed OUTSIDE the save transaction, so a row that commits
      // after that read — which is exactly what just happened, since the nudge
      // is emitted right after the INSERT while the POST is still running — is
      // invisible to the request in flight. Dropping the nudge here left the
      // prize waiting on the next PERSISTENT state change, and a paused or
      // idle tab produces none: `paused` is not a persisted field, so a paused
      // game uploads nothing, indefinitely.
      //
      // So defer it. One boolean, cleared before it re-fires, bounds this to a
      // single extra upload per burst however many grants arrive at once.
      if (uploadInFlightRef.current) { grantNudgeRef.current = true; return; }
      void payload;
      void syncNowRef.current(true);
    };
    // LEGACY, and kept ONLY for the minutes a rolling deploy takes.
    //
    // An OLD server instance still runs the pre-inbox grant path: it writes
    // the prize straight into cloud saveData and bumps saveVersion, with no
    // PendingGrant row, no receipt and no coordination with this client. It
    // then emits this event. The current build emits `gift:pending` instead
    // and writes no save at all, so the two can never both fire for one grant.
    //
    // Removing this handler was the tempting option and it is the wrong one.
    // Ignoring the event does not make the prize safe — it makes it die: the
    // old server's write is invisible to us, our next upload 409s, we re-read
    // the version only, and the upload after that overwrites the prize with a
    // blob that never had it. That is the original bug, and the inbox cannot
    // heal it because there is no row and no receipt to heal from. Applying it
    // here is what puts the prize into the blob we are about to upload.
    //
    // It carries no `assignedId` — there is no grant id on this path — so the
    // reducer mints a local `gift<n>` id for a prize mon (mandatory: `mon.id`
    // here is the admin client's template id, identical for every recipient).
    // That means our copy and the cloud's copy of the same mon sit under
    // different ids. What used to turn that into a DUPLICATE was the boot
    // merge unioning the two boxes; the merge no longer unions spendable state
    // at all — party, box, money and inventory come from one side or the
    // other, whole — so whichever side wins, the player ends up with exactly
    // one.
    //
    // Ignored if the payload looks like the new protocol (a grantId), so this
    // path can never double-apply something the fold is also going to deliver.
    const onGift = (payload: { prizes?: unknown; summary?: string; grantId?: unknown }) => {
      if (typeof payload?.grantId === "string") return;
      const prizes = Array.isArray(payload?.prizes) ? payload.prizes : null;
      if (!prizes || prizes.length === 0) return;
      dispatch({ type: "RECEIVE_GIFT", payload: { prizes: prizes as any } });
      // Tell us an old instance is still serving. This should stop appearing
      // within minutes of a deploy; if it does not, a stale process is still
      // handing out prizes through a path with no delivery guarantee.
      reportClientError({
        source: "gift-legacy-socket",
        message: "gift:received from a pre-inbox server instance",
      });
      // Get it into the cloud before the throttle window would: the old server
      // already bumped saveVersion, so our first attempt 409s, re-reads the
      // version, and the retry carries the prize. Until that lands the prize
      // exists only in this tab.
      window.setTimeout(() => { void syncNowRef.current(true); }, 0);
    };
    // Admin wiped this account's save. The whole reason a reset "doesn't
    // stick" is that this client would otherwise re-upload its intact local
    // copy and undo it — so clear the local cache and hard-reload into a fresh
    // game. On boot the empty cloud + no local yields a clean initialState.
    const onSaveReset = () => {
      try {
        for (const k of Object.keys(localStorage)) {
          if (k === "pokemon-idle-save" || k.startsWith("pokemon-idle-save")) localStorage.removeItem(k);
        }
      } catch { /* private mode */ }
      if (typeof window !== "undefined") window.location.reload();
    };
    // The server authoritatively rewrote our save: an admin edit / restore /
    // item-set, an auction escrow or settlement, or a prize fold. Fetch it and
    // adopt WHOLESALE so the change sticks instead of being undone by our own
    // copy on the next autosave.
    //
    // Gated on the seq inside adoptIfServerRewrote, which is what lets the
    // session that CAUSED the bump skip its own adopt: it already applied the
    // echo and recorded the seq, so re-loading the cloud copy would cost it
    // nothing but the play since its upload. Every other session sees a seq it
    // cannot account for and adopts — and that is the one that matters, since
    // it is the one holding the stale blob.
    //
    // The gate is an in-memory ref, NOT localStorage, precisely because two
    // tabs of one account share localStorage: reading it back here would let
    // the uploading tab's write disarm the sibling that still has to adopt.
    const onSaveAdopt = async () => {
      try {
        const fresh = await api.getSave();
        if (!adoptIfServerRewrote(fresh)) return;
        pushToast({ kind: "info", icon: "🛠️", text: "Your save was updated." });
      } catch { /* transient; the boot check and the next 409 both re-try */ }
    };
    // Remote control from the admin dashboard (stream/OBS accounts only).
    // Drives the same game flows the UI uses — travel, fight the Elite Four,
    // start a raid, toggle auto-play settings.
    const onStreamCommand = (cmd: any) => {
      if (!isStreamMode()) return; // only stream sessions obey remote commands
      try {
        const res = executeStreamCommand(cmd, stateRef.current, dispatch);
        pushToast({
          kind: res.ok ? "info" : "warn",
          icon: res.ok ? "🎮" : "⚠️",
          text: `Stream: ${res.message}`,
        });
        // Echo the outcome back so the admin dashboard can show WHY a command
        // was refused — a rejected command used to look identical to a
        // successful one from the operator's side.
        sock.emit("stream:command:result", { kind: cmd?.kind, ok: res.ok, message: res.message });
      } catch { /* malformed command — ignore */ }
    };
    sock.on("auction:sold", onSold);
    sock.on("auction:won", onWon);
    sock.on("gift:pending", onGiftPending);
    sock.on("gift:received", onGift);
    sock.on("save:reset", onSaveReset);
    sock.on("save:adopt", onSaveAdopt);
    sock.on("stream:command", onStreamCommand);
    return () => {
      sock.off("auction:sold", onSold);
      sock.off("auction:won", onWon);
      sock.off("gift:pending", onGiftPending);
      sock.off("gift:received", onGift);
      sock.off("save:reset", onSaveReset);
      sock.off("save:adopt", onSaveAdopt);
      sock.off("stream:command", onStreamCommand);
    };
  }, []);

  // ── Recent battles cache (client-side) ──
  // Record one entry whenever phase transitions FROM a battle state TO
  // idle / victory. Captures the last seen enemy + trainer + location
  // + lead mon for the trainer card's "Recent Battles" feed. Lives in
  // localStorage via utils/battleHistory.ts so it survives reloads
  // without bloating saveData.
  const prevPhaseRef = useRef<typeof state.phase>(state.phase);
  const lastEnemyRef = useRef<typeof state.enemyPokemon>(null);
  useEffect(() => {
    if (state.enemyPokemon) lastEnemyRef.current = state.enemyPokemon;
    const prev = prevPhaseRef.current;
    const cur = state.phase;
    const wasBattle =
      prev === "battle" || prev === "trainerBattle" || prev === "bossBattle" || prev === "raid";
    const isResolved = cur === "idle" || cur === "victory";
    if (wasBattle && isResolved && lastEnemyRef.current) {
      const enemy = lastEnemyRef.current;
      const here = state.currentLocation;
      const route = routes[here];
      const trainer =
        prev === "trainerBattle" ? state.trainerBattle?.trainerName
        : prev === "bossBattle"    ? state.bossBattle?.trainerName
        : undefined;
      const player = state.playerPokemon;
      recordBattle({
        at: Date.now(),
        type: prev === "raid" ? "raid" : prev === "bossBattle" ? "boss" : prev === "trainerBattle" ? "trainer" : "wild",
        enemyName: enemy.name,
        enemyLevel: enemy.level,
        enemySpeciesKey: enemy.speciesKey,
        locationKey: here,
        locationName: route?.name ?? here,
        trainerName: trainer,
        playerLeadName: player?.name,
        playerLeadLevel: player?.level,
        playerLeadSpeciesKey: player?.speciesKey,
      });
      lastEnemyRef.current = null;
    }
    prevPhaseRef.current = cur;
  }, [state.phase, state.enemyPokemon, state.currentLocation, state.trainerBattle, state.bossBattle, state.playerPokemon]);

  return (
    <GameContext.Provider
      value={{
        state,
        dispatch: dispatch as Dispatch,
        saveStatus,
        lastSavedAt,
        syncNow,
      }}
    >
      {children}
    </GameContext.Provider>
  );
}

// Snapshot timestamp lives on the persisted blob (not on GameState), so
// we can decide between cloud and local on the next boot without touching
// the reducer or the type. See the cloud-sync useEffect for how it's used.
const SNAPSHOT_TS_KEY = "__savedAt";

// The canonical progress snapshot, and the basis for every "has anything
// actually changed?" comparison.
//
// This used to stamp `out[SNAPSHOT_TS_KEY] = Date.now()` on its way out,
// which silently disabled every change-detection guard in the file: two
// serializations of identical state taken microseconds apart always
// differed, so `serialized === lastUploadedRef.current` could never once be
// true. The dedupe read as working code and was dead. Keep the timestamp
// OUT of the diff basis; writeLocalSave stamps it on the way to disk instead.
function pickPersistent(state: GameState): Partial<GameState> {
  const out: any = {};
  for (const key of PERSISTENT_KEYS) {
    out[key] = state[key];
  }
  return out;
}

// The one place that writes the local save. Stamps the timestamp here so
// pickPersistent stays diffable, the owner so the blob can never be mistaken
// for a different account's, and THE SYNC BOOKKEEPING so it can never be
// mistaken for a sibling tab's — see SYNC_VERSION_KEY above for the prize this
// last one costs when the two live in separate keys.
//
// One `setItem`. That is the whole mechanism: localStorage offers no
// multi-key transaction, so the only way to make "these bytes" and "the
// version and adopt seq that describe these bytes" inseparable is for them to
// be the same value. A tab that overwrites the blob necessarily overwrites the
// bookkeeping with its own, and a tab that dies mid-update leaves neither.
function writeLocalSave(
  snapshot: Partial<GameState>,
  ownerId: string | null,
  cloudVersion: number | null,
  adoptSeq: number,
): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      ...snapshot,
      [SNAPSHOT_TS_KEY]: Date.now(),
      [OWNER_KEY]: ownerId,
      // `null` = never synced. Written explicitly rather than omitted: the
      // PRESENCE of __adoptseq is what marks a blob as stamped, so a stamped
      // "never synced" blob must not fall back to a legacy key that some other
      // tab wrote.
      [CLOUD_VERSION_FIELD]: cloudVersion,
      [ADOPT_SEQ_FIELD]: adoptSeq,
    }));
  } catch { /* private mode / quota — the cloud is the durable copy */ }
}

// Who the local blob belongs to. null = a legacy save written before we
// stamped ownership; we cannot know whose it is.
function readLocalOwner(): string | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.[OWNER_KEY] === "string" ? parsed[OWNER_KEY] : null;
  } catch {
    return null;
  }
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside <GameProvider>");
  return ctx;
}

export type { Action } from "../types";
