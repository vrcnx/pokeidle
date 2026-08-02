import { useEffect, useState } from "react";
import type { AwayProgress, DailyStatus } from "../net/api";
import { changesSince, CURRENT_VERSION, LAST_SEEN_VERSION_KEY } from "../data/changelog";
import { isStreamMode } from "./streamMode";
import type { ChangelogEntry } from "../types";

// Everything a returning player is greeted with, gathered into one decision.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────
// Four independent surfaces used to fire on the same load, each unaware of the
// others: the daily-reward modal (when GET /dailies/status resolved), the
// away-progress modal (when POST /away/claim resolved), the changelog modal
// (synchronously, from localStorage) and a "you received X" toast (when the
// first autosave came back carrying grants).
//
// Nothing coordinated them. They all rendered at z-index 100 into a flat list
// in GameShell, so the ordering was whatever DOM order happened to be, and a
// player returning after an update to a claimable daily and an overnight
// stipend got three stacked overlays — the two later ones covering the first —
// plus a toast over the top. Dismissing them was a chore performed before the
// game could be played, which is the opposite of what a reward is for.
//
// ── WHY A COLLECTOR AND NOT JUST ONE COMPONENT ──────────────────────
// The four inputs resolve at genuinely different times: one is synchronous,
// two are separate HTTP round trips fired during the boot reconcile, and the
// fourth arrives with an upload that may not have happened yet. A component
// that rendered as soon as it had anything would pop up half-built and then
// grow extra sections under the player's cursor.
//
// So contributions are collected, and the dialog opens ONCE, when the sources
// that can reasonably be waited for have reported — or when the wait has gone
// on long enough that waiting is worse than showing what we have.

export interface WelcomeBackData {
  /** Money paid for time with the game closed. Null = nothing owed. */
  away: AwayProgress | null;
  /** Daily streak state. Null = never loaded (offline at boot). */
  daily: DailyStatus | null;
  /** Release notes since the player's last version. Empty = caught up, brand
   *  new, or storage unavailable. */
  news: ChangelogEntry[];
  /** Human-readable prize summaries folded in during boot. */
  gifts: string[];
  /** True when we have evidence this player has been here before. Drives
   *  "Welcome back" vs "Welcome" — greeting a first-time player with
   *  "welcome back" is a small lie they notice. */
  returning: boolean;
}

/**
 * How long to wait for the slow sources before showing what we have.
 *
 * Both HTTP contributors are fired during the boot reconcile, concurrently
 * with getSave, so in practice they land well inside this. The timeout exists
 * for the case where one of them hangs — a player who is owed an overnight
 * stipend should not be denied the report because the daily endpoint is
 * having a bad day.
 */
const SETTLE_TIMEOUT_MS = 2_500;

/**
 * How long after boot a gift still counts as "part of coming back".
 *
 * A grant folded in during the first upload is something they came back TO. A
 * grant that arrives ten minutes later is a live event and belongs in a toast,
 * where it can appear without interrupting whatever they are doing.
 */
const BOOT_GIFT_WINDOW_MS = 30_000;

const _bootAt = Date.now();

let _data: WelcomeBackData = { away: null, daily: null, news: [], gifts: [], returning: false };
let _open = false;
let _resolved = false;
/** Which slow sources have reported. The dialog waits for both. */
const _pending = new Set<"away" | "daily">(["away", "daily"]);
let _timer: ReturnType<typeof setTimeout> | null = null;

const _listeners = new Set<() => void>();
function emit() { for (const fn of _listeners) fn(); }

function readSeenVersion(): string | null {
  try { return localStorage.getItem(LAST_SEEN_VERSION_KEY); } catch { return null; }
}
export function markVersionSeen() {
  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, CURRENT_VERSION); } catch { /* private mode */ }
}

/** Anything worth interrupting them for? */
function hasContent(d: WelcomeBackData): boolean {
  return (d.away != null && d.away.money > 0)
    || (d.daily != null && !d.daily.claimedToday)
    || d.news.length > 0
    || d.gifts.length > 0;
}

function tryResolve() {
  if (_resolved) return;
  if (_pending.size > 0) return;
  finish();
}

function finish() {
  if (_resolved) return;
  _resolved = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }

  // Read the changelog HERE rather than in beginWelcomeBack.
  //
  // React runs child effects before parent effects, so the components that
  // contribute (DailyRewardModal calls bindDailies from its own mount effect)
  // can report before anything higher up has had a chance to arm the window.
  // If both sources landed first, finish() would run with news still empty and
  // the player would silently lose their release notes. Reading it at decision
  // time makes the outcome independent of mount order.
  readNews();

  // An unattended stream box has nobody to dismiss anything, and the stream
  // would sit behind it. Same convention as every other auto-opening surface
  // in the app — except now it is decided once rather than copy-pasted into
  // five components.
  if (isStreamMode()) { markVersionSeen(); emit(); return; }

  if (!hasContent(_data)) {
    // Nothing to say. Do not open an empty "welcome back" — a dialog that
    // greets you with no news is worse than no dialog, because it costs a
    // click and teaches you that the dialog is noise.
    emit();
    return;
  }
  _open = true;
  emit();
}

let _newsRead = false;
function readNews() {
  if (_newsRead) return;
  _newsRead = true;
  const seen = readSeenVersion();
  if (!seen) {
    // No stored version: they have never played, or cleared storage. Release
    // notes are not a first screen — "we fixed the Safari Zone Dratini bug"
    // means nothing to someone who has never caught one. Mark them current so
    // their FIRST update is the first set they ever read.
    markVersionSeen();
    return;
  }
  if (seen === CURRENT_VERSION) return;   // caught up
  const fresh = changesSince(seen);
  if (fresh.length === 0) {
    // Version moved but nothing player-facing shipped (or their stored
    // version is somehow ahead of ours). Record and stay quiet.
    markVersionSeen();
    return;
  }
  _data.news = fresh;
  _data.returning = true;
}

/**
 * Arms the collection window.
 *
 * Safe to call at any point during boot, including after the contributors
 * have already reported — finish() is idempotent and reads everything it
 * needs at decision time.
 */
export function beginWelcomeBack() {
  if (_timer || _resolved) return;
  _timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
}

export function contributeAway(report: AwayProgress | null) {
  if (_resolved) return;
  if (report && report.money > 0) {
    _data.away = report;
    _data.returning = true;
  }
  _pending.delete("away");
  tryResolve();
}

export function contributeDaily(status: DailyStatus | null) {
  if (_resolved) return;
  _data.daily = status;
  // A streak means they have claimed before, so they have been here before.
  if (status && status.streak > 0) _data.returning = true;
  _pending.delete("daily");
  tryResolve();
}

/**
 * Offer a gift summary to the welcome dialog.
 *
 * Returns true if the dialog took it, in which case the caller must NOT also
 * toast — otherwise the same gift is announced twice, once in a dialog the
 * player is reading and once in a toast over the top of it.
 */
export function captureBootGift(summary: string): boolean {
  if (Date.now() - _bootAt > BOOT_GIFT_WINDOW_MS) return false;
  if (_resolved && !_open) return false;   // decided not to show — toast it
  _data.gifts = [..._data.gifts, summary];
  _data.returning = true;
  // A gift landing after the dialog opened still belongs in it: the section
  // appears, rather than a toast firing over a dialog about the same thing.
  emit();
  return true;
}

export function closeWelcomeBack() {
  _open = false;
  // Closing is the player saying "I have read this", including the release
  // notes — the same rule the changelog modal always had, now applied on the
  // one close path instead of four.
  markVersionSeen();
  emit();
}

/** Lets the dialog write back the post-claim daily status without a refetch. */
export function updateWelcomeDaily(status: DailyStatus) {
  _data = { ..._data, daily: status };
  emit();
}

export function useWelcomeBack(): { open: boolean; data: WelcomeBackData } {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
  }, []);
  return { open: _open, data: _data };
}
