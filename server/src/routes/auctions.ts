import { Hono, type Context } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser, blockStream } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { getIo, sendToUserGlobal } from "../socket.js";
import { computeAccountLevel } from "../lib/level.js";
import { validateSave } from "../lib/saveValidation.js";
import { emitSaveAdopt } from "../lib/saveAdopt.js";
import { enqueuePrizeGrant } from "../lib/prizeGrant.js";
import { recordError } from "../lib/errorReporting.js";
import type { Prize } from "../lib/giveaway.js";
import {
  MAX_BID,
  MIN_STARTING_BID,
  formatMoney,
  minAcceptableBid,
  minIncrementFor,
  resolveProxy,
} from "../lib/auctionBidRules.js";
import {
  proxyBiddingAvailable,
  raiseOwnProxyMax,
  readContest,
  readContests,
  readLeaderProxySecret,
  readOwnProxyMaxes,
  writeLeaderProxy,
} from "../lib/auctionProxy.js";
import { noteLosingBid, noteSelfBidBlocked } from "../lib/auctionShillWatch.js";

const app = new Hono();

const MIN_DURATION_MIN = 10;
const MAX_DURATION_MIN = 60 * 24 * 2; // 48h
// eBay-style soft close: a bid landing inside this window pushes endsAt
// out by this much, so a listing can't be sniped in its closing seconds.
//
// PROXY BIDDING COMPLEMENTS THIS RATHER THAN DUPLICATING IT: the proxy
// removes the MOTIVE to snipe (a later click cannot beat a higher maximum)
// and the extension removes the OPPORTUNITY. Critically, the extension fires
// only when the PUBLIC PRICE MOVES — never when the leader merely raises
// their own hidden maximum. Otherwise the leader could bump their own
// maximum every 59 seconds and hold the auction open forever.
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

// THE ALLOWLIST. Every field that reaches another player passes through here
// and through serializeAuctions below. A bidder's secret maximum lives in a
// DIFFERENT TABLE (AuctionProxyBid) precisely so that it cannot be added to
// an auction payload by accident — see that migration's header for why the
// alternative (columns on Auction) was rejected.
const AUCTION_SELECT = {
  id: true, sellerId: true, lotKind: true,
  pokemonId: true, pokemonSnapshot: true, itemId: true, itemQty: true,
  startingBid: true, currentBid: true, currentBidderId: true,
  status: true, endsAt: true, createdAt: true, settledAt: true,
} as const;

type AuctionRow = {
  id: string; sellerId: string; lotKind: string;
  pokemonId: string | null; pokemonSnapshot: string | null;
  itemId: string | null; itemQty: number | null;
  startingBid: number; currentBid: number; currentBidderId: string | null;
  status: string; endsAt: Date; createdAt: Date; settledAt: Date | null;
};

/**
 * Serialise auctions FOR ONE VIEWER.
 *
 * Batched on purpose: this used to issue three queries PER auction (150 for a
 * 50-row browse page) and this codebase has already had a Postgres
 * connection-ceiling incident from exactly that shape. It is now three
 * queries total regardless of how many auctions are returned, while adding
 * two new pieces of information.
 *
 * `yourMax` is the ONLY place a maximum ever leaves the server, and it is
 * gated by a positive `bidderId === viewerId` filter inside
 * readOwnProxyMaxes — a wrong viewerId yields an empty map, never another
 * player's number.
 *
 * `minNextBid` is exact for THIS viewer, because the same groupBy that counts
 * the contest also reveals whether this viewer has bid here before (a
 * returning repeat-bidder faces a higher minimum than a newcomer, and a hint
 * that ignored that would produce precisely the "typed a number, got
 * rejected, told nothing" failure this work exists to remove).
 */
async function serializeAuctions(rows: AuctionRow[], viewerId: string) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const userIds = Array.from(new Set([
    ...rows.map((r) => r.sellerId),
    ...rows.map((r) => r.currentBidderId).filter((v): v is string => !!v),
  ]));
  const [contests, ownMaxes, users, viewerBidRows] = await Promise.all([
    readContests(ids),
    readOwnProxyMaxes(ids, viewerId),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }),
    prisma.bid.findMany({
      where: { auctionId: { in: ids }, bidderId: viewerId },
      select: { auctionId: true },
      distinct: ["auctionId"],
    }),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  const viewerHasBid = new Set(viewerBidRows.map((b) => b.auctionId));

  return rows.map((a) => {
    // An item lot has no snapshot to parse. Guarding on the FIELD rather
    // than on lotKind keeps a malformed row (kind says pokemon, snapshot is
    // null) from throwing here and taking the whole browse page with it.
    let pokemon: unknown = null;
    if (a.pokemonSnapshot) {
      try { pokemon = JSON.parse(a.pokemonSnapshot); } catch { /* leave null */ }
    }
    const contest = contests.get(a.id) ?? { bidCount: 0, distinctBidders: 0 };
    const minNextBid = minAcceptableBid(a, {
      bidCount: contest.bidCount,
      distinctBidders: contest.distinctBidders,
      bidderIsNew: !viewerHasBid.has(a.id),
    });
    const youAreHighBidder = !!a.currentBidderId && a.currentBidderId === viewerId;
    return {
      id: a.id,
      sellerUsername: nameOf.get(a.sellerId) ?? null,
      /**
       * Whether this lot is the VIEWER'S OWN listing. Not a secret — the
       * seller's username is right there — but the client had no way to
       * derive it, so Browse rendered a full, enabled bid box on your own
       * Pokemon and you only found out it was impossible after a round trip.
       */
      youAreSeller: a.sellerId === viewerId,
      /**
       * "pokemon" | "item" — which of the two fields below is filled.
       *
       * Normalised rather than passed through. `JSON.stringify` DROPS keys
       * whose value is undefined, so a row that somehow reached here without
       * the column would send no `lotKind` at all and the client would have
       * to guess — which is exactly what the payload audit test caught. The
       * database default makes that unreachable in production; this makes it
       * unreachable everywhere.
       */
      lotKind: a.lotKind === "item" ? "item" : "pokemon",
      pokemon,
      item: a.lotKind === "item" && a.itemId ? { itemId: a.itemId, quantity: a.itemQty ?? 1 } : null,
      startingBid: a.startingBid,
      currentBid: a.currentBid,
      currentBidderUsername: a.currentBidderId ? nameOf.get(a.currentBidderId) ?? null : null,
      bidCount: contest.bidCount,
      distinctBidders: contest.distinctBidders,
      /** What THIS viewer must bid at least. Server recomputes on submit. */
      minNextBid,
      /** The minimum RAISE component, for explaining the rule in the UI. */
      minIncrement: a.currentBid > 0 ? minNextBid - a.currentBid : 0,
      youAreHighBidder,
      /**
       * The viewer's OWN maximum, or null. Never anyone else's.
       *
       * GATED ON ACTUALLY HOLDING THE LOT. Only one maximum is stored per
       * auction — the leader's — so a row naming a viewer who does NOT lead is
       * by definition stale: a degraded write moved the price without updating
       * it. Showing it back anyway told a beaten player they still held a
       * $55,555,555 maximum on a lot somebody else had taken. Reproduced by
       * execution in tests/auctionProbeShillDegrade.test.ts.
       */
      yourMax: youAreHighBidder ? ownMaxes.get(a.id) ?? null : null,
      status: a.status,
      endsAt: a.endsAt,
      createdAt: a.createdAt,
      settledAt: a.settledAt,
    };
  });
}

// GET /api/auctions — active listings, soonest-ending first.
app.get("/", requireUser, async (c) => {
  const user = c.get("user");
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50));
  const rows = await prisma.auction.findMany({
    where: { status: "active" },
    orderBy: { endsAt: "asc" },
    take: limit,
    select: AUCTION_SELECT,
  });
  return c.json({ auctions: await serializeAuctions(rows, user.id) });
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
    serializeAuctions(selling, user.id),
    serializeAuctions(biddingOn, user.id),
  ]);
  return c.json({ selling: sellingOut, bidding: biddingOut });
});

// GET /api/auctions/:id — single auction + recent bid history.
app.get("/:id", requireUser, async (c) => {
  const user = c.get("user");
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
  const [auction] = await serializeAuctions([a], user.id);
  // Bid.amount is PUBLIC — it is rendered here next to a username. That is
  // exactly why a maximum is never stored in it: `amount` is the resulting
  // public price when the bidder took the lead, or their own already-defeated
  // maximum when they were outbid instantly. A STANDING maximum never
  // appears here.
  return c.json({
    auction,
    bids: bidRows.map((b) => ({ id: b.id, amount: b.amount, username: nameOf.get(b.bidderId) ?? "?", createdAt: b.createdAt })),
  });
});


/**
 * A machine's inventory id. TM01-TM95, HM01-HM06.
 *
 * A regex rather than an imported allowlist, and that is safe because it is
 * not the security boundary: the escrow below refuses to list anything the
 * seller does not actually hold in their save, so an invented id fails on
 * ownership before this pattern ever matters. The pattern's job is only to
 * keep the market to the thing it was opened for.
 */
const MACHINE_ID = /^(tm|hm)\d\d$/;

/**
 * List an ITEM lot.
 *
 * ── WHY ONLY MACHINES, FOR NOW ───────────────────────────────────────
 * Machines are the item this market exists for: you turn up a second TM26 on
 * a route you were farming for something else, it is reusable so the spare
 * does nothing, and the player who wants it is waiting on a rotation or a
 * 1.5% drop. That is a real trade with a real price.
 *
 * Poke Balls and repels are not — they are bought at a fixed price from a
 * shop that never runs out, so an auction for them is either a gift or a
 * scam, and either way it is noise in the browse list. The schema is general
 * (itemId + itemQty); the policy is narrow, and this is the one line to move
 * when that changes.
 *
 * ── ESCROW ───────────────────────────────────────────────────────────
 * Identical in shape to the Pokemon path: the item leaves the seller's save
 * the moment it is listed, in the same transaction that creates the auction,
 * under a compare-and-swap on the version we read. It cannot be used, sold to
 * a shop, or double-listed while it is up. Settlement delivers it from the
 * row; cancel and expiry give it back.
 */
async function listItemLot(
  c: Context,
  sellerId: string,
  itemId: string,
  quantity: number,
  startingBid: number,
  durationMinutes: number,
) {
  if (!MACHINE_ID.test(itemId)) {
    return c.json({ error: "Only TMs and HMs can be auctioned." }, 400);
  }
  // Machines are reusable and capped at one per player, so a quantity above
  // one cannot be held and would not mean anything if it could.
  if (quantity !== 1) {
    return c.json({ error: "A machine is sold one at a time — it never wears out." }, 400);
  }

  const existing = await prisma.auction.findFirst({
    where: { sellerId, itemId, status: "active" },
    select: { id: true },
  });
  if (existing) return c.json({ error: "you already have that machine listed" }, 409);

  const me = await prisma.user.findUnique({
    where: { id: sellerId },
    select: { saveData: true, saveVersion: true },
  });
  const save = safeParseSave(me?.saveData ?? null);
  if (!save) return c.json({ error: "no save data" }, 400);

  const inventory = (save.inventory && typeof save.inventory === "object" && !Array.isArray(save.inventory))
    ? { ...(save.inventory as Record<string, unknown>) }
    : null;
  if (!inventory) return c.json({ error: "no save data" }, 400);
  const held = Number(inventory[itemId] ?? 0);
  if (!Number.isFinite(held) || held < quantity) {
    return c.json({ error: "you don't have that machine" }, 404);
  }

  const left = held - quantity;
  if (left <= 0) delete inventory[itemId];
  else inventory[itemId] = left;
  const escrowedSave = { ...save, inventory };
  const derived = computeAccountLevel(escrowedSave);

  let auction;
  try {
    auction = await prisma.$transaction(async (tx) => {
      const claim = await tx.user.updateMany({
        where: { id: sellerId, saveVersion: me!.saveVersion },
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
          sellerId,
          lotKind: "item",
          itemId,
          itemQty: quantity,
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
  emitSaveAdopt(sellerId);
  const [serialized] = await serializeAuctions([auction], sellerId);
  return c.json({ auction: serialized }, 201);
}

// ── A LOT IS A POKEMON OR AN ITEM ───────────────────────────────────
// `pokemonId` stays optional rather than becoming part of a discriminated
// union so that every client already in the wild — which sends a bare
// { pokemonId, startingBid, durationMinutes } — keeps working untouched
// through the deploy. A body with neither is refused below, by name.
const CreateBody = z.object({
  pokemonId: z.string().min(1).max(64).optional(),
  itemId: z.string().min(1).max(64).optional(),
  itemQuantity: z.number().int().min(1).max(999).optional(),
  // THE FLOOR. Was min(1), which is how eleven Pokemon came to be listed for
  // $1 and twenty-four for the form's untouched $100 default — including a
  // Lv100 unown with a 186 IV total that sold for $100.
  startingBid: z.number().int().min(MIN_STARTING_BID).max(MAX_BID),
  durationMinutes: z.number().int().min(MIN_DURATION_MIN).max(MAX_DURATION_MIN),
});

/**
 * EVERY REFUSAL NAMES THE RULE IT BROKE.
 *
 * "A player who types a number and gets 'rejected' with no explanation is the
 * failure mode here" — so the type-level refusals get the same treatment the
 * rule-level ones already had. These are only reachable from a crafted client
 * (the real form is a number input with a disabled submit), but "only an
 * attacker sees it" is not a reason for a response to be useless, and a
 * generic string is exactly what makes a client bug take a day to find.
 */
function explainIssue(
  issues: ReadonlyArray<{ code: string; path: PropertyKey[]; expected?: unknown }>,
  field: string,
  label: string,
  bounds: { tooSmall: string; tooBig: string; notWhole: string },
): string | null {
  const issue = issues.find((i) => i.path[0] === field);
  if (!issue) return null;
  if (issue.code === "too_small") return bounds.tooSmall;
  if (issue.code === "too_big") return bounds.tooBig;
  // Zod 3 reports `z.number().int()` on a fractional value as invalid_type
  // with expected "integer" — measured, not assumed.
  if (issue.expected === "integer") return bounds.notWhole;
  return `${label} must be a number — send a plain number, not text.`;
}

// POST /api/auctions — list a specific Pokemon (by its stable per-mon id,
// from the caller's own party or box) for auction.
app.post("/", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  if (!listLimiter.consume(user.id)) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  const body = CreateBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    // A bare "invalid request" is the exact failure mode this work exists to
    // remove, so every shape of bad listing names the rule it broke.
    const start = explainIssue(body.error.issues, "startingBid", "Starting bid", {
      tooSmall: `Starting bid must be at least ${formatMoney(MIN_STARTING_BID)}.`,
      tooBig: `Starting bid can't be above ${formatMoney(MAX_BID)}.`,
      notWhole: "Starting bid must be a whole number of dollars.",
    });
    if (start) return c.json({ error: start, minStartingBid: MIN_STARTING_BID }, 400);
    const duration = explainIssue(body.error.issues, "durationMinutes", "Duration", {
      tooSmall: `An auction must run for at least ${MIN_DURATION_MIN} minutes.`,
      tooBig: `An auction can't run for longer than ${MAX_DURATION_MIN / 60} hours.`,
      notWhole: "Duration must be a whole number of minutes.",
    });
    if (duration) {
      return c.json({ error: duration, minDurationMinutes: MIN_DURATION_MIN, maxDurationMinutes: MAX_DURATION_MIN }, 400);
    }
    return c.json({
      error: "Pick something to sell, a starting bid and a duration — that request was missing one of them.",
      issues: body.error.issues,
    }, 400);
  }
  const { pokemonId, itemId, itemQuantity, startingBid, durationMinutes } = body.data;
  if (!pokemonId && !itemId) {
    return c.json({ error: "Pick a Pokemon or an item to sell." }, 400);
  }
  if (pokemonId && itemId) {
    return c.json({ error: "One lot sells one thing — a Pokemon or an item, not both." }, 400);
  }

  if (itemId) return listItemLot(c, user.id, itemId, itemQuantity ?? 1, startingBid, durationMinutes);

  const existing = await prisma.auction.findFirst({
    where: { sellerId: user.id, pokemonId, status: "active" },
    select: { id: true },
  });
  if (existing) return c.json({ error: "that Pokemon is already listed in an active auction" }, 409);

  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { saveData: true, saveVersion: true } });
  const save = safeParseSave(me?.saveData ?? null);
  if (!save) return c.json({ error: "no save data" }, 400);
  // Narrowing for the compiler; the two guards above already refused a body
  // with neither id, and an itemId body returned through listItemLot.
  if (!pokemonId) return c.json({ error: "Pick a Pokemon or an item to sell." }, 400);
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
  const escrowParty = party.filter((m) => !(m && m.id === pokemonId));
  // ── RE-ANCHOR THE ACTIVE MON, OR STORE A SAVE THE SERVER ITSELF REFUSES ──
  // The spread carried `activePlayerPokemonIndex` and `playerPokemon` over
  // untouched while `party` got shorter. Sell the mon sitting at the last
  // party index - which is an ordinary thing to do, because the index tracks
  // whoever was last switched in and handleFaint parks it on the last living
  // member - and the stored blob has an index past the end of the party.
  //
  // saveValidation rejects exactly that ("activePlayerPokemonIndex out of
  // range"), and unlike every other save writer this path never calls
  // validateSave, so it is the one place that can PERSIST a save the server
  // would refuse from the player. Two things then break, both of them
  // invisible from here:
  //
  //   * if this account later WINS an item lot, settlement rebuilds their blob
  //     without touching the party, validateSave fails, and the settlement
  //     cancels itself - the winner never receives the machine they paid for.
  //     (Pokemon lots accidentally self-heal, because pushing the won mon
  //     makes the party long enough again.)
  //   * every admin save-patch and item grant on the account is refused with
  //     "patch produced invalid save", so the documented repair path is
  //     unavailable for precisely the accounts that need repairing.
  //
  // Clamping the index and re-pointing playerPokemon costs nothing and keeps
  // the invariant every other writer maintains.
  const escrowIdx = Math.max(0, Math.min(
    Number(save.activePlayerPokemonIndex ?? 0) || 0,
    escrowParty.length - 1,
  ));
  const escrowedSave = {
    ...save,
    party: escrowParty,
    box: box.filter((m) => !(m && m.id === pokemonId)),
    activePlayerPokemonIndex: escrowParty.length ? escrowIdx : 0,
    playerPokemon: escrowParty.length ? escrowParty[escrowIdx] : null,
  };
  // Belt and braces: refuse to STORE what we would refuse to accept — but ONLY
  // when escrowing is what broke it.
  //
  // A plain `validateSave(escrowedSave)` gate here would be a availability
  // regression: any player whose stored blob is ALREADY invalid (an old save
  // predating a validation tightening, say) would suddenly be unable to list
  // anything, and refusing them helps nobody — their save was equally invalid
  // a moment ago. So compare the two. If the input was already bad, proceed as
  // before and record it; if the input was good and our output is not, that is
  // a bug in the lines above and must never reach the database.
  const escrowValid = validateSave(escrowedSave);
  if (!escrowValid.ok) {
    const inputWasValid = validateSave(save).ok;
    void recordError({
      kind: "server", level: inputWasValid ? "error" : "warn",
      message: inputWasValid ? "auction_escrow_invalid_save" : "auction_escrow_input_already_invalid",
      source: "POST /api/auctions",
      userId: user.id,
      meta: { reason: escrowValid.reason, inputWasValid },
    });
    if (inputWasValid) {
      return c.json({ error: "couldn't list that right now — please try again" }, 500);
    }
  }
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
  const [serialized] = await serializeAuctions([auction], user.id);
  return c.json({ auction: serialized }, 201);
});

/**
 * `amount` IS THE BIDDER'S MAXIMUM, not the price they will pay.
 *
 * One number, deliberately: with proxy bidding "bid exactly $X" and "my
 * maximum is $X" are the same submission, so a second field would be a
 * second thing to get wrong and a second thing to attack. A player who types
 * the displayed minimum gets today's behaviour exactly; a player who types
 * more is protected by the proxy and still pays only what it takes.
 */
const BidBody = z.object({ amount: z.number().int().min(1).max(MAX_BID) });

const BID_SELECT = {
  id: true, sellerId: true, lotKind: true, itemId: true,
  startingBid: true, currentBid: true,
  currentBidderId: true, status: true, endsAt: true,
} as const;

/** A player's last-synced spendable money. */
async function readMoney(userId: string): Promise<{ money: number; username: string | null; ok: boolean }> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { saveData: true, username: true } });
  const save = safeParseSave(u?.saveData ?? null);
  const money = Number(save?.money ?? 0);
  return {
    money: Number.isFinite(money) ? money : 0,
    username: u?.username ?? null,
    ok: !!save && Number.isFinite(money),
  };
}

// POST /api/auctions/:id/bids — submit a MAXIMUM bid.
//
// ── THE MODEL ────────────────────────────────────────────────────────
// The server holds the leader's maximum secretly and moves the public price
// only as far as it must, so the lot goes to whoever valued it highest
// rather than whoever clicked last. Resolution is CLOSED FORM (see
// resolveProxy): one comparison, zero iterations. There is no auto-raise
// loop, therefore nothing to deadlock, nothing to double-fire, and no
// termination argument required beyond "it is an expression".
//
// ── MONEY IS STILL NOT ESCROWED ──────────────────────────────────────
// Settlement checks affordability against live saveData and that is
// unchanged (lib/auctionSettlement.ts). What is added here is the guarantee
// that the SERVER never walks a bidder up to a number they never had:
//   (c) at submit, a maximum above the bidder's synced balance is REFUSED
//       with the balance named; and
//   (b) at the price move, the leader's effective maximum is capped at their
//       own synced balance, and if that cap falls below the minimum needed to
//       defend, they are DROPPED and told so.
// Both are needed. (c) alone goes stale the moment a balance changes; (b)
// alone silently ceilings a player who typed a big number and never explains
// why they stopped winning. Neither touches the money model.
//
// This is not hypothetical: 10 of the 78 contested auctions in production
// (12.8%) ended `cancelled` because the winner could not pay, including a
// $4,000,010 shiny nidorina whose winner holds $1,420 today. Those were
// reflex-war prices that no proxy would ever have produced.
app.post("/:id/bids", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!bidLimiter.consume(user.id)) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);
  const body = BidBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({
      error: explainIssue(body.error.issues, "amount", "Your maximum", {
        tooSmall: "Your maximum must be at least $1.",
        tooBig: `That bid is too large — the most anyone can bid is ${formatMoney(MAX_BID)}.`,
        notWhole: "Your maximum must be a whole number of dollars.",
      }) ?? "Send an amount — a whole number of dollars.",
    }, 400);
  }
  const { amount } = body.data;

  // Explicit select — this used to be a bare findUnique that pulled every
  // column into request scope. Nothing here may ever be spread into a
  // response.
  const auction = await prisma.auction.findUnique({ where: { id }, select: BID_SELECT });
  if (!auction) return c.json({ error: "auction not found" }, 404);
  if (auction.status !== "active" || auction.endsAt.getTime() <= Date.now()) {
    return c.json({ error: "this auction has ended" }, 409);
  }
  // SHILL BIDDING, trivial case: a seller cannot bid on their own lot. Alt
  // accounts cannot be stopped outright, but this one can and always could.
  //
  // The ATTEMPT is now recorded. The real client never renders a bid box on
  // your own listing (see `youAreSeller`), so a request that reaches here was
  // crafted, and that is worth knowing about.
  if (auction.sellerId === user.id) {
    noteSelfBidBlocked(id, user.id, amount);
    return c.json({ error: "you can't bid on your own auction" }, 400);
  }

  // ── A MACHINE YOU ALREADY OWN ─────────────────────────────────────
  // Refused here, before any money is committed, because winning it would be
  // strictly worse than losing: machines are reusable and capped at one, so
  // settlement cannot deliver a second copy and would cancel the whole lot —
  // after the bidding had already pushed the price up and denied it to
  // someone who could actually use it.
  //
  // Not a substitute for the settlement check: a bidder can find their own
  // copy on a route during a 48-hour listing, and that path is handled there.
  // This is the one that saves people from an obvious mistake.
  if (auction.lotKind === "item" && auction.itemId) {
    const holder = await prisma.user.findUnique({ where: { id: user.id }, select: { saveData: true } });
    const holderSave = safeParseSave(holder?.saveData ?? null);
    const inv = (holderSave?.inventory && typeof holderSave.inventory === "object" && !Array.isArray(holderSave.inventory))
      ? (holderSave.inventory as Record<string, number>)
      : {};
    if (Number(inv[auction.itemId] ?? 0) > 0) {
      return c.json({
        error: "You already have that machine — it never wears out, so a second one would do nothing.",
      }, 400);
    }
  }

  const me = await readMoney(user.id);
  if (!me.ok) return c.json({ error: "insufficient funds for that bid" }, 400);
  // (c) AFFORDABILITY AT SUBMIT. Names the balance, because "insufficient
  // funds" with no number is unactionable. The client calls syncNow() before
  // bidding so this reads fresh money.
  if (amount > me.money) {
    return c.json({
      error: `Your maximum can't exceed your balance of ${formatMoney(me.money)}.`,
      yourBalance: me.money,
    }, 400);
  }

  const contest = await readContest(id, user.id);
  // The expected leader is passed IN: a stored maximum that does not belong
  // to whoever currently holds the lot is reported as no maximum at all, so a
  // row stranded by a degraded write can neither defend the lot nor be read
  // back to the wrong player. See readLeaderProxySecret.
  const leaderProxy = await readLeaderProxySecret(id, auction.currentBidderId);

  // ── BRANCH A: you already hold the lot ────────────────────────────
  // Raising your own hidden maximum is the ONLY legal action here. It does
  // not move the price, create a Bid row, count toward the contest, or
  // extend endsAt. Bidding against yourself was 327 of 1,020 real bids
  // (32.1%) — one shiny gengar took 18 consecutive self-raises from a single
  // account, 13 of them +$1 inside 12 seconds — and it is pure noise.
  if (auction.currentBidderId === user.id) {
    // THE STORED ROW MUST BE PROVABLY YOURS BEFORE IT IS READ BACK.
    //
    // `auction` and `leaderProxy` are two SEPARATE un-transacted reads, so
    // `auction.currentBidderId === user.id` does NOT imply the proxy row is
    // this caller's. Two ways it can belong to somebody else:
    //   1. a rival's whole bid commits between those two reads (the auction
    //      row is stale by one round-trip); and
    //   2. the row is stranded on a PREVIOUS leader, because one table-level
    //      error put auctionProxy.ts into degraded mode for a single write —
    //      the price moved, writeLeaderProxy no-opped, and the row never
    //      caught up. That desync outlives the blip.
    // In either case the `yourMax` branch below would hand this caller
    // ANOTHER PLAYER'S SECRET MAXIMUM, verbatim, in the message AND in the
    // `yourMax` field. Both cases reproduced by driving this route.
    // A row that is not yours is, for you, no stored maximum at all.
    if (!leaderProxy || leaderProxy.bidderId !== user.id) {
      return c.json({ error: "You're already the highest bidder on this auction." }, 400);
    }
    // RETRACTION IS IMPOSSIBLE: a maximum may only be raised. This is what
    // makes probing self-punishing — a prober whose number beats the leader
    // becomes the leader at their own probe price with no way out.
    if (amount <= leaderProxy.maxAmount) {
      return c.json({
        error: `You're already the highest bidder. Your maximum is ${formatMoney(leaderProxy.maxAmount)} — enter more than that to raise it. Maximums can't be lowered or withdrawn.`,
        yourMax: leaderProxy.maxAmount,
      }, 400);
    }
    // CAS on the stored maximum itself — the one bidding path the price CAS
    // cannot arbitrate, because the price does not move.
    const raised = await raiseOwnProxyMax(id, user.id, leaderProxy.maxAmount, amount);
    if (!raised) return c.json({ error: "someone else just bid — refresh and try again" }, 409);
    return c.json({
      ok: true,
      currentBid: auction.currentBid,
      endsAt: auction.endsAt,
      youAreHighBidder: true,
      yourMax: amount,
      priceMoved: false,
    });
  }

  // ── THE MONEY CEILING ─────────────────────────────────────────────
  // `minAcceptableBid` clamps to MAX_BID, so this is the one price at which
  // the required minimum EQUALS the current bid instead of exceeding it —
  // there is no larger integer the column can hold. Without this guard the
  // `amount < required` test below passes for an exact match, and the lot
  // changes hands at the SAME price: a free transfer, and a tie that beats
  // the incumbent rather than losing to it, contradicting the tie rule
  // everywhere else in this file.
  //
  // Unreachable against today's data (largest balance in production ~$110M,
  // largest live ask $20M), and pinned by auctionRoute.test.ts because a tie
  // rule that holds at every price except one is not a tie rule.
  if (auction.currentBid >= MAX_BID) {
    return c.json({
      error: `This auction has reached the ${formatMoney(MAX_BID)} ceiling and can't be raised any further.`,
      minNextBid: MAX_BID,
      minIncrement: 0,
      currentBid: auction.currentBid,
    }, 400);
  }

  // ── The minimum this bidder must meet ─────────────────────────────
  // Recomputed HERE, server-side, from the auction row and the Bid table.
  // The request body contributes exactly one number and cannot influence
  // this, so a crafted socket/HTTP payload gains nothing.
  const required = minAcceptableBid(auction, contest);
  if (amount < required) {
    const step = auction.currentBid > 0 ? minIncrementFor(auction.currentBid, contest) : 0;
    return c.json({
      error: auction.currentBid > 0
        ? `Minimum bid is ${formatMoney(required)} — the current ${formatMoney(auction.currentBid)} plus a ${formatMoney(step)} raise.`
        : `Minimum bid is ${formatMoney(required)} — the seller's starting bid.`,
      minNextBid: required,
      minIncrement: step,
      currentBid: auction.currentBid,
    }, 400);
  }

  const previousBidderId = auction.currentBidderId;
  let newPrice: number;
  let newLeaderId: string;
  let publicBidAmount: number;
  let droppedLeader: { id: string; max: number; balance: number } | null = null;

  if (!proxyBiddingAvailable()) {
    // DEGRADED MODE — AuctionProxyBid is absent, so no maximum can be
    // stored. The submitted amount IS the bid: today's exact semantics, with
    // the new increment still enforced above. Never reached once the
    // migration is applied (railway.json runs `migrate deploy` first).
    newPrice = amount;
    newLeaderId = user.id;
    publicBidAmount = newPrice;
  } else if (!leaderProxy || !previousBidderId) {
    // NO INCUMBENT MAXIMUM TO RACE. Either the lot is unbid, or its leader
    // bid before proxy bidding shipped — in which case they committed
    // exactly `currentBid` and nothing more, so the challenger needs only
    // the minimum to take it. This is the path all 26 live auctions take on
    // their next bid.
    newPrice = required;
    newLeaderId = user.id;
    publicBidAmount = newPrice;
  } else {
    // (b) AFFORDABILITY AT THE PRICE MOVE. The leader defends only with what
    // they can actually pay right now. Exactly one check, not a loop,
    // because resolution is closed form.
    const leaderMoney = await readMoney(previousBidderId);
    const effectiveLeaderMax = Math.min(leaderProxy.maxAmount, leaderMoney.money);
    if (effectiveLeaderMax < required) {
      // The leader cannot cover even the minimum defence, so the challenger
      // takes the lot at the minimum either way.
      //
      // WHY THE GUARD: `auction:proxy_dropped` says "your synced balance can
      // no longer cover this", so it may only fire when the BALANCE is what
      // bit. A leader whose stored maximum is simply exhausted was plainly
      // outbid — the ordinary `auction:outbid` notice below covers that — and
      // that is the COMMON shape, not an edge case: a bidder who types the
      // stated minimum holds max === currentBid, so `required` clears their
      // maximum on the very next bid. Firing here unguarded told a player
      // holding $500,000,000 that their balance had run out (measured:
      // yourMax 500,000 / balance 500,000,000).
      if (leaderMoney.money < leaderProxy.maxAmount) {
        droppedLeader = { id: previousBidderId, max: leaderProxy.maxAmount, balance: leaderMoney.money };
      }
      newPrice = required;
      newLeaderId = user.id;
      publicBidAmount = required;
    } else {
      const step = minIncrementFor(auction.currentBid, contest);
      const r = resolveProxy(auction.currentBid, effectiveLeaderMax, amount, step);
      newPrice = Math.max(r.newPrice, required);
      newLeaderId = r.challengerLeads ? user.id : previousBidderId;
      publicBidAmount = Math.min(amount, newPrice);
      // THE OTHER HALF OF THE VISIBLE FAILURE MODE, and the one that actually
      // bites. The drop above only fires when the leader cannot cover even the
      // MINIMUM step. The far commoner case is a leader whose stored maximum
      // would have held the lot outright but whose synced BALANCE stopped us
      // raising for them: max $50,000,000, balance $2,000,000, beaten at
      // $2,010,000 by a $2,500,000 challenger. Before this they received a
      // bare "bob outbid you" and nothing else — outbid far below the number
      // they set, with no way to tell why. That is precisely the silent
      // failure the no-escrow model is not allowed to have.
      //
      // The condition is exact rather than approximate: `>= amount` means
      // their full maximum WOULD have defended (ties go to the incumbent), so
      // the balance cap is provably what lost it. A leader simply outbid by a
      // bigger maximum gets the ordinary outbid notice and nothing more.
      if (
        r.challengerLeads
        && effectiveLeaderMax < leaderProxy.maxAmount
        && leaderProxy.maxAmount >= amount
      ) {
        droppedLeader = { id: previousBidderId, max: leaderProxy.maxAmount, balance: leaderMoney.money };
      }
    }
  }

  // ANTI-SNIPE. Extended because the PRICE MOVED — every path reaching here
  // moves it. Branch A returned above without touching endsAt, which is what
  // stops a leader holding the auction open forever by bumping their own
  // maximum every 59 seconds.
  let newEndsAt = auction.endsAt;
  if (auction.endsAt.getTime() - Date.now() < ANTI_SNIPE_WINDOW_MS) {
    newEndsAt = new Date(Date.now() + ANTI_SNIPE_EXTENSION_MS);
  }

  // ── The compare-and-swap, UNCHANGED ───────────────────────────────
  // `where: { id, status: "active", currentBid: auction.currentBid }` is
  // exactly what it was. It is what stops two simultaneous bids both
  // "winning" against the same stale value, and it is now also what
  // arbitrates two proxies racing each other: both write against the same
  // observed currentBid, exactly one wins, and the loser gets a 409 and
  // retries from a fresh read. The proxy row is written INSIDE this
  // transaction and only after the CAS has won, so a stored maximum can
  // never diverge from the price it was resolved against.
  //
  // ── AND A SECOND GUARD ON THE STORED MAXIMUM ──────────────────────
  // The price CAS alone is NOT sufficient, because there is exactly one
  // write in this file that changes a stored maximum WITHOUT moving
  // `currentBid`: raiseOwnProxyMax (branch A). A leader who raises their own
  // maximum while a challenger's request is in flight is invisible to a
  // predicate on `currentBid`, so the challenger resolves against the stale
  // maximum and then OVERWRITES the raise with it. Reproduced by execution:
  // a leader was acknowledged at a $9,000,000 maximum and then lost the lot
  // to a $6,000,000 one.
  //
  // So: when we resolved against a stored maximum, compare-and-swap on THAT
  // ROW too, before touching the price. It is deliberately an UPDATE and not
  // a SELECT — a read would only narrow the window, because under READ
  // COMMITTED a raise that commits after our SELECT is still invisible to us
  // and we would overwrite it anyway. `UPDATE ... WHERE bidderId = ? AND
  // maxAmount = ?` takes the row lock and re-evaluates its predicate against
  // the latest committed row, so a concurrent raise either loses the
  // predicate (we abort, 409, caller retries against the higher maximum) or
  // blocks until we commit and then loses its own CAS in raiseOwnProxyMax
  // (409, same remedy). Either way the higher maximum survives.
  //
  // LOCK ORDER is proxy-then-auction here and nowhere else: raiseOwnProxyMax
  // is a single autocommit statement that takes only the proxy row, and
  // settlement never touches this table at all. Two bid transactions both
  // take the proxy row first, so they serialise rather than deadlock.
  //
  // Only needed when `leaderProxy` was non-null: with no row, the only write
  // that can create one is a bid, and a bid always moves `currentBid`, so the
  // price CAS already covers it. That keeps this off the hot path for every
  // unbid lot and every pre-proxy listing, including all 26 live ones.
  let claimed = false;
  await prisma.$transaction(async (tx) => {
    if (leaderProxy && proxyBiddingAvailable()) {
      const guard = await tx.auctionProxyBid.updateMany({
        where: { auctionId: id, bidderId: leaderProxy.bidderId, maxAmount: leaderProxy.maxAmount },
        data: { updatedAt: new Date() },
      });
      // The stored maximum moved under us. Leave `claimed` false and let the
      // caller retry — same 409 as a lost price CAS, same remedy.
      if (guard.count === 0) return;
    }
    const claim = await tx.auction.updateMany({
      where: { id, status: "active", currentBid: auction.currentBid },
      data: { currentBid: newPrice, currentBidderId: newLeaderId, endsAt: newEndsAt },
    });
    if (claim.count === 0) return;
    claimed = true;
    await tx.bid.create({ data: { auctionId: id, bidderId: user.id, amount: publicBidAmount } });
    // One stored maximum per auction: the LEADER'S. A beaten maximum is
    // consumed here — that is what keeps resolution closed form.
    const leaderMax = newLeaderId === user.id
      ? amount
      : (leaderProxy?.maxAmount ?? newPrice);
    await writeLeaderProxy(tx as never, id, newLeaderId, leaderMax);
  });
  if (!claimed) {
    return c.json({ error: "someone else just bid — refresh and try again" }, 409);
  }

  const leaderName = newLeaderId === user.id
    ? (me.username ?? user.username)
    : (await prisma.user.findUnique({ where: { id: newLeaderId }, select: { username: true } }))?.username ?? "?";

  const io = getIo();
  if (io) {
    // NO MAXIMUM IN THIS PAYLOAD. bidCount/distinctBidders are the contest
    // counts the client needs to recompute the next minimum locally; both are
    // already public (the bid history renders amounts with usernames).
    io.to(`auction:${id}`).emit("auction:bid", {
      auctionId: id,
      amount: newPrice,
      username: leaderName,
      endsAt: newEndsAt,
      bidCount: contest.bidCount + 1,
      distinctBidders: contest.distinctBidders + (contest.bidderIsNew ? 1 : 0),
    });
  }
  if (previousBidderId && previousBidderId !== newLeaderId) {
    sendToUserGlobal(previousBidderId, "auction:outbid", { auctionId: id, amount: newPrice, username: leaderName });
  }
  // SHILL / PROBE WATCH. A bid that moved the price and did NOT take the lead,
  // from an account that has now done that several times on this one lot, is
  // the shape of a ladder being run to walk an honest bidder up toward their
  // maximum. It is also the shape of an honest bidder being repeatedly outbid,
  // so it is RECORDED and never refused — see lib/auctionShillWatch.ts for
  // why blocking was rejected. Fire-and-forget: this cannot fail the bid.
  if (newLeaderId !== user.id) {
    noteLosingBid({
      auctionId: id,
      sellerId: auction.sellerId,
      bidderId: user.id,
      bidsByThisBidder: contest.bidderBidCount + 1,
      priceNow: newPrice,
    });
  }
  if (droppedLeader) {
    // THE VISIBLE FAILURE MODE of the no-escrow decision. A toast alone is
    // not enough — this fires while the player may be offline — so the
    // client also renders a durable badge from GET /mine.
    sendToUserGlobal(droppedLeader.id, "auction:proxy_dropped", {
      auctionId: id,
      yourMax: droppedLeader.max,
      balance: droppedLeader.balance,
      priceNow: newPrice,
    });
  }

  return c.json({
    ok: true,
    currentBid: newPrice,
    endsAt: newEndsAt,
    youAreHighBidder: newLeaderId === user.id,
    // Your OWN maximum echoed back to you, and only ever yours.
    yourMax: newLeaderId === user.id ? amount : null,
    // True when a hidden maximum beat you the instant you submitted. Without
    // this the client cannot explain why the player was outbid in the same
    // second, and it reads as a bug.
    outbidImmediately: newLeaderId !== user.id,
    priceMoved: true,
  });
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
    select: { id: true, lotKind: true, pokemonSnapshot: true, itemId: true, itemQty: true },
  });
  if (!auction) {
    return c.json({ error: "can't cancel — not yours, already ended, or already has a bid" }, 409);
  }
  let mon: Record<string, unknown> | null = null;
  if (auction.pokemonSnapshot) {
    try { mon = JSON.parse(auction.pokemonSnapshot); } catch { /* no restore possible */ }
  }

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

      // Pulling a listing gives the lot back, and a return is pure ADDITION —
      // it left the save at listing time, so there is nothing to remove. That
      // makes it a PendingGrant rather than a save write, for the same reason
      // as the expiry path in lib/auctionSettlement.ts: rewriting the save here
      // meant rebuilding it from the seller's LAST-UPLOADED bytes and bumping
      // saveAdoptSeq, and the client adopts that wholesale with no comparison.
      // Everything played since the last sync was discarded.
      //
      // This one was worse than it looks. Listing and bidding both call
      // `syncNow` on the client first, so there is little unsynced play to
      // lose. Cancelling never did — same file, same component, one calls it
      // and the other does not — and cancelling is the one that WRITES. So the
      // flush was on the path that only reads and missing from the path that
      // rewrites. "Pull this listing? You get it straight back" gave the mon
      // back and took the session.
      //
      // Once-only is `cancelClaim` above: it is conditional on status
      // "active" and throws when the claim misses, so this runs at most once
      // per auction. The grant is enlisted in THIS transaction, so the lot can
      // never be owed without the listing actually being cancelled.
      const prizes: Prize[] = [];
      if (auction.lotKind === "item" && auction.itemId) {
        const inv = (save?.inventory && typeof save.inventory === "object" && !Array.isArray(save.inventory))
          ? (save.inventory as Record<string, number>)
          : {};
        // Still load-bearing: the fold's item branch has no machine cap, so
        // without this a seller who re-acquired the machine mid-listing would
        // end up with two of something capped at one.
        if (!(Number(inv[auction.itemId] ?? 0) > 0)) {
          prizes.push({ kind: "item", itemId: auction.itemId, quantity: auction.itemQty ?? 1 });
        }
      } else if (mon && typeof mon.id === "string") {
        const box = Array.isArray(save?.box) ? (save!.box as Record<string, unknown>[]) : [];
        const party = Array.isArray(save?.party) ? (save!.party as Record<string, unknown>[]) : [];
        const alreadyHas = box.some((m) => m && m.id === mon!.id) || party.some((m) => m && m.id === mon!.id);
        if (!alreadyHas) {
          const label = typeof mon.nickname === "string" && mon.nickname
            ? mon.nickname
            : (typeof mon.name === "string" && mon.name ? mon.name : "Pokémon");
          prizes.push({ kind: "pokemon", label, mon });
        }
      }
      if (prizes.length) {
        await enqueuePrizeGrant(user.id, prizes, { source: "auction-return", sourceId: id }, tx);
      }
    });
  } catch (e) {
    const m = (e as Error).message;
    if (m === "auction_gone") return c.json({ error: "can't cancel — already ended or bid on" }, 409);
    if (m === "save_conflict") return c.json({ error: "your save just changed — reload and try again" }, 409);
    throw e;
  }
  // NO emitSaveAdopt. Nothing was written to this player's save, so there is
  // nothing to adopt — and telling them to adopt would throw away exactly the
  // play this change exists to protect. `enqueuePrizeGrant` has already nudged
  // them to sync, which is how the lot comes back.
  return c.json({ ok: true });
});

export default app;
