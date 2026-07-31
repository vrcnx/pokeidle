// SHILL / PROBE WATCH — the "log the suspicious one" half of the brief's
// anti-shill requirement.
//
// ── WHAT THIS CAN AND CANNOT DO ──────────────────────────────────────
// Alt accounts cannot be detected from inside a bid handler. The TRIVIAL
// case (a seller bidding their own lot) is REFUSED in routes/auctions.ts and
// recorded here; the non-trivial case (a seller's second account walking an
// honest bidder up toward their maximum) is not refusable without also
// locking honest bidders out of live auctions, so it is RECORDED instead.
//
// Nothing here blocks a bid, and nothing here can fail one: every write is
// fire-and-forget through lib/audit.ts, which already swallows its own
// errors. A bid that has been accepted stays accepted even if the audit
// table is unreachable — proven in tests/auctionProbeShillDegrade.test.ts.
//
// ── THE SIGNAL, AND ITS HONEST LIMITS ────────────────────────────────
// One losing bid is nothing. A single account making FOUR OR MORE bids on
// one lot and holding the lead after none of them is the shape of a ladder:
// the account is moving the price and taking no risk. That is also the shape
// of a determined honest bidder who keeps being outbid by a bigger maximum —
// the two are genuinely indistinguishable within one auction, which is why
// this LOGS rather than blocks.
//
// What makes the log actionable is the pair (sellerId, bidderId) in `meta`:
// the same two accounts appearing across many of one seller's lots is the
// thing no honest bidder reproduces, and AdminAudit is already indexed by
// targetId + createdAt for exactly that kind of sweep.
//
// Logging is throttled to every 4th losing bid so a 50-probe ladder leaves a
// readable dozen rows rather than fifty.
import { audit } from "./audit.js";

/** Fires at 4, 8, 12 … losing bids from one account on one lot. */
const LOSING_BID_THRESHOLD = 4;

/**
 * Fire-and-forget writes, tracked so tests (and any future shutdown hook)
 * can await them. Never awaited on the request path.
 */
const pending = new Set<Promise<void>>();

function fire(p: Promise<void>): void {
  pending.add(p);
  void p.catch(() => undefined).finally(() => pending.delete(p));
}

/** Test seam: wait for outstanding audit writes to settle. */
export async function flushShillWatch(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

/**
 * The trivial shill case, already refused by the route. Logged because an
 * ATTEMPT is itself the signal — an honest player never sends it, since the
 * client does not render a bid box on your own listing.
 */
export function noteSelfBidBlocked(auctionId: string, sellerId: string, amount: number): void {
  fire(audit(sellerId, "auction.self_bid_blocked", auctionId, {
    sellerId,
    attemptedAmount: amount,
    note: "seller attempted to bid on their own listing; refused",
  }));
}

/**
 * A bid that moved the price and did NOT take the lead, from an account that
 * has now done so repeatedly on this lot.
 *
 * @param bidsByThisBidder This bidder's Bid rows on this auction INCLUDING
 *                         the one just written.
 */
export function noteLosingBid(input: {
  auctionId: string;
  sellerId: string;
  bidderId: string;
  bidsByThisBidder: number;
  priceNow: number;
}): void {
  const n = input.bidsByThisBidder;
  if (n < LOSING_BID_THRESHOLD || n % LOSING_BID_THRESHOLD !== 0) return;
  fire(audit(input.bidderId, "auction.repeat_losing_bids", input.auctionId, {
    auctionId: input.auctionId,
    sellerId: input.sellerId,
    bidderId: input.bidderId,
    losingBidsByThisBidder: n,
    priceNow: input.priceNow,
    note:
      "account keeps raising this lot without ever taking the lead. Consistent "
      + "with a shill ladder run from a second account, and also with an honest "
      + "bidder repeatedly outbid by a larger maximum. Cross-reference "
      + "(sellerId, bidderId) across this seller's other lots before acting.",
  }));
}
