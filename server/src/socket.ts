import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { auth } from "./auth.js";
import { prisma } from "./db.js";
import { canAccessChannel, GLOBAL_CHANNEL, parseDmChannel } from "./lib/chatChannels.js";
import { makeRateLimiter } from "./lib/rateLimit.js";
import { validateSave } from "./lib/saveValidation.js";

// ── Rate limits ──────────────────────────────────────────────────────────
// Per-user limits; values are deliberate bands, not optimisations:
// - Chat: roughly one message every 1.5 s sustained, with bursts.
// - Trade invites: 5/min — discourages mass-spam invites.
// - Trade actions (offer/lock/cancel): 60/min — UI generates a few per
//   trade naturally; well above that is misuse.
const chatLimiter = makeRateLimiter({ tokens: 20, windowMs: 30_000 });
const tradeInviteLimiter = makeRateLimiter({ tokens: 5, windowMs: 60_000 });
const tradeActionLimiter = makeRateLimiter({ tokens: 60, windowMs: 60_000 });

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
  sessionId?: string;
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

// Broadcast a "chat cleared" notification to every connected socket so
// clients can wipe their cached message lists for the affected channels
// without needing a refresh. Called by the admin clear-chat endpoint.
//   scope: "public" → clear global + all area:* channels client-side
export function broadcastChatCleared(scope: "public"): void {
  if (!ioInstance) return;
  ioInstance.emit("chat:cleared", { scope });
}

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: FRONTEND_ORIGINS,
      credentials: true,
    },
  });

  // Auth gate — extract Better Auth session cookie from the handshake and
  // reject connections that aren't logged in.
  io.use(async (socket, next) => {
    try {
      const headers = new Headers();
      const cookie = socket.request.headers.cookie;
      if (cookie) headers.set("cookie", cookie);
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return next(new Error("unauthorized"));
      const sessionId = (session as any).session?.id as string | undefined;
      socket.data.user = {
        id: session.user.id,
        username: (session.user as any).username ?? session.user.email.split("@")[0],
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
  io.on("connection", async (socket) => {
    const user = socket.data.user!;
    const wasFirst = addPresence(user.id, socket.id);
    if (user.sessionId) {
      let set = socketsBySession.get(user.sessionId);
      if (!set) { set = new Set(); socketsBySession.set(user.sessionId, set); }
      set.add(socket.id);
    }

    // Mark last seen now.
    await prisma.user
      .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    // Send the current count to the freshly-connected socket so the
    // chat header has a value to show immediately, before any other
    // user comes/goes.
    socket.emit("presence:count", { count: online.size });

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

    // Auto-join the global channel.
    socket.join(GLOBAL_CHANNEL);

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
      async ({ channelId, content }: { channelId: string; content: string }, ack?: (r: any) => void) => {
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
        const trimmed = content
          .replace(/[ -‮]/g, "")
          .trim()
          .slice(0, 500);
        if (!trimmed) {
          ack?.({ ok: false, error: "empty" });
          return;
        }
        if (!canAccessChannel(channelId, user.id)) {
          ack?.({ ok: false, error: "forbidden" });
          return;
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
          data: { channelId, userId: user.id, content: trimmed },
          include: {
            user: { select: { id: true, username: true, name: true, accountLevel: true } },
          },
        });
        const payload = {
          id: stored.id,
          channelId,
          content: stored.content,
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
      const [aRow, bRow] = await Promise.all([
        t.a.liveSnapshot
          ? Promise.resolve(null)
          : prisma.user.findUnique({ where: { id: t.a.userId }, select: { saveData: true } }),
        t.b.liveSnapshot
          ? Promise.resolve(null)
          : prisma.user.findUnique({ where: { id: t.b.userId }, select: { saveData: true } }),
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
      setTimeout(() => trades.delete(t.id), 5_000);
    };

    // Send an invite to another user. They'll see a toast with accept/decline.
    socket.on(
      "trade:invite",
      async ({ toUserId }: { toUserId: string }, ack?: (r: any) => void) => {
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
