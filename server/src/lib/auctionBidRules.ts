// Auction bidding rules — the pure arithmetic behind the minimum starting
// bid, the escalating minimum increment, and proxy (maximum-bid) resolution.
//
// ZERO imports on purpose. No prisma, no socket, no clock. Everything here is
// a total function of its arguments, so it can be exhaustively unit-tested and
// mirrored byte-for-byte in the client (game/src/utils/auctionBidRules.ts)
// without dragging server code into the browser bundle. The CLIENT COPY IS A
// HINT ONLY — routes/auctions.ts recomputes every value here from the DB row
// and the Bid table before it writes anything, so a crafted payload that lies
// about the minimum changes nothing.
//
// ── WHY THESE NUMBERS ────────────────────────────────────────────────
// Measured against production on 2026-07-30 (240 auctions, 1,020 bids):
//
//   * 555 of 932 consecutive raises (59.5%) were EXACTLY $1, and 87.4% were
//     $10 or less. The old rule was `currentBid + 1`, so a $10,000,000 lot
//     was winnable with $10,000,001. 60 of 69 sales were decided by a click
//     rather than a price.
//   * 45% of listings already expire UNSOLD, and every one of those 106
//     expired auctions received ZERO bids. Liquidity is thin at the TOP of
//     the price range: the $0–$100 starting band clears at 69%, the $5M+
//     band at 16%. So this is sized for "bidding is meaningful", not
//     "bidding is expensive" — see MAX_STEP_FRACTION_OF_PRICE.

/** Matches saveValidation's MAX_MONEY, and Auction.currentBid is an Int. */
export const MAX_BID = 999_999_999;

/**
 * A Pokemon may not be listed below this. Creation-time validation ONLY —
 * see `POST /api/auctions`. An auction row that already exists is NEVER
 * re-validated against this, which is what makes the floor safe to raise
 * without breaking a live listing (two live auctions were created at $100
 * before this shipped and both still take a first bid at $100).
 *
 * $500 and not $10,000: across 2,321 accounts with a save the MEDIAN balance
 * is $3,000, while the 50 accounts that have ever bid have a median of
 * $1.58M. A starting bid is the buyer's entry ticket, so a high floor locks
 * the median player out of the auction house permanently. $500 is above the
 * $100 form default that produced 24 accidental junk listings, and refuses
 * only $452 of realised trade across all of production history.
 */
export const MIN_STARTING_BID = 500;

/**
 * Base increment tiers: [exclusive upper bound on currentBid, step].
 * Inside a tier the step decays from at most 5% of the price at the tier
 * floor to 0.5% at its top — the eBay shape. (The sizing note said
 * "0.5%–2.5%"; 5% at a tier floor is the true figure and the signed-off
 * $10,000 row already showed it. MEASURED in auctionBidRules.test.ts.)
 * A flat percentage was rejected because it is pointless at the bottom
 * ($10 on a $1,000 lot) and punishing at the top ($100,000 on a $10M lot).
 * Boundaries sit on the decade/half-decade points the real distribution
 * already clusters on (p25 $27.5k, p50 $300k, p75 $2.5M, p90 $5M).
 */
const BASE_STEP_TIERS: ReadonlyArray<readonly [number, number]> = [
  // THE BOTTOM RUNG EXISTS TO KEEP THE 10% RAIL HONEST. Without it the
  // $0–$9,999 tier's $100 step applied at the very bottom of the market, so
  // the cheapest lot that can now legally exist — a $500 listing — carried a
  // 20% minimum raise, the harshest relative increment anywhere in the
  // schedule, on precisely the thinnest-liquidity band. $50 is still 50x the
  // old +$1 creep, and it makes "never more than 10% of the price" TRUE for
  // every lot at or above the listing floor (asserted over the whole range in
  // auctionBidRules.test.ts) rather than true-with-a-footnote.
  [1_000, 50],
  [10_000, 100],
  [100_000, 500],
  [500_000, 2_500],
  [2_000_000, 10_000],
  [10_000_000, 50_000],
];
const TOP_TIER_STEP = 250_000;

/**
 * THE SAFETY RAIL, and the single most important constant in this file.
 *
 * THE EXACT CLAIM, because a rounded one was wrong once already: for every
 * lot priced at or above MIN_STARTING_BID, no bid at any heat may ever be
 * required to exceed the current price by more than 10%. Measured, not
 * asserted — auctionBidRules.test.ts sweeps the whole range at every
 * multiplier.
 *
 * The rail is `max(base, 10% of price)` rather than a plain 10%, so BELOW the
 * $500 listing floor the base step wins instead: a grandfathered $100 lot
 * (two exist, and no new one can be created) has a $50 minimum raise. That is
 * the one and only place the 10% sentence does not hold, and it holds nowhere
 * a player can newly get to.
 *
 * This is what makes "the escalation turned a real contest into an
 * unaffordable one" structurally impossible, and it is the concession to the
 * 45%-expire-unsold liquidity problem.
 */
const MAX_STEP_FRACTION_OF_PRICE = 0.1;

/** Multiplier cap. An uncapped curve on a 40-bid auction reaches absurdity. */
export const MAX_CONTEST_MULTIPLIER = 8;

/** The tiered base step for a given live price, before any escalation. */
export function baseStepFor(currentBid: number): number {
  const cur = Number.isFinite(currentBid) && currentBid > 0 ? Math.floor(currentBid) : 0;
  for (const [bound, step] of BASE_STEP_TIERS) {
    if (cur < bound) return step;
  }
  return TOP_TIER_STEP;
}

/**
 * Repeat-bidding concentration: bids per distinct bidder, computed
 * PROSPECTIVELY — the incoming bidder is counted in both the numerator and
 * the denominator before they have acted.
 *
 * This is the whole discrimination between the two cases, in one fraction.
 * Raw bid count cannot tell them apart: production has a 21-bid auction with
 * 9 distinct bidders (healthy price discovery) and a 122-bid auction with 7
 * (a war of attrition). Including the challenger in the denominator is what
 * keeps newcomers safe — the 10th distinct player joining a 20-bid auction
 * sees r = 21/10 = 2.1, which is the gentle band, while a returning
 * repeat-bidder sees the same numerator over a smaller denominator.
 *
 * @param bidCount        Bid rows already on the auction.
 * @param distinctBidders Distinct bidders already on the auction, INCLUDING
 *                        the incoming one if they have bid before.
 * @param bidderIsNew     True when the incoming bidder has not bid here yet.
 */
export function concentrationRatio(
  bidCount: number,
  distinctBidders: number,
  bidderIsNew: boolean,
): number {
  const bids = Math.max(0, Math.floor(bidCount)) + 1;
  const people = Math.max(0, Math.floor(distinctBidders)) + (bidderIsNew ? 1 : 0);
  if (people <= 0) return 1;
  return bids / people;
}

/**
 * How hard the step escalates, given concentration. Measured across the 88
 * contested auctions in production: median r = 1.33, p75 = 2.33, p90 = 3.80,
 * max = 35.0. On this curve 74% of real contested auctions never escalate at
 * all, and the 8x band catches exactly the seven genuine wars (the 210-bid
 * tangela at r=35, the 194-bid ditto at r=24.3, the 122-bid nidorina at
 * r=17.4, and four more).
 *
 * Per-bid rather than per-round, because r is already round-ish by
 * construction: two people alternating drive it to n/2 quickly, while twelve
 * people bidding once each hold it at 1.00 forever. No round bookkeeping.
 */
export function contestMultiplier(ratio: number): 1 | 2 | 4 | 8 {
  if (!Number.isFinite(ratio) || ratio <= 2) return 1;
  if (ratio <= 3) return 2;
  if (ratio <= 5) return 4;
  return MAX_CONTEST_MULTIPLIER;
}

export interface ContestInput {
  /** Bid rows already recorded against this auction. */
  bidCount: number;
  /** Distinct bidders already recorded against this auction. */
  distinctBidders: number;
  /** True when the incoming bidder has never bid on this auction. */
  bidderIsNew: boolean;
}

/**
 * The minimum RAISE over the current price: tiered base, escalated by
 * concentration, then clamped by the 10%-of-price rail.
 *
 * NOTE the rail is `max(base, 10% of price)` and not plain `10% of price`:
 * on a cheap lot the base step is the larger of the two and must still
 * apply, otherwise a $600 lot would have a $60 minimum raise and the creep
 * problem comes straight back at the bottom of the market.
 */
export function minIncrementFor(currentBid: number, contest: ContestInput): number {
  const cur = Number.isFinite(currentBid) && currentBid > 0 ? Math.floor(currentBid) : 0;
  const base = baseStepFor(cur);
  const ratio = concentrationRatio(contest.bidCount, contest.distinctBidders, contest.bidderIsNew);
  const escalated = base * contestMultiplier(ratio);
  const ceiling = Math.max(base, Math.floor(cur * MAX_STEP_FRACTION_OF_PRICE));
  return Math.min(escalated, ceiling);
}

/**
 * The lowest amount this bidder may submit.
 *
 * On a lot with no bids this is the seller's ask verbatim — NOT
 * `max(startingBid, MIN_STARTING_BID)`. That distinction is what stops the
 * new floor retroactively repricing an in-flight listing: the two live
 * $100 shiny listings keep taking a first bid at exactly $100, because the
 * floor is a creation-time rule and creation already happened.
 */
export function minAcceptableBid(
  auction: { startingBid: number; currentBid: number },
  contest: ContestInput,
): number {
  if (auction.currentBid <= 0) return Math.min(auction.startingBid, MAX_BID);
  const step = minIncrementFor(auction.currentBid, contest);
  return Math.min(auction.currentBid + step, MAX_BID);
}

// ── Proxy resolution ────────────────────────────────────────────────────

export interface ProxyResolution {
  /** The new public price. Never above either party's maximum. */
  newPrice: number;
  /** True when the challenger takes the lead. */
  challengerLeads: boolean;
  /**
   * What the challenger's own Bid row records. `min(submittedMax, newPrice)`:
   * the resulting price when they take the lead, their own committed max when
   * they are beaten. Either way it is only ever a DEFEATED maximum that
   * becomes public — the standing leader's max is never written anywhere a
   * player can read.
   */
  publicBidAmount: number;
}

/**
 * Resolve one proxy exchange. CLOSED FORM — one comparison and two
 * arithmetic expressions, zero iterations.
 *
 * There is no auto-raise loop to terminate, deadlock or double-fire, because
 * only ONE maximum is ever stored (the current leader's) and a beaten maximum
 * is consumed the instant it loses. `newPrice` is bounded above by
 * `max(leaderMax, challengerMax)` in both branches, so neither party's
 * maximum can be exceeded.
 *
 * TIES: strict `>` is required to take the lead, so a challenger who exactly
 * matches the incumbent's maximum LOSES and the price rises to that amount.
 * The incumbent is by definition the earlier submission, so "earliest
 * submission wins" falls out deterministically with no timestamp comparison.
 *
 * ── THE LOSING BRANCH IS A FUNCTION OF THE CHALLENGER ONLY ───────────
 * This is a SECURITY property, not a pricing preference, and it is the fix
 * for the probing attack.
 *
 * The eBay rule — `min(leaderMax, challengerMax + step)` — returns
 * `leaderMax` VERBATIM whenever the cap binds. A rival could therefore read
 * a standing maximum EXACTLY, for free, by bidding just under it and reading
 * the resulting public price out of the response; the leader's secret is a
 * direct output of the arithmetic. Measured before this change: a cautious
 * prober who never overshot read a $90,000,000 maximum off single-digit
 * probes, still losing, still committed to nothing.
 *
 * So a losing challenge now moves the price to EXACTLY the challenger's own
 * submitted maximum. Every number the loser can observe is a number they
 * chose, so a losing probe returns strictly zero information beyond "the
 * leader is at or above what I just committed to" — which is the same thing
 * any bid tells you, and it costs the prober the price they just set.
 *
 * The cost is at most one increment of realised price on a lot whose last
 * action is a losing challenge, and what it buys is the textbook
 * second-price outcome: the winner pays the runner-up's valuation rather
 * than the runner-up's valuation plus a step.
 *
 * MEASURED, read-only, against all 70 real sales that have bid history
 * (production, 251 auctions / 1,198 bids): total realised trade moves from
 * $83,218,558 to $83,185,502 — minus $33,056, or -0.040%. Eleven lots change
 * price, the largest single drop is $10,000, NO lot changes winner, and NO
 * lot becomes unsold. The disclosure channel closes for four hundredths of
 * one percent of gross.
 *
 * The WINNING branch still resolves at `leaderMax + step`, which does
 * disclose the beaten maximum — but only to somebody who has just bought the
 * lot at that price, against a maximum that is now consumed. Paying for the
 * information is the auction working.
 *
 * @param leaderMax  The leader's EFFECTIVE maximum — already capped at what
 *                   they can currently afford by the caller.
 */
export function resolveProxy(
  currentBid: number,
  leaderMax: number,
  challengerMax: number,
  step: number,
): ProxyResolution {
  if (challengerMax > leaderMax) {
    const newPrice = Math.min(challengerMax, Math.min(leaderMax + step, MAX_BID));
    return {
      newPrice,
      challengerLeads: true,
      publicBidAmount: Math.min(challengerMax, newPrice),
    };
  }
  // `challengerMax <= leaderMax` holds on this branch, so pricing at the
  // challenger's own maximum can never exceed the leader's — the "neither
  // maximum is exceeded" invariant is preserved, and the leader's capped
  // affordability (applied by the caller) still covers the new price.
  const newPrice = Math.max(Math.min(challengerMax, MAX_BID), currentBid);
  return {
    newPrice,
    challengerLeads: false,
    publicBidAmount: Math.min(challengerMax, newPrice),
  };
}

// ── Human-readable money, shared by both error strings and the UI ───────
export function formatMoney(n: number): string {
  return `$${Math.max(0, Math.floor(n)).toLocaleString("en-US")}`;
}
