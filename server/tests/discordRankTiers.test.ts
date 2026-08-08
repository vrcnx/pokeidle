// The Discord rank curve. Pure arithmetic, no database.
//
// The property this file cares about most is the one lib/discordXp.ts's
// header demands: NOTHING here pays money. That is asserted directly rather
// than left as a convention, because the convention is one careless `{ kind:
// "money" }` away from putting a faucet on the economy whose tap is typing in
// a text box.

import { describe, expect, it } from "vitest";
import {
  EARLY_RANKS, TAIL_STEP, MASTERBALL_EVERY,
  tiersReachedAtRank, rankForTier, nextTierRank, rewardForTier, rewardsBetween,
} from "../src/lib/discordRankTiers.js";

describe("the curve", () => {
  it("pays nothing below the first rank", () => {
    for (let r = 0; r < EARLY_RANKS[0]; r++) {
      expect(tiersReachedAtRank(r)).toBe(0);
    }
    expect(rewardForTier(0)).toEqual([]);
  });

  it("hands out the early ranks exactly where they are placed", () => {
    EARLY_RANKS.forEach((rank, i) => {
      expect(tiersReachedAtRank(rank)).toBe(i + 1);
      // One below must NOT have reached it. Off-by-one here pays a rank early,
      // which is the kind of bug nobody reports.
      expect(tiersReachedAtRank(rank - 1)).toBe(i);
      expect(rankForTier(i + 1)).toBe(rank);
    });
  });

  it("keeps stepping past the hand-placed ranks, forever", () => {
    const last = EARLY_RANKS[EARLY_RANKS.length - 1];
    for (let n = 1; n <= 200; n++) {
      const tier = EARLY_RANKS.length + n;
      expect(rankForTier(tier)).toBe(last + n * TAIL_STEP);
      expect(tiersReachedAtRank(last + n * TAIL_STEP)).toBe(tier);
    }
  });

  it("round-trips rank and tier at every tier for a long way up", () => {
    for (let tier = 1; tier <= 500; tier++) {
      expect(tiersReachedAtRank(rankForTier(tier))).toBe(tier);
    }
  });

  it("never reports a next rank at or below where you stand", () => {
    for (let rank = 0; rank <= 400; rank++) {
      expect(nextTierRank(rank)).toBeGreaterThan(rank);
    }
  });
});

describe("what it pays", () => {
  it("never pays money — this is the whole reason it is allowed to exist", () => {
    for (let tier = 1; tier <= 300; tier++) {
      for (const p of rewardForTier(tier)) {
        expect(p.kind).toBe("item");
      }
    }
    // And the same through the merge path, which is where a stray money prize
    // would actually reach a player.
    for (const p of rewardsBetween(0, 300)) expect(p.kind).toBe("item");
  });

  it("bands the ball by rank instead of growing the pile", () => {
    const ballAt = (rank: number) => {
      const prize = rewardForTier(tiersReachedAtRank(rank))[0];
      return prize?.kind === "item" ? prize.itemId : null;
    };
    expect(ballAt(5)).toBe("pokeball");
    expect(ballAt(10)).toBe("greatball");
    expect(ballAt(20)).toBe("greatball");
    expect(ballAt(25)).toBe("ultraball");
    expect(ballAt(100)).toBe("ultraball");
  });

  it("puts a Master Ball on every milestone rank and nowhere else", () => {
    for (let tier = 1; tier <= 60; tier++) {
      const rank = rankForTier(tier);
      const hasMaster = rewardForTier(tier).some(
        (p) => p.kind === "item" && p.itemId === "masterball",
      );
      expect(hasMaster).toBe(rank % MASTERBALL_EVERY === 0);
    }
  });
});

describe("back-pay", () => {
  it("owes nothing for standing still or going backwards", () => {
    expect(rewardsBetween(4, 4)).toEqual([]);
    expect(rewardsBetween(6, 3)).toEqual([]);
  });

  it("merges a span into one entry per item rather than one per tier", () => {
    // Someone who links at rank 30 is owed all six early tiers at once.
    const prizes = rewardsBetween(0, tiersReachedAtRank(30));
    const ids = prizes.map((p) => (p.kind === "item" ? p.itemId : "?"));
    expect(new Set(ids).size).toBe(ids.length);
    // Rank 5 pays Poké Balls, 10–20 Great Balls, 25 and 30 Ultra Balls.
    const qty = (id: string) => prizes
      .filter((p) => p.kind === "item" && p.itemId === id)
      .reduce((n, p) => n + (p.kind === "item" ? p.quantity : 0), 0);
    expect(qty("pokeball")).toBe(10);
    expect(qty("greatball")).toBe(30);
    expect(qty("ultraball")).toBe(20);
    expect(qty("masterball")).toBe(1);
  });

  it("pays the same total whether it is taken tier by tier or in one span", () => {
    const total = (prizes: ReturnType<typeof rewardsBetween>) => {
      const m = new Map<string, number>();
      for (const p of prizes) {
        if (p.kind !== "item") continue;
        m.set(p.itemId, (m.get(p.itemId) ?? 0) + p.quantity);
      }
      return m;
    };

    const oneGo = total(rewardsBetween(0, 120));
    const stepwise = new Map<string, number>();
    for (let tier = 1; tier <= 120; tier++) {
      for (const [id, n] of total(rewardForTier(tier))) {
        stepwise.set(id, (stepwise.get(id) ?? 0) + n);
      }
    }
    expect(Object.fromEntries(oneGo)).toEqual(Object.fromEntries(stepwise));
  });

  it("splits at the stack cap instead of clamping", () => {
    // The account-level ladder shipped with a clamp on money and silently
    // deleted about $40M of back-pay. A clamp here would quietly hand over
    // fewer balls than the track promised.
    const prizes = rewardsBetween(0, 400);
    for (const p of prizes) {
      if (p.kind === "item") expect(p.quantity).toBeLessThanOrEqual(999);
    }
    const ultra = prizes
      .filter((p) => p.kind === "item" && p.itemId === "ultraball")
      .reduce((n, p) => n + (p.kind === "item" ? p.quantity : 0), 0);
    // 400 tiers, all but the first three paying Ultra Balls at 10 apiece —
    // comfortably past 999, so this span genuinely exercises the split.
    expect(ultra).toBeGreaterThan(999);
    expect(prizes.filter((p) => p.kind === "item" && p.itemId === "ultraball").length)
      .toBeGreaterThan(1);
  });
});
