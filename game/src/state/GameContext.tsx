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
    return {
      ...initialState,
      ...parsed,
      playerPokemon: activeFromParty,
      party: normalizedParty,
      box: normalizedBox,
      activePlayerPokemonIndex: activeIdx,
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
  const lastUploadedRef = useRef<string>("");
  const uploadTimerRef = useRef<number | undefined>(undefined);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const { refresh: refreshProfile } = useAuth();

  // ── Initial cloud sync ──
  // Uses last-write-wins on the snapshot timestamp. localStorage updates
  // synchronously on every state change, but the cloud is debounced ~1.5s.
  // If the player travels and reloads inside that window, cloud is stale
  // and would otherwise overwrite the fresh local state. Comparing the
  // `__savedAt` markers lets local win in that case (and triggers a
  // background upload so the cloud catches up).
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
        const cloudTs: number =
          cloudOk && typeof cloudData[SNAPSHOT_TS_KEY] === "number" ? cloudData[SNAPSHOT_TS_KEY] : 0;
        const localTs = readLocalTimestamp();
        const cloudIsNewer = cloudOk && cloudTs >= localTs;

        if (cloudIsNewer) {
          // Cloud is the source of truth. Replace local state.
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
        } else {
          // Local is newer (or there's no usable cloud save). Keep what
          // loadSaved() seeded the reducer with and push it up so the
          // cloud catches up.
          const local = loadSaved();
          if (local.playerPokemon) {
            const snapshot = pickPersistent(local);
            await api.putSave(snapshot).catch(() => undefined);
          }
        }
      } catch {
        /* offline: keep local state */
      } finally {
        cloudReadyRef.current = true;
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
      api.putSave(snapshot)
        .then(() => {
          setSaveStatus("saved");
          setLastSavedAt(Date.now());
          return refreshProfile();   // pulls back the new accountLevel
        })
        .catch(() => setSaveStatus("error"));
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
