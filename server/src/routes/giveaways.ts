import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { parsePrizes, describePrizes } from "../lib/giveaway.js";

// PLAYER-facing giveaway routes. Admin CRUD + drawing lives in
// routes/admin.ts behind the admin gate; this file is only what a
// normal signed-in player may do: see what is running, and enter.

const app = new Hono();
app.use("*", requireUser);

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
  const rows = await prisma.giveaway.findMany({
    // Never leak drafts or cancelled events to players.
    where: { status: { in: ["open", "closed", "drawn"] } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 30,
    include: {
      entries: {
        select: { userId: true, username: true, isWinner: true },
      },
    },
  });

  return c.json({
    giveaways: rows.map((g) => {
      const prizes = parsePrizes(g.prizes);
      return {
        id: g.id,
        title: g.title,
        description: g.description,
        status: g.status,
        startsAt: g.startsAt,
        endsAt: g.endsAt,
        drawnAt: g.drawnAt,
        winnerCount: g.winnerCount,
        minAccountLevel: g.minAccountLevel,
        prizes,
        prizeSummary: describePrizes(prizes),
        entryCount: g.entries.length,
        // Personalised so the UI can render the right CTA without a
        // second request.
        hasEntered: g.entries.some((e) => e.userId === me.id),
        youWon: g.entries.some((e) => e.userId === me.id && e.isWinner),
        // Winners are public once drawn — that is the point. Entrant
        // lists are NOT public: who entered and lost is nobody's
        // business, and publishing it invites harassment.
        winners: g.drawnAt
          ? g.entries.filter((e) => e.isWinner).map((e) => e.username)
          : [],
        // Published after the draw so anyone can recompute the result
        // and satisfy themselves it was not rigged.
        drawSeed: g.drawnAt ? g.drawSeed : null,
      };
    }),
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
