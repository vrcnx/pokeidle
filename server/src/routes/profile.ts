import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";

const app = new Hono();

// GET /api/profile/me/trades — caller's trade history. Up to 50 most
// recent records. Mirrors the admin /users/:id/trades shape but is
// scoped to the caller, so any signed-in player can see their own
// record. Trades record the canonical {sent, received} pair at the
// time of the trade so renames + account deletes don't rewrite
// history (a sibling user-id may be null if the partner deleted
// their account).
app.get("/me/trades", requireUser, async (c) => {
  const me = c.get("user");
  const rows = await prisma.tradeRecord.findMany({
    where: { OR: [{ userAId: me.id }, { userBId: me.id }] },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // Normalise to a "what I gave / got" shape so the client doesn't have
  // to figure out which side we're on each row.
  const trades = rows.map((r) => {
    const iAmA = r.userAId === me.id;
    return {
      id: r.id,
      at: r.createdAt,
      partnerUsername: iAmA ? r.userBUsername : r.userAUsername,
      partnerUserId: iAmA ? r.userBId : r.userAId,
      sent: {
        speciesKey: iAmA ? r.userASentSpecies : r.userBSentSpecies,
        nickname:   iAmA ? r.userASentMon     : r.userBSentMon,
        level:      iAmA ? r.userASentLevel   : r.userBSentLevel,
      },
      received: {
        speciesKey: iAmA ? r.userBSentSpecies : r.userASentSpecies,
        nickname:   iAmA ? r.userBSentMon     : r.userASentMon,
        level:      iAmA ? r.userBSentLevel   : r.userASentLevel,
      },
    };
  });
  return c.json({ trades });
});

// GET /api/profile/me — caller's profile + derived stats.
app.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json(u);
});

// GET /api/profile/:username — public profile (no email).
app.get("/:username", requireUser, async (c) => {
  const username = c.req.param("username");
  const u = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json(u);
});

export default app;
