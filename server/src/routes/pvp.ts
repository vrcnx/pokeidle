// Player-facing PvP endpoints. Admin tournament management lives in
// admin.ts; this file is for read-only data the game UI needs to render
// the trainer card, the leaderboard, the player's own match history,
// and the public tournament list / sign-up flow.

import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { recordError } from "../lib/errorReporting.js";
import {
  PVP_BADGE_TIERS,
  PVP_MILESTONES,
  PVP_MILESTONE_BP_LIFETIME_TOTAL,
  pvpBadgeForRating,
} from "../lib/pvpBadge.js";
import {
  LADDER_BP_CAP_PER_WINDOW,
  LADDER_BP_ITEM_ID,
  LADDER_BP_LOSS,
  LADDER_BP_MIN_PER_PAYABLE_MATCH,
  LADDER_BP_WIN,
  LADDER_BP_WINDOW_MS,
  LADDER_DECAY_PERCENT_BY_MEETING,
  LADDER_DECAY_PERCENT_FLOOR,
  LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW,
  LADDER_MIN_DURATION_MS,
  LADDER_MIN_TURNS,
  LADDER_PAYABLE_PROVENANCE,
  LADDER_WIN_BONUS_BP,
  LADDER_WIN_BONUS_COOLDOWN_MS,
  readLadderHistory,
  readLadderStatus,
} from "../lib/pvpLadder.js";

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
      // Derived, never stored — see lib/pvpBadge.ts for why the primary PvP
      // reward is a pure function of rating rather than anything minted.
      badge: pvpBadgeForRating(1000, 1000, 0),
    });
  }
  return c.json({
    ...row,
    unranked: false,
    badge: pvpBadgeForRating(row.rating, row.peakRating, row.matchesPlayed),
  });
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
      badge: pvpBadgeForRating(1000, 1000, 0),
    });
  }
  return c.json({
    ...row,
    unranked: false,
    badge: pvpBadgeForRating(row.rating, row.peakRating, row.matchesPlayed),
  });
});

// ── Leaderboard — top by rating ────────────────────────────────────
// Caps at 100 to keep the payload bounded.
//
// ── WHY THE DEFAULT FILTER IS 1 MATCH AND NOT 5 ───────────────────
// It was `matchesPlayed >= 5`. Measured read-only against production: the
// maximum matchesPlayed across ALL FOUR PlayerRating rows that exist is 1, so
// this endpoint returned an EMPTY ARRAY — and leaderboard placement is itself
// one of the rewards this feature is built on. A reward nobody can appear on is
// not a reward. One rated match is enough to be on the board; zero is not, and
// `matchesPlayed` is returned on every row so the UI can mark a provisional
// rating rather than the server hiding the player entirely.
//
// `?minMatches=` still overrides, so the stricter view is one query param away
// once there is a population that can satisfy it.
app.get("/leaderboard", requireUser, async (c) => {
  const limit = Math.min(100, Math.max(10, parseInt(c.req.query("limit") ?? "50", 10)));
  const minMatches = Math.max(0, parseInt(c.req.query("minMatches") ?? "1", 10));
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
        // Derived from the row already in hand — no extra query, no stored
        // column, nothing minted. Placement on this board IS one of the
        // rewards, which is why it needed no schema at all.
        badge: pvpBadgeForRating(r.rating, r.peakRating, r.matchesPlayed),
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

// ── Ladder rewards: my position ───────────────────────────────────
//
// Read-only, and it deliberately does NOT report a Battle Point BALANCE. The
// balance lives in the player's save (`inventory.battlepoint`), which the
// client already holds; this reports what the server MINTED and what is still
// available. A second authoritative balance is the reconciliation bug class the
// save-CAS work removed, so there isn't one.
//
// EVERY RULE IS ECHOED rather than left for the client to hardcode a drifting
// second copy of — the same reason routes/away.ts echoes minMs / capMs. That is
// not decoration here: the client currently has no catalog entry for
// `battlepoint` and no BP shop, so this payload is the entire contract for the
// UI work that has to land before PVP_LADDER_REWARDS is switched on. It answers,
// without the client needing to know a single constant:
//   * what a win and a loss are worth, and the floor under decay;
//   * when my cash bonus comes back (winBonusAvailableAt) and what it will be
//     worth at my rating (winBonusMoney);
//   * how much of my rolling BP cap is left;
//   * which milestones I have and what the next one pays;
//   * that invites pay too, and that a forfeit pays nobody.
app.get("/me/ladder", requireUser, async (c) => {
  const user = c.get("user");
  const rating = await prisma.playerRating.findUnique({ where: { userId: user.id } });
  const badge = pvpBadgeForRating(rating?.rating ?? 1000, rating?.peakRating ?? 1000, rating?.matchesPlayed ?? 0);

  let status: Awaited<ReturnType<typeof readLadderStatus>> | null = null;
  try {
    status = await readLadderStatus(user.id, new Date(), rating?.rating ?? 1000);
  } catch (e) {
    // The overwhelmingly likely cause is that migration
    // 20260730120000_add_pvp_ladder has not been applied yet, i.e. the server
    // shipped ahead of the deploy. Degrade to "no ladder data" rather than
    // 500ing the PvP hub — but record it, because a panel that quietly shows
    // zeroes forever is a support ticket nobody can answer.
    void recordError({
      kind: "server",
      message: "pvp_ladder_status_read_failed",
      source: "GET /pvp/me/ladder",
      userId: user.id,
      meta: { error: String(e) },
    });
  }

  const milestones = await readMilestonesSafe(user.id);

  return c.json({
    badge,
    unranked: !rating,
    rating: rating?.rating ?? 1000,
    peakRating: rating?.peakRating ?? 1000,
    matchesPlayed: rating?.matchesPlayed ?? 0,
    ladder: status,
    // What the rules ARE, so the UI can explain a zero instead of looking broken.
    rules: {
      bpItemId: LADDER_BP_ITEM_ID,
      // The label the client should render until data/itemsCatalog.ts carries an
      // entry for `battlepoint`. Sent from here so the two cannot disagree, and
      // so a bag row reading literally "battlepoint" is a client bug with a
      // server-supplied fix rather than a missing feature.
      bpItemLabel: "Battle Point",
      bpForWin: LADDER_BP_WIN,
      bpForLoss: LADDER_BP_LOSS,
      bpFloorPerMatch: LADDER_BP_MIN_PER_PAYABLE_MATCH,
      bpCapPerWindow: LADDER_BP_CAP_PER_WINDOW,
      bpWindowMs: LADDER_BP_WINDOW_MS,
      // The HONEST maximum, inclusive of milestones, so a UI never advertises
      // the cap as a bound it is not: milestones are exempt, once-ever, and
      // worth PVP_MILESTONE_BP_LIFETIME_TOTAL in total across a whole career.
      maxBpOneWindowIncludingMilestones: LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW,
      milestoneBpLifetimeTotal: PVP_MILESTONE_BP_LIFETIME_TOTAL,
      winBonusBp: LADDER_WIN_BONUS_BP,
      winBonusCooldownMs: LADDER_WIN_BONUS_COOLDOWN_MS,
      minTurns: LADDER_MIN_TURNS,
      minDurationMs: LADDER_MIN_DURATION_MS,
      perOpponentDecayPercent: [...LADDER_DECAY_PERCENT_BY_MEETING],
      perOpponentDecayFloorPercent: LADDER_DECAY_PERCENT_FLOOR,
      // Stated plainly because these are the most-asked questions, and stated
      // HONESTLY because this endpoint is what a rewards panel renders.
      //
      // A FRIEND INVITE PAYS NOTHING. That is the owner's settled decision, and
      // the cost is real and measured: 76% of every PvP match ever played in
      // this game is between friends, so most PvP that actually happens here
      // earns nothing. The ladder pays the queue, not your friends list. What it
      // buys is the one structural obstacle to a two-account ring that no cap
      // can provide — you cannot choose your opponent on the only path that pays.
      //
      // These two fields used to say the opposite: `invitesPay` was hardcoded
      // `true` beside a comment arguing for it, while the server paid an invite
      // exactly nothing. It is DERIVED now so the endpoint cannot drift from the
      // policy again, in either direction.
      //
      // A forfeit still pays nobody, in either direction, so you cannot profit
      // from an opponent disconnecting.
      payablePairingPaths: [...LADDER_PAYABLE_PROVENANCE],
      invitesPay: (LADDER_PAYABLE_PROVENANCE as readonly string[]).includes("invite"),
      forfeitPaysNothing: true,
      botBattlesPayNothing: true,
    },
    milestones: PVP_MILESTONES.map((m) => ({
      threshold: m.threshold,
      bp: m.bp,
      tier: PVP_BADGE_TIERS.find((t) => t.minRating === m.threshold)?.id ?? null,
      awarded: milestones.includes(m.threshold),
      // Only paid on the match that CROSSES the threshold, so a UI must not
      // promise it to an account already above one.
      reachable: !milestones.includes(m.threshold) && (rating?.rating ?? 1000) < m.threshold,
    })),
    // Tier table INCLUDING the cash each tier pays, because the cash scales
    // with rating and "what is my win bonus worth?" is otherwise unanswerable
    // client-side.
    tiers: PVP_BADGE_TIERS.map((t) => ({
      id: t.id,
      label: t.label,
      minRating: t.minRating,
      milestoneBp: t.milestoneBp,
      winBonusMoney: t.winBonusMoney,
    })),
  });
});

/** Thresholds this account has already been paid for. Isolated + swallowing so
 *  a pre-migration server still renders the hub. */
async function readMilestonesSafe(userId: string): Promise<number[]> {
  try {
    const rows = await prisma.$queryRaw<{ threshold: number }[]>`
      SELECT "threshold"::int AS threshold FROM "PvpBadgeMilestone" WHERE "userId" = ${userId}
    `;
    return rows.map((r) => Number(r.threshold));
  } catch (e) {
    void recordError({
      kind: "server",
      message: "pvp_ladder_milestones_read_failed",
      source: "GET /pvp/me/ladder",
      userId,
      meta: { error: String(e) },
    });
    return [];
  }
}

// ── Ladder rewards: what I actually earned, and why ───────────────
// The per-row `meetingIndex` / `decayApplied` are the point: a player whose
// third match against the same opponent paid half needs to be able to SEE that,
// or the decay reads as a bug.
app.get("/me/ladder/history", requireUser, async (c) => {
  const user = c.get("user");
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "25", 10)));
  try {
    return c.json({ earnings: await readLadderHistory(user.id, limit) });
  } catch (e) {
    void recordError({
      kind: "server",
      message: "pvp_ladder_history_read_failed",
      source: "GET /pvp/me/ladder/history",
      userId: user.id,
      meta: { error: String(e) },
    });
    return c.json({ earnings: [] });
  }
});

export default app;
