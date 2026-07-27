// Player-facing PvP endpoints. Admin tournament management lives in
// admin.ts; this file is for read-only data the game UI needs to render
// the trainer card, the leaderboard, the player's own match history,
// and the public tournament list / sign-up flow.

import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";

const app = new Hono();

// ── My rating + W/L stats ──────────────────────────────────────────
// Returns the caller's PvP rating + match counters. If they've never
// played a rated match the row may not exist yet — in that case we
// return defaults rather than 404 so the UI can show "unranked"
// alongside the same shape.
app.get("/me/rating", requireUser, async (c) => {
  const user = c.get("user");
  const row = await prisma.playerRating.findUnique({ where: { userId: user.id } });
  if (!row) {
    return c.json({
      userId: user.id,
      rating: 1000,
      peakRating: 1000,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      forfeits: 0,
      unranked: true,
    });
  }
  return c.json({ ...row, unranked: false });
});

// ── Public rating for any user (for trainer cards) ────────────────
app.get("/rating/:userId", requireUser, async (c) => {
  const id = c.req.param("userId");
  const row = await prisma.playerRating.findUnique({ where: { userId: id } });
  if (!row) {
    return c.json({
      userId: id,
      rating: 1000,
      peakRating: 1000,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      forfeits: 0,
      unranked: true,
    });
  }
  return c.json({ ...row, unranked: false });
});

// ── Leaderboard — top by rating ────────────────────────────────────
// Caps at 100 to keep the payload bounded. matchesPlayed >= 5 filter
// hides bots / first-match players from the top of the board until
// they've actually established a rating.
app.get("/leaderboard", requireUser, async (c) => {
  const limit = Math.min(100, Math.max(10, parseInt(c.req.query("limit") ?? "50", 10)));
  const minMatches = Math.max(0, parseInt(c.req.query("minMatches") ?? "5", 10));
  const rows = await prisma.playerRating.findMany({
    where: { matchesPlayed: { gte: minMatches } },
    orderBy: [{ rating: "desc" }, { matchesPlayed: "desc" }],
    take: limit,
  });
  // Decorate with usernames in one round trip.
  const ids = rows.map((r) => r.userId);
  const users = ids.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true, name: true, accountLevel: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));
  return c.json({
    leaderboard: rows.map((r, i) => {
      const u = userMap.get(r.userId);
      return {
        rank: i + 1,
        userId: r.userId,
        username: u?.username ?? "(deleted)",
        name: u?.name ?? null,
        accountLevel: u?.accountLevel ?? 0,
        rating: r.rating,
        peakRating: r.peakRating,
        matchesPlayed: r.matchesPlayed,
        wins: r.wins,
        losses: r.losses,
        forfeits: r.forfeits,
      };
    }),
  });
});

// ── Replay: full log + both teams for a single completed match ────
// Caller must have been a participant (no spectating completed matches
// of strangers, for now — we can relax this if we add a public replay
// surface). Returns the protocol log lines and both teams' JSON so
// the client can re-derive sprites + names while playing back.
app.get("/match/:id/replay", requireUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const m = await prisma.pvpMatch.findUnique({ where: { id } });
  if (!m) return c.json({ error: "match not found" }, 404);
  if (m.userAId !== user.id && m.userBId !== user.id) {
    return c.json({ error: "not your match" }, 403);
  }
  return c.json({
    match: {
      id: m.id,
      createdAt: m.createdAt,
      finishedAt: m.finishedAt,
      format: m.format,
      status: m.status,
      userAId: m.userAId,
      userAUsername: m.userAUsername,
      userATeam: safeJson(m.userATeam),
      userBId: m.userBId,
      userBUsername: m.userBUsername,
      userBTeam: safeJson(m.userBTeam),
      winnerId: m.winnerId,
      loserId: m.loserId,
      endReason: m.endReason,
      log: (m.battleLog ?? "").split("\n").filter(Boolean),
    },
  });
});

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ── My PvP match history ──────────────────────────────────────────
// Returns the caller's recent PvP matches with both teams' species/
// level summary (decoded from the PvpMatch.userATeam / userBTeam
// JSON snapshots). Capped at 50.
app.get("/me/history", requireUser, async (c) => {
  const user = c.get("user");
  const limit = Math.min(50, Math.max(10, parseInt(c.req.query("limit") ?? "20", 10)));
  const rows = await prisma.pvpMatch.findMany({
    where: { OR: [{ userAId: user.id }, { userBId: user.id }] },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return c.json({
    matches: rows.map((m) => {
      const youAreA = m.userAId === user.id;
      const opponent = youAreA
        ? { id: m.userBId, username: m.userBUsername }
        : { id: m.userAId, username: m.userAUsername };
      const result = m.winnerId === user.id ? "win"
        : m.loserId === user.id ? (m.endReason === "forfeit" ? "forfeit" : "loss")
        : "draw";
      return {
        id: m.id,
        createdAt: m.createdAt,
        finishedAt: m.finishedAt,
        format: m.format,
        opponent,
        result,
        endReason: m.endReason,
      };
    }),
  });
});

// ── Public tournaments — list ──────────────────────────────────────
// Players see open tournaments to sign up for + live ones for context.
// "scheduled" / "cancelled" / "completed" appear with status tags.
app.get("/tournaments", requireUser, async (c) => {
  const tournaments = await prisma.tournament.findMany({
    where: { status: { in: ["open", "live", "scheduled", "completed"] } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      entries: {
        select: { userId: true, username: true, eliminated: true, seed: true, ratingAtSeed: true },
      },
    },
  });
  return c.json({ tournaments });
});

// ── Tournament detail ─────────────────────────────────────────────
app.get("/tournaments/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({
    where: { id },
    include: {
      entries: {
        select: { userId: true, username: true, eliminated: true, seed: true, ratingAtSeed: true },
      },
    },
  });
  if (!t) return c.json({ error: "tournament not found" }, 404);
  return c.json({ tournament: t });
});

// ── Sign up for a tournament ──────────────────────────────────────
// Self-sign-up. Only valid when the tournament is still "open".
// Compound unique on (tournamentId, userId) prevents duplicates.
app.post("/tournaments/:id/join", requireUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t) return c.json({ error: "tournament not found" }, 404);
  if (t.status !== "open") {
    return c.json({ error: "tournament not accepting entries" }, 400);
  }
  // Already-joined check is handled by the unique constraint, but
  // surfacing a friendlier error here saves a server-side throw.
  const existing = await prisma.tournamentEntry.findUnique({
    where: { tournamentId_userId: { tournamentId: id, userId: user.id } },
  });
  if (existing) return c.json({ error: "already joined" }, 400);
  const entry = await prisma.tournamentEntry.create({
    data: { tournamentId: id, userId: user.id, username: user.username },
  });
  return c.json({ entry });
});

// ── Withdraw before the tournament starts ─────────────────────────
app.delete("/tournaments/:id/leave", requireUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t) return c.json({ error: "tournament not found" }, 404);
  if (t.status !== "open") {
    return c.json({ error: "tournament already started — can't leave" }, 400);
  }
  await prisma.tournamentEntry.deleteMany({
    where: { tournamentId: id, userId: user.id },
  });
  return c.json({ ok: true });
});

export default app;
