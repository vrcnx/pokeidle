// Threshold alerter (lib/alerting.ts). Clock and webhook POST are injected,
// so these tests run with zero I/O and deterministic time.

import { describe, expect, it, vi } from "vitest";
import { Alerter, configFromEnv, type AlertsConfig } from "../src/lib/alerting.js";

function makeAlerter(overrides: Partial<AlertsConfig> = {}) {
  const cfg: AlertsConfig = {
    webhookUrl: "https://discord.example/webhook",
    windowMs: 5 * 60_000,
    spikeThreshold: 10,
    saveRejectThreshold: 20,
    fingerprintCooldownMs: 15 * 60_000,
    maxAlertsPerMinute: 4,
    startupGraceMs: 2 * 60_000,
    ...overrides,
  };
  let t = 1_000_000;
  const clock = {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
  const posts: { url: string; content: string }[] = [];
  const post = vi.fn(async (url: string, payload: { content: string }) => {
    posts.push({ url, content: payload.content });
  });
  const alerter = new Alerter(cfg, { now: clock.now, post });
  return { alerter, clock, posts, post, cfg };
}

const err = (message: string, level: "error" | "warn" = "error") => ({
  message, kind: "server", level, source: "test", meta: { x: 1 },
});

describe("off by default", () => {
  it("does nothing at all when ALERT_WEBHOOK_URL is absent", () => {
    const { alerter, posts, clock } = makeAlerter({ webhookUrl: null });
    clock.advance(10 * 60_000);
    for (let i = 0; i < 100; i++) alerter.noteError(err("pvp_start_battle_failed"));
    for (let i = 0; i < 100; i++) alerter.noteSaveReject("regression_blocked");
    expect(posts).toHaveLength(0);
    expect(alerter.enabled).toBe(false);
  });

  it("configFromEnv: empty env means disabled with sane defaults", () => {
    const cfg = configFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.webhookUrl).toBeNull();
    expect(cfg.windowMs).toBe(300_000);
    expect(cfg.spikeThreshold).toBe(10);
    expect(cfg.saveRejectThreshold).toBe(20);
    expect(cfg.fingerprintCooldownMs).toBe(900_000);
    expect(cfg.maxAlertsPerMinute).toBe(4);
  });

  it("configFromEnv: env values override, garbage falls back", () => {
    const cfg = configFromEnv({
      ALERT_WEBHOOK_URL: " https://x.example/hook ",
      ALERT_SPIKE_THRESHOLD: "3",
      ALERT_WINDOW_MS: "not-a-number",
    } as never);
    expect(cfg.webhookUrl).toBe("https://x.example/hook");
    expect(cfg.spikeThreshold).toBe(3);
    expect(cfg.windowMs).toBe(300_000);
  });
});

describe("new-fingerprint alerts", () => {
  it("alerts once on the first sighting of a new error fingerprint", () => {
    const { alerter, clock, posts } = makeAlerter();
    clock.advance(3 * 60_000); // past startup grace
    alerter.noteError(err("pvp_start_battle_failed"));
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain("new error fingerprint");
    expect(posts[0].content).toContain("server:pvp_start_battle_failed");
    // Second occurrence of the same fingerprint: no new-fingerprint alert.
    alerter.noteError(err("pvp_start_battle_failed"));
    expect(posts).toHaveLength(1);
  });

  it("stays quiet during the startup grace period (deploy restart != news)", () => {
    const { alerter, posts, clock } = makeAlerter();
    clock.advance(60_000); // inside the 2min grace
    alerter.noteError(err("some_error"));
    expect(posts).toHaveLength(0);
  });

  it("a first-of-its-kind WARN does not page; a warn spike still does", () => {
    const { alerter, clock, posts } = makeAlerter({ spikeThreshold: 5 });
    clock.advance(3 * 60_000);
    alerter.noteError(err("pvp_team_adapted", "warn"));
    expect(posts).toHaveLength(0);
    for (let i = 0; i < 4; i++) alerter.noteError(err("pvp_team_adapted", "warn"));
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain("error spike");
  });
});

describe("spike detection + fingerprint dedupe window", () => {
  it("alerts exactly once when one fingerprint crosses the threshold in a window", () => {
    const { alerter, clock, posts } = makeAlerter({ spikeThreshold: 10 });
    clock.advance(3 * 60_000);
    alerter.noteError(err("save_write_failed")); // new-fingerprint alert (1)
    for (let i = 0; i < 30; i++) alerter.noteError(err("save_write_failed"));
    // Spike at count 10 is suppressed by the 15min per-fingerprint cooldown
    // (the new-fingerprint alert just fired) — no storm.
    expect(posts).toHaveLength(1);
    // After the cooldown, a fresh window spike alerts again.
    clock.advance(16 * 60_000);
    for (let i = 0; i < 10; i++) alerter.noteError(err("save_write_failed"));
    expect(posts).toHaveLength(2);
    expect(posts[1].content).toContain("error spike");
    expect(posts[1].content).toContain("10 events");
  });

  it("counts reset when the rolling window expires", () => {
    const { alerter, clock, posts } = makeAlerter({
      spikeThreshold: 10,
      fingerprintCooldownMs: 0,
    });
    clock.advance(3 * 60_000);
    alerter.noteError(err("e1")); // new fp alert
    posts.length = 0;
    clock.advance(6 * 60_000); // roll the window so the count starts fresh
    // 9 events, window rolls, 9 more: never reaches 10 inside one window.
    for (let i = 0; i < 9; i++) alerter.noteError(err("e1"));
    clock.advance(6 * 60_000);
    for (let i = 0; i < 9; i++) alerter.noteError(err("e1"));
    expect(posts).toHaveLength(0);
  });

  it("distinct fingerprints do not pool into one spike", () => {
    const { alerter, clock, posts } = makeAlerter({ spikeThreshold: 10, startupGraceMs: 0 });
    clock.advance(1);
    posts.length = 0;
    for (let i = 0; i < 9; i++) alerter.noteError({ ...err(`unique_${i}`), level: "warn" });
    expect(posts).toHaveLength(0);
  });
});

describe("global rate limit (webhook storm brake)", () => {
  it("caps posts per minute and reports the suppressed count on the next send", () => {
    const { alerter, clock, posts } = makeAlerter({ maxAlertsPerMinute: 2 });
    clock.advance(3 * 60_000);
    // 6 distinct new fingerprints in one minute → only 2 posts.
    for (let i = 0; i < 6; i++) alerter.noteError(err(`boom_${i}`));
    expect(posts).toHaveLength(2);
    // A minute later the bucket refills; the next alert mentions what was dropped.
    clock.advance(61_000);
    alerter.noteError(err("boom_late"));
    expect(posts).toHaveLength(3);
    expect(posts[2].content).toContain("4 alert(s) suppressed");
  });
});

describe("save-reject spike", () => {
  it("alerts with a reason breakdown when regression-class rejects cross the threshold", () => {
    const { alerter, clock, posts } = makeAlerter({ saveRejectThreshold: 20 });
    clock.advance(3 * 60_000);
    for (let i = 0; i < 12; i++) alerter.noteSaveReject("versionless_regression");
    for (let i = 0; i < 7; i++) alerter.noteSaveReject("regression_blocked");
    expect(posts).toHaveLength(0); // 19 — one short
    alerter.noteSaveReject("validation: money out of range");
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain("save-reject spike");
    expect(posts[0].content).toContain("12× versionless_regression");
    expect(posts[0].content).toContain("7× regression_blocked");
  });

  it("reject counter resets with the window", () => {
    const { alerter, clock, posts } = makeAlerter({ saveRejectThreshold: 20 });
    clock.advance(3 * 60_000);
    for (let i = 0; i < 19; i++) alerter.noteSaveReject("versionless_regression");
    clock.advance(6 * 60_000); // window expires
    for (let i = 0; i < 19; i++) alerter.noteSaveReject("versionless_regression");
    expect(posts).toHaveLength(0);
  });
});

describe("robustness", () => {
  it("a throwing webhook never propagates to the caller", () => {
    const cfg: AlertsConfig = { ...makeAlerter().cfg };
    let t = 10_000_000;
    const alerter = new Alerter(cfg, {
      now: () => t,
      post: async () => { throw new Error("webhook down"); },
    });
    t += 3 * 60_000;
    expect(() => alerter.noteError(err("boom"))).not.toThrow();
  });
});

// Config for the hostile-input tests. Spelled out rather than reusing
// makeAlerter(), which builds its own clock and post spy.
function hostileCfg(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    webhookUrl: "https://example.invalid/hook",
    windowMs: 5 * 60_000,
    spikeThreshold: 10,
    saveRejectThreshold: 20,
    fingerprintCooldownMs: 15 * 60_000,
    maxAlertsPerMinute: 4,
    startupGraceMs: 0,
    ...overrides,
  };
}

// ── Hostile client input (added after the security review) ──────────────
// POST /api/bug-reports/client-error feeds recordError with a message the
// PLAYER controls, so that string reaches the alerter. These pin the three
// ways that could be abused once a webhook is configured.
describe("client-reported errors cannot be weaponised", () => {
  it("collapses every client message into one fingerprint", () => {
    const sent: string[] = [];
    const a = new Alerter(
      hostileCfg({ startupGraceMs: 0 }),
      { now: () => 1_000_000, post: async (_u, p) => { sent.push(p.content); } },
    );
    for (let i = 0; i < 300; i++) {
      a.noteError({ kind: "client", level: "error", message: `unique-${i}`, source: "x" });
    }
    // One bucket, not 300 — so no unbounded map and no per-message page.
    expect(a.trackedFingerprintCount).toBe(1);
  });

  it("never fires a new-fingerprint alert for a client message", () => {
    const sent: string[] = [];
    const a = new Alerter(
      hostileCfg({ startupGraceMs: 0 }),
      { now: () => 1_000_000, post: async (_u, p) => { sent.push(p.content); } },
    );
    a.noteError({ kind: "client", level: "error", message: "@everyone pwned", source: "x" });
    expect(sent.filter((c) => c.includes("new error fingerprint"))).toHaveLength(0);
  });

  it("stops tracking new fingerprints past the ceiling", () => {
    const a = new Alerter(
      hostileCfg({ startupGraceMs: 1e9 }),
      { now: () => 1_000_000, post: async () => {} },
    );
    for (let i = 0; i < 900; i++) {
      a.noteError({ kind: "server", level: "warn", message: `svc-${i}`, source: "x" });
    }
    expect(a.trackedFingerprintCount).toBeLessThanOrEqual(500);
  });
});
