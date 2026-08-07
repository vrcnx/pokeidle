// First-touch attribution: remember where a visitor arrived from, and hand it
// to the server once they have an account.
//
// ── WHY THE BROWSER HAS TO DO THIS ──────────────────────────────────
// By the time the signup request reaches the server, the Referer header says
// "pokeidle.com" — the visitor has been through the landing page and the auth
// screen, and each hop overwrote the one before. The only moment the original
// referrer exists is the first page load, in the browser. So we capture it
// there and hold it until there is an account to attach it to.
//
// ── FIRST TOUCH, NOT LAST ───────────────────────────────────────────
// The stored record is written once and never overwritten. Someone who finds
// the game on Reddit, plays as a guest, comes back a week later by typing the
// URL, and only then signs up was acquired by Reddit — last-touch would file
// them under "direct" and credit nothing for the post that actually worked.
//
// ── WHAT IS NOT STORED ──────────────────────────────────────────────
// The referrer is kept as the full URL only until it is sent; the server
// reduces it to a bare host and throws the rest away (see
// server/src/lib/acquisition.ts). Nothing here is read by the game itself, and
// nothing identifies the visitor — this is one row about one signup, not a
// session trail.

import { SERVER_BASE } from "./api";

const KEY = "pokeidle-first-touch";
const SENT_KEY = "pokeidle-first-touch-sent";
/**
 * A friend's referral code, held until there is an account to credit it to.
 *
 * ── ITS OWN KEY, NOT A FIELD ON FirstTouch ──────────────────────────
 * First touch is written once and never overwritten, which is right for
 * "where did this player come from" and wrong for this. The common case is
 * someone who finds the game on their own, plays as a guest, and only later
 * gets a link from a friend who wants the referral — under first-touch rules
 * that code would be dropped, because a touch was already recorded on the
 * visit before it.
 *
 * So the code is captured independently: the FIRST code seen before signup
 * wins, whenever it arrives. First rather than last so a code cannot be
 * displaced by a stray link the visitor clicks on the way to registering.
 */
const REF_KEY = "pokeidle-referral-code";

export interface FirstTouch {
  referrer: string;
  landingPath: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  at: string;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // private mode, disabled storage, or corrupt JSON
  }
}

/**
 * Records the current page as the first touch, if nothing is recorded yet.
 *
 * Called once from the app entry point, before anything routes. Cheap, silent,
 * and a complete no-op on every visit after the first — including the reload
 * that follows a Google OAuth redirect, which is exactly the case that would
 * otherwise overwrite a real referrer with "accounts.google.com".
 */
export function captureFirstTouch(): void {
  if (typeof window === "undefined") return;
  if (read<FirstTouch>(KEY)) return;

  const sp = new URLSearchParams(window.location.search);
  const touch: FirstTouch = {
    referrer: document.referrer || "",
    landingPath: window.location.pathname || "/",
    utmSource: sp.get("utm_source"),
    utmMedium: sp.get("utm_medium"),
    utmCampaign: sp.get("utm_campaign"),
    utmTerm: sp.get("utm_term"),
    utmContent: sp.get("utm_content"),
    at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(touch));
  } catch { /* private mode — attribution is a nicety, never a blocker */ }
}

/**
 * Remembers `?ref=CODE` from the current URL.
 *
 * Called on every load, not just the first, and a no-op once a code is held —
 * see REF_KEY for why this does not ride on the first-touch record.
 *
 * The code is NOT validated here. Whether it resolves to a player is the
 * server's answer and it needs the database to give it; a client-side guess
 * would only ever be a second, weaker copy of that rule. All this does is
 * refuse to store something absurd, so a junk URL cannot fill storage.
 */
export function captureReferralCode(): void {
  if (typeof window === "undefined") return;
  const raw = new URLSearchParams(window.location.search).get("ref");
  if (!raw) return;
  const code = raw.trim().slice(0, 32);
  if (!code) return;
  try {
    if (localStorage.getItem(REF_KEY)) return; // first code wins
    localStorage.setItem(REF_KEY, code);
  } catch { /* private mode — the referral is lost, the signup is not */ }
}

/**
 * Sends the stored first touch. Safe to call on every authenticated boot.
 *
 * Two layers of "only once": a local flag so an existing player costs at most
 * one request ever, and the server's own primary-key + account-age guards,
 * which are the ones that actually matter — the local flag lives in storage
 * the player can clear.
 *
 * Every failure path is swallowed. Nothing about signing in or playing should
 * ever depend on a reporting call succeeding.
 */
export async function sendFirstTouch(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(SENT_KEY)) return;
  } catch {
    return; // no storage means no dedupe, and we will not spam without one
  }

  const touch = read<FirstTouch>(KEY);
  if (!touch) return;

  try {
    await fetch(`${SERVER_BASE}/api/attribution`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        referrer: touch.referrer,
        landingPath: touch.landingPath,
        utmSource: touch.utmSource,
        utmMedium: touch.utmMedium,
        utmCampaign: touch.utmCampaign,
        utmTerm: touch.utmTerm,
        utmContent: touch.utmContent,
        // Read at send time rather than captured with the touch: the code may
        // have arrived on a later visit than the one that set the touch.
        ref: (() => {
          try { return localStorage.getItem(REF_KEY); } catch { return null; }
        })(),
      }),
    });
    // Marked on ANY response, including the no-op reasons. "Too late" and
    // "already attributed" are permanent verdicts; retrying them next boot
    // would be a request per session for the life of the account.
    localStorage.setItem(SENT_KEY, "1");
  } catch { /* offline, blocked, CORS — try again next boot */ }
}
