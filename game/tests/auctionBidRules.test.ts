// The CLIENT mirror of the auction bidding rules.
//
// These are the SAME golden sequences asserted in
// server/tests/auctionBidRules.test.ts against the server copy — the tables
// the owner was shown and signed off on. Duplicating them is the drift
// detector: if either copy of the rule changes without the other, that
// copy's own suite goes red.

import { describe, expect, it } from "vitest";
import {
  MAX_BID,
  MIN_STARTING_BID,
  baseStepFor,
  bidFloorFor,
  concentrationRatio,
  conservativeMinBid,
  contestMultiplier,
  formatMoney,
  minAcceptableBid,
  minIncrementFor,
  prefillBidAmount,
} from "../src/utils/auctionBidRules";

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
    cur = min;
  }
  return out;
}

const war = { distinctOf: (n: number) => Math.min(n, 2), isNew: (n: number) => n < 2 };
const healthy = { distinctOf: (n: number) => n, isNew: () => true };

describe("GOLDEN sequences — identical to the server suite", () => {
  it("$10,000 lot, 15 bids, war of attrition", () => {
    expect(walk(10_000, 15, war.distinctOf, war.isNew)).toEqual([
      10_000, 10_500, 11_000, 11_500, 12_500, 13_500, 14_850, 16_335,
      17_968, 19_764, 21_740, 23_914, 26_305, 28_935, 31_828,
    ]);
  });

  it("$10,000 lot, 15 bids, 15 different players — never escalates", () => {
    expect(walk(10_000, 15, healthy.distinctOf, healthy.isNew)).toEqual([
      10_000, 10_500, 11_000, 11_500, 12_000, 12_500, 13_000, 13_500,
      14_000, 14_500, 15_000, 15_500, 16_000, 16_500, 17_000,
    ]);
  });

  it("$2,000,000 lot, 8 bids, war of attrition", () => {
    expect(walk(2_000_000, 8, war.distinctOf, war.isNew)).toEqual([
      2_000_000, 2_050_000, 2_100_000, 2_150_000, 2_250_000,
      2_350_000, 2_550_000, 2_750_000,
    ]);
  });

  it("$2,000,000 lot, 8 different players — ends at 1.18x the ask", () => {
    expect(walk(2_000_000, 8, healthy.distinctOf, healthy.isNew)[7]).toBe(2_350_000);
  });
});

describe("tiers and the escalation curve", () => {
  it.each([
    [0, 50], [999, 50], [1_000, 100], [9_999, 100], [10_000, 500], [99_999, 500], [100_000, 2_500],
    [499_999, 2_500], [500_000, 10_000], [1_999_999, 10_000], [2_000_000, 50_000],
    [9_999_999, 50_000], [10_000_000, 250_000], [MAX_BID, 250_000],
  ])("baseStepFor(%i) === %i", (cur, step) => {
    expect(baseStepFor(cur)).toBe(step);
  });

  it.each([[1, 1], [2, 1], [2.01, 2], [3, 2], [3.01, 4], [5, 4], [5.01, 8], [35, 8]])(
    "contestMultiplier(%s) === %i", (r, m) => { expect(contestMultiplier(r)).toBe(m); },
  );

  // The HARD version of the claim, matching the server suite exactly: at or
  // above the $500 listing floor the raise is never more than 10% of the
  // price. Before the $50 bottom rung a $500 lot demanded 20%.
  it("no minimum raise ever exceeds 10% of the live price, at or above the floor", () => {
    for (let cur = MIN_STARTING_BID; cur < 200_000_000; cur = Math.ceil(cur * 1.11)) {
      for (const [b, d] of [[1, 2], [10, 2], [40, 2], [200, 2], [200, 6]]) {
        for (const isNew of [true, false]) {
          const step = minIncrementFor(cur, { bidCount: b, distinctBidders: d, bidderIsNew: isNew });
          expect(step, `price ${cur}`).toBeLessThanOrEqual(Math.floor(cur * 0.1));
          expect(step).toBeGreaterThan(0);
        }
      }
    }
    expect(minIncrementFor(500, { bidCount: 1, distinctBidders: 1, bidderIsNew: true })).toBe(50);
  });

  it("healthy discovery never escalates", () => {
    for (let n = 1; n <= 60; n++) {
      expect(contestMultiplier(concentrationRatio(n, n, true))).toBe(1);
    }
  });
});

describe("the live-auction guarantee", () => {
  it("an unbid lot asks the seller's price verbatim, even below the floor", () => {
    // The two live SHINY listings created at the old $100 default.
    expect(minAcceptableBid({ startingBid: 100, currentBid: 0 },
      { bidCount: 0, distinctBidders: 0, bidderIsNew: true })).toBe(100);
    expect(100).toBeLessThan(MIN_STARTING_BID);
  });

  it("the ten live lots that carry a bid get the expected new minimum", () => {
    const cases: Array<[number, number, number, number, number]> = [
      // currentBid, bidCount, distinct, expectedMin, expectedStep
      [5_000_002, 3, 2, 5_050_002, 50_000],
      [5_000_000, 1, 1, 5_050_000, 50_000],
      [2_000_000, 1, 1, 2_050_000, 50_000],
      [1_500_001, 2, 2, 1_510_001, 10_000],
      [2_500_000, 1, 1, 2_550_000, 50_000],
      [1_500_000, 1, 1, 1_510_000, 10_000],
      [500_000, 1, 1, 510_000, 10_000],
    ];
    for (const [cur, bids, distinct, expMin, expStep] of cases) {
      const contest = { bidCount: bids, distinctBidders: distinct, bidderIsNew: true };
      expect(minAcceptableBid({ startingBid: cur, currentBid: cur }, contest)).toBe(expMin);
      expect(minIncrementFor(cur, contest)).toBe(expStep);
    }
  });
});

describe("conservativeMinBid — the socket-tick prefill", () => {
  it("is never BELOW the exact per-viewer minimum, for any viewer", () => {
    for (const cur of [10_000, 250_000, 5_000_000]) {
      for (let bids = 1; bids <= 30; bids++) {
        for (let distinct = 1; distinct <= Math.min(bids, 10); distinct++) {
          const shown = conservativeMinBid({ startingBid: cur, currentBid: cur, bidCount: bids, distinctBidders: distinct });
          for (const bidderIsNew of [true, false]) {
            const exact = minAcceptableBid({ startingBid: cur, currentBid: cur },
              { bidCount: bids, distinctBidders: distinct, bidderIsNew });
            // Erring upward is safe; erring downward is a rejection the
            // player could not see coming.
            expect(shown).toBeGreaterThanOrEqual(exact);
          }
        }
      }
    }
  });

  it("falls back to the seller's ask on an unbid lot", () => {
    expect(conservativeMinBid({ startingBid: 2_500_000, currentBid: 0, bidCount: 0, distinctBidders: 0 }))
      .toBe(2_500_000);
  });
});

// REGRESSION LOCK. This shipped wrong once: while the player held the lot,
// the bid box was prefilled from `minNextBid` — which is computed against the
// PUBLIC price and therefore sits far below their own stored maximum — so
// clicking "Raise my maximum" submitted a number the server refuses. It was
// invisible to the typecheck and to every other test here, and was found only
// by rendering the real card in a browser.
describe("prefillBidAmount / bidFloorFor — the number in the box is always legal", () => {
  const leading = {
    currentBid: 700_000, minNextBid: 710_000, minIncrement: 10_000,
    youAreHighBidder: true, yourMax: 4_000_000,
  };

  it("while LEADING, the prefill is above your own maximum", () => {
    expect(bidFloorFor(leading)).toBe(4_000_001);
    expect(prefillBidAmount(leading)).toBe(4_050_000);
    expect(prefillBidAmount(leading)).toBeGreaterThanOrEqual(bidFloorFor(leading));
  });

  it("while CHALLENGING, the prefill is exactly the minimum acceptable bid", () => {
    const challenging = { ...leading, youAreHighBidder: false, yourMax: null };
    expect(bidFloorFor(challenging)).toBe(710_000);
    expect(prefillBidAmount(challenging)).toBe(710_000);
  });

  it("the prefill is NEVER below the floor, across every shape", () => {
    for (const currentBid of [0, 500, 9_999, 250_000, 5_000_000, 90_000_000]) {
      for (const youAreHighBidder of [true, false]) {
        for (const yourMax of [null, currentBid, currentBid * 3, 90_000_000]) {
          const minIncrement = currentBid > 0 ? minIncrementFor(currentBid, {
            bidCount: 3, distinctBidders: 2, bidderIsNew: true,
          }) : 0;
          const a = {
            currentBid,
            minNextBid: minAcceptableBid({ startingBid: Math.max(currentBid, 500), currentBid },
              { bidCount: 3, distinctBidders: 2, bidderIsNew: true }),
            minIncrement, youAreHighBidder, yourMax,
          };
          expect(prefillBidAmount(a)).toBeGreaterThanOrEqual(bidFloorFor(a));
        }
      }
    }
  });

  it("a leader with no recorded maximum still gets a raisable number", () => {
    const a = { currentBid: 800, minNextBid: 900, minIncrement: 100, youAreHighBidder: true, yourMax: null };
    expect(prefillBidAmount(a)).toBeGreaterThan(a.currentBid);
    expect(prefillBidAmount(a)).toBeGreaterThanOrEqual(bidFloorFor(a));
  });
});

describe("formatMoney — what the player actually reads", () => {
  it("groups thousands", () => {
    expect(formatMoney(500)).toBe("$500");
    expect(formatMoney(5_050_002)).toBe("$5,050,002");
    expect(formatMoney(-5)).toBe("$0");
  });
});
