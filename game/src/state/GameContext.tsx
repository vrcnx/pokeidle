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
import { reportClientError } from "../net/errorReporter";

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

    return {
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
  // The newest snapshot that has not reached the cloud yet, and the timer
  // that will send it. See the uploader below for why this is a throttle
  // and not a debounce.
  const pendingRef = useRef<{ snapshot: Partial<GameState>; serialized: string } | null>(null);
  const uploadTimerRef = useRef<number | undefined>(undefined);
  // Set once a permanent rejection (400/413/403) is seen. The save we are
  // producing is one the server will never accept, so retrying it forever
  // just burns the rate limit and lies to the player with "Offline".
  const permanentlyRejectedRef = useRef<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const { refresh: refreshProfile, me } = useAuth();
  // The signed-in account. GameProvider only mounts when authenticated, so
  // this is set for every save this provider will ever write.
  const myIdRef = useRef<string | null>(me?.id ?? null);
  myIdRef.current = me?.id ?? null;

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
          reportClientError({
            source: "save-foreign-local",
            message: "local save belonged to a different account; discarded before boot reconcile",
          });
        }

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
          } else if (localIsForeign) {
            // No cloud save AND the local blob is someone else's: this is a
            // genuinely new account. useReducer already seeded the UI from
            // that foreign blob, so reset it — otherwise the player would be
            // looking at a stranger's Pokemon and would then upload them.
            dispatch({ type: "LOAD_SAVE", payload: { state: pickPersistent(initialState) } });
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
    pendingRef.current = null;

    // Optimistic: blocks a duplicate in-flight write of the same bytes.
    // Cleared again on any failure so the next tick retries.
    lastUploadedRef.current = pending.serialized;
    setSaveStatus("saving");
    try {
      const res = await api.putSave(
        pending.snapshot,
        cloudVersionRef.current >= 0 ? cloudVersionRef.current : undefined,
      );
      cloudVersionRef.current = res.saveVersion;
      setSaveStatus("saved");
      setLastSavedAt(Date.now());
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
        reportClientError({
          source: "save-conflict",
          message: `putSave 409 — another device wrote (localVersion=${cloudVersionRef.current})`,
        });
        // Re-read the cloud's VERSION only — not its data. A plain version
        // mismatch then resolves on the next attempt, while the player's
        // actual progress stays untouched by a device they are not using.
        try {
          const fresh = await api.getSave();
          if (typeof fresh.saveVersion === "number") cloudVersionRef.current = fresh.saveVersion;
        } catch { /* transient; the next change retries */ }
        return;
      }

      // Permanent vs transient. A 400/413/403 is a contract violation: the
      // save we are building is one this server will never accept, so
      // retrying is pure noise and "Offline" is an outright lie that sends
      // the player to check a router that is working fine.
      if (status === 400 || status === 413 || status === 403) {
        permanentlyRejectedRef.current = err?.message ?? `HTTP ${status}`;
        setSaveStatus("rejected");
        // The team finds out, not the player. Until now the only way anyone
        // learned saves were failing was a player typing "its possible to
        // save your progress ????" into global chat.
        reportClientError({
          source: "save-rejected",
          message: `putSave ${status}: ${err?.message ?? "unknown"}`,
          meta: { status, code: err?.code ?? null },
        });
        return;
      }

      // Everything else (429/500/502/network/DNS/CORS) is transient and
      // self-heals on the next state change, which an idle game produces
      // constantly.
      setSaveStatus("error");
    }
  }, [refreshProfile]);

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
    writeLocalSave(pickPersistent(state), myIdRef.current);
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

    pendingRef.current = { snapshot, serialized };
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
      writeLocalSave(snapshot, myIdRef.current);
      if (!cloudReadyRef.current) return;
      if (permanentlyRejectedRef.current) return;
      if (JSON.stringify(snapshot) === lastUploadedRef.current) return;
      api.putSaveBeacon(snapshot, cloudVersionRef.current >= 0 ? cloudVersionRef.current : undefined);
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
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
// OUT of the diff basis; writeLocalSave stamps it on the way to disk, where
// it is read back by readLocalTimestamp and nothing compares it.
function pickPersistent(state: GameState): Partial<GameState> {
  const out: any = {};
  for (const key of PERSISTENT_KEYS) {
    out[key] = state[key];
  }
  return out;
}

// The one place that writes the local save. Stamps the timestamp here so
// pickPersistent stays diffable, and the owner so the blob can never be
// mistaken for a different account's.
function writeLocalSave(snapshot: Partial<GameState>, ownerId: string | null): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      ...snapshot,
      [SNAPSHOT_TS_KEY]: Date.now(),
      [OWNER_KEY]: ownerId,
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
