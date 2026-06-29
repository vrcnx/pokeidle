import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Action, Dispatch, GameState, Pokemon } from "../types";
import { reducer } from "./reducer";
import { initialState } from "./initialState";
import { SAVE_KEY } from "../data/raidLegendaries";
import { pokemonTable } from "../data/pokemon";
import { expForLevel } from "../utils/stats";
import { pickAbility } from "../data/abilities";
import { routes } from "../data/routes";
import { recordBattle } from "../utils/battleHistory";
import { api } from "../net/api";
import { useAuth } from "../auth/AuthContext";

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

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

interface GameContextValue {
  state: GameState;
  dispatch: Dispatch;
  /** Flush the debounced cloud save immediately. Used by the trade
   *  flow before locking so the server's canonical lookup sees the
   *  current species/level instead of a 1.5s-stale version (the bug
   *  where evolving then trading shipped the pre-evolved form). */
  forceSave: () => Promise<void>;
  /** Coarse-grained cloud-sync status for the UI. `pending` while the
   *  debounce timer is running; `saving` while putSave is in flight;
   *  `saved` when the most recent flush succeeded; `error` when it
   *  failed (most often: offline). */
  saveStatus: SaveStatus;
  /** Wall-clock timestamp of the last successful putSave, or null if
   *  no save has succeeded this session. Lets the indicator show
   *  "Saved · 12s ago" instead of a static "Saved". */
  lastSavedAt: number | null;
}

const GameContext = createContext<GameContextValue | null>(null);

function loadSaved(): GameState {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw) as Partial<GameState>;
    if (!parsed.playerPokemon) return initialState;
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

    return {
      ...initialState,
      ...parsed,
      playerPokemon: activeFromParty,
      party: normalizedParty,
      box: normalizedBox,
      activePlayerPokemonIndex: activeIdx,
      globalCatchDefaults: migratedGlobalCatchDefaults ?? initialState.globalCatchDefaults,
      // Defensively reset transient fields we never want to restore
      phase: "idle",
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
    };
  } catch {
    return initialState;
  }
}

// Returns true if `cloudData` strictly has MORE meaningful progress
// than `local`. Used by the boot sync to refuse swaps that would lose
// a milestone — e.g. local with empty defeatedEliteFour should never
// overwrite a cloud save where the Elite Four was cleared. We bias to
// "cloud wins" so cross-device players never see regressions.
function cloudHasMoreProgress(cloudData: any, local: GameState): boolean {
  const sigOf = (s: any) => ({
    badges:       Array.isArray(s?.defeatedGyms)       ? s.defeatedGyms.length       : 0,
    e4:           Array.isArray(s?.defeatedEliteFour)  ? s.defeatedEliteFour.length  : 0,
    champion:     !!s?.championDefeated,
    caught:       Array.isArray(s?.pokedexCaught)      ? s.pokedexCaught.length      : 0,
    boxParty:     (Array.isArray(s?.party) ? s.party.length : 0)
                + (Array.isArray(s?.box)   ? s.box.length   : 0),
    locations:    Array.isArray(s?.unlockedLocations)  ? s.unlockedLocations.length  : 0,
    money:        typeof s?.money === "number" ? s.money : 0,
  });
  const c = sigOf(cloudData);
  const l = sigOf(local);
  // Cloud wins if any milestone is greater; or if all are equal but
  // local has strictly less collection mass (catches a "local was
  // wiped to initialState but cloud is intact" case).
  if (c.e4 > l.e4) return true;
  if (c.champion && !l.champion) return true;
  if (c.badges > l.badges) return true;
  if (c.caught > l.caught) return true;
  if (c.locations > l.locations) return true;
  // For party/box and money we only trust cloud when the OTHER milestones
  // are equal — a strictly bigger cloud collection with equal story
  // progress indicates the cloud is the same player's longer-running
  // save and we should restore it.
  if (
    c.e4 === l.e4 && c.badges === l.badges && c.caught === l.caught &&
    c.locations === l.locations &&
    c.boxParty > l.boxParty + 1   // +1 slack to swallow lock-window race
  ) return true;
  return false;
}

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
  "victoryTokens",
  "autoProceed",
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

export function GameProvider({ children }: { children: ReactNode }) {
  // Initial state still seeds from localStorage so the player sees their
  // game instantly. Cloud sync hydrates over it once the network call
  // returns (cloud wins if it has data; otherwise local migrates up).
  const [state, dispatch] = useReducer(reducer, undefined, loadSaved);
  const cloudReadyRef = useRef(false);
  // Tracks the server-side `saveVersion` we have observed. Sent on every
  // putSave so the server can compare-and-swap reject stale writes that
  // would clobber a newer cloud copy from a different device. -1 means
  // "we have never successfully talked to the cloud this session" —
  // crucial for the autosave gate: if we never got cloud, we MUST NOT
  // push local state up (it might be stale and would destroy progress).
  const cloudVersionRef = useRef<number>(-1);
  const lastUploadedRef = useRef<string>("");
  const uploadTimerRef = useRef<number | undefined>(undefined);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const { refresh: refreshProfile } = useAuth();

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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cloud = await api.getSave();
        if (cancelled) return;
        const cloudData = cloud.saveData as any;
        const cloudOk = cloudData
          && typeof cloudData === "object"
          && cloudData.playerPokemon
          && typeof cloudData.playerPokemon.speciesKey === "string";
        // Lock in the cloud version BEFORE any potential upload. This
        // is what gets sent on every putSave as expectedSaveVersion.
        cloudVersionRef.current = cloud.saveVersion ?? 0;

        const local = loadSaved();
        const localOk = !!local.playerPokemon;

        if (!cloudOk) {
          // First-ever play, or cloud row is null/garbage. Keep local
          // (loadSaved already seeded the reducer) and bootstrap the
          // cloud with whatever we have.
          if (localOk) {
            const snapshot = pickPersistent(local);
            try {
              const res = await api.putSave(snapshot, cloudVersionRef.current);
              cloudVersionRef.current = res.saveVersion;
            } catch { /* offline: try again on next change */ }
          }
        } else if (!localOk || cloudHasMoreProgress(cloudData, local)) {
          // Cloud wins. Replace local state. Crucially this fires not
          // just when cloud has more milestones than local — it also
          // fires when local has none (fresh-tab / cleared-localStorage)
          // so we don't overwrite cloud with initialState.
          const sd = cloudData as Partial<GameState>;
          const normParty = (sd.party ?? [])
            .filter((p: any) => p && typeof p.speciesKey === "string")
            .map(normalizePokemon);
          const normBox = (sd.box ?? [])
            .filter((p: any) => p && typeof p.speciesKey === "string")
            .map(normalizePokemon);
          dispatch({
            type: "LOAD_SAVE",
            payload: {
              state: {
                ...sd,
                party: normParty,
                box: normBox,
                phase: "idle",
                enemyPokemon: null,
                pendingEvents: [],
                trainerBattle: null,
                bossBattle: null,
                healingState: null,
                playerVolatile: null,
                evolutionState: null,
              },
            },
          });
          // Mark this snapshot as already-uploaded so the autosave
          // useEffect's diff check doesn't re-push cloud right back to
          // cloud on the first state-change tick.
          lastUploadedRef.current = JSON.stringify(pickPersistent({
            ...local,
            ...sd,
          } as GameState));
        } else {
          // Local strictly extends cloud (more milestones / equal +
          // local-only changes). Push local up with the cloud version
          // as expectedSaveVersion so a concurrent write from another
          // device can still 409 us and prevent a clobber.
          const snapshot = pickPersistent(local);
          try {
            const res = await api.putSave(snapshot, cloudVersionRef.current);
            cloudVersionRef.current = res.saveVersion;
          } catch (err: any) {
            // 409 means another device wrote in between — re-pull
            // cloud and load it rather than retrying our stale view.
            if (err?.status === 409) {
              try {
                const fresh = await api.getSave();
                cloudVersionRef.current = fresh.saveVersion ?? cloudVersionRef.current;
                const fd = fresh.saveData as Partial<GameState> | null;
                if (fd && (fd as any).playerPokemon) {
                  dispatch({
                    type: "LOAD_SAVE",
                    payload: {
                      state: {
                        ...fd,
                        party: ((fd.party ?? []) as any[])
                          .filter((p) => p && typeof p.speciesKey === "string")
                          .map(normalizePokemon),
                        box: ((fd.box ?? []) as any[])
                          .filter((p) => p && typeof p.speciesKey === "string")
                          .map(normalizePokemon),
                        phase: "idle",
                        enemyPokemon: null,
                        pendingEvents: [],
                        trainerBattle: null,
                        bossBattle: null,
                        healingState: null,
                        playerVolatile: null,
                        evolutionState: null,
                      },
                    },
                  });
                }
              } catch { /* */ }
            }
            // else: silent retry on next autosave cycle.
          }
        }
        cloudReadyRef.current = true;
      } catch {
        // CRITICAL: a cloud fetch failure does NOT enable autosave.
        // Previously this branch flipped cloudReadyRef.current = true
        // which let the debounced uploader push local state to cloud
        // on the next change — destructively if local was stale.
        // Now we leave the flag false; the user keeps playing locally
        // and we retry getSave on next mount. Save status is surfaced
        // to the UI so silent regressions don't slip past QA.
        setSaveStatus("error");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Periodic cloud upload (debounced, idle-only) ──
  useEffect(() => {
    if (!cloudReadyRef.current) return;
    if (state.phase !== "idle" && state.phase !== "victory") return;
    if (!state.playerPokemon) return;

    const snapshot = pickPersistent(state);
    // Always cache locally so a refresh shows the most recent state
    // even before the cloud responds.
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot)); } catch { /* */ }

    // Debounce server upload — most state changes happen in clusters.
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastUploadedRef.current) return;
    if (uploadTimerRef.current) window.clearTimeout(uploadTimerRef.current);
    setSaveStatus("pending");
    uploadTimerRef.current = window.setTimeout(() => {
      lastUploadedRef.current = serialized;
      setSaveStatus("saving");
      // expectedSaveVersion gates the write: if another device wrote
      // in between, the server rejects with 409 and we re-pull rather
      // than blindly overwriting.
      api.putSave(snapshot, cloudVersionRef.current >= 0 ? cloudVersionRef.current : undefined)
        .then((res) => {
          cloudVersionRef.current = res.saveVersion;
          setSaveStatus("saved");
          setLastSavedAt(Date.now());
          return refreshProfile();
        })
        .catch(async (err: any) => {
          if (err?.status === 409) {
            // Cloud advanced under us — another device wrote. Re-pull
            // and adopt cloud rather than retrying the stale write.
            try {
              const fresh = await api.getSave();
              cloudVersionRef.current = fresh.saveVersion ?? cloudVersionRef.current;
              const fd = fresh.saveData as Partial<GameState> | null;
              if (fd && (fd as any).playerPokemon) {
                const normParty = ((fd.party ?? []) as any[])
                  .filter((p) => p && typeof p.speciesKey === "string")
                  .map(normalizePokemon);
                const normBox = ((fd.box ?? []) as any[])
                  .filter((p) => p && typeof p.speciesKey === "string")
                  .map(normalizePokemon);
                dispatch({
                  type: "LOAD_SAVE",
                  payload: {
                    state: {
                      ...fd,
                      party: normParty,
                      box: normBox,
                      phase: "idle",
                      enemyPokemon: null,
                      pendingEvents: [],
                      trainerBattle: null,
                      bossBattle: null,
                      healingState: null,
                      playerVolatile: null,
                      evolutionState: null,
                    },
                  },
                });
                setSaveStatus("saved");
                return;
              }
            } catch { /* */ }
          }
          setSaveStatus("error");
        });
    }, 1500);

    return () => {
      if (uploadTimerRef.current) window.clearTimeout(uploadTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.phase,
    state.playerPokemon?.level,
    state.playerPokemon?.totalExp,
    state.party.length,
    state.box.length,
    state.money,
    state.inventory,
    state.pokedexCaught.length,
    state.shinyCaught.length,
    state.activeEffects,
    // Travel-only changes (no battles, no level-ups) still need to flush
    // so the next reload returns the player to where they were.
    state.currentLocation,
    state.currentRoute,
    state.unlockedLocations.length,
    state.defeatedGyms.length,
    state.defeatedEliteFour.length,
  ]);

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

  // Stable reference to current state for forceSave. Reading from a
  // ref avoids re-creating forceSave on every state change and makes
  // sure it always sees the latest snapshot when called.
  const stateRef = useRef(state);
  stateRef.current = state;
  const forceSave = async () => {
    if (!cloudReadyRef.current) return;
    if (!stateRef.current.playerPokemon) return;
    // Cancel the pending debounced upload — we're about to do it now.
    if (uploadTimerRef.current) {
      window.clearTimeout(uploadTimerRef.current);
      uploadTimerRef.current = undefined;
    }
    const snapshot = pickPersistent(stateRef.current);
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastUploadedRef.current) return;
    lastUploadedRef.current = serialized;
    setSaveStatus("saving");
    try {
      await api.putSave(snapshot);
      setSaveStatus("saved");
      setLastSavedAt(Date.now());
      refreshProfile();
    } catch {
      setSaveStatus("error");
      // Surface failure to the caller so trade-lock can bail rather
      // than emitting against a stale cloud copy.
      throw new Error("save_sync_failed");
    }
  };

  return (
    <GameContext.Provider
      value={{
        state,
        dispatch: dispatch as Dispatch,
        forceSave,
        saveStatus,
        lastSavedAt,
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

function pickPersistent(state: GameState): Partial<GameState> & { [SNAPSHOT_TS_KEY]: number } {
  const out: any = {};
  for (const key of PERSISTENT_KEYS) {
    out[key] = state[key];
  }
  out[SNAPSHOT_TS_KEY] = Date.now();
  return out;
}

function readLocalTimestamp(): number {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    return typeof parsed?.[SNAPSHOT_TS_KEY] === "number" ? parsed[SNAPSHOT_TS_KEY] : 0;
  } catch {
    return 0;
  }
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside <GameProvider>");
  return ctx;
}

export type { Action } from "../types";
