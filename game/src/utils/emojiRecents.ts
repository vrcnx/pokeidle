// Recently-used emoji, client-only — same localStorage pattern as
// utils/profanity.ts / utils/music.ts / i18n/language.ts.
const STORAGE_KEY = "pkmn-emoji-recents";
const MAX_RECENTS = 24;

export function getRecentEmoji(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecentEmoji(emoji: string): void {
  try {
    const next = [emoji, ...getRecentEmoji().filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* */
  }
}
