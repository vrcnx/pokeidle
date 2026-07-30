// Socket-level PvP regression tests.
//
// Everything else in tests/ drives pvp.ts's exported helpers directly, because
// they take their transport and their presence predicate as parameters for
// exactly that reason. That left socket.ts — the disconnect handler, the
// reconnect probes, the queue broadcasts, the drain guards — with ZERO
// automated coverage, and two of the defects fixed in this pass lived there and
// were invisible to every existing test.
//
// So this file drives the REAL socket.ts handlers over a real socket.io server,
// with a hand-rolled Engine.IO/Socket.IO v4 websocket client (socket.io-client
// is not a dependency here). auth.js and db.js are both mocked, so nothing
// reaches better-auth or Postgres; the session middleware resolves a user id
// straight out of a `uid=` cookie.
//
// The two cases that pin this pass's socket-side fixes are marked FINDING in
// their names: the reconnect-probe limiter must never answer an off-contract
// ack, and the shutdown drain must refuse new battles at every entry point
// including the ones that cannot import this module.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

const db = vi.hoisted(() => {
  const ratingUpsert = vi.fn(async ({ where }: any) => ({
    userId: where.userId, rating: 1000, peakRating: 1000,
  }));
  const ratingUpdate = vi.fn(async (a: any) => a);
  const matchCreate = vi.fn(async (a: any) => a);
  const tx = { playerRating: { upsert: ratingUpsert, update: ratingUpdate } };
  return {
    ratingUpsert, ratingUpdate, matchCreate,
    prisma: {
      pvpMatch: { create: matchCreate },
      playerRating: { upsert: ratingUpsert, update: ratingUpdate },
      user: {
        findUnique: vi.fn(async ({ where }: any) => ({
          id: where.id, username: where.id, isAdmin: false, bannedUntil: null, saveData: null,
        })),
        update: vi.fn(async (a: any) => a),
      },
      friend: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      chatMessage: { create: vi.fn(async (a: any) => a) },
      dailyActive: { upsert: vi.fn(async () => ({})), create: vi.fn(async () => ({})) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      $executeRaw: vi.fn(async () => 1),
    },
  };
});
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));
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
  battleRooms, matchmakingQueue, endBattle, stopMatchmakingTicker,
  beginDrain, isDraining, resetDrainForTests,
} from "../src/pvp.js";
import { bstOf } from "../src/lib/pvpBotRoster.js";
import { isTeamPreviewRequest } from "../src/lib/pvpTeamPreview.js";

// ── minimal Socket.IO v4 client over a raw WebSocket ──────────────────────
class Sio {
  private ws!: WebSocket;
  private nextAck = 1;
  private acks = new Map<number, (v: any) => void>();
  readonly received: { ev: string; payload: any }[] = [];
  closed = false;

  static async connect(port: number, uid: string): Promise<Sio> {
    const c = new Sio();
    await c.open(port, uid);
    return c;
  }

  private open(port: number, uid: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new (WebSocket as any)(
        `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
        { headers: { cookie: `uid=${uid}` } },
      );
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5_000);
      this.ws.onerror = (e: any) => { clearTimeout(timer); reject(new Error("ws error " + String(e?.message ?? e))); };
      this.ws.onclose = () => { this.closed = true; };
      this.ws.onmessage = (m: MessageEvent) => {
        const d = String(m.data);
        if (d[0] === "0") { this.ws.send("40"); return; }          // engine open → ns connect
        if (d === "2") { this.ws.send("3"); return; }               // ping → pong
        if (d.startsWith("40")) { clearTimeout(timer); resolve(); return; }
        if (d.startsWith("44")) { clearTimeout(timer); reject(new Error("ns connect error: " + d)); return; }
        if (d.startsWith("43")) {                                   // ack
          const mm = /^43(\d+)(\[.*\])$/.exec(d);
          if (mm) {
            const cb = this.acks.get(Number(mm[1]));
            this.acks.delete(Number(mm[1]));
            cb?.(JSON.parse(mm[2])[0]);
          }
          return;
        }
        if (d.startsWith("42")) {
          const mm = /^42(\d*)(\[.*\])$/.exec(d);
          if (!mm) return;
          const arr = JSON.parse(mm[2]);
          this.received.push({ ev: arr[0], payload: arr[1] });
          return;
        }
      };
    });
  }

  emit(ev: string, payload?: unknown): void {
    this.ws.send("42" + JSON.stringify(payload === undefined ? [ev] : [ev, payload]));
  }

  emitAck(ev: string, payload?: unknown, timeoutMs = 5_000): Promise<any> {
    const id = this.nextAck++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ack timeout for ${ev}`)), timeoutMs);
      this.acks.set(id, (v) => { clearTimeout(t); resolve(v); });
      this.ws.send("42" + id + JSON.stringify(payload === undefined ? [ev] : [ev, payload]));
    });
  }

  of(ev: string) { return this.received.filter((r) => r.ev === ev); }
  clear() { this.received.length = 0; }

  async waitFor(ev: string, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find((r) => r.ev === ev);
      if (hit) return hit.payload;
      if (Date.now() > deadline) {
        throw new Error(`never saw ${ev}; saw: ${this.received.map((r) => r.ev).join(",")}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void { try { this.ws.close(); } catch { /* */ } }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

function team(id: string) {
  return [{
    id, speciesKey: "pikachu", name: "Pika", level: 50,
    moves: [{ id: "thunderShock" }],
  }];
}

let server: http.Server;
let port: number;
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

beforeEach(() => {
  db.matchCreate.mockClear();
  db.ratingUpdate.mockClear();
});

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await sleep(80);
  for (const r of Array.from(battleRooms.values())) {
    if (r.status === "active" || r.status === "invited") await endBattle(r, undefined, "cancelled");
    battleRooms.delete(r.id);
  }
  matchmakingQueue.length = 0;
});

async function connect(uid: string): Promise<Sio> {
  const c = await Sio.connect(port, uid);
  open.push(c);
  return c;
}

/**
 * Answer Team Preview for both seats, over the real socket, and return once the
 * simulator has replaced the preview request with turn 1's.
 *
 * WHY EVERY TEST THAT SENDS A `move` NEEDS THIS. Team Preview is on, so the
 * first |request| both sides hold is `{"teamPreview":true}` and a move choice
 * against it is not a legal answer. It used to be ACCEPTED anyway — applyChoice
 * wrote it and returned ok, and the simulator's refusal arrived later on the
 * player's own stream as `|error|[Invalid choice] Can't move: You need a
 * teampreview response`. Two tests in this file were asserting `{ok: true}` for
 * a choice that was in fact discarded, and passing on the strength of the very
 * defect that pvp.ts's choiceFitsPhase now closes. Answering the phase first is
 * what makes those assertions mean what they say.
 *
 * `default` is the identity order — the same string the server's own auto-lock
 * writes — so the lead is each fixture's slot 1, unchanged.
 */
async function leavePreview(a: Sio, b: Sio, battleId: string): Promise<void> {
  const room = battleRooms.get(battleId)!;
  const answer = async (c: Sio, side: "a" | "b") => {
    if (!isTeamPreviewRequest(room[side].request)) return;
    await c.emitAck("battle:choose", { battleId, choice: "default" }).catch(() => {});
  };
  for (let i = 0; i < 100; i++) {
    if (room.status !== "active") return;
    await answer(a, "a");
    await answer(b, "b");
    // Both sides holding a request that is NOT a preview request — "no preview
    // request" alone is also true in the split second before the first request
    // of any kind arrives.
    if (room.a.request && room.b.request
      && !isTeamPreviewRequest(room.a.request) && !isTeamPreviewRequest(room.b.request)) return;
    await sleep(20);
  }
}

// ═══ queue still pairs, and queue:update now broadcasts ═══════════════════
describe("E2E queue", () => {
  it("pairs two queued players into a live battle and broadcasts queue size", async () => {
    const A = await connect("eA");
    const B = await connect("eB");
    expect(await A.emitAck("battle:queue", { team: team("m1") })).toEqual({ ok: true });
    await A.waitFor("battle:queue:joined");
    expect(matchmakingQueue.length).toBe(1);

    expect(await B.emitAck("battle:queue", { team: team("m2") })).toEqual({ ok: true });
    // the previously-waiting player is told the queue grew — the reported lie
    await until(
      () => A.of("battle:queue:update").some((e) => e.payload.queueSize >= 2),
      3_000, "queue:update with size >= 2",
    );
    // (a lone queuer also gets a redundant size-1 update on its own join)
    expect(A.of("battle:queue:update")[0].payload.queueSize).toBe(1);

    const startA = await A.waitFor("battle:start");
    const startB = await B.waitFor("battle:start");
    expect(startA.battleId).toBe(startB.battleId);
    expect(startA.you).toBe("a");
    expect(startB.you).toBe("b");
    expect(startA.format).toBe("random50");
    await A.waitFor("battle:state");
    await B.waitFor("battle:state");
    expect(matchmakingQueue.length).toBe(0);
    const room = battleRooms.get(startA.battleId)!;
    expect(room.status).toBe("active");
  });

  it("explicit dequeue still emits queue:left", async () => {
    const A = await connect("eC");
    await A.emitAck("battle:queue", { team: team("m3") });
    await A.waitFor("battle:queue:joined");
    expect(await A.emitAck("battle:dequeue", {})).toEqual({ ok: true });
    await A.waitFor("battle:queue:left");
    expect(matchmakingQueue.length).toBe(0);
  });

  it("a disconnect HOLDS the queue slot and a reconnect is told it is still queued", async () => {
    const A = await connect("eD");
    await A.emitAck("battle:queue", { team: team("m4") });
    await A.waitFor("battle:queue:joined");
    A.close();
    await until(() => matchmakingQueue.length === 1 && matchmakingQueue[0].awayAt != null,
      3_000, "queue hold");
    const A2 = await connect("eD");
    const rejoined = await A2.waitFor("battle:queue:joined");
    expect(rejoined.position).toBe(1);
    expect(matchmakingQueue[0].awayAt ?? null).toBeNull();
  });
});

// ═══ disconnect is no longer an instant rated loss ════════════════════════
describe("E2E disconnect grace", () => {
  it("tells the survivor the opponent is away and rates nobody", async () => {
    const A = await connect("eE");
    const B = await connect("eF");
    await A.emitAck("battle:queue", { team: team("m5") });
    await B.emitAck("battle:queue", { team: team("m6") });
    const start = await B.waitFor("battle:start");
    B.clear();

    A.close();
    const away = await B.waitFor("battle:opponent-away", 3_000);
    expect(away.battleId).toBe(start.battleId);
    expect(away.username).toBe("eE");
    expect(away.graceEndsAt).toBeGreaterThan(Date.now() + 30_000);
    expect(away.graceEndsAt).toBeLessThan(Date.now() + 50_000);

    await sleep(400);
    expect(B.of("battle:complete")).toHaveLength(0);
    expect(db.ratingUpdate).not.toHaveBeenCalled();
    expect(db.matchCreate).not.toHaveBeenCalled();
    expect(battleRooms.get(start.battleId)!.status).toBe("active");

    // …and coming back clears it
    const A2 = await connect("eE");
    const back = await B.waitFor("battle:opponent-back", 3_000);
    expect(back.battleId).toBe(start.battleId);
    expect(battleRooms.get(start.battleId)!.status).toBe("active");
    expect(db.ratingUpdate).not.toHaveBeenCalled();
    // the returning client can rebuild
    const ack = await A2.emitAck("battle:rejoin", { battleId: start.battleId });
    expect(ack.ok).toBe(true);
    expect(ack.snapshot.side).toBe("a");
    expect(ack.snapshot.opponent.username).toBe("eF");
    expect(Array.isArray(ack.snapshot.log)).toBe(true);
    expect(ack.snapshot.log.length).toBeGreaterThan(0);
  });

  it("battle:sync answers gone for an unknown battle and ok for a live one", async () => {
    const A = await connect("eG");
    const B = await connect("eH");
    await A.emitAck("battle:queue", { team: team("m7") });
    await B.emitAck("battle:queue", { team: team("m8") });
    const start = await A.waitFor("battle:start");
    expect(await A.emitAck("battle:sync", { battleId: start.battleId }))
      .toEqual({ ok: true, battleId: start.battleId });
    expect(await A.emitAck("battle:sync", { battleId: "b_nope" }))
      .toEqual({ ok: false, reason: "gone" });
    // a stranger cannot confirm someone else's battle
    const C = await connect("eI");
    expect(await C.emitAck("battle:sync", { battleId: start.battleId }))
      .toEqual({ ok: false, reason: "gone" });
    expect(await C.emitAck("battle:rejoin", {}))
      .toEqual({ ok: false, reason: "not_in_battle" });
  });

  it("rejoin never hands a participant the omniscient log", async () => {
    const A = await connect("eJ");
    const B = await connect("eK");
    await A.emitAck("battle:queue", { team: team("m9") });
    await B.emitAck("battle:queue", { team: team("m10") });
    const start = await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    await sleep(150);
    const room = battleRooms.get(start.battleId)!;
    const ack = await A.emitAck("battle:rejoin", { battleId: start.battleId });
    const mine = new Set(ack.snapshot.log as string[]);
    const bOnly = (room.b.log ?? []).filter((l) => !(room.a.log ?? []).includes(l));
    expect(bOnly.length).toBeGreaterThan(0);          // B really does see private lines
    for (const l of bOnly) expect(mine.has(l)).toBe(false);
    expect((ack.snapshot.log as string[]).some((l) => l.startsWith("|request|"))).toBe(true);
    expect(JSON.stringify(ack.snapshot)).not.toContain("m10");
  });
});

// ═══ FINDING · a refused reconnect probe must not LIE ═════════════════════
// The limiter used to answer { ok: false, reason: "rate_limited" } — a third
// failure reason the fixed ack contract does not contain. The client does not
// inspect `reason`: any ok:false renders "Battle ended by a server restart —
// not rated" and REMOVES the action bar, so the player can no longer submit a
// choice in a rated battle that is still running and the 5-minute AFK watchdog
// then forfeits them for real. Measured before the fix: 30 acks ok, the 31st
// rate_limited, room.status still "active", no PvpMatch row.
//
// Two properties are pinned here, and the SECOND is the one that matters:
//   1. the honest budget is wide enough for a genuine reconnect storm, and
//   2. past it, the server answers NOTHING — never an ok:false — so the board
//      the client is already rendering stays correct and it simply retries.
describe("E2E reconnect probe limiter", () => {
  it("FINDING: never answers an off-contract ack for a live battle, and goes silent instead of lying", async () => {
    const A = await connect("eT");
    const B = await connect("eU");
    await A.emitAck("battle:queue", { team: team("m19") });
    await B.emitAck("battle:queue", { team: team("m20") });
    const start = await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    // Out of Team Preview first, so the `move 1` at the end of this test is a
    // real turn-1 choice rather than one the simulator would discard.
    await leavePreview(A, B, start.battleId);

    // Walk past the 120/min bucket so both regimes are exercised. A refused
    // call is detected by the ack never arriving, so the over-budget tail is
    // kept short and the per-call wait tight.
    // 500 ms per call is a ~500x margin over the observed ack latency, so a
    // slow machine cannot turn a real ack into a false "silent".
    let okCount = 0;
    let silent = 0;
    const badAcks: any[] = [];
    for (let i = 0; i < 130 && silent < 2; i++) {
      try {
        const r = await A.emitAck("battle:rejoin", { battleId: start.battleId }, 500);
        if (r?.ok) { okCount++; continue; }
        badAcks.push(r);                       // any ok:false on a LIVE battle
      } catch {
        silent++;                              // no ack at all — the fix
      }
    }
    expect(okCount).toBeGreaterThanOrEqual(120);
    expect(badAcks).toEqual([]);
    expect(silent).toBe(2);
    // Same for the cheap probe: refusal is silence, never a "gone" for a battle
    // that is still running.
    const syncAcks: any[] = [];
    let syncSilent = 0;
    for (let i = 0; i < 130 && syncSilent < 2; i++) {
      try { syncAcks.push(await A.emitAck("battle:sync", { battleId: start.battleId }, 500)); }
      catch { syncSilent++; }
    }
    expect(syncAcks.length).toBeGreaterThanOrEqual(120);
    expect(syncAcks.every((r) => r.ok === true && r.battleId === start.battleId)).toBe(true);
    expect(syncSilent).toBe(2);

    // Through all of that the battle never stopped being live and rated.
    expect(battleRooms.get(start.battleId)!.status).toBe("active");
    expect(db.matchCreate).not.toHaveBeenCalled();
    // And a choice is still accepted — i.e. the player was never locked out.
    expect(await A.emitAck("battle:choose", { battleId: start.battleId, choice: "move 1" }))
      .toEqual({ ok: true });
  }, 40_000);
});

// ═══ FINDING · the drain refuses new battles everywhere ═══════════════════
// socket.ts guarded its own four entry points with a local `shuttingDown` and
// exported an isShuttingDown() that nothing in src/ consumed — while
// lib/tournamentRunner.ts's 15-second bracket ticker and the admin start-match
// route call startBattle directly. The latch now lives in pvp.ts so startBattle
// itself refuses, which is the only place all four callers pass through. This
// test pins the socket half: the same latch drainForShutdown() flips is the one
// these handlers read.
describe("E2E shutdown drain", () => {
  afterEach(() => { resetDrainForTests(); });

  it("FINDING: refuses queue and invite off the same latch pvp.isDraining owns", async () => {
    const A = await connect("dA");
    const B = await connect("dB");
    expect(isDraining()).toBe(false);
    // Sanity: these same calls work when the latch is clear.
    expect(await A.emitAck("battle:queue", { team: team("d0") })).toEqual({ ok: true });
    expect(await A.emitAck("battle:dequeue", {})).toEqual({ ok: true });

    // drainForShutdown() latches exactly this, before its sweep. It cannot be
    // called here: it ends in process.exit(0) and would take vitest with it.
    beginDrain();
    expect(isDraining()).toBe(true);

    expect(await A.emitAck("battle:queue", { team: team("d1") }))
      .toEqual({ ok: false, error: "server_restarting" });
    expect(await A.emitAck("battle:invite", { toUserId: "dB", team: team("d2") }))
      .toEqual({ ok: false, error: "server_restarting" });
    expect(matchmakingQueue.length).toBe(0);
    expect(B.of("battle:invite")).toHaveLength(0);
    expect([...battleRooms.values()].filter((r) => r.status === "active")).toHaveLength(0);
  });
});

// ═══ choices still accepted while the opponent is away ════════════════════
describe("E2E choose during grace", () => {
  it("the present player can still submit a move while the opponent is in grace", async () => {
    const A = await connect("eV");
    const B = await connect("eW");
    await A.emitAck("battle:queue", { team: team("m21") });
    await B.emitAck("battle:queue", { team: team("m22") });
    const start = await B.waitFor("battle:start");
    await B.waitFor("battle:state");
    // Both leads locked in BEFORE A vanishes: a seat that disconnects mid-phase
    // leaves the battle on the 20-second auto-lock, and the point of this test
    // is the grace window, not the phase.
    await leavePreview(A, B, start.battleId);
    A.close();
    await B.waitFor("battle:opponent-away", 3_000);
    const r = await B.emitAck("battle:choose", { battleId: start.battleId, choice: "move 1" });
    expect(r).toEqual({ ok: true });
    expect(battleRooms.get(start.battleId)!.status).toBe("active");
  });
});

// ═══ spectating still works ═══════════════════════════════════════════════
describe("E2E spectate", () => {
  it("battle:list + spectate:join/leave still behave", async () => {
    const A = await connect("eX");
    const B = await connect("eY");
    await A.emitAck("battle:queue", { team: team("m23") });
    await B.emitAck("battle:queue", { team: team("m24") });
    const start = await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    const C = await connect("eZ");
    const list = await C.emitAck("battle:list", {});
    expect(list.ok).toBe(true);
    expect(list.battles.some((b: any) => b.battleId === start.battleId)).toBe(true);
    expect(await C.emitAck("battle:spectate:join", { battleId: start.battleId })).toEqual({ ok: true });
    await C.waitFor("battle:spectate:start");
    await C.waitFor("battle:spectate:state");
    // participants still refused
    expect((await A.emitAck("battle:spectate:join", { battleId: start.battleId })).ok).toBe(false);
    expect(await C.emitAck("battle:spectate:leave", { battleId: start.battleId })).toEqual({ ok: true });
    expect(battleRooms.get(start.battleId)!.spectators.size).toBe(0);
  });
});

// ═══ explicit forfeit is still immediate ══════════════════════════════════
describe("E2E explicit forfeit", () => {
  it("battle:cancel ends the battle at once, rates it, and never waits 45 s", async () => {
    const A = await connect("eL");
    const B = await connect("eM");
    await A.emitAck("battle:queue", { team: team("m11") });
    await B.emitAck("battle:queue", { team: team("m12") });
    const start = await A.waitFor("battle:start");
    await A.waitFor("battle:state");

    const t0 = Date.now();
    expect(await A.emitAck("battle:cancel", { battleId: start.battleId })).toEqual({ ok: true });
    const doneB = await B.waitFor("battle:complete", 2_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
    expect(doneB.winnerId).toBe("eM");
    expect(doneB.loserId).toBe("eL");
    expect(doneB.reason).toBe("forfeit");
    expect(doneB.ratingDelta).not.toBeNull();
    const loser = db.ratingUpdate.mock.calls.find((c: any) => c[0].where.userId === "eL")![0];
    expect(loser.data.forfeits).toEqual({ increment: 1 });
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    // and the forfeiter's own subsequent disconnect must not start a grace
    A.close();
    await sleep(300);
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    expect(B.of("battle:opponent-away")).toHaveLength(0);
  });
});

// ═══ invite flow still works, TTL cancel path intact ══════════════════════
describe("E2E invite", () => {
  it("invite → accept still starts a battle; decline still cancels", async () => {
    const A = await connect("eN");
    const B = await connect("eO");
    const inv = await A.emitAck("battle:invite", { toUserId: "eO", team: team("m13") });
    expect(inv.ok).toBe(true);
    const got = await B.waitFor("battle:invite");
    expect(got.battleId).toBe(inv.battleId);
    expect(await B.emitAck("battle:respond", { battleId: inv.battleId, accept: false })).toEqual({ ok: true });
    const cancelled = await A.waitFor("battle:cancelled");
    expect(cancelled.battleId).toBe(inv.battleId);
    expect(battleRooms.has(inv.battleId)).toBe(false);

    const inv2 = await A.emitAck("battle:invite", { toUserId: "eO", team: team("m14") });
    await B.waitFor("battle:invite");
    expect(await B.emitAck("battle:respond", { battleId: inv2.battleId, accept: true, team: team("m15") }))
      .toEqual({ ok: true });
    const s = await A.waitFor("battle:start");
    expect(s.battleId).toBe(inv2.battleId);
    expect(battleRooms.get(inv2.battleId)!.status).toBe("active");
  });

  it("an invited room is still cancelled outright on disconnect (no grace)", async () => {
    const A = await connect("eP");
    const B = await connect("eQ");
    const inv = await A.emitAck("battle:invite", { toUserId: "eQ", team: team("m16") });
    await B.waitFor("battle:invite");
    A.close();
    const cancelled = await B.waitFor("battle:cancelled", 3_000);
    expect(cancelled.battleId).toBe(inv.battleId);
    expect(battleRooms.has(inv.battleId)).toBe(false);
    expect(B.of("battle:opponent-away")).toHaveLength(0);
  });
});

// ═══ a normal battle still completes and rates, end to end ════════════════
describe("E2E full battle", () => {
  it("plays to a KO through battle:choose and rates the result", async () => {
    const A = await connect("eR");
    const B = await connect("eS");
    await A.emitAck("battle:queue", { team: team("m17") });
    await B.emitAck("battle:queue", { team: team("m18") });
    const start = await A.waitFor("battle:start");
    const room = battleRooms.get(start.battleId)!;
    await A.waitFor("battle:state");

    const deadline = Date.now() + 12_000;
    while (room.status === "active" && Date.now() < deadline) {
      await A.emitAck("battle:choose", { battleId: start.battleId, choice: "default" }).catch(() => {});
      await B.emitAck("battle:choose", { battleId: start.battleId, choice: "default" }).catch(() => {});
      await sleep(20);
    }
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("ko");
    const doneA = await A.waitFor("battle:complete", 2_000);
    expect(doneA.reason).toBe("ko");
    expect([doneA.winnerId, doneA.loserId].sort()).toEqual(["eR", "eS"]);
    expect(doneA.ratingDelta).not.toBeNull();
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    expect(db.matchCreate.mock.calls[0][0].data.status).toBe("completed");
    const winner = db.ratingUpdate.mock.calls.find((c: any) => c[0].where.userId === doneA.winnerId)![0];
    expect(winner.data.wins).toEqual({ increment: 1 });
    const loser = db.ratingUpdate.mock.calls.find((c: any) => c[0].where.userId === doneA.loserId)![0];
    expect(loser.data.losses).toEqual({ increment: 1 });
  }, 25_000);
});

// ═══ AI practice battles, over the real socket ════════════════════════════
// The queue needs two people in it at the SAME INSTANT and the game averages
// ~34 active players an hour, so "nobody is there" is the normal case. These
// pin the four things battle:bot has to get right that no unit test can reach:
// the handler's own refusals, the honest opponent label the player is shown,
// the dequeue-with-an-emit (a silent leaveQueue leaves the client's "Searching
// for opponent… 14m 32s" toast ticking forever), and battle:list keeping
// practice battles out of the public LIVE NOW panel.
describe("E2E bot battle", () => {
  afterEach(() => { resetDrainForTests(); });

  it("starts against a named AI, never rates it, and plays to a finish", async () => {
    const A = await connect("bA");
    const ack = await A.emitAck("battle:bot", { team: team("bm1") });
    expect(ack.ok).toBe(true);
    expect(ack.opponent).toMatch(/ AI$/);
    expect(ack.tier).toBe("trainer");

    const start = await A.waitFor("battle:start");
    expect(start.battleId).toBe(ack.battleId);
    expect(start.you).toBe("a");
    // The format is what the arena's rail reads to label the battle
    // "AI Practice · Not rated" instead of falling through to "Friendly".
    expect(start.format).toBe("bot");
    // A space is impossible in a real username ([A-Za-z0-9_] only), so the
    // player can never mistake this seat for a human.
    expect(start.opponent.username).toContain(" AI");
    expect(start.opponent.id.startsWith("bot:")).toBe(true);
    await A.waitFor("battle:state");

    const room = battleRooms.get(start.battleId)!;
    // The AI's Pokémon are level-matched to the human's, not capped to 50.
    expect(room.b.team.map((m: any) => m.level)).toEqual([50]);
    expect(room.b.isBot).toBe(true);

    // Play it out. Only ONE side sends choices — the AI answers itself, which
    // is the whole point: a mute bot never gets past turn 1.
    const deadline = Date.now() + 15_000;
    while (room.status === "active" && Date.now() < deadline) {
      await A.emitAck("battle:choose", { battleId: start.battleId, choice: "default" }).catch(() => {});
      await sleep(50);
    }
    expect(room.status).toBe("completed");
    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(true);

    const done = await A.waitFor("battle:complete", 2_000);
    expect(done.ratingDelta).toBeNull();
    // Never rated, never recorded — by execution, on the real socket path.
    expect(db.matchCreate).not.toHaveBeenCalled();
    expect(db.ratingUpdate).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps practice battles out of battle:list, so LIVE NOW stays real players", async () => {
    const A = await connect("bB");
    const ack = await A.emitAck("battle:bot", { team: team("bm2") });
    await A.waitFor("battle:start");
    const C = await connect("bC");
    const list = await C.emitAck("battle:list", {});
    expect(list.ok).toBe(true);
    expect(list.battles.some((b: any) => b.battleId === ack.battleId)).toBe(false);
    // Nothing about the AI seat is published to a third party at all.
    expect(JSON.stringify(list)).not.toContain("bot:");
    expect(JSON.stringify(list)).not.toContain(" AI");
  });

  it("FINDING: also refuses spectate:join, which battle:list's filter did NOT close", async () => {
    // The filter above hides practice battles from LIVE NOW. It cannot hide
    // them from battle:spectate:join, which reads a battleId straight off the
    // payload and never consults the list — so this used to succeed, and the
    // spectator received battle:spectate:start carrying `bot:<battleId>` and the
    // " AI" label, the full omniscient log of somebody's practice match, and a
    // battle:spectate:end naming a winnerId that belongs to no account. It
    // never crashed; it simply was not closed the way the code said it was.
    const A = await connect("bI");
    const ack = await A.emitAck("battle:bot", { team: team("bm9") });
    await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    const C = await connect("bJ");
    expect(await C.emitAck("battle:spectate:join", { battleId: ack.battleId }))
      .toEqual({ ok: false, error: "no such battle" });
    const room = battleRooms.get(ack.battleId)!;
    expect(room.spectators.size).toBe(0);
    // Same answer a genuinely unknown id gets, so this is not an existence
    // oracle for practice battles either.
    expect(await C.emitAck("battle:spectate:join", { battleId: "b_doesnotexist" }))
      .toEqual({ ok: false, error: "no such battle" });
    // A REAL battle is still spectatable — the guard is not a blanket refusal.
    expect(room.status).toBe("active");
  }, 30_000);

  it("dequeues the player and SAYS so, so the search toast dies", async () => {
    const A = await connect("bD");
    await A.emitAck("battle:queue", { team: team("bm3") });
    await A.waitFor("battle:queue:joined");
    expect(matchmakingQueue.length).toBe(1);
    A.clear();
    const ack = await A.emitAck("battle:bot", { team: team("bm3") });
    expect(ack.ok).toBe(true);
    await A.waitFor("battle:queue:left");
    expect(matchmakingQueue.length).toBe(0);
  });

  it("refuses a second battle, a bad team, and a restart", async () => {
    const A = await connect("bE");
    await A.emitAck("battle:bot", { team: team("bm4") });
    await A.waitFor("battle:start");
    // One battle at a time, same guard battle:queue and battle:invite use.
    expect(await A.emitAck("battle:bot", { team: team("bm5") }))
      .toEqual({ ok: false, error: "already in a battle" });
    // The fourth team-intake site is bounds-validated like the other three.
    const B = await connect("bF");
    const bad = await B.emitAck("battle:bot", { team: [] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/1\.\.6/);
    // …and it refuses mid-drain, before any room exists.
    beginDrain();
    expect(await B.emitAck("battle:bot", { team: team("bm6") }))
      .toEqual({ ok: false, error: "server_restarting" });
  });

  it("a human closing the tab ends the practice battle instead of stranding it", async () => {
    const A = await connect("bG");
    const ack = await A.emitAck("battle:bot", { team: team("bm7") });
    await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    const room = battleRooms.get(ack.battleId)!;
    A.close();
    // The grace holds their seat (a reload keeps the fight) and then the AI
    // takes it by forfeit — bounded, unrated, and the room is reclaimed rather
    // than pinning a simulator forever.
    await until(() => room.a.awayAt != null, 3_000, "human grace started");
    expect(room.b.awayAt ?? null).toBeNull();
    expect(room.status).toBe("active");
    expect(db.matchCreate).not.toHaveBeenCalled();
  });

  it("a RATED match cannot be turned into a practice battle to dodge the loss", async () => {
    // The dangerous direction, and the one with the most to lose: if a player
    // losing a rated match could relabel it, ELO and the leaderboard would be
    // forgeable. battle:bot must be refused mid-match, the room must never be
    // relabelled, and the forfeit must still rate.
    const W = await connect("bV");
    const L = await connect("bW");
    expect(await W.emitAck("battle:queue", { team: team("bv1") })).toEqual({ ok: true });
    expect(await L.emitAck("battle:queue", { team: team("bw1") })).toEqual({ ok: true });
    const start = await L.waitFor("battle:start");
    const room = battleRooms.get(start.battleId)!;
    expect(room.format).toBe("random50");
    const roomsBefore = battleRooms.size;

    // Every shape of the attempt, including hostile tier/trainer strings.
    for (const payload of [
      { team: team("bw1") },
      { team: team("bw1"), tier: "godmode", trainer: "__proto__" },
    ]) {
      expect(await L.emitAck("battle:bot", payload))
        .toEqual({ ok: false, error: "already in a battle" });
    }
    // Nothing about the live room moved: same room, same format, no AI seat.
    expect(battleRooms.size).toBe(roomsBefore);
    expect(room.format).toBe("random50");
    expect(room.a.isBot ?? null).toBeNull();
    expect(room.b.isBot ?? null).toBeNull();

    // …and the loss still rates and still records.
    expect(await L.emitAck("battle:cancel", { battleId: start.battleId })).toEqual({ ok: true });
    await until(() => db.matchCreate.mock.calls.length > 0, 3_000, "match row written");
    const row = db.matchCreate.mock.calls[0][0].data;
    expect(row.format).toBe("random50");
    expect(row.loserId).toBe("bW");
    expect(row.winnerId).toBe("bV");
    expect(db.ratingUpdate).toHaveBeenCalled();
  }, 30_000);

  it("FINDING: a practice battle no longer benches the RATED queue", async () => {
    // "Already in a battle" is checked against battleRooms, so a live practice
    // battle used to refuse battle:queue, battle:invite and (server-side)
    // tournament pairings. Measured: with a second tab keeping the player
    // present, NO reconnect grace starts, so the only thing that reclaimed the
    // room was the turn clock — 345,000 ms of being unable to look for a real
    // opponent. Wanting a human is the clearest possible statement that the AI
    // fight is over, so it ends and the queue join goes through.
    const A = await connect("bQ");
    const ack = await A.emitAck("battle:bot", { team: team("bq1") });
    expect(ack.ok).toBe(true);
    await A.waitFor("battle:start");
    await A.waitFor("battle:state");
    const practice = battleRooms.get(ack.battleId)!;
    expect(practice.status).toBe("active");

    A.clear();
    expect(await A.emitAck("battle:queue", { team: team("bq1") })).toEqual({ ok: true });
    // The practice battle is over — unrated, unrecorded, and no winner: they
    // left it, they did not lose it.
    await until(() => practice.status === "cancelled", 3_000, "practice battle ended");
    expect(practice.winnerId ?? null).toBeNull();
    expect(db.matchCreate).not.toHaveBeenCalled();
    expect(db.ratingUpdate).not.toHaveBeenCalled();
    await A.waitFor("battle:queue:joined");
    expect(matchmakingQueue.length).toBe(1);

    // …and a real human can now actually reach them.
    const B = await connect("bR");
    expect(await B.emitAck("battle:queue", { team: team("bq2") })).toEqual({ ok: true });
    const startA = await A.waitFor("battle:start");
    const startB = await B.waitFor("battle:start");
    expect(startA.battleId).toBe(startB.battleId);
    expect(startA.format).toBe("random50");
    expect(matchmakingQueue.length).toBe(0);
  }, 30_000);

  it("a practice battle does not block an invite either", async () => {
    const A = await connect("bS");
    const ack = await A.emitAck("battle:bot", { team: team("bs1") });
    expect(ack.ok).toBe(true);
    await A.waitFor("battle:start");
    const practice = battleRooms.get(ack.battleId)!;
    const B = await connect("bT");
    void B;   // the recipient only has to be online
    const inv = await A.emitAck("battle:invite", { toUserId: "bT", team: team("bs1") });
    expect(inv.ok).toBe(true);
    await until(() => practice.status === "cancelled", 3_000, "practice battle ended");
    expect(db.matchCreate).not.toHaveBeenCalled();
  }, 30_000);

  it("the trainer list names a FAIR opponent for the party it is given", async () => {
    // The hub's offer says "Fight <trainer> instead?" and then passes that id
    // back, so the server has to agree with its own recommendation — otherwise
    // the offer is a promise the battle breaks. The party summary is levels and
    // species only; the real team is validated at battle:bot like every other
    // intake.
    const A = await connect("bU");
    const plain = await A.emitAck("battle:bot:trainers", {});
    expect(plain.ok).toBe(true);
    expect(plain.recommended ?? null).toBeNull();       // no party, no advice
    expect(plain.trainers.length).toBe(8);

    const advised = await A.emitAck("battle:bot:trainers", {
      mons: [{ level: 7, speciesKey: "charmander" }, { level: 5, speciesKey: "rattata" }],
    });
    expect(advised.ok).toBe(true);
    expect(advised.trainers.length).toBe(8);
    for (const t of advised.trainers) {
      expect(t.label).toMatch(/ AI$/);
      expect(typeof t.fit).toBe("number");
      expect(typeof t.edge).toBe("number");
    }
    // The head of the list is the recommendation, it is one of the ones that
    // FIT, and at least one entry is labelled a fair fight. (Deliberately NOT
    // "trainers[0].fit is the smallest": the list is ordered by fit-then-type-
    // neutrality, so when several trainers fit, the most neutral of them leads —
    // which is the better OFFER and the whole point of the second axis.)
    const minFit = Math.min(...advised.trainers.map((t: any) => t.fit));
    expect(advised.trainers[0].fit).toBeLessThanOrEqual(minFit + 0.2);
    expect(advised.trainers[0].matched).toBe(true);
    expect(advised.recommended).toBe(advised.trainers[0].id);
    expect(advised.trainers.some((t: any) => t.matched)).toBe(true);
    // Every trainer whose power fit is out of tolerance sorts after every
    // trainer whose fit is inside it — the first stage of the ordering.
    const inTolerance = advised.trainers.map((t: any) => t.fit <= minFit + 0.2);
    expect(inTolerance).toEqual([...inTolerance].sort((a, b) => Number(b) - Number(a)));

    // The recommendation is honoured verbatim, and the team it fields is
    // level-matched to the party rather than to the trainer's own flavour.
    const ack = await A.emitAck("battle:bot", {
      team: [
        { id: "u1", speciesKey: "charmander", name: "Char", level: 7, moves: [{ id: "ember" }] },
        { id: "u2", speciesKey: "rattata", name: "Rat", level: 5, moves: [{ id: "tackle" }] },
      ],
      trainer: advised.recommended,
    });
    expect(ack.ok).toBe(true);
    const label = advised.trainers.find((t: any) => t.id === advised.recommended)!.label;
    expect(ack.opponent).toBe(label);
    const start = await A.waitFor("battle:start");
    expect(start.opponent.username).toBe(label);
    const room = battleRooms.get(ack.battleId)!;
    expect(room.b.team.map((m: any) => m.level)).toEqual([7, 5]);
    // A Lv 7 practice battle is fought between Lv 7-appropriate Pokémon: the
    // finding was a level-matched Gyarados/Snorlax/Arcanine (BST 540-555)
    // against a party averaging 299.
    for (const m of room.b.team as any[]) {
      expect(bstOf(m.speciesKey), `${m.speciesKey} at Lv 7`).toBeLessThanOrEqual(400);
    }
  }, 30_000);

  it("exposes the trainer roster and honours the one the client offered", async () => {
    // The hub names the opponent in its "no one else is in the queue" offer, so
    // the server has to actually send THAT trainer — otherwise the offer is a
    // promise the battle breaks.
    const A = await connect("bH");
    const r = await A.emitAck("battle:bot:trainers", {});
    expect(r.ok).toBe(true);
    expect(r.trainers.length).toBeGreaterThan(0);
    for (const t of r.trainers) expect(t.label).toMatch(/ AI$/);

    const pick = r.trainers.find((t: any) => t.id === "hiker") ?? r.trainers[0];
    const ack = await A.emitAck("battle:bot", { team: team("bm8"), trainer: pick.id });
    expect(ack.ok).toBe(true);
    expect(ack.opponent).toBe(pick.label);
    const start = await A.waitFor("battle:start");
    expect(start.opponent.username).toBe(pick.label);
    // An unknown id falls back to a real trainer rather than failing the battle.
    const B = await connect("bI");
    const junk = await B.emitAck("battle:bot", { team: team("bm9"), trainer: "not-a-trainer" });
    expect(junk.ok).toBe(true);
    expect(r.trainers.map((t: any) => t.label)).toContain(junk.opponent);
  });
});
