// A rate-guard refusal must not be a life sentence.
//
// RaQaR reported two things in one message, and they turned out to be one
// bug: "My account level is also frozen no matter how much pokemons i level
// up or catch" AND "it reseted my progress after i posted pokemon in auction".
//
// The server's rate-of-gain guard refuses an implausible upload with 400. The
// client treated every 400 as a contract violation — a save this server will
// NEVER accept — and latched `permanentlyRejectedRef` for the whole session.
// From that moment:
//
//   * nothing uploaded again, so the server-derived accountLevel froze —
//     exactly his second symptom; and
//   * the server's stored copy stayed pinned at the last ACCEPTED save, so
//     the next saveAdoptSeq bump (listing a Pokemon does one) made the client
//     adopt it wholesale and every hour since the lockout vanished — exactly
//     his first.
//
// The server's own comment reasoned that this was safe: "localStorage is
// written unconditionally, so the player loses nothing but the cloud copy".
// That holds only in a world with no forced adopts, and there are six.
//
// The refusal was never permanent in the first place. The allowance is
//     MONEY_BURST + MONEY_RATE_PER_HOUR x elapsedHours
// monotonic in time since the last accepted save (saveGainGuard.ts:616), so
// the same bytes become acceptable by waiting. The client foreclosing the
// retry is what made a self-healing limit permanent.

import { describe, expect, it } from "vitest";
import {
  moneyAllowanceFor, elapsedHoursFor,
  MONEY_BURST, MONEY_RATE_PER_HOUR, MONEY_ELAPSED_CAP_H,
} from "../src/lib/saveGainGuard";

const MIN = 60_000;
const HOUR = 3_600_000;

describe("the allowance grows with time, so waiting is a real fix", () => {
  it("is strictly larger after a backoff than at the moment of refusal", () => {
    // THE property the client's 10-minute backoff relies on. If this were
    // flat, retrying would be pointless and a latch would be defensible.
    const atRefusal = moneyAllowanceFor(30 * MIN);
    const afterBackoff = moneyAllowanceFor(30 * MIN + 10 * MIN);
    expect(afterBackoff).toBeGreaterThan(atRefusal);
  });

  it("buys back a meaningful amount per backoff, not a rounding error", () => {
    // Ten minutes at MONEY_RATE_PER_HOUR is a sixth of an hour of headroom.
    const gained = moneyAllowanceFor(10 * MIN) - moneyAllowanceFor(0);
    expect(gained).toBeCloseTo(MONEY_RATE_PER_HOUR / 6, 0);
  });

  it("never shrinks as time passes", () => {
    let prev = -1;
    for (const h of [0, 0.25, 0.5, 1, 2, 4, 6, 8, 24]) {
      const a = moneyAllowanceFor(h * HOUR);
      expect(a, `${h}h`).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it("starts at the burst and tops out at the capped elapsed term", () => {
    expect(moneyAllowanceFor(0)).toBe(MONEY_BURST);
    // The cap is why a backoff cannot rescue EVERY case — a long enough
    // lockout still outruns it. That is the argument for not creating long
    // lockouts, which is what this change does.
    const ceiling = MONEY_BURST + MONEY_RATE_PER_HOUR * MONEY_ELAPSED_CAP_H;
    expect(moneyAllowanceFor(999 * HOUR)).toBe(ceiling);
    expect(elapsedHoursFor(999 * HOUR)).toBe(MONEY_ELAPSED_CAP_H);
  });

  it("does not go strange on a clock that jumped backwards", () => {
    // elapsedMs is a difference between two timestamps and can be negative
    // if the device clock moved. A NaN or negative allowance here would
    // refuse every upload forever, which is the bug this file is about.
    expect(elapsedHoursFor(-5000)).toBe(0);
    expect(moneyAllowanceFor(-5000)).toBe(MONEY_BURST);
    expect(Number.isNaN(moneyAllowanceFor(NaN))).toBe(false);
  });
});
