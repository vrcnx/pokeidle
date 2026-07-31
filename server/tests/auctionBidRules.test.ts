// Pure arithmetic of the auction bidding rules.
//
// The GOLDEN_SEQUENCES below are the exact tables the owner was shown and
// signed off on. They are duplicated verbatim in game/tests/auctionBidRules
// .test.ts against the client mirror, so if either copy of the rule drifts
// from the other, that copy's own suite goes red.

import { describe, expect, it } from "vitest";
import {
  MAX_BID,
  MAX_CONTEST_MULTIPLIER,
  MIN_STARTING_BID,
  baseStepFor,
  concentrationRatio,
  contestMultiplier,
  formatMoney,
  minAcceptableBid,
  minIncrementFor,
  resolveProxy,
} from "../src/lib/auctionBidRules.js";

/** Walk an auction, one bid at a time, returning the minimum acceptable bid
 *  at each step. `distinctOf` says how many distinct bidders exist after n
 *  bids, and `isNew` whether the (n+1)th bidder has bid here before. */
function walk(
  startingBid: number,
  bids: number,
  distinctOf: (n: number) => number,
  isNew: (n: number) => boolean,
): number[] {
  const out: number[] = [];
  let cur = 0;
  for (let n = 0; n < bids; n++) {
    const min = minAcceptableBid(
      { startingBid, currentBid: cur },
      { bidCount: n, distinctBidders: distinctOf(n), bidderIsNew: isNew(n) },
    );
    out.push(min);
    cur = min; // everyone bids exactly the minimum — the worst case for creep
  }
  return out;
}

/** Two accounts trading raises: distinct saturates at 2, nobody is new after #2. */
const war = {
  distinctOf: (n: number) => Math.min(n, 2),
  isNew: (n: number) => n < 2,
};
/** Every bid from a different account: distinct === n, everyone is new. */
const healthy = {
  distinctOf: (n: number) => n,
  isNew: () => true,
};

describe("baseStepFor — tiered, not a flat percentage", () => {
  it.each([
    // The bottom rung keeps the 10% rail honest at the listing floor: a $500
    // lot used to carry a $100 (20%) minimum raise, the harshest relative
    // increment in the whole schedule, on the thinnest-liquidity band.
    [0, 50],
    [1, 50],
    [500, 50],
    [999, 50],
    [1_000, 100],
    [9_999, 100],
    [10_000, 500],
    [99_999, 500],
    [100_000, 2_500],
    [499_999, 2_500],
    [500_000, 10_000],
    [1_999_999, 10_000],
    [2_000_000, 50_000],
    [9_999_999, 50_000],
    [10_000_000, 250_000],
    [100_000_000, 250_000],
    [MAX_BID, 250_000],
  ])("currentBid %i -> base step %i", (cur, step) => {
    expect(baseStepFor(cur)).toBe(step);
  });

  // MEASURED, not assumed. The sizing note said "0.5%-2.5% of the price
  // inside that tier"; the real span at a tier FLOOR is 2.0%-5.0% (the
  // $10,000 row of the signed-off table itself says 5.00%), decaying to
  // 0.50% at every tier top. The tiers are unchanged — this is the honest
  // statement of what they do.
  it("each tier's step is 0.5% of price at its top and at most 5% at its floor", () => {
    const tiers: Array<[number, number]> = [
      [10_000, 100_000], [100_000, 500_000], [500_000, 2_000_000], [2_000_000, 10_000_000],
    ];
    for (const [floor, top] of tiers) {
      expect((baseStepFor(floor) / floor) * 100).toBeLessThanOrEqual(5);
      expect((baseStepFor(floor) / floor) * 100).toBeGreaterThanOrEqual(2);
      expect((baseStepFor(top - 1) / (top - 1)) * 100).toBeCloseTo(0.5, 2);
    }
    expect((baseStepFor(10_000_000) / 10_000_000) * 100).toBe(2.5);
  });
});

describe("concentrationRatio — distinct bidders, not raw bid count", () => {
  it("holds at 1.00 when every bid comes from a different account", () => {
    for (let n = 1; n < 40; n++) {
      expect(concentrationRatio(n, n, true)).toBe(1);
    }
  });

  it("climbs linearly when two accounts trade raises", () => {
    expect(concentrationRatio(1, 1, true)).toBe(1);
    expect(concentrationRatio(3, 2, false)).toBe(2);
    expect(concentrationRatio(9, 2, false)).toBe(5);
    expect(concentrationRatio(39, 2, false)).toBe(20);
  });

  // The sizing note claimed the 10th distinct player on a 20-bid auction
  // "sees r = 2.1, which is the gentle band". r = 21/10 = 2.1 is correct but
  // the band is not: the 1x band is r <= 2, so 2.1 is already 2x. The
  // discrimination that actually matters is RELATIVE and it does hold
  // everywhere, which is what these two assertions pin down.
  it("a newcomer is never priced ABOVE a returner in the same situation", () => {
    for (let bids = 1; bids <= 60; bids++) {
      for (let distinct = 1; distinct <= Math.min(bids, 12); distinct++) {
        const newcomer = minIncrementFor(250_000, { bidCount: bids, distinctBidders: distinct, bidderIsNew: true });
        const returner = minIncrementFor(250_000, { bidCount: bids, distinctBidders: distinct, bidderIsNew: false });
        expect(newcomer).toBeLessThanOrEqual(returner);
      }
    }
  });

  it("healthy discovery never escalates, however many people show up", () => {
    // n bids from n distinct accounts: r === 1.00 forever.
    for (let n = 1; n <= 60; n++) {
      expect(contestMultiplier(concentrationRatio(n, n, true))).toBe(1);
    }
    // Two accounts trading the same number of raises escalates to the cap.
    expect(contestMultiplier(concentrationRatio(60, 2, false))).toBe(MAX_CONTEST_MULTIPLIER);
  });

  it("never divides by zero on a virgin auction", () => {
    expect(concentrationRatio(0, 0, true)).toBe(1);
    expect(Number.isFinite(concentrationRatio(0, 0, false))).toBe(true);
  });
});

describe("contestMultiplier — the escalation curve", () => {
  it.each([
    [1, 1], [2, 1], [2.01, 2], [3, 2], [3.01, 4], [5, 4], [5.01, 8], [35, 8], [1e9, 8],
  ])("r=%s -> %ix", (r, mult) => {
    expect(contestMultiplier(r)).toBe(mult);
  });

  it("is capped — an uncapped curve on a 40-bid auction reaches absurdity", () => {
    expect(contestMultiplier(1000)).toBe(MAX_CONTEST_MULTIPLIER);
  });
});

describe("the 10%-of-price rail", () => {
  it("no minimum raise ever exceeds 10% of the live price, at any heat", () => {
    const prices = [600, 1_000, 9_999, 10_000, 55_000, 100_000, 499_999, 500_000,
      1_999_999, 2_000_000, 9_999_999, 10_000_000, 100_000_000];
    for (const cur of prices) {
      for (const [bidCount, distinct] of [[1, 2], [10, 2], [40, 2], [200, 6], [122, 7]]) {
        const step = minIncrementFor(cur, { bidCount, distinctBidders: distinct, bidderIsNew: false });
        // The rail is max(base, 10%) — on cheap lots the base step wins and
        // that is deliberate, but it is still trivially affordable.
        expect(step).toBeLessThanOrEqual(Math.max(baseStepFor(cur), Math.floor(cur * 0.1)));
        expect(step).toBeGreaterThan(0);
      }
    }
  });

  // THE CLAIM, STATED EXACTLY AND MEASURED. The module comment used to say
  // "never more than 10%" while the schedule quietly required 20% of a $500
  // lot — the cheapest listing that can now exist — because the $0–$9,999
  // tier's $100 base step outran the rail at the bottom. That is fixed by the
  // $50 rung, and this is the assertion that keeps it fixed.
  it("AT OR ABOVE THE LISTING FLOOR, no minimum raise EVER exceeds 10% of the price", () => {
    const heats: Array<[number, number]> = [[1, 2], [5, 2], [10, 2], [40, 2], [200, 2], [200, 6], [122, 7]];
    let worstRatio = 0;
    let worstAt = 0;
    const check = (cur: number) => {
      for (const [bidCount, distinctBidders] of heats) {
        for (const bidderIsNew of [true, false]) {
          const step = minIncrementFor(cur, { bidCount, distinctBidders, bidderIsNew });
          expect(step).toBeGreaterThan(0);
          const ratio = step / cur;
          if (ratio > worstRatio) { worstRatio = ratio; worstAt = cur; }
          expect(step, `price ${cur} required a raise of ${step}`).toBeLessThanOrEqual(Math.floor(cur * 0.1));
        }
      }
    };
    // Every tier boundary and every neighbourhood of one, plus a sweep.
    for (const b of [500, 999, 1_000, 9_999, 10_000, 99_999, 100_000, 499_999, 500_000,
      1_999_999, 2_000_000, 9_999_999, 10_000_000, 200_000_000, MAX_BID]) {
      for (const d of [-1, 0, 1]) if (b + d >= MIN_STARTING_BID) check(b + d);
    }
    for (let cur = MIN_STARTING_BID; cur < 2_000_000; cur = Math.ceil(cur * 1.07)) check(cur);
    expect(worstRatio).toBeLessThanOrEqual(0.1);
    expect(worstAt).toBeGreaterThan(0);
  });

  // The one place the 10% sentence does NOT hold, stated rather than hidden.
  it("BELOW the floor — only the grandfathered $100 listings — the $50 base applies", () => {
    expect(minIncrementFor(100, { bidCount: 1, distinctBidders: 1, bidderIsNew: true })).toBe(50);
    // And that is strictly gentler than it used to be: the old $100 base step
    // demanded a 100% raise on those same two live lots.
    expect(minIncrementFor(100, { bidCount: 1, distinctBidders: 1, bidderIsNew: true })).toBeLessThan(100);
  });

  it("escalation cannot bite at all on a $1,000 lot", () => {
    for (const [bidCount, distinct] of [[1, 2], [10, 2], [50, 2]]) {
      expect(minIncrementFor(1_000, { bidCount, distinctBidders: distinct, bidderIsNew: false })).toBe(100);
    }
  });
});

describe("GOLDEN: $10,000 lot through 15 bids", () => {
  it("war of attrition — two accounts — matches the signed-off table", () => {
    expect(walk(10_000, 15, war.distinctOf, war.isNew)).toEqual([
      10_000, 10_500, 11_000, 11_500, 12_500, 13_500, 14_850, 16_335,
      17_968, 19_764, 21_740, 23_914, 26_305, 28_935, 31_828,
    ]);
  });

  it("healthy discovery — 15 different players — is NOT punished", () => {
    const seq = walk(10_000, 15, healthy.distinctOf, healthy.isNew);
    // Flat $500 every single step; the multiplier never leaves 1x.
    expect(seq).toEqual([
      10_000, 10_500, 11_000, 11_500, 12_000, 12_500, 13_000, 13_500,
      14_000, 14_500, 15_000, 15_500, 16_000, 16_500, 17_000,
    ]);
    expect(seq[14]).toBe(17_000);
  });

  it("the war costs 1.87x what healthy discovery costs, by design", () => {
    const w = walk(10_000, 15, war.distinctOf, war.isNew)[14];
    const h = walk(10_000, 15, healthy.distinctOf, healthy.isNew)[14];
    expect(w).toBe(31_828);
    expect(h).toBe(17_000);
    expect(w / h).toBeGreaterThan(1.8);
  });
});

describe("GOLDEN: $2,000,000 lot through 8 bids", () => {
  it("war of attrition — two accounts — matches the signed-off table", () => {
    expect(walk(2_000_000, 8, war.distinctOf, war.isNew)).toEqual([
      2_000_000, 2_050_000, 2_100_000, 2_150_000, 2_250_000,
      2_350_000, 2_550_000, 2_750_000,
    ]);
  });

  it("healthy — 8 different players — ends at 1.18x the ask", () => {
    const seq = walk(2_000_000, 8, healthy.distinctOf, healthy.isNew);
    expect(seq[7]).toBe(2_350_000);
  });
});

describe("minAcceptableBid", () => {
  it("a lot with NO bids asks for the seller's starting bid verbatim", () => {
    for (const start of [100, 500, 2_500_000, 20_000_000]) {
      expect(minAcceptableBid({ startingBid: start, currentBid: 0 },
        { bidCount: 0, distinctBidders: 0, bidderIsNew: true })).toBe(start);
    }
  });

  it("DOES NOT retroactively reprice a live sub-floor listing", () => {
    // The two live $100 shiny listings. The floor is a creation-time rule.
    expect(minAcceptableBid({ startingBid: 100, currentBid: 0 },
      { bidCount: 0, distinctBidders: 0, bidderIsNew: true })).toBe(100);
    expect(100).toBeLessThan(MIN_STARTING_BID);
  });

  it("never exceeds MAX_BID even at the ceiling", () => {
    const min = minAcceptableBid({ startingBid: 1, currentBid: MAX_BID },
      { bidCount: 100, distinctBidders: 2, bidderIsNew: false });
    expect(min).toBe(MAX_BID);
  });
});

describe("resolveProxy — closed form, no loop", () => {
  const step = 10_000;

  it("challenger with a higher max takes the lead at leaderMax + step", () => {
    const r = resolveProxy(500_000, 600_000, 900_000, step);
    expect(r).toEqual({ newPrice: 610_000, challengerLeads: true, publicBidAmount: 610_000 });
  });

  it("challenger with a higher max but inside one step pays only their max", () => {
    const r = resolveProxy(500_000, 600_000, 605_000, step);
    expect(r.newPrice).toBe(605_000);
    expect(r.challengerLeads).toBe(true);
  });

  // THE PRICE AFTER A LOSS IS THE CHALLENGER'S OWN NUMBER, not `leaderMax`
  // and not `challengerMax + step`. Both of those are functions of the
  // leader's secret, and returning either one let a rival read a standing
  // maximum exactly, for free, by probing. See resolveProxy's doc comment.
  it("challenger with a lower max is beaten instantly; price stops at THEIR max", () => {
    const r = resolveProxy(500_000, 900_000, 600_000, step);
    expect(r).toEqual({ newPrice: 600_000, challengerLeads: false, publicBidAmount: 600_000 });
  });

  it("a LOSING price is independent of the leader's maximum — the anti-probe property", () => {
    // Same challenger, wildly different secrets. If any observable differed,
    // the secret would be readable off the response.
    const seen = new Set<string>();
    for (const leaderMax of [600_001, 700_000, 1_000_000, 90_000_000, MAX_BID]) {
      seen.add(JSON.stringify(resolveProxy(500_000, leaderMax, 600_000, step)));
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(JSON.stringify(
      { newPrice: 600_000, challengerLeads: false, publicBidAmount: 600_000 },
    ));
  });

  it("TIE: equal maxima -> incumbent holds, price rises to the tied amount", () => {
    const r = resolveProxy(500_000, 700_000, 700_000, step);
    expect(r.challengerLeads).toBe(false);
    expect(r.newPrice).toBe(700_000);
  });

  it("NEITHER maximum is ever exceeded, across a wide sweep", () => {
    for (const cur of [1_000, 250_000, 5_000_000]) {
      for (const L of [cur, cur * 2, cur * 10]) {
        for (const C of [cur, cur * 2, cur * 10, cur * 11]) {
          for (const s of [100, 10_000, 250_000]) {
            const r = resolveProxy(cur, L, C, s);
            expect(r.newPrice).toBeLessThanOrEqual(Math.max(L, C));
            expect(r.newPrice).toBeLessThanOrEqual(MAX_BID);
            expect(r.publicBidAmount).toBeLessThanOrEqual(C);
            expect(r.newPrice).toBeGreaterThanOrEqual(cur);
          }
        }
      }
    }
  });

  it("the price never runs away past MAX_BID", () => {
    const r = resolveProxy(MAX_BID - 1, MAX_BID, MAX_BID, 250_000);
    expect(r.newPrice).toBeLessThanOrEqual(MAX_BID);
  });
});

describe("the shiny tangela — 210 real bids, 6 distinct bidders", () => {
  it("resolves in 6 exchanges at the same price, with the multiplier never engaging", () => {
    // Real maxima, in the order those accounts first bid.
    const maxima = [4_000_012, 300_034, 500_006, 300_030, 4_000_011, 4_000_007];
    let cur = 300_000;          // the ask
    let leaderMax = maxima[0];  // opened at the ask
    let bidCount = 1;
    const multipliers: number[] = [];
    for (let i = 1; i < maxima.length; i++) {
      const contest = { bidCount, distinctBidders: i, bidderIsNew: true };
      multipliers.push(contestMultiplier(concentrationRatio(bidCount, i, true)));
      const step = minIncrementFor(cur, contest);
      const r = resolveProxy(cur, leaderMax, maxima[i], step);
      cur = r.newPrice;
      if (r.challengerLeads) leaderMax = maxima[i];
      bidCount++;
    }
    // $1 UNDER the real sale price, and that dollar is the whole point.
    // The real sale closed at $4,000,012 — the WINNER'S own maximum, which is
    // what the old `min(leaderMax, challengerMax + step)` rule leaked into the
    // public price. The runner-up's maximum was $4,000,011, and that is what
    // the winner now pays: the textbook second-price outcome, and the reason a
    // losing probe can no longer read anybody's number.
    expect(cur).toBe(4_000_011);
    expect(cur).toBe(Math.max(...maxima.filter((m) => m !== 4_000_012))); // the runner-up
    expect(leaderMax).toBe(4_000_012);     // identical winner (the opener held)
    expect(multipliers).toEqual([1, 1, 1, 1, 1]); // six people acting once each
  });
});

describe("formatMoney", () => {
  it("is the string players actually read in the rejection", () => {
    expect(formatMoney(500)).toBe("$500");
    expect(formatMoney(5_050_002)).toBe("$5,050,002");
    expect(formatMoney(0)).toBe("$0");
  });
});
