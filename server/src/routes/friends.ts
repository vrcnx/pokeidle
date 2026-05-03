import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";

const app = new Hono();

// 10 friend requests per user per hour. Combined with the unique
// `(requesterId, receiverId)` index on the Friend model, this keeps
// spammers from blasting requests at the entire user base.
const friendRequestLimiter = makeRateLimiter({ tokens: 10, windowMs: 60 * 60_000 });

// GET /api/friends — accepted friends + incoming/outgoing pending requests.
app.get("/", requireUser, async (c) => {
  const user = c.get("user");
  const all = await prisma.friend.findMany({
    where: {
      OR: [{ requesterId: user.id }, { receiverId: user.id }],
    },
    include: {
      requester: { select: profileFields() },
      receiver: { select: profileFields() },
    },
    orderBy: { updatedAt: "desc" },
  });

  const accepted: any[] = [];
  const incoming: any[] = [];
  const outgoing: any[] = [];
  for (const f of all) {
    const them = f.requesterId === user.id ? f.receiver : f.requester;
    const entry = { friendshipId: f.id, status: f.status, ...them };
    if (f.status === "accepted") accepted.push(entry);
    else if (f.requesterId === user.id) outgoing.push(entry);
    else incoming.push(entry);
  }
  return c.json({ accepted, incoming, outgoing });
});

// POST /api/friends/request — send to a username.
const RequestBody = z.object({ username: z.string().min(1) });

app.post("/request", requireUser, async (c) => {
  const user = c.get("user");
  if (!friendRequestLimiter.consume(user.id)) {
    return c.json({ error: "rate_limited", retryAfter: 3600 }, 429);
  }
  const parsed = RequestBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);

  if (parsed.data.username.toLowerCase() === user.username.toLowerCase()) {
    return c.json({ error: "cannot friend yourself" }, 400);
  }

  const target = await prisma.user.findUnique({
    where: { username: parsed.data.username },
    select: { id: true, username: true },
  });
  if (!target) return c.json({ error: "user not found" }, 404);

  // If a row in either direction exists, just upsert/return it.
  const existing = await prisma.friend.findFirst({
    where: {
      OR: [
        { requesterId: user.id, receiverId: target.id },
        { requesterId: target.id, receiverId: user.id },
      ],
    },
  });
  if (existing) {
    // Block-list check. The blocker (whoever set status=blocked) is the
    // requesterId; the receiverId is the blocked user. Either side
    // initiating a request when one of these rows exists is a no-op:
    // the blocker shouldn't be hassled, and the blocked user shouldn't
    // see whether they're blocked (return generic "user not found" so
    // it can't be probed).
    if (existing.status === "blocked") {
      return c.json({ error: "user not found" }, 404);
    }
    if (existing.status === "accepted") {
      return c.json({ ok: true, status: "accepted", friendshipId: existing.id });
    }
    // If they already requested us, accept it automatically.
    if (existing.receiverId === user.id) {
      const updated = await prisma.friend.update({
        where: { id: existing.id },
        data: { status: "accepted" },
      });
      return c.json({ ok: true, status: "accepted", friendshipId: updated.id });
    }
    return c.json({ ok: true, status: "pending", friendshipId: existing.id });
  }
  const created = await prisma.friend.create({
    data: { requesterId: user.id, receiverId: target.id, status: "pending" },
  });
  return c.json({ ok: true, status: "pending", friendshipId: created.id });
});

// POST /api/friends/block — hard-block another user. Sets status=blocked
// with the caller as requester; replaces any existing relationship row
// (pending invite, accepted friendship). Subsequent friend-request /
// trade-invite / DM attempts in either direction return "user not found".
const BlockBody = z.object({ username: z.string().min(1) });
app.post("/block", requireUser, async (c) => {
  const user = c.get("user");
  const parsed = BlockBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);
  if (parsed.data.username.toLowerCase() === user.username.toLowerCase()) {
    return c.json({ error: "cannot block yourself" }, 400);
  }
  const target = await prisma.user.findUnique({
    where: { username: parsed.data.username },
    select: { id: true },
  });
  if (!target) return c.json({ error: "user not found" }, 404);
  // Drop any existing row in either direction; replace with a single
  // blocked row owned by the caller. Use a transaction so we can't end
  // up with two rows for the same pair.
  await prisma.$transaction([
    prisma.friend.deleteMany({
      where: {
        OR: [
          { requesterId: user.id, receiverId: target.id },
          { requesterId: target.id, receiverId: user.id },
        ],
      },
    }),
    prisma.friend.create({
      data: { requesterId: user.id, receiverId: target.id, status: "blocked" },
    }),
  ]);
  return c.json({ ok: true });
});

// POST /api/friends/unblock — reverse a previous block.
app.post("/unblock", requireUser, async (c) => {
  const user = c.get("user");
  const parsed = BlockBody.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid body" }, 400);
  const target = await prisma.user.findUnique({
    where: { username: parsed.data.username },
    select: { id: true },
  });
  if (!target) return c.json({ error: "user not found" }, 404);
  await prisma.friend.deleteMany({
    where: { requesterId: user.id, receiverId: target.id, status: "blocked" },
  });
  return c.json({ ok: true });
});

// POST /api/friends/:id/accept — accept an incoming request.
app.post("/:id/accept", requireUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const f = await prisma.friend.findUnique({ where: { id } });
  if (!f || f.receiverId !== user.id || f.status !== "pending") {
    return c.json({ error: "not found" }, 404);
  }
  await prisma.friend.update({ where: { id }, data: { status: "accepted" } });
  return c.json({ ok: true });
});

// DELETE /api/friends/:id — decline / unfriend / cancel.
app.delete("/:id", requireUser, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const f = await prisma.friend.findUnique({ where: { id } });
  if (!f || (f.requesterId !== user.id && f.receiverId !== user.id)) {
    return c.json({ error: "not found" }, 404);
  }
  await prisma.friend.delete({ where: { id } });
  return c.json({ ok: true });
});

function profileFields() {
  return {
    id: true,
    username: true,
    name: true,
    image: true,
    accountLevel: true,
    pokedexCaughtCount: true,
    lastSeenAt: true,
  } as const;
}

export default app;
