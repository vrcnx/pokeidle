import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { getIo } from "../socket.js";
import { makeRateLimiter } from "../lib/rateLimit.js";

// PLAYER-facing poll routes. Admin CRUD + open/close lives in
// routes/admin.ts behind the admin gate; this file is only what a
// normal signed-in player may do: see what's running, and vote.

const app = new Hono();
app.use("*", requireUser);

function tally(votes: { optionIndex: number }[], optionCount: number): number[] {
  const counts = new Array(optionCount).fill(0);
  for (const v of votes) {
    if (v.optionIndex >= 0 && v.optionIndex < optionCount) counts[v.optionIndex]++;
  }
  return counts;
}

// GET /api/polls — open + recently-closed polls. Results are public by
// design (see schema.prisma's Poll doc comment) — aggregate counts only,
// never who voted for what; that stays admin-only.
app.get("/", async (c) => {
  const me = c.get("user");
  const rows = await prisma.poll.findMany({
    where: { status: { in: ["open", "closed"] } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 30,
    include: { votes: { select: { userId: true, optionIndex: true } } },
  });
  return c.json({
    polls: rows.map((p) => {
      const options = JSON.parse(p.options) as string[];
      const mine = p.votes.find((v) => v.userId === me.id);
      return {
        id: p.id,
        question: p.question,
        options,
        status: p.status,
        createdAt: p.createdAt,
        closedAt: p.closedAt,
        tallies: tally(p.votes, options.length),
        totalVotes: p.votes.length,
        myVote: mine ? mine.optionIndex : null,
      };
    }),
  });
});

// GET /api/polls/:id — same shape, for a card that only has the id from
// a chat meta blob and needs its own fetch on mount.
app.get("/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const p = await prisma.poll.findUnique({
    where: { id },
    include: { votes: { select: { userId: true, optionIndex: true } } },
  });
  if (!p) return c.json({ error: "poll not found" }, 404);
  const options = JSON.parse(p.options) as string[];
  const mine = p.votes.find((v) => v.userId === me.id);
  return c.json({
    poll: {
      id: p.id,
      question: p.question,
      options,
      status: p.status,
      createdAt: p.createdAt,
      closedAt: p.closedAt,
      tallies: tally(p.votes, options.length),
      totalVotes: p.votes.length,
      myVote: mine ? mine.optionIndex : null,
    },
  });
});

const voteLimiter = makeRateLimiter({ tokens: 30, windowMs: 60_000 });
const VoteBody = z.object({ optionIndex: z.number().int().min(0) });

// POST /api/polls/:id/vote — cast or change a vote. Upsert on
// (pollId, userId): a poll is live opinion, not a one-shot commitment,
// so changing your mind before it closes is expected, not abuse.
app.post("/:id/vote", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  if (!voteLimiter.consume(me.id)) return c.json({ error: "rate_limited", retryAfter: 60 }, 429);

  const body = VoteBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid vote" }, 400);
  const { optionIndex } = body.data;

  const p = await prisma.poll.findUnique({ where: { id } });
  if (!p) return c.json({ error: "poll not found" }, 404);
  if (p.status !== "open") return c.json({ error: "this poll is not accepting votes" }, 409);
  const options = JSON.parse(p.options) as string[];
  if (optionIndex >= options.length) return c.json({ error: "invalid option" }, 400);

  await prisma.pollVote.upsert({
    where: { pollId_userId: { pollId: id, userId: me.id } },
    create: { pollId: id, userId: me.id, username: me.username, optionIndex },
    update: { optionIndex },
  });

  const votes = await prisma.pollVote.findMany({ where: { pollId: id }, select: { optionIndex: true } });
  const tallies = tally(votes, options.length);
  const totalVotes = votes.length;

  // Broadcast to everyone, not just a "global" room — the poll card can
  // be open in a scrolled-back chat view or the Social panel regardless
  // of which channel tab is active, same as announcement:set /
  // chat:cleared already do unscoped.
  const io = getIo();
  if (io) io.emit("poll:voted", { pollId: id, tallies, totalVotes });

  return c.json({ ok: true, tallies, totalVotes, myVote: optionIndex });
});

export default app;
