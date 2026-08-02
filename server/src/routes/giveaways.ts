import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import {
  PUBLIC_GIVEAWAY_STATUSES,
  shapePublicGiveaway,
  type GiveawayRowForView,
  type GiveawayStats,
} from "../lib/giveaway.js";
import { listPromos } from "../lib/promos.js";

// PLAYER-facing giveaway routes. Admin CRUD + drawing lives in
// routes/admin.ts behind the admin gate; this file is only what a
// normal signed-in player may do: see what is running, see what has
// already been given away, and enter.
//
// Every projection goes through shapePublicGiveaway (lib/giveaway.ts), which
// owns the privacy rules. Nothing here re-implements them.

const app = new Hono();
app.use("*", requireUser);

/** History = everything finished. Excludes draft/cancelled by construction. */
const FINISHED_STATUSES = ["closed", "drawn"] as const;

/**
 * The entry rows a viewer's projection can possibly need: their own, plus the
 * winners. Bounded by `winnerCount + 1` per giveaway.
 *
 * This replaced an unfiltered `include: { entries: … }` that pulled EVERY
 * entrant row into process memory just to compute four scalars — linear in
 * total entries, for up to 30 giveaways, on a route the client polls. The
 * filter is not only cheaper: it means a losing entrant's row is never loaded
 * at all, so their non-exposure is a property of the query rather than
 * something the serializer has to remember.
 */
function entrySelectFor(viewerId: string) {
  return {
    where: { OR: [{ userId: viewerId }, { isWinner: true }] },
    select: { userId: true, username: true, isWinner: true },
  };
}

/**
 * "Has MY prize actually landed?" — one bounded query over the viewer's own
 * PendingGrant rows. Scoped to `userId = viewer`, so it can never describe
 * anybody else's delivery state.
 *
 * Only called with the ids the viewer actually won, which is normally zero or
 * one row.
 */
async function deliveredMapFor(
  viewerId: string,
  giveawayIds: readonly string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (giveawayIds.length === 0) return out;
  const rows = await prisma.pendingGrant.findMany({
    where: { userId: viewerId, source: "giveaway", sourceId: { in: [...giveawayIds] } },
    select: { sourceId: true, deliveredAt: true },
  });
  for (const r of rows) {
    if (!r.sourceId) continue;
    // A giveaway can produce more than one grant row for the same winner in
    // theory (a re-grant after a refused fold); delivered-if-any is the
    // reading that matches what the player sees in their bag.
    out.set(r.sourceId, (out.get(r.sourceId) ?? false) || r.deliveredAt != null);
  }
  return out;
}

// Lifetime numbers change only when a giveaway is created or drawn — i.e.
// about once a day — but the list route below is polled by every signed-in
// client. Caching the shared half keeps that poll to two queries instead of
// five. The per-viewer half is never cached.
let statsCache: { at: number; value: Omit<GiveawayStats, "you"> } | null = null;
const STATS_TTL_MS = 60_000;

/** Drop the cache. Exists for tests, which change the dataset between cases
 *  faster than any real operator ever will. */
export function _resetGiveawayStatsCache() {
  statsCache = null;
}

async function sharedStats(): Promise<Omit<GiveawayStats, "you">> {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const [total, prizesAwarded, winnerRows, first] = await Promise.all([
    prisma.giveaway.count({ where: { status: { in: [...PUBLIC_GIVEAWAY_STATUSES] } } }),
    prisma.giveawayEntry.count({ where: { isWinner: true } }),
    // Distinct COUNT, emitted as a number. The usernames behind it are already
    // public per-giveaway; the set of them is not assembled here.
    prisma.giveawayEntry.findMany({
      where: { isWinner: true },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.giveaway.findFirst({
      where: { status: { in: [...PUBLIC_GIVEAWAY_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);
  const value = {
    total,
    prizesAwarded,
    distinctWinners: winnerRows.length,
    firstAt: first?.createdAt ?? null,
  };
  statsCache = { at: now, value };
  return value;
}

async function statsFor(viewerId: string): Promise<GiveawayStats> {
  const [shared, mine] = await Promise.all([
    sharedStats(),
    prisma.giveawayEntry.groupBy({
      by: ["isWinner"],
      where: { userId: viewerId },
      _count: { _all: true },
    }),
  ]);
  let entered = 0;
  let won = 0;
  for (const row of mine) {
    entered += row._count._all;
    if (row.isWinner) won += row._count._all;
  }
  return { ...shared, you: { entered, won } };
}

/** Shape a batch of rows, resolving the viewer's own delivery state first. */
async function shapeAll(rows: GiveawayRowForView[], viewerId: string) {
  const wonIds = rows
    .filter((r) => r.entries.some((e) => e.userId === viewerId && e.isWinner))
    .map((r) => r.id);
  const delivered = await deliveredMapFor(viewerId, wonIds);
  return rows
    .map((r) => shapePublicGiveaway(r, { viewerId, delivered }))
    .filter((v): v is NonNullable<typeof v> => v != null);
}

// Whether a giveaway is currently accepting entries. Status is the
// operator's intent; the dates are the schedule. Both must agree.
function isEnterable(g: { status: string; startsAt: Date | null; endsAt: Date | null }): boolean {
  if (g.status !== "open") return false;
  const now = Date.now();
  if (g.startsAt && g.startsAt.getTime() > now) return false;
  if (g.endsAt && g.endsAt.getTime() <= now) return false;
  return true;
}

// GET /api/giveaways — everything a player should see: what is live,
// what they have entered, and what has already been won (results are
// half the appeal; a giveaway nobody sees the outcome of is invisible).
app.get("/", async (c) => {
  const me = c.get("user");
  const LIMIT = 30;
  const entries = entrySelectFor(me.id);
  // Two separate bounded queries rather than one ordered-and-capped query:
  // sorting by status alphabetically puts "open" AFTER "closed"/"drawn", so
  // a single `orderBy status, take 30` could silently push currently-open
  // giveaways off the end once enough historical ones piled up. Querying
  // "open" on its own guarantees every live giveaway is always visible,
  // then closed/drawn history fills whatever budget is left.
  const [openRows, historyRows, stats] = await Promise.all([
    prisma.giveaway.findMany({
      where: { status: "open" },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      include: { entries, _count: { select: { entries: true } } },
    }),
    prisma.giveaway.findMany({
      where: { status: { in: [...FINISHED_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      include: { entries, _count: { select: { entries: true } } },
    }),
    statsFor(me.id),
  ]);
  const rows = [...openRows, ...historyRows].slice(0, LIMIT);
  const shownHistory = rows.length - openRows.length;

  return c.json({
    giveaways: await shapeAll(rows, me.id),
    stats,
    // The combined LIMIT truncates history once the archive outgrows it, and
    // the whole premise of showing history is that it keeps accumulating —
    // so tell the client whether there is more behind /history. True either
    // because the combined slice dropped rows we already fetched, or because
    // the history query itself came back full.
    hasMoreHistory: shownHistory < historyRows.length || historyRows.length >= LIMIT,
  });
});

// GET /api/giveaways/promos — the free-reward cards.
//
// Lives on this router because the dialog that shows giveaways is the same
// dialog that shows these, so the client wants them from one place and one
// auth gate. Resolution is in lib/promos.ts; this is just the surface.
//
// READ-ONLY by design. There is no claim endpoint anywhere: each promo is
// granted by the thing that proves you earned it (linking Discord grants the
// link reward), and a second path to the same prize is how one gets paid
// twice.
//
// Declared before /:id-shaped routes for the usual reason — there is no
// GET /:id in this file today, but "promos" would be a very ordinary id to
// shadow if one is ever added.
app.get("/promos", async (c) => {
  const me = c.get("user");
  return c.json({ promos: await listPromos(me.id) });
});

// GET /api/giveaways/history?before=<iso>&limit=<n> — READ-ONLY, cursor-paged
// archive. Same projection, same privacy rules, no live-only fields.
//
// Mounted inside this file's `requireUser`, so it adds no anonymous surface;
// nothing here belongs on a pre-sign-in page. There is no `GET /:id` in this
// file and the enter route is a POST, so nothing can shadow this path.
const historyQuery = z.object({
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

app.get("/history", async (c) => {
  const me = c.get("user");
  const parsed = historyQuery.safeParse({
    before: c.req.query("before") || undefined,
    limit: c.req.query("limit") || undefined,
  });
  if (!parsed.success) return c.json({ error: "bad query" }, 400);
  const limit = parsed.data.limit ?? 20;
  const before = parsed.data.before ? new Date(parsed.data.before) : null;

  // take limit+1 so "is there another page" needs no second count query.
  const rows = await prisma.giveaway.findMany({
    where: {
      status: { in: [...FINISHED_STATUSES] },
      ...(before ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    include: {
      entries: entrySelectFor(me.id),
      _count: { select: { entries: true } },
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    giveaways: await shapeAll(page, me.id),
    hasMore,
    nextBefore: page.length > 0 ? page[page.length - 1].createdAt : null,
  });
});

// POST /api/giveaways/:id/enter — one entry per player, enforced by a
// DB unique rather than a read-then-write, so a double-click or two
// tabs cannot produce two entries.
app.post("/:id/enter", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");

  const g = await prisma.giveaway.findUnique({ where: { id } });
  if (!g) return c.json({ error: "giveaway not found" }, 404);
  if (!isEnterable(g)) {
    return c.json({
      error: "entries closed",
      reason: g.status === "drawn" ? "This giveaway has already been drawn."
        : g.status === "closed" ? "Entries have closed for this giveaway."
        : g.startsAt && g.startsAt.getTime() > Date.now() ? "This giveaway has not opened yet."
        : "This giveaway is not accepting entries.",
    }, 409);
  }

  if (g.minAccountLevel != null) {
    const u = await prisma.user.findUnique({
      where: { id: me.id },
      select: { accountLevel: true },
    });
    if ((u?.accountLevel ?? 0) < g.minAccountLevel) {
      return c.json({
        error: "not eligible",
        reason: `This giveaway is for trainers at account level ${g.minAccountLevel}+. You are level ${u?.accountLevel ?? 0}.`,
      }, 403);
    }
  }

  try {
    await prisma.giveawayEntry.create({
      data: { giveawayId: id, userId: me.id, username: me.username },
    });
  } catch {
    // Unique violation = already entered. Idempotent: report success so
    // a double-submit is not an error the player has to think about.
    return c.json({ ok: true, alreadyEntered: true });
  }
  const entryCount = await prisma.giveawayEntry.count({ where: { giveawayId: id } });
  return c.json({ ok: true, alreadyEntered: false, entryCount });
});

export default app;
export { isEnterable };
