// Client-side recent-battles cache. Records up to 30 most-recent
// resolved wild / trainer / boss / raid encounters into localStorage
// so the trainer card has a meaningful "Recent Battles" feed without
// needing a new server table + migration. Each entry captures who
// the player faced and where, plus the player's lead mon at the
// time so the history reads as a personal play log.
//
// A full server-backed PvE history (cross-device, never expires)
// is a follow-up; this one's the right scope for an immediate UX
// win and survives reloads on the same device.

const STORAGE_KEY = "pokeidle.battleHistory.v1";
const CAP = 30;
type Listener = () => void;
const listeners = new Set<Listener>();

export type BattleHistoryEntry = {
  at: number;                // Date.now()
  type: "wild" | "trainer" | "boss" | "raid";
  enemyName: string;
  enemyLevel: number;
  enemySpeciesKey: string;
  locationKey: string;
  locationName: string;
  /** Trainer name for trainer / boss battles. */
  trainerName?: string;
  /** Player's lead mon at the time. */
  playerLeadName?: string;
  playerLeadLevel?: number;
  playerLeadSpeciesKey?: string;
};

function read(): BattleHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((e): e is BattleHistoryEntry => !!e && typeof e === "object" && typeof e.at === "number") : [];
  } catch {
    return [];
  }
}

function write(arr: BattleHistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(0, CAP)));
  } catch { /* quota / private mode */ }
  for (const fn of listeners) fn();
}

export function recordBattle(entry: BattleHistoryEntry): void {
  const cur = read();
  cur.unshift(entry);
  if (cur.length > CAP) cur.length = CAP;
  write(cur);
}

export function listBattleHistory(): BattleHistoryEntry[] {
  return read();
}

import { useEffect, useState } from "react";

// React hook — re-renders the caller on every change.
export function useBattleHistory(): BattleHistoryEntry[] {
  const [entries, setEntries] = useState<BattleHistoryEntry[]>(() => read());
  useEffect(() => {
    const fn = () => setEntries(read());
    listeners.add(fn);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setEntries(read());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return entries;
}
