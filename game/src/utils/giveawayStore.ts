import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";
import { api, type GiveawayStats, type Promo, type PublicGiveaway } from "../net/api";
import { isLiveNow } from "./giveawayRail";

// One shared giveaway snapshot, modelled on state/announcement.ts.
//
// This exists because the modal used to be the only thing that knew anything:
// it fetched on open and threw the result away on close, so nothing outside it
// could say whether a giveaway was running, and opening it always cost a
// "Loading…" flash. A standing rail control needs the answer before anyone
// clicks anything, and the dialog it opens should already have it.
//
// Three inputs keep it live, in decreasing order of importance:
//
//   1. the socket. Every socket is joined to the `global` room on connect, and
//      both giveaway lifecycle events already broadcast there as chat cards
//      (`giveawayOpen` when one is published, `giveaway` when one is drawn).
//      So "a giveaway just opened" is a PUSH we already receive — no new
//      server event, no change to MiniChat, no change to socket.ts. A second
//      `.on("chat:message")` listener is purely additive.
//   2. a REST fetch on bind, so the first paint is right rather than empty.
//   3. a slow safety poll. The auto-draw sweep runs on a 15s server timer and
//      emits chat, which case 1 covers — but a client that reconnected while
//      a draw happened, or one whose socket is wedged, would otherwise sit on
//      a stale row indefinitely. 90s while something is live (a countdown is
//      on screen), 10 minutes otherwise. At ~34 concurrent players that is
//      well under a request a second.

export interface GiveawaySnapshot {
  giveaways: PublicGiveaway[] | null;
  stats: GiveawayStats | null;
  hasMoreHistory: boolean;
  /**
   * Standing free rewards. Separate from `giveaways` because they are a
   * different kind of thing on a different clock: a giveaway is a scheduled
   * event that opens and draws, a promo is a config row that changes when an
   * operator edits it or when THIS player finally does the thing. Folding them
   * into one list would mean either polling promos every 90s for nothing, or
   * letting a giveaway go stale to match a promo's cadence.
   */
  promos: Promo[] | null;
  error: string | null;
  /** Date.now() of the last successful fetch; 0 = never. */
  loadedAt: number;
}

const EMPTY: GiveawaySnapshot = {
  giveaways: null,
  stats: null,
  hasMoreHistory: false,
  promos: null,
  error: null,
  loadedAt: 0,
};

let _snap: GiveawaySnapshot = EMPTY;
const _listeners = new Set<(s: GiveawaySnapshot) => void>();
let _bound = false;
let _timer: number | undefined;
let _inFlight: Promise<void> | null = null;

const LIVE_POLL_MS = 90_000;
const IDLE_POLL_MS = 600_000;
/** Never refetch more often than this, however many triggers coincide. */
const MIN_GAP_MS = 5_000;

function emit() {
  for (const fn of _listeners) fn(_snap);
}

function hasLive(s: GiveawaySnapshot): boolean {
  const now = Date.now();
  return (s.giveaways ?? []).some((g) => isLiveNow(g, now));
}

function schedule() {
  if (_timer !== undefined) window.clearTimeout(_timer);
  _timer = undefined;
  // No subscribers = nothing on screen depends on this. Stop.
  if (_listeners.size === 0) return;
  _timer = window.setTimeout(() => {
    _timer = undefined;
    void refreshGiveaways();
  }, hasLive(_snap) ? LIVE_POLL_MS : IDLE_POLL_MS);
}

/**
 * Refetch. Coalesces concurrent callers onto one request, and (unless forced)
 * ignores triggers that arrive within MIN_GAP_MS of the last load — an admin
 * publishing four giveaways at once is one real burst in production, and it
 * should cost one request, not four.
 */
export function refreshGiveaways(opts: { force?: boolean } = {}): Promise<void> {
  if (_inFlight) return _inFlight;
  if (!opts.force && _snap.loadedAt > 0 && Date.now() - _snap.loadedAt < MIN_GAP_MS) {
    // Re-arm before bailing. The poll timer calls this unforced, so without
    // the reschedule a single coincidence — the timer firing within 5s of a
    // socket-driven refresh — silently ends polling for the rest of the
    // session, and the row would then only ever update on a socket push.
    schedule();
    return Promise.resolve();
  }
  _inFlight = api
    .listGiveaways()
    .then((d) => {
      // Spread, not a fresh literal: promos are loaded by a SEPARATE request
      // on a much slower clock, and rebuilding the snapshot from scratch here
      // would drop them on every 90s poll — the rail would show its promo row
      // for ninety seconds, lose it, and get it back on the next visibility
      // change. TypeScript catches exactly this omission, which is why the
      // field is required rather than optional.
      _snap = {
        ..._snap,
        giveaways: d.giveaways ?? [],
        stats: d.stats ?? null,
        hasMoreHistory: d.hasMoreHistory ?? false,
        error: null,
        loadedAt: Date.now(),
      };
      emit();
    })
    .catch((e) => {
      // Keep whatever we already had. A rail that empties itself on one flaky
      // request is worse than a rail that is a minute stale.
      _snap = { ..._snap, error: e?.message ?? "Couldn't load giveaways." };
      emit();
    })
    .finally(() => {
      _inFlight = null;
      schedule();
    });
  return _inFlight;
}

// ── Promos ──────────────────────────────────────────────────────────
// Deliberately NOT on the giveaway poll. A promo's state changes on exactly
// three occasions: an operator edits the config, the player links their
// Discord, or the grant lands. The first is rare, and the other two both
// happen away from this tab — the player leaves for Discord and comes back.
// So: once on bind, once when the dialog opens, and on the visibility return
// that follows every trip out of the app. Putting it on the 90s live poll
// would multiply the request rate of the whole feature to re-read a row that
// changes about once a month.
let _promosInFlight: Promise<void> | null = null;
let _promosAt = 0;
const PROMOS_MIN_GAP_MS = 30_000;

export function refreshPromos(opts: { force?: boolean } = {}): Promise<void> {
  if (_promosInFlight) return _promosInFlight;
  if (!opts.force && _promosAt > 0 && Date.now() - _promosAt < PROMOS_MIN_GAP_MS) {
    return Promise.resolve();
  }
  _promosInFlight = api
    .listPromos()
    .then((d) => {
      _promosAt = Date.now();
      _snap = { ..._snap, promos: d.promos ?? [] };
      emit();
    })
    .catch(() => {
      // Silent. A promo that fails to load shows no card, which is the same
      // thing the player sees when there is no promo running — and unlike the
      // giveaway list, nothing in the UI promises this section exists. Writing
      // to `_snap.error` here would put a red "couldn't load giveaways" line in
      // the dialog because a side section failed.
    })
    .finally(() => {
      _promosInFlight = null;
    });
  return _promosInFlight;
}

/**
 * Apply a known-good entry result locally so the rail and the dialog flip to
 * "entered" on the click rather than on the next round trip. The refetch that
 * follows is the authority; this only removes the lag.
 */
export function markEnteredLocally(id: string, entryCount?: number) {
  if (!_snap.giveaways) return;
  _snap = {
    ..._snap,
    giveaways: _snap.giveaways.map((g) =>
      g.id === id
        ? { ...g, hasEntered: true, entryCount: entryCount ?? (g.hasEntered ? g.entryCount : g.entryCount + 1) }
        : g,
    ),
  };
  emit();
}

// ── "I have seen this win" ──────────────────────────────────────────
// The win state leads the rail for 48h. Once the player has actually opened
// the dialog on it, the pulse stops — the row still says they won, it just
// stops asking for attention. localStorage because it is a per-device UI
// nicety, not account state worth a column.
const SEEN_KEY = "pkmn-giveaway-seen-wins";
let _seen: Set<string> | null = null;

export function seenWins(): ReadonlySet<string> {
  if (_seen) return _seen;
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    _seen = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    _seen = new Set<string>();
  }
  return _seen;
}

export function markWinsSeen(ids: readonly string[]) {
  if (ids.length === 0) return;
  const set = new Set(seenWins());
  let changed = false;
  for (const id of ids) if (!set.has(id)) { set.add(id); changed = true; }
  if (!changed) return;
  _seen = set;
  try {
    // Bounded — this only ever needs to cover the 48h window.
    localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-50)));
  } catch { /* private mode / quota — the pulse simply repeats */ }
  // New object identity, or subscribers bail out of the re-render and the
  // pulse keeps running against a set that has already changed.
  _snap = { ..._snap };
  emit();
}

function bind() {
  if (_bound) return;
  _bound = true;

  void refreshGiveaways({ force: true });
  void refreshPromos({ force: true });

  const sock = getSocket();
  if (!sock.connected) sock.connect();
  sock.on("chat:message", (msg: { kind?: string }) => {
    // The two giveaway lifecycle cards, already broadcast to `global`.
    if (msg?.kind === "giveawayOpen" || msg?.kind === "giveaway") {
      void refreshGiveaways({ force: true });
    }
  });
  // A tab that was backgrounded for an hour has a stale row the moment it
  // comes back, and that is exactly when the player looks at it.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - _snap.loadedAt > 60_000) {
      void refreshGiveaways();
      // The trip that most often changes a promo is the one the player just
      // took: out to Discord, link the account, come back.
      void refreshPromos();
    }
  });
}

/** The shared snapshot. Binds the socket + poll on first use, so no shell
 *  component has to know this module exists. */
export function useGiveaways(): GiveawaySnapshot {
  const [s, setS] = useState(_snap);
  useEffect(() => {
    _listeners.add(setS);
    bind();
    // A later mount (e.g. opening the dialog) must not sit on a snapshot from
    // ten minutes ago while the poll timer idles.
    if (_snap.loadedAt === 0) void refreshGiveaways();
    else schedule();
    setS(_snap);
    return () => {
      _listeners.delete(setS);
      if (_listeners.size === 0 && _timer !== undefined) {
        window.clearTimeout(_timer);
        _timer = undefined;
      }
    };
  }, []);
  return s;
}
