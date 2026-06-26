// Client-side mute list. Lives in localStorage as a flat array of
// lowercase usernames; the chat surfaces filter their renders against
// it. Doesn't block at the server (their message still flows to other
// clients), which is the right scope for a quick player-safety pass —
// a server-side block needing a schema migration is a follow-up.
//
// Why localStorage and not the React tree:
// - Survives reloads without a fetch.
// - Read from every chat surface (SocialPanel, MiniChat, future
//   places) without prop-drilling.
// - Tiny payload — 200 muted users at ~30 chars each is ~6 KB.
//
// To clear a mute the user re-opens the trainer card and clicks Unmute.

const STORAGE_KEY = "pokeidle.muteList.v1";
type Listener = () => void;
const listeners = new Set<Listener>();

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase()));
  } catch {
    return new Set();
  }
}

function write(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* quota / private mode */ }
  for (const fn of listeners) fn();
}

export function isMuted(username: string | undefined | null): boolean {
  if (!username) return false;
  return read().has(username.toLowerCase());
}

export function muteUser(username: string): void {
  const set = read();
  set.add(username.toLowerCase());
  write(set);
}

export function unmuteUser(username: string): void {
  const set = read();
  set.delete(username.toLowerCase());
  write(set);
}

export function listMuted(): string[] {
  return [...read()].sort();
}

// React hook — re-renders the caller whenever the mute list changes.
// Returns a stable {isMuted, mute, unmute, list} bundle.
import { useEffect, useState } from "react";

export function useMuteList() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const fn = () => setVersion((v) => v + 1);
    listeners.add(fn);
    // Sync across tabs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setVersion((v) => v + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return {
    version, // for downstream useMemo deps
    isMuted: (username: string | undefined | null) => isMuted(username),
    mute: (username: string) => muteUser(username),
    unmute: (username: string) => unmuteUser(username),
    list: () => listMuted(),
  };
}
