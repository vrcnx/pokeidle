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
      }),
    });
    // Marked on ANY response, including the no-op reasons. "Too late" and
    // "already attributed" are permanent verdicts; retrying them next boot
    // would be a request per session for the life of the account.
    localStorage.setItem(SENT_KEY, "1");
  } catch { /* offline, blocked, CORS — try again next boot */ }
}
