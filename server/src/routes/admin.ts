import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, requireAdmin } from "../lib/middleware.js";
import { audit } from "../lib/audit.js";

const app = new Hono();

// All admin endpoints require an authenticated admin.
app.use("*", requireUser, requireAdmin);

// ── Self-check ─────────────────────────────────────────────────────────
app.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, username: user.username, isAdmin: true });
});

// ── Users ──────────────────────────────────────────────────────────────
// Paginated list with optional search across username/email/name.
app.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const page = Math.max(0, parseInt(c.req.query("page") ?? "0", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(c.req.query("pageSize") ?? "25", 10)));

  const where = q
    ? {
        OR: [
          { username: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
          { name: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: page * pageSize,
      take: pageSize,
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        accountLevel: true,
        pokedexCaughtCount: true,
        totalCaughtLevels: true,
        isAdmin: true,
        bannedUntil: true,
        banReason: true,
        createdAt: true,
        lastSeenAt: true,
      },
    }),
  ]);

  return c.json({ total, page, pageSize, users });
});

// Detail view — includes save data for inspection. Logged to the audit
// trail because the response carries the raw `saveData` JSON, which is
// the most-sensitive field on the user row (party + box + everything
// the player has done). Self-reads aren't audited.
app.get("/users/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const u = await prisma.user.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          friendsRequested: true,
          friendsReceived: true,
          messages: true,
        },
      },
    },
  });
  if (!u) return c.json({ error: "not found" }, 404);
  if (id !== me.id) {
    void audit(me.id, "user.read_save", id);
  }
  return c.json(u);
});

// Promote / demote.
app.post("/users/:id/admin", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const { isAdmin } = (await c.req.json().catch(() => ({}))) as { isAdmin?: boolean };
  if (typeof isAdmin !== "boolean") {
    return c.json({ error: "isAdmin must be boolean" }, 400);
  }
  try {
    const u = await prisma.user.update({
      where: { id },
      data: { isAdmin },
      select: { id: true, isAdmin: true },
    });
    void audit(me.id, isAdmin ? "user.promote" : "user.demote", id);
    return c.json(u);
  } catch {
    return c.json({ error: "user not found" }, 404);
  }
});

// Ban / unban. `until` ISO string; pass `null` to unban. Bad date strings
// (NaN-after-parse) and missing users return 4xx instead of bubbling up
// as an unhandled 500 — see ban-admin probe.
app.post("/users/:id/ban", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { until?: string | null; reason?: string | null };
  let until: Date | null;
  if (body.until === null) {
    until = null;
  } else if (body.until) {
    const parsed = new Date(body.until);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: "invalid until date" }, 400);
    }
    until = parsed;
  } else {
    until = new Date(Date.now() + 7 * 86400000);
  }
  try {
    const u = await prisma.user.update({
      where: { id },
      data: { bannedUntil: until, banReason: body.reason ?? null },
      select: { id: true, bannedUntil: true, banReason: true },
    });
    void audit(me.id, until ? "user.ban" : "user.unban", id, {
      until: until?.toISOString() ?? null,
      reason: body.reason ?? null,
    });
    return c.json(u);
  } catch {
    return c.json({ error: "user not found" }, 404);
  }
});

// Hard delete (cascades to sessions, accounts, friendships, messages).
app.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("user");
  if (id === me.id) return c.json({ error: "cannot delete self" }, 400);
  try {
    await prisma.user.delete({ where: { id } });
    void audit(me.id, "user.delete", id);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "user not found" }, 404);
  }
});

// Reset a user's save (clears the JSON blob — they'll be back in the
// starter-select state on next login).
app.post("/users/:id/reset-save", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  try {
    const u = await prisma.user.update({
      where: { id },
      data: { saveData: null, saveVersion: 0, accountLevel: 0, totalCaughtLevels: 0, pokedexCaughtCount: 0 },
      select: { id: true, saveVersion: true },
    });
    void audit(me.id, "user.reset_save", id);
    return c.json(u);
  } catch {
    return c.json({ error: "user not found" }, 404);
  }
});

// ── Analytics ──────────────────────────────────────────────────────────
app.get("/analytics", async (c) => {
  const now = new Date();
  const day = 86400000;
  const oneDayAgo = new Date(now.getTime() - day);
  const sevenDaysAgo = new Date(now.getTime() - 7 * day);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * day);

  const [
    totalUsers,
    activeDay,
    activeWeek,
    activeMonth,
    bannedUsers,
    admins,
    signups7d,
    chatMessagesTotal,
    chatMessages7d,
    friendships,
    pokedexAvg,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastSeenAt: { gte: oneDayAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: thirtyDaysAgo } } }),
    prisma.user.count({ where: { bannedUntil: { gt: now } } }),
    prisma.user.count({ where: { isAdmin: true } }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.chatMessage.count(),
    prisma.chatMessage.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.friend.count({ where: { status: "accepted" } }),
    prisma.user.aggregate({ _avg: { pokedexCaughtCount: true, accountLevel: true } }),
  ]);

  // Signup buckets by day for the last 30 days.
  const signupRows = await prisma.user.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: { createdAt: true },
  });
  const signupSeries: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * day);
    signupSeries[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of signupRows) {
    const k = row.createdAt.toISOString().slice(0, 10);
    if (k in signupSeries) signupSeries[k]++;
  }

  // Top 10 by pokedex completion.
  const topByDex = await prisma.user.findMany({
    orderBy: { pokedexCaughtCount: "desc" },
    take: 10,
    select: {
      id: true, username: true, name: true,
      accountLevel: true, pokedexCaughtCount: true,
    },
  });

  return c.json({
    totals: {
      users: totalUsers,
      bannedUsers,
      admins,
      friendships,
      chatMessagesTotal,
      chatMessages7d,
    },
    activity: {
      activeDay,
      activeWeek,
      activeMonth,
      signups7d,
    },
    averages: {
      pokedexCaught: Math.round((pokedexAvg._avg.pokedexCaughtCount ?? 0) * 10) / 10,
      accountLevel: Math.round((pokedexAvg._avg.accountLevel ?? 0) * 10) / 10,
    },
    signupSeries,
    leaderboards: {
      pokedex: topByDex,
    },
  });
});

// ── Map editor: positions in Postgres so they survive deploys and can
// be read by the game frontend at boot. The game's hard-coded routes.ts
// values stay around as defaults; DB rows override them per location.
app.get("/map-positions", async (c) => {
  const rows = await prisma.mapPosition.findMany();
  const positions: Record<string, { x: number; y: number }> = {};
  for (const r of rows) positions[r.locationId] = { x: r.x, y: r.y };
  return c.json({ positions });
});

// ── Map crop: rectangle within the source image that's actually shown
// in-game. Stored as percentages (0..100) of the source image.
const DEFAULT_REGION = "kanto";

app.get("/map-crop", async (c) => {
  const row = await prisma.mapCrop.findUnique({ where: { regionId: DEFAULT_REGION } });
  if (!row) return c.json({ crop: null });
  return c.json({ crop: { x: row.x, y: row.y, w: row.w, h: row.h } });
});

app.put("/map-crop", async (c) => {
  const me = c.get("user");
  const body = (await c.req.json().catch(() => null)) as
    | { crop?: { x: number; y: number; w: number; h: number } | null; regionId?: string }
    | null;
  const regionId = body?.regionId ?? DEFAULT_REGION;
  // null = clear the crop, fall back to full image.
  if (body?.crop === null) {
    await prisma.mapCrop.deleteMany({ where: { regionId } });
    return c.json({ ok: true, crop: null });
  }
  const c0 = body?.crop;
  if (
    !c0 ||
    typeof c0.x !== "number" || typeof c0.y !== "number" ||
    typeof c0.w !== "number" || typeof c0.h !== "number" ||
    c0.x < 0 || c0.y < 0 || c0.w <= 0 || c0.h <= 0 ||
    c0.x + c0.w > 100.001 || c0.y + c0.h > 100.001
  ) {
    return c.json({ error: "crop must be { x, y, w, h } percentages with x+w<=100 and y+h<=100" }, 400);
  }
  const row = await prisma.mapCrop.upsert({
    where: { regionId },
    update: { x: c0.x, y: c0.y, w: c0.w, h: c0.h, updatedBy: me.id },
    create: { regionId, x: c0.x, y: c0.y, w: c0.w, h: c0.h, updatedBy: me.id },
  });
  return c.json({ ok: true, crop: { x: row.x, y: row.y, w: row.w, h: row.h } });
});

app.put("/map-positions", async (c) => {
  const me = c.get("user");
  const body = (await c.req.json().catch(() => null)) as
    | { positions?: Record<string, { x: number; y: number }> }
    | null;
  if (!body?.positions || typeof body.positions !== "object") {
    return c.json({ error: "positions object required" }, 400);
  }
  // Validation pass first — bail before writing anything if invalid.
  const entries = Object.entries(body.positions);
  for (const [k, v] of entries) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(k) ||
      typeof v?.x !== "number" ||
      typeof v?.y !== "number" ||
      !Number.isFinite(v.x) ||
      !Number.isFinite(v.y)
    ) {
      return c.json({ error: `invalid position for ${k}` }, 400);
    }
  }
  // Upsert each row; runs in a single transaction so the table never
  // ends up half-updated if any individual write fails.
  await prisma.$transaction(
    entries.map(([locationId, { x, y }]) =>
      prisma.mapPosition.upsert({
        where: { locationId },
        update: { x, y, updatedBy: me.id },
        create: { locationId, x, y, updatedBy: me.id },
      })
    )
  );
  return c.json({ ok: true, count: entries.length });
});

// ── Chat moderation ────────────────────────────────────────────────────
app.get("/chat/recent", async (c) => {
  const limit = Math.min(200, Math.max(20, parseInt(c.req.query("limit") ?? "50", 10)));
  const messages = await prisma.chatMessage.findMany({
    where: { channelId: "global" },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { id: true, username: true, name: true, isAdmin: true } } },
  });
  return c.json({ messages: messages.reverse() });
});

app.delete("/chat/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  try {
    await prisma.chatMessage.delete({ where: { id } });
    void audit(me.id, "chat.delete", id);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "message not found" }, 404);
  }
});

// ── Audit log ──────────────────────────────────────────────────────────
// Admin actions that touch other users are appended to AdminAudit. This
// endpoint surfaces the most recent entries for review. Keep it simple:
// most-recent-first, no filtering UI yet, capped at 200 rows.
app.get("/audit", async (c) => {
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "100", 10)));
  // Raw SQL to dodge the codegen-locked Prisma client (see lib/audit.ts);
  // safe because limit is a parsed integer and the rest is static SQL.
  const rows = await prisma.$queryRawUnsafe<{
    id: string; adminId: string; action: string; targetId: string | null;
    meta: string | null; createdAt: Date;
  }[]>(
    `SELECT "id","adminId","action","targetId","meta","createdAt"
       FROM "AdminAudit"
       ORDER BY "createdAt" DESC
       LIMIT ${limit}`
  );
  // Decorate with usernames so the dashboard doesn't need a second
  // fetch per row. Two lookups: distinct admin ids + distinct target ids.
  const adminIds = Array.from(new Set(rows.map((r) => r.adminId)));
  const targetIds = Array.from(new Set(rows.flatMap((r) => (r.targetId ? [r.targetId] : []))));
  const allIds = Array.from(new Set([...adminIds, ...targetIds]));
  const users = allIds.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: allIds } },
    select: { id: true, username: true },
  });
  const byId = new Map(users.map((u) => [u.id, u.username]));
  return c.json({
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      createdAt: r.createdAt,
      admin: { id: r.adminId, username: byId.get(r.adminId) ?? "?" },
      target: r.targetId ? { id: r.targetId, username: byId.get(r.targetId) ?? "?" } : null,
      meta: r.meta ? safeJson(r.meta) : null,
    })),
  });
});
function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

export default app;
