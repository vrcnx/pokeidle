// Threshold alerting on top of recordError / ErrorLog.
//
// WHY THIS EXISTS: a completely dead PvP shipped and ran for an unknown
// number of days because its failures only went to console.error — nothing
// watched the console, nothing paged anyone, and the first report came from
// a player. recordError already funnels every server failure through one
// choke point; this module sits on that choke point and turns three
// conditions into a webhook POST a human actually sees:
//
//   1. A NEW fingerprint appears — an error class this process has never
//      seen before (the "PvP is suddenly failing to start" case).
//   2. An error group SPIKES — one fingerprint crosses a count threshold
//      inside a rolling window (the "something broke at scale" case).
//   3. SAVE REJECTS spike — regression-class refusals from POST /api/saves
//      cross a threshold (the "a bad deploy is eating players' saves" case).
//      Routine stale-save 409s (two-tab races) are deliberately NOT counted.
//
// Payload shape is Discord-webhook-compatible ({ username, content }) since
// the owner is considering a Discord; any receiver that accepts that JSON
// works (Slack via a shim, a tiny relay, etc.).
//
// COST MODEL: ALERT_WEBHOOK_URL unset → `enabled` is false and every entry
// point returns before touching any state. Zero allocations, zero timers,
// zero behaviour change. This module never throws to its caller and never
// calls recordError (that would recurse).
//
// Every threshold is env-tunable; see configFromEnv() and server/.env.example.

import { logger } from "./logger.js";

export interface AlertsConfig {
  /** Discord-compatible webhook URL. Absent/empty = alerting OFF. */
  webhookUrl: string | null;
  /** Rolling window for spike counting (per fingerprint, and for save rejects). */
  windowMs: number;
  /** Events of ONE fingerprint inside a window that count as a spike. */
  spikeThreshold: number;
  /** Regression-class save rejections inside a window that count as a spike. */
  saveRejectThreshold: number;
  /** Minimum gap between two alerts about the SAME fingerprint. */
  fingerprintCooldownMs: number;
  /** Global ceiling on webhook POSTs per minute (storm brake). */
  maxAlertsPerMinute: number;
  /** After boot, how long "new fingerprint" alerts stay muted. Every
   *  fingerprint is "new" right after a deploy restart; without this a
   *  restart under load is an alert storm about errors that are not news.
   *  Spike alerts are NOT muted during the grace period. */
  startupGraceMs: number;
}

const num = (v: string | undefined, dflt: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AlertsConfig {
  return {
    webhookUrl: env.ALERT_WEBHOOK_URL?.trim() || null,
    windowMs: num(env.ALERT_WINDOW_MS, 5 * 60_000),
    spikeThreshold: num(env.ALERT_SPIKE_THRESHOLD, 10),
    saveRejectThreshold: num(env.ALERT_SAVE_REJECT_THRESHOLD, 20),
    fingerprintCooldownMs: num(env.ALERT_FINGERPRINT_COOLDOWN_MS, 15 * 60_000),
    maxAlertsPerMinute: num(env.ALERT_MAX_PER_MINUTE, 4),
    startupGraceMs: num(env.ALERT_STARTUP_GRACE_MS, 2 * 60_000),
  };
}

export interface AlertErrorEvent {
  /** Stable classifier, e.g. "pvp_start_battle_failed". */
  message: string;
  kind: string;
  level: "error" | "warn";
  source?: string | null;
  meta?: Record<string, unknown> | null;
}

interface FingerprintState {
  windowStart: number;
  count: number;
  lastAlertAt: number | null;
}

/** Reserved fingerprint for the save-reject counter so it shares the same
 *  cooldown / rate-limit machinery as everything else. */
const SAVE_REJECT_FP = "__save_rejects__";

/** Cap on distinct save-reject reasons tracked per window — reasons carry
 *  validator text and could otherwise grow without bound. */
const MAX_REJECT_REASONS = 20;

/** Discord hard limit is 2000 chars on `content`. */
const MAX_CONTENT = 1900;

export interface AlerterDeps {
  now?: () => number;
  /** POST the payload. Default posts via global fetch with a 5s timeout. */
  post?: (url: string, payload: { username: string; content: string }) => Promise<void>;
}

async function defaultPost(url: string, payload: { username: string; content: string }): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // allowed_mentions is not optional politeness. Alert text can embed a
    // client-supplied error message (POST /api/bug-reports/client-error feeds
    // recordError), so without this a player could put @everyone in an error
    // string and ping the whole Discord through our own alerter.
    body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5_000),
  });
  // Discord returns 204 on success. Anything else is worth one warn line
  // (never an ErrorLog row — alerting about alerting is a loop).
  if (!res.ok && res.status !== 204) {
    logger.warn("[alerting] webhook responded non-ok", { status: res.status });
  }
}

/** Hard ceiling on tracked fingerprints. Real server-side error classes number
 *  in the dozens; anything approaching this is a cardinality bug or an attack. */
const MAX_TRACKED_FINGERPRINTS = 500;

export class Alerter {
  private readonly cfg: AlertsConfig;
  private readonly now: () => number;
  private readonly post: NonNullable<AlerterDeps["post"]>;
  private readonly startedAt: number;
  private readonly fingerprints = new Map<string, FingerprintState>();
  /** Timestamps of the webhook POSTs sent in the trailing minute. */
  private sentAt: number[] = [];
  /** Alerts dropped by the global rate limit since the last successful send. */
  private suppressed = 0;
  private rejectWindowStart: number;
  private rejectCount = 0;
  private rejectReasons = new Map<string, number>();

  constructor(cfg: AlertsConfig, deps: AlerterDeps = {}) {
    this.cfg = cfg;
    this.now = deps.now ?? Date.now;
    this.post = deps.post ?? defaultPost;
    this.startedAt = this.now();
    this.rejectWindowStart = this.startedAt;
  }

  /** Test/ops visibility into map growth — see MAX_TRACKED_FINGERPRINTS. */
  get trackedFingerprintCount(): number {
    return this.fingerprints.size;
  }

  get enabled(): boolean {
    return !!this.cfg.webhookUrl;
  }

  /** Feed every recordError() event through here. Never throws. */
  noteError(e: AlertErrorEvent): void {
    if (!this.enabled) return;
    try {
      const now = this.now();
      // Fingerprint = (kind, message) — the same grouping the admin errors
      // dashboard uses, so an alert names a group the operator can find.
      // Client-reported errors carry an ATTACKER-CONTROLLED message, so the
      // raw string cannot be the grouping key: one hostile account could mint
      // an unbounded number of distinct fingerprints (unbounded memory) and
      // saturate the global alert budget with novel "new fingerprint" pages,
      // drowning real breakage. Client events collapse to ONE bucket and are
      // never eligible for the new-fingerprint page below.
      const clientReported = e.kind === "client";
      const fp = clientReported
        ? "client:(reported)"
        : `${e.kind}:${trim(e.message, 200)}`;
      let st = this.fingerprints.get(fp);
      const isNew = !st;
      // Backstop for any other unbounded-cardinality source we have not
      // thought of: stop tracking new keys rather than growing forever. Spike
      // detection for keys already known keeps working.
      if (isNew && this.fingerprints.size >= MAX_TRACKED_FINGERPRINTS) return;
      if (!st) {
        st = { windowStart: now, count: 0, lastAlertAt: null };
        this.fingerprints.set(fp, st);
      }
      if (now - st.windowStart > this.cfg.windowMs) {
        st.windowStart = now;
        st.count = 0;
      }
      st.count += 1;

      // New fingerprint: only for level "error" (a first-of-its-kind warn is
      // operational bookkeeping, not a page), and only after the startup
      // grace period (post-deploy, everything is "new").
      if (isNew && !clientReported && e.level === "error" && now - this.startedAt > this.cfg.startupGraceMs) {
        this.send(fp, st, [
          `🆕 **new error fingerprint**: \`${fp}\``,
          e.source ? `source: \`${e.source}\`` : null,
          e.meta ? `sample meta: \`${trim(safeJson(e.meta), 400)}\`` : null,
        ]);
        return;
      }

      // Spike: exactly at the threshold so one window produces one alert;
      // the per-fingerprint cooldown covers the window-boundary edge.
      if (st.count === this.cfg.spikeThreshold) {
        this.send(fp, st, [
          `📈 **error spike**: \`${fp}\` hit ${st.count} events in ${Math.round(this.cfg.windowMs / 60_000)}min`,
          e.source ? `latest source: \`${e.source}\`` : null,
          e.meta ? `latest meta: \`${trim(safeJson(e.meta), 400)}\`` : null,
        ]);
      }
    } catch (err) {
      logger.warn("[alerting] noteError failed", { err: String(err) });
    }
  }

  /**
   * Feed regression-class save rejections (POST /api/saves) through here —
   * validation 400s, milestone-regression 409s, versionless-regression 400s.
   * NOT plain stale-save 409s: those are the normal two-tab race resolving
   * itself and would drown the signal.
   */
  noteSaveReject(reason: string): void {
    if (!this.enabled) return;
    try {
      const now = this.now();
      if (now - this.rejectWindowStart > this.cfg.windowMs) {
        this.rejectWindowStart = now;
        this.rejectCount = 0;
        this.rejectReasons.clear();
      }
      this.rejectCount += 1;
      const key = this.rejectReasons.size >= MAX_REJECT_REASONS && !this.rejectReasons.has(reason)
        ? "(other)"
        : reason;
      this.rejectReasons.set(key, (this.rejectReasons.get(key) ?? 0) + 1);

      if (this.rejectCount === this.cfg.saveRejectThreshold) {
        let st = this.fingerprints.get(SAVE_REJECT_FP);
        if (!st) {
          st = { windowStart: now, count: 0, lastAlertAt: null };
          this.fingerprints.set(SAVE_REJECT_FP, st);
        }
        const breakdown = [...this.rejectReasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([r, c]) => `${c}× ${r}`)
          .join(", ");
        this.send(SAVE_REJECT_FP, st, [
          `🛑 **save-reject spike**: ${this.rejectCount} regression-class rejections in ${Math.round(this.cfg.windowMs / 60_000)}min`,
          `breakdown: ${trim(breakdown, 600)}`,
        ]);
      }
    } catch (err) {
      logger.warn("[alerting] noteSaveReject failed", { err: String(err) });
    }
  }

  /** Dedupe (per-fingerprint cooldown) + global rate limit + fire-and-forget POST. */
  private send(fp: string, st: FingerprintState, lines: (string | null)[]): void {
    const now = this.now();
    if (st.lastAlertAt !== null && now - st.lastAlertAt < this.cfg.fingerprintCooldownMs) return;

    // Global storm brake: at most maxAlertsPerMinute POSTs in any minute.
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= this.cfg.maxAlertsPerMinute) {
      this.suppressed += 1;
      return;
    }
    this.sentAt.push(now);
    st.lastAlertAt = now;

    const parts = lines.filter((l): l is string => !!l);
    if (this.suppressed > 0) {
      parts.push(`(+${this.suppressed} alert(s) suppressed by the rate limit since the last send)`);
      this.suppressed = 0;
    }
    const content = trim(parts.join("\n"), MAX_CONTENT);
    // Fire-and-forget: an alert must never delay or fail the request path
    // that produced the error it is about.
    void this.post(this.cfg.webhookUrl!, { username: "pokeidle alerts", content }).catch((err) => {
      logger.warn("[alerting] webhook post failed", { err: String(err) });
    });
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function trim(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── Process-wide singleton ────────────────────────────────────────────
// Constructed once from env. recordError() calls notifyErrorEvent on every
// event; routes/saves.ts calls noteSaveReject on regression-class refusals.
export const alerter = new Alerter(configFromEnv());

export function notifyErrorEvent(e: AlertErrorEvent): void {
  alerter.noteError(e);
}

export function noteSaveReject(reason: string): void {
  alerter.noteSaveReject(reason);
}
