import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { computeStatus, rewardForStreak, utcMidnight } from "../lib/dailies.js";

// Player-facing daily-reward routes. The server owns the streak and the
// once-per-day gate; the client applies the returned reward to its save.
const app = new Hono();
app.use("*", requireUser);

// GET /api/dailies/status — what the player would get and whether they can
// claim right now.
app.get("/status", async (c) => {
  const user = c.get("user");
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dailyStreak: true, longestDailyStreak: true, lastDailyClaimAt: true },
  });
  if (!row) return c.json({ error: "user not found" }, 404);
  return c.json(computeStatus(row, new Date()));
});

// POST /api/dailies/claim — claim today's reward. Atomic: the conditional
// update only matches when the last claim was before today (UTC), so two
// concurrent claims can never both succeed — the first sets lastDailyClaimAt
// to now, and the second's WHERE no longer matches.
app.post("/claim", async (c) => {
  const user = c.get("user");
  const now = new Date();
  const todayStart = utcMidnight(now);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dailyStreak: true, longestDailyStreak: true, lastDailyClaimAt: true },
  });
  if (!row) return c.json({ error: "user not found" }, 404);

  if (row.lastDailyClaimAt && row.lastDailyClaimAt.getTime() >= todayStart.getTime()) {
    const status = computeStatus(row, now);
    return c.json({ error: "already_claimed", reason: "You've already claimed today's reward.", status }, 409);
  }

  const continues = !!row.lastDailyClaimAt && row.lastDailyClaimAt.getTime() >= yesterdayStart.getTime();
  const newStreak = continues ? row.dailyStreak + 1 : 1;
  const newLongest = Math.max(row.longestDailyStreak, newStreak);
  const reward = rewardForStreak(newStreak);

  // Atomic gate: matches only if still unclaimed today.
  const res = await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [{ lastDailyClaimAt: null }, { lastDailyClaimAt: { lt: todayStart } }],
    },
    data: { dailyStreak: newStreak, longestDailyStreak: newLongest, lastDailyClaimAt: now },
  });
  if (res.count !== 1) {
    // Lost the race — another request claimed between our read and write.
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { dailyStreak: true, longestDailyStreak: true, lastDailyClaimAt: true },
    });
    return c.json({ error: "already_claimed", reason: "You've already claimed today's reward.", status: fresh ? computeStatus(fresh, now) : null }, 409);
  }

  return c.json({
    ok: true,
    reward,
    streak: newStreak,
    longestStreak: newLongest,
    // Fresh status for the UI (claimedToday true, countdown to tomorrow).
    status: computeStatus({ dailyStreak: newStreak, longestDailyStreak: newLongest, lastDailyClaimAt: now }, now),
  });
});

export default app;
