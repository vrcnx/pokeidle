// ADVERSARIAL: try to print currency through the PvP ladder faucet.
//
// tests/pvpLadderWiring.test.ts proves the hook is wired correctly from
// hand-built room literals. This file attacks it instead, and it does two
// things that file cannot:
//
//   1. It drives the REAL socket.ts — battle:bot and battle:queue over a real
//      socket.io server, played to a real KO by the real simulator — with
//      PVP_LADDER_REWARDS=1. A bot room built by a test is only as good as the
//      test author's copy of socket.ts; a bot room built BY socket.ts is the
//      actual artefact.
//   2. Its fake Postgres models ROW LOCKS and READ COMMITTED, not
//      snapshot/restore, so "the cash bonus is arbitrated by a conditional
//      upsert, not by arithmetic" is a claim two concurrent transactions can
//      actually falsify.
//
// It also enforces every CHECK and FK the migrations declare, so a payment that
// only works because the fake is lenient fails here.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const h = vi.hoisted(() => {
  const state = {
    users: new Map<string, { saveVersion: number }>(),
    ratings: new Map<string, { rating: number; peakRating: number }>(),
    earns: [] as any[],
    bonusClaims: [] as any[],
    milestones: [] as any[],
    baselines: [] as any[],
    grants: [] as any[],
    matches: [] as any[],
    errors: [] as any[],
    /** Set false to simulate migration 20260730130000 not being applied. */
    baselineTableExists: true,
    nextId: 1,
  };

  // ── Row locks ──────────────────────────────────────────────────────
  // Postgres blocks a second INSERT … ON CONFLICT on a key another
  // uncommitted transaction already holds, and holds the lock to commit. That
  // blocking IS the exactly-once and once-per-cooldown guarantee, so the fake
  // has to have it or the concurrency tests prove nothing.
  const locks = new Map<string, Promise<void>>();
  async function withKey<T>(key: string, held: Promise<void>, fn: () => Promise<T>): Promise<T> {
    while (locks.has(key)) await locks.get(key);
    locks.set(key, held.catch(() => {}).then(() => { locks.delete(key); }));
    return fn();
  }

  function makeClient(tx: null | { done: Promise<void>; undo: (() => void)[] }) {
    const journal = (fn: () => void) => { if (tx) tx.undo.push(fn); };
    const client: any = {
      user: {
        findMany: async ({ where }: any) =>
          (where?.id?.in ?? [])
            .filter((id: string) => state.users.has(id))
            .map((id: string) => ({ id, saveVersion: state.users.get(id)!.saveVersion })),
        findUnique: async ({ where }: any) =>
          state.users.has(where.id)
            ? {
                id: where.id, username: where.id, isAdmin: false,
                bannedUntil: null, saveData: null,
                saveVersion: state.users.get(where.id)!.saveVersion,
              }
            : null,
        update: async () => { throw new Error("the reward must never touch the save"); },
      },
      pendingGrant: {
        create: async ({ data }: any) => {
          const row = { id: "g" + state.nextId++, ...data };
          state.grants.push(row);
          journal(() => { const i = state.grants.indexOf(row); if (i >= 0) state.grants.splice(i, 1); });
          return { id: row.id };
        },
      },
      pvpMatch: { create: async ({ data }: any) => { state.matches.push(data); return data; } },
      friend: { findMany: async () => [], findFirst: async () => null },
      chatMessage: { create: async (a: any) => a },
      dailyActive: { upsert: async () => ({}), create: async () => ({}) },
      playerRating: {
        upsert: async ({ where }: any) => {
          const r = state.ratings.get(where.userId) ?? { rating: 1000, peakRating: 1000 };
          state.ratings.set(where.userId, r);
          return { userId: where.userId, ...r };
        },
        update: async ({ where, data }: any) => {
          const r = state.ratings.get(where.userId) ?? { rating: 1000, peakRating: 1000 };
          state.ratings.set(where.userId, {
            rating: typeof data.rating === "number" ? data.rating : r.rating,
            peakRating: typeof data.peakRating === "number" ? data.peakRating : r.peakRating,
          });
          return {};
        },
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join("?");
        if (sql.includes('FROM "PvpLadderEarn" e')) {
          const [opponentId, , bonusCutoff, userId, windowStart] = values;
          const mine = state.earns.filter(
            (e) => e.userId === userId && e.createdAt.getTime() > windowStart.getTime(),
          );
          return [{
            bp_window: mine.reduce((a, e) => a + e.bp, 0),
            milestone_window: mine.reduce((a, e) => a + e.milestoneBp, 0),
            meetings: mine.filter((e) => e.opponentUserId === opponentId).length,
            bonus_on_cooldown: state.bonusClaims.filter(
              (b) => b.userId === userId && b.claimedAt.getTime() > bonusCutoff.getTime(),
            ).length,
          }];
        }
        if (sql.includes('FROM "PvpBadgeMilestone"')) {
          return state.milestones.filter((m) => m.userId === values[0]).map((m) => ({ threshold: m.threshold }));
        }
        if (sql.includes('FROM "PvpLadderBaseline"')) {
          if (!state.baselineTableExists) {
            throw new Error('42P01: relation "PvpLadderBaseline" does not exist');
          }
          return state.baselines.filter((b) => values.includes(b.userId));
        }
        throw new Error(`unmodelled query: ${sql}`);
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join("?");
        const held = tx?.done ?? Promise.resolve();

        if (sql.includes('INSERT INTO "PvpLadderEarn"')) {
          // `tier` is captured rather than skipped: it records WHICH rating
          // priced the payment, which is how a clamped payout stays visible in
          // the audit instead of only in the amount.
          const [id, matchId, userId, opponentUserId, , provenance, result, endReason,
            turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
            bpBeforeDecay, tier, createdAt] = values;
          // FKs to User(id). A synthetic bot id raises 23503 here.
          for (const fk of [userId, opponentUserId]) {
            if (!state.users.has(fk)) throw new Error(`23503 FK violation: ${fk} is not a User`);
          }
          // CHECK PvpLadderEarn_not_self
          if (userId === opponentUserId) throw new Error("23514 PvpLadderEarn_not_self");
          return withKey(`earn:${matchId}:${userId}`, held, async () => {
            if (state.earns.some((e) => e.matchId === matchId && e.userId === userId)) return 0;
            const row = {
              id, matchId, userId, opponentUserId, provenance, result, endReason,
              turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
              bpBeforeDecay, tier,
              bp: 0, milestoneBp: 0, moneyAwarded: 0, winBonusPaid: false, createdAt,
            };
            state.earns.push(row);
            journal(() => { const i = state.earns.indexOf(row); if (i >= 0) state.earns.splice(i, 1); });
            return 1;
          });
        }

        if (sql.includes('INSERT INTO "PvpWinBonusClaim"')) {
          const [userId, claimedAt, , , , , , cutoff] = values;
          if (!state.users.has(userId)) throw new Error(`23503 FK violation: ${userId}`);
          return withKey(`bonus:${userId}`, held, async () => {
            const existing = state.bonusClaims.find((b) => b.userId === userId);
            if (!existing) {
              const row = { userId, claimedAt };
              state.bonusClaims.push(row);
              journal(() => {
                const i = state.bonusClaims.indexOf(row);
                if (i >= 0) state.bonusClaims.splice(i, 1);
              });
              return 1;
            }
            if (existing.claimedAt.getTime() > cutoff.getTime()) return 0;
            const prev = existing.claimedAt;
            existing.claimedAt = claimedAt;
            journal(() => { existing.claimedAt = prev; });
            return 1;
          });
        }

        if (sql.includes('INSERT INTO "PvpBadgeMilestone"')) {
          const [userId, threshold, ratingBefore, , bp] = values;
          if (!state.users.has(userId)) throw new Error(`23503 FK violation: ${userId}`);
          // CHECK PvpBadgeMilestone_crossed
          if (!(ratingBefore < threshold)) throw new Error("23514 PvpBadgeMilestone_crossed");
          if (bp < 0) throw new Error("23514 PvpBadgeMilestone_nonneg");
          return withKey(`ms:${userId}:${threshold}`, held, async () => {
            if (state.milestones.some((m) => m.userId === userId && m.threshold === threshold)) return 0;
            const row = { userId, threshold, bp };
            state.milestones.push(row);
            journal(() => { const i = state.milestones.indexOf(row); if (i >= 0) state.milestones.splice(i, 1); });
            return 1;
          });
        }

        if (sql.includes('INSERT INTO "PvpLadderBaseline"')) {
          if (!state.baselineTableExists) {
            throw new Error('42P01: relation "PvpLadderBaseline" does not exist');
          }
          const [ratingAfter, createdAt, userId] = values;
          const pr = state.ratings.get(userId);
          if (!pr) return 0;                       // INSERT … SELECT FROM PlayerRating
          return withKey(`bl:${userId}`, held, async () => {
            if (state.baselines.some((b) => b.userId === userId)) return 0;
            const row = {
              userId, rating: Math.max(pr.peakRating, pr.rating, ratingAfter),
              source: "settle", createdAt,
            };
            state.baselines.push(row);
            journal(() => { const i = state.baselines.indexOf(row); if (i >= 0) state.baselines.splice(i, 1); });
            return 1;
          });
        }

        if (sql.includes('UPDATE "PvpLadderEarn"')) {
          const [bp, milestoneBp, moneyAwarded, winBonusPaid, grantId, id] = values;
          // CHECK PvpLadderEarn_money_needs_bonus / _nonneg
          if (moneyAwarded !== 0 && !winBonusPaid) throw new Error("23514 money_needs_bonus");
          if (bp < 0 || milestoneBp < 0 || moneyAwarded < 0) throw new Error("23514 nonneg");
          const row = state.earns.find((e) => e.id === id);
          if (row) {
            const prev = { ...row };
            Object.assign(row, { bp, milestoneBp, moneyAwarded, winBonusPaid, grantId });
            journal(() => Object.assign(row, prev));
          }
          return 1;
        }
        throw new Error(`unmodelled statement: ${sql}`);
      },
    };
    return client;
  }

  const root: any = makeClient(null);
  root.$transaction = async (fn: any) => {
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    const frame = { done, undo: [] as (() => void)[] };
    const inner = makeClient(frame);
    inner.$transaction = root.$transaction;
    try {
      const out = await fn(inner);
      return out;
    } catch (e) {
      // ROLLBACK, in reverse order.
      for (const u of frame.undo.reverse()) u();
      throw e;
    } finally {
      release();
    }
  };

  return {
    state,
    prisma: root,
    recordError: vi.fn(async (e: any) => { state.errors.push(e); }),
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: h.recordError }));
vi.mock("../src/auth.js", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const m = /uid=([A-Za-z0-9_]+)/.exec(headers.get("cookie") ?? "");
        if (!m) return null;
        return {
          user: { id: m[1], email: `${m[1]}@example.test`, username: m[1] },
          session: { id: `sess_${m[1]}` },
        };
      },
    },
  },
}));
vi.mock("../src/lib/presence.js", () => ({ recordDailyActive: vi.fn(async () => {}) }));
vi.mock("../src/lib/announcements.js", () => ({
  getLiveAnnouncement: vi.fn(async () => null),
  toPublic: (x: unknown) => x,
}));

import { attachSocketServer } from "../src/socket.js";
import {
  battleRooms, endBattle, flushPvpPersists, matchmakingQueue,
  stopMatchmakingTicker, type BattleRoom,
} from "../src/pvp.js";
import {
  LADDER_BP_CAP_PER_WINDOW, LADDER_BP_ITEM_ID, LADDER_BP_LOSS, LADDER_BP_WIN,
  LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW, LADDER_MILESTONE_BP_CAP_PER_WINDOW,
  LADDER_WIN_BONUS_BP, LADDER_WIN_BONUS_COOLDOWN_MS, settleLadderEarn,
} from "../src/lib/pvpLadder.js";
import { PVP_BADGE_TIERS, PVP_MILESTONE_BP_LIFETIME_TOTAL } from "../src/lib/pvpBadge.js";
import { parsePrizes } from "../src/lib/giveaway.js";

const BRONZE = PVP_BADGE_TIERS[0].winBonusMoney;
const DIAMOND = PVP_BADGE_TIERS[4].winBonusMoney;

function owed(userId: string): { bp: number; money: number } {
  let bp = 0, money = 0;
  for (const g of h.state.grants.filter((x) => x.userId === userId)) {
    for (const p of parsePrizes(g.prizes)) {
      if (p.kind === "item" && p.itemId === LADDER_BP_ITEM_ID) bp += p.quantity;
      if (p.kind === "money") money += p.amount;
    }
  }
  return { bp, money };
}
const totalMinted = () => h.state.grants.reduce(
  (acc, g) => {
    for (const p of parsePrizes(g.prizes)) {
      if (p.kind === "item" && p.itemId === LADDER_BP_ITEM_ID) acc.bp += p.quantity;
      if (p.kind === "money") acc.money += p.amount;
    }
    return acc;
  },
  { bp: 0, money: 0 },
);

function addUser(id: string, saveVersion = 7) { h.state.users.set(id, { saveVersion }); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  const s = h.state;
  s.users = new Map(); addUser("uA"); addUser("uB");
  s.ratings = new Map();
  s.earns = []; s.bonusClaims = []; s.milestones = []; s.baselines = [];
  s.grants = []; s.matches = []; s.errors = [];
  s.baselineTableExists = true;
  h.recordError.mockClear();
  process.env.PVP_LADDER_REWARDS = "1";
});
afterEach(() => { delete process.env.PVP_LADDER_REWARDS; });

// ════════════════════════════════════════════════════════════════════
// PART 1 — THE REAL SOCKET SERVER, REAL SIMULATOR, FAUCET OPEN
// ════════════════════════════════════════════════════════════════════
class Sio {
  private ws!: WebSocket;
  private nextAck = 1;
  private acks = new Map<number, (v: any) => void>();
  readonly received: { ev: string; payload: any }[] = [];

  static async connect(port: number, uid: string): Promise<Sio> {
    const c = new Sio(); await c.open(port, uid); return c;
  }
  private open(port: number, uid: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new (WebSocket as any)(
        `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
        { headers: { cookie: `uid=${uid}` } },
      );
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5_000);
      this.ws.onerror = (e: any) => { clearTimeout(timer); reject(new Error("ws " + String(e?.message ?? e))); };
      this.ws.onmessage = (m: MessageEvent) => {
        const d = String(m.data);
        if (d[0] === "0") { this.ws.send("40"); return; }
        if (d === "2") { this.ws.send("3"); return; }
        if (d.startsWith("40")) { clearTimeout(timer); resolve(); return; }
        if (d.startsWith("44")) { clearTimeout(timer); reject(new Error("ns connect error " + d)); return; }
        if (d.startsWith("43")) {
          const mm = /^43(\d+)(\[.*\])$/.exec(d);
          if (mm) { const cb = this.acks.get(Number(mm[1])); this.acks.delete(Number(mm[1])); cb?.(JSON.parse(mm[2])[0]); }
          return;
        }
        if (d.startsWith("42")) {
          const mm = /^42(\d*)(\[.*\])$/.exec(d);
          if (!mm) return;
          const arr = JSON.parse(mm[2]);
          this.received.push({ ev: arr[0], payload: arr[1] });
        }
      };
    });
  }
  emitAck(ev: string, payload?: unknown, timeoutMs = 5_000): Promise<any> {
    const id = this.nextAck++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ack timeout ${ev}`)), timeoutMs);
      this.acks.set(id, (v) => { clearTimeout(t); resolve(v); });
      this.ws.send("42" + id + JSON.stringify(payload === undefined ? [ev] : [ev, payload]));
    });
  }
  async waitFor(ev: string, timeoutMs = 6_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find((r) => r.ev === ev);
      if (hit) return hit.payload;
      if (Date.now() > deadline) throw new Error(`never saw ${ev}; saw ${this.received.map((r) => r.ev).join(",")}`);
      await sleep(10);
    }
  }
  close(): void { try { this.ws.close(); } catch { /* */ } }
}

describe("the real socket server, with the faucet OPEN", () => {
  let server: http.Server;
  let port = 0;
  const open: Sio[] = [];

  beforeAll(async () => {
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
    attachSocketServer(server);
  });
  afterAll(async () => {
    stopMatchmakingTicker();
    for (const c of open) c.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  afterEach(async () => {
    for (const c of open.splice(0)) c.close();
    await sleep(60);
    for (const r of Array.from(battleRooms.values())) {
      if (r.status === "active" || r.status === "invited") await endBattle(r, undefined, "cancelled");
      if (r.expiryTimer) clearInterval(r.expiryTimer);
      battleRooms.delete(r.id);
    }
    matchmakingQueue.length = 0;
    await flushPvpPersists();
  });

  const connect = async (uid: string) => { const c = await Sio.connect(port, uid); open.push(c); return c; };
  const team = (id: string) => [{
    id, speciesKey: "pikachu", name: "Pika", level: 50, moves: [{ id: "thunderShock" }],
  }];

  async function playToFinish(room: BattleRoom, clients: Sio[], battleId: string, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (room.status === "active" && Date.now() < deadline) {
      for (const c of clients) {
        await c.emitAck("battle:choose", { battleId, choice: "default" }).catch(() => {});
      }
      await sleep(30);
    }
    await flushPvpPersists();
  }

  it("PRINT ATTEMPT: a real bot battle, fought to a real KO, mints nothing", async () => {
    addUser("bZ1");
    const A = await connect("bZ1");
    const ack = await A.emitAck("battle:bot", { team: team("p1") });
    expect(ack.ok).toBe(true);
    const room = battleRooms.get(ack.battleId)!;
    expect(room.b.isBot).toBe(true);
    expect(room.ladderProvenance).toBeUndefined();   // the gate, at the source
    await A.waitFor("battle:start");
    await A.waitFor("battle:state");

    await playToFinish(room, [A], ack.battleId);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("ko");
    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(true);

    // Nothing minted, nothing recorded, and no error either — an unpaid bot
    // battle is the NORMAL answer.
    expect(h.state.grants).toEqual([]);
    expect(h.state.earns).toEqual([]);
    expect(h.state.bonusClaims).toEqual([]);
    expect(h.state.errors).toEqual([]);
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
  }, 40_000);

  it("…and the faucet really was open: a real QUEUED battle mints", async () => {
    // Without this the test above passes for the wrong reason.
    addUser("qZ1"); addUser("qZ2");
    const A = await connect("qZ1");
    const B = await connect("qZ2");
    await A.emitAck("battle:queue", { team: team("p2") });
    await B.emitAck("battle:queue", { team: team("p3") });
    const start = await A.waitFor("battle:start");
    const room = battleRooms.get(start.battleId)!;
    expect(room.ladderProvenance).toBe("queue");
    await A.waitFor("battle:state");
    // Backdate so the 20 s floor is met by a battle the simulator finishes in ~1 s.
    room.createdAt = Date.now() - 5 * 60_000;

    await playToFinish(room, [A, B], start.battleId);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("ko");

    const minted = totalMinted();
    expect(minted.money).toBe(BRONZE);
    expect(minted.bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP + LADDER_BP_LOSS);
    expect(h.state.earns).toHaveLength(2);
    expect(h.state.earns.every((e) => e.provenance === "queue")).toBe(true);
  }, 40_000);

  it("PRINT ATTEMPT: a LONG bot battle — past both the turn and duration floors", async () => {
    // The two floors are the only gates a bot battle could plausibly be
    // failing on by accident, so remove them: backdate createdAt past
    // LADDER_MIN_DURATION_MS and let the sim run many turns. Still zero.
    addUser("bZ2");
    const A = await connect("bZ2");
    const ack = await A.emitAck("battle:bot", { team: team("pLong") });
    expect(ack.ok).toBe(true);
    const room = battleRooms.get(ack.battleId)!;
    await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    room.createdAt = Date.now() - 30 * 60_000;
    await playToFinish(room, [A], ack.battleId);
    expect(room.status).toBe("completed");
    // Half an hour of "duration": the 20 s floor is provably not what refuses
    // this. (The simulator settles a 1-v-1 Pikachu mirror in 2 turns, so the
    // TURN floor would also refuse it — which is why the unit-level bot rooms
    // above carry a six-turn log and are refused anyway.)
    expect(Date.now() - room.createdAt).toBeGreaterThan(20_000);
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.earns).toEqual([]);
    expect(h.state.ratings.size).toBe(0);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════
// PART 2 — endBattle-level attacks
// ════════════════════════════════════════════════════════════════════
let seq = 0;
function room(over: Partial<BattleRoom> = {}, botSeat = false): BattleRoom {
  const id = `b_mp${++seq}`;
  const r: BattleRoom = {
    id, status: "active", format: "random50",
    createdAt: Date.now() - 5 * 60_000, lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "A", team: [] as never, stream: null, request: null, connected: true },
    b: botSeat
      ? {
          userId: `bot:${id}`, username: "Joey AI", team: [] as never, stream: null,
          request: null, connected: true, awayAt: null, isBot: true, botTier: "rookie" as never,
        }
      : { userId: "uB", username: "B", team: [] as never, stream: null, request: null, connected: true },
    log: ["|start", "|turn|1", "|turn|2", "|turn|3", "|turn|4", "|win|A"],
    stream: null, expiryTimer: null, spectators: new Set(),
    ...over,
  };
  battleRooms.set(r.id, r);
  return r;
}
async function finish(r: BattleRoom, reason: "ko" | "tie" | "forfeit" | "timeout" | "cancelled",
  winner: "a" | "b" | null = "a") {
  if (winner) {
    r.winnerId = winner === "a" ? r.a.userId : r.b.userId;
    r.loserId = winner === "a" ? r.b.userId : r.a.userId;
  }
  await endBattle(r, undefined, reason);
  await flushPvpPersists();
  battleRooms.delete(r.id);
}

describe("PRINT ATTEMPT: peel the bot gate one layer at a time", () => {
  // Each step is one MORE deliberate act by a future refactor. The point is
  // that no single mistake pays, and that the layers are real rather than
  // rhetorical.
  it("layer 1 — provenance forced onto a bot room: unrated, pays nothing", async () => {
    const r = room({ ladderProvenance: "queue" } as any, true);
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.earns).toEqual([]);
    expect(h.state.ratings.size).toBe(0);           // isBotRoom blocked the Elo too
  });

  it("layer 2 — …plus the durable isBot flag stripped: format is not rated, pays nothing", async () => {
    const r = room({ ladderProvenance: "queue", format: "bot" } as any, true);
    r.b.isBot = false;
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.ratings.size).toBe(0);
  });

  it("layer 3 — …plus a rated format: the account gate refuses, pays nothing", async () => {
    const r = room({ ladderProvenance: "queue", format: "random50" } as any, true);
    r.b.isBot = false;                                   // now genuinely rated
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.earns).toEqual([]);
    expect(h.state.grants).toEqual([]);
    // The rating DID move — three deliberate acts is enough to fool Elo — but
    // no currency exists.
    expect(h.state.ratings.get("uA")!.rating).toBe(1016);
    // MEASURED ORDERING, against the header's claim that the FOREIGN KEY is the
    // layer a synthetic bot id dies on: it never gets there. `saveVersion > 0`
    // (gate 3) refuses first, inside computeLadderReward, so the FK on
    // PvpLadderEarn is genuinely unreachable belt-and-braces rather than the
    // active defence. Refusals are not errors, so nothing is logged.
    expect(h.state.errors).toEqual([]);
  });

  it("layer 4 — …plus a real User row with NO accepted save: pays nothing", async () => {
    const r = room({ ladderProvenance: "queue", format: "random50" } as any, true);
    r.b.isBot = false;
    addUser(r.b.userId, 0);                              // saveVersion 0
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.earns).toEqual([]);
  });

  it("layer 5 — all FOUR acts: it pays, which is the documented residual", async () => {
    const r = room({ ladderProvenance: "queue", format: "random50" } as any, true);
    r.b.isBot = false;
    addUser(r.b.userId, 7);
    await finish(r, "ko");
    // Honest: a bot given a room-construction provenance, no isBot flag, a rated
    // format, a User row AND accepted save uploads is indistinguishable from a
    // human. Four deliberate acts, not a forgotten `if`.
    expect(totalMinted().money).toBe(BRONZE);
  });
});

describe("PRINT ATTEMPT: mutate the room mid-battle", () => {
  it("a queue room whose seat is swapped to a bot AFTER pairing pays nothing", async () => {
    const r = room({ ladderProvenance: "queue" } as any);
    r.b.isBot = true;                                    // the hostile mutation
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
  });

  it("a bot room relabelled random50 mid-battle pays nothing", async () => {
    const r = room({}, true);
    r.format = "random50";
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
  });

  it("FINDING: provenance written onto an invite room AFTER endBattle started pays nothing", async () => {
    // THE DEFECT: `provenance: room.ladderProvenance` and `matchId: room.id`
    // were read INSIDE the dynamic import's .then(), i.e. after a module load,
    // while every other reward input was frozen synchronously — so the field
    // that decides whether a bot battle pays was sampled from a mutable object
    // owned by a room that lives another five seconds. Before the fix this
    // paid 9 BP and $10,000 on an invite-shaped room.
    const r = room({ format: "random50" });              // invite shape: no provenance
    r.winnerId = "uA"; r.loserId = "uB";
    const p = endBattle(r, undefined, "ko");
    (r as any).ladderProvenance = "queue";               // the late writer
    await p;
    await flushPvpPersists();
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.earns).toEqual([]);
  });

  it("FINDING: the ledger row is keyed to the match that was FOUGHT, not to a later id", async () => {
    // Same freeze, other half: `matchId` is the idempotency key AND the
    // PendingGrant sourceId. Reading it late lets a recycled/renamed room
    // attribute a payment — and a second settle under the old id — to the
    // wrong match.
    const r = room({ ladderProvenance: "queue" } as any);
    const fought = r.id;
    r.winnerId = "uA"; r.loserId = "uB";
    const p = endBattle(r, undefined, "ko");
    r.id = "b_someone_elses_match";                      // the late writer
    await p;
    await flushPvpPersists();
    expect(h.state.earns.map((e) => e.matchId)).toEqual([fought, fought]);
    expect(h.state.grants.every((g: any) => g.sourceId === fought)).toBe(true);
  });
});

describe("PRINT ATTEMPT: get paid twice for one battle", () => {
  it("two endBattle calls in the same tick pay once", async () => {
    const r = room({ ladderProvenance: "queue" } as any);
    r.winnerId = "uA"; r.loserId = "uB";
    await Promise.all([endBattle(r, undefined, "ko"), endBattle(r, undefined, "ko")]);
    await flushPvpPersists();
    expect(h.state.earns).toHaveLength(2);
    expect(owed("uA")).toEqual({ bp: LADDER_BP_WIN + LADDER_WIN_BONUS_BP, money: BRONZE });
  });

  it("two CONCURRENT settles of the same matchId pay once — the unique index blocks", async () => {
    const delta = { aDelta: 16, bDelta: -16, aRating: 1016, bRating: 984 };
    const input = {
      matchId: "m_dup", provenance: "queue", winnerId: "uA", loserId: "uB",
      endReason: "ko" as const, logLines: ["|turn|1", "|turn|2", "|turn|3"],
      durationMs: 120_000, ratingDelta: delta,
    };
    const [x, y] = await Promise.all([settleLadderEarn(input), settleLadderEarn(input)]);
    expect([x.paid, y.paid].filter(Boolean)).toHaveLength(1);
    expect([x.reason, y.reason]).toContain("already_settled");
    expect(h.state.earns).toHaveLength(2);
    expect(totalMinted().money).toBe(BRONZE);
  });

  it("a retried settle after success pays nothing more", async () => {
    const delta = { aDelta: 16, bDelta: -16, aRating: 1016, bRating: 984 };
    const input = {
      matchId: "m_retry", provenance: "queue", winnerId: "uA", loserId: "uB",
      endReason: "ko" as const, logLines: ["|turn|1", "|turn|2", "|turn|3"],
      durationMs: 120_000, ratingDelta: delta,
    };
    expect((await settleLadderEarn(input)).paid).toBe(true);
    for (let i = 0; i < 5; i++) expect((await settleLadderEarn(input)).paid).toBe(false);
    expect(totalMinted().money).toBe(BRONZE);
    expect(h.state.earns).toHaveLength(2);
  });

  it("two CONCURRENT cash claims by one account across two matches pay ONE bonus", async () => {
    // The one place a check-then-act would really cost money. socket.ts allows
    // one live battle per account, so this cannot happen today — which is
    // exactly why the guarantee must come from the row lock, not from that.
    const mk = (matchId: string, opponent: string) => ({
      matchId, provenance: "queue", winnerId: "uA", loserId: opponent,
      endReason: "ko" as const, logLines: ["|turn|1", "|turn|2", "|turn|3"],
      durationMs: 120_000,
      ratingDelta: { aDelta: 16, bDelta: -16, aRating: 1016, bRating: 984 },
    });
    addUser("uC");
    const [x, y] = await Promise.all([
      settleLadderEarn(mk("m_c1", "uB")),
      settleLadderEarn(mk("m_c2", "uC")),
    ]);
    expect(x.paid && y.paid).toBe(true);
    // BOTH matches paid BP (the cap is a soft read, and a one-match overshoot
    // costs 3 BP) but only ONE cash bonus exists.
    expect(owed("uA").money).toBe(BRONZE);
    expect(h.state.bonusClaims).toHaveLength(1);
    expect(h.state.earns.filter((e) => e.userId === "uA" && e.winBonusPaid)).toHaveLength(1);
  });
});

describe("PRINT ATTEMPT: profit from quitting, being quit on, or timing out", () => {
  for (const reason of ["forfeit", "timeout"] as const) {
    it(`${reason} pays NOBODY, in either direction`, async () => {
      await finish(room({ ladderProvenance: "queue" } as any), reason, "a");
      await finish(room({ ladderProvenance: "queue" } as any), reason, "b");
      expect(totalMinted()).toEqual({ bp: 0, money: 0 });
      expect(h.state.earns).toEqual([]);
    });
  }

  it("a cancelled battle pays nobody and is not even rated", async () => {
    await finish(room({ ladderProvenance: "queue" } as any), "cancelled", null);
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.ratings.size).toBe(0);
  });

  it("200 instant forfeit wins mint exactly zero currency", async () => {
    for (let i = 0; i < 200; i++) {
      await finish(room({ ladderProvenance: "queue" } as any), "forfeit", "a");
    }
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    expect(h.state.earns).toEqual([]);
    // …though the RATING climbs, which is the residual worth stating: a forfeit
    // is instant, needs no turns and no 20 s, and it moves Elo. Rating prices
    // the cash bonus (Bronze $10k → Diamond $200k), so this is the only way to
    // raise the ceiling. It is self-limiting against one partner: the delta
    // collapses as the gap opens.
    const solo = h.state.ratings.get("uA")!.rating;
    expect(solo).toBeGreaterThan(1000);
    expect(solo).toBeLessThan(PVP_BADGE_TIERS[3].minRating);   // 200 free wins < Platinum
  }, 30_000);

  it("MEASURED: how many thrown matches buy the $200,000 Diamond bonus", async () => {
    // The one input an abuser controls that changes the payout by 20x. Feeding
    // a main from FRESH 1000-rated alts is the best case for the attacker
    // (biggest deltas), and forfeits make each match instant and free.
    let main = 1000;
    let matches = 0;
    let altsBurned = 0;
    let alt = 1000;
    const K = 32;
    while (main < PVP_BADGE_TIERS[4].minRating && matches < 200_000) {
      const expected = 1 / (1 + Math.pow(10, (alt - main) / 400));
      const d = Math.round(K * (1 - expected));
      if (d <= 0) { alt = 1000; altsBurned++; continue; }   // this alt is spent
      main += d; alt = Math.max(0, alt - d); matches++;
    }
    // Recorded so the number is a measurement rather than an intuition.
    expect(main).toBeGreaterThanOrEqual(PVP_BADGE_TIERS[4].minRating);
    expect(matches).toBeGreaterThan(60);
    expect(altsBurned).toBeGreaterThanOrEqual(0);
    // eslint-disable-next-line no-console
    console.log(`[abuse] Diamond reached in ${matches} thrown matches, ${altsBurned} alts exhausted`);
    // …and that whole measurement is now the cost of buying a BADGE, not a
    // price. Thrown matches are invites and forfeits, so none of them is in the
    // ledger, so none of them is witnessed: an account handed a live 1700 by
    // that pump is still priced at Bronze on its next ten matchmade wins,
    // because ten real wins is all the climb this feature has actually seen.
    h.state.ratings.set("uA", { rating: 1700, peakRating: 1700 });
    h.state.baselines.push({ userId: "uA", rating: 1700, source: "migration", createdAt: new Date() });
    h.state.baselines.push({ userId: "uB", rating: 1000, source: "migration", createdAt: new Date() });
    for (let i = 0; i < 10; i++) await finish(room({ ladderProvenance: "queue" } as any), "ko", "a");
    expect(owed("uA").money).toBe(BRONZE);
    expect(owed("uA").money).not.toBe(DIAMOND);
    // The bound that used to be the ONLY bound still holds on top of it.
    expect(h.state.bonusClaims).toHaveLength(1);
  }, 30_000);

  it("a scripted sub-20s / sub-3-turn KO mints nothing", async () => {
    const r = room({ ladderProvenance: "queue" } as any);
    r.createdAt = Date.now() - 1_000;
    r.log = ["|start", "|turn|1", "|win|A"];
    await finish(r, "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
  });
});

describe("PRINT ATTEMPT: does the milestone stack still bypass the daily cap?", () => {
  it("ONE match crossing all four tiers pays at most one tier's worth", async () => {
    // Unreachable at K=32 today; the point is that the arithmetic, not the K
    // factor, is what bounds it. This is defect 2 exactly.
    const out = await settleLadderEarn({
      matchId: "m_stack", provenance: "queue", winnerId: "uA", loserId: "uB",
      endReason: "ko", logLines: ["|turn|1", "|turn|2", "|turn|3"], durationMs: 120_000,
      ratingDelta: { aDelta: 800, bDelta: -800, aRating: 1800, bRating: 200 },
    });
    expect(out.paid).toBe(true);
    const win = out.sides.find((s) => s.userId === "uA")!;
    expect(win.milestoneBp).toBeLessThanOrEqual(LADDER_MILESTONE_BP_CAP_PER_WINDOW);
    expect(win.milestoneBp).toBeLessThan(PVP_MILESTONE_BP_LIFETIME_TOTAL);   // not 90
    expect(win.bp + win.milestoneBp).toBeLessThanOrEqual(LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW);
    expect(owed("uA").bp).toBe(win.bp + win.milestoneBp);
    // …and the cash is priced at the tier actually reached, once.
    expect(owed("uA").money).toBe(DIAMOND);
  });

  it("a whole ROLLING WINDOW cannot mint more than 25 + 40 BP", async () => {
    // Climb through every threshold in many matches, staying inside one window.
    let rating = 1000;
    for (let i = 0; i < 30 && rating < 1750; i++) {
      rating += 30;
      await settleLadderEarn({
        matchId: `m_w${i}`, provenance: "queue", winnerId: "uA", loserId: "uB",
        endReason: "ko", logLines: ["|turn|1", "|turn|2", "|turn|3"], durationMs: 120_000,
        ratingDelta: { aDelta: 30, bDelta: -30, aRating: rating, bRating: 2000 - rating },
      });
    }
    const mine = h.state.earns.filter((e) => e.userId === "uA");
    const battleBp = mine.reduce((a, e) => a + e.bp, 0);
    const msBp = mine.reduce((a, e) => a + e.milestoneBp, 0);
    expect(battleBp).toBeLessThanOrEqual(LADDER_BP_CAP_PER_WINDOW);
    expect(msBp).toBeLessThanOrEqual(LADDER_MILESTONE_BP_CAP_PER_WINDOW);
    expect(battleBp + msBp).toBeLessThanOrEqual(LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW);
    expect(owed("uA").bp).toBe(battleBp + msBp);
    expect(msBp).toBeGreaterThan(0);                     // the climb really happened
  });
});

describe("PRINT ATTEMPT: would enabling this TODAY pay the four live accounts?", () => {
  // Production, read-only, 2026-07-30: four PlayerRating rows, ratings 984–1016,
  // max peakRating 1016. The first payable threshold is 1100.
  const LIVE = [
    { id: "p1", rating: 1016, peak: 1016 },
    { id: "p2", rating: 1016, peak: 1016 },
    { id: "p3", rating: 984, peak: 1000 },
    { id: "p4", rating: 984, peak: 1000 },
  ];

  it("pays 0 milestone BP for the past, with the baseline backfill applied", async () => {
    for (const p of LIVE) {
      addUser(p.id);
      h.state.ratings.set(p.id, { rating: p.rating, peakRating: p.peak });
      h.state.baselines.push({ userId: p.id, rating: p.peak, source: "migration", createdAt: new Date() });
    }
    await finish(room({
      ladderProvenance: "queue",
      a: { userId: "p1", username: "p1", team: [] as never, stream: null, request: null, connected: true },
      b: { userId: "p3", username: "p3", team: [] as never, stream: null, request: null, connected: true },
    } as any), "ko");
    expect(h.state.milestones).toEqual([]);
    expect(totalMinted().bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP + LADDER_BP_LOSS);
  });

  it("an account ALREADY above a threshold cannot collect it by re-crossing", async () => {
    // The staggered dump: one loss puts a 1310 account back under 1300, and the
    // once-ever key would happily pay the re-crossing.
    addUser("hi"); addUser("lo");
    h.state.ratings.set("hi", { rating: 1290, peakRating: 1310 });
    h.state.ratings.set("lo", { rating: 1290, peakRating: 1290 });
    h.state.baselines.push({ userId: "hi", rating: 1310, source: "migration", createdAt: new Date() });
    h.state.baselines.push({ userId: "lo", rating: 1290, source: "migration", createdAt: new Date() });
    await finish(room({
      ladderProvenance: "queue",
      a: { userId: "hi", username: "hi", team: [] as never, stream: null, request: null, connected: true },
      b: { userId: "lo", username: "lo", team: [] as never, stream: null, request: null, connected: true },
    } as any), "ko");
    expect(h.state.ratings.get("hi")!.rating).toBeGreaterThan(1300);
    expect(h.state.milestones).toEqual([]);
  });

  it("with the baseline table MISSING, every rated battle pays nothing and says so", async () => {
    h.state.baselineTableExists = false;
    await finish(room({ ladderProvenance: "queue" } as any), "ko");
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });
    // …and "says so" now means it names the migration and the fix, rather than
    // logging a generic failure on every rated battle for an evening.
    expect(h.state.errors.map((e) => e.message)).toContain("pvp_ladder_migration_missing");
    const err = h.state.errors.find((e) => e.message === "pvp_ladder_migration_missing");
    expect(err.meta.migration).toBe("20260730130000_add_pvp_ladder_baseline");
    expect(String(err.meta.remedy)).toMatch(/migrate deploy/);
  });
});

describe("THE HEADLINE NUMBER: what a determined ring extracts per hour", () => {
  it("two colluding accounts, 200 matches inside one window", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) {
      const winner = i % 2 === 0 ? "a" : "b";
      const r = room({ ladderProvenance: "queue" } as any);
      r.createdAt = t0 - 5 * 60_000;
      await finish(r, "ko", winner);
    }
    const A = owed("uA"); const B = owed("uB");
    // Cash: exactly one bonus each, whatever the match count.
    expect(A.money).toBe(BRONZE);
    expect(B.money).toBe(BRONZE);
    expect(h.state.bonusClaims).toHaveLength(2);
    // BP: the rolling cap, per account, plus whatever the climb was worth.
    for (const [id, o] of [["uA", A], ["uB", B]] as const) {
      const mine = h.state.earns.filter((e) => e.userId === id);
      expect(mine.reduce((a, e) => a + e.bp, 0)).toBe(LADDER_BP_CAP_PER_WINDOW);
      expect(mine.reduce((a, e) => a + e.milestoneBp, 0))
        .toBeLessThanOrEqual(LADDER_MILESTONE_BP_CAP_PER_WINDOW);
      expect(o.bp).toBeLessThanOrEqual(LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW);
    }
    // 200 matches, two accounts, one rolling window: $20,000 total.
    expect(totalMinted().money).toBe(2 * BRONZE);
  }, 60_000);

  it("CLOSED: rating manufactured OFF the paying path no longer prices the cash", async () => {
    // THE REPRODUCTION, kept verbatim because it is what made the case. The
    // anti-collusion argument was "you cannot choose your opponent on the only
    // path that pays". True — and not sufficient, because the thing that set the
    // payout SIZE was rating, and rating is set on paths that pay nothing: a
    // friend invite at format random50 is RATED (deliberately: the owner refused
    // a payout, not competitive play) and a forfeit is instant, needs no turns
    // and no 20 s. So an abuser pumped rating where they could pick the
    // opponent, and collected once where they could not. Measured: 40 free
    // forfeits bought Silver, ~448 bought Diamond and a 20x price.
    for (let i = 0; i < 40; i++) {
      // Invite shape: rated random50, NO provenance.
      await finish(room({ format: "random50" }), "forfeit", "a");
    }
    expect(totalMinted()).toEqual({ bp: 0, money: 0 });   // the pump itself is free
    const pumped = h.state.ratings.get("uA")!.rating;
    expect(pumped).toBeGreaterThan(1100);                 // …and it still moves the BADGE

    // …but the badge is no longer what prices the money. The cash is priced by
    // `min(live rating, 1000 + Σ ladder ratingDelta)`, and not one of those 40
    // forfeits produced a ledger row, so this account has witnessed nothing.
    h.state.baselines.push({ userId: "uA", rating: pumped, source: "migration", createdAt: new Date() });
    h.state.baselines.push({ userId: "uB", rating: 1000, source: "migration", createdAt: new Date() });
    await finish(room({ ladderProvenance: "queue" } as any), "ko", "a");
    expect(owed("uA").money).toBe(BRONZE);
    expect(owed("uA").money).not.toBe(PVP_BADGE_TIERS[1].winBonusMoney);
    // The audit row makes the clamp visible rather than silent: the LIVE rating
    // is recorded beside the tier that actually priced the payment.
    const paid = h.state.earns.find((e) => e.userId === "uA" && e.moneyAwarded > 0)!;
    expect(paid.ratingAfter).toBeGreaterThan(1100);
    expect(paid.tier).toBe(PVP_BADGE_TIERS[0].id);
    // Still exactly ONE bonus per cooldown, which was the only bound before.
    expect(h.state.bonusClaims.filter((b) => b.userId === "uA")).toHaveLength(1);
  }, 30_000);

  it("the cash cooldown cannot be compressed by playing more", async () => {
    const base = new Date("2026-07-30T00:00:00Z");
    const pay = async (i: number, offsetMs: number) => settleLadderEarn({
      matchId: `m_cd${i}`, provenance: "queue", winnerId: "uA", loserId: "uB",
      endReason: "ko", logLines: ["|turn|1", "|turn|2", "|turn|3"], durationMs: 120_000,
      ratingDelta: { aDelta: 1, bDelta: -1, aRating: 1000, bRating: 1000 },
      now: new Date(base.getTime() + offsetMs),
    });
    await pay(0, 0);
    // Every hour for 19 hours: no second bonus.
    for (let hr = 1; hr <= 19; hr++) await pay(hr, hr * 3_600_000);
    expect(owed("uA").money).toBe(BRONZE);
    // At exactly the cooldown it unlocks, and not before.
    await pay(20, LADDER_WIN_BONUS_COOLDOWN_MS);
    expect(owed("uA").money).toBe(2 * BRONZE);
    expect(h.state.errors).toEqual([]);
  });
});
