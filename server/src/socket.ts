import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { auth } from "./auth.js";
import { prisma } from "./db.js";
import { recordDailyActive } from "./lib/presence.js";
import { canAccessChannel, GLOBAL_CHANNEL, TRADE_CHANNEL, parseDmChannel } from "./lib/chatChannels.js";
import { makeRateLimiter } from "./lib/rateLimit.js";
import { validateSave } from "./lib/saveValidation.js";
import { getLiveAnnouncement, toPublic } from "./lib/announcements.js";
import { readStreamCookie, resolveStreamKey } from "./lib/streamSession.js";
import { recordCommandResult } from "./lib/streamCommandLog.js";
import { recordError } from "./lib/errorReporting.js";
import {
  battleRooms,
  newBattleId,
  startBattle,
  applyChoice,
  endBattle,
  startInviteExpiry,
  joinQueue,
  leaveQueue,
  popQueuePair,
  queueIndexOf,
  matchmakingQueue,
  startMatchmakingTicker,
  type BattleRoom,
  type BattleFormat,
} from "./pvp.js";

// ── Rate limits ──────────────────────────────────────────────────────────
// Per-user limits; values are deliberate bands, not optimisations:
// - Chat: roughly one message every 1.5 s sustained, with bursts.
// - Trade invites: 5/min — discourages mass-spam invites.
// - Trade actions (offer/lock/cancel): 60/min — UI generates a few per
//   trade naturally; well above that is misuse.
const chatLimiter = makeRateLimiter({ tokens: 20, windowMs: 30_000 });
const tradeInviteLimiter = makeRateLimiter({ tokens: 5, windowMs: 60_000 });
const tradeActionLimiter = makeRateLimiter({ tokens: 60, windowMs: 60_000 });
// PvP rate limits — invites mirror trade invites (anti-spam) and per-
// turn choices have a generous-but-finite ceiling so a runaway client
// can't flood the simulator.
const battleInviteLimiter = makeRateLimiter({ tokens: 5, windowMs: 60_000 });
const battleChoiceLimiter = makeRateLimiter({ tokens: 120, windowMs: 60_000 });

// Parse FRONTEND_ORIGIN as a comma-separated allowlist (mirrors what
// the Hono CORS in index.ts does). Socket.IO's `cors.origin` accepts
// an array; a raw comma-joined string would be matched literally and
// fail every browser's actual `Origin` header — which is the bug that
// caused live chat to silently fall back to polling-only and not
// receive broadcasts.
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface SocketUser {
  id: string;
  username: string;
  isAdmin?: boolean;
  sessionId?: string;
  /** True for OBS/24-7 stream auto-login sockets. Sensitive socket actions
   *  (trade:*, etc.) reject when set — mirrors the HTTP blockStream guard. */
  isStream?: boolean;
}

declare module "socket.io" {
  interface SocketData {
    user?: SocketUser;
  }
}

// ── Trade plumbing ───────────────────────────────────────────────────────
// Trades live entirely in memory: short-lived (≤ 60 s), no persistence
// needed. Each trade tracks both sides' offers + lock state. The server
// only relays the agreed swap once both sides have locked their offers.
// The actual party mutation happens client-side via a TRADE_COMPLETE
// reducer dispatch — both clients then push their next save normally.
//
// Stages:
//   "invited"   — sender pinged receiver; awaiting accept/decline
//   "active"    — receiver accepted; both can pick & lock offers
//   "completed" — relayed swap; trade is dead (will be deleted shortly)
//   "cancelled" — either side cancelled or the timer ran out
interface TradeSide {
  userId: string;
  username: string;
  offer: TradeOffer | null; // serialised Pokemon (pre-evolution)
  locked: boolean;
  // Snapshot of {party, box} that the client attaches to the trade:lock
  // event. We use it as the canonical source for findMon() instead of
  // reading saveData from the DB, because the DB lags behind real client
  // state (autosave debounces ~1.5s + HTTP roundtrip), which caused the
  // Haunter→Gastly bug: server reads pre-evolution Gastly from DB and
  // ships it even though the player just evolved + locked. The snapshot
  // is validateSave()-checked for type bounds before being trusted.
  liveSnapshot?: { party?: unknown; box?: unknown } | null;
}
// What the client serialises into a trade. The shape is validated
// strictly with zod (see TradeOfferSchema below) before the server
// stores it. Even though tryFinalize ALSO replaces the offer with the
// canonical server-side mon at lock time, we still guard the in-flight
// state shape here so a malicious client can't poison the broadcast
// with prototype-polluting keys, oversized arrays, or weird strings
// that the receiving client might trust.
import { z } from "zod";

const MoveSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  pp: z.number().int().min(0).max(128),
  maxPp: z.number().int().min(0).max(128),
}).strict();

const TradeOfferSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  speciesKey: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  name: z.string().max(40).optional(),
  nickname: z.string().max(32).optional(),
  level: z.number().int().min(1).max(100),
  totalExp: z.number().min(0).max(2_000_000).optional(),
  isShiny: z.boolean().optional(),
  heldItem: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).nullable().optional(),
  nature: z.string().max(20).optional(),
  ability: z.string().max(40).optional(),
  // Stat fields — bounds enforced for parity with saveValidation.ts.
  currentHp: z.number().min(0).max(999).optional(),
  maxHp: z.number().min(1).max(999).optional(),
  attack: z.number().min(0).max(800).optional(),
  defense: z.number().min(0).max(800).optional(),
  spAttack: z.number().min(0).max(800).optional(),
  spDefense: z.number().min(0).max(800).optional(),
  speed: z.number().min(0).max(800).optional(),
  ivs: z.record(z.string(), z.number().int().min(0).max(31)).optional(),
  evs: z.record(z.string(), z.number().int().min(0).max(252)).optional(),
  moves: z.array(MoveSchema).max(4).optional(),
  // Tolerate any other client-side bookkeeping fields (status, sleepTurns,
  // statStages, etc.) but cap their depth via passthrough — the actual
  // post-trade payload is the SERVER-canonical mon, so this only guards
  // the in-flight broadcast.
}).passthrough();

type TradeOffer = z.infer<typeof TradeOfferSchema>;
interface Trade {
  id: string;
  status: "invited" | "active" | "completed" | "cancelled";
  a: TradeSide;
  b: TradeSide;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}
const trades = new Map<string, Trade>();
const TRADE_INVITE_TTL_MS = 60_000;
const TRADE_ROOM_TTL_MS = 5 * 60_000; // 5 min once both sides are in the room

// Generate a short trade id (prefix + 9 random hex chars).
function newTradeId(): string {
  return `t_${Math.random().toString(16).slice(2, 11)}`;
}

// Online presence — userId → set of socket ids.
const online = new Map<string, Set<string>>();
// Live socket index by sessionId so we can kick a specific session
// when a fresh login replaces it.
const socketsBySession = new Map<string, Set<string>>();
// Reference to the io instance — populated by attachSocketServer so
// `kickSession()` (called from outside this module) can reach it.
let ioInstance: Server | null = null;

// Public hook the auth middleware calls when it deletes a session row.
// Disconnects every socket bound to that session and tells the client
// the account has been signed in elsewhere so the UI can show the
// auth modal immediately instead of waiting for the next 401.
export function kickSession(userId: string, sessionId: string): void {
  const ids = socketsBySession.get(sessionId);
  if (!ids || !ioInstance) return;
  for (const sid of ids) {
    const s = ioInstance.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit("session:replaced", { userId, reason: "Signed in from another device" });
    s.disconnect(true);
  }
  socketsBySession.delete(sessionId);
}

// Force-disconnect every active socket for a user. Called by the
// admin ban endpoint so a ban takes effect immediately rather than
// at the next reconnect (a banned user with an open tab could
// otherwise keep using chat / PvP / trades over the existing WS
// even after their HTTP requests started 403-ing). Returns the
// number of sockets actually kicked.
export function kickUser(userId: string, reason: string): number {
  const ids = online.get(userId);
  if (!ids || !ioInstance) return 0;
  let kicked = 0;
  for (const sid of [...ids]) {
    const s = ioInstance.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit("session:banned", { reason });
    s.disconnect(true);
    kicked++;
  }
  return kicked;
}

function addPresence(userId: string, socketId: string) {
  let set = online.get(userId);
  if (!set) {
    set = new Set();
    online.set(userId, set);
  }
  set.add(socketId);
  return set.size === 1; // first connection
}
function removePresence(userId: string, socketId: string): boolean {
  const set = online.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    online.delete(userId);
    return true; // last connection
  }
  return false;
}

export function isOnline(userId: string): boolean {
  return online.has(userId);
}

// Snapshot of currently-online users, with their concurrent socket
// count. Used by the admin "Live ops" page to render who is connected
// right this second. Map iteration order is insertion order so the
// list is roughly oldest-session-first.
export function liveOnlineSnapshot(): { userId: string; sessionCount: number }[] {
  return Array.from(online.entries()).map(([userId, sockets]) => ({
    userId,
    sessionCount: sockets.size,
  }));
}

// Cross-module helper: send `event` to every active socket of a user.
// Used by admin routes (tournament bracket runner, etc.) that need to
// reach players outside the socket-handler scope.
export function sendToUserGlobal(userId: string, event: string, payload: unknown): void {
  if (!ioInstance) return;
  const sockets = online.get(userId);
  if (!sockets) return;
  for (const sid of sockets) ioInstance.to(sid).emit(event, payload);
}

export function getIo(): Server | null {
  return ioInstance;
}

// Broadcast a "chat cleared" notification to every connected socket so
// clients can wipe their cached message lists for the affected channels
// without needing a refresh. Called by the admin clear-chat endpoint.
//   scope: "public" → clear global + all area:* channels client-side
export function broadcastChatCleared(scope: "public"): void {
  if (!ioInstance) return;
  ioInstance.emit("chat:cleared", { scope });
}

// Push the pinned banner to every connected player the instant an admin
// publishes or clears one. `payload` is the PublicAnnouncement, or null to
// tear the banner down. A player who joins later gets the current banner
// pushed on connect (see the connection handler), so this only needs to
// reach who is already online.
export function broadcastAnnouncement(payload: unknown | null): void {
  if (!ioInstance) return;
  ioInstance.emit("announcement:set", { announcement: payload });
}

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: FRONTEND_ORIGINS,
      credentials: true,
    },
  });

  // Auth gate — extract Better Auth session cookie from the handshake,
  // reject anonymous connections, AND honour the user's banned-until
  // window. The HTTP requireUser middleware already enforces the ban
  // on REST endpoints; mirroring it here closes a ban-evasion gap
  // where a banned user with an open tab could keep using chat, PvP
  // matchmaking, and trades over the WebSocket after their HTTP
  // requests started 403-ing. Schema.prisma's bannedUntil comment
  // (`> now blocks login + socket connections`) is the source of truth.
  io.use(async (socket, next) => {
    try {
      const headers = new Headers();
      const cookie = socket.request.headers.cookie;
      if (cookie) headers.set("cookie", cookie);
      const session = await auth.api.getSession({ headers });
      if (!session?.user) {
        // No Better Auth session — try a stream auto-login cookie. Stream
        // sockets are RESTRICTED (isAdmin false, isStream true) and the
        // sensitive socket handlers reject them.
        const streamKey = readStreamCookie(cookie);
        const stream = await resolveStreamKey(streamKey);
        if (stream) {
          socket.data.user = {
            id: stream.userId,
            username: stream.username,
            isAdmin: false,
            isStream: true,
          };
          return next();
        }
        return next(new Error("unauthorized"));
      }
      const sessionId = (session as any).session?.id as string | undefined;
      const dbUser = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { id: true, isAdmin: true, bannedUntil: true },
      });
      if (!dbUser) return next(new Error("unauthorized"));
      if (dbUser.bannedUntil && dbUser.bannedUntil.getTime() > Date.now()) {
        return next(new Error("banned"));
      }
      socket.data.user = {
        id: session.user.id,
        username: (session.user as any).username ?? session.user.email.split("@")[0],
        isAdmin: dbUser.isAdmin,
        sessionId,
      };
      next();
    } catch (e) {
      next(e instanceof Error ? e : new Error("auth failed"));
    }
  });

  ioInstance = io;
  // Broadcast the global online-user count to every connected socket.
  // We count distinct user ids (the `online` Map keys), not sockets,
  // so a player with two tabs open counts as one.
  const broadcastOnlineCount = () => {
    io.emit("presence:count", { count: online.size });
  };

  // Per-room sendToUser helper at the module level — needed by the
  // matchmaking ticker which doesn't have a per-connection scope.
  const sendToAnyUser = (userId: string, event: string, payload: unknown) => {
    const sockets = online.get(userId);
    if (!sockets) return;
    for (const sid of sockets) io.to(sid).emit(event, payload);
  };

  // Pair anyone waiting in the matchmaking queue with the next
  // available opponent and spawn a room. Called both as a side effect
  // of battle:queue (so the second-to-arrive player triggers an
  // instant match) and from a periodic ticker (so a missed trigger
  // doesn't strand both players staring at "Searching for opponent...").
  // Idempotent — no-ops when there aren't ≥2 queued.
  const tryPairAndSpawnRoom = async (): Promise<void> => {
    const pair = popQueuePair();
    if (!pair) return;
    const [aEntry, bEntry] = pair;
    // If either side dropped out between joining the queue and the
    // pair pop, requeue the survivor and bail. The next tick (or the
    // next join) re-attempts.
    if (!online.has(aEntry.userId)) {
      if (online.has(bEntry.userId)) joinQueue(bEntry);
      return;
    }
    if (!online.has(bEntry.userId)) {
      joinQueue(aEntry);
      return;
    }
    const battleId = newBattleId();
    const room: BattleRoom = {
      id: battleId,
      status: "invited",  // immediately upgraded to "active" by startBattle
      format: "random50",
      createdAt: Date.now(),
      lastChoiceAt: Date.now(),
      a: { userId: aEntry.userId, username: aEntry.username, team: aEntry.team, stream: null, request: null, connected: true },
      b: { userId: bEntry.userId, username: bEntry.username, team: bEntry.team, stream: null, request: null, connected: true },
      log: [],
      stream: null,
      expiryTimer: null,
      spectators: new Set(),
    };
    battleRooms.set(battleId, room);
    // Start the simulator BEFORE telling anyone a battle exists. The
    // other order opened the battle screen on both clients and only
    // then found out whether there was a battle behind it — so a
    // refusal showed up as a window that appeared and vanished with no
    // explanation. Now a refusal is just an error message.
    try {
      await startBattle(io, room, sendToAnyUser, () => {
        sendToAnyUser(aEntry.userId, "battle:start", {
          battleId, format: room.format,
          opponent: { id: bEntry.userId, username: bEntry.username },
          you: "a",
        });
        sendToAnyUser(bEntry.userId, "battle:start", {
          battleId, format: room.format,
          opponent: { id: aEntry.userId, username: aEntry.username },
          you: "b",
        });
      });
      console.log("[pvp] matchmaking spawned battle", { battleId, a: aEntry.username, b: bEntry.username });
    } catch (e) {
      room.status = "cancelled";
      const detail = e instanceof Error ? e.message : String(e);
      const reason = `Couldn't start the battle: ${detail}`;
      sendToAnyUser(aEntry.userId, "battle:cancelled", { battleId, reason });
      sendToAnyUser(bEntry.userId, "battle:cancelled", { battleId, reason });
      battleRooms.delete(battleId);
      void recordError({
        kind: "server",
        message: "pvp_start_battle_failed",
        source: "socket.tryPairAndSpawnRoom",
        stack: e instanceof Error ? e.stack ?? null : null,
        meta: {
          battleId,
          format: room.format,
          simulatorError: detail,
          aUserId: aEntry.userId, aUsername: aEntry.username, aTeamSize: aEntry.team.length,
          bUserId: bEntry.userId, bUsername: bEntry.username, bTeamSize: bEntry.team.length,
        },
      });
    }
  };

  // Defense-in-depth ticker. Fires every 3s; if anyone is queued and
  // a pair is available, this guarantees a battle starts even if the
  // join-time trigger was missed (race, transient socket hiccup, etc.).
  startMatchmakingTicker(() => { void tryPairAndSpawnRoom(); }, 3_000);
  io.on("connection", async (socket) => {
    const user = socket.data.user!;
    // The admin dashboard's Live Chat view opens a real, authenticated
    // socket on the same server (server/src/routes/admin.ts's REST
    // calls already share this account's session, so this is nothing
    // new auth-wise) — but it isn't gameplay, and treating it as one
    // more of the player's connections would count staff as an online
    // player and record a DailyActive row for a dashboard visit, not a
    // play session. admin/src/net/socket.ts sends this auth flag so
    // that specific connection can skip presence/DAU side effects
    // while still authenticating, auto-joining chat rooms, and sending/
    // receiving broadcasts normally — an admin who ALSO has the game
    // open in another tab still counts fully via that other socket.
    const isAdminDashboard = socket.handshake.auth?.client === "admin-dashboard";
    const wasFirst = isAdminDashboard ? false : addPresence(user.id, socket.id);
    if (user.sessionId) {
      let set = socketsBySession.get(user.sessionId);
      if (!set) { set = new Set(); socketsBySession.set(user.sessionId, set); }
      set.add(socket.id);
    }

    if (!isAdminDashboard) {
      // Mark last seen now.
      await prisma.user
        .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
      // lastSeenAt is a scalar — it gets overwritten, so it can only ever
      // answer "when did they last play". Append a per-day activity row
      // too, which is what real DAU is computed from. Idempotent per
      // (user, UTC day); never allowed to fail the connection.
      void recordDailyActive(user.id);
    }

    // Send the current count to the freshly-connected socket so the
    // chat header has a value to show immediately, before any other
    // user comes/goes.
    socket.emit("presence:count", { count: online.size });

    // Push the current pinned banner to this socket so a player who joins
    // after it was set still sees it — the REST fetch on the client covers
    // the pre-socket paint, this covers everyone already connected when a
    // banner is live. Never allowed to fail the connection.
    void getLiveAnnouncement()
      .then((a) => socket.emit("announcement:set", { announcement: a ? toPublic(a) : null }))
      .catch(() => { /* banner is a nice-to-have; a DB blip must not drop the socket */ });

    if (wasFirst) {
      // First connection for this user — broadcast updated total to
      // everyone, and notify their friends specifically.
      broadcastOnlineCount();
      const friends = await prisma.friend.findMany({
        where: {
          status: "accepted",
          OR: [{ requesterId: user.id }, { receiverId: user.id }],
        },
        select: { requesterId: true, receiverId: true },
      });
      const friendIds = friends.map((f) =>
        f.requesterId === user.id ? f.receiverId : f.requesterId
      );
      for (const fid of friendIds) {
        const sockets = online.get(fid);
        if (!sockets) continue;
        for (const sid of sockets) io.to(sid).emit("presence:update", { userId: user.id, online: true });
      }
    }

    // Auto-join the global + trade-offer channels.
    socket.join(GLOBAL_CHANNEL);
    socket.join(TRADE_CHANNEL);

    // One area channel per socket. Joining a new `area:` room leaves
    // any previously-joined area room, so a user can't sit in every
    // area at once and silently scrape every region's local chat.
    let currentAreaChannel: string | null = null;
    socket.on("chat:join", ({ channelId }: { channelId: string }) => {
      if (typeof channelId !== "string") return;
      if (!canAccessChannel(channelId, user.id)) return;
      if (channelId.startsWith("area:")) {
        if (currentAreaChannel && currentAreaChannel !== channelId) {
          socket.leave(currentAreaChannel);
        }
        currentAreaChannel = channelId;
      }
      socket.join(channelId);
    });

    socket.on("chat:leave", ({ channelId }: { channelId: string }) => {
      if (typeof channelId !== "string") return;
      if (channelId === currentAreaChannel) currentAreaChannel = null;
      socket.leave(channelId);
    });

    // Send a chat message. Persist + broadcast.
    socket.on(
      "chat:send",
      async (
        { channelId, content, kind, meta }: {
          channelId: string; content: string;
          kind?: string; meta?: { offering?: string; wanting?: string };
        },
        ack?: (r: any) => void,
      ) => {
        if (typeof channelId !== "string" || typeof content !== "string") {
          ack?.({ ok: false, error: "bad payload" });
          return;
        }
        if (!chatLimiter.consume(user.id)) {
          ack?.({ ok: false, error: "rate_limited" });
          return;
        }
        // Strip control / RTL-override chars before persisting. React
        // escapes on render, but a unicode ‮ would visually flip
        // the rest of a message and survive into the DB; trim it out.
        // Applied to every user-supplied text field that actually
        // renders somewhere, not just `content` — meta.offering/wanting
        // render straight into TradeOfferCard the same way and are
        // just as spoofable if this were skipped for them.
        const sanitize = (s: string) => s.replace(/[\x00-\x1f\x7f‮]/g, "").trim();
        const trimmed = sanitize(content).slice(0, 500);
        if (!trimmed) {
          ack?.({ ok: false, error: "empty" });
          return;
        }
        if (!canAccessChannel(channelId, user.id)) {
          ack?.({ ok: false, error: "forbidden" });
          return;
        }
        // A player socket may only ever set "tradeOffer", and only when
        // posting to the trade channel itself — "announcement"/"giveaway"
        // are admin-only and set directly by server/src/routes/admin.ts,
        // never reachable from this client-facing path. Without the
        // channel check, a crafted emit could inject a fully-functional
        // trade-offer card (complete with a working Open Trade button)
        // into Global, an area room, or a DM.
        const safeKind = kind === "tradeOffer" && channelId === TRADE_CHANNEL ? "tradeOffer" : "user";
        let safeMeta: string | null = null;
        if (safeKind === "tradeOffer") {
          const offering = sanitize(typeof meta?.offering === "string" ? meta.offering : "").slice(0, 120);
          const wanting = sanitize(typeof meta?.wanting === "string" ? meta.wanting : "").slice(0, 120);
          if (!offering || !wanting) {
            ack?.({ ok: false, error: "offering and wanting are both required" });
            return;
          }
          safeMeta = JSON.stringify({ offering, wanting });
        }
        // For DMs, ensure the participants are actually friends.
        const dm = parseDmChannel(channelId);
        if (dm) {
          const other = dm.a === user.id ? dm.b : dm.a;
          // Look up the relationship in either direction. Treat blocks
          // as "not found" — the blocker shouldn't be DM-able, and we
          // don't leak whether you're blocked vs simply not friends.
          const rel = await prisma.friend.findFirst({
            where: {
              OR: [
                { requesterId: user.id, receiverId: other },
                { requesterId: other, receiverId: user.id },
              ],
            },
          });
          if (!rel || rel.status !== "accepted") {
            ack?.({ ok: false, error: "not friends" });
            return;
          }
        }

        const stored = await prisma.chatMessage.create({
          data: { channelId, userId: user.id, content: trimmed, kind: safeKind, meta: safeMeta },
          include: {
            user: { select: { id: true, username: true, name: true, accountLevel: true, isAdmin: true } },
          },
        });
        const payload = {
          id: stored.id,
          channelId,
          content: stored.content,
          kind: stored.kind,
          meta: stored.meta ? JSON.parse(stored.meta) : null,
          createdAt: stored.createdAt,
          user: stored.user,
        };
        // Broadcast to the room (sender included; client de-dupes by id).
        io.to(channelId).emit("chat:message", payload);
        // For DMs, also push to the other user's personal sockets if they
        // haven't joined the room yet.
        if (dm) {
          const other = dm.a === user.id ? dm.b : dm.a;
          const sockets = online.get(other);
          if (sockets) {
            for (const sid of sockets) io.to(sid).emit("chat:message", payload);
          }
        }
        ack?.({ ok: true, id: stored.id });
      }
    );

    // ── Trade events ─────────────────────────────────────────────────
    // Helpers shared across handlers below. Co-located so they capture
    // `socket`/`user`/`io` from the connection scope.
    const sendToUser = (userId: string, event: string, payload: unknown) => {
      const sockets = online.get(userId);
      if (!sockets) return;
      for (const sid of sockets) io.to(sid).emit(event, payload);
    };
    const otherSide = (t: Trade) => (t.a.userId === user.id ? t.b : t.a);
    const mySide = (t: Trade) => (t.a.userId === user.id ? t.a : t.b);
    const cancelTrade = (t: Trade, reason: string) => {
      if (t.status === "completed" || t.status === "cancelled") return;
      t.status = "cancelled";
      clearTimeout(t.expiryTimer);
      sendToUser(t.a.userId, "trade:cancelled", { tradeId: t.id, reason });
      sendToUser(t.b.userId, "trade:cancelled", { tradeId: t.id, reason });
      // Delete after a beat so any in-flight ack acks go through.
      setTimeout(() => trades.delete(t.id), 1_000);
    };
    const tryFinalize = async (t: Trade) => {
      // Both sides must (a) be locked and (b) have an offer to swap.
      if (!(t.a.locked && t.b.locked && t.a.offer && t.b.offer)) return;

      // ── Anti-cheat: ownership verification ─────────────────────────
      // The client's offer payload is untrusted — a malicious client can
      // claim to be sending any Pokemon, including ones it doesn't own
      // (perfect-IV shiny Mewtwo, etc.). Before relaying the swap, look
      // up the offered mon BY ID in the player's current state and use
      // THAT (not the offer payload) as the canonical version we ship.
      //
      // Source for the lookup, in priority order:
      //   1. The `liveSnapshot` the client attached to trade:lock — this
      //      is the freshest possible state, written at the same instant
      //      the player clicked Lock. Eliminates the autosave/lock race
      //      that caused the Haunter→Gastly bug (DB had pre-evolution
      //      Gastly because the autosave hadn't flushed yet).
      //   2. The DB saveData — fallback when the client didn't send a
      //      snapshot (older clients, or snapshot failed validation).
      const aId = String(t.a.offer.id);
      const bId = String(t.b.offer.id);
      // Always pull DB saveData as a fallback even when liveSnapshot
      // exists. The snapshot is authoritative when present (covers
      // the autosave/lock race for trade-evolution mons), but if the
      // snapshot was validator-rejected mid-flight, dropped, or the
      // offered id was moved between party/box between snapshot
      // capture and lock, the DB still has the canonical source of
      // truth. One extra read per lock — negligible cost, eliminates
      // the "Cannot be verified as the owner" dead-end seen by
      // veterans whose saves stalled at the MAX_BOX validator cap.
      const [aRow, bRow] = await Promise.all([
        prisma.user.findUnique({ where: { id: t.a.userId }, select: { saveData: true } }),
        prisma.user.findUnique({ where: { id: t.b.userId }, select: { saveData: true } }),
      ]);
      const findMonInSave = (save: unknown, id: string): TradeOffer | null => {
        if (!save || typeof save !== "object") return null;
        const s = save as { party?: unknown; box?: unknown };
        const candidates: unknown[] = [
          ...(Array.isArray(s.party) ? s.party : []),
          ...(Array.isArray(s.box) ? s.box : []),
        ];
        for (const c of candidates) {
          if (c && typeof c === "object" && (c as { id?: unknown }).id === id) {
            return c as TradeOffer;
          }
        }
        return null;
      };
      const findMon = (
        snapshot: { party?: unknown; box?: unknown } | null | undefined,
        saveDataJson: string | null,
        id: string,
      ): TradeOffer | null => {
        if (snapshot) {
          const m = findMonInSave(snapshot, id);
          if (m) return m;
        }
        if (saveDataJson) {
          try {
            return findMonInSave(JSON.parse(saveDataJson), id);
          } catch { /* malformed — treat as not found */ }
        }
        return null;
      };
      const aCanonical = findMon(t.a.liveSnapshot, aRow?.saveData ?? null, aId);
      const bCanonical = findMon(t.b.liveSnapshot, bRow?.saveData ?? null, bId);
      if (!aCanonical || !bCanonical) {
        // Either side claimed a mon they don't own — abort the trade.
        cancelTrade(
          t,
          !aCanonical
            ? `${t.a.username} couldn't be verified as the owner of the offered Pokémon.`
            : `${t.b.username} couldn't be verified as the owner of the offered Pokémon.`
        );
        return;
      }
      // Block trading the offered mon if it would leave the player with
      // an empty party. Same source priority as findMon: live snapshot
      // first, DB saveData fallback. partyOf returns null when neither
      // source has a usable party.
      const partyOf = (
        snapshot: { party?: unknown } | null | undefined,
        saveDataJson: string | null,
      ): unknown[] | null => {
        if (snapshot && Array.isArray(snapshot.party)) return snapshot.party;
        if (!saveDataJson) return null;
        try {
          const save = JSON.parse(saveDataJson);
          return Array.isArray(save?.party) ? save.party : null;
        } catch { return null; }
      };
      const sideHasOtherMons = (party: unknown[] | null, id: string): boolean =>
        !!party && party.some((p) => p && typeof p === "object" && (p as { id?: unknown }).id !== id);
      const aParty = partyOf(t.a.liveSnapshot, aRow?.saveData ?? null);
      const bParty = partyOf(t.b.liveSnapshot, bRow?.saveData ?? null);
      if (!sideHasOtherMons(aParty, aId)) {
        cancelTrade(t, `${t.a.username} would be left with no Pokémon — trade refused.`);
        return;
      }
      if (!sideHasOtherMons(bParty, bId)) {
        cancelTrade(t, `${t.b.username} would be left with no Pokémon — trade refused.`);
        return;
      }

      t.status = "completed";
      clearTimeout(t.expiryTimer);
      // Each side gets the OTHER side's CANONICAL mon (i.e. what the
      // server confirmed they actually own).
      sendToUser(t.a.userId, "trade:complete", {
        tradeId: t.id,
        sentMonId: aId,
        received: bCanonical,
        otherUser: { id: t.b.userId, username: t.b.username },
      });
      sendToUser(t.b.userId, "trade:complete", {
        tradeId: t.id,
        sentMonId: bId,
        received: aCanonical,
        otherUser: { id: t.a.userId, username: t.a.username },
      });
      // Persist the completed trade so the admin dashboard can review
      // history (the live trade flow is in-memory only). Fire-and-
      // forget — failure here mustn't break the swap that already
      // shipped to both clients. Snapshot the mons + usernames AT
      // trade time so a later rename / account delete preserves
      // history for the surviving counterpart.
      prisma.tradeRecord
        .create({
          data: {
            userAId: t.a.userId,
            userAUsername: t.a.username,
            userASentMon: JSON.stringify(aCanonical),
            userASentSpecies: String((aCanonical as { speciesKey?: string }).speciesKey ?? ""),
            userASentLevel: Number((aCanonical as { level?: number }).level ?? 0),
            userBId: t.b.userId,
            userBUsername: t.b.username,
            userBSentMon: JSON.stringify(bCanonical),
            userBSentSpecies: String((bCanonical as { speciesKey?: string }).speciesKey ?? ""),
            userBSentLevel: Number((bCanonical as { level?: number }).level ?? 0),
          },
        })
        .catch((e) => {
          console.error("[trade] failed to persist record", { tradeId: t.id, err: String(e) });
        });
      setTimeout(() => trades.delete(t.id), 5_000);
    };

    // ── Auction room ────────────────────────────────────────────────
    // Join/leave a per-auction room so bid updates reach everyone
    // currently viewing that listing in real time. Placing a bid itself
    // goes over HTTP (routes/auctions.ts) — this is purely for the
    // read-side live broadcast, same split as the gift-announcement
    // chat card (HTTP mutation, socket side-effect).
    socket.on("auction:watch", ({ auctionId }: { auctionId: string }) => {
      if (typeof auctionId === "string" && auctionId) socket.join(`auction:${auctionId}`);
    });
    socket.on("auction:unwatch", ({ auctionId }: { auctionId: string }) => {
      if (typeof auctionId === "string" && auctionId) socket.leave(`auction:${auctionId}`);
    });

    // A stream client reporting back what it did with an admin remote command,
    // so the dashboard can show "✗ that town isn't unlocked" instead of a
    // misleading "Sent".
    socket.on("stream:command:result", (p: { kind?: unknown; ok?: unknown; message?: unknown }) => {
      if (!p || typeof p !== "object") return;
      recordCommandResult(user.id, {
        kind: String(p.kind ?? "?").slice(0, 32),
        ok: !!p.ok,
        message: String(p.message ?? "").slice(0, 200),
      });
    });

    // Send an invite to another user. They'll see a toast with accept/decline.
    socket.on(
      "trade:invite",
      async ({ toUserId }: { toUserId: string }, ack?: (r: any) => void) => {
        if (user.isStream) { ack?.({ ok: false, error: "stream_restricted" }); return; }
        if (typeof toUserId !== "string" || !toUserId || toUserId === user.id) {
          ack?.({ ok: false, error: "bad target" });
          return;
        }
        if (!tradeInviteLimiter.consume(user.id)) {
          ack?.({ ok: false, error: "rate_limited" });
          return;
        }
        // One outstanding trade per user — anything in progress wins.
        for (const t of trades.values()) {
          if (
            t.status !== "completed" && t.status !== "cancelled" &&
            (t.a.userId === user.id || t.b.userId === user.id ||
             t.a.userId === toUserId || t.b.userId === toUserId)
          ) {
            ack?.({ ok: false, error: "already in a trade" });
            return;
          }
        }
        if (!online.has(toUserId)) {
          ack?.({ ok: false, error: "user is offline" });
          return;
        }
        const recipient = await prisma.user.findUnique({
          where: { id: toUserId },
          select: { id: true, username: true },
        });
        if (!recipient) {
          ack?.({ ok: false, error: "user not found" });
          return;
        }
        // Friends-only: trade invites are a real notification surface,
        // and unsolicited invites from strangers are a harassment vector.
        // Mirror the chat:send DM check, including the block-list rule.
        const rel = await prisma.friend.findFirst({
          where: {
            OR: [
              { requesterId: user.id, receiverId: toUserId },
              { requesterId: toUserId, receiverId: user.id },
            ],
          },
        });
        if (!rel || rel.status !== "accepted") {
          ack?.({ ok: false, error: "must be friends to trade" });
          return;
        }
        const id = newTradeId();
        const expiresAt = Date.now() + TRADE_INVITE_TTL_MS;
        const expiryTimer = setTimeout(() => {
          const t = trades.get(id);
          if (t) cancelTrade(t, "Trade invite expired.");
        }, TRADE_INVITE_TTL_MS);
        const trade: Trade = {
          id,
          status: "invited",
          a: { userId: user.id, username: user.username, offer: null, locked: false, liveSnapshot: null },
          b: { userId: recipient.id, username: recipient.username, offer: null, locked: false, liveSnapshot: null },
          expiresAt,
          expiryTimer,
        };
        trades.set(id, trade);
        sendToUser(recipient.id, "trade:invite", {
          tradeId: id,
          from: { id: user.id, username: user.username },
          expiresAt,
        });
        ack?.({ ok: true, tradeId: id, expiresAt });
      }
    );

    // Receiver responds to an invite (accept or decline).
    socket.on(
      "trade:respond",
      ({ tradeId, accept }: { tradeId: string; accept: boolean }, ack?: (r: any) => void) => {
        if (user.isStream) { ack?.({ ok: false, error: "stream_restricted" }); return; }
        const t = trades.get(tradeId);
        if (!t) { ack?.({ ok: false, error: "no such trade" }); return; }
        if (t.status !== "invited") { ack?.({ ok: false, error: "trade not pending" }); return; }
        if (t.b.userId !== user.id) { ack?.({ ok: false, error: "not the receiver" }); return; }
        if (!accept) {
          cancelTrade(t, `${user.username} declined the trade.`);
          ack?.({ ok: true });
          return;
        }
        t.status = "active";
        clearTimeout(t.expiryTimer);
        t.expiresAt = Date.now() + TRADE_ROOM_TTL_MS;
        t.expiryTimer = setTimeout(() => {
          const cur = trades.get(t.id);
          if (cur) cancelTrade(cur, "Trade timed out.");
        }, TRADE_ROOM_TTL_MS);
        const startPayload = (other: TradeSide) => ({
          tradeId: t.id,
          other: { id: other.userId, username: other.username },
          expiresAt: t.expiresAt,
        });
        sendToUser(t.a.userId, "trade:start", startPayload(t.b));
        sendToUser(t.b.userId, "trade:start", startPayload(t.a));
        ack?.({ ok: true });
      }
    );

    // Either side picks (or unsets) which Pokemon they're sending.
    socket.on(
      "trade:offer",
      ({ tradeId, offer }: { tradeId: string; offer: unknown }, ack?: (r: any) => void) => {
        if (user.isStream) { ack?.({ ok: false, error: "stream_restricted" }); return; }
        const t = trades.get(tradeId);
        if (!t || t.status !== "active") { ack?.({ ok: false, error: "trade not active" }); return; }
        const me = mySide(t);
        if (me.userId !== user.id) { ack?.({ ok: false, error: "not in trade" }); return; }
        if (!tradeActionLimiter.consume(`offer:${user.id}`)) {
          ack?.({ ok: false, error: "rate_limited" }); return;
        }
        // Validate offer shape strictly before storing/relaying. This is
        // belt-and-braces — tryFinalize replaces the offer with the
        // canonical server-side mon at lock time anyway — but it
        // prevents prototype-polluting / malformed payloads from ever
        // reaching the other client's broadcast handler.
        let cleanOffer: TradeOffer | null = null;
        if (offer !== null) {
          const parsed = TradeOfferSchema.safeParse(offer);
          if (!parsed.success) {
            ack?.({ ok: false, error: "invalid offer" }); return;
          }
          cleanOffer = parsed.data;
        }
        // Setting an offer always unlocks (the other side's lock too —
        // mainline games re-confirm if the offer changes).
        me.offer = cleanOffer;
        me.locked = false;
        otherSide(t).locked = false;
        const broadcast = {
          tradeId: t.id,
          a: { userId: t.a.userId, hasOffer: !!t.a.offer, locked: t.a.locked, offer: t.a.offer },
          b: { userId: t.b.userId, hasOffer: !!t.b.offer, locked: t.b.locked, offer: t.b.offer },
        };
        sendToUser(t.a.userId, "trade:state", broadcast);
        sendToUser(t.b.userId, "trade:state", broadcast);
        ack?.({ ok: true });
      }
    );

    // Either side toggles their lock-in. When both lock + both have an
    // offer, the server fires trade:complete.
    //
    // The lock event carries an optional `liveSnapshot` of the player's
    // current {party, box}. The client sends it so the server can pick
    // a canonical mon from the freshest possible state — saving via the
    // REST endpoint races with the lock event over socket.io and the DB
    // copy can lag a few hundred ms behind, which is what caused the
    // Haunter→Gastly bug. The snapshot is type/bound-checked with the
    // same validateSave() that the save endpoint uses; a malformed
    // snapshot is silently ignored and we fall back to DB saveData.
    socket.on(
      "trade:lock",
      (
        { tradeId, locked, liveSnapshot }:
          { tradeId: string; locked: boolean; liveSnapshot?: unknown },
        ack?: (r: any) => void,
      ) => {
        if (user.isStream) { ack?.({ ok: false, error: "stream_restricted" }); return; }
        const t = trades.get(tradeId);
        if (!t || t.status !== "active") { ack?.({ ok: false, error: "trade not active" }); return; }
        const me = mySide(t);
        if (me.userId !== user.id) { ack?.({ ok: false, error: "not in trade" }); return; }
        if (!tradeActionLimiter.consume(`lock:${user.id}`)) {
          ack?.({ ok: false, error: "rate_limited" }); return;
        }
        if (locked && !me.offer) { ack?.({ ok: false, error: "no offer set" }); return; }
        me.locked = !!locked;
        // Stash the live snapshot if it passes validation. We only need
        // {party, box} for the canonical lookup; validateSave gracefully
        // ignores fields it doesn't recognise, so a partial snapshot
        // (just party + box) is fine.
        if (locked && liveSnapshot && typeof liveSnapshot === "object") {
          const v = validateSave(liveSnapshot);
          if (v.ok) {
            me.liveSnapshot = liveSnapshot as { party?: unknown; box?: unknown };
          } else {
            me.liveSnapshot = null;
          }
        } else if (!locked) {
          me.liveSnapshot = null;
        }
        const broadcast = {
          tradeId: t.id,
          a: { userId: t.a.userId, hasOffer: !!t.a.offer, locked: t.a.locked, offer: t.a.offer },
          b: { userId: t.b.userId, hasOffer: !!t.b.offer, locked: t.b.locked, offer: t.b.offer },
        };
        sendToUser(t.a.userId, "trade:state", broadcast);
        sendToUser(t.b.userId, "trade:state", broadcast);
        // Fire-and-forget: tryFinalize is now async (it loads + validates
        // both sides' canonical save data). The ack returns immediately
        // and the actual completion fires on its own emit cycle.
        void tryFinalize(t);
        ack?.({ ok: true });
      }
    );

    // Either side cancels the trade outright.
    socket.on(
      "trade:cancel",
      ({ tradeId }: { tradeId: string }, ack?: (r: any) => void) => {
        const t = trades.get(tradeId);
        if (!t) { ack?.({ ok: false, error: "no such trade" }); return; }
        if (t.a.userId !== user.id && t.b.userId !== user.id) {
          ack?.({ ok: false, error: "not in trade" });
          return;
        }
        cancelTrade(t, `${user.username} cancelled the trade.`);
        ack?.({ ok: true });
      }
    );

    // ── PvP battle events ────────────────────────────────────────
    // Mirrors the trade-invite flow but the room hosts a @pkmn/sim
    // battle stream instead of an offer/lock state machine. Heavy
    // lifting lives in pvp.ts; the socket handlers here are thin
    // glue that does input validation + routing.
    socket.on(
      "battle:invite",
      async (
        { toUserId, team, format }: { toUserId: string; team: unknown[]; format?: BattleFormat },
        ack?: (r: any) => void,
      ) => {
        if (typeof toUserId !== "string" || !toUserId || toUserId === user.id) {
          ack?.({ ok: false, error: "bad target" }); return;
        }
        if (!Array.isArray(team) || team.length < 1 || team.length > 6) {
          ack?.({ ok: false, error: "team must be 1..6 mons" }); return;
        }
        if (!battleInviteLimiter.consume(user.id)) {
          ack?.({ ok: false, error: "rate_limited" }); return;
        }
        // Whitelist formats — friend invites can be anything-goes or
        // random50, but never tournament (those are server-spawned by
        // the bracket runner). Default to anything-goes.
        const fmt: BattleFormat = format === "random50" ? "random50" : "anything-goes";
        // One outstanding battle per user — same heuristic as trades.
        for (const room of battleRooms.values()) {
          if (
            room.status !== "completed" && room.status !== "cancelled" &&
            (room.a.userId === user.id || room.b.userId === user.id ||
             room.a.userId === toUserId || room.b.userId === toUserId)
          ) {
            ack?.({ ok: false, error: "already in a battle" }); return;
          }
        }
        if (!online.has(toUserId)) { ack?.({ ok: false, error: "user is offline" }); return; }
        const recipient = await prisma.user.findUnique({
          where: { id: toUserId },
          select: { id: true, username: true },
        });
        if (!recipient) { ack?.({ ok: false, error: "user not found" }); return; }
        // Drop the inviter from the matchmaking queue if waiting —
        // sending a friend invite implies they no longer want a
        // random match (and would also collide if both fired at
        // the same time).
        leaveQueue(user.id);
        const id = newBattleId();
        const room: BattleRoom = {
          id,
          status: "invited",
          format: fmt,
          createdAt: Date.now(),
          lastChoiceAt: Date.now(),
          a: { userId: user.id, username: user.username, team: team as never, stream: null, request: null, connected: true },
          b: { userId: recipient.id, username: recipient.username, team: [], stream: null, request: null, connected: false },
          log: [],
          stream: null,
          expiryTimer: null,
          spectators: new Set(),
        };
        battleRooms.set(id, room);
        startInviteExpiry(room, () => {
          if (room.status === "invited") {
            room.status = "cancelled";
            sendToUser(room.a.userId, "battle:cancelled", { battleId: id, reason: "Invite expired." });
            sendToUser(room.b.userId, "battle:cancelled", { battleId: id, reason: "Invite expired." });
            battleRooms.delete(id);
          }
        });
        sendToUser(recipient.id, "battle:invite", {
          battleId: id,
          from: { id: user.id, username: user.username },
          format: fmt,
          expiresAt: Date.now() + 60_000,
        });
        ack?.({ ok: true, battleId: id });
      },
    );

    // ── Random matchmaking queue ─────────────────────────────────
    // Player joins the queue with a team; server pairs them up FIFO
    // and spins up a "random50" room that auto-starts (no accept
    // step — joining the queue IS the consent). Format-level cap
    // (Lv 50) applies on simulator start.
    socket.on(
      "battle:queue",
      async ({ team }: { team: unknown[] }, ack?: (r: any) => void) => {
        if (!Array.isArray(team) || team.length < 1 || team.length > 6) {
          ack?.({ ok: false, error: "team must be 1..6 mons" }); return;
        }
        if (!battleInviteLimiter.consume(user.id)) {
          ack?.({ ok: false, error: "rate_limited" }); return;
        }
        // Don't queue if already in a battle.
        for (const room of battleRooms.values()) {
          if (
            room.status !== "completed" && room.status !== "cancelled" &&
            (room.a.userId === user.id || room.b.userId === user.id)
          ) {
            ack?.({ ok: false, error: "already in a battle" }); return;
          }
        }
        const added = joinQueue({
          userId: user.id,
          username: user.username,
          team: team as never,
          joinedAt: Date.now(),
        });
        if (!added) { ack?.({ ok: false, error: "already queued" }); return; }
        sendToUser(user.id, "battle:queue:joined", {
          position: queueIndexOf(user.id) + 1,
          queueSize: matchmakingQueue.length,
        });
        console.log("[pvp] queued", { user: user.username, queueSize: matchmakingQueue.length });

        // Try to pair via the shared helper (also called by the
        // periodic ticker). The helper handles room spawn + start +
        // error reporting; we just ack the queue-join here.
        ack?.({ ok: true });
        void tryPairAndSpawnRoom();
      },
    );

    socket.on("battle:dequeue", (_payload: unknown, ack?: (r: any) => void) => {
      const removed = leaveQueue(user.id);
      if (removed) sendToUser(user.id, "battle:queue:left", {});
      ack?.({ ok: removed });
    });

    // ── Spectator subscription ──────────────────────────────────
    // List currently-live battles. Returns [{id, format, players,
    // turnNumber, log size}] so the UI can show a live battles tab.
    // No participants' parties are exposed here — that's per-spectator
    // via battle:spectate:join.
    socket.on("battle:list", (_payload: unknown, ack?: (r: any) => void) => {
      const list = Array.from(battleRooms.values())
        .filter((r) => r.status === "active")
        .map((r) => ({
          battleId: r.id,
          format: r.format,
          a: { userId: r.a.userId, username: r.a.username },
          b: { userId: r.b.userId, username: r.b.username },
          spectatorCount: r.spectators.size,
          startedAt: r.createdAt,
          tournamentId: r.tournamentId ?? null,
        }));
      ack?.({ ok: true, battles: list });
    });

    // Join as a spectator. Server replays the entire log so far so
    // the spectator sees the full battle from the beginning, then
    // the omni-stream pump forwards new lines as they happen.
    socket.on(
      "battle:spectate:join",
      ({ battleId }: { battleId: string }, ack?: (r: any) => void) => {
        const room = battleRooms.get(battleId);
        if (!room) { ack?.({ ok: false, error: "no such battle" }); return; }
        if (room.status !== "active") { ack?.({ ok: false, error: "battle not active" }); return; }
        // Players can't spectate their own battles — they're already
        // participants. (Their UI shouldn't expose this option, but
        // guard server-side anyway.)
        if (user.id === room.a.userId || user.id === room.b.userId) {
          ack?.({ ok: false, error: "you're a participant — open your battle modal instead" }); return;
        }
        room.spectators.add(user.id);
        // Replay the log we have so far so the spectator joins
        // cleanly mid-battle.
        sendToUser(user.id, "battle:spectate:start", {
          battleId: room.id,
          format: room.format,
          a: { userId: room.a.userId, username: room.a.username },
          b: { userId: room.b.userId, username: room.b.username },
          tournamentId: room.tournamentId ?? null,
        });
        if (room.log.length > 0) {
          sendToUser(user.id, "battle:spectate:state", {
            battleId: room.id,
            chunk: room.log.join("\n"),
          });
        }
        ack?.({ ok: true });
      },
    );

    socket.on(
      "battle:spectate:leave",
      ({ battleId }: { battleId: string }, ack?: (r: any) => void) => {
        const room = battleRooms.get(battleId);
        if (!room) { ack?.({ ok: false, error: "no such battle" }); return; }
        room.spectators.delete(user.id);
        sendToUser(user.id, "battle:spectate:end", { battleId, reason: "left" });
        ack?.({ ok: true });
      },
    );

    socket.on(
      "battle:respond",
      async (
        { battleId, accept, team }: { battleId: string; accept: boolean; team?: unknown[] },
        ack?: (r: any) => void,
      ) => {
        const room = battleRooms.get(battleId);
        if (!room) { ack?.({ ok: false, error: "no such battle" }); return; }
        if (room.status !== "invited") { ack?.({ ok: false, error: "battle not pending" }); return; }
        if (room.b.userId !== user.id) { ack?.({ ok: false, error: "not the receiver" }); return; }
        if (!accept) {
          room.status = "cancelled";
          if (room.expiryTimer) clearTimeout(room.expiryTimer);
          sendToUser(room.a.userId, "battle:cancelled", { battleId, reason: `${user.username} declined the battle.` });
          sendToUser(room.b.userId, "battle:cancelled", { battleId, reason: `${user.username} declined the battle.` });
          battleRooms.delete(battleId);
          ack?.({ ok: true }); return;
        }
        if (!Array.isArray(team) || team.length < 1 || team.length > 6) {
          ack?.({ ok: false, error: "team must be 1..6 mons" }); return;
        }
        // Drop them from the matchmaking queue if waiting — accepting
        // a friend invite implies they're no longer looking for a
        // random match. Without this, the queue could pair them with
        // someone else mid-friend-battle.
        leaveQueue(user.id);
        room.b.team = team as never;
        room.b.connected = true;
        // "battle:start" opens the battle screen, so it goes inside
        // startBattle's onReady — i.e. only once the simulator has
        // accepted both teams. Emitting it up front is what turned a
        // refused matchup into a window that opened and closed by
        // itself with nothing said.
        try {
          await startBattle(io, room, sendToUser, () => {
            sendToUser(room.a.userId, "battle:start", {
              battleId, format: room.format,
              opponent: { id: room.b.userId, username: room.b.username },
              you: "a",
            });
            sendToUser(room.b.userId, "battle:start", {
              battleId, format: room.format,
              opponent: { id: room.a.userId, username: room.a.username },
              you: "b",
            });
          });
          ack?.({ ok: true });
        } catch (e) {
          room.status = "cancelled";
          const detail = e instanceof Error ? e.message : String(e);
          const reason = `Couldn't start the battle: ${detail}`;
          sendToUser(room.a.userId, "battle:cancelled", { battleId, reason });
          sendToUser(room.b.userId, "battle:cancelled", { battleId, reason });
          battleRooms.delete(battleId);
          void recordError({
            kind: "server",
            message: "pvp_start_battle_failed",
            source: "socket.battle:respond",
            stack: e instanceof Error ? e.stack ?? null : null,
            userId: user.id,
            username: user.username,
            meta: {
              battleId,
              format: room.format,
              simulatorError: detail,
              aUserId: room.a.userId, aUsername: room.a.username, aTeamSize: room.a.team.length,
              bUserId: room.b.userId, bUsername: room.b.username, bTeamSize: room.b.team.length,
            },
          });
          ack?.({ ok: false, error: reason });
        }
      },
    );

    socket.on(
      "battle:choose",
      ({ battleId, choice }: { battleId: string; choice: string }, ack?: (r: any) => void) => {
        if (!battleChoiceLimiter.consume(user.id)) {
          ack?.({ ok: false, error: "rate_limited" }); return;
        }
        const room = battleRooms.get(battleId);
        if (!room) { ack?.({ ok: false, error: "no such battle" }); return; }
        const result = applyChoice(room, user.id, choice);
        ack?.(result);
      },
    );

    socket.on(
      "battle:cancel",
      ({ battleId }: { battleId: string }, ack?: (r: any) => void) => {
        const room = battleRooms.get(battleId);
        if (!room) { ack?.({ ok: false, error: "no such battle" }); return; }
        if (room.a.userId !== user.id && room.b.userId !== user.id) {
          ack?.({ ok: false, error: "not in battle" }); return;
        }
        // Forfeit if mid-battle, otherwise just cancel the pending invite.
        if (room.status === "active") {
          room.winnerId = user.id === room.a.userId ? room.b.userId : room.a.userId;
          room.loserId = user.id;
          void endBattle(room, sendToUser, "forfeit");
        } else {
          room.status = "cancelled";
          if (room.expiryTimer) clearTimeout(room.expiryTimer);
          sendToUser(room.a.userId, "battle:cancelled", { battleId, reason: `${user.username} cancelled.` });
          sendToUser(room.b.userId, "battle:cancelled", { battleId, reason: `${user.username} cancelled.` });
          battleRooms.delete(battleId);
        }
        ack?.({ ok: true });
      },
    );

    socket.on("disconnect", async () => {
      const wasLast = removePresence(user.id, socket.id);
      if (user.sessionId) {
        const sset = socketsBySession.get(user.sessionId);
        if (sset) {
          sset.delete(socket.id);
          if (sset.size === 0) socketsBySession.delete(user.sessionId);
        }
      }
      if (wasLast) {
        // Last connection for this user is gone — broadcast updated
        // total to everyone.
        broadcastOnlineCount();
        // Flush from random matchmaking queue if waiting.
        leaveQueue(user.id);
        // Drop from any spectator sets — no-op if they weren't
        // watching anything. Cheap O(rooms) walk.
        for (const room of battleRooms.values()) {
          room.spectators.delete(user.id);
        }
        // Forfeit any active PvP battle. Disconnect = forfeit; the
        // other side gets the win instead of staring at a frozen
        // turn timer.
        for (const room of Array.from(battleRooms.values())) {
          if (room.status !== "active" && room.status !== "invited") continue;
          if (room.a.userId === user.id || room.b.userId === user.id) {
            if (room.status === "active") {
              room.winnerId = user.id === room.a.userId ? room.b.userId : room.a.userId;
              room.loserId = user.id;
              void endBattle(room, sendToUser, "forfeit");
            } else {
              // Pending invite — just cancel it.
              room.status = "cancelled";
              if (room.expiryTimer) clearTimeout(room.expiryTimer);
              const reason = `${user.username} disconnected.`;
              sendToUser(room.a.userId, "battle:cancelled", { battleId: room.id, reason });
              sendToUser(room.b.userId, "battle:cancelled", { battleId: room.id, reason });
              battleRooms.delete(room.id);
            }
          }
        }
        // If this user had an open trade, cancel it so the other side
        // gets unblocked instead of staring at a frozen lock.
        for (const t of Array.from(trades.values())) {
          if (t.status === "completed" || t.status === "cancelled") continue;
          if (t.a.userId === user.id || t.b.userId === user.id) {
            cancelTrade(t, `${user.username} disconnected.`);
          }
        }
        await prisma.user
          .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
          .catch(() => undefined);
        void recordDailyActive(user.id);
        const friends = await prisma.friend.findMany({
          where: {
            status: "accepted",
            OR: [{ requesterId: user.id }, { receiverId: user.id }],
          },
          select: { requesterId: true, receiverId: true },
        });
        const friendIds = friends.map((f) =>
          f.requesterId === user.id ? f.receiverId : f.requesterId
        );
        for (const fid of friendIds) {
          const sockets = online.get(fid);
          if (!sockets) continue;
          for (const sid of sockets) io.to(sid).emit("presence:update", { userId: user.id, online: false });
        }
      }
    });
  });

  return io;
}
