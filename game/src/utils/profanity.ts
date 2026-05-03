// Lightweight client-side profanity filter for chat. Substitutes
// matched words with bullets (• of equal length) so the message shape
// is preserved and the player can still tell roughly what was said —
// then surface a per-message "show original" toggle in MiniChat for
// anyone who wants to opt out.
//
// Word list is intentionally small + opinionated: common slurs,
// strong vulgarities. Prefer false negatives over false positives —
// over-filtering destroys trust faster than missing the occasional
// edge case. Variants (l33t-speak, repeated letters) are caught by
// loose pattern matching, not an exhaustive variants table.
//
// Live preference is stored in localStorage so it persists across
// sessions. Defaults to ON; players can toggle in Settings.

const STORAGE_KEY = "pkmn-profanity-filter";

// Base wordlist. Each entry is matched as a whole word, case-insensitive,
// with l33t-speak normalisation applied (a→[a@4], e→[e3], i→[i1!], o→[o0],
// s→[s$5], t→[t7]). Repeated letters (≥3) are collapsed before matching
// so "fuuuck" reduces to "fuck".
const WORDS = [
  "fuck", "shit", "bitch", "asshole", "cunt", "dick", "pussy",
  "fag", "faggot", "nigger", "nigga", "retard", "retarded",
  "whore", "slut", "bastard", "wanker", "twat", "douche",
  "cock", "prick", "tits", "boobs",
  // Mild — included so kids accounts get a cleaner experience by
  // default; players can disable the whole filter if they want.
  "damn", "hell", "crap",
];

// Build a case-insensitive regex that matches any of the words with
// l33t-speak substitution and collapsed repeats. Word-boundaries on
// either side so "scunthorpe" doesn't get caught by "cunt".
const SUBS: Record<string, string> = {
  a: "[a@4]", b: "[b]", c: "[ck]", d: "[d]", e: "[e3]", f: "[f]",
  g: "[g9]", h: "[h]", i: "[i1!|]", j: "[j]", k: "[ck]", l: "[l1]",
  m: "[m]", n: "[n]", o: "[o0]", p: "[p]", q: "[q]", r: "[r]",
  s: "[s$5]", t: "[t7]", u: "[uv]", v: "[uv]", w: "[w]", x: "[x]",
  y: "[y]", z: "[z2]",
};

function buildPattern(word: string): string {
  return word
    .toLowerCase()
    .split("")
    .map((c) => (SUBS[c] ?? c) + "+")
    .join("");
}

const PATTERN = new RegExp(
  "\\b(?:" + WORDS.map(buildPattern).join("|") + ")\\b",
  "gi",
);

export function isProfanityFilterOn(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v !== "0"; // default ON
  } catch {
    return true;
  }
}

export function setProfanityFilter(on: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, on ? "1" : "0"); } catch { /* */ }
  // Notify listeners so currently-open chat panels re-render.
  for (const fn of listeners) fn(on);
}

const listeners = new Set<(on: boolean) => void>();
export function subscribeProfanityFilter(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Apply the filter to a string. Returns the original text unchanged
// if no matches; otherwise replaces each match with a string of •
// the same length so message shape stays readable. The caller owns
// the "show original" toggle — pass `force: false` to bypass.
export function censor(text: string, force = true): string {
  if (!force) return text;
  return text.replace(PATTERN, (m) => "•".repeat(m.length));
}

// Returns whether the input text would be modified by the filter.
// Used to decide whether to show a "show original" affordance.
export function hasProfanity(text: string): boolean {
  PATTERN.lastIndex = 0;
  return PATTERN.test(text);
}
