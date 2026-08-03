// The TM Mart's rotation.
//
// The whole mechanic is one function of one integer, which makes it cheap to
// test exhaustively and expensive to get subtly wrong — a rotation that
// mostly works is a rotation where one machine is unreachable and nobody
// finds out for a month. So these check the two properties the design rests
// on, over hundreds of simulated cycles rather than a sample:
//
//   FAIRNESS   — every machine comes around, on a bounded schedule.
//   STABILITY  — the same day always produces the same counter, for
//                everyone, forever. That is what makes "Ice Beam is up
//                today" a true statement about someone else's game.

import { describe, expect, it } from "vitest";
import {
  tmMartStock,
  tmMartPrice,
  TM_MART_POOL,
  TM_MART_SLOTS,
  TM_MART_CYCLE_DAYS,
  rotationDay,
  nextRotationAt,
  daysUntilStocked,
} from "../src/data/tmMart";
import { machineList } from "../src/data/tms";
import { machineSource } from "../src/data/machineSources";

describe("what the counter may sell", () => {
  it("never sells an HM", () => {
    for (const m of TM_MART_POOL) expect(m.kind).toBe("tm");
  });

  it("never sells a raid prize", () => {
    // Hyper Beam, Giga Impact, Solar Beam, Overheat, Explosion. A prize you
    // can wait out at a shop counter is not a prize.
    for (const m of TM_MART_POOL) expect(machineSource[m.id]).not.toBe("raid");
  });

  it("covers every machine that has no other source", () => {
    const shopOnly = machineList.filter((m) => machineSource[m.id] === "mart");
    expect(shopOnly.length).toBeGreaterThan(0);
    for (const m of shopOnly) {
      expect(TM_MART_POOL.some((p) => p.id === m.id), `${m.label} unobtainable`).toBe(true);
    }
  });

  it("charges double for anything a route also drops", () => {
    // The route has to stay the better deal or the drops stop meaning
    // anything. Paying twice is the price of not walking.
    for (const m of TM_MART_POOL) {
      const expected = machineSource[m.id] === "route" ? (m.price ?? 0) * 2 : (m.price ?? 0);
      expect(tmMartPrice(m), m.label).toBe(expected);
    }
  });

  it("never prices anything at zero", () => {
    for (const m of TM_MART_POOL) expect(tmMartPrice(m)).toBeGreaterThan(0);
  });
});

describe("the daily counter", () => {
  it("shows a full counter of distinct machines", () => {
    for (let day = 0; day < 200; day++) {
      const stock = tmMartStock(day);
      expect(stock).toHaveLength(TM_MART_SLOTS);
      expect(new Set(stock.map((m) => m.id)).size).toBe(TM_MART_SLOTS);
    }
  });

  it("is the same counter every time it is asked", () => {
    // Called on every render and every minute tick. If it were not pure the
    // shop would reshuffle under the player's cursor.
    for (const day of [0, 1, 7, 999, 20_300]) {
      expect(tmMartStock(day).map((m) => m.id)).toEqual(tmMartStock(day).map((m) => m.id));
    }
  });

  it("changes from one day to the next", () => {
    // A rotation that repeats is not a rotation.
    let identical = 0;
    for (let day = 0; day < 200; day++) {
      const a = tmMartStock(day).map((m) => m.id).join();
      const b = tmMartStock(day + 1).map((m) => m.id).join();
      if (a === b) identical++;
    }
    expect(identical).toBe(0);
  });

  it("survives a negative day index", () => {
    // Only reachable by a clock set before 1970, but `%` on a negative is
    // negative in JS and a negative slice index reads from the END of the
    // deck — which would silently return a short counter.
    expect(tmMartStock(-1)).toHaveLength(TM_MART_SLOTS);
    expect(tmMartStock(-9_999)).toHaveLength(TM_MART_SLOTS);
  });
});

describe("fairness — the reason it is dealt, not drawn", () => {
  // The first implementation drew independently each day. Over a simulated
  // year every machine did appear, but a specific one could be 28 days out,
  // which is a slot machine rather than a shop. Dealing the pool guarantees
  // the schedule below.
  it("shows every machine exactly once per cycle", () => {
    for (let cycle = 0; cycle < 300; cycle++) {
      const seen = new Map<string, number>();
      for (let d = 0; d < TM_MART_CYCLE_DAYS; d++) {
        for (const m of tmMartStock(cycle * TM_MART_CYCLE_DAYS + d)) {
          seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
        }
      }
      expect(seen.size, `cycle ${cycle} missed a machine`).toBe(TM_MART_POOL.length);
      for (const [id, n] of seen) expect(n, `${id} twice in cycle ${cycle}`).toBe(1);
    }
  });

  it("can always say how long the wait is, and it is never long", () => {
    let worst = 0;
    for (let day = 0; day < 120; day++) {
      for (const m of TM_MART_POOL) {
        const wait = daysUntilStocked(m.id, day);
        expect(wait, `${m.label} unreachable from day ${day}`).not.toBeNull();
        worst = Math.max(worst, wait!);
      }
    }
    // Two cycles is the theoretical bound; anything near it is fine, and a
    // regression to independent draws would blow straight past it.
    expect(worst).toBeLessThanOrEqual(TM_MART_CYCLE_DAYS * 2);
  });

  it("returns null for something the shop never stocks", () => {
    expect(daysUntilStocked("hm03")).toBeNull();
    expect(daysUntilStocked("tm15")).toBeNull(); // Hyper Beam — raid only
    expect(daysUntilStocked("nonsense")).toBeNull();
  });
});

describe("the clock", () => {
  it("advances one day at a time, in UTC", () => {
    const day = 20_000;
    const noon = day * 86_400_000 + 43_200_000;
    expect(rotationDay(noon)).toBe(day);
    expect(rotationDay(noon + 86_400_000)).toBe(day + 1);
  });

  it("restocks at the next midnight, never in the past", () => {
    for (const t of [0, 1, 43_200_000, 86_399_999, 1_900_000_000_000]) {
      const next = nextRotationAt(t);
      expect(next).toBeGreaterThan(t);
      expect(next - t).toBeLessThanOrEqual(86_400_000);
      expect(next % 86_400_000).toBe(0);
    }
  });
});
