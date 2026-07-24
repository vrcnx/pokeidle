import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser, blockStream } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { getIo, sendToUserGlobal } from "../socket.js";
import { recordError } from "../lib/errorReporting.js";
import { computeAccountLevel } from "../lib/level.js";
import { emitSaveAdopt } from "../lib/saveAdopt.js";

const app = new Hono();

const MIN_DURATION_MIN = 10;
const MAX_DURATION_MIN = 60 * 24 * 2; // 48h
const MAX_BID = 999_999_999; // matches saveValidation's MAX_MONEY
// eBay-style soft close: a bid landing inside this window pushes endsAt
// out by this much, so a listing can't be sniped in its closing seconds.
const ANTI_SNIPE_WINDOW_MS = 60_000;
const ANTI_SNIPE_EXTENSION_MS = 60_000;

const listLimiter = makeRateLimiter({ tokens: 10, windowMs: 60_000 });
const bidLimiter = makeRateLimiter({ tokens: 20, windowMs: 60_000 });

function safeParseSave(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function findMonInSave(save: Record<string, unknown>, id: string): Record<string, unknown> | null {
  const party = Array.isArray(save.party) ? (save.party as Record<string, unknown>[]) : [];
  const box = Array.isArray(save.box) ? (save.box as Record<string, unknown>[]) : [];
  return party.find((m) => m && m.id === id) ?? box.find((m) => m && m.id === id) ?? null;
}

const AUCTION_SELECT = {
  id: true, sellerId: true, pokemonId: true, pokemonSnapshot: true,
  startingBid: true, currentBid: true, currentBidderId: true,
  status: true, endsAt: true, createdAt: true, settledAt: true,
} as const;

async function serializeAuction(a: {
  id: string; sellerId: string; pokemonId: string; pokemonSnapshot: string;
  startingBid: number; currentBid: number; currentBidderId: string | null;
  status: string; endsAt: Date; createdAt: Date; settledAt: Date | null;
}) {
  const [seller, bidder, bidCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: a.sellerId }, select: { username: true } }),
    a.currentBidderId
      ? prisma.user.findUnique({ where: { id: a.currentBidderId }, select: { username: true } })
      : Promise.resolve(null),
    prisma.bid.count({ where: { auctionId: a.id } }),
  ]);
  let pokemon: unknown = null;
  try { pokemon = JSON.parse(a.pokemonSnapshot); } catch { /* leave null */ }
  return {
    id: a.id,
    sellerUsername: seller?.username ?? null,
    pokemon,
    startingBid: a.startingBid,
    currentBid: a.currentBid,
    currentBidderUsername: bidder?.username ?? null,
    bidCount,
    status: a.status,
    endsAt: a.endsAt,
    createdAt: a.createdAt,
    settledAt: a.settledAt,
  };
}

// GET /api/auctions — active listings, soonest-ending first.
app.get("/", requireUser, async (c) => {
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50));
  const rows = await prisma.auction.findMany({
    where: { status: "active" },
    orderBy: { endsAt: "asc" },
    take: limit,
    select: AUCTION_SELECT,
  });
  const auctions = await Promise.all(rows.map(serializeAuction));
  return c.json({ auctions });
});

// GET /api/auctions/mine — the caller's own listings (any status) plus
// auctions they've placed a bid on, for a "my auctions" view.
app.get("/mine", requireUser, async (c) => {
  const user = c.get("user");
  const [selling, biddingOn] = await Promise.all([
    prisma.auction.findMany({
      where: { sellerId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: AUCTION_SELECT,
    }),
    prisma.auction.findMany({
      where: { bids: { some: { bidderId: user.id } } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: AUCTION_SELECT,
    }),
  ]);
  const [sellingOut, biddingOut] = await Promise.all([
    Promise.all(selling.map(serializeAuction)),
    Promise.all(biddingOn.map(serializeAuction)),
  ]);
  return c.json({ selling: sellingOut, bidding: biddingOut });
});

// GET /api/auctions/:id — single auction + recent bid history.
app.get("/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const a = await prisma.auction.findUnique({ where: { id }, select: AUCTION_SELECT });
  if (!a) return c.json({ error: "auction not found" }, 404);
  const bidRows = await prisma.bid.findMany({
    where: { auctionId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const bidderIds = Array.from(new Set(bidRows.map((b) => b.bidderId)));
  const bidders = await prisma.user.findMany({ where: { id: { in: bidderIds } }, select: { id: true, username: true } });
  const nameOf = new Map(bidders.map((u) => [u.id, u.username]));
  const auction = await serializeAuction(a);
  return c.json({
    auction,
    bids: bidRows.map((b) => ({ id: b.id, amount: b.amount, username: nameOf.get(b.bidderId) ?? "?", createdAt: b.createdAt })),
  });
});

const CreateBody = z.object({
  pokemonId: z.string().min(1).max(64),
  startingBid: z.number().int().min(1).max(MAX_BID),
  durationMinutes: z.number().int().min(MIN_DURATION_MIN).max(MAX_DURATION_MIN),
});

// POST /api/auctions — list a specific Pokemon (by its stable per-mon id,
// from the caller's own party or box) for auction.
app.post("/", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  if (!listLimiter.consume(user.id)) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  const body = CreateBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request", issues: body.error.issues }, 400);
  const { pokemonId, startingBid, durationMinutes } = body.data;

  const existing = await prisma.auction.findFirst({
    where: { sellerId: user.id, pokemonId, status: "active" },
    select: { id: true },
  });
  if (existing) return c.json({ error: "that Pokemon is already listed in an active auction" }, 409);

  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { saveData: true, saveVersion: true } });
  const save = safeParseSave(me?.saveData ?? null);
  if (!save) return c.json({ error: "no save data" }, 400);
  const mon = findMonInSave(save, pokemonId);
  if (!mon) return c.json({ error: "you don't own that Pokemon" }, 404);
  const party = Array.isArray(save.party) ? (save.party as Record<string, unknown>[]) : [];
  const box = Array.isArray(save.box) ? (save.box as Record<string, unknown>[]) : [];
  const isInParty = party.some((m) => m && m.id === pokemonId);
  if (isInParty && party.length <= 1) {
    return c.json({ error: "can't list your only Pokemon — you'd be left with an empty party" }, 400);
  }

  // ESCROW: remove the mon from the seller's save the moment it's listed, so
  // it can't be used in battle, traded, or double-listed while up for auction
  // (that was the dupe vector). pokemonSnapshot preserves its data for
  // settlement (→ winner) or cancel/expiry (→ returned to the seller). The
  // save write + auction create are one transaction (CAS on the version we
  // read); saveAdoptSeq is bumped so the seller's client drops the mon too.
  const escrowedSave = {
    ...save,
    party: party.filter((m) => !(m && m.id === pokemonId)),
    box: box.filter((m) => !(m && m.id === pokemonId)),
  };
  const derived = computeAccountLevel(escrowedSave);

  let auction;
  try {
    auction = await prisma.$transaction(async (tx) => {
      const claim = await tx.user.updateMany({
        where: { id: user.id, saveVersion: me!.saveVersion },
        data: {
          saveData: JSON.stringify(escrowedSave),
          saveVersion: { increment: 1 },
          saveAdoptSeq: { increment: 1 },
          saveUpdatedAt: new Date(),
          accountLevel: derived.accountLevel,
          totalCaughtLevels: derived.totalCaughtLevels,
          pokedexCaughtCount: derived.pokedexCaughtCount,
        },
      });
      if (claim.count === 0) throw new Error("save_conflict");
      return tx.auction.create({
        data: {
          sellerId: user.id,
          pokemonId,
          pokemonSnapshot: JSON.stringify(mon),
          startingBid,
          endsAt: new Date(Date.now() + durationMinutes * 60_000),
        },
        select: AUCTION_SELECT,
      });
    });
  } catch (e) {
    if ((e as Error).message === "save_conflict") {
      return c.json({ error: "your save just changed — reload and try again" }, 409);
    }
    throw e;
  }
  emitSaveAdopt(user.id);
  return c.json({ auction: await serializeAuction(auction) }, 201);
});

const BidBody = z.object({ amount: z.number().int().min(1).max(MAX_BID) });

// POST /api/auctions/:id/bids — place a bid. Soft-validated against the
// bidder's current money now; re-validated authoritatively at settlement
// (see lib/auctionSettlement.ts's doc comment for why there's no escrow).
app.post("/:id/bids", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!bidLimiter.consume(user.id)) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  const body = BidBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid bid" }, 400);
  const { amount } = body.data;

  const auction = await prisma.auction.findUnique({ where: { id } });
  if (!auction) return c.json({ error: "auction not found" }, 404);
  if (auction.status !== "active" || auction.endsAt.getTime() <= Date.now()) {
    return c.json({ error: "this auction has ended" }, 409);
  }
  if (auction.sellerId === user.id) return c.json({ error: "you can't bid on your own auction" }, 400);
  const minAcceptable = auction.currentBid > 0 ? auction.currentBid + 1 : auction.startingBid;
  if (amount < minAcceptable) {
    return c.json({ error: `bid must be at least ${minAcceptable}` }, 400);
  }

  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { saveData: true, username: true } });
  const save = safeParseSave(me?.saveData ?? null);
  const money = Number(save?.money ?? 0);
  if (!save || !Number.isFinite(money) || money < amount) {
    return c.json({ error: "insufficient funds for that bid" }, 400);
  }

  const previousBidderId = auction.currentBidderId;
  let newEndsAt = auction.endsAt;
  if (auction.endsAt.getTime() - Date.now() < ANTI_SNIPE_WINDOW_MS) {
    newEndsAt = new Date(Date.now() + ANTI_SNIPE_EXTENSION_MS);
  }

  // Atomic: only the writer that still sees the auction at its last-known
  // currentBid wins the row, so two near-simultaneous bids can't both
  // "succeed" against the same stale currentBid.
  const claim = await prisma.auction.updateMany({
    where: { id, status: "active", currentBid: auction.currentBid },
    data: { currentBid: amount, currentBidderId: user.id, endsAt: newEndsAt },
  });
  if (claim.count === 0) {
    return c.json({ error: "someone else just bid — refresh and try again" }, 409);
  }
  await prisma.bid.create({ data: { auctionId: id, bidderId: user.id, amount } });

  const io = getIo();
  if (io) {
    io.to(`auction:${id}`).emit("auction:bid", {
      auctionId: id, amount, username: me?.username ?? user.username, endsAt: newEndsAt,
    });
  }
  if (previousBidderId && previousBidderId !== user.id) {
    sendToUserGlobal(previousBidderId, "auction:outbid", { auctionId: id, amount, username: me?.username ?? user.username });
  }

  return c.json({ ok: true, currentBid: amount, endsAt: newEndsAt });
});

// POST /api/auctions/:id/cancel — seller can pull a listing, but only
// before anyone has bid (once there's a live bid, yanking the listing
// out from under the bidder is exactly the "sucks" trade-tab UX this
// feature replaces — better to let it run to settlement or expiry).
app.post("/:id/cancel", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const auction = await prisma.auction.findFirst({
    where: { id, sellerId: user.id, status: "active", currentBidderId: null },
    select: { id: true, pokemonSnapshot: true },
  });
  if (!auction) {
    return c.json({ error: "can't cancel — not yours, already ended, or already has a bid" }, 409);
  }
  let mon: Record<string, unknown> | null = null;
  try { mon = JSON.parse(auction.pokemonSnapshot); } catch { /* no restore possible */ }

  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { saveData: true, saveVersion: true } });
  const save = safeParseSave(me?.saveData ?? null);

  // Cancel the listing AND return the escrowed mon to the seller's box, in one
  // transaction. If either CAS loses a race, nothing commits and the seller
  // can retry — no way to end up with the auction cancelled but the mon lost.
  try {
    await prisma.$transaction(async (tx) => {
      const cancelClaim = await tx.auction.updateMany({
        where: { id, sellerId: user.id, status: "active", currentBidderId: null },
        data: { status: "cancelled", settledAt: new Date() },
      });
      if (cancelClaim.count === 0) throw new Error("auction_gone");
      if (save && mon && typeof mon.id === "string") {
        const box = Array.isArray(save.box) ? (save.box as Record<string, unknown>[]) : [];
        const party = Array.isArray(save.party) ? (save.party as Record<string, unknown>[]) : [];
        const alreadyHas = box.some((m) => m && m.id === mon!.id) || party.some((m) => m && m.id === mon!.id);
        if (!alreadyHas) {
          const restoredSave = { ...save, box: [...box, mon] };
          const derived = computeAccountLevel(restoredSave);
          const saveClaim = await tx.user.updateMany({
            where: { id: user.id, saveVersion: me!.saveVersion },
            data: {
              saveData: JSON.stringify(restoredSave),
              saveVersion: { increment: 1 },
              saveAdoptSeq: { increment: 1 },
              saveUpdatedAt: new Date(),
              accountLevel: derived.accountLevel,
              totalCaughtLevels: derived.totalCaughtLevels,
              pokedexCaughtCount: derived.pokedexCaughtCount,
            },
          });
          if (saveClaim.count === 0) throw new Error("save_conflict");
        }
      }
    });
  } catch (e) {
    const m = (e as Error).message;
    if (m === "auction_gone") return c.json({ error: "can't cancel — already ended or bid on" }, 409);
    if (m === "save_conflict") return c.json({ error: "your save just changed — reload and try again" }, 409);
    throw e;
  }
  emitSaveAdopt(user.id);
  return c.json({ ok: true });
});

export default app;
