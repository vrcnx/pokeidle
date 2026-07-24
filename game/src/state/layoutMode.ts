import { useEffect, useState } from "react";

// Desktop layout preference.
//
// Deliberately a DEVICE preference in localStorage rather than part of the
// save: it describes the screen you're sitting at, not your progress. Syncing
// it would mean a wide monitor's choice following you onto a laptop, and it
// would add a field to save validation/merging for something with no gameplay
// meaning.
//
// "classic" stays the default so no existing player's view changes without
// them asking for it — this is a secondary layout, not a replacement.

export type LayoutMode = "classic" | "wide";

const KEY = "pokemon-idle-layout-mode";
const listeners = new Set<(m: LayoutMode) => void>();
let current: LayoutMode = read();

function read(): LayoutMode {
  try {
    return localStorage.getItem(KEY) === "wide" ? "wide" : "classic";
  } catch {
    return "classic";
  }
}

export function getLayoutMode(): LayoutMode {
  return current;
}

export function setLayoutMode(mode: LayoutMode): void {
  current = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* private mode — session only */ }
  for (const fn of listeners) fn(mode);
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(current);
  useEffect(() => {
    listeners.add(setMode);
    return () => { listeners.delete(setMode); };
  }, []);
  return mode;
}
