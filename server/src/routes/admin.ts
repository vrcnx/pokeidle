import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { adminApiKey, requireUser, requireAdmin } from "../lib/middleware.js";
import { audit as auditRaw } from "../lib/audit.js";
import { validateSave } from "../lib/saveValidation.js";
import { computeAccountLevel } from "../lib/level.js";
import { broadcastChatCleared, sendToUserGlobal, getIo, kickUser, liveOnlineSnapshot } from "../socket.js";
import { auth } from "../auth.js";
import {
  battleRooms,
  newBattleId,
  startBattle,
  type BattleRoom,
} from "../pvp.js";
import { generateBracket, advanceBracket, type Bracket } from "../lib/bracket.js";

const app = new Hono();

// All admin endpoints require an admin. Two ways in:
//   * a browser session (requireUser → requireAdmin), or
//   * the ADMIN_API_KEY machine path for CLI / agent callers, which
//     adminApiKey resolves to a real admin row before requireUser runs.
// requireAdmin is the single chokepoint either way: no isAdmin, no entry.
app.use("*", adminApiKey, requireUser, requireAdmin);

// Audit shim. Every call site in this file already passes the acting
// admin id; this wrapper additionally stamps HOW the caller authed, so
// the ledger can tell "the operator clicked this in the dashboard"
// apart from "an agent/CLI did this over the API key". Signature is
// otherwise identical to lib/audit.ts, so no call site changes.
function makeAudit(c: { get: (k: "viaApiKey") => boolean | undefined }) {
  return (adminId: string, action: string, targetId: string | null, meta?: Record<string, unknown>) =>
    auditRaw(adminId, action, targetId, c.get("viaApiKey") ? { ...(meta ?? {}), via: "api-key" } : meta);
}

// ── Self-check ─────────────────────────────────────────────────────────
app.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, username: user.username, isAdmin: true });
});

// ── Users ──────────────────────────────────────────────────────────────
// Paginated list with optional search across username/email/name.
// Sortable columns. An allow-list rather than passing the query param
// through to Prisma — `orderBy` takes a field name, and forwarding user
// input there lets a caller order by any column on the model.
const USER_SORTS = {
  createdAt:          (dir: "asc" | "desc") => ({ createdAt: dir }),
  lastSeenAt:         (dir: "asc" | "desc") => ({ lastSeenAt: dir }),
  accountLevel:       (dir: "asc" | "desc") => ({ accountLevel: dir }),
  pokedexCaughtCount: (dir: "asc" | "desc") => ({ pokedexCaughtCount: dir }),
  totalCaughtLevels:  (dir: "asc" | "desc") => ({ totalCaughtLevels: dir }),
  username:           (dir: "asc" | "desc") => ({ username: dir }),
} as const;
type UserSort = keyof typeof USER_SORTS;

app.get("/users", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const page = Math.max(0, parseInt(c.req.query("page") ?? "0", 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(c.req.query("pageSize") ?? "25", 10)));

  // Sorting was hardcoded to createdAt desc, so the operator could only
  // ever see the newest 25 accounts — there was no way to ask "who has
  // the highest level" (the shape a cheat looks like) or "who has not
  // played in a month".
  const sortRaw = (c.req.query("sort") ?? "createdAt") as UserSort;
  const sort: UserSort = sortRaw in USER_SORTS ? sortRaw : "createdAt";
  const dir: "asc" | "desc" = c.req.query("dir") === "asc" ? "asc" : "desc";

  // Filters. `banned` and `admin` are the two the operator actually
  // reaches for — "show me everyone I have banned", "who has admin".
  const filter = (c.req.query("filter") ?? "").trim();
  const filterWhere =
      filter === "banned" ? { bannedUntil: { gt: new Date() } }
    : filter === "admins" ? { isAdmin: true }
    : {};

  const searchWhere = q
    ? {
        OR: [
          { username: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
          { name: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};
  const where = { ...searchWhere, ...filterWhere };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: USER_SORTS[sort](dir),
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
    void makeAudit(c)(me.id, "user.read_save", id);
  }
  return c.json(u);
});

// Promote / demote. Refuses self-action so a sole admin can't lock
// themselves (or the whole platform if they're the only one) out by
// flipping their own flag — recovery would require direct DB access.
// Mirrors the self-action guard in DELETE /users/:id.
app.post("/users/:id/admin", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  if (id === me.id) return c.json({ error: "cannot change own admin status" }, 400);
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
    void makeAudit(c)(me.id, isAdmin ? "user.promote" : "user.demote", id);
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
  // Self-ban would 403 their next HTTP request via requireUser while
  // leaving any open WebSockets connected — a confusing partial-state
  // lockout. Just refuse, same shape as the self-delete / self-demote
  // guards above.
  if (id === me.id) return c.json({ error: "cannot ban yourself" }, 400);
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
    void makeAudit(c)(me.id, until ? "user.ban" : "user.unban", id, {
      until: until?.toISOString() ?? null,
      reason: body.reason ?? null,
    });
    // Force-disconnect the banned user's live sockets so they can't
    // keep chatting / queueing / trading on an open tab while the
    // ban is in effect. No-op if they aren't currently connected.
    if (until && until.getTime() > Date.now()) {
      try { kickUser(id, body.reason ?? "banned"); } catch { /* socket layer may not be up */ }
    }
    return c.json(u);
  } catch {
    return c.json({ error: "user not found" }, 404);
  }
});

// Bulk ban / unban. A cheat wave is never one account, and banning them
// one detail-panel-at-a-time is both slow and error-prone (the operator
// loses their place in the list after each one).
//
// Deliberately NOT a bulk delete: delete cascades and is unrecoverable,
// and a bulk unrecoverable action is a footgun with no upside — a
// mis-selected checkbox would be unrecoverable across N accounts. Bans
// are reversible, so bulk is safe here and only here.
const BulkBanBody = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(100),
  until: z.string().datetime().nullable(),
  reason: z.string().max(500).nullable().optional(),
});

app.post("/users/bulk-ban", async (c) => {
  const me = c.get("user");
  const parsed = BulkBanBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const { until, reason } = parsed.data;
  // Never let the operator ban themselves out of the dashboard, even by
  // accident inside a 100-id selection. Mirrors the single-ban guard.
  const userIds = parsed.data.userIds.filter((id) => id !== me.id);
  const skippedSelf = userIds.length !== parsed.data.userIds.length;

  const untilDate = until ? new Date(until) : null;
  if (until && Number.isNaN(untilDate!.getTime())) {
    return c.json({ error: "invalid until date" }, 400);
  }

  const result = await prisma.user.updateMany({
    where: { id: { in: userIds } },
    data: { bannedUntil: untilDate, banReason: reason ?? null },
  });

  void makeAudit(c)(me.id, untilDate ? "user.bulk_ban" : "user.bulk_unban", null, {
    count: result.count,
    userIds,
    until: untilDate?.toISOString() ?? null,
    reason: reason ?? null,
  });

  // Kick their live sockets so the ban is immediate, matching single-ban
  // behaviour. Best-effort per user; a socket-layer failure must not
  // roll back a completed ban.
  if (untilDate && untilDate.getTime() > Date.now()) {
    for (const id of userIds) {
      try { kickUser(id, reason ?? "banned"); } catch { /* */ }
    }
  }

  return c.json({ ok: true, count: result.count, skippedSelf });
});

// Hard delete (cascades to sessions, accounts, friendships, messages).
app.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("user");
  if (id === me.id) return c.json({ error: "cannot delete self" }, 400);
  try {
    await prisma.user.delete({ where: { id } });
    void makeAudit(c)(me.id, "user.delete", id);
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

  void makeAudit(c)(me.id, "user.save_patch", id, { keys: appliedKeys });
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
    void makeAudit(c)(me.id, "user.reset_save", id);
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
    void makeAudit(c)(me.id, "user.send_password_reset", id);
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
  void makeAudit(c)(me.id, "user.read_sessions", id);
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
  void makeAudit(c)(me.id, "user.read_trades", id);
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
  void makeAudit(c)(me.id, "user.read_messages", id);
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
  void makeAudit(c)(me.id, "user.set_item", id, { itemId, quantity });
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
    signups30d,
    chatMessagesTotal,
    chatMessages7d,
    friendships,
    pokedexAvg,
    pvpMatchesTotal,
    pvpMatches7d,
    tradesTotal,
    trades7d,
    bugReportsOpen,
    errorsLast24h,
    pokedexSum,
    accountLevelSum,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastSeenAt: { gte: oneDayAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { lastSeenAt: { gte: thirtyDaysAgo } } }),
    prisma.user.count({ where: { bannedUntil: { gt: now } } }),
    prisma.user.count({ where: { isAdmin: true } }),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.chatMessage.count(),
    prisma.chatMessage.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.friend.count({ where: { status: "accepted" } }),
    prisma.user.aggregate({ _avg: { pokedexCaughtCount: true, accountLevel: true } }),
    prisma.pvpMatch.count().catch(() => 0),
    prisma.pvpMatch.count({ where: { createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
    prisma.tradeRecord.count().catch(() => 0),
    prisma.tradeRecord.count({ where: { createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
    prisma.bugReport.count({ where: { status: "open" } }).catch(() => 0),
    prisma.errorLog.count({ where: { createdAt: { gte: oneDayAgo } } }).catch(() => 0),
    prisma.user.aggregate({ _sum: { pokedexCaughtCount: true } }),
    prisma.user.aggregate({ _sum: { totalCaughtLevels: true } }),
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
  // WHAT THIS IS, AND WHAT IT IS NOT.
  //
  // This buckets each user by their `lastSeenAt` — a single scalar that
  // is overwritten every time they connect. A player active every day
  // for 30 days contributes exactly ONE tick, on today. So a historical
  // bucket does not hold "users active that day", it holds "users whose
  // final visit was that day". The buckets sum to activeMonth.
  //
  // That makes it a LAST-SEEN / churn distribution. It is emphatically
  // NOT daily-active-users, and it must slope upward toward today no
  // matter how the game is actually doing — the shape is an artefact of
  // the storage model, not a signal. It was previously served as "dau"
  // and charted as "Daily Active", which is a confident wrong answer to
  // the single most important question on the dashboard.
  //
  // Renamed to `lastSeenSeries` so no caller can mistake it again. Real
  // DAU needs a per-day event row (see the DailyActive TODO below); it
  // cannot be recovered retroactively from this column.
  const lastSeenRows = await prisma.user.findMany({
    where: { lastSeenAt: { gte: thirtyDaysAgo } },
    select: { lastSeenAt: true },
  });
  const lastSeenSeries: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * day);
    lastSeenSeries[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of lastSeenRows) {
    if (!row.lastSeenAt) continue;
    const k = row.lastSeenAt.toISOString().slice(0, 10);
    if (k in lastSeenSeries) lastSeenSeries[k]++;
  }

  // Daily logins — a real per-day event series, derived from Session
  // rows (one per login, with a createdAt that is never overwritten).
  // This is not DAU either: an idle player with a long-lived session
  // logs in once and plays for days, so it undercounts engagement. But
  // unlike lastSeenSeries it is a true count of a real event on a real
  // day, so it is honest.
  const sessionRows = await prisma.session.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: { createdAt: true },
  });
  const loginSeries: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * day);
    loginSeries[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of sessionRows) {
    const k = row.createdAt.toISOString().slice(0, 10);
    if (k in loginSeries) loginSeries[k]++;
  }

  // ── Real DAU + retention, from the DailyActive event table ─────────
  //
  // Everything above is a workaround for not having per-day activity
  // rows. This is the real thing. Both are wrapped in a tolerant try:
  // the table is created by scripts/ensure-daily-active.ts, and if the
  // code is deployed ahead of that, analytics must degrade rather than
  // 500 the operator's landing page.
  //
  // `dauCollectingSince` is the honest disclaimer. The table only knows
  // about days since it existed, and no amount of querying recovers
  // history that was never recorded — so the UI states the start date
  // instead of rendering 30 buckets and implying the zeroes are real.
  let dauSeries: Record<string, number> | null = null;
  let dauCollectingSince: string | null = null;
  let retention: { d1: number | null; d7: number | null; d30: number | null; cohortSizes: { d1: number; d7: number; d30: number } } | null = null;

  try {
    const dauRows = await prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT "day", COUNT(DISTINCT "userId")::bigint AS count
        FROM "DailyActive"
       WHERE "day" >= ${thirtyDaysAgo}
       GROUP BY "day"
       ORDER BY "day" ASC
    `;
    const [firstRow] = await prisma.$queryRaw<{ day: Date }[]>`
      SELECT "day" FROM "DailyActive" ORDER BY "day" ASC LIMIT 1
    `;
    dauCollectingSince = firstRow ? firstRow.day.toISOString().slice(0, 10) : null;

    dauSeries = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(now.getTime() - i * day);
      const k = d.toISOString().slice(0, 10);
      // Only emit buckets from days we were actually recording. A zero
      // on a day that predates the table is not "nobody played", it is
      // "we do not know", and charting the two identically is the same
      // class of lie the old dauSeries told.
      if (dauCollectingSince && k >= dauCollectingSince) dauSeries[k] = 0;
    }
    for (const r of dauRows) {
      const k = r.day.toISOString().slice(0, 10);
      if (k in dauSeries) dauSeries[k] = Number(r.count);
    }

    // Retention: of the players who signed up N+1 days ago, what share
    // came back on exactly day N after signup? Only computed for cohorts
    // whose day-N window is fully inside the collection period —
    // otherwise we would report 0% for players we simply were not
    // watching, which reads as catastrophic churn.
    const retentionFor = async (n: number): Promise<{ rate: number | null; size: number }> => {
      const cohortStart = new Date(now.getTime() - (n + 1) * day);
      cohortStart.setUTCHours(0, 0, 0, 0);
      const cohortEnd = new Date(cohortStart.getTime() + day);
      const checkDay = new Date(cohortStart.getTime() + n * day);
      if (!dauCollectingSince || checkDay.toISOString().slice(0, 10) < dauCollectingSince) {
        return { rate: null, size: 0 };
      }
      const cohort = await prisma.user.findMany({
        where: { createdAt: { gte: cohortStart, lt: cohortEnd } },
        select: { id: true },
      });
      if (cohort.length === 0) return { rate: null, size: 0 };
      const ids = cohort.map((u) => u.id);
      const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count
          FROM "DailyActive"
         WHERE "day" = ${checkDay}
           AND "userId" = ANY(${ids})
      `;
      return { rate: (Number(count) / cohort.length) * 100, size: cohort.length };
    };

    const [r1, r7, r30] = await Promise.all([
      retentionFor(1), retentionFor(7), retentionFor(30),
    ]);
    retention = {
      d1: r1.rate, d7: r7.rate, d30: r30.rate,
      cohortSizes: { d1: r1.size, d7: r7.size, d30: r30.size },
    };
  } catch (e) {
    if (!/does not exist|no such table/i.test(String(e))) {
      console.error("[analytics] DailyActive query failed", String(e));
    }
    // Leave dauSeries/retention null — the dashboard renders a
    // "not collecting yet" state rather than a fake zero series.
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

  // PvP matches per day for the last 30 days. Mirrors the signupSeries
  // shape so the chart helpers don't need to know the difference.
  const pvpRows = await prisma.pvpMatch.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: { createdAt: true },
  }).catch(() => [] as { createdAt: Date }[]);
  const pvpSeries: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * day);
    pvpSeries[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of pvpRows) {
    const k = row.createdAt.toISOString().slice(0, 10);
    if (k in pvpSeries) pvpSeries[k]++;
  }

  // Trades per day for the last 30 days.
  const tradeRows = await prisma.tradeRecord.findMany({
    where: { createdAt: { gte: thirtyDaysAgo } },
    select: { createdAt: true },
  }).catch(() => [] as { createdAt: Date }[]);
  const tradeSeries: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * day);
    tradeSeries[d.toISOString().slice(0, 10)] = 0;
  }
  for (const row of tradeRows) {
    const k = row.createdAt.toISOString().slice(0, 10);
    if (k in tradeSeries) tradeSeries[k]++;
  }

  // Top 10 by pokedex completion + top 10 by total caught levels (the
  // grindiest players) so the CRM has two leaderboards to look at.
  const [topByDex, topByLevels] = await Promise.all([
    prisma.user.findMany({
      orderBy: { pokedexCaughtCount: "desc" },
      take: 10,
      select: {
        id: true, username: true, name: true,
        accountLevel: true, pokedexCaughtCount: true,
      },
    }),
    prisma.user.findMany({
      orderBy: { totalCaughtLevels: "desc" },
      take: 10,
      select: {
        id: true, username: true, name: true,
        accountLevel: true, totalCaughtLevels: true,
      },
    }),
  ]);

  return c.json({
    totals: {
      users: totalUsers,
      bannedUsers,
      admins,
      friendships,
      chatMessagesTotal,
      chatMessages7d,
      pvpMatchesTotal,
      pvpMatches7d,
      tradesTotal,
      trades7d,
      bugReportsOpen,
      errorsLast24h,
      pokemonCaughtSum: pokedexSum._sum.pokedexCaughtCount ?? 0,
      pokemonLevelsSum: accountLevelSum._sum.totalCaughtLevels ?? 0,
    },
    activity: {
      activeDay,
      activeWeek,
      activeMonth,
      signups7d,
      signups30d,
    },
    averages: {
      pokedexCaught: Math.round((pokedexAvg._avg.pokedexCaughtCount ?? 0) * 10) / 10,
      accountLevel: Math.round((pokedexAvg._avg.accountLevel ?? 0) * 10) / 10,
    },
    signupSeries,
    lastSeenSeries,
    loginSeries,
    dauSeries,
    dauCollectingSince,
    retention,
    pvpSeries,
    tradeSeries,
    levelBuckets,
    leaderboards: {
      pokedex: topByDex,
      sigmaLevels: topByLevels,
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
  const limit = Math.min(500, Math.max(20, parseInt(c.req.query("limit") ?? "100", 10)));
  // channel: "all" | "global" | "area" | "dm" | a specific channel id like "area:Pallet Town"
  const channel = (c.req.query("channel") ?? "all").trim();
  const q = (c.req.query("q") ?? "").trim();
  const username = (c.req.query("username") ?? "").trim();

  const where: any = {};
  if (channel && channel !== "all") {
    if (channel === "global") where.channelId = "global";
    else if (channel === "area") where.channelId = { startsWith: "area:" };
    else if (channel === "dm")   where.channelId = { startsWith: "dm:" };
    else where.channelId = channel;
  }
  if (q) where.content = { contains: q, mode: "insensitive" };
  if (username) {
    where.user = {
      OR: [
        { username: { contains: username, mode: "insensitive" } },
        { name:     { contains: username, mode: "insensitive" } },
      ],
    };
  }

  const [messages, channelGroups] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { id: true, username: true, name: true, isAdmin: true } } },
    }),
    // Channel facets — count messages by channelId so the admin sees
    // which channels are noisiest at a glance. Limit to public channels
    // (global + area:*) because DMs leak addressee info.
    prisma.chatMessage.groupBy({
      by: ["channelId"],
      _count: { channelId: true },
      where: {
        OR: [
          { channelId: "global" },
          { channelId: { startsWith: "area:" } },
        ],
      },
      orderBy: { _count: { channelId: "desc" } },
      take: 12,
    }),
  ]);
  return c.json({
    messages: messages.reverse(),
    channels: channelGroups.map((g) => ({ id: g.channelId, count: g._count.channelId })),
  });
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
  void makeAudit(c)(me.id, "chat.clearAll", null, { deleted: result.count });
  return c.json({ ok: true, deleted: result.count });
});

// Server-wide announcement. Lands in the global chat as a real
// ChatMessage authored by the admin who triggered it, but the body is
// stamped with a "📢 SERVER ANNOUNCEMENT — " prefix so the in-game
// chat client can pick it up and render it with the system-message
// style. The message persists in the DB so it shows up in chat
// history, audit log, and the moderation page just like any other.
app.post("/announce", async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }));
  const content = (body.content ?? "").trim();
  if (!content) return c.json({ error: "content required" }, 400);
  if (content.length > 500) return c.json({ error: "content too long (max 500)" }, 400);

  const prefixed = `📢 SERVER ANNOUNCEMENT — ${content}`;
  const stored = await prisma.chatMessage.create({
    data: { channelId: "global", userId: me.id, content: prefixed },
    include: {
      user: { select: { id: true, username: true, name: true, accountLevel: true } },
    },
  });
  const payload = {
    id: stored.id,
    channelId: stored.channelId,
    content: stored.content,
    createdAt: stored.createdAt,
    user: stored.user,
  };
  const io = getIo();
  if (io) io.to("global").emit("chat:message", payload);
  void makeAudit(c)(me.id, "chat.announce", null, { length: content.length });
  return c.json({ ok: true, message: payload });
});

app.delete("/chat/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  try {
    await prisma.chatMessage.delete({ where: { id } });
    void makeAudit(c)(me.id, "chat.delete", id);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "message not found" }, 404);
  }
});

// ── Live ops ──────────────────────────────────────────────────────────
// Real-time snapshot of who is connected right this second. Joined
// with the User table so we can show display names + ban state + last
// seen + level. Also returns the last 30 minutes of chat as a
// rolling activity feed so the operator sees engagement at a glance.
app.get("/live-ops", async (c) => {
  const snapshot = liveOnlineSnapshot();
  const userIds = snapshot.map((s) => s.userId);
  const since = new Date(Date.now() - 30 * 60 * 1000);

  const [users, recentMessages, recentSignups, recentTrades, recentPvP] = await Promise.all([
    userIds.length === 0
      ? []
      : prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true, username: true, name: true,
            accountLevel: true, lastSeenAt: true,
            pokedexCaughtCount: true, isAdmin: true, bannedUntil: true,
          },
        }),
    prisma.chatMessage.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { user: { select: { id: true, username: true, name: true } } },
    }),
    prisma.user.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, username: true, name: true, createdAt: true },
    }),
    prisma.tradeRecord.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, createdAt: true, userASentSpecies: true, userBSentSpecies: true },
    }).catch(() => [] as any[]),
    prisma.pvpMatch.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, createdAt: true, winnerId: true },
    }).catch(() => [] as any[]),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const onlineUsers = snapshot.map((s) => ({
    ...s,
    user: userMap.get(s.userId) ?? null,
  }));

  return c.json({
    online: onlineUsers,
    activity: {
      chat: recentMessages.map((m) => ({
        id: m.id,
        kind: "chat",
        channelId: m.channelId,
        content: m.content,
        createdAt: m.createdAt,
        user: m.user,
      })),
      signups: recentSignups.map((u) => ({
        id: u.id,
        kind: "signup",
        createdAt: u.createdAt,
        user: { id: u.id, username: u.username, name: u.name },
      })),
      trades: recentTrades.map((t) => ({
        id: t.id,
        kind: "trade",
        createdAt: t.createdAt,
        species: [t.userASentSpecies, t.userBSentSpecies],
      })),
      pvp: recentPvP.map((p) => ({
        id: p.id,
        kind: "pvp",
        createdAt: p.createdAt,
        winnerUserId: p.winnerId,
      })),
    },
    serverTime: new Date().toISOString(),
  });
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
  void makeAudit(c)(me.id, "bugReport.update", id, { status: newStatus, adminNotes: body.adminNotes });
  return c.json({ ok: true });
});

// ── Error log ──────────────────────────────────────────────────────────
// Server + client errors persist into ErrorLog. Filter by kind so the
// triage view can show server-side stack traces separately from
// client-reported ones.
// True error counts, grouped server-side by (kind, message).
//
// The dashboard used to group client-side over whatever rows it had
// fetched — and since the row endpoint caps the page, those counts were
// a FLOOR, not a count. That is wrong in the exact situation the log
// exists for: when one looping bug is generating thousands of rows and
// drowning everything else, the operator most needs to know it is
// 3,000 and not "200+". A groupBy answers over the whole table
// regardless of any row cap.
app.get("/errors/groups", async (c) => {
  const kind = (c.req.query("kind") ?? "").trim();
  const days = Math.min(90, Math.max(1, parseInt(c.req.query("days") ?? "14", 10)));
  const since = new Date(Date.now() - days * 86400000);

  const rows = await prisma.errorLog.groupBy({
    by: ["kind", "message"],
    where: {
      createdAt: { gte: since },
      ...(kind === "server" || kind === "client" ? { kind } : {}),
    },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _count: { message: "desc" } },
    take: 100,
  });

  // One representative row per group so the operator can see a stack
  // without expanding into the raw table.
  const groups = await Promise.all(rows.map(async (g) => {
    const sample = await prisma.errorLog.findFirst({
      where: { kind: g.kind, message: g.message },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, level: true, source: true, stack: true,
        userId: true, username: true, userAgent: true,
      },
    });
    return {
      kind: g.kind,
      message: g.message,
      count: g._count._all,
      latestAt: g._max.createdAt,
      sample,
    };
  }));

  return c.json({ sinceDays: days, groups });
});

// Clear a resolved error group.
//
// Once a bug is actually fixed, its historical rows are pure noise —
// they push live problems off the top of the log and inflate the
// dashboard's error KPI forever. Deleting by exact (kind, message) is
// the honest unit: it is the same key the grouped view counts by, so
// what the operator sees is exactly what gets removed.
//
// Audited with the row count, so "who wiped 228 errors and when" stays
// answerable after the fact.
const ClearErrorsBody = z.object({
  kind: z.enum(["server", "client"]),
  message: z.string().min(1),
});

app.post("/errors/clear-group", async (c) => {
  const me = c.get("user");
  const parsed = ClearErrorsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const { kind, message } = parsed.data;
  const result = await prisma.errorLog.deleteMany({ where: { kind, message } });
  void makeAudit(c)(me.id, "errors.clear_group", null, {
    kind,
    message: message.slice(0, 200),
    deleted: result.count,
  });
  return c.json({ ok: true, deleted: result.count });
});

app.get("/errors", async (c) => {
  const kind = (c.req.query("kind") ?? "").trim();
  // Cap raised 200 → 500 to match what the dashboard actually asks for.
  // It requested 500 and silently received 200, so the table quietly
  // hid 60% of what the operator asked to see, with no indication.
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query("limit") ?? "100", 10)));
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
  // `total` lets the table say "showing 500 of 3,412" instead of
  // implying the 500 it rendered is everything there is.
  const total = await prisma.errorLog.count({
    where: kind === "server" || kind === "client" ? { kind } : {},
  });

  return c.json({
    total,
    limit,
    truncated: total > rows.length,
    errors: rows.map((r) => ({
      ...r,
      meta: r.meta ? safeJson(r.meta) : null,
    })),
  });
});

// ── Tournaments ────────────────────────────────────────────────────────
// Admin-managed brackets. v1 ships:
//   - Create + list + delete tournaments with optional level cap
//   - Add / remove participants (manual seeding by the admin)
//   - "Run match" — given two participant ids, spawn a server-side
//     PvP battle room with format=tournament + the tournament's
//     levelCap. Both participants must be online + provide teams.
//
// Player-facing tournament UI (browse, sign up, watch bracket) is a
// follow-up. For v1 the admin DMs participants to coordinate.

const TournamentCreateBody = z.object({
  name: z.string().min(1).max(80),
  levelCap: z.number().int().min(1).max(100).nullable().optional(),
  format: z.string().max(40).optional(),
});

app.get("/tournaments", async (c) => {
  const tournaments = await prisma.tournament.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      entries: {
        select: { id: true, userId: true, username: true, eliminated: true, seed: true },
      },
    },
  });
  return c.json({ tournaments });
});

app.post("/tournaments", async (c) => {
  const me = c.get("user");
  const parsed = TournamentCreateBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const t = await prisma.tournament.create({
    data: {
      name: parsed.data.name,
      levelCap: parsed.data.levelCap ?? null,
      format: parsed.data.format ?? "tournament",
      status: "open",
      ownerId: me.id,
    },
  });
  void makeAudit(c)(me.id, "tournament.create", t.id, { name: t.name, levelCap: t.levelCap });
  return c.json({ tournament: t });
});

app.delete("/tournaments/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  try {
    await prisma.tournament.delete({ where: { id } });
    void makeAudit(c)(me.id, "tournament.delete", id);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "tournament not found" }, 404);
  }
});

// Update level cap / status / name post-creation.
app.patch("/tournaments/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string; levelCap?: number | null; status?: string }
    | null;
  if (!body) return c.json({ error: "invalid body" }, 400);
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.length <= 80) data.name = body.name;
  if (body.levelCap === null || (typeof body.levelCap === "number" && body.levelCap >= 1 && body.levelCap <= 100)) {
    data.levelCap = body.levelCap;
  }
  // Status was `if (typeof body.status === "string")` — any string, no
  // enum, no state machine. The dashboard renders a plain "Open"
  // button, and clicking it on a LIVE event walked the tournament
  // backwards into "open", which re-armed Generate bracket (whose only
  // guard was status !== "open"). That then overwrote `bracket`
  // wholesale, discarding every battleId and winnerId recorded so far.
  // Two clicks, a semifinal's worth of real results gone, no history,
  // no undo. Only legal forward transitions are accepted now.
  const LEGAL_NEXT: Record<string, string[]> = {
    open:      ["live", "cancelled"],
    live:      ["completed", "cancelled"],
    completed: [],            // terminal — re-opening would invite a re-seed
    cancelled: [],            // terminal
  };
  if (body.status !== undefined) {
    const next = String(body.status);
    const current = await prisma.tournament.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) return c.json({ error: "tournament not found" }, 404);
    if (next !== current.status) {
      const allowed = LEGAL_NEXT[current.status] ?? [];
      if (!allowed.includes(next)) {
        return c.json({
          error: "illegal status transition",
          reason: `A tournament cannot go from "${current.status}" to "${next}".`
            + (allowed.length
              ? ` Allowed from here: ${allowed.join(", ")}.`
              : ` "${current.status}" is terminal.`),
          from: current.status,
          to: next,
          allowed,
        }, 409);
      }
      data.status = next;
    }
  }
  try {
    const t = await prisma.tournament.update({ where: { id }, data });
    void makeAudit(c)(me.id, "tournament.update", id, data);
    return c.json({ tournament: t });
  } catch {
    return c.json({ error: "tournament not found" }, 404);
  }
});

// Add participant by username — looks up the user and creates a
// TournamentEntry. The compound unique on (tournamentId, userId)
// prevents duplicate registrations.
app.post("/tournaments/:id/entries", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { username?: string } | null;
  const uname = String(body?.username ?? "").trim();
  if (!uname) return c.json({ error: "username required" }, 400);
  const u = await prisma.user.findUnique({ where: { username: uname }, select: { id: true, username: true } });
  if (!u) return c.json({ error: "user not found" }, 404);
  try {
    const entry = await prisma.tournamentEntry.create({
      data: { tournamentId: id, userId: u.id, username: u.username },
    });
    void makeAudit(c)(me.id, "tournament.add_entry", id, { userId: u.id });
    return c.json({ entry });
  } catch {
    return c.json({ error: "user already registered or tournament missing" }, 400);
  }
});

app.delete("/tournaments/:id/entries/:entryId", async (c) => {
  const me = c.get("user");
  const tid = c.req.param("id");
  const eid = c.req.param("entryId");
  try {
    await prisma.tournamentEntry.delete({ where: { id: eid } });
    void makeAudit(c)(me.id, "tournament.remove_entry", tid, { entryId: eid });
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "entry not found" }, 404);
  }
});

// ── Generate the bracket ────────────────────────────────────────────
// Seeds a single-elimination bracket from the registered entries. Only
// allowed while status="open"; flips status to "live" on success.
// Idempotent in the sense that a re-call with status="live" returns
// 409 — bracket must be regenerated only after delete + re-create.
app.post("/tournaments/:id/generate-bracket", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({
    where: { id },
    include: { entries: true },
  });
  if (!t) return c.json({ error: "tournament not found" }, 404);
  if (t.status !== "open") {
    return c.json({ error: "tournament must be 'open' to generate a bracket" }, 409);
  }
  // Status is not sufficient protection on its own. Refuse outright if a
  // bracket already exists — regenerating overwrites it wholesale and
  // takes every recorded battleId and winnerId with it. Requiring an
  // explicit delete + recreate to re-seed makes destroying real results
  // an intentional act rather than a side effect of a stray click.
  if (t.bracket != null) {
    return c.json({
      error: "bracket already exists",
      reason: "Regenerating would discard the recorded match results. "
        + "Delete the tournament and recreate it if you need a fresh seed.",
    }, 409);
  }
  // Never re-seed eliminated players. bracket.ts's own header documents
  // this expectation; the endpoint was passing t.entries unfiltered.
  const seedable = t.entries.filter((e) => !e.eliminated);
  if (seedable.length < 2) {
    return c.json({ error: "need at least 2 participants" }, 400);
  }
  const bracket = generateBracket(
    seedable.map((e) => ({ userId: e.userId, username: e.username, seed: e.seed })),
  );
  const updated = await prisma.tournament.update({
    where: { id },
    data: { bracket: JSON.stringify(bracket), status: "live", startsAt: new Date() },
  });
  void makeAudit(c)(me.id, "tournament.generate_bracket", id, {
    rounds: bracket.rounds.length,
    entries: t.entries.length,
  });
  return c.json({ tournament: updated });
});

// ── Advance the bracket ────────────────────────────────────────────
// Reads the bracket + every linked PvpMatch, copies in any newly-
// resolved winners, marks losers as eliminated, propagates winnerOf
// placeholders forward. Marks the tournament completed when the
// final match has a winner. Idempotent: call as often as you want;
// no-ops when nothing has resolved since the last call.
app.post("/tournaments/:id/advance-bracket", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t || !t.bracket) return c.json({ error: "tournament has no bracket" }, 400);
  if (t.status !== "live") return c.json({ error: "tournament not live" }, 409);

  let bracket: Bracket;
  try { bracket = JSON.parse(t.bracket) as Bracket; }
  catch { return c.json({ error: "bracket JSON is corrupt" }, 500); }

  // Build the matchResults map by joining every match with a battleId
  // against PvpMatch.winnerId. Matches without a battleId are skipped
  // (haven't been started yet).
  const battleIds = bracket.rounds
    .flatMap((r) => r.matches)
    .filter((m): m is typeof m & { battleId: string } => !!m.battleId && !m.winnerId)
    .map((m) => m.battleId);
  const pvpMatches = battleIds.length > 0
    ? await prisma.pvpMatch.findMany({
        where: { id: { in: battleIds } },
        select: { id: true, winnerId: true, status: true },
      })
    : [];
  const matchResults: Record<string, string | null> = {};
  for (const r of bracket.rounds) {
    for (const m of r.matches) {
      if (!m.battleId || m.winnerId) continue;
      const pm = pvpMatches.find((x) => x.id === m.battleId);
      if (pm && pm.status === "completed" && pm.winnerId) {
        matchResults[m.id] = pm.winnerId;
      }
    }
  }

  const advanced = advanceBracket(bracket, matchResults);
  // Mark losers as eliminated in TournamentEntry. We use updateMany
  // so it's a single round-trip for all losers.
  if (advanced.eliminatedUserIds.length > 0) {
    await prisma.tournamentEntry.updateMany({
      where: { tournamentId: id, userId: { in: advanced.eliminatedUserIds } },
      data: { eliminated: true },
    });
  }
  const data: { bracket: string; status?: string; finishedAt?: Date } = {
    bracket: JSON.stringify(advanced.bracket),
  };
  if (advanced.complete) {
    data.status = "completed";
    data.finishedAt = new Date();
  }
  const updated = await prisma.tournament.update({ where: { id }, data });
  void makeAudit(c)(me.id, "tournament.advance_bracket", id, {
    eliminated: advanced.eliminatedUserIds.length,
    complete: advanced.complete,
    championId: advanced.championId,
  });
  return c.json({ tournament: updated, championId: advanced.championId });
});

// ── Start a specific bracket-match ──────────────────────────────────
// Like /tournaments/:id/match but works against a bracket-match-id
// (e.g. "r1.m0") rather than two raw user ids — server resolves the
// concrete users from the bracket, refuses if the match's slots are
// still placeholders, and writes the resulting battleId back into
// the bracket JSON so advance-bracket can find it later.
app.post("/tournaments/:id/start-bracket-match", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as { matchId?: string } | null;
  const matchId = String(body?.matchId ?? "");
  if (!matchId) return c.json({ error: "matchId required" }, 400);
  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t || !t.bracket) return c.json({ error: "tournament has no bracket" }, 400);
  if (t.status !== "live") return c.json({ error: "tournament not live" }, 409);
  let bracket: Bracket;
  try { bracket = JSON.parse(t.bracket) as Bracket; }
  catch { return c.json({ error: "bracket JSON is corrupt" }, 500); }

  // Locate the match.
  let target: { match: Bracket["rounds"][number]["matches"][number] } | null = null;
  for (const r of bracket.rounds) {
    for (const m of r.matches) {
      if (m.id === matchId) { target = { match: m }; break; }
    }
    if (target) break;
  }
  if (!target) return c.json({ error: "match not in bracket" }, 404);
  if (target.match.battleId) {
    return c.json({ error: "match already started", battleId: target.match.battleId }, 409);
  }
  if (target.match.winnerId) {
    return c.json({ error: "match already resolved" }, 409);
  }
  if (target.match.a.kind !== "player" || target.match.b.kind !== "player") {
    return c.json({ error: "match has unresolved placeholders — advance the bracket first" }, 400);
  }
  const aUserId = target.match.a.userId;
  const bUserId = target.match.b.userId;

  // Pull both players' parties + verify they're online.
  const [aUser, bUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: aUserId }, select: { id: true, username: true, saveData: true } }),
    prisma.user.findUnique({ where: { id: bUserId }, select: { id: true, username: true, saveData: true } }),
  ]);
  if (!aUser || !bUser) return c.json({ error: "user not found" }, 404);
  const partyOf = (saveJson: string | null): unknown[] => {
    if (!saveJson) return [];
    try {
      const s = JSON.parse(saveJson);
      return Array.isArray(s?.party) ? s.party : [];
    } catch { return []; }
  };
  const teamA = partyOf(aUser.saveData);
  const teamB = partyOf(bUser.saveData);
  if (teamA.length < 1 || teamB.length < 1) {
    return c.json({ error: "one or both participants have no party" }, 400);
  }
  // Refuse if either user is already in another in-flight battle —
  // see /tournaments/:id/match for rationale.
  for (const room of battleRooms.values()) {
    if (room.status !== "active" && room.status !== "invited") continue;
    if (
      room.a.userId === aUser.id || room.b.userId === aUser.id
      || room.a.userId === bUser.id || room.b.userId === bUser.id
    ) {
      return c.json({ error: "one or both participants are already in a battle" }, 409);
    }
  }
  if (!getIo()) return c.json({ error: "socket server not ready" }, 500);

  const battleId = newBattleId();
  const room: BattleRoom = {
    id: battleId,
    status: "invited",
    format: "tournament",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: aUser.id, username: aUser.username, team: teamA as never, stream: null, request: null, connected: true },
    b: { userId: bUser.id, username: bUser.username, team: teamB as never, stream: null, request: null, connected: true },
    log: [],
    stream: null,
    expiryTimer: null,
    spectators: new Set(),
    tournamentId: t.id,
    levelCap: t.levelCap ?? undefined,
  };
  battleRooms.set(battleId, room);

  // Save the battleId into the bracket BEFORE starting the simulator
  // — that way if the simulator throws or the server crashes, the
  // next advance-bracket call will see the half-state and flag it.
  target.match.battleId = battleId;
  await prisma.tournament.update({
    where: { id },
    data: { bracket: JSON.stringify(bracket) },
  });

  sendToUserGlobal(aUser.id, "battle:start", {
    battleId, format: room.format, opponent: { id: bUser.id, username: bUser.username }, you: "a",
    levelCap: t.levelCap ?? null,
  });
  sendToUserGlobal(bUser.id, "battle:start", {
    battleId, format: room.format, opponent: { id: aUser.id, username: aUser.username }, you: "b",
    levelCap: t.levelCap ?? null,
  });
  try {
    await startBattle(getIo()!, room, sendToUserGlobal);
    void makeAudit(c)(me.id, "tournament.start_bracket_match", t.id, { battleId, matchId, aUserId, bUserId });
    return c.json({ ok: true, battleId });
  } catch (e) {
    room.status = "cancelled";
    sendToUserGlobal(aUser.id, "battle:cancelled", { battleId, reason: "Engine refused the matchup." });
    sendToUserGlobal(bUser.id, "battle:cancelled", { battleId, reason: "Engine refused the matchup." });
    battleRooms.delete(battleId);
    // Roll back the bracket battleId so the admin can retry without
    // the bracket thinking the match has already started.
    target.match.battleId = null;
    await prisma.tournament.update({
      where: { id },
      data: { bracket: JSON.stringify(bracket) },
    });
    return c.json({ error: "engine refused", detail: String(e) }, 500);
  }
});

// Spawn a tournament match between two registered participants. Both
// must be online; both will see a battle:invite-style start event and
// the server-side room is created with format="tournament" so the
// tournament's levelCap is applied. Teams are pulled from each
// participant's current party (admin's responsibility to confirm
// they're ready before triggering).
app.post("/tournaments/:id/match", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { aUserId?: string; bUserId?: string }
    | null;
  const aUserId = String(body?.aUserId ?? "");
  const bUserId = String(body?.bUserId ?? "");
  if (!aUserId || !bUserId || aUserId === bUserId) {
    return c.json({ error: "two distinct participant ids required" }, 400);
  }
  const t = await prisma.tournament.findUnique({
    where: { id },
    include: { entries: { where: { userId: { in: [aUserId, bUserId] } } } },
  });
  if (!t) return c.json({ error: "tournament not found" }, 404);
  if (t.entries.length !== 2) return c.json({ error: "both users must be registered participants" }, 400);

  const [aUser, bUser] = await Promise.all([
    prisma.user.findUnique({ where: { id: aUserId }, select: { id: true, username: true, saveData: true } }),
    prisma.user.findUnique({ where: { id: bUserId }, select: { id: true, username: true, saveData: true } }),
  ]);
  if (!aUser || !bUser) return c.json({ error: "user not found" }, 404);

  // Refuse if either side is already in an active or pending battle.
  // Without this, the admin could clobber a user's in-progress
  // friend battle with a tournament match — the client UI doesn't
  // multiplex two PvP rooms.
  for (const room of battleRooms.values()) {
    if (room.status !== "active" && room.status !== "invited") continue;
    if (
      room.a.userId === aUser.id || room.b.userId === aUser.id
      || room.a.userId === bUser.id || room.b.userId === bUser.id
    ) {
      return c.json({ error: "one or both participants are already in a battle" }, 409);
    }
  }

  // Pull teams from each user's saved party. Admin should ensure both
  // sides have a party set — if either is empty, the simulator will
  // refuse to start. We surface that as a 400 here rather than the
  // raw engine error.
  const partyOf = (saveJson: string | null): unknown[] => {
    if (!saveJson) return [];
    try {
      const s = JSON.parse(saveJson);
      return Array.isArray(s?.party) ? s.party : [];
    } catch { return []; }
  };
  const teamA = partyOf(aUser.saveData);
  const teamB = partyOf(bUser.saveData);
  if (teamA.length < 1 || teamB.length < 1) {
    return c.json({ error: "one or both participants have no party" }, 400);
  }

  if (!getIo()) return c.json({ error: "socket server not ready" }, 500);

  const battleId = newBattleId();
  const room: BattleRoom = {
    id: battleId,
    status: "invited",
    format: "tournament",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: aUser.id, username: aUser.username, team: teamA as never, stream: null, request: null, connected: true },
    b: { userId: bUser.id, username: bUser.username, team: teamB as never, stream: null, request: null, connected: true },
    log: [],
    stream: null,
    expiryTimer: null,
    spectators: new Set(),
    tournamentId: t.id,
    levelCap: t.levelCap ?? undefined,
  };
  battleRooms.set(battleId, room);
  sendToUserGlobal(aUser.id, "battle:start", {
    battleId, format: room.format, opponent: { id: bUser.id, username: bUser.username }, you: "a",
    levelCap: t.levelCap ?? null,
  });
  sendToUserGlobal(bUser.id, "battle:start", {
    battleId, format: room.format, opponent: { id: aUser.id, username: aUser.username }, you: "b",
    levelCap: t.levelCap ?? null,
  });
  try {
    await startBattle(getIo()!, room, sendToUserGlobal);
    void makeAudit(c)(me.id, "tournament.start_match", t.id, { battleId, aUserId, bUserId });
    return c.json({ ok: true, battleId });
  } catch (e) {
    room.status = "cancelled";
    sendToUserGlobal(aUser.id, "battle:cancelled", { battleId, reason: "Engine refused the matchup." });
    sendToUserGlobal(bUser.id, "battle:cancelled", { battleId, reason: "Engine refused the matchup." });
    battleRooms.delete(battleId);
    return c.json({ error: "engine refused", detail: String(e) }, 500);
  }
});

export default app;
