import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser, requireAdmin } from "../lib/middleware.js";
import { audit } from "../lib/audit.js";
import { validateSave } from "../lib/saveValidation.js";
import { computeAccountLevel } from "../lib/level.js";
import { broadcastChatCleared } from "../socket.js";
import { auth } from "../auth.js";

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

// Apply a partial patch to a user's save data. The patch is a partial
// object; only allow-listed top-level keys are accepted, and the
// merged result is run through the same validateSave the player's own
// uploads pass through. After a successful patch we bump saveVersion
// so the player's next save (if their tab is still open) will get
// rejected as stale and re-pull the cloud copy.
//
// Allowed keys are explicitly listed below. New fields the admin
// dashboard wants to edit must be added here AND understood by
// validateSave or they'll be rejected.
const PATCHABLE_KEYS = new Set([
  "money",
  "inventory",
  "party",
  "box",
  "defeatedGyms",
  "defeatedEliteFour",
  "championDefeated",
  "victoryTokens",
  "pokedexCaught",
  "pokedexSeen",
  "shinyCaught",
  "shinySeen",
  "unlockedLocations",
  "currentLocation",
  "activePlayerPokemonIndex",
  "battlesWonByLocation",
  "wildBattlesWon",
  "trainerBattlesWon",
]);

app.post("/users/:id/save-patch", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { patch?: Record<string, unknown> }
    | null;
  if (!body?.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
    return c.json({ error: "patch object required" }, 400);
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { saveData: true, saveVersion: true },
  });
  if (!target) return c.json({ error: "user not found" }, 404);

  const baseSave = target.saveData ? safeParseObject(target.saveData) : {};
  if (!baseSave) return c.json({ error: "user save is corrupt" }, 500);

  const merged: Record<string, unknown> = { ...baseSave };
  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(body.patch)) {
    if (!PATCHABLE_KEYS.has(key)) {
      return c.json({ error: `key not patchable: ${key}` }, 400);
    }
    merged[key] = value;
    appliedKeys.push(key);
  }

  const v = validateSave(merged);
  if (!v.ok) {
    return c.json({ error: "patch produced invalid save", reason: v.reason }, 400);
  }

  const derived = computeAccountLevel(merged);
  const updated = await prisma.user.update({
    where: { id },
    data: {
      saveData: JSON.stringify(merged),
      saveVersion: { increment: 1 },
      saveUpdatedAt: new Date(),
      accountLevel: derived.accountLevel,
      totalCaughtLevels: derived.totalCaughtLevels,
      pokedexCaughtCount: derived.pokedexCaughtCount,
    },
    select: { id: true, saveVersion: true, accountLevel: true, pokedexCaughtCount: true },
  });

  void audit(me.id, "user.save_patch", id, { keys: appliedKeys });
  return c.json({ ok: true, ...updated, keys: appliedKeys });
});

function safeParseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

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

// ── User: send password reset ──────────────────────────────────────────
// Trigger Better Auth's normal password-reset flow on behalf of the
// admin. The user receives an email with a one-shot reset link
// (1-hour expiry) and chooses a new password themselves. We never
// see or store the new password — that's deliberate; admins should
// not be able to read user passwords, only initiate a reset. The
// `redirectTo` is the game frontend's reset page; the admin caller
// supplies it because the server doesn't know the public game URL.
app.post("/users/:id/send-password-reset", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { redirectTo?: string }
    | null;
  const target = await prisma.user.findUnique({
    where: { id },
    select: { email: true, username: true },
  });
  if (!target) return c.json({ error: "user not found" }, 404);
  const redirectTo = body?.redirectTo
    ?? (process.env.FRONTEND_ORIGIN?.split(",")[0]?.trim()
        ? `${process.env.FRONTEND_ORIGIN.split(",")[0].trim()}/reset-password`
        : "http://localhost:5173/reset-password");
  try {
    await auth.api.requestPasswordReset({
      body: { email: target.email, redirectTo },
    });
    void audit(me.id, "user.send_password_reset", id);
    return c.json({ ok: true, sentTo: target.email });
  } catch (e) {
    return c.json({ error: "failed to send reset email", detail: String(e) }, 500);
  }
});

// ── User: sessions (login history) ─────────────────────────────────────
// Returns Better Auth Session rows for the user — expiresAt, ipAddress,
// userAgent, createdAt, updatedAt. This is the closest thing to a
// "login history" we have; rows are deleted by Better Auth when they
// expire or the user signs out, so don't expect a full audit trail.
app.get("/users/:id/sessions", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return c.json({ error: "user not found" }, 404);
  const sessions = await prisma.session.findMany({
    where: { userId: id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
    },
  });
  // Annotate each session with a coarse country lookup (best-effort).
  // Uses ip-api.com's free no-auth endpoint, which is rate-limited to
  // 45 req/min per IP — fine for an admin tool. Failures (private IP,
  // network, rate limit) silently degrade to country: null.
  const decorated = await Promise.all(
    sessions.map(async (s) => {
      const country = s.ipAddress ? await lookupCountry(s.ipAddress) : null;
      return { ...s, country };
    }),
  );
  void audit(me.id, "user.read_sessions", id);
  return c.json({ sessions: decorated });
});

// In-memory country cache. Expires after 7 days so a long-lived process
// doesn't accumulate forever, but reuses lookups across admin views.
const _countryCache = new Map<string, { country: string | null; at: number }>();
const COUNTRY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function lookupCountry(ip: string): Promise<string | null> {
  // Skip private / loopback / IPv6-link-local — they have no public
  // GeoIP entry and would just waste a request.
  if (
    ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.")
    || ip.startsWith("192.168.") || ip.startsWith("172.")
    || ip.startsWith("fe80:") || ip.startsWith("fc00:")
  ) return "Local";
  const cached = _countryCache.get(ip);
  if (cached && Date.now() - cached.at < COUNTRY_CACHE_TTL_MS) return cached.country;
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as { status?: string; country?: string };
    const country = data.status === "success" && data.country ? data.country : null;
    _countryCache.set(ip, { country, at: Date.now() });
    return country;
  } catch {
    _countryCache.set(ip, { country: null, at: Date.now() });
    return null;
  }
}

// ── User: trade history ────────────────────────────────────────────────
// Returns up to 100 completed trades involving this user, sorted newest
// first. Each row includes both sides' mons and usernames as captured
// at trade time, so renames / account deletes don't rewrite history.
app.get("/users/:id/trades", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return c.json({ error: "user not found" }, 404);
  const trades = await prisma.tradeRecord.findMany({
    where: { OR: [{ userAId: id }, { userBId: id }] },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  void audit(me.id, "user.read_trades", id);
  return c.json({ trades });
});

// ── User: chat messages they've sent ───────────────────────────────────
// All channels (global + area:* + dm:*). Capped at 500 to keep the
// payload reasonable; older messages can be paged via `before` (an
// ISO timestamp — return rows with createdAt < before).
app.get("/users/:id/messages", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const limit = Math.min(500, Math.max(20, parseInt(c.req.query("limit") ?? "200", 10)));
  const beforeRaw = c.req.query("before");
  const before = beforeRaw ? new Date(beforeRaw) : null;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return c.json({ error: "user not found" }, 404);
  const messages = await prisma.chatMessage.findMany({
    where: {
      userId: id,
      ...(before && !isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, channelId: true, content: true, createdAt: true },
  });
  void audit(me.id, "user.read_messages", id);
  return c.json({ messages });
});

// ── User: set inventory item quantity ──────────────────────────────────
// Convenience wrapper around save-patch for the common admin action of
// granting / removing an item. Quantity 0 deletes the entry. Quantity
// must be a non-negative integer; validateSave enforces the upper
// bound (MAX_INVENTORY_STACK = 999_999).
app.post("/users/:id/items", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { itemId?: string; quantity?: number }
    | null;
  const itemId = String(body?.itemId ?? "");
  const quantity = Math.floor(Number(body?.quantity ?? -1));
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(itemId)) {
    return c.json({ error: "invalid itemId" }, 400);
  }
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 999_999) {
    return c.json({ error: "quantity must be 0..999999" }, 400);
  }
  const target = await prisma.user.findUnique({
    where: { id },
    select: { saveData: true },
  });
  if (!target) return c.json({ error: "user not found" }, 404);
  const baseSave = target.saveData ? safeParseObject(target.saveData) : {};
  if (!baseSave) return c.json({ error: "user save is corrupt" }, 500);
  const inventory: Record<string, number> = {
    ...((baseSave.inventory && typeof baseSave.inventory === "object" && !Array.isArray(baseSave.inventory))
      ? (baseSave.inventory as Record<string, number>)
      : {}),
  };
  if (quantity === 0) delete inventory[itemId];
  else inventory[itemId] = quantity;
  const merged = { ...baseSave, inventory };
  const v = validateSave(merged);
  if (!v.ok) return c.json({ error: "patch produced invalid save", reason: v.reason }, 400);
  await prisma.user.update({
    where: { id },
    data: {
      saveData: JSON.stringify(merged),
      saveVersion: { increment: 1 },
      saveUpdatedAt: new Date(),
    },
  });
  void audit(me.id, "user.set_item", id, { itemId, quantity });
  return c.json({ ok: true, itemId, quantity });
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

  // DAU buckets — daily active users over the last 30 days. lastSeenAt
  // is updated on every socket connection, so this is a reasonable proxy
  // for "logged in today". Approximates DAU from the latest snapshot
  // since we don't keep per-day login records (would need a separate
  // event log table). Buckets users by whose last seen falls in each
  // 24-hour window.
  const lastSeenRows = await prisma.user.findMany({
    where: { lastSeenAt: { gte: thirtyDaysAgo } },
    select: { lastSeenAt: true },
  });
  const dauSeries: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * day);
    dauSeries[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of lastSeenRows) {
    if (!row.lastSeenAt) continue;
    const k = row.lastSeenAt.toISOString().slice(0, 10);
    if (k in dauSeries) dauSeries[k]++;
  }

  // Account-level distribution — bucket users by 10-level bands so the
  // histogram shows a digestible breakdown of progression. Buckets are
  // 0-9, 10-19, ..., 100-109, 110+ for anything beyond.
  const allLevels = await prisma.user.findMany({
    select: { accountLevel: true },
  });
  const levelBuckets: { label: string; count: number }[] = [];
  const BAND_SIZE = 10;
  const MAX_BANDS = 12;
  for (let i = 0; i < MAX_BANDS - 1; i++) {
    levelBuckets.push({ label: `${i * BAND_SIZE}–${i * BAND_SIZE + BAND_SIZE - 1}`, count: 0 });
  }
  levelBuckets.push({ label: `${(MAX_BANDS - 1) * BAND_SIZE}+`, count: 0 });
  for (const u of allLevels) {
    const lv = u.accountLevel ?? 0;
    const idx = Math.min(MAX_BANDS - 1, Math.floor(lv / BAND_SIZE));
    levelBuckets[idx].count += 1;
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
    dauSeries,
    levelBuckets,
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

// Wipe every message in the public live-chat channels (global + any
// area:*). DMs are intentionally excluded — those are private 1-1
// conversations between users, not "live chat", and clearing them
// would feel like a privacy violation. After the DB delete we
// broadcast chat:cleared to all connected sockets so live clients
// flush their cached message lists without needing a refresh.
//
// MUST be declared BEFORE /chat/:id — Hono matches routes in order,
// and a static `/chat/clear` registered after the param route would
// be intercepted with id="clear".
app.delete("/chat/clear", async (c) => {
  const me = c.get("user");
  const result = await prisma.chatMessage.deleteMany({
    where: {
      OR: [
        { channelId: "global" },
        { channelId: { startsWith: "area:" } },
      ],
    },
  });
  broadcastChatCleared("public");
  void audit(me.id, "chat.clearAll", null, { deleted: result.count });
  return c.json({ ok: true, deleted: result.count });
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

// ── Bug reports ────────────────────────────────────────────────────────
// Paginated list of user-submitted reports. Filter by status so the
// triage view ("open") doesn't drown in resolved noise.
app.get("/bug-reports", async (c) => {
  const status = (c.req.query("status") ?? "").trim();
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10));
  // Compose WHERE without breaking parameterisation — use $queryRaw with
  // a Prisma.sql conditional. Prisma's tagged template interpolates safely.
  const rows = status
    ? await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","reporterId","reporterName","title","description","page","userAgent","context","status","adminNotes","createdAt","updatedAt"
           FROM "BugReport"
          WHERE "status" = $1
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${offset}`,
        status
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","reporterId","reporterName","title","description","page","userAgent","context","status","adminNotes","createdAt","updatedAt"
           FROM "BugReport"
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${offset}`
      );
  return c.json({ reports: rows });
});

app.patch("/bug-reports/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { status?: string; adminNotes?: string };
  const newStatus = body.status;
  if (newStatus && !["open", "investigating", "resolved", "wontfix"].includes(newStatus)) {
    return c.json({ error: "invalid status" }, 400);
  }
  await prisma.$executeRaw`
    UPDATE "BugReport"
       SET "status" = COALESCE(${newStatus ?? null}, "status"),
           "adminNotes" = COALESCE(${body.adminNotes ?? null}, "adminNotes"),
           "updatedAt" = NOW()
     WHERE "id" = ${id}
  `;
  void audit(me.id, "bugReport.update", id, { status: newStatus, adminNotes: body.adminNotes });
  return c.json({ ok: true });
});

// ── Error log ──────────────────────────────────────────────────────────
// Server + client errors persist into ErrorLog. Filter by kind so the
// triage view can show server-side stack traces separately from
// client-reported ones.
app.get("/errors", async (c) => {
  const kind = (c.req.query("kind") ?? "").trim();
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "100", 10)));
  const rows = kind === "server" || kind === "client"
    ? await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","kind","level","message","stack","source","userId","username","userAgent","meta","createdAt"
           FROM "ErrorLog"
          WHERE "kind" = $1
          ORDER BY "createdAt" DESC
          LIMIT ${limit}`,
        kind
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","kind","level","message","stack","source","userId","username","userAgent","meta","createdAt"
           FROM "ErrorLog"
          ORDER BY "createdAt" DESC
          LIMIT ${limit}`
      );
  return c.json({
    errors: rows.map((r) => ({
      ...r,
      meta: r.meta ? safeJson(r.meta) : null,
    })),
  });
});

export default app;
