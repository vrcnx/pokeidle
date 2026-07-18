// Language preference — same lightweight localStorage pattern as
// utils/profanity.ts / utils/music.ts: get/set + pub-sub so every open
// panel re-renders live when the player switches language, no reload
// needed. Client-only (not synced to the server save) for the same
// reason audio/chat prefs aren't — it's a device preference, not game
// progress.

export type Language = "en" | "pt" | "es";

export const LANGUAGES: { code: Language; label: string }[] = [
  { code: "en", label: "English" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
];

const STORAGE_KEY = "pkmn-language";

export function getLanguage(): Language {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "pt" || v === "es") return v;
    return "en";
  } catch {
    return "en";
  }
}

export function setLanguage(lang: Language): void {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* */ }
  for (const fn of listeners) fn(lang);
}

const listeners = new Set<(lang: Language) => void>();
export function subscribeLanguage(fn: (lang: Language) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
