import type { GiveawayStats, PublicGiveaway } from "../net/api";

// What the standing giveaway control in the left rail should say.
//
// The control is one 42px row and it is the ONLY always-present giveaway
// affordance in the game, so the interesting part is not the pixels — it is
// deciding which of six things is worth saying in the space of one line. That
// decision is pure, so it lives here and is tested against the real production
// shapes rather than eyeballed in a browser.
//
// Why this needed a state machine at all, from the production rows:
//   * something is live 84% of the time (252 of 300 hours), so "live" is the
//     common case and "nothing running" is a real, recurring 38-hour state —
//     both have to look deliberate, and neither may make the row disappear;
//   * four giveaways were published in one burst, so "a live giveaway" is not
//     always singular, and "2 live · 1 not entered" is the only honest line;
//   * a giveaway can be open, entered, and hours from drawing, which is a
//     calm state that must not shout;
//   * winning is the one thing worth interrupting for, and only briefly.

/** How long after a draw a win still leads the rail. */
export const WIN_BANNER_MS = 48 * 60 * 60 * 1000;

export type RailKind =
  | "loading"
  | "offline"
  | "won"
  | "live-unentered"
  | "live-entered"
  | "live-mixed"
  | "idle";

/** Colour/emphasis bucket. Colour is the only PERMANENT differentiator — the
 *  pulse stops, the tone does not. */
export type RailTone = "won" | "urgent" | "calm" | "quiet";

export interface RailState {
  kind: RailKind;
  tone: RailTone;
  /** Which giveaway the dialog should open on and scroll to. */
  targetId: string | null;
  /** The giveaway the row is talking about, for its prize label. */
  primary: PublicGiveaway | null;
  /** Live giveaways (status "open" and not past their close time). */
  liveCount: number;
  /** …of which this many the player has not entered. */
  unenteredCount: number;
  /** ms until `primary` closes; null when it has no deadline. May be <= 0
   *  while the 15s auto-draw sweep catches up. */
  endsInMs: number | null;
  /** Public giveaways ever held — the idle line's proof that this recurs. */
  totalHeld: number;
  /** Most recent finished giveaway's title, for the idle line. */
  lastTitle: string | null;
  /** Whether to run the attention pulse. Never for a state the player has
   *  already dealt with. */
  pulse: boolean;
}

export interface RailInput {
  giveaways: PublicGiveaway[] | null;
  stats: GiveawayStats | null;
  now: number;
  /** Wins the player has already opened the dialog on. Keeps a 48h win from
   *  nagging someone who has already looked at it. */
  seenWins?: ReadonlySet<string>;
  /**
   * The store's last fetch error, if the store has never managed a successful
   * fetch. Without this the row said "Checking…" FOREVER whenever the very
   * first load failed — signed out mid-session, offline, server restarting —
   * because the store deliberately keeps its previous snapshot on failure and
   * a client that never had one keeps `giveaways: null`. "Checking…" that
   * never resolves is the one thing the always-present control must not do:
   * it is the single row in the rail whose entire job is to look deliberate.
   */
  error?: string | null;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Live = the operator says open AND the schedule agrees. Mirrors the
 *  server's isEnterable so the row never offers an entry the server refuses. */
export function isLiveNow(g: PublicGiveaway, now: number): boolean {
  if (g.status !== "open") return false;
  const start = ms(g.startsAt);
  if (start != null && start > now) return false;
  const end = ms(g.endsAt);
  if (end != null && end <= now) return false;
  return true;
}

/**
 * Which live giveaway leads the row. Unentered first (that is the one with
 * something to do), then whichever closes soonest, then the newest — a
 * giveaway with no deadline must not outrank one that closes in ten minutes.
 */
function pickPrimaryLive(live: PublicGiveaway[], now: number): PublicGiveaway | null {
  if (live.length === 0) return null;
  const rank = (g: PublicGiveaway) => {
    const end = ms(g.endsAt);
    return [
      g.hasEntered ? 1 : 0,
      end != null ? 0 : 1,
      end != null ? end - now : 0,
      -(ms(g.createdAt) ?? 0),
    ] as const;
  };
  return [...live].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  })[0];
}

export function railState(input: RailInput): RailState {
  const { giveaways, stats, now, seenWins, error } = input;
  const base: RailState = {
    kind: "loading",
    tone: "quiet",
    targetId: null,
    primary: null,
    liveCount: 0,
    unenteredCount: 0,
    endsInMs: null,
    totalHeld: stats?.total ?? 0,
    lastTitle: null,
    pulse: false,
  };
  // Nothing has ever loaded. Either it is still in flight ("loading", a
  // transient state that resolves on its own) or the fetch failed and there is
  // nothing behind it ("offline", which does NOT resolve on its own and must
  // therefore say something a player can act on). Note the order: `error` is
  // only consulted when there is no data at all — a flaky poll on top of a
  // good snapshot keeps showing the snapshot, which is what the store's own
  // catch branch is for.
  if (giveaways == null) return error ? { ...base, kind: "offline" } : base;

  const finished = giveaways
    .filter((g) => g.status !== "open")
    .sort((a, b) => (ms(b.drawnAt) ?? ms(b.createdAt) ?? 0) - (ms(a.drawnAt) ?? ms(a.createdAt) ?? 0));
  const totalHeld = stats?.total ?? giveaways.length;
  const lastTitle = finished[0]?.title ?? null;

  // 1. A fresh win outranks everything. It is the one giveaway state worth
  //    interrupting for, and it expires on its own so it cannot become
  //    permanent chrome.
  const freshWin = finished.find((g) => {
    if (!g.youWon) return false;
    const drawn = ms(g.drawnAt);
    if (drawn == null) return false;
    return now - drawn <= WIN_BANNER_MS && now >= drawn;
  });
  if (freshWin) {
    return {
      ...base,
      kind: "won",
      tone: "won",
      targetId: freshWin.id,
      primary: freshWin,
      totalHeld,
      lastTitle,
      pulse: !seenWins?.has(freshWin.id),
    };
  }

  const live = giveaways.filter((g) => isLiveNow(g, now));
  const unentered = live.filter((g) => !g.hasEntered);

  // 2. Nothing running. Still a row, still the same height, just quiet —
  //    disappearing chrome is exactly how this feature became invisible.
  if (live.length === 0) {
    return { ...base, kind: "idle", tone: "quiet", totalHeld, lastTitle };
  }

  const primary = pickPrimaryLive(live, now);
  const end = primary ? ms(primary.endsAt) : null;
  const common = {
    ...base,
    targetId: primary?.id ?? null,
    primary,
    liveCount: live.length,
    unenteredCount: unentered.length,
    endsInMs: end != null ? end - now : null,
    totalHeld,
    lastTitle,
  };

  if (unentered.length === 0) {
    // 3. Entered everything that is running. Calm and green: there is nothing
    //    to do, and saying so is the point.
    return { ...common, kind: "live-entered", tone: "calm", pulse: false };
  }
  // 4/5. Something to enter. Mixed when the player is already in some of them,
  //      because "2 live" alone would read as "you have missed two".
  return {
    ...common,
    kind: live.length > unentered.length ? "live-mixed" : "live-unentered",
    tone: "urgent",
    pulse: true,
  };
}

// ── Time, in pieces the caller can translate ────────────────────────
//
// Returned as {unit, value} rather than a formatted string so the i18n layer
// can compose it (the app translates literal English fragments) and so the
// arithmetic is testable without depending on the machine's timezone.

export type RelUnit = "now" | "min" | "hour" | "day" | "date";
export interface RelTime {
  unit: RelUnit;
  value: number;
}

/** How long ago `then` was. "date" means: too old for a relative phrase,
 *  print the actual date. */
export function relativeTime(then: number, now: number): RelTime {
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return { unit: "now", value: 0 };
  if (diff < 3_600_000) return { unit: "min", value: Math.floor(diff / 60_000) };
  if (diff < 86_400_000) return { unit: "hour", value: Math.floor(diff / 3_600_000) };
  if (diff < 7 * 86_400_000) return { unit: "day", value: Math.floor(diff / 86_400_000) };
  return { unit: "date", value: then };
}

export interface Countdown {
  d: number;
  h: number;
  m: number;
  s: number;
  /** True once the deadline has passed — the draw sweep runs every 15s. */
  ended: boolean;
  /** Last hour. The row and the card both go red on this. */
  urgent: boolean;
}

export function countdown(untilMs: number): Countdown {
  if (untilMs <= 0) return { d: 0, h: 0, m: 0, s: 0, ended: true, urgent: true };
  return {
    d: Math.floor(untilMs / 86_400_000),
    h: Math.floor((untilMs % 86_400_000) / 3_600_000),
    m: Math.floor((untilMs % 3_600_000) / 60_000),
    s: Math.floor((untilMs % 60_000) / 1000),
    ended: false,
    urgent: untilMs < 3_600_000,
  };
}

/** Compact countdown for the rail: one unit pair, never seconds unless close. */
export function shortCountdown(untilMs: number): string {
  const c = countdown(untilMs);
  if (c.ended) return "";
  if (c.d > 0) return `${c.d}d ${c.h}h`;
  if (c.h > 0) return `${c.h}h ${c.m}m`;
  if (c.m > 0) return `${c.m}m`;
  return `${c.s}s`;
}
