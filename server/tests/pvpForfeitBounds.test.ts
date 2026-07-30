// Forfeit-correctness bounds for the PvP reconnect grace.
//
// The reconnect grace fixed "a disconnect is an instant rated loss" by having
// the AFK watchdog stand down while a side is away. Everything here pins the
// OTHER half of that trade: the stand-down has to be bounded, and every way it
// can end has to produce exactly one result.
//
// Two defects were found by execution and are pinned below.
//
//   1. The stand-down was unbounded. `awayAt != null` restarts from scratch on
//      every fresh disconnect, so a client that closes its socket for 44.8 s
//      and reopens it for 5 ms puts every 30 s watchdog poll inside an away
//      window and the turn-timeout check never runs again. Measured before the
//      fix: 322 flap cycles, 4 simulated hours, turn clock ~4 h past a
//      5-minute deadline, room still "active", zero PvpMatch rows — while the
//      identical battle with nobody flapping times out normally. A losing
//      player could stall a match forever, pin the simulator in memory, freeze
//      a tournament bracket, and (once the honest opponent gave up and closed
//      their tab) convert the loss into an UNRATED cancel — which the bracket
//      reads as dead and replays. The stand-down is now spent from the same
//      MAX_TURN_CREDIT_MS budget as the turn-clock credit, so both stop
//      together.
//
//      Closing that hole opened a second one, also caught here: deferring the
//      both-sides-away case to the grace timers deadlocked two flappers
//      against each other (timers waiting on the watchdog, watchdog waiting on
//      the timers) for 30 simulated minutes with no row. Whichever mechanism
//      notices first must finish it.
//
//   2. endBattle re-read room.status / winnerId / loserId AFTER `await
//      applyEloUpdate`. The double-end gate stops a second endBattle but not a
//      caller that writes those fields and is then turned away by the gate —
//      socket.ts's battle:cancel, reached by the surviving player's "Yes,
//      forfeit" button, sets status = "cancelled" on a non-active room. Landing
//      that inside the ELO window of a grace forfeit moved both ratings while
//      persisting the row as "cancelled": history loses a win whose rating
//      already moved, and tournamentRunner.battleOutcome reads a non-completed
//      row as dead and REPLAYS a decided pairing. The outcome is now frozen
//      before the await.
//
// DB stubbing follows pvp.test.ts: vi.mock replaces ../src/db.js, so nothing
// here can construct a PrismaClient. Nothing imports ../src/socket.js — the
// grace helpers take their transport and presence predicate as parameters.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const ratingUpsert = vi.fn(async ({ where }: any) => ({
    userId: where.userId, rating: 1000, peakRating: 1000,
  }));
  const ratingUpdate = vi.fn(async () => ({}));
  const matchCreate = vi.fn(async () => ({}));
  const tx = { playerRating: { upsert: ratingUpsert, update: ratingUpdate } };
  return {
    ratingUpsert, ratingUpdate, matchCreate,
    prisma: {
      pvpMatch: { create: matchCreate },
      playerRating: { upsert: ratingUpsert, update: ratingUpdate },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      $executeRaw: vi.fn(async () => 1),
    },
  };
});
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));

import {
  battleRooms,
  startBattle,
  applyChoice,
  beginDisconnectGrace,
  endDisconnectGrace,
  resolveReconnectGrace,
  RECONNECT_GRACE_MS,
  WATCHDOG_POLL_MS,
  TURN_TIMEOUT_MS,
  MAX_TURN_CREDIT_MS,
  type BattleRoom,
  type GraceDeps,
} from "../src/pvp.js";

// ── Harness ───────────────────────────────────────────────────────────────

const io = { to: () => ({ emit: () => {} }) } as any;
const rows = () => db.matchCreate.mock.calls.map((c: any) => c[0].data);
const eloUpdates = () => db.ratingUpdate.mock.calls.map((c: any) => c[0]);
const forfeitedUserId = () =>
  eloUpdates().find((u: any) => u.data.forfeits)?.where.userId;
const eloWinnerId = () =>
  eloUpdates().find((u: any) => u.data.wins)?.where.userId;

function makeHarness(present: string[]) {
  const p = new Set(present);
  const events: { userId: string; event: string; payload: any }[] = [];
  const deps: GraceDeps = {
    sendToUser: (userId, event, payload) => { events.push({ userId, event, payload }); },
    isPresent: (u) => p.has(u),
  };
  return { present: p, deps, events };
}

let seq = 0;

/** A real @pkmn/sim battle with the real watchdog interval installed by
 *  startBattle. Hand-built rooms with a stub stream can't be used for any of
 *  this: the interval IS the thing under test, and its phase is anchored to
 *  startBattle. */
async function liveBattle(
  h: ReturnType<typeof makeHarness>,
  format = "random50",
): Promise<BattleRoom> {
  const id = `b_fb${++seq}`;
  const team = (x: string) => [
    { speciesKey: "pikachu", name: x, level: 50, moves: [{ id: "thunderShock" }] },
    { speciesKey: "bulbasaur", name: `${x}2`, level: 50, moves: [{ id: "tackle" }] },
  ];
  const room: BattleRoom = {
    id, status: "invited", format,
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: team("A"), stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: team("B"), stream: null, request: null, connected: true },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  };
  battleRooms.set(id, room);
  await startBattle(io, room, (u, e, pl) => { h.events.push({ userId: u, event: e, payload: pl }); });
  await vi.advanceTimersByTimeAsync(0);
  return room;
}

function tearDown(room: BattleRoom): void {
  if (room.expiryTimer) clearInterval(room.expiryTimer);
  if (room.a.graceTimer) clearTimeout(room.a.graceTimer);
  if (room.b.graceTimer) clearTimeout(room.b.graceTimer);
  battleRooms.delete(room.id);
}

/** One disconnect → reconnect cycle, timed so the away window swallows every
 *  watchdog poll. This is the exploit, expressed as a loop. */
async function flapOnce(userId: string, h: ReturnType<typeof makeHarness>): Promise<number> {
  const away = RECONNECT_GRACE_MS - 200;
  h.present.delete(userId);
  beginDisconnectGrace(userId, h.deps);
  await vi.advanceTimersByTimeAsync(away);
  h.present.add(userId);
  endDisconnectGrace(userId, h.deps);
  await vi.advanceTimersByTimeAsync(5);
  return away + 5;
}

/** Spend a side's whole grace budget with ordinary-looking blips. */
async function burnBudget(userId: string, h: ReturnType<typeof makeHarness>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    h.present.delete(userId);
    beginDisconnectGrace(userId, h.deps);
    await vi.advanceTimersByTimeAsync(44_000);
    h.present.add(userId);
    endDisconnectGrace(userId, h.deps);
    await vi.advanceTimersByTimeAsync(50);
  }
}

beforeEach(() => {
  db.matchCreate.mockClear();
  db.ratingUpdate.mockClear();
  db.ratingUpsert.mockClear();
  (db.prisma.$transaction as any).mockClear();
  battleRooms.clear();
});

// ── A battle always terminates ────────────────────────────────────────────

describe("the AFK watchdog stand-down is bounded", () => {
  it("CONTROL: a stalled battle with nobody away still times out", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    const status = room.status;
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    expect(status).toBe("completed");
    expect(room.endReason).toBe("timeout");
    expect(rows()).toHaveLength(1);
    tearDown(room);
  });

  it("a socket flap timed to dodge every poll can no longer stall the turn", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    // Before the fix this ran for four simulated HOURS without ending. Give it
    // one simulated hour of rope; it must be done long before that.
    let elapsed = 0;
    let flaps = 0;
    while (elapsed < 60 * 60_000 && room.status === "active") {
      elapsed += await flapOnce("uA", h);
      flaps++;
    }
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    expect(room.status).toBe("completed");
    // Terminates on the order of the turn timeout plus the grace budget, not
    // "eventually" — the whole point is that the bound is a bound.
    expect(elapsed).toBeLessThan(TURN_TIMEOUT_MS + MAX_TURN_CREDIT_MS + WATCHDOG_POLL_MS * 3);
    expect(flaps).toBeGreaterThan(1);
    // …and it is the FLAPPER who loses. Exactly one row, exactly one rating pair.
    expect(rows()).toHaveLength(1);
    expect(rows()[0].winnerId).toBe("uB");
    expect(rows()[0].loserId).toBe("uA");
    expect(eloUpdates()).toHaveLength(2);
    expect(forfeitedUserId()).toBe("uA");
    tearDown(room);
  });

  it("BOTH sides flapping in step cannot deadlock the grace against the watchdog", async () => {
    vi.useFakeTimers();
    const h = makeHarness([]);
    const room = await liveBattle(h);
    let elapsed = 0;
    while (elapsed < 60 * 60_000 && room.status === "active") {
      const away = RECONNECT_GRACE_MS - 200;
      beginDisconnectGrace("uA", h.deps);
      beginDisconnectGrace("uB", h.deps);
      await vi.advanceTimersByTimeAsync(away);
      h.present.add("uA"); h.present.add("uB");
      endDisconnectGrace("uA", h.deps); endDisconnectGrace("uB", h.deps);
      h.present.delete("uA"); h.present.delete("uB");
      await vi.advanceTimersByTimeAsync(5);
      elapsed += away + 5;
    }
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    // Nobody to hand it to: unrated cancel, one row, no winner, no rating move.
    expect(room.status).toBe("cancelled");
    expect(room.winnerId).toBeUndefined();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].winnerId).toBeNull();
    expect(eloUpdates()).toHaveLength(0);
    tearDown(room);
  });
});

// ── …and terminates exactly once ──────────────────────────────────────────

describe("one battle, one result", () => {
  it("the bounded watchdog and the side's own grace timer coming due together produce one row", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    await burnBudget("uA", h);
    expect(room.a.graceCreditedMs).toBe(MAX_TURN_CREDIT_MS);
    // Away for good, with both the poll and the 45 s grace timer in play.
    h.present.delete("uA");
    beginDisconnectGrace("uA", h.deps);
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    expect(rows()).toHaveLength(1);
    expect(eloUpdates()).toHaveLength(2);
    expect(rows()[0].winnerId).toBe("uB");
    expect(rows()[0].loserId).toBe("uA");
    expect(forfeitedUserId()).toBe("uA");
    tearDown(room);
  });

  it("an absent side never WINS the bounded timeout on the movedAt tiebreak", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    // The timeout tiebreak is "whoever submitted most recently wins". On a turn
    // where neither side has chosen yet that reads the PREVIOUS turn, which is
    // a coin flip — so rig it in the absent player's favour and check that
    // absence still decides.
    applyChoice(room, "uB", "move 1");
    await vi.advanceTimersByTimeAsync(100);
    applyChoice(room, "uA", "move 1");
    await vi.advanceTimersByTimeAsync(100);
    expect(room.a.movedAt!).toBeGreaterThan(room.b.movedAt!);
    await burnBudget("uA", h);
    h.present.delete("uA");
    beginDisconnectGrace("uA", h.deps);
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    expect(room.winnerId).toBe("uB");
    expect(room.loserId).toBe("uA");
    expect(rows()).toHaveLength(1);
    tearDown(room);
  });

  it("50 graces expiring in the same tick produce 50 rows and 50 rating pairs", async () => {
    vi.useFakeTimers();
    const h = makeHarness([]);
    const built: BattleRoom[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `b_fb_bulk${i}`;
      const team = (x: string) => [{ speciesKey: "pikachu", name: x, level: 50, moves: [{ id: "thunderShock" }] }];
      const room: BattleRoom = {
        id, status: "active", format: "random50",
        createdAt: Date.now(), lastChoiceAt: Date.now(),
        a: { userId: `a${i}`, username: `A${i}`, team: team("a"), stream: null, request: null, connected: true },
        b: { userId: `b${i}`, username: `B${i}`, team: team("b"), stream: null, request: null, connected: true },
        log: [], stream: { write: () => undefined, destroy: () => undefined },
        expiryTimer: null, spectators: new Set(),
      };
      battleRooms.set(id, room);
      built.push(room);
      h.present.add(`b${i}`);
    }
    for (let i = 0; i < 50; i++) beginDisconnectGrace(`a${i}`, h.deps);
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 5);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toHaveLength(50);
    expect(new Set(rows().map((r: any) => r.id)).size).toBe(50);
    expect(eloUpdates()).toHaveLength(100);
    for (const r of built) tearDown(r);
  });
});

// ── The bound must not re-break defect 1 ──────────────────────────────────

describe("the reconnect grace itself is untouched", () => {
  it("a blip with budget in hand is still fully covered", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    await vi.advanceTimersByTimeAsync(120_000);
    h.present.delete("uA");
    beginDisconnectGrace("uA", h.deps);
    await vi.advanceTimersByTimeAsync(8_000);
    h.present.add("uA");
    endDisconnectGrace("uA", h.deps);
    await vi.advanceTimersByTimeAsync(WATCHDOG_POLL_MS * 2);
    const status = room.status;
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    expect(status).toBe("active");
    expect(rows()).toHaveLength(0);
    tearDown(room);
  });

  it("two 40 s blips inside one turn — 80 s away — still forfeit nobody", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    for (const at of [60_000, 100_000]) {
      await vi.advanceTimersByTimeAsync(at);
      h.present.delete("uA");
      beginDisconnectGrace("uA", h.deps);
      await vi.advanceTimersByTimeAsync(40_000);
      h.present.add("uA");
      endDisconnectGrace("uA", h.deps);
    }
    await vi.advanceTimersByTimeAsync(WATCHDOG_POLL_MS);
    const status = room.status;
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    expect(room.a.graceCreditedMs).toBe(80_000);
    expect(status).toBe("active");
    expect(rows()).toHaveLength(0);
    tearDown(room);
  });

  it("a long battle with a blip every turn — 160 s away, well past the budget — keeps playing", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    const room = await liveBattle(h);
    for (let turn = 0; turn < 8 && room.status === "active"; turn++) {
      h.present.delete("uA");
      beginDisconnectGrace("uA", h.deps);
      await vi.advanceTimersByTimeAsync(20_000);
      h.present.add("uA");
      endDisconnectGrace("uA", h.deps);
      applyChoice(room, "uA", "move 1");
      applyChoice(room, "uB", "move 1");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const status = room.status;
    const endReason = room.endReason;
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    // Either still going or finished by KO — never a forfeit or a timeout.
    expect(status === "active" || endReason === "ko").toBe(true);
    tearDown(room);
  });
});

// ── endBattle freezes its outcome before the ELO await ────────────────────

describe("endBattle cannot persist a different match than it rated", () => {
  it("a battle:cancel-style mutation during the ELO await does not reach the row", async () => {
    const h = makeHarness(["uB"]);
    const id = "b_fb_snapshot";
    const team = (x: string) => [{ speciesKey: "pikachu", name: x, level: 50, moves: [{ id: "thunderShock" }] }];
    const room: BattleRoom = {
      id, status: "active", format: "random50",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: { userId: "uA", username: "Alice", team: team("a"), stream: null, request: null, connected: true },
      b: { userId: "uB", username: "Bob", team: team("b"), stream: null, request: null, connected: true },
      log: [], stream: { write: () => undefined, destroy: () => undefined },
      expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(id, room);

    // Hold the Elo transaction open so the window is deterministic instead of
    // "however long Railway takes".
    let release: (() => void) | null = null;
    (db.prisma.$transaction as any).mockImplementationOnce(async (fn: any) => {
      await new Promise<void>((res) => { release = res; });
      return fn({ playerRating: { upsert: db.ratingUpsert, update: db.ratingUpdate } });
    });

    room.a.awayAt = Date.now() - RECONNECT_GRACE_MS;
    resolveReconnectGrace(id, "a", h.deps);
    await Promise.resolve();
    expect(room.status).toBe("completed");
    expect(release).not.toBeNull();

    // socket.ts battle:cancel, else branch, verbatim — the survivor's "Yes,
    // forfeit" click landing on a room that just finished.
    room.status = "cancelled";
    battleRooms.delete(id);
    // …and, for good measure, a winnerId overwrite naming the AWAY player.
    room.winnerId = "uA";
    room.loserId = "uB";

    release!();
    await new Promise((r) => setTimeout(r, 20));

    const row = rows()[0];
    expect(row.status).toBe("completed");
    expect(row.endReason).toBe("forfeit");
    expect(row.winnerId).toBe("uB");
    expect(row.loserId).toBe("uA");
    // The single invariant that matters: the row and the ratings describe the
    // same match.
    expect(row.winnerId).toBe(eloWinnerId());
    expect(forfeitedUserId()).toBe("uA");
    tearDown(room);
  });
});
