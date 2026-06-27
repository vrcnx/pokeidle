import { useEffect, useState } from "react";
import type { GameState } from "../types";
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID, type Achievement, type AchievementExtras } from "../data/achievements";

// Achievement state is FULLY DERIVED from GameState + a small PvP/trade
// snapshot. We never write to the save — the predicates re-evaluate
// each render and the only persisted bit is the "already-shown-toast"
// set in localStorage so we don't replay the unlock pop-up on every
// page refresh.
//
// Flow:
//   1. useUnlockedAchievements(state, extras) → string[] of ids
//   2. useAchievementToasts() compares against the cached seen set and
//      emits a one-shot toast event for every newly-unlocked id
//   3. AchievementToast component subscribes to the event bus and
//      renders the pop-up

const STORAGE_KEY = "pokeidle.achievements.seen";

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function writeSeen(seen: Set<string>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(seen))); }
  catch { /* */ }
}

export function computeUnlocked(state: GameState, extras: AchievementExtras): string[] {
  const out: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (a.isUnlocked(state, extras)) out.push(a.id);
  }
  return out;
}

// Pub-sub for unlock toasts. AchievementToast subscribes; other code
// fires events via fireUnlock().
const _toastListeners = new Set<(a: Achievement) => void>();
function fireUnlock(a: Achievement) {
  for (const l of _toastListeners) l(a);
}
export function subscribeUnlock(fn: (a: Achievement) => void): () => void {
  _toastListeners.add(fn);
  return () => _toastListeners.delete(fn);
}

// Mounts once at the top of the app. Recomputes the unlocked-id set
// every time state/extras change, diffs against localStorage, and
// fires unlock events for the newly-seen ones.
//
// IMPORTANT: the first run after a session opens does NOT emit toasts
// for achievements unlocked before this session — we mark them as
// seen on first observation so we don't spam the user with a wall of
// pop-ups every time they sign in.
export function useAchievementTracker(state: GameState, extras: AchievementExtras): void {
  // Suppress toasts on first render so historical unlocks don't fire.
  const [firstRun, setFirstRun] = useState(true);
  useEffect(() => {
    const unlocked = computeUnlocked(state, extras);
    const seen = readSeen();
    const fresh: Achievement[] = [];
    for (const id of unlocked) {
      if (!seen.has(id)) {
        seen.add(id);
        const def = ACHIEVEMENTS_BY_ID.get(id);
        if (def) fresh.push(def);
      }
    }
    if (fresh.length > 0) {
      writeSeen(seen);
      if (!firstRun) {
        // Stagger each toast by 400ms so a multi-unlock event (e.g.
        // catching the 100th Pokémon AND hitting the 500-wild-win
        // threshold in the same battle) doesn't pile up.
        fresh.forEach((a, i) => {
          window.setTimeout(() => fireUnlock(a), i * 400);
        });
      }
    }
    if (firstRun) setFirstRun(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, extras.pvpRating, extras.pvpWins, extras.pvpLosses, extras.tradeCount]);
}

// Reads "have I ever unlocked this?" snapshots without wiring through
// the tracker — useful for the trophy gallery so it can render dim
// vs. lit tiles without re-running the tracker pipeline.
export function isAchievementUnlocked(id: string, state: GameState, extras: AchievementExtras): boolean {
  const def = ACHIEVEMENTS_BY_ID.get(id);
  return def ? def.isUnlocked(state, extras) : false;
}
