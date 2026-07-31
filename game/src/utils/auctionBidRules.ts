// CLIENT MIRROR of server/src/lib/auctionBidRules.ts.
//
// ── THIS IS A HINT, NOT A RULE ───────────────────────────────────────
// Everything here exists so the bid box can SAY what the minimum is before
// the player types, and prefill it. The server recomputes every one of these
// values from the auction row and the Bid table before it writes anything
// (see routes/auctions.ts), so a tampered copy of this file buys nothing —
// the worst a wrong value here can do is show the player a wrong number and
// get their bid rejected with the correct one.
//
// Kept byte-comparable with the server copy on purpose. Both suites run the
// SAME golden sequences (the tables the owner signed off on), so if either
// side drifts, that side's tests go red.

export const MAX_BID = 999_999_999;
export const MIN_STARTING_BID = 500;

const BASE_STEP_TIERS: ReadonlyArray<readonly [number, number]> = [
  // Keeps the 10%-of-price rail true at the very bottom of the market: a
  // $500 lot (the listing floor) had a 20% minimum raise without this rung.
  // Mirrors the server tier table exactly — both suites assert the same rail.
  [1_000, 50],
  [10_000, 100],
  [100_000, 500],
  [500_000, 2_500],
  [2_000_000, 10_000],
  [10_000_000, 50_000],
];
const TOP_TIER_STEP = 250_000;
const MAX_STEP_FRACTION_OF_PRICE = 0.1;
export const MAX_CONTEST_MULTIPLIER = 8;

export function baseStepFor(currentBid: number): number {
  const cur = Number.isFinite(currentBid) && currentBid > 0 ? Math.floor(currentBid) : 0;
  for (const [bound, step] of BASE_STEP_TIERS) {
    if (cur < bound) return step;
  }
  return TOP_TIER_STEP;
}

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

export function contestMultiplier(ratio: number): 1 | 2 | 4 | 8 {
  if (!Number.isFinite(ratio) || ratio <= 2) return 1;
  if (ratio <= 3) return 2;
  if (ratio <= 5) return 4;
  return MAX_CONTEST_MULTIPLIER;
}

export interface ContestInput {
  bidCount: number;
  distinctBidders: number;
  bidderIsNew: boolean;
}

export function minIncrementFor(currentBid: number, contest: ContestInput): number {
  const cur = Number.isFinite(currentBid) && currentBid > 0 ? Math.floor(currentBid) : 0;
  const base = baseStepFor(cur);
  const ratio = concentrationRatio(contest.bidCount, contest.distinctBidders, contest.bidderIsNew);
  const escalated = base * contestMultiplier(ratio);
  const ceiling = Math.max(base, Math.floor(cur * MAX_STEP_FRACTION_OF_PRICE));
  return Math.min(escalated, ceiling);
}

export function minAcceptableBid(
  auction: { startingBid: number; currentBid: number },
  contest: ContestInput,
): number {
  if (auction.currentBid <= 0) return Math.min(auction.startingBid, MAX_BID);
  const step = minIncrementFor(auction.currentBid, contest);
  return Math.min(auction.currentBid + step, MAX_BID);
}

/**
 * The minimum to display for a live auction after a SOCKET tick, when the
 * client does not know whether this viewer has bid here before.
 *
 * Deliberately assumes `bidderIsNew: false` — the RETURNING-bidder value,
 * which is the higher of the two. A prefill that is too HIGH costs a proxy
 * bidder nothing (the submitted number is a maximum; they still pay only
 * what it takes), whereas one that is too LOW is a rejection the player
 * cannot see coming. Erring upward is the safe direction, and the next REST
 * refetch replaces it with the exact per-viewer figure the server computed.
 */
export function conservativeMinBid(auction: {
  startingBid: number; currentBid: number; bidCount: number; distinctBidders: number;
}): number {
  return minAcceptableBid(auction, {
    bidCount: auction.bidCount,
    distinctBidders: auction.distinctBidders,
    bidderIsNew: false,
  });
}

/** The lowest number the server will accept from this viewer right now. */
export function bidFloorFor(a: {
  currentBid: number; minNextBid: number; youAreHighBidder: boolean; yourMax: number | null;
}): number {
  // While you hold the lot the only legal action is RAISING your own maximum,
  // so the floor is your own maximum plus one — not minNextBid, which is
  // computed against the public price and sits far below it.
  return a.youAreHighBidder ? (a.yourMax ?? a.currentBid) + 1 : a.minNextBid;
}

/**
 * What the bid box should be PREFILLED with.
 *
 * Split out of the component and tested, because getting it wrong is
 * invisible to a typecheck and produces exactly the failure this work exists
 * to remove. It shipped wrong once already: while leading, the field was
 * seeded from `minNextBid` ($710,000 against a $4,000,000 stored maximum),
 * so clicking the button submitted a number the server refuses outright.
 * Caught by rendering the real card in a browser, not by any unit test —
 * hence this one.
 */
export function prefillBidAmount(a: {
  currentBid: number; minNextBid: number; minIncrement: number;
  youAreHighBidder: boolean; yourMax: number | null;
}): number {
  if (!a.youAreHighBidder) return a.minNextBid;
  const base = a.yourMax ?? a.currentBid;
  return base + Math.max(a.minIncrement, baseStepFor(base));
}

export function formatMoney(n: number): string {
  return `$${Math.max(0, Math.floor(n)).toLocaleString("en-US")}`;
}
