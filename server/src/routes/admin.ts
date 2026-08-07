import { Hono } from "hono";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { adminApiKey, requireUser, requireAdmin } from "../lib/middleware.js";
import { audit as auditRaw } from "../lib/audit.js";
import { validateSave } from "../lib/saveValidation.js";
import { computeAccountLevel } from "../lib/level.js";
import { broadcastChatCleared, sendToUserGlobal, getIo, kickUser, liveOnlineSnapshot, broadcastAnnouncement, isOnline } from "../socket.js";
import { TRADE_CHANNEL } from "../lib/chatChannels.js";
import { recordError } from "../lib/errorReporting.js";
import {
  AnnouncementInput,
  getLiveAnnouncement,
  isValidHref,
  toPublic as toPublicAnnouncement,
} from "../lib/announcements.js";
import { forceSnapshot } from "../lib/saveHistory.js";
import { auth } from "../auth.js";
import {
  battleRooms,
  newBattleId,
  startBattle,
  type BattleRoom,
} from "../pvp.js";
import {
  generateBracket, advanceBracket, findMatch, participants,
  type Bracket,
} from "../lib/bracket.js";
import {
  startTournamentBattle, tickOneTournament, onTournamentComplete,
  clampRoundMinutes, usernameOf,
} from "../lib/tournamentRunner.js";
import { endBattle } from "../pvp.js";
import {
  parsePrizes, parsePrizesStrict, describePrizes, PrizeListSchema, type Prize,
} from "../lib/giveaway.js";
import { drawGiveaway } from "../lib/giveawayDraw.js";
import { roleThresholds } from "../lib/discordRoles.js";
import { LINK_REWARD_SOURCE } from "../lib/discordLinkReward.js";
import { XP_DEFAULTS, levelFromXp } from "../lib/discordXp.js";
import { enqueuePrizeGrant, checkPrizesDeliverable } from "../lib/prizeGrant.js";
import { generateStreamKey, sanitizeStreamConfig, parseStreamConfig } from "../lib/streamSession.js";
import { emitSaveAdopt } from "../lib/saveAdopt.js";
import { getBroadcast, setBroadcast, type BroadcastPatch } from "../lib/broadcast.js";
import { twitchConfigured, getChannelInfo, setChannelInfo } from "../lib/twitch.js";
import { markWatching, getFrame, enqueueInput, sanitizeInput } from "../lib/browserControl.js";
import { getCommandResults } from "../lib/streamCommandLog.js";

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

  // Counts for the OTHER filters, under the same search.
  //
  // ── WHY ─────────────────────────────────────────────────────────
  // The filter tabs used to be unlabelled, so "are there any banned accounts
  // matching this search?" could only be answered by clicking Banned and
  // seeing an empty table. Two extra counts turn that into something the
  // operator reads without navigating — and they respect `q`, so the numbers
  // describe the search actually on screen rather than the whole table.
  const [total, users, bannedCount, adminCount] = await Promise.all([
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
    prisma.user.count({ where: { ...searchWhere, bannedUntil: { gt: new Date() } } }),
    prisma.user.count({ where: { ...searchWhere, isAdmin: true } }),
  ]);

  // `all` is the unfiltered count under the same search, which is NOT `total`
  // whenever a filter is active — the tab has to show how many it would find,
  // not how many the current view holds.
  const allCount = filter ? await prisma.user.count({ where: searchWhere }) : total;

  return c.json({
    total, page, pageSize, users,
    counts: { all: allCount, banned: bannedCount, admins: adminCount },
  });
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

// ── Stream auto-login key ──────────────────────────────────────────────
// Manage a user's OBS/24-7 stream auto-login key (see lib/streamSession.ts
// + POST /stream-login). The key value is a bearer secret — it's returned
// here (and embedded in loginUrl) only so the operator can paste it into
// OBS. GET reports status; POST enables / disables / regenerates.
function streamLoginUrl(c: { req: { url: string } }, key: string): string {
  const base = (process.env.BETTER_AUTH_URL?.trim() || new URL(c.req.url).origin).replace(/\/$/, "");
  return `${base}/stream-login?key=${encodeURIComponent(key)}`;
}

function streamStatus(c: { req: { url: string } }, row: {
  enabled: boolean; label: string | null; config: string | null;
  createdAt: Date; lastUsedAt: Date | null; lastUsedIp: string | null; key: string;
}) {
  return {
    exists: true,
    enabled: row.enabled,
    label: row.label,
    config: parseStreamConfig(row.config),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    key: row.key,
    loginUrl: streamLoginUrl(c, row.key),
  };
}

app.get("/users/:id/stream-key", async (c) => {
  const id = c.req.param("id");
  const row = await prisma.streamKey.findUnique({ where: { userId: id } });
  if (!row) return c.json({ exists: false });
  return c.json(streamStatus(c, row));
});

app.post("/users/:id/stream-key", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { action?: string; label?: string; config?: unknown };
  const action = body.action;
  if (action !== "enable" && action !== "disable" && action !== "regenerate" && action !== "config") {
    return c.json({ error: "action must be enable|disable|regenerate|config" }, 400);
  }
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return c.json({ error: "user not found" }, 404);
  const label = typeof body.label === "string" ? body.label.slice(0, 60) : undefined;
  // `config` in the body: undefined = leave as-is; present = replace (a sanitized
  // null clears it). Stored as a JSON string.
  const configProvided = Object.prototype.hasOwnProperty.call(body, "config");
  const configJson = configProvided
    ? (() => { const cfg = sanitizeStreamConfig(body.config); return cfg ? JSON.stringify(cfg) : null; })()
    : undefined;

  if (action === "disable") {
    const row = await prisma.streamKey
      .update({ where: { userId: id }, data: { enabled: false } })
      .catch(() => null);
    void makeAudit(c)(me.id, "user.stream_key_disable", id);
    return c.json(row ? streamStatus(c, row) : { exists: false, enabled: false });
  }

  if (action === "config") {
    // Update automation config only — requires an existing key.
    const row = await prisma.streamKey
      .update({ where: { userId: id }, data: { config: configJson ?? null } })
      .catch(() => null);
    if (!row) return c.json({ error: "no stream key to configure — enable it first" }, 404);
    void makeAudit(c)(me.id, "user.stream_key_config", id);
    return c.json(streamStatus(c, row));
  }

  // enable (create if missing, keep existing secret) or regenerate (new secret).
  const existing = await prisma.streamKey.findUnique({ where: { userId: id } });
  const key = action === "regenerate" || !existing ? generateStreamKey() : existing.key;
  const row = await prisma.streamKey.upsert({
    where: { userId: id },
    create: { userId: id, key, enabled: true, label, config: configJson ?? null },
    update: {
      key, enabled: true,
      ...(label !== undefined ? { label } : {}),
      ...(configProvided ? { config: configJson ?? null } : {}),
    },
  });
  void makeAudit(
    c,
  )(me.id, action === "regenerate" ? "user.stream_key_regenerate" : "user.stream_key_enable", id);
  return c.json(streamStatus(c, row));
});

// POST /users/:id/stream-command — remote-control a stream (OBS/24-7) account.
// Relays a command over the stream:command socket event; the client only obeys
// it when it's actually a stream session (isStream). Requires an enabled key.
const STREAM_COMMAND_KINDS = new Set(["travel", "speed", "autoProceed", "autoCatch", "raid", "gym", "eliteFour", "champion"]);
app.post("/users/:id/stream-command", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { command?: { kind?: string } };
  const command = body.command;
  if (!command || typeof command !== "object" || !command.kind || !STREAM_COMMAND_KINDS.has(command.kind)) {
    return c.json({ error: "invalid command" }, 400);
  }
  const key = await prisma.streamKey.findUnique({ where: { userId: id }, select: { enabled: true } });
  if (!key || !key.enabled) {
    return c.json({ error: "this account has no enabled stream login" }, 400);
  }
  const delivered = isOnline(id);
  sendToUserGlobal(id, "stream:command", command);
  void makeAudit(c)(me.id, "user.stream_command", id, { kind: command.kind });
  return c.json({ ok: true, delivered, command: command.kind });
});

// GET /users/:id/stream-command-log — what the stream client actually DID with
// recent remote commands. Delivery alone told the operator nothing about
// whether the client accepted the command.
app.get("/users/:id/stream-command-log", async (c) => {
  return c.json({ results: getCommandResults(c.req.param("id")) });
});

// ── Stream ops (one-shot snapshot + control) ───────────────────────────
// A single call that answers "what is the stream doing and why is it stuck?"
// — broadcast state, renderer status, the streamed account's actual progress,
// and the recent command outcomes. Built for machine/CLI callers (the
// ADMIN_API_KEY path) so the stream can be tuned without clicking through
// several dashboard pages.
app.get("/stream-ops", async (c) => {
  const b = await getBroadcast();
  const payload = await broadcastPayload();
  if (!b.accountUserId) return c.json({ broadcast: payload, account: null });
  const u = await prisma.user.findUnique({
    where: { id: b.accountUserId },
    select: { id: true, username: true, accountLevel: true, saveData: true, saveVersion: true },
  });
  const save = u?.saveData ? safeParseObject(u.saveData) : null;
  const inv = (save?.inventory ?? {}) as Record<string, number>;
  const party = ((save?.party ?? []) as { name?: string; level?: number; currentHp?: number; maxHp?: number }[]);
  return c.json({
    broadcast: payload,
    commandLog: getCommandResults(b.accountUserId),
    account: u ? {
      id: u.id,
      username: u.username,
      accountLevel: u.accountLevel,
      saveVersion: u.saveVersion,
      online: isOnline(u.id),
      currentLocation: save?.currentLocation ?? null,
      money: save?.money ?? 0,
      badges: (save?.defeatedGyms ?? []) as string[],
      eliteFour: (save?.defeatedEliteFour ?? []) as string[],
      autoCatch: save?.autoCatch ?? null,
      autoProceed: save?.autoProceed ?? null,
      speed: save?.speed ?? null,
      partySize: party.length,
      topLevel: party.reduce((m, p) => Math.max(m, p.level ?? 0), 0),
      faintedInParty: party.filter((p) => (p.currentHp ?? 0) <= 0).length,
      boxCount: ((save?.box ?? []) as unknown[]).length,
      balls: Object.fromEntries(Object.entries(inv).filter(([k]) => k.toLowerCase().includes("ball"))),
      unlockedCount: ((save?.unlockedLocations ?? []) as unknown[]).length,
    } : null,
  });
});

// ── 24/7 Twitch broadcast control ──────────────────────────────────────
// The standalone renderer service polls /api/internal/broadcast/state and
// pushes video to Twitch. These endpoints let an admin set the DESIRED state
// (on/off, which account, encode quality) and read the renderer's reported
// status. The Twitch stream key lives ONLY on the renderer service's env —
// the server never sees or stores it.
async function broadcastPayload() {
  const b = await getBroadcast();
  const account = b.accountUserId
    ? await prisma.user.findUnique({
        where: { id: b.accountUserId },
        select: { id: true, username: true, name: true },
      })
    : null;
  const key = b.accountUserId
    ? await prisma.streamKey.findUnique({ where: { userId: b.accountUserId }, select: { enabled: true } })
    : null;
  let status: unknown = null;
  if (b.lastStatus) { try { status = JSON.parse(b.lastStatus); } catch { status = null; } }
  // The renderer stops reporting `live` when it dies; treat a stale status
  // (no report in 45s) as offline so the dashboard doesn't lie.
  const stale = !b.lastStatusAt || Date.now() - new Date(b.lastStatusAt).getTime() > 45_000;
  return {
    enabled: b.enabled,
    account,
    accountUserId: b.accountUserId,
    streamKeyReady: !!key?.enabled,
    width: b.width,
    height: b.height,
    fps: b.fps,
    bitrateKbps: b.bitrateKbps,
    live: b.live && !stale,
    statusStale: stale,
    status,
    lastStatusAt: b.lastStatusAt,
    updatedAt: b.updatedAt,
  };
}

app.get("/broadcast", async (c) => {
  return c.json(await broadcastPayload());
});

// ── Live browser control (screen preview + input relay) ────────────────
// The renderer uploads periodic frames while an admin is watching; clicks and
// keystrokes are queued here and picked up on the renderer's next poll.
app.get("/broadcast/frame", async (c) => {
  markWatching();
  const f = getFrame();
  if (!f) return c.json({ frame: null, watching: true });
  return c.json({
    frame: f.data,
    at: f.at,
    width: f.width,
    height: f.height,
    ageMs: Date.now() - f.at,
    watching: true,
  });
});

app.post("/broadcast/input", async (c) => {
  const me = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { command?: unknown };
  const cmd = sanitizeInput(body.command);
  if (!cmd) return c.json({ error: "invalid input command" }, 400);
  markWatching();
  if (!enqueueInput(cmd)) return c.json({ error: "input queue full — the renderer may be offline" }, 429);
  // Only audit the state-changing navigations; a click/keystroke stream would
  // flood the audit log with no forensic value.
  if (cmd.kind === "navigate" || cmd.kind === "home" || cmd.kind === "reload") {
    void makeAudit(c)(me.id, "broadcast.browser_input", "", { kind: cmd.kind });
  }
  return c.json({ ok: true, kind: cmd.kind });
});

// ── Twitch channel info (title / category / tags) ──────────────────────
app.get("/broadcast/twitch", async (c) => {
  if (!twitchConfigured()) return c.json({ configured: false });
  try {
    const channel = await getChannelInfo();
    return c.json({ configured: true, channel });
  } catch (e) {
    return c.json({ configured: true, error: (e as Error).message }, 502);
  }
});

app.post("/broadcast/twitch", async (c) => {
  if (!twitchConfigured()) return c.json({ error: "Twitch is not configured on the server (set TWITCH_CLIENT_ID/SECRET/REFRESH_TOKEN)." }, 400);
  const me = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { title?: string; gameName?: string; tags?: string[] | string };
  const patch: { title?: string; gameName?: string; tags?: string[] } = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.gameName === "string") patch.gameName = body.gameName;
  if (Array.isArray(body.tags)) patch.tags = body.tags.map(String);
  else if (typeof body.tags === "string") patch.tags = body.tags.split(",").map((t) => t.trim()).filter(Boolean);
  try {
    const channel = await setChannelInfo(patch);
    void makeAudit(c)(me.id, "broadcast.twitch", "", { title: patch.title, gameName: patch.gameName });
    return c.json({ configured: true, channel });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.post("/broadcast", async (c) => {
  const me = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    enabled?: boolean; account?: string | null;
    width?: number; height?: number; fps?: number; bitrateKbps?: number;
  };
  const patch: BroadcastPatch = {};
  if ("enabled" in body) patch.enabled = !!body.enabled;
  if ("width" in body) patch.width = body.width;
  if ("height" in body) patch.height = body.height;
  if ("fps" in body) patch.fps = body.fps;
  if ("bitrateKbps" in body) patch.bitrateKbps = body.bitrateKbps;

  // `account` may be a userId or a username — resolve to an id (or clear it).
  if ("account" in body) {
    const raw = (body.account ?? "").toString().trim();
    if (!raw) {
      patch.accountUserId = null;
    } else {
      const acc = await prisma.user.findFirst({
        where: { OR: [{ id: raw }, { username: raw }] },
        select: { id: true },
      });
      if (!acc) return c.json({ error: `no user matches "${raw}"` }, 400);
      patch.accountUserId = acc.id;
    }
  }

  // Refuse to go live without a working stream login for the target account —
  // otherwise the renderer would just spin on a dead URL.
  const willEnable = patch.enabled ?? (await getBroadcast()).enabled;
  if (willEnable) {
    const accId = patch.accountUserId !== undefined ? patch.accountUserId : (await getBroadcast()).accountUserId;
    if (!accId) return c.json({ error: "choose an account before going live" }, 400);
    const key = await prisma.streamKey.findUnique({ where: { userId: accId }, select: { enabled: true } });
    if (!key?.enabled) {
      return c.json({ error: "that account has no enabled stream login — set one up on its Users page first" }, 400);
    }
  }

  await setBroadcast(patch);
  void makeAudit(c)(me.id, "broadcast.config", patch.accountUserId ?? "", {
    enabled: patch.enabled, width: patch.width, height: patch.height, fps: patch.fps,
  });
  return c.json(await broadcastPayload());
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

// Accumulating currencies: applied as a DELTA relative to what the admin
// loaded, so a concurrent player earn/spend isn't wiped. Everything else is a
// straight set onto the latest save.
const DELTA_SAVE_KEYS = new Set(["money", "victoryTokens"]);

// Apply an authoritative admin edit onto the player's LATEST save with a
// compare-and-swap RETRY loop. The old code CAS'd against the version the
// admin's browser loaded, so for an actively-playing user (whose save version
// moves every few seconds) an edit could NEVER land — it always 409'd
// ("save changed since this page loaded"). This re-reads the current save,
// lets `mutate` apply the specific changes onto it, and writes with a fresh
// CAS; if the player's client autosaved in between, it retries onto the newer
// save. Only the mutated fields change, so the player's other live progress is
// preserved. Bumps saveAdoptSeq + emits save:adopt so the online client adopts
// the result rather than re-uploading its stale copy.
async function patchSaveWithRetry(
  id: string,
  mutate: (latest: Record<string, unknown>) => Record<string, unknown> | { error: string; status?: number },
): Promise<
  | { ok: true; saveVersion: number; derived: ReturnType<typeof computeAccountLevel> }
  | { ok: false; status: number; error: string; reason?: string }
> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const target = await prisma.user.findUnique({
      where: { id },
      select: { saveData: true, saveVersion: true },
    });
    if (!target) return { ok: false, status: 404, error: "user not found" };
    const base = target.saveData ? safeParseObject(target.saveData) : {};
    if (!base) return { ok: false, status: 500, error: "user save is corrupt" };
    const out = mutate(base);
    if (out && typeof out === "object" && "error" in out) {
      return { ok: false, status: (out as { status?: number }).status ?? 400, error: (out as { error: string }).error };
    }
    const merged = out as Record<string, unknown>;
    const v = validateSave(merged);
    if (!v.ok) return { ok: false, status: 400, error: "patch produced invalid save", reason: v.reason };
    const derived = computeAccountLevel(merged);
    const claim = await prisma.user.updateMany({
      where: { id, saveVersion: target.saveVersion },
      data: {
        saveData: JSON.stringify(merged),
        saveVersion: { increment: 1 },
        saveAdoptSeq: { increment: 1 },
        saveUpdatedAt: new Date(),
        accountLevel: derived.accountLevel,
        totalCaughtLevels: derived.totalCaughtLevels,
        pokedexCaughtCount: derived.pokedexCaughtCount,
      },
    });
    if (claim.count > 0) {
      emitSaveAdopt(id);
      return { ok: true, saveVersion: target.saveVersion + 1, derived };
    }
    // Lost the CAS — the player's client autosaved between our read and write.
    // Loop and re-apply onto the newer save.
  }
  return { ok: false, status: 409, error: "the player's save is updating too fast to edit — try again in a moment" };
}

app.post("/users/:id/save-patch", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as
    | { patch?: Record<string, unknown>; announce?: string; expectedSaveVersion?: number; base?: Record<string, unknown> }
    | null;
  if (!body?.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
    return c.json({ error: "patch object required" }, 400);
  }
  for (const key of Object.keys(body.patch)) {
    if (!PATCHABLE_KEYS.has(key)) return c.json({ error: `key not patchable: ${key}` }, 400);
  }
  const patch = body.patch;
  const baseVals = (body.base && typeof body.base === "object" ? body.base : {}) as Record<string, unknown>;
  const appliedKeys = Object.keys(patch);

  const who = await prisma.user.findUnique({ where: { id }, select: { username: true } });
  if (!who) return c.json({ error: "user not found" }, 404);

  // Apply the edit onto the player's LATEST save (retry loop handles a
  // concurrently-autosaving client). Currencies are delta-merged so a
  // concurrent earn/spend survives; other keys are set.
  const result = await patchSaveWithRetry(id, (latest) => {
    const merged: Record<string, unknown> = { ...latest };
    for (const [key, value] of Object.entries(patch)) {
      if (
        DELTA_SAVE_KEYS.has(key) &&
        typeof value === "number" &&
        typeof baseVals[key] === "number" &&
        typeof latest[key] === "number"
      ) {
        // final = latest + (typed - loaded)
        const next = (latest[key] as number) + (value - (baseVals[key] as number));
        merged[key] = key === "money"
          ? Math.max(0, Math.min(999_999_999, Math.round(next)))
          : Math.max(0, Math.round(next));
      } else {
        merged[key] = value;
      }
    }
    return merged;
  });
  if (!result.ok) {
    return c.json(result.reason ? { error: result.error, reason: result.reason } : { error: result.error }, result.status as 400 | 404 | 409 | 500);
  }

  void makeAudit(c)(me.id, "user.save_patch", id, { keys: appliedKeys });
  if (appliedKeys.length > 0) await postGiftAnnouncement(me, body.announce, who.username);
  return c.json({
    ok: true,
    id,
    saveVersion: result.saveVersion,
    accountLevel: result.derived.accountLevel,
    pokedexCaughtCount: result.derived.pokedexCaughtCount,
    keys: appliedKeys,
  });
});

// Posted from both save-patch (gifting/editing a Pokémon) and the
// instant item-grant route below — an operator can opt to announce
// either as a "gift" system card, same shape as /announce and the
// giveaway cards but attributed to the recipient rather than being a
// server-wide broadcast. content is admin-authored (the client
// auto-suggests text but the operator can edit it), so this is capped
// and control-char-stripped the same way regular chat content is.
async function postGiftAnnouncement(
  me: { id: string; username: string },
  announce: string | undefined,
  recipientUsername: string,
): Promise<void> {
  if (typeof announce !== "string") return;
  // Strip control chars, the RTL-override char, and zero-width/format
  // characters (U+200B-200D, U+2060, U+FEFF) — String.trim() treats none
  // of these as whitespace, so without this an announce of e.g. a lone
  // zero-width space would pass the emptiness check below and post a
  // visually blank public "gift" card.
  const content = announce.replace(/[\x00-\x1f\x7f​‌‍⁠﻿‮]/g, "").trim().slice(0, 300);
  if (!content) return;
  try {
    const io = getIo();
    if (!io) return;
    const stored = await prisma.chatMessage.create({
      data: {
        channelId: "global",
        userId: me.id,
        content,
        kind: "gift",
        meta: JSON.stringify({ username: recipientUsername }),
      },
      include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
    });
    io.to("global").emit("chat:message", {
      id: stored.id, channelId: stored.channelId, content: stored.content,
      kind: stored.kind, meta: stored.meta ? JSON.parse(stored.meta) : null,
      createdAt: stored.createdAt, user: stored.user,
    });
  } catch (e) {
    void recordError({
      kind: "server",
      message: "gift_announcement_failed",
      source: "POST /admin/users/:id",
      userId: me.id,
      username: me.username,
      meta: { recipientUsername, error: String((e as Error)?.message ?? e) },
    });
  }
}

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
//
// NOTE ON PRIZES: a reset does NOT hand back prizes this account already
// received. Delivery is recorded in PendingGrant.deliveredAt, which a save
// wipe cannot touch, so a delivered grant stays delivered. Grants still OWED
// at reset time survive and land on the reset account's first upload, which
// is the correct behaviour — they were never paid.
//
// If a reset was a mistake, the way back is the snapshot restore below, not a
// re-grant: creating a second PendingGrant row pays a second time.
app.post("/users/:id/reset-save", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  try {
    const u = await prisma.user.update({
      where: { id },
      data: { saveData: null, saveVersion: 0, accountLevel: 0, totalCaughtLevels: 0, pokedexCaughtCount: 0 },
      select: { id: true, saveVersion: true },
    });
    // Tell the player's open client to drop its LOCAL save and reload —
    // otherwise it would just re-upload its intact copy on the next autosave
    // and silently undo the reset. Offline clients honour the reset on their
    // next boot via the cloud-version-went-backwards check (GameContext).
    try { sendToUserGlobal(id, "save:reset", { reason: "admin_reset" }); } catch { /* socket may be down */ }
    void makeAudit(c)(me.id, "user.reset_save", id);
    return c.json(u);
  } catch {
    return c.json({ error: "user not found" }, 404);
  }
});

// ── User: save history ─────────────────────────────────────────────────
// The append-only checkpoints from lib/saveHistory. Lets an operator see a
// player's recent saved states and roll one back — the recovery path that
// makes an accepted-but-wrong write survivable.

// GET /users/:id/snapshots — list (metadata only; bodies are large).
app.get("/users/:id/snapshots", async (c) => {
  const id = c.req.param("id");
  const rows = await prisma.saveSnapshot.findMany({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, saveVersion: true, reason: true, createdAt: true, saveData: true },
  });
  // Summarise each so the operator can tell them apart without shipping
  // every full blob to the browser.
  const snapshots = rows.map((r) => {
    let summary: { level: number; badges: number; caught: number; money: number; bytes: number } | null = null;
    try {
      const s = JSON.parse(r.saveData) as Record<string, unknown>;
      summary = {
        level: typeof s.playerPokemon === "object" && s.playerPokemon
          ? ((s.playerPokemon as any).level ?? 0) : 0,
        badges: Array.isArray(s.defeatedGyms) ? s.defeatedGyms.length : 0,
        caught: Array.isArray(s.pokedexCaught) ? s.pokedexCaught.length : 0,
        money: typeof s.money === "number" ? s.money : 0,
        bytes: r.saveData.length,
      };
    } catch { /* corrupt snapshot; leave summary null */ }
    return { id: r.id, saveVersion: r.saveVersion, reason: r.reason, createdAt: r.createdAt, summary };
  });
  return c.json({ snapshots });
});

// GET /users/:id/snapshots/:snapshotId — the full save body of one snapshot,
// for inspection/diff before restoring.
app.get("/users/:id/snapshots/:snapshotId", async (c) => {
  const id = c.req.param("id");
  const snapshotId = c.req.param("snapshotId");
  const snap = await prisma.saveSnapshot.findFirst({ where: { id: snapshotId, userId: id } });
  if (!snap) return c.json({ error: "snapshot not found" }, 404);
  let saveData: unknown = null;
  try { saveData = JSON.parse(snap.saveData); } catch { /* return raw below */ }
  return c.json({
    id: snap.id, saveVersion: snap.saveVersion, reason: snap.reason,
    createdAt: snap.createdAt, saveData: saveData ?? snap.saveData,
  });
});

// POST /users/:id/snapshots/:snapshotId/restore — roll the player back to a
// snapshot. Validates the snapshot first, captures the CURRENT save as a
// pre-restore checkpoint (so the restore is undoable), then writes it back
// with a bumped saveVersion so live clients 409 and re-pull rather than
// racing the operator.
app.post("/users/:id/snapshots/:snapshotId/restore", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const snapshotId = c.req.param("snapshotId");

  const snap = await prisma.saveSnapshot.findFirst({ where: { id: snapshotId, userId: id } });
  if (!snap) return c.json({ error: "snapshot not found" }, 404);

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(snap.saveData) as Record<string, unknown>; }
  catch { return c.json({ error: "snapshot is corrupt and cannot be restored" }, 422); }

  const v = validateSave(parsed);
  if (!v.ok) return c.json({ error: "snapshot fails validation", reason: v.reason }, 422);

  const current = await prisma.user.findUnique({
    where: { id },
    select: { saveData: true, saveVersion: true },
  });
  if (!current) return c.json({ error: "user not found" }, 404);

  // Preserve the current state so this restore can itself be reversed.
  if (current.saveData) {
    try { await forceSnapshot(id, current.saveVersion, current.saveData, "pre-restore"); }
    catch { /* best-effort; the restore below is the important part */ }
  }

  const derived = computeAccountLevel(parsed);
  const updated = await prisma.user.update({
    where: { id },
    data: {
      saveData: snap.saveData,
      saveVersion: { increment: 1 },
      // Authoritative rollback — force the client to adopt the restored save
      // wholesale rather than re-uploading its newer local copy over it.
      saveAdoptSeq: { increment: 1 },
      saveUpdatedAt: new Date(),
      accountLevel: derived.accountLevel,
      totalCaughtLevels: derived.totalCaughtLevels,
      pokedexCaughtCount: derived.pokedexCaughtCount,
    },
    select: { id: true, saveVersion: true, accountLevel: true },
  });
  emitSaveAdopt(id);
  void makeAudit(c)(me.id, "user.restore_save", id, {
    snapshotId, snapshotVersion: snap.saveVersion, snapshotTakenAt: snap.createdAt,
  });
  return c.json({ ok: true, ...updated });
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
    | { itemId?: string; quantity?: number; announce?: string }
    | null;
  const itemId = String(body?.itemId ?? "");
  const quantity = Math.floor(Number(body?.quantity ?? -1));
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(itemId)) {
    return c.json({ error: "invalid itemId" }, 400);
  }
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 999_999) {
    return c.json({ error: "quantity must be 0..999999" }, 400);
  }
  const who = await prisma.user.findUnique({ where: { id }, select: { username: true } });
  if (!who) return c.json({ error: "user not found" }, 404);

  // Set the item quantity on the player's LATEST inventory (retry loop rides
  // out a concurrently-autosaving client). Only this item key changes; the
  // rest of the inventory + save is preserved.
  let previousQuantity = 0;
  const result = await patchSaveWithRetry(id, (latest) => {
    const inventory: Record<string, number> = {
      ...((latest.inventory && typeof latest.inventory === "object" && !Array.isArray(latest.inventory))
        ? (latest.inventory as Record<string, number>)
        : {}),
    };
    previousQuantity = Number(inventory[itemId] ?? 0);
    if (quantity === 0) delete inventory[itemId];
    else inventory[itemId] = quantity;
    return { ...latest, inventory };
  });
  if (!result.ok) {
    return c.json(result.reason ? { error: result.error, reason: result.reason } : { error: result.error }, result.status as 400 | 404 | 409 | 500);
  }
  void makeAudit(c)(me.id, "user.set_item", id, { itemId, quantity });
  // Only announce if the quantity actually changed, for the same reason
  // save-patch gates on appliedKeys — a no-op grant shouldn't be able to
  // post an arbitrary "gift" card.
  if (quantity !== previousQuantity) {
    await postGiftAnnouncement(me, body?.announce, who.username);
  }
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

// ── GET /acquisition ────────────────────────────────────────────────
// Where signups come from. Separate from /analytics on purpose: that endpoint
// already fans out to ~25 queries and loads every user's accountLevel into
// memory, and bolting five more GROUP BYs onto it would make the whole page
// wait on a panel most visits do not scroll to. A separate call also means
// the acquisition panel can carry its own loading and error state instead of
// taking the page down with it when the table is not there yet.
//
// ── ON COVERAGE ─────────────────────────────────────────────────────
// Every number here is "of the signups we have attribution for", and that is
// NOT every signup: collection started on a date, and some browsers will drop
// the write. So the response carries both `signups` (everyone who registered
// in the window) and `attributed` (how many we can place). Reporting shares
// without that denominator is how a dashboard ends up confidently claiming
// 100% of traffic is direct.
app.get("/acquisition", async (c) => {
  const days = Math.min(365, Math.max(1, parseInt(c.req.query("days") ?? "30", 10) || 30));
  const since = new Date(Date.now() - days * 86400000);

  // Signups in the window, from User — the denominator, and the only figure
  // here that does not depend on the attribution table existing.
  const signups = await prisma.user.count({ where: { createdAt: { gte: since } } });

  try {
    const where = { createdAt: { gte: since } };
    const [attributed, firstRow, channels, sources, campaigns, landings] = await Promise.all([
      prisma.signupAttribution.count({ where }),
      prisma.signupAttribution.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      prisma.signupAttribution.groupBy({ by: ["channel"], where, _count: { _all: true } }),
      // Grouped WITH the channel so the table can colour each source by how it
      // classified — seeing "reddit.com — referral" would be a bug worth
      // catching, and it is invisible if the channel is dropped here.
      prisma.signupAttribution.groupBy({
        by: ["source", "channel"], where, _count: { _all: true },
        orderBy: { _count: { source: "desc" } }, take: 15,
      }),
      prisma.signupAttribution.groupBy({
        by: ["campaign", "source", "medium"],
        where: { ...where, campaign: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { campaign: "desc" } }, take: 10,
      }),
      prisma.signupAttribution.groupBy({
        by: ["landingPath"],
        where: { ...where, landingPath: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { landingPath: "desc" } }, take: 10,
      }),
    ]);

    return c.json({
      windowDays: days,
      signups,
      attributed,
      collectingSince: firstRow?.createdAt.toISOString() ?? null,
      channels: channels
        .map((r) => ({ channel: r.channel, signups: r._count._all }))
        .sort((a, b) => b.signups - a.signups),
      sources: sources.map((r) => ({ source: r.source, channel: r.channel, signups: r._count._all })),
      campaigns: campaigns.map((r) => ({
        campaign: r.campaign ?? "—", source: r.source, medium: r.medium, signups: r._count._all,
      })),
      landingPages: landings.map((r) => ({ path: r.landingPath ?? "/", signups: r._count._all })),
    });
  } catch (e) {
    // Same tolerance as the DailyActive block above: on a server whose
    // migration has not landed yet, the panel should say "not collecting"
    // rather than 500 the request.
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|no such table|P2021/i.test(msg)) {
      return c.json({
        windowDays: days, signups, attributed: 0, collectingSince: null,
        channels: [], sources: [], campaigns: [], landingPages: [],
      });
    }
    throw e;
  }
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
      include: { user: { select: { id: true, username: true, name: true, isAdmin: true, accountLevel: true } } },
    }),
    // Channel facets — count messages by channelId so the admin sees
    // which channels are noisiest at a glance. Limit to public channels
    // (global + trade + area:*) because DMs leak addressee info.
    prisma.chatMessage.groupBy({
      by: ["channelId"],
      _count: { channelId: true },
      where: {
        OR: [
          { channelId: "global" },
          { channelId: TRADE_CHANNEL },
          { channelId: { startsWith: "area:" } },
        ],
      },
      orderBy: { _count: { channelId: "desc" } },
      take: 12,
    }),
  ]);
  return c.json({
    // meta is stored as a JSON-encoded string column — parse it here the
    // same way the live socket broadcast does (server/src/socket.ts), or
    // every consumer of this route sees a raw string instead of the
    // {offering, wanting} object the shared ChatMessage type promises.
    messages: messages.reverse().map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })),
    channels: channelGroups.map((g) => ({ id: g.channelId, count: g._count.channelId })),
  });
});

// Wipe every message in the public live-chat channels (global + trade
// + any area:*). DMs are intentionally excluded — those are private
// 1-1 conversations between users, not "live chat", and clearing them
// would feel like a privacy violation. After the DB delete we
// broadcast chat:cleared to all connected sockets so live clients
// flush their cached message lists without needing a refresh.
//
// trade MUST be included here: the client (game/src/components/
// MiniChat.tsx's chat:cleared handler) already treats "public" as
// covering global+trade+area:* and flushes its Trade-tab cache on
// this broadcast regardless — leaving trade rows in the DB while the
// UI shows them as cleared meant the "wipe" was cosmetic-only for
// exactly the channel most likely to carry scam/abuse content, and
// the same "cleared" posts would silently reappear on the next reload.
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
        { channelId: TRADE_CHANNEL },
        { channelId: { startsWith: "area:" } },
      ],
    },
  });
  broadcastChatCleared("public");
  void makeAudit(c)(me.id, "chat.clearAll", null, { deleted: result.count });
  return c.json({ ok: true, deleted: result.count });
});

// Server-wide announcement. Lands in the global chat as a real
// ChatMessage authored by the admin who triggered it, but stamped
// kind: "announcement" so the client renders it as a system card
// instead of a personal message. The message persists in the DB so it
// shows up in chat history, audit log, and the moderation page just
// like any other.
app.post("/announce", async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ content?: string }>().catch(() => ({} as { content?: string }));
  const content = (body.content ?? "").trim();
  if (!content) return c.json({ error: "content required" }, 400);
  if (content.length > 500) return c.json({ error: "content too long (max 500)" }, 400);

  // kind: "announcement" — the client renders this as a system card, not
  // a chat bubble from the admin's own account, so content no longer
  // needs the emoji prefix baked in to be recognizable.
  const stored = await prisma.chatMessage.create({
    data: { channelId: "global", userId: me.id, content, kind: "announcement" },
    include: {
      user: { select: { id: true, username: true, name: true, accountLevel: true } },
    },
  });
  const payload = {
    id: stored.id,
    channelId: stored.channelId,
    content: stored.content,
    kind: stored.kind,
    createdAt: stored.createdAt,
    user: stored.user,
  };
  const io = getIo();
  if (io) io.to("global").emit("chat:message", payload);
  void makeAudit(c)(me.id, "chat.announce", null, { length: content.length });
  return c.json({ ok: true, message: payload });
});

// ── Pinned banner (Announcement) ─────────────────────────────────────
// The persistent header banner, distinct from the ephemeral chat
// broadcast above. See prisma/schema.prisma `Announcement`.

// GET /admin/announcements — the live banner plus recent history.
app.get("/announcements", async (c) => {
  const [live, recent] = await Promise.all([
    getLiveAnnouncement(),
    prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  return c.json({
    live: live ? toPublicAnnouncement(live) : null,
    recent: recent.map((a) => ({
      ...toPublicAnnouncement(a),
      active: a.active,
      startsAt: a.startsAt ? a.startsAt.toISOString() : null,
    })),
  });
});

// POST /admin/announcements — publish a banner. Deactivates every other
// row in the same transaction so exactly one is ever live.
app.post("/announcements", async (c) => {
  const me = c.get("user");
  const parsed = AnnouncementInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  const d = parsed.data;

  const href = d.href?.trim() || null;
  if (href && !isValidHref(href)) {
    return c.json({ error: "invalid href", reason: "href must be an https(s) URL or an in-app #route" }, 400);
  }
  const expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
  const startsAt = d.startsAt ? new Date(d.startsAt) : null;
  if (expiresAt && startsAt && expiresAt <= startsAt) {
    return c.json({ error: "expiresAt must be after startsAt" }, 400);
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.announcement.updateMany({ where: { active: true }, data: { active: false } });
    return tx.announcement.create({
      data: {
        type: d.type,
        message: d.message,
        href,
        linkLabel: href ? (d.linkLabel?.trim() || null) : null,
        startsAt,
        expiresAt,
        active: true,
        createdBy: me.id,
      },
    });
  });

  // The banner is already committed. The live broadcast is best-effort — a
  // DB blip on this re-query must not 500 a publish that actually succeeded
  // (the client's own socket-connect push and REST fetch will reconcile).
  try {
    const live = await getLiveAnnouncement();
    broadcastAnnouncement(live ? toPublicAnnouncement(live) : null);
  } catch { /* published; players pick it up on their next connect/fetch */ }
  void makeAudit(c)(me.id, "announcement.publish", created.id, { type: created.type });
  return c.json({ announcement: toPublicAnnouncement(created) });
});

// POST /admin/announcements/clear — take the banner down. Deactivates all
// active rows; safe to call when nothing is live.
app.post("/announcements/clear", async (c) => {
  const me = c.get("user");
  const res = await prisma.announcement.updateMany({ where: { active: true }, data: { active: false } });
  broadcastAnnouncement(null);
  void makeAudit(c)(me.id, "announcement.clear", null, { deactivated: res.count });
  return c.json({ ok: true, deactivated: res.count });
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

// ── POST /chat/bulk-delete ──────────────────────────────────────────
// Delete a named set of messages in one call.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────
// Clearing a spam flood meant clicking a × on thirty rows, each behind its
// own confirm dialog — sixty clicks and thirty audit rows for one incident.
// The only alternative the dashboard offered was "Clear public chat", which
// deletes EVERY message in every public channel. Faced with sixty clicks or
// one big red button, a moderator under pressure presses the button, and the
// whole server's chat history goes with the spammer's.
//
// ── WHY IDS AND NOT A PREDICATE ─────────────────────────────────────
// The endpoint takes explicit ids, never "everything from user X" or
// "everything matching this text". The moderator has the rows on screen and
// has selected them; a server-side predicate would delete rows they never
// saw, evaluated against a table that has moved on since they looked. The
// blast radius should be exactly what was on screen.
app.post("/chat/bulk-delete", async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ ids?: unknown }>().catch(() => ({} as { ids?: unknown }));
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (ids.length === 0) return c.json({ error: "ids required" }, 400);
  // Bounded. This is reached from a checkbox selection over a page of at most
  // 500 rows, so anything larger is a malformed or hostile caller rather than
  // a moderator.
  if (ids.length > 500) return c.json({ error: "too many ids (max 500)" }, 400);

  const result = await prisma.chatMessage.deleteMany({ where: { id: { in: ids } } });
  // ONE audit row for the batch, carrying the ids. Thirty rows saying
  // "chat.delete" would bury every other action taken that hour, and the
  // thing worth auditing is the decision, which was made once.
  void makeAudit(c)(me.id, "chat.bulkDelete", null, {
    requested: ids.length,
    deleted: result.count,
    ids: ids.slice(0, 100),
  });
  return c.json({ ok: true, deleted: result.count });
});

// ── Giveaways ─────────────────────────────────────────────────────────
// PrizeSchema / PrizeListSchema live in lib/giveaway.ts, next to the Prize type
// they bound, so that EVERY route which mints a prize is gated by the same
// numbers. They used to be a private const in this file, and the tournament
// routes below quietly did not use them — see the comment on PrizeSchema for
// what that let through.
// ── Discord settings ────────────────────────────────────────────────
//
// The link-reward prize, editable from the dashboard rather than from the
// environment. Deployment config (BOT_TOKEN, channel ids) stays in env; this
// is promotion CONTENT, which an operator changes as a judgement call and
// needs to be able to see.

// ── Referral programme ──────────────────────────────────────────────
//
// Same reasoning as the link reward directly below: the prizes are promotion
// CONTENT, so they live in the database where the dashboard can show them,
// while nothing about deployment moves here.
//
// `enabled` is the stop button. The programme pays on signup with no
// eligibility gate (a deliberate choice — see lib/referrals.ts), so the
// control against farming is noticing and switching it off, which means the
// switch has to be one click from the numbers that would show it.

app.get("/referral-config", async (c) => {
  const [row, referrals, grants] = await Promise.all([
    prisma.referralConfig.findUnique({ where: { id: "singleton" } }),
    prisma.referral.count(),
    prisma.pendingGrant.count({ where: { source: { startsWith: "referral" } } }),
  ]);
  return c.json({
    // Unconfigured means RUNNING — see getReferralConfig. The panel has to
    // agree with the payout path about that, or an operator reads "off" here
    // while friends are being paid for.
    enabled: row?.enabled ?? true,
    perReferral: row?.perReferral ? parsePrizes(row.perReferral) : [],
    milestone: row?.milestone ? parsePrizes(row.milestone) : [],
    shinyPool: row?.shinyPool ? parsePrizes(row.shinyPool) : [],
    perReferralCap: row?.perReferralCap ?? 10,
    // What it has actually done, next to the switch that stops it.
    totalReferrals: referrals,
    totalGrants: grants,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  });
});

const ReferralConfigBody = z.object({
  enabled: z.boolean(),
  perReferral: PrizeListSchema.optional(),
  milestone: PrizeListSchema.optional(),
  shinyPool: PrizeListSchema.optional(),
  perReferralCap: z.number().int().min(1).max(1000).optional(),
});

app.put("/referral-config", async (c) => {
  const me = c.get("user");
  const parsed = ReferralConfigBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const d = parsed.data;

  // Refuse an undeliverable prize HERE, while an operator is looking at the
  // form — not on the first player who refers somebody, where it becomes a
  // grant silently refused on every save upload forever and invisible to
  // everyone. Same guard, same reason, as giveaway create.
  for (const [name, list] of [
    ["perReferral", d.perReferral], ["milestone", d.milestone], ["shinyPool", d.shinyPool],
  ] as const) {
    if (!list?.length) continue;
    const bad = checkPrizesDeliverable(list);
    if (bad) return c.json({ error: "prize rejected", field: name, reason: bad }, 400);
  }

  // The pool is drawn from as "a random shiny", so anything in it that is not
  // a Pokémon would make that description a lie.
  const notAMon = d.shinyPool?.find((p) => p.kind !== "pokemon");
  if (notAMon) {
    return c.json(
      { error: "bad pool", reason: "The shiny pool holds Pokémon only — money and items belong in the milestone prize." },
      400,
    );
  }

  const existing = await prisma.referralConfig.findUnique({ where: { id: "singleton" } });
  const json = (next: Prize[] | undefined, prev: string | null | undefined) =>
    next ? JSON.stringify(next) : prev ?? null;

  const row = await prisma.referralConfig.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      enabled: d.enabled,
      perReferral: json(d.perReferral, null),
      milestone: json(d.milestone, null),
      shinyPool: json(d.shinyPool, null),
      ...(d.perReferralCap !== undefined ? { perReferralCap: d.perReferralCap } : {}),
      updatedBy: me.username,
    },
    update: {
      enabled: d.enabled,
      perReferral: json(d.perReferral, existing?.perReferral),
      milestone: json(d.milestone, existing?.milestone),
      shinyPool: json(d.shinyPool, existing?.shinyPool),
      ...(d.perReferralCap !== undefined ? { perReferralCap: d.perReferralCap } : {}),
      updatedBy: me.username,
    },
  });

  return c.json({
    enabled: row.enabled,
    perReferral: row.perReferral ? parsePrizes(row.perReferral) : [],
    milestone: row.milestone ? parsePrizes(row.milestone) : [],
    shinyPool: row.shinyPool ? parsePrizes(row.shinyPool) : [],
    perReferralCap: row.perReferralCap,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  });
});

app.get("/discord-config", async (c) => {
  const row = await prisma.discordConfig.findUnique({ where: { id: "singleton" } });
  return c.json({
    // A missing row and a disabled one are the same state — see the migration
    // for why nothing is seeded. The dashboard renders both as "off".
    linkRewardEnabled: row?.linkRewardEnabled ?? false,
    linkReward: row?.linkReward ? parsePrizes(row.linkReward) : [],
    linkRewardSummary: row?.linkReward ? describePrizes(parsePrizes(row.linkReward)) : null,
    ...(await roleThresholds()),
    xp: {
      enabled: row?.xpEnabled ?? false,
      perMessageMin: row?.xpPerMessageMin ?? XP_DEFAULTS.perMessageMin,
      perMessageMax: row?.xpPerMessageMax ?? XP_DEFAULTS.perMessageMax,
      cooldownSec: row?.xpCooldownSec ?? XP_DEFAULTS.cooldownSec,
      ignoredChannels: row?.xpIgnoredChannels ?? "",
    },
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  });
});

const DiscordConfigBody = z.object({
  linkRewardEnabled: z.boolean(),
  // Optional so the toggle can be flipped without re-sending the prize.
  linkReward: PrizeListSchema.optional(),
  // Role thresholds. Bounded generously rather than tightly: the right Ace
  // Trainer bar depends on a level curve that keeps moving, and the max
  // account level in production is already 18,810.
  aceTrainerMinLevel: z.number().int().min(1).max(1_000_000).optional(),
  championMinMatches: z.number().int().min(1).max(10_000).optional(),
  // Community XP. A SEPARATE currency from the game economy — see
  // lib/discordXp.ts. Nothing here can pay out anything the game can see, so
  // the bounds are about sanity rather than about protecting the economy.
  xpEnabled: z.boolean().optional(),
  xpPerMessageMin: z.number().int().min(0).max(1000).optional(),
  xpPerMessageMax: z.number().int().min(0).max(1000).optional(),
  xpCooldownSec: z.number().int().min(0).max(86_400).optional(),
  xpIgnoredChannels: z.string().max(2000).optional(),
});

app.put("/discord-config", async (c) => {
  const me = c.get("user");
  const parsed = DiscordConfigBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // Name the offending field. A bare "invalid body" is what this used to
    // return, and it is unactionable in a dashboard — the operator sees a red
    // box with no indication of which of six inputs it is complaining about.
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join(".") : "body";
    return c.json(
      {
        error: "invalid body",
        reason: `${where}: ${first?.message ?? "invalid"}`,
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  const d = parsed.data;

  // Refuse a prize that can never be delivered, HERE, while an operator is
  // looking at the form — not on the first player who links, where it would
  // become a grant that is silently refused on every save upload forever and
  // is invisible to everyone. Same guard, same reason, as giveaway create.
  if (d.linkReward && d.linkReward.length > 0) {
    const bad = checkPrizesDeliverable(d.linkReward);
    if (bad) return c.json({ error: "prize rejected", reason: bad }, 400);
  }

  // Enabling with no prize configured is a promotion that silently pays
  // nothing — the exact state that looks like a bug to everyone downstream.
  const existing = await prisma.discordConfig.findUnique({ where: { id: "singleton" } });
  const effective = d.linkReward ?? (existing?.linkReward ? parsePrizes(existing.linkReward) : []);
  if (d.linkRewardEnabled && effective.length === 0) {
    return c.json(
      { error: "no prize", reason: "Add at least one prize before turning the reward on." },
      400,
    );
  }

  const linkRewardJson = d.linkReward ? JSON.stringify(d.linkReward) : existing?.linkReward ?? null;
  const row = await prisma.discordConfig.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      linkReward: linkRewardJson,
      linkRewardEnabled: d.linkRewardEnabled,
      // undefined leaves the column NULL, which means "use the env default" —
      // so omitting a threshold is not the same as setting it to zero.
      aceTrainerMinLevel: d.aceTrainerMinLevel,
      championMinMatches: d.championMinMatches,
      xpEnabled: d.xpEnabled ?? false,
      xpPerMessageMin: d.xpPerMessageMin,
      xpPerMessageMax: d.xpPerMessageMax,
      xpCooldownSec: d.xpCooldownSec,
      xpIgnoredChannels: d.xpIgnoredChannels,
      updatedBy: me.username,
    },
    update: {
      linkReward: linkRewardJson,
      linkRewardEnabled: d.linkRewardEnabled,
      ...(d.aceTrainerMinLevel !== undefined ? { aceTrainerMinLevel: d.aceTrainerMinLevel } : {}),
      ...(d.championMinMatches !== undefined ? { championMinMatches: d.championMinMatches } : {}),
      ...(d.xpEnabled !== undefined ? { xpEnabled: d.xpEnabled } : {}),
      ...(d.xpPerMessageMin !== undefined ? { xpPerMessageMin: d.xpPerMessageMin } : {}),
      ...(d.xpPerMessageMax !== undefined ? { xpPerMessageMax: d.xpPerMessageMax } : {}),
      ...(d.xpCooldownSec !== undefined ? { xpCooldownSec: d.xpCooldownSec } : {}),
      ...(d.xpIgnoredChannels !== undefined ? { xpIgnoredChannels: d.xpIgnoredChannels } : {}),
      updatedBy: me.username,
    },
  });

  void makeAudit(c)(me.id, "discord.config_update", null, {
    linkRewardEnabled: row.linkRewardEnabled,
    aceTrainerMinLevel: row.aceTrainerMinLevel,
    championMinMatches: row.championMinMatches,
    linkReward: row.linkReward ? describePrizes(parsePrizes(row.linkReward)) : null,
  });

  return c.json({
    linkRewardEnabled: row.linkRewardEnabled,
    linkReward: row.linkReward ? parsePrizes(row.linkReward) : [],
    linkRewardSummary: row.linkReward ? describePrizes(parsePrizes(row.linkReward)) : null,
    ...(await roleThresholds()),
    xp: {
      enabled: row.xpEnabled,
      perMessageMin: row.xpPerMessageMin ?? XP_DEFAULTS.perMessageMin,
      perMessageMax: row.xpPerMessageMax ?? XP_DEFAULTS.perMessageMax,
      cooldownSec: row.xpCooldownSec ?? XP_DEFAULTS.cooldownSec,
      ignoredChannels: row.xpIgnoredChannels ?? "",
    },
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  });
});

// ── Discord: stats + linked accounts ────────────────────────────────
//
// Everything the dashboard's Discord page needs, in ONE round trip. It is a
// page of counters, and issuing a dozen requests to fill it would make the
// page's load time the sum of a dozen latencies for no benefit — none of these
// counts is expensive and none is independently useful.
//
// Every figure here is derived, not stored. There is no Discord analytics
// table and there should not be: the link rows, the grant ledger and the bug
// reports already know all of this, and a denormalised counter would be one
// more thing that can silently disagree with them.

app.get("/discord-stats", async (c) => {
  const now = new Date();
  const { aceTrainerMinLevel, championMinMatches } = await roleThresholds();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const visible = { OR: [{ bannedUntil: null }, { bannedUntil: { lt: now } }] };

  const [
    cfg,
    linksTotal, links24h, links7d,
    aceEligible, topRating,
    rewardsGranted, rewardsDelivered,
    discordGiveaways, discordEntries,
    bugsFromDiscord, bugsOpenFromDiscord,
    tradeListings,
    xpMembers, xpAgg, xpTop,
  ] = await Promise.all([
    prisma.discordConfig.findUnique({ where: { id: "singleton" } }),
    prisma.discordLink.count(),
    prisma.discordLink.count({ where: { linkedAt: { gte: dayAgo } } }),
    prisma.discordLink.count({ where: { linkedAt: { gte: weekAgo } } }),
    // Ace Trainer eligibility across LINKED accounts only — the role can only
    // ever be granted to someone in the server, so counting the whole player
    // base would overstate it.
    prisma.discordLink.count({
      where: { user: { accountLevel: { gte: aceTrainerMinLevel }, ...visible } },
    }),
    prisma.playerRating.findFirst({
      where: { matchesPlayed: { gte: championMinMatches } },
      orderBy: [{ rating: "desc" }, { matchesPlayed: "desc" }],
      select: { userId: true, rating: true },
    }),
    prisma.pendingGrant.count({ where: { source: LINK_REWARD_SOURCE } }),
    prisma.pendingGrant.count({ where: { source: LINK_REWARD_SOURCE, deliveredAt: { not: null } } }),
    prisma.giveaway.count({ where: { announceToDiscord: true } }),
    prisma.giveawayEntry.count({ where: { giveaway: { announceToDiscord: true } } }),
    prisma.bugReport.count({ where: { source: "discord" } }),
    prisma.bugReport.count({ where: { source: "discord", status: "open" } }),
    prisma.chatMessage.count({ where: { kind: "tradeOffer", createdAt: { gte: weekAgo } } }),
    prisma.discordXp.count(),
    prisma.discordXp.aggregate({ _sum: { xp: true, messages: true } }),
    prisma.discordXp.findFirst({ orderBy: { xp: "desc" }, select: { label: true, xp: true } }),
  ]);

  const championUser = topRating
    ? await prisma.user.findUnique({ where: { id: topRating.userId }, select: { username: true } })
    : null;
  const championLinked = topRating
    ? !!(await prisma.discordLink.findUnique({ where: { userId: topRating.userId }, select: { discordId: true } }))
    : false;

  let botStatus: unknown = null;
  try { botStatus = cfg?.botStatus ? JSON.parse(cfg.botStatus) : null; } catch { botStatus = null; }

  return c.json({
    bot: {
      lastSeenAt: cfg?.botLastSeenAt?.toISOString() ?? null,
      status: botStatus,
    },
    links: { total: linksTotal, last24h: links24h, last7d: links7d },
    roles: {
      // Trainer goes to every linked, unbanned account, so its count IS the
      // link count. Stated rather than queried separately so the page cannot
      // show two numbers that disagree.
      trainer: linksTotal,
      aceTrainer: aceEligible,
      aceTrainerMinLevel,
      championMinMatches,
      champion: championUser?.username ?? null,
      // The dashboard needs to distinguish "nobody qualifies" from "the person
      // who qualifies has not linked" — they look identical from the outside
      // and have completely different fixes.
      championLinked,
    },
    reward: {
      enabled: cfg?.linkRewardEnabled ?? false,
      summary: cfg?.linkReward ? describePrizes(parsePrizes(cfg.linkReward)) : null,
      granted: rewardsGranted,
      delivered: rewardsDelivered,
      pending: Math.max(0, rewardsGranted - rewardsDelivered),
    },
    giveaways: { announced: discordGiveaways, entries: discordEntries },
    bugReports: { total: bugsFromDiscord, open: bugsOpenFromDiscord },
    trade: { listings7d: tradeListings },
    xp: {
      members: xpMembers,
      totalXp: xpAgg._sum.xp ?? 0,
      totalMessages: xpAgg._sum.messages ?? 0,
      // Level is derived, never stored — one number is one source of truth.
      topLabel: xpTop?.label ?? null,
      topLevel: xpTop ? levelFromXp(xpTop.xp).level : 0,
    },
  });
});

// The linked accounts themselves, newest first. Paginated because this grows
// with the Discord server rather than with the player base, but it still grows.
app.get("/discord-links", async (c) => {
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10));
  const q = (c.req.query("q") ?? "").trim();

  const where = q
    ? { OR: [{ discordId: { contains: q } }, { user: { username: { contains: q, mode: "insensitive" as const } } }] }
    : {};

  const [rows, total] = await Promise.all([
    prisma.discordLink.findMany({
      where,
      orderBy: { linkedAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        discordId: true,
        linkedAt: true,
        user: { select: { id: true, username: true, accountLevel: true, lastSeenAt: true, bannedUntil: true } },
      },
    }),
    prisma.discordLink.count({ where }),
  ]);

  const now = new Date();
  return c.json({
    total,
    links: rows.map((r) => ({
      discordId: r.discordId,
      linkedAt: r.linkedAt.toISOString(),
      userId: r.user.id,
      username: r.user.username,
      accountLevel: r.user.accountLevel,
      lastSeenAt: r.user.lastSeenAt.toISOString(),
      // Surfaced because a banned linked account holds NO managed roles, and
      // an operator wondering why someone lost Trainer needs to see this
      // without opening another page.
      banned: !!r.user.bannedUntil && r.user.bannedUntil > now,
    })),
  });
});

// Bind a Discord account to a game account from the dashboard.
//
// The support path. A player who cannot finish /link — DMs closed AND the
// ephemeral fallback missed, a code that expired mid-deploy, a Discord account
// they have since lost access to — otherwise has no route to a linked account
// at all, and every reward and role behind linking stays shut to them.
//
// Deliberately NOT a shortcut around the code flow for ordinary use. It writes
// an audit row naming the admin who did it, because binding one person's
// Discord identity to another person's game account is exactly the action you
// want attributable afterwards.
//
// Both conflicts are reported rather than silently overwritten: an admin who
// meant to move a link must unlink first, so the destructive half of a move is
// never implicit in the constructive half.
app.post("/discord-links", async (c) => {
  const me = c.get("user");
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      // A snowflake, not an arbitrary string: this ends up in Discord API
      // paths and in a primary key.
      discordId: z.string().regex(/^\d{15,25}$/, "must be a Discord user id"),
      username: z.string().min(1).max(64),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", reason: parsed.error.issues[0]?.message }, 400);
  }
  const { discordId, username } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true },
  });
  if (!user) return c.json({ error: "not_found", reason: "No player with that username." }, 404);

  const byDiscord = await prisma.discordLink.findUnique({ where: { discordId } });
  if (byDiscord) {
    return c.json(
      { error: "discord_already_linked", reason: "That Discord account is already linked. Unlink it first." },
      409,
    );
  }
  const byUser = await prisma.discordLink.findUnique({ where: { userId: user.id } });
  if (byUser) {
    return c.json(
      { error: "account_already_linked", reason: "That player is already linked. Unlink them first." },
      409,
    );
  }

  try {
    await prisma.discordLink.create({ data: { discordId, userId: user.id } });
  } catch (e) {
    // The checks above are for the error message; the constraints are the
    // guard. Same reasoning as lib/discordLink.ts.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return c.json({ error: "already_linked", reason: "Already linked — refresh and check." }, 409);
    }
    throw e;
  }

  void makeAudit(c)(me.id, "discord.link", user.id, { discordId, username: user.username });

  // No link reward. grantLinkReward is for a player completing the flow; paying
  // it out of an admin action would make the promotion something support can
  // hand out, and would fire on every repair of a link that already claimed it.
  return c.json({ ok: true, discordId, username: user.username });
});

// Sever a link from the dashboard. The player-facing paths are /unlink in
// Discord and the account settings on the site; this is the moderation one,
// for a binding that needs removing without the account holder's cooperation.
app.delete("/discord-links/:discordId", async (c) => {
  const me = c.get("user");
  const discordId = c.req.param("discordId");
  const existing = await prisma.discordLink.findUnique({
    where: { discordId },
    select: { userId: true },
  });
  const res = await prisma.discordLink.deleteMany({ where: { discordId } });
  if (res.count > 0) {
    void makeAudit(c)(me.id, "discord.unlink", existing?.userId ?? null, { discordId });
  }
  // Idempotent: unlinking something already unlinked is not an error.
  return c.json({ ok: true, removed: res.count > 0 });
});

const GiveawayBody = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  winnerCount: z.number().int().min(1).max(100),
  prizes: PrizeListSchema,
  minAccountLevel: z.number().int().min(0).max(10_000).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  // Post this giveaway in the community Discord. A flag the BOT polls for —
  // the game server never talks to Discord itself. See the field comments on
  // the Giveaway model.
  announceToDiscord: z.boolean().optional(),
  // Optional channel override; null/absent uses the bot's configured default.
  // Bounded and digits-only because it is a snowflake, and an unbounded string
  // here would be passed straight to a Discord API path.
  discordChannelId: z.string().regex(/^\d{5,32}$/).nullable().optional(),
});

app.get("/giveaways", async (c) => {
  const rows = await prisma.giveaway.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { entries: { select: { id: true, userId: true, username: true, isWinner: true, claimedAt: true } } },
  });
  // `claimedAt` no longer means "the prize is in their save" — it means the
  // PendingGrant row is committed, i.e. durably OWED. Those are different
  // states and the operator's decision differs between them: an owed prize
  // must NOT be re-granted (it will land on the winner's next upload; a second
  // grant pays twice), while a genuinely un-granted winner still needs paying
  // by hand. Join the inbox so the dashboard can say which is which instead of
  // printing "UNPAID" for a prize that is guaranteed.
  // BOTH sources. A giveaway drawn from the Discord bot stamps its grants
  // "discord" (so the ops sweep can tell them apart); one drawn here stamps
  // "giveaway". Filtering on "giveaway" alone made every bot-drawn giveaway
  // show its winners as never delivered, which is the exact wrong direction
  // for this flag to be wrong in — it steers an operator toward re-granting a
  // prize that already landed.
  const grants = rows.length === 0 ? [] : await prisma.pendingGrant.findMany({
    where: { source: { in: ["giveaway", "discord"] }, sourceId: { in: rows.map((g) => g.id) } },
    select: { userId: true, sourceId: true, deliveredAt: true },
  });
  const deliveredKeys = new Set<string>();
  for (const gr of grants) {
    if (gr.deliveredAt !== null) deliveredKeys.add(`${gr.sourceId}:${gr.userId}`);
  }
  return c.json({
    giveaways: rows.map((g) => ({
      ...g,
      entries: g.entries.map((e) => ({
        ...e,
        // true = physically folded into their saveData. false with claimedAt
        // set = owed and safe; do not re-grant.
        prizeDelivered: deliveredKeys.has(`${g.id}:${e.userId}`),
      })),
      prizes: parsePrizes(g.prizes),
      prizeSummary: describePrizes(parsePrizes(g.prizes)),
      entryCount: g.entries.length,
    })),
  });
});

// ── Pending grants (the prize inbox) ─────────────────────────────────
// Read-only ops window onto lib/prizeGrant.ts's PendingGrant queue: what the
// server still owes, and what it has already handed over.
//
// This exists because "granted" no longer means "in their save this instant".
// A grant is a durable row that the player's next save upload absorbs, so a
// prize can legitimately sit here for as long as the player stays away. Ops
// needs to be able to tell that apart from a prize that is STUCK — `attempts`
// climbing with a `lastError` means the fold keeps being refused (a Pokémon
// prize into a full box, say), and that one does need a human.
//
// Do not re-grant a row that shows deliveredAt, ever: a second grant is a
// second row and pays twice. That column is the delivery gate itself — it is
// set under a `deliveredAt IS NULL` compare-and-swap inside the transaction
// that stores the folded save — so a row that shows it was paid exactly once.
//
// There is no re-delivery and there must not be one: the server cannot tell
// "never received it" from "received it and spent it", so anything that
// re-pays a fungible prize is an exploit. What protects the prize instead is
// that the fold bumps saveAdoptSeq, so every session of that account adopts
// the cloud copy holding it rather than overwriting it.
//
// How to read a row:
//   * deliveredAt null, attempts climbing with a lastError → STUCK. The fold
//     keeps refusing it (a Pokémon prize into a full box, say). Needs a human.
//   * deliveredAt null, attempts 0 → simply unclaimed. The player has not
//     loaded the game since — or is still on a pre-`grantAck` client, which is
//     never delivered to. Nothing to do.
//   * deliveredAt set → done.
// ── Auctions (read-only ops window) ──────────────────────────────────
// Exists because auction rows hold the ONLY copy of a sold Pokemon between
// escrow and delivery: the mon is removed from the seller's save at listing
// and exists solely as Auction.pokemonSnapshot until the winner's save
// absorbs it. When delivery goes wrong (naill's shiny Nidoran), this is the
// one place the lost mon can be recovered from — there was previously no way
// to read it without a database console.
app.get("/auctions", async (c) => {
  const status = (c.req.query("status") ?? "").trim();
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") ?? "50", 10)));
  const rows = await prisma.auction.findMany({
    where: status ? { status } : {},
    orderBy: { endsAt: "desc" },
    take: limit,
  });
  const out = rows.filter((r) => {
    if (!q) return true;
    // An item lot has no snapshot; its searchable text is the item id, which
    // is also the only thing an admin would type ("tm24").
    return (
      (r.pokemonSnapshot ?? "").toLowerCase().includes(q) ||
      (r.itemId ?? "").toLowerCase().includes(q) ||
      r.sellerId.toLowerCase().includes(q) ||
      (r.currentBidderId ?? "").toLowerCase().includes(q)
    );
  });
  return c.json({ auctions: out });
});

app.get("/pending-grants", async (c) => {
  const url = new URL(c.req.url);
  const userId = url.searchParams.get("userId");
  const includeDelivered = url.searchParams.get("includeDelivered") === "1";
  const rows = await prisma.pendingGrant.findMany({
    where: {
      ...(userId ? { userId } : {}),
      ...(includeDelivered ? {} : { deliveredAt: null }),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { user: { select: { username: true } } },
  });
  return c.json({
    grants: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      username: r.user?.username ?? null,
      source: r.source,
      sourceId: r.sourceId,
      summary: r.summary,
      createdAt: r.createdAt,
      deliveredAt: r.deliveredAt,
      deliveredSaveVersion: r.deliveredSaveVersion,
      attempts: r.attempts,
      lastError: r.lastError,
    })),
    owed: rows.filter((r) => r.deliveredAt === null).length,
  });
});

app.post("/giveaways", async (c) => {
  const me = c.get("user");
  const parsed = GiveawayBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  const d = parsed.data;
  // Fail here, not at draw time. PrizeSchema leaves a Pokémon prize's `mon` an
  // opaque record; an unfoldable one would otherwise be discovered only when
  // the draw enqueues it for every winner, and then refused on every upload
  // forever while the dashboard shows those winners as paid.
  const badPrize = checkPrizesDeliverable(d.prizes);
  if (badPrize) return c.json({ error: "prize rejected", reason: badPrize }, 400);
  const g = await prisma.giveaway.create({
    data: {
      title: d.title,
      description: d.description,
      winnerCount: d.winnerCount,
      prizes: JSON.stringify(d.prizes),
      minAccountLevel: d.minAccountLevel ?? null,
      startsAt: d.startsAt ? new Date(d.startsAt) : null,
      endsAt: d.endsAt ? new Date(d.endsAt) : null,
      status: "draft",
      ownerId: me.id,
      announceToDiscord: d.announceToDiscord ?? false,
      discordChannelId: d.discordChannelId ?? null,
    },
  });
  void makeAudit(c)(me.id, "giveaway.create", g.id, { title: g.title, winnerCount: g.winnerCount });
  return c.json({ giveaway: g });
});

// Status transitions. Same forward-only discipline as tournaments —
// walking a drawn giveaway back to open would let an operator re-draw
// and quietly change who won, which is exactly the thing the seed
// exists to make impossible.
const GIVEAWAY_NEXT: Record<string, string[]> = {
  draft:     ["open", "cancelled"],
  open:      ["closed", "cancelled"],
  closed:    ["open", "drawn", "cancelled"],   // reopening entries is fine BEFORE a draw
  drawn:     [],                                // terminal — winners are final
  cancelled: [],
};

// endsAt (and startsAt) must go through the same z.string().datetime()
// check the create route already uses — that rejects any string without
// an explicit Z/offset. Without it, new Date("2026-07-24T18:00:00") (no
// Z) parses as SERVER-LOCAL time, not UTC — dormant today only because
// nothing currently sends this field in a PATCH and the deployed host
// happens to run UTC, but a landmine for any future "edit deadline" UI
// wiring a plain datetime-local input straight into this field.
const GiveawayPatchBody = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  status: z.string().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

app.patch("/giveaways/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const parsed = GiveawayPatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const body = parsed.data;

  const current = await prisma.giveaway.findUnique({ where: { id }, select: { status: true } });
  if (!current) return c.json({ error: "giveaway not found" }, 404);

  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title;
  if (typeof body.description === "string") data.description = body.description;
  if (body.startsAt !== undefined) data.startsAt = body.startsAt ? new Date(body.startsAt) : null;
  if (body.endsAt !== undefined) data.endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (body.status !== undefined && body.status !== current.status) {
    const allowed = GIVEAWAY_NEXT[current.status] ?? [];
    if (!allowed.includes(body.status)) {
      return c.json({
        error: "illegal status transition",
        reason: `A giveaway cannot go from "${current.status}" to "${body.status}".`
          + (allowed.length ? ` Allowed: ${allowed.join(", ")}.` : ` "${current.status}" is final.`),
        from: current.status, to: body.status, allowed,
      }, 409);
    }
    data.status = body.status;
  }

  let g;
  if (data.status !== undefined) {
    // A status transition specifically needs the same TOCTOU guard the
    // draw endpoint uses below: two overlapping PATCH requests (a
    // double-click, two admin tabs, a client retry) can both read the
    // same current.status and both decide to write "open" — without
    // this, both would ALSO independently pass the chat-announcement
    // gate further down, posting a duplicate system card. The where
    // clause makes only one of them actually perform the write.
    const claimed = await prisma.giveaway.updateMany({ where: { id, status: current.status }, data });
    if (claimed.count === 0) {
      return c.json({
        error: "conflict",
        reason: "This giveaway's status changed under you — reload and try again.",
      }, 409);
    }
    g = await prisma.giveaway.findUniqueOrThrow({ where: { id } });
  } else {
    g = await prisma.giveaway.update({ where: { id }, data });
  }
  void makeAudit(c)(me.id, "giveaway.update", id, data);

  // A giveaway going live is easy to miss — nothing else in the game
  // told a player one existed until they happened to open the
  // Giveaways panel on their own. Announce it in chat the same way a
  // draw result already is, so it's actually discoverable. Only fires
  // on a genuine transition INTO "open" (data.status is only set above
  // when body.status !== current.status), and only for the one request
  // that actually won the updateMany claim above.
  if (data.status === "open") {
    try {
      const io = getIo();
      if (io) {
        const prizes = parsePrizes(g.prizes);
        // Capped like /announce's own content — describePrizes() on a
        // max-length title + 10 max-length prizes can run past 900
        // chars with nothing to truncate it client-side otherwise.
        const raw = `"${g.title}" just opened — ${describePrizes(prizes)} for ${g.winnerCount} winner${g.winnerCount === 1 ? "" : "s"}!`;
        const content = raw.length > 400 ? raw.slice(0, 399) + "…" : raw;
        const stored = await prisma.chatMessage.create({
          data: {
            channelId: "global",
            userId: me.id,
            content,
            kind: "giveawayOpen",
            // Carries the giveaway id so "View Giveaway" can scroll to
            // and highlight the right one — openGiveaways() otherwise
            // just opens an undifferentiated list, confusing if more
            // than one giveaway happens to be open at once.
            meta: JSON.stringify({ giveawayId: g.id }),
          },
          include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
        });
        io.to("global").emit("chat:message", {
          id: stored.id, channelId: stored.channelId, content: stored.content,
          kind: stored.kind, meta: stored.meta ? JSON.parse(stored.meta) : null,
          createdAt: stored.createdAt, user: stored.user,
        });
      }
    } catch (e) {
      // Never fail the actual status change for a broadcast that's a
      // nice-to-have — but do record it, or a failure here silently
      // defeats the whole point of this feature with zero signal
      // anywhere an operator would think to look.
      void recordError({
        kind: "server",
        message: "giveaway.open_announcement_failed",
        source: "PATCH /admin/giveaways/:id",
        userId: me.id,
        username: me.username,
        meta: { giveawayId: id, error: String((e as Error)?.message ?? e) },
      });
    }
  }

  return c.json({ giveaway: g });
});

app.delete("/giveaways/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const g = await prisma.giveaway.findUnique({ where: { id }, select: { drawnAt: true } });
  if (!g) return c.json({ error: "giveaway not found" }, 404);
  // Deleting a drawn giveaway erases the public record of who won and
  // the seed that proves it was fair. Refuse — cancel instead.
  if (g.drawnAt) {
    return c.json({
      error: "cannot delete a drawn giveaway",
      reason: "Winners and the fairness seed are a public record. Deleting it would erase the proof the draw was fair.",
    }, 409);
  }
  await prisma.giveaway.delete({ where: { id } });
  void makeAudit(c)(me.id, "giveaway.delete", id);
  return c.json({ ok: true });
});

// ── The draw ────────────────────────────────────────────────────────
// Picks winners deterministically from a stored seed, then grants the
// prizes straight into the winners' saves.
//
// The implementation lives in lib/giveawayDraw.ts so this manual
// endpoint and the automatic endsAt sweep run the exact same code —
// including the atomic compare-and-swap that makes a concurrent draw
// (two operators, a retry, or a sweep tick landing mid-click) grant
// nothing. This handler is only the HTTP shell around it.
app.post("/giveaways/:id/draw", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const res = await drawGiveaway(id, { id: me.id, viaApiKey: c.get("viaApiKey") });
  if (!res.ok) {
    return c.json(
      res.reason ? { error: res.error, reason: res.reason } : { error: res.error },
      res.status ?? 500,
    );
  }
  return c.json({
    ok: true,
    giveaway: res.giveaway,
    seed: res.seed,
    winners: res.granted,
    entryCount: res.entryCount,
  });
});

// ── Mass gift ────────────────────────────────────────────────────────
// Direct grant (not an opt-in raffle) of any item / money / Pokémon to a
// whole audience at once: everyone online right now, every account, or a
// hand-picked set. Reuses enqueuePrizeGrant, so every recipient gets a durable
// PendingGrant row rather than a racy direct save write; the prize is folded
// into their save (and validated there) by POST /api/saves the next time their
// client uploads — within ~2.5s for someone playing, on next load for someone
// offline. Delivery is exactly-once whether they are online or not, which is
// what the old direct-write path could not promise. See lib/prizeGrant.ts.
const MassGiftBody = z.object({
  audience: z.enum(["all", "online", "selected"]),
  userIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(5000).optional(),
  prizes: PrizeListSchema,
  announce: z.string().max(300).optional(),
  minAccountLevel: z.number().int().min(0).max(100_000).nullable().optional(),
});

app.post("/mass-gift", async (c) => {
  const me = c.get("user");
  const parsed = MassGiftBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  const d = parsed.data;

  // Reject an undeliverable prize NOW, while the operator is still looking at
  // the form. PrizeSchema bounds a Pokémon prize as an opaque record, so a
  // malformed mon (level 105, a broken moves array) parses fine here and is
  // then refused by the fold on every single upload, forever, for every
  // recipient — invisible to the operator, who was told it went out. The
  // grants below are enqueued in the BACKGROUND, so this is the last point
  // where a bad prize can still be reported synchronously.
  const badPrize = checkPrizesDeliverable(d.prizes);
  if (badPrize) return c.json({ error: "prize rejected", reason: badPrize }, 400);

  // Resolve the audience to a concrete, de-duplicated recipient list.
  let userIds: string[];
  if (d.audience === "selected") {
    if (!d.userIds || d.userIds.length === 0) return c.json({ error: "no users selected" }, 400);
    userIds = d.userIds;
  } else if (d.audience === "online") {
    userIds = liveOnlineSnapshot().map((u) => u.userId);
  } else {
    const rows = await prisma.user.findMany({ select: { id: true } });
    userIds = rows.map((r) => r.id);
  }
  if (d.minAccountLevel != null && userIds.length > 0) {
    const eligible = await prisma.user.findMany({
      where: { id: { in: userIds.slice(0, 5000) }, accountLevel: { gte: d.minAccountLevel } },
      select: { id: true },
    });
    userIds = eligible.map((r) => r.id);
  }
  userIds = Array.from(new Set(userIds));
  const recipientCount = userIds.length;
  if (recipientCount === 0) return c.json({ error: "no recipients matched" }, 400);

  void makeAudit(c)(me.id, "mass_gift", null, {
    audience: d.audience, recipientCount, prizes: describePrizes(d.prizes),
  });

  // Optional Global chat announcement, rendered as the same gift system card
  // players already know from admin gifts.
  //
  // Global-audience gifts ONLY. A "selected" gift's announce used to post to
  // global chat too, so a personal restitution written in the second person
  // ("the shiny Nidoran YOU won at auction...") pinged all 2,300 players, and
  // chat immediately filled with "did everyone get this? where's my poke?".
  // A targeted gift already announces itself to the right person — the prize
  // label renders in their delivery toast — so the room does not need to know.
  if (d.audience !== "selected" && d.announce && d.announce.trim()) {
    try {
      const io = getIo();
      if (io) {
        const stored = await prisma.chatMessage.create({
          data: { channelId: "global", userId: me.id, content: d.announce.trim().slice(0, 300), kind: "gift" },
          include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
        });
        io.to("global").emit("chat:message", {
          id: stored.id, channelId: stored.channelId, content: stored.content,
          kind: stored.kind, meta: null, createdAt: stored.createdAt, user: stored.user,
        });
      }
    } catch { /* announcement is best-effort */ }
  }

  // Grant in the background so a big audience (up to every account) can't time
  // the request out. Serial, not fan-out — the same connection-ceiling
  // discipline the auction settlement loop uses. Each recipient's failure is
  // isolated so one corrupt save can't stop the batch.
  void (async () => {
    let ok = 0, fail = 0;
    for (const uid of userIds) {
      try {
        // Durable inbox, not a save write — see lib/prizeGrant.ts. The prize
        // is folded into the recipient's save by POST /api/saves on top of
        // whatever their client uploads, so an ONLINE recipient's next
        // autosave can no longer overwrite it (which is exactly how giveaway
        // prizes were being destroyed). enqueuePrizeGrant emits the
        // `gift:pending` nudge itself; there is no separate socket step here
        // any more, and nothing depends on that emit arriving.
        await enqueuePrizeGrant(uid, d.prizes, { source: "mass-gift", sourceId: null });
        ok++;
      } catch {
        fail++;
      }
    }
    void recordError({
      kind: "server", level: "warn", message: "mass_gift.complete",
      source: "POST /admin/mass-gift", userId: me.id, username: me.username,
      meta: { audience: d.audience, recipientCount, ok, fail, prizes: describePrizes(d.prizes) },
    });
  })();

  return c.json({ started: true, recipientCount });
});

// ── Polls ────────────────────────────────────────────────────────────
// Admin-created, posted to Global chat for players to vote on directly
// from the chat card. Unlike a Giveaway (one entry, drawn once), a poll
// is live opinion data: a vote can change any time before close, and
// results are public + update in real time — see schema.prisma's Poll
// doc comment.
app.get("/polls", async (c) => {
  const rows = await prisma.poll.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { votes: { select: { id: true, userId: true, username: true, optionIndex: true, updatedAt: true } } },
  });
  return c.json({
    polls: rows.map((p) => ({
      ...p,
      options: JSON.parse(p.options) as string[],
      voteCount: p.votes.length,
    })),
  });
});

const PollBody = z.object({
  question: z.string().min(1).max(280),
  options: z.array(z.string().min(1).max(80)).min(2).max(10),
});

app.post("/polls", async (c) => {
  const me = c.get("user");
  const parsed = PollBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  const d = parsed.data;
  const p = await prisma.poll.create({
    data: {
      question: d.question,
      options: JSON.stringify(d.options),
      status: "draft",
      ownerId: me.id,
    },
  });
  void makeAudit(c)(me.id, "poll.create", p.id, { question: p.question });
  return c.json({ poll: { ...p, options: d.options, voteCount: 0 } });
});

// draft -> open -> closed. Forward-only, same reasoning as giveaways:
// walking a closed poll back to open after results are public would let
// an operator quietly re-solicit votes on a question people already saw
// resolved.
const POLL_NEXT: Record<string, string[]> = {
  draft:  ["open", "closed"],
  open:   ["closed"],
  closed: [],
};

const PollPatchBody = z.object({
  question: z.string().min(1).max(280).optional(),
  options: z.array(z.string().min(1).max(80)).min(2).max(10).optional(),
  status: z.string().optional(),
});

app.patch("/polls/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const parsed = PollPatchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  const body = parsed.data;

  const current = await prisma.poll.findUnique({ where: { id }, select: { status: true } });
  if (!current) return c.json({ error: "poll not found" }, 404);

  // Editing the question/options after it has ever gone live would let
  // an operator quietly change what people already voted on — only a
  // draft may be edited.
  if ((body.question !== undefined || body.options !== undefined) && current.status !== "draft") {
    return c.json({ error: "cannot edit question/options once a poll has opened" }, 409);
  }

  const data: Record<string, unknown> = {};
  if (typeof body.question === "string") data.question = body.question;
  if (body.options !== undefined) data.options = JSON.stringify(body.options);
  if (body.status !== undefined && body.status !== current.status) {
    const allowed = POLL_NEXT[current.status] ?? [];
    if (!allowed.includes(body.status)) {
      return c.json({
        error: "illegal status transition",
        reason: `A poll cannot go from "${current.status}" to "${body.status}".`
          + (allowed.length ? ` Allowed: ${allowed.join(", ")}.` : ` "${current.status}" is final.`),
        from: current.status, to: body.status, allowed,
      }, 409);
    }
    data.status = body.status;
    if (body.status === "closed") data.closedAt = new Date();
  }

  let p;
  if (data.status !== undefined) {
    // Same TOCTOU guard as the giveaway status transition above — two
    // overlapping PATCH requests must not both win the "open" transition
    // and both post a duplicate chat announcement.
    const claimed = await prisma.poll.updateMany({ where: { id, status: current.status }, data });
    if (claimed.count === 0) {
      return c.json({ error: "conflict", reason: "This poll's status changed under you — reload and try again." }, 409);
    }
    p = await prisma.poll.findUniqueOrThrow({ where: { id } });
  } else {
    p = await prisma.poll.update({ where: { id }, data });
  }
  void makeAudit(c)(me.id, "poll.update", id, data);

  if (data.status === "open") {
    try {
      const io = getIo();
      if (io) {
        const options = JSON.parse(p.options) as string[];
        const raw = `"${p.question}" — vote now! (${options.length} options)`;
        const content = raw.length > 400 ? raw.slice(0, 399) + "…" : raw;
        const stored = await prisma.chatMessage.create({
          data: {
            channelId: "global",
            userId: me.id,
            content,
            kind: "pollOpen",
            meta: JSON.stringify({ pollId: p.id }),
          },
          include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
        });
        io.to("global").emit("chat:message", {
          id: stored.id, channelId: stored.channelId, content: stored.content,
          kind: stored.kind, meta: stored.meta ? JSON.parse(stored.meta) : null,
          createdAt: stored.createdAt, user: stored.user,
        });
      }
    } catch (e) {
      void recordError({
        kind: "server",
        message: "poll.open_announcement_failed",
        source: "PATCH /admin/polls/:id",
        userId: me.id,
        username: me.username,
        meta: { pollId: id, error: String((e as Error)?.message ?? e) },
      });
    }
  }

  const votes = await prisma.pollVote.findMany({ where: { pollId: id }, select: { userId: true, username: true, optionIndex: true } });
  return c.json({ poll: { ...p, options: JSON.parse(p.options), voteCount: votes.length, votes } });
});

app.delete("/polls/:id", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const p = await prisma.poll.findUnique({ where: { id }, select: { status: true } });
  if (!p) return c.json({ error: "poll not found" }, 404);
  // Deleting an opened poll erases public vote results players may have
  // already seen — refuse, close it instead.
  if (p.status !== "draft") {
    return c.json({
      error: "cannot delete a poll that has opened",
      reason: "Once a poll opens, its results are a public record. Close it instead of deleting.",
    }, 409);
  }
  await prisma.poll.delete({ where: { id } });
  void makeAudit(c)(me.id, "poll.delete", id);
  return c.json({ ok: true });
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

  // ── WHY THE COUNTS ARE QUERIED SEPARATELY ─────────────────────────
  // The lists below are capped (50 chat, 20 each of the rest) so the payload
  // stays small on a 5-second poll. The dashboard used to derive its headline
  // numbers from the LENGTH of those lists, which meant a busy half hour
  // reported "50 chat messages" — pinned to the cap, indistinguishable from a
  // quiet one that genuinely had 50, and wrong in exactly the direction that
  // makes an incident look smaller than it is. These are the real numbers; the
  // lists stay capped and are labelled as a recent sample.
  const [users, recentMessages, recentSignups, recentTrades, recentPvP,
         chatCount, signupCount, tradeCount, pvpCount] = await Promise.all([
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
    prisma.chatMessage.count({ where: { createdAt: { gte: since } } }),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.tradeRecord.count({ where: { createdAt: { gte: since } } }).catch(() => 0),
    prisma.pvpMatch.count({ where: { createdAt: { gte: since } } }).catch(() => 0),
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
    /** True totals over the window. The lists above are a capped sample of
     *  these — see the comment on the query fan-out. */
    counts: { chat: chatCount, signups: signupCount, trades: tradeCount, pvp: pvpCount },
    /** How many of each kind the lists will return at most, so the dashboard
     *  can tell "this is everything" from "this is the most recent N" without
     *  hardcoding the server's limits. */
    caps: { chat: 50, signups: 20, trades: 20, pvp: 20 },
    windowMinutes: 30,
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
        `SELECT "id","reporterId","reporterName","title","description","page","userAgent","context","status","adminNotes","source","discordMessageId","createdAt","updatedAt"
           FROM "BugReport"
          WHERE "status" = $1
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${offset}`,
        status
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","reporterId","reporterName","title","description","page","userAgent","context","status","adminNotes","source","discordMessageId","createdAt","updatedAt"
           FROM "BugReport"
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${offset}`
      );

  // Counts per status, over the WHOLE table.
  //
  // Derived from the row list, these would be counts of the current page —
  // so a triage queue with 300 open reports would say "50 open" because that
  // is the page size, and the tab for a status you are not looking at would
  // always read zero. The whole point of the number on a filter tab is to
  // tell you what is behind it without going there.
  const grouped = await prisma.$queryRawUnsafe<{ status: string; n: bigint }[]>(
    `SELECT "status", COUNT(*)::bigint AS n FROM "BugReport" GROUP BY "status"`,
  );
  const counts: Record<string, number> = { all: 0 };
  for (const g of grouped) {
    const n = Number(g.n);
    counts[g.status] = n;
    counts.all += n;
  }

  return c.json({ reports: rows, counts });
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
// message with variable data (ids, uuids, timestamps, digit runs)
// normalized to placeholders — see error_message_fingerprint()
// (migration 20260717050000). Exact-string grouping fragments one real
// error type into many groups whenever a message embeds instance data
// (a save version, a raw exception's dynamic text), which is exactly
// what made this log look far noisier than it actually was.
//
// One query, one connection: fingerprint-normalize, count, and pick the
// newest row per group via a window function. The old version did
// groupBy() then Promise.all(rows.map(findFirst)) — up to 101
// concurrent connections for a single page load, a very plausible
// contributor to a "sorry, too many clients already" incident against
// a DB near its Postgres max_connections ceiling.
app.get("/errors/groups", async (c) => {
  const kind = (c.req.query("kind") ?? "").trim();
  const days = Math.min(90, Math.max(1, parseInt(c.req.query("days") ?? "14", 10)));
  const since = new Date(Date.now() - days * 86400000);
  const kindFilter = kind === "server" || kind === "client" ? kind : null;

  const rows = await prisma.$queryRaw<{
    kind: string; fingerprint: string; sampleMessage: string; count: bigint; latestAt: Date;
    sampleId: string; sampleLevel: string; sampleSource: string | null; sampleStack: string | null;
    sampleUserId: string | null; sampleUsername: string | null; sampleUserAgent: string | null;
  }[]>`
    WITH scored AS (
      SELECT
        "id", "kind", "level", "message", "stack", "source",
        "userId", "username", "userAgent", "createdAt",
        error_message_fingerprint("message") AS fingerprint,
        COUNT(*) OVER (PARTITION BY "kind", error_message_fingerprint("message")) AS "groupCount",
        MAX("createdAt") OVER (PARTITION BY "kind", error_message_fingerprint("message")) AS "groupLatestAt",
        ROW_NUMBER() OVER (
          PARTITION BY "kind", error_message_fingerprint("message")
          ORDER BY "createdAt" DESC
        ) AS rn
      FROM "ErrorLog"
      WHERE "createdAt" >= ${since}
        AND (${kindFilter}::text IS NULL OR "kind" = ${kindFilter})
    )
    SELECT
      "kind", fingerprint,
      "message"       AS "sampleMessage",
      "groupCount"    AS count,
      "groupLatestAt" AS "latestAt",
      "id"            AS "sampleId",
      "level"         AS "sampleLevel",
      "source"        AS "sampleSource",
      "stack"         AS "sampleStack",
      "userId"        AS "sampleUserId",
      "username"      AS "sampleUsername",
      "userAgent"     AS "sampleUserAgent"
    FROM scored
    WHERE rn = 1
    ORDER BY "groupCount" DESC
    LIMIT 100;
  `;

  const groups = rows.map((g) => ({
    kind: g.kind,
    fingerprint: g.fingerprint,
    message: g.sampleMessage,
    count: Number(g.count),
    latestAt: g.latestAt,
    sample: {
      id: g.sampleId, level: g.sampleLevel, source: g.sampleSource, stack: g.sampleStack,
      userId: g.sampleUserId, username: g.sampleUsername, userAgent: g.sampleUserAgent,
    },
  }));

  return c.json({ sinceDays: days, groups });
});

// Clear a resolved error group.
//
// Once a bug is actually fixed, its historical rows are pure noise —
// they push live problems off the top of the log and inflate the
// dashboard's error KPI forever. Deletes by FINGERPRINT, not exact
// message — the grouped view above now collapses rows whose messages
// differ only in embedded variable data (an id, a version number) into
// one group, so deleting by exact message would silently leave those
// sibling rows behind while the operator believes the group is gone.
//
// Audited with the row count, so "who wiped 228 errors and when" stays
// answerable after the fact.
const ClearErrorsBody = z.object({
  kind: z.enum(["server", "client"]),
  fingerprint: z.string().min(1),
});

app.post("/errors/clear-group", async (c) => {
  const me = c.get("user");
  const parsed = ClearErrorsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const { kind, fingerprint } = parsed.data;
  const deleted = await prisma.$executeRaw`
    DELETE FROM "ErrorLog"
     WHERE "kind" = ${kind} AND error_message_fingerprint("message") = ${fingerprint}
  `;
  void makeAudit(c)(me.id, "errors.clear_group", null, {
    kind,
    fingerprint: fingerprint.slice(0, 200),
    deleted,
  });
  return c.json({ ok: true, deleted });
});

app.get("/errors", async (c) => {
  const kind = (c.req.query("kind") ?? "").trim();
  // Cap raised 200 → 500 to match what the dashboard actually asks for.
  // It requested 500 and silently received 200, so the table quietly
  // hid 60% of what the operator asked to see, with no indication.
  const limit = Math.min(500, Math.max(1, parseInt(c.req.query("limit") ?? "100", 10)));
  // fingerprint included so the dashboard's grouped-view drill-down can
  // join occurrences to a group correctly — joining on raw "message"
  // silently drops sibling rows whose message differs only in embedded
  // variable data (see error_message_fingerprint(), migration
  // 20260717050000).
  const rows = kind === "server" || kind === "client"
    ? await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","kind","level","message","stack","source","userId","username","userAgent","meta","createdAt",
                error_message_fingerprint("message") AS fingerprint
           FROM "ErrorLog"
          WHERE "kind" = $1
          ORDER BY "createdAt" DESC
          LIMIT ${limit}`,
        kind
      )
    : await prisma.$queryRawUnsafe<any[]>(
        `SELECT "id","kind","level","message","stack","source","userId","username","userAgent","meta","createdAt",
                error_message_fingerprint("message") AS fingerprint
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
// Admin-managed brackets:
//   - Create + list + delete tournaments with optional level cap
//   - Add / remove participants (players self-sign-up via
//     POST /api/pvp/tournaments/:id/join; this is the operator override)
//   - Generate the bracket — seeds by ELO, sizes itself from the actual
//     sign-ups, folds byes to the top seeds
//   - Everything after that is driven by lib/tournamentRunner.ts: it
//     starts each pairing the moment both players are online, applies
//     results, and decides a pairing whose round window expired. The
//     buttons below are operator overrides on top of that, not the
//     primary path.
//
// See lib/tournamentRunner.ts for why the format is asynchronous.

const TournamentCreateBody = z.object({
  name: z.string().min(1).max(80),
  levelCap: z.number().int().min(1).max(100).nullable().optional(),
  format: z.string().max(40).optional(),
  /** Minutes each ROUND stays open. Default 24h — see the runner. */
  roundWindowMinutes: z.number().int().min(5).max(60 * 24 * 14).optional(),
  /** Let the runner drive it. Off = hand-run showmatch. */
  autoRun: z.boolean().optional(),
  /** Champion prize, as the same Prize[] JSON giveaways use — and now held to
   *  the same bounds. The string is parsed and re-normalised through
   *  PrizeListSchema by parsePrizesStrict before it is stored; the length cap
   *  only stops a huge body reaching the JSON parser. */
  prizes: z.string().max(20_000).nullable().optional(),
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
  // TWO checks, and they answer different questions. parsePrizesStrict asks
  // "is this in bounds" — the same PrizeListSchema giveaways and mass-gift are
  // held to, which this route used to skip entirely (see lib/giveaway.ts).
  // checkPrizesDeliverable then asks "will it actually fold", at CREATE time,
  // rather than discovering it when the final resolves and the champion is
  // standing there empty-handed.
  let prizesJson: string | null = null;
  if (parsed.data.prizes) {
    const strict = parsePrizesStrict(parsed.data.prizes);
    if (!strict.ok) return c.json({ error: "prize rejected", reason: strict.reason }, 400);
    const bad = checkPrizesDeliverable(strict.prizes);
    if (bad) return c.json({ error: "prize would corrupt save", reason: bad }, 400);
    // Store the re-normalised form, so the row can only ever hold what the
    // schema accepted.
    prizesJson = JSON.stringify(strict.prizes);
  }
  const t = await prisma.tournament.create({
    data: {
      name: parsed.data.name,
      levelCap: parsed.data.levelCap ?? null,
      format: parsed.data.format ?? "tournament",
      status: "open",
      ownerId: me.id,
      roundWindowMinutes: parsed.data.roundWindowMinutes ?? 1440,
      autoRun: parsed.data.autoRun ?? true,
      prizes: prizesJson,
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
    | {
        name?: string; levelCap?: number | null; status?: string;
        roundWindowMinutes?: number; autoRun?: boolean; prizes?: string | null;
      }
    | null;
  if (!body) return c.json({ error: "invalid body" }, 400);
  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.length <= 80) data.name = body.name;
  if (body.levelCap === null || (typeof body.levelCap === "number" && body.levelCap >= 1 && body.levelCap <= 100)) {
    data.levelCap = body.levelCap;
  }
  if (typeof body.roundWindowMinutes === "number") {
    data.roundWindowMinutes = clampRoundMinutes(body.roundWindowMinutes);
  }
  if (typeof body.autoRun === "boolean") data.autoRun = body.autoRun;
  if (body.prizes !== undefined) {
    if (body.prizes === null) data.prizes = null;
    else {
      // Same two gates as create, and for the same reason: an operator who can
      // PATCH a prize past the bounds has the create bound for nothing.
      if (typeof body.prizes !== "string" || body.prizes.length > 20_000) {
        return c.json({ error: "prize rejected", reason: "prizes must be a JSON string under 20,000 chars" }, 400);
      }
      const strict = parsePrizesStrict(body.prizes);
      if (!strict.ok) return c.json({ error: "prize rejected", reason: strict.reason }, 400);
      const bad = checkPrizesDeliverable(strict.prizes);
      if (bad) return c.json({ error: "prize would corrupt save", reason: bad }, 400);
      data.prizes = JSON.stringify(strict.prizes);
    }
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

  // ── Seed by ELO ───────────────────────────────────────────────────
  // TournamentEntry.seed was never populated by anything: neither the
  // player join route nor the admin add-entry route set it, so
  // generateBracket's tie-break fell through to `userId.localeCompare`
  // — the draw was ordered by cuid. That makes byes and the no-show
  // tie-break arbitrary, which matters a lot here because with this
  // population a meaningful share of pairings WILL be decided by
  // walkover rather than played.
  //
  // Any explicit seed an operator already set by hand wins; everyone
  // else is ranked by PlayerRating (the same ELO the ranked ladder
  // uses), then by matches played, then by username so the result is
  // stable. Unrated players sort to the bottom on the starting 1000.
  const ratings = await prisma.playerRating.findMany({
    where: { userId: { in: seedable.map((e) => e.userId) } },
    select: { userId: true, rating: true, matchesPlayed: true },
  });
  const ratingOf = new Map(ratings.map((r) => [r.userId, r]));
  const manual = seedable.filter((e) => e.seed != null).sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
  const auto = seedable
    .filter((e) => e.seed == null)
    .sort((a, b) => {
      const ra = ratingOf.get(a.userId);
      const rb = ratingOf.get(b.userId);
      const diff = (rb?.rating ?? 1000) - (ra?.rating ?? 1000);
      if (diff !== 0) return diff;
      const played = (rb?.matchesPlayed ?? 0) - (ra?.matchesPlayed ?? 0);
      if (played !== 0) return played;
      return a.username.localeCompare(b.username);
    });
  const ordered = [...manual, ...auto];
  const seeds = ordered.map((e, i) => ({
    entryId: e.id,
    userId: e.userId,
    username: e.username,
    seed: i + 1,
    ratingAtSeed: ratingOf.get(e.userId)?.rating ?? 1000,
  }));
  // Persist the seeds so the bracket, the admin table and the player's
  // bracket view all agree on who was #1 and why.
  await prisma.$transaction(
    seeds.map((s) =>
      prisma.tournamentEntry.update({
        where: { id: s.entryId },
        data: { seed: s.seed, ratingAtSeed: s.ratingAtSeed },
      }),
    ),
  );

  const bracket = generateBracket(
    seeds.map((s) => ({ userId: s.userId, username: s.username, seed: s.seed })),
  );
  // Arm the first round's clock immediately. Every later round's clock
  // starts when that round OPENS — the runner stamps it — so a slow
  // round 1 does not eat round 2's window.
  const deadline = Date.now() + clampRoundMinutes(t.roundWindowMinutes) * 60_000;
  for (const m of bracket.rounds[0].matches) {
    if (!m.winnerId) m.deadlineAt = deadline;
  }
  const updated = await prisma.tournament.update({
    where: { id },
    data: { bracket: JSON.stringify(bracket), status: "live", startsAt: new Date() },
  });
  void makeAudit(c)(me.id, "tournament.generate_bracket", id, {
    rounds: bracket.rounds.length,
    entries: seeds.length,
    drawSize: bracket.rounds[0].matches.length * 2,
    byes: bracket.rounds[0].matches.length * 2 - seeds.length,
    roundWindowMinutes: t.roundWindowMinutes,
  });
  return c.json({ tournament: updated, seeds });
});

// ── Force a runner tick ─────────────────────────────────────────────
// The runner sweeps on its own timer; this is the "do it now" button so
// an operator watching the dashboard doesn't have to wait 15s to see
// their change take effect. Same code path, so it can't diverge.
app.post("/tournaments/:id/run", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t) return c.json({ error: "tournament not found" }, 404);
  if (t.status !== "live") return c.json({ error: "tournament not live" }, 409);
  const actions = await tickOneTournament(id);
  void makeAudit(c)(me.id, "tournament.run", id, { actions: actions.length });
  const after = await prisma.tournament.findUnique({ where: { id } });
  return c.json({ actions, tournament: after });
});

// ── Operator override: decide a match by hand ───────────────────────
// The escape hatch for everything the runner cannot see — a player who
// tells you in chat they're withdrawing, a disputed result, a match both
// sides agree to concede. Writes through the same advanceBracket path as
// everything else so the bracket can never end up in a shape the runner
// doesn't understand.
app.post("/tournaments/:id/matches/:matchId/resolve", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const matchId = c.req.param("matchId");
  const body = (await c.req.json().catch(() => null)) as
    | { winnerUserId?: string; note?: string }
    | null;
  const winnerUserId = String(body?.winnerUserId ?? "");
  if (!winnerUserId) return c.json({ error: "winnerUserId required" }, 400);

  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t || !t.bracket) return c.json({ error: "tournament has no bracket" }, 400);
  if (t.status !== "live") return c.json({ error: "tournament not live" }, 409);
  let bracket: Bracket;
  try { bracket = JSON.parse(t.bracket) as Bracket; }
  catch { return c.json({ error: "bracket JSON is corrupt" }, 500); }

  const match = findMatch(bracket, matchId);
  if (!match) return c.json({ error: "match not in bracket" }, 404);
  if (match.winnerId) return c.json({ error: "match already resolved" }, 409);
  const p = participants(match);
  if (!p) return c.json({ error: "match still has unresolved placeholders" }, 400);
  if (winnerUserId !== p.a.userId && winnerUserId !== p.b.userId) {
    return c.json({ error: "winner is not in this match" }, 400);
  }
  // Kill any battle still attached so the runner doesn't later reap it
  // and reopen a match an operator has just settled.
  if (match.battleId) {
    const room = battleRooms.get(match.battleId);
    if (room && (room.status === "active" || room.status === "invited")) {
      room.winnerId = winnerUserId;
      room.loserId = winnerUserId === p.a.userId ? p.b.userId : p.a.userId;
      await endBattle(room, sendToUserGlobal, "forfeit");
    }
    match.battleId = null;
    match.battleStartedAt = null;
  }

  const adv = advanceBracket(bracket, {
    [matchId]: { winnerId: winnerUserId, by: "admin", note: body?.note || `resolved by ${me.username}` },
  });
  if (adv.eliminatedUserIds.length > 0) {
    await prisma.tournamentEntry.updateMany({
      where: { tournamentId: id, userId: { in: adv.eliminatedUserIds } },
      data: { eliminated: true },
    });
  }
  const data: Record<string, unknown> = { bracket: JSON.stringify(adv.bracket) };
  if (adv.complete && adv.championId) {
    data.status = "completed";
    data.finishedAt = new Date();
    data.championId = adv.championId;
    data.championUsername = usernameOf(adv.bracket, adv.championId);
  }
  const updated = await prisma.tournament.update({ where: { id }, data });
  if (adv.complete) await onTournamentComplete(id);
  void makeAudit(c)(me.id, "tournament.resolve_match", id, { matchId, winnerUserId, note: body?.note });
  return c.json({ tournament: updated, championId: adv.championId });
});

// ── Advance the bracket ────────────────────────────────────────────
// Kept for the dashboard button and for anything scripted against it,
// but it is now a thin alias for one runner tick.
//
// It used to be its own implementation: join every match's battleId
// against PvpMatch, copy in `status === "completed" && winnerId`,
// propagate. That handled exactly one outcome — a clean win — and
// silently ignored the other three a real battle can end in. A tie, a
// double timeout and a cancellation all produce a bracket match that
// holds a battleId (so start-bracket-match 409s "already started") and
// has no winner (so advance can never resolve it). The tournament was
// then frozen with no operator-visible cause and no way out short of
// editing the bracket JSON in the database.
//
// tickOneTournament reaps those, retries them, decides them at the
// round deadline, and records the champion. One code path, same
// idempotency guarantees.
app.post("/tournaments/:id/advance-bracket", async (c) => {
  const me = c.get("user");
  const id = c.req.param("id");
  const t = await prisma.tournament.findUnique({ where: { id } });
  if (!t || !t.bracket) return c.json({ error: "tournament has no bracket" }, 400);
  if (t.status !== "live") return c.json({ error: "tournament not live" }, 409);

  const actions = await tickOneTournament(id);
  const after = await prisma.tournament.findUnique({ where: { id } });
  void makeAudit(c)(me.id, "tournament.advance_bracket", id, {
    actions: actions.length,
    complete: after?.status === "completed",
    championId: after?.championId ?? null,
  });
  return c.json({ tournament: after, championId: after?.championId ?? null, actions });
});

// ── Start a specific bracket-match ──────────────────
// Operator override for "start this pairing NOW". The runner already
// does this automatically the moment both players are online, so this
// is only needed when an operator wants to force the issue.
//
// The room-spawn body used to live here, inline and duplicated with
// /tournaments/:id/match. It is now startTournamentBattle() in
// lib/tournamentRunner.ts, which is also what the runner calls — one
// place that knows the preconditions, so the manual button and the
// automatic path cannot enforce different ones. In particular the old
// inline version documented "both participants must be online" and then
// never checked: it hardcoded `connected: true` and never consulted
// presence. Starting a pairing against an offline player burned it —
// the match got a battleId (so it could not be restarted) and then
// timed out with no winner (so it could not be advanced).
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

  const match = findMatch(bracket, matchId);
  if (!match) return c.json({ error: "match not in bracket" }, 404);
  if (match.battleId) {
    return c.json({ error: "match already started", battleId: match.battleId }, 409);
  }
  if (match.winnerId) return c.json({ error: "match already resolved" }, 409);
  if (!participants(match)) {
    return c.json({ error: "match has unresolved placeholders — advance the bracket first" }, 400);
  }

  const started = await startTournamentBattle(t, match);
  if (!started.ok) return c.json({ error: started.reason }, 409);

  // Persist the battleId so the runner (and advance-bracket) can find
  // the result later. If this write fails the battle is still live in
  // memory; the runner's orphan reaper hands the pairing back rather
  // than leaving it wedged.
  match.battleId = started.battleId;
  match.battleStartedAt = Date.now();
  await prisma.tournament.update({
    where: { id },
    data: { bracket: JSON.stringify(bracket) },
  });
  void makeAudit(c)(me.id, "tournament.start_bracket_match", t.id, { battleId: started.battleId, matchId });
  return c.json({ ok: true, battleId: started.battleId });
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

  // Both sides must actually be connected. The comment above this route
  // has always claimed this; nothing enforced it, and the room below
  // hardcodes `connected: true`. A battle against an absent player just
  // burns five minutes of turn timer and produces a match nobody won.
  if (!isOnline(aUserId)) return c.json({ error: "player A is offline" }, 409);
  if (!isOnline(bUserId)) return c.json({ error: "player B is offline" }, 409);

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
  // battle:start opens the players' battle screen — it only fires once
  // the simulator has accepted the matchup. See pvp.ts's onReady note.
  try {
    await startBattle(getIo()!, room, sendToUserGlobal, () => {
      sendToUserGlobal(aUser.id, "battle:start", {
        battleId, format: room.format, opponent: { id: bUser.id, username: bUser.username }, you: "a",
        levelCap: t.levelCap ?? null,
      });
      sendToUserGlobal(bUser.id, "battle:start", {
        battleId, format: room.format, opponent: { id: aUser.id, username: aUser.username }, you: "b",
        levelCap: t.levelCap ?? null,
      });
    });
    void makeAudit(c)(me.id, "tournament.start_match", t.id, { battleId, aUserId, bUserId });
    return c.json({ ok: true, battleId });
  } catch (e) {
    room.status = "cancelled";
    const detail = e instanceof Error ? e.message : String(e);
    const reason = `Couldn't start the battle: ${detail}`;
    sendToUserGlobal(aUser.id, "battle:cancelled", { battleId, reason });
    sendToUserGlobal(bUser.id, "battle:cancelled", { battleId, reason });
    battleRooms.delete(battleId);
    void recordError({
      kind: "server",
      message: "pvp_start_battle_failed",
      source: "admin.tournaments.start-match",
      stack: e instanceof Error ? e.stack ?? null : null,
      userId: me.id,
      meta: {
        battleId, format: room.format, simulatorError: detail,
        tournamentId: t.id,
        aUserId: aUser.id, aUsername: aUser.username, aTeamSize: teamA.length,
        bUserId: bUser.id, bUsername: bUser.username, bTeamSize: teamB.length,
      },
    });
    return c.json({ error: "engine refused", detail }, 500);
  }
});

export default app;
