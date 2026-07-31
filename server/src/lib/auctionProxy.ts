// Data access for proxy (maximum) bids and for the contest counts the
// escalating increment is keyed on.
//
// Split out of routes/auctions.ts so that the ONE table holding a player's
// secret maximum is touched from exactly one module, and every function that
// can return a maximum has "own" or "secret" in its name or its doc comment.
// The pure arithmetic lives in auctionBidRules.ts and imports nothing.
import { prisma } from "../db.js";
import { recordError } from "./errorReporting.js";

export interface Contest {
  /** Bid rows already recorded against this auction. */
  bidCount: number;
  /** Distinct bidders already recorded against this auction. */
  distinctBidders: number;
  /** True when this bidder has never bid on this auction. */
  bidderIsNew: boolean;
  /**
   * Bid rows THIS bidder already has on this auction. Falls out of the same
   * groupBy for free, and is the shill-watch signal: an account with several
   * rows here that still does not hold the lot is running a ladder.
   */
  bidderBidCount: number;
}

export interface ProxyState {
  bidderId: string;
  maxAmount: number;
}

// ── Graceful degradation ────────────────────────────────────────────────
// railway.json's start command is `prisma migrate deploy && npm start`, so
// AuctionProxyBid exists before this code runs in the normal case. This flag
// covers the abnormal one: if the table is genuinely absent, proxy bidding
// switches OFF and the auction house keeps working as plain highest-bid
// bidding with the new increments still enforced — rather than every bid in
// the game failing with an unhandled 42P01.
//
// This is only possible because the maximum lives in its OWN table. Had it
// been columns on Auction, the failure would be a missing column inside
// `prisma.auction.findUnique`, which is not catchable in any useful way.
//
// ── DEGRADATION IS A COOLDOWN, NOT A SENTENCE ────────────────────────
// This used to be a boolean that latched for the life of the process, and
// `isMissingTable` used to match the loose substring "does not exist in the
// current database" — so ONE transient error, about ANY relation, silently
// turned proxy bidding off until the next deploy while the UI carried on
// promising it. Reproduced by execution in
// tests/auctionProbeShillDegrade.test.ts.
//
// Two changes: the detector now insists on either Prisma's own P2021, the
// SQLSTATE 42P01, or a message that actually NAMES this table; and the flag
// is a deadline, so the next request after the cooldown re-probes and
// recovers by itself.
const DEGRADE_COOLDOWN_MS = 60_000;
let proxyMissingUntil = 0;
let missingReported = false;

function isMissingTable(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === "P2021") return true; // Prisma: table does not exist
  const msg = String((e as Error)?.message ?? "");
  if (msg.includes("42P01")) return true; // Postgres: undefined_table
  // Anything else must name THIS table. A message about some other relation
  // is somebody else's outage and must not disable bidding here.
  return /AuctionProxyBid/i.test(msg) && /does not exist/i.test(msg);
}

function noteMissing(where: string): void {
  proxyMissingUntil = Date.now() + DEGRADE_COOLDOWN_MS;
  if (missingReported) return;
  missingReported = true;
  void recordError({
    kind: "server",
    message: "auction_proxy_table_missing",
    source: `auctionProxy.${where}`,
    meta: {
      note: "proxy bidding degraded for 60s, then re-probed; if this repeats, run prisma migrate deploy",
    },
  });
}

/**
 * Test seam + ops: is proxy bidding currently available?
 *
 * Self-healing: once the cooldown lapses this reports available again and the
 * next call re-probes the table for real. A genuinely absent table simply
 * re-degrades on the next query, at a cost of one failed statement a minute.
 */
export function proxyBiddingAvailable(): boolean {
  if (proxyMissingUntil === 0) return true;
  if (Date.now() < proxyMissingUntil) return false;
  proxyMissingUntil = 0;
  missingReported = false;
  return true;
}

/** Test seam only — resets the degradation flag between cases. */
export function __resetProxyAvailability(): void {
  proxyMissingUntil = 0;
  missingReported = false;
}

/**
 * The two numbers the escalation is keyed on, plus whether this bidder is
 * new here. One groupBy, not one query per bidder.
 *
 * Read from the Bid table, which only ever grows — so the concentration
 * ratio is monotone by construction and CANNOT be reset by triggering the
 * anti-snipe extension. That would otherwise be a live exploit: bid in the
 * final minute to extend the clock and drop the increment back to base.
 */
export async function readContest(auctionId: string, bidderId: string): Promise<Contest> {
  const rows = await prisma.bid.groupBy({
    by: ["bidderId"],
    where: { auctionId },
    _count: { _all: true },
  });
  let bidCount = 0;
  let bidderBidCount = 0;
  for (const r of rows) {
    bidCount += r._count._all;
    if (r.bidderId === bidderId) bidderBidCount = r._count._all;
  }
  return { bidCount, distinctBidders: rows.length, bidderIsNew: bidderBidCount === 0, bidderBidCount };
}

/** Batched contest counts for a list of auctions (browse / my-auctions). */
export async function readContests(
  auctionIds: string[],
): Promise<Map<string, { bidCount: number; distinctBidders: number }>> {
  const out = new Map<string, { bidCount: number; distinctBidders: number }>();
  if (auctionIds.length === 0) return out;
  const rows = await prisma.bid.groupBy({
    by: ["auctionId", "bidderId"],
    where: { auctionId: { in: auctionIds } },
    _count: { _all: true },
  });
  for (const r of rows) {
    const cur = out.get(r.auctionId) ?? { bidCount: 0, distinctBidders: 0 };
    cur.bidCount += r._count._all;
    cur.distinctBidders += 1;
    out.set(r.auctionId, cur);
  }
  for (const id of auctionIds) if (!out.has(id)) out.set(id, { bidCount: 0, distinctBidders: 0 });
  return out;
}

/**
 * THE LEADER'S SECRET MAXIMUM. Server-internal only.
 *
 * Every caller must treat the result as secret: it may be used to COMPUTE a
 * new public price, and it may be returned to its own owner, but it must
 * never be placed in a payload sent to anyone else. There is exactly one
 * caller (the bid route) and one owner-facing accessor (readOwnProxyMaxes).
 *
 * ── THE ROW MUST BELONG TO THE PLAYER WHO ACTUALLY HOLDS THE LOT ─────
 * `expectedLeaderId` is REQUIRED, and a row belonging to anyone else is
 * reported as NO ROW AT ALL. This closes a real desync: a single degraded
 * write moved the price without updating the stored maximum, stranding it on
 * the PREVIOUS leader — and that stale maximum then auto-defended the lot
 * against live challengers, beating a bidder who was racing nobody.
 * Reproduced by execution in tests/auctionProbeShillDegrade.test.ts.
 *
 * The same guard covers the benign race (a rival's bid commits between the
 * caller's auction read and this one): there the auction row is stale by one
 * round-trip, we correctly decline to resolve against a maximum that is not
 * the one we think it is, and the caller's compare-and-swap on `currentBid`
 * then fails anyway and returns a 409 asking for a retry.
 *
 * NOTHING IS DELETED HERE, deliberately. A stranded row is indistinguishable
 * from a freshly-written one belonging to a leader we have not observed yet,
 * so "clean it up" would sometimes destroy a live maximum. Ignoring it is
 * safe and self-healing: the next accepted bid upserts the row correctly.
 */
export async function readLeaderProxySecret(
  auctionId: string,
  expectedLeaderId: string | null,
): Promise<ProxyState | null> {
  if (!expectedLeaderId || !proxyBiddingAvailable()) return null;
  try {
    const row = await prisma.auctionProxyBid.findUnique({
      where: { auctionId },
      select: { bidderId: true, maxAmount: true },
    });
    if (!row || row.bidderId !== expectedLeaderId) return null;
    return row;
  } catch (e) {
    if (isMissingTable(e)) { noteMissing("readLeaderProxySecret"); return null; }
    throw e;
  }
}

/**
 * The caller's OWN maxima across a set of auctions, for display back to
 * them. The `bidderId: viewerId` term is a POSITIVE identity filter, so this
 * is structurally incapable of returning someone else's maximum — there is
 * no code path where a wrong viewerId yields another player's number, only
 * an empty map.
 */
export async function readOwnProxyMaxes(
  auctionIds: string[],
  viewerId: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!proxyBiddingAvailable() || auctionIds.length === 0) return out;
  try {
    const rows = await prisma.auctionProxyBid.findMany({
      where: { auctionId: { in: auctionIds }, bidderId: viewerId },
      select: { auctionId: true, maxAmount: true },
    });
    for (const r of rows) out.set(r.auctionId, r.maxAmount);
    return out;
  } catch (e) {
    if (isMissingTable(e)) { noteMissing("readOwnProxyMaxes"); return out; }
    throw e;
  }
}

/**
 * Install the new leader's maximum, inside the caller's transaction and
 * ONLY after the Auction compare-and-swap has already won. Ordering is the
 * concurrency argument: the CAS on `currentBid` is what arbitrates, so a
 * proxy row can only change on the write that also moved the price.
 */
export async function writeLeaderProxy(
  tx: { auctionProxyBid: { upsert: (args: unknown) => Promise<unknown> } },
  auctionId: string,
  bidderId: string,
  maxAmount: number,
): Promise<void> {
  if (!proxyBiddingAvailable()) return;
  await tx.auctionProxyBid.upsert({
    where: { auctionId },
    create: { auctionId, bidderId, maxAmount },
    update: { bidderId, maxAmount, updatedAt: new Date() },
  });
}

/**
 * Raise the leader's OWN maximum without moving the public price.
 *
 * Compare-and-swap on the stored maximum itself: this is the one bidding
 * path that does not move `currentBid`, so the Auction CAS cannot arbitrate
 * it and this predicate does instead. Two concurrent raises from the same
 * account serialise, and the loser gets 0 rows and a 409 — the same shape as
 * the price CAS, with no shared lock and no possibility of a lost update.
 *
 * @returns true when the raise was applied.
 */
export async function raiseOwnProxyMax(
  auctionId: string,
  bidderId: string,
  expectedMax: number,
  newMax: number,
): Promise<boolean> {
  if (!proxyBiddingAvailable()) return false;
  try {
    const claim = await prisma.auctionProxyBid.updateMany({
      where: { auctionId, bidderId, maxAmount: expectedMax },
      data: { maxAmount: newMax, updatedAt: new Date() },
    });
    return claim.count > 0;
  } catch (e) {
    if (isMissingTable(e)) { noteMissing("raiseOwnProxyMax"); return false; }
    throw e;
  }
}
