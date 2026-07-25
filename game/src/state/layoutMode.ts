import { useEffect, useState } from "react";

// Desktop layout preference.
//
// Deliberately a DEVICE preference in localStorage rather than part of the
// save: it describes the screen you're sitting at, not your progress. Syncing
// it would mean a wide monitor's choice following you onto a laptop, and it
// would add a field to save validation/merging for something with no gameplay
// meaning.
//
// "wide" is the default: it uses the screen people actually have instead of
// leaving a third of it as margin, and the reception was strongly positive.
// Classic remains one click away for anyone who prefers it.
//
// The read below checks for "classic" rather than defaulting to it, so a
// player who DELIBERATELY picked Classic keeps it, while everyone who never
// touched the setting moves to Wide. Below 1200px the wide grid reverts to
// the classic template anyway, and mobile uses a different shell entirely, so
// small screens are unaffected either way.

export type LayoutMode = "classic" | "wide";

const KEY = "pokemon-idle-layout-mode";
const listeners = new Set<(m: LayoutMode) => void>();
let current: LayoutMode = read();

function read(): LayoutMode {
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "wide";
  } catch {
    return "wide";
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
