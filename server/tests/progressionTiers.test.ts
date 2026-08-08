// The level-reward ladder.
//
// Two facts about `accountLevel` drive every test here, and both are easy to
// forget when reading the curve on its own:
//
//   THE CEILING IS 100,050. It is `floor(totalCaughtLevels / 10)` over party +
//   box, and the box holds 9,999 Pokemon at level 100. So "infinite" means
//   four orders of magnitude, and anything in this file that walked the tiers
//   would be a 100,000-iteration loop on a path that runs every 2.5 seconds
//   per player.
//
//   LEVEL CAN GO DOWN, because it is derived from what you currently HOLD.
//   That is handled by the claim ledger rather than here, but it is why these
//   functions are pure and why "tiers reached at a level" is a question with
//   an answer independent of history.

import { describe, expect, it } from "vitest";
import {
  tiersReachedAt, levelForTier, nextTierLevel, rewardForTier, rewardsBetween,
  TAIL_STEP, MASTERBALL_EVERY,
} from "../src/lib/progressionTiers.js";

describe("the ladder's two directions agree", () => {
  it("round-trips every tier, from the first to well past the ceiling", () => {
    // The property that matters most. If these disagree by one anywhere, the
    // ledger pays the wrong tier — or pays one twice, which is worse.
    for (let n = 1; n <= 4100; n++) {
      const level = levelForTier(n);
      expect(tiersReachedAt(level), `tier ${n} at level ${level}`).toBe(n);
      // And one level BELOW a tier must not count it.
      expect(tiersReachedAt(level - 1), `just under tier ${n}`).toBe(n - 1);
    }
  });

  it("pays nothing before the first tier", () => {
    expect(tiersReachedAt(0)).toBe(0);
    expect(tiersReachedAt(4)).toBe(0);
    expect(tiersReachedAt(5)).toBe(1);
  });

  it("survives nonsense without inventing tiers", () => {
    // `accountLevel` comes from a derived save field; a NaN reaching here
    // should pay nobody rather than throw inside a save upload.
    expect(tiersReachedAt(Number.NaN)).toBe(0);
    expect(tiersReachedAt(-50)).toBe(0);
    expect(tiersReachedAt(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("keeps a constant interval in the tail", () => {
    const a = levelForTier(200);
    const b = levelForTier(201);
    expect(b - a).toBe(TAIL_STEP);
  });

  it("names the next level worth reaching", () => {
    expect(nextTierLevel(0)).toBe(5);
    expect(nextTierLevel(100)).toBe(125);
    expect(nextTierLevel(1197)).toBe(1200);
  });
});

describe("it stays O(1) at the ceiling", () => {
  it("answers for level 100,050 as fast as for level 5", () => {
    // Not a benchmark — a guard against someone replacing the arithmetic with
    // a loop. At the ceiling a per-level walk is 100,000 iterations, and this
    // runs inside the save-upload transaction.
    const start = performance.now();
    for (let i = 0; i < 20_000; i++) {
      tiersReachedAt(100_050);
      levelForTier(4_000);
    }
    const ms = performance.now() - start;
    expect(ms, `40,000 lookups took ${ms.toFixed(0)}ms`).toBeLessThan(250);
  });
});

describe("a tier is worth something at every level", () => {
  it("scales money with the level, so a tier never becomes pocket change", () => {
    const early = moneyIn(rewardForTier(tiersReachedAt(50)));
    const mid = moneyIn(rewardForTier(tiersReachedAt(500)));
    const late = moneyIn(rewardForTier(tiersReachedAt(5000)));
    expect(mid).toBeGreaterThan(early * 5);
    expect(late).toBeGreaterThan(mid * 5);
  });

  it("upgrades the ball rather than piling up the count", () => {
    // A stack of 200 Poke Balls is not a reward at level 900; a better ball
    // is. The quantity stays readable at every tier.
    const at20 = itemsIn(rewardForTier(tiersReachedAt(20)));
    const at900 = itemsIn(rewardForTier(tiersReachedAt(900)));
    expect(at20.get("pokeball")).toBe(5);
    expect(at900.get("ultraball")).toBe(5);
    expect(at900.has("pokeball")).toBe(false);
  });

  it("keeps Master Balls rare, because they are tradeable", () => {
    // An infinite ladder minting them is an infinite supply, so the interval
    // is the only thing bounding the rate.
    const withMb = itemsIn(rewardForTier(tiersReachedAt(MASTERBALL_EVERY)));
    expect(withMb.get("masterball")).toBe(1);
    const without = itemsIn(rewardForTier(tiersReachedAt(MASTERBALL_EVERY + TAIL_STEP)));
    expect(without.has("masterball")).toBe(false);
  });

  it("never mints a prize the schema would reject", () => {
    // A grant that fails validation pays NOTHING, so an out-of-range prize is
    // not a cosmetic problem. Checked at the ceiling, where the curve is
    // largest.
    for (const level of [5, 100, 1200, 10_000, 100_050]) {
      for (const p of rewardForTier(tiersReachedAt(level))) {
        if (p.kind === "money") {
          expect(p.amount, `money at level ${level}`).toBeGreaterThan(0);
          expect(p.amount).toBeLessThanOrEqual(10_000_000);
        }
        if (p.kind === "item") {
          expect(p.quantity, `qty at level ${level}`).toBeGreaterThan(0);
          expect(p.quantity).toBeLessThanOrEqual(9_999);
        }
      }
    }
  });
});

describe("back-pay is one grant, and keeps its full value", () => {
  it("merges a span rather than emitting a prize per tier", () => {
    // A level 1,200 account has crossed 53 tiers. As 53 grants that is 53
    // toasts and 53 inbox rows for one event.
    const tiers = tiersReachedAt(1200);
    expect(tiers).toBeGreaterThan(50);
    const merged = rewardsBetween(0, tiers);
    // One entry per item id, plus however many money prizes the cap needs.
    const itemIds = merged.filter((p) => p.kind === "item").length;
    expect(itemIds).toBeLessThan(6);
  });

  it("SPLITS money past the per-prize cap instead of clamping it", () => {
    // The bug this replaced: clamping made every account past ~level 1,150
    // receive exactly $10,000,000, so a level 5,000 player and a level 1,200
    // player were paid identically and roughly $40M vanished silently.
    const at1200 = moneyIn(rewardsBetween(0, tiersReachedAt(1200)));
    const at5000 = moneyIn(rewardsBetween(0, tiersReachedAt(5000)));
    expect(at1200).toBeGreaterThan(10_000_000);
    expect(at5000).toBeGreaterThan(at1200 * 5);
    // And every individual prize still passes the schema.
    for (const p of rewardsBetween(0, tiersReachedAt(5000))) {
      if (p.kind === "money") expect(p.amount).toBeLessThanOrEqual(10_000_000);
    }
  });

  it("pays a span exactly once — the sum of its parts, no more", () => {
    const whole = moneyIn(rewardsBetween(0, 40));
    const first = moneyIn(rewardsBetween(0, 17));
    const rest = moneyIn(rewardsBetween(17, 40));
    expect(first + rest).toBe(whole);
  });

  it("owes nothing when nothing was crossed", () => {
    expect(rewardsBetween(12, 12)).toEqual([]);
    // A DROPPED level must never produce a negative or a refund. The ledger
    // holds a high-water mark for this reason, but the maths should not
    // misbehave if it is ever handed a backwards span.
    expect(rewardsBetween(30, 12)).toEqual([]);
  });
});

function moneyIn(prizes: ReturnType<typeof rewardForTier>): number {
  return prizes.reduce((s, p) => (p.kind === "money" ? s + p.amount : s), 0);
}
function itemsIn(prizes: ReturnType<typeof rewardForTier>): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of prizes) if (p.kind === "item") m.set(p.itemId, p.quantity);
  return m;
}
