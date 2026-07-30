// PvP reconnect-grace regression tests.
//
// Four live defects are pinned here, all of them by EXECUTION rather than by
// reading the code:
//   * a disconnect was an INSTANT rated loss — the socket disconnect handler
//     named the opponent winner and forfeited with zero grace, so a wifi blip
//     or a page reload cost a rated loss plus a `forfeits` increment.
//   * the AFK watchdog would have defeated the grace anyway: it polls every
//     30 s against a turn clock that does not advance while a side is away,
//     so a disconnect late in a turn (or a RETURN late in a turn) got
//     timeout-forfeited by the other mechanism.
//   * the matchmaking queue was dropped silently on disconnect, leaving the
//     client's "Searching for opponent…" toast ticking forever.
//   * a restart evaporated live battles with no record and no way for a
//     client to find out.
//
// The anti-cheat proof is the last describe: a rejoin must replay the
// SIDE-FILTERED stream, never room.log. room.log is @pkmn/sim's omniscient
// channel and carries both sides' secret |split| halves plus both |request|
// payloads — replaying it to a participant would hand them the opponent's
// full team. That test runs a real simulator battle and asserts the
// opponent's unrevealed Pokémon appears in room.log and nowhere in the
// snapshot.
//
// DB stubbing: pvp.ts imports ./db.js (prisma) for the PvpMatch row and the
// Elo transaction — vi.mock below replaces it, so no test here can construct
// a PrismaClient. Nothing imports ../src/socket.js: every piece of grace
// logic takes its transport and its presence predicate as parameters
// precisely so it is reachable without a socket server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const ratingUpsert = vi.fn(async ({ where }: any) => ({
    userId: where.userId,
    rating: 1000,
    peakRating: 1000,
  }));
  const ratingUpdate = vi.fn(async () => ({}));
  const matchCreate = vi.fn(async () => ({}));
  const tx = { playerRating: { upsert: ratingUpsert, update: ratingUpdate } };
  return {
    ratingUpsert,
    ratingUpdate,
    matchCreate,
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
  endBattle,
  startBattle,
  beginDisconnectGrace,
  endDisconnectGrace,
  beginReconnectGrace,
  resolveReconnectGrace,
  resolveRejoin,
  resolveSync,
  snapshotForSide,
  joinQueue,
  leaveQueue,
  popQueuePair,
  beginQueueGrace,
  cancelQueueGrace,
  matchmakingQueue,
  queueIndexOf,
  queuedUserIds,
  RECONNECT_GRACE_MS,
  WATCHDOG_POLL_MS,
  QUEUE_GRACE_MS,
  TURN_TIMEOUT_MS,
  type BattleRoom,
  type GraceDeps,
} from "../src/pvp.js";
import { passTeamPreview, passTeamPreviewFake } from "./support/teamPreview.js";

// ── Harness ───────────────────────────────────────────────────────────────

interface Ev { userId: string; event: string; payload: any }

function makeHarness(presentUserIds: string[]) {
  const events: Ev[] = [];
  const present = new Set(presentUserIds);
  const queueDropped: string[] = [];
  const deps: GraceDeps = {
    sendToUser: (userId, event, payload) => { events.push({ userId, event, payload }); },
    isPresent: (userId) => present.has(userId),
    onQueueDropped: (userId) => { queueDropped.push(userId); },
  };
  return {
    events,
    present,
    queueDropped,
    deps,
    of: (event: string) => events.filter((e) => e.event === event),
  };
}

let roomSeq = 0;
function makeActiveRoom(format = "anything-goes"): BattleRoom {
  const id = `b_rc${++roomSeq}`;
  const team = (name: string) => [
    { speciesKey: "pikachu", name, level: 50, moves: [{ id: "thunderShock" }] },
  ];
  const room: BattleRoom = {
    id,
    status: "active",
    format,
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: team("Pika-A"), stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: team("Pika-B"), stream: null, request: null, connected: true },
    log: [],
    // endBattle destroys the stream; a stub keeps the hand-built rooms out of
    // the simulator entirely so the timer behaviour is what's under test.
    stream: { write: () => undefined, destroy: () => undefined },
    expiryTimer: null,
    spectators: new Set(),
  };
  battleRooms.set(id, room);
  return room;
}

function tearDown(room: BattleRoom): void {
  if (room.expiryTimer) clearInterval(room.expiryTimer);
  if (room.a.graceTimer) clearTimeout(room.a.graceTimer);
  if (room.b.graceTimer) clearTimeout(room.b.graceTimer);
  battleRooms.delete(room.id);
}

// ── A. Grace mechanics, fake timers, no simulator ─────────────────────────

describe("reconnect grace — a disconnect is no longer an instant rated loss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    db.matchCreate.mockClear();
    db.ratingUpsert.mockClear();
    db.ratingUpdate.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const id of [...battleRooms.keys()]) {
      if (id.startsWith("b_rc")) battleRooms.delete(id);
    }
  });

  it("does NOT forfeit inside the window, and DOES once it expires", async () => {
    const room = makeActiveRoom();
    const h = makeHarness(["uA"]);          // uB's last socket just went away
    const t0 = Date.now();

    beginDisconnectGrace("uB", h.deps);

    // The surviving player is told something immediately — sendToUser is a
    // silent no-op for the away player, so if this event didn't exist we'd
    // have traded a bad loss for a frozen board.
    const away = h.of("battle:opponent-away");
    expect(away).toHaveLength(1);
    expect(away[0].userId).toBe("uA");
    expect(away[0].payload).toEqual({
      battleId: room.id,
      username: "Bob",
      graceEndsAt: t0 + RECONNECT_GRACE_MS,
    });

    // One second before expiry: still a live battle, nothing rated.
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1_000);
    expect(room.status).toBe("active");
    expect(h.of("battle:complete")).toHaveLength(0);
    expect(db.matchCreate).not.toHaveBeenCalled();

    // Past expiry, still absent: now it's a forfeit, exactly as before —
    // just 45 s later.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("forfeit");
    expect(room.winnerId).toBe("uA");
    expect(room.loserId).toBe("uB");
    expect(h.of("battle:complete")).toHaveLength(2);   // one per participant
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    tearDown(room);
  });

  it("resumes on reconnect and credits the away time back to the turn clock", async () => {
    const room = makeActiveRoom();
    const h = makeHarness(["uA"]);
    const clockBefore = room.lastChoiceAt;

    beginDisconnectGrace("uB", h.deps);
    await vi.advanceTimersByTimeAsync(20_000);
    h.present.add("uB");
    const resumed = endDisconnectGrace("uB", h.deps);

    expect(resumed.battleIds).toEqual([room.id]);
    expect(room.b.awayAt).toBeNull();
    const back = h.of("battle:opponent-back");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ userId: "uA", payload: { battleId: room.id, username: "Bob" } });
    // The credit: the 20 s they were gone is handed back, so they don't lose
    // turn time they were never able to use.
    expect(room.lastChoiceAt).toBe(clockBefore + 20_000);

    // And the pending forfeit is gone for good.
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS * 2);
    expect(room.status).toBe("active");
    expect(h.of("battle:complete")).toHaveLength(0);
    tearDown(room);
  });

  it("never credits more than the away time, and caps a flapping client", async () => {
    const room = makeActiveRoom();
    const h = makeHarness(["uA", "uB"]);
    const clockBefore = room.lastChoiceAt;

    // Three full-window flaps = 135 s of raw away time, capped at 90 s.
    for (let i = 0; i < 3; i++) {
      h.present.delete("uB");
      beginDisconnectGrace("uB", h.deps);
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 1_000);
      h.present.add("uB");
      endDisconnectGrace("uB", h.deps);
    }
    expect(room.lastChoiceAt - clockBefore).toBe(90_000);
    // Never pushed past now — a reconnect restores lost time, it does not buy
    // a longer turn than a present player gets.
    expect(room.lastChoiceAt).toBeLessThanOrEqual(Date.now());
    expect(room.status).toBe("active");
    tearDown(room);
  });

  it("re-announcing an existing grace does not extend it or start a second timer", async () => {
    const room = makeActiveRoom();
    const h = makeHarness(["uA"]);
    const t0 = Date.now();

    beginReconnectGrace(room, "b", h.deps);
    const firstTimer = room.b.graceTimer;
    await vi.advanceTimersByTimeAsync(30_000);
    beginReconnectGrace(room, "b", h.deps);   // second tab closes

    expect(room.b.graceTimer).toBe(firstTimer);
    const away = h.of("battle:opponent-away");
    expect(away).toHaveLength(2);
    // Same deadline both times — a flapping client must not be able to
    // extend the window indefinitely.
    expect(away[1].payload.graceEndsAt).toBe(away[0].payload.graceEndsAt);
    expect(away[1].payload.graceEndsAt).toBe(t0 + RECONNECT_GRACE_MS);

    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(h.of("battle:complete")).toHaveLength(2);  // exactly one end, both sides told
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    tearDown(room);
  });

  it("rates a random50 forfeit exactly once when the grace expires", async () => {
    const room = makeActiveRoom("random50");
    const h = makeHarness(["uA"]);
    beginDisconnectGrace("uB", h.deps);
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1_000);

    expect(room.endReason).toBe("forfeit");
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    // One Elo transaction: upsert both rows, update both rows.
    expect(db.ratingUpsert).toHaveBeenCalledTimes(2);
    expect(db.ratingUpdate).toHaveBeenCalledTimes(2);
    // The loser takes a `forfeits` increment, not a `losses` one.
    const loserUpdate = db.ratingUpdate.mock.calls
      .map((c: any[]) => c[0])
      .find((arg: any) => arg.where.userId === "uB");
    expect(loserUpdate.data.forfeits).toEqual({ increment: 1 });
    tearDown(room);
  });

  it("cancels UNRATED with no winner when both sides are away (the rolling-deploy case)", async () => {
    const room = makeActiveRoom("random50");
    const h = makeHarness([]);                       // both sockets gone
    beginDisconnectGrace("uA", h.deps);
    await vi.advanceTimersByTimeAsync(500);           // A's TCP closed first
    beginDisconnectGrace("uB", h.deps);

    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1_000);

    expect(room.status).toBe("cancelled");
    expect(room.endReason).toBe("cancelled");
    // Naming a winner here would hand a rated win to whichever connection
    // happened to close a millisecond later.
    expect(room.winnerId).toBeUndefined();
    expect(room.loserId).toBeUndefined();
    expect(db.ratingUpsert).not.toHaveBeenCalled();
    // Still exactly one record — the bracket reads "cancelled" as dead and
    // re-runs the pairing instead of advancing a phantom winner.
    expect(db.matchCreate).toHaveBeenCalledTimes(1);

    // B's timer fires next and must be a complete no-op.
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    expect(room.winnerId).toBeUndefined();
    tearDown(room);
  });

  it("a stale grace resolution on a finished room does not rewrite winnerId", async () => {
    // The bracket-corruption tripwire. winnerId is written by CALLERS, not by
    // endBattle, and the tournament runner reads it off a finished room for
    // five seconds. A grace timer that wrote winnerId after a legitimate KO
    // would leave rows and ratings correct and still advance the LOSER.
    const room = makeActiveRoom("random50");
    const h = makeHarness(["uA"]);
    beginDisconnectGrace("uB", h.deps);

    // An away player CAN win: their choice was already submitted, the turn
    // resolved, |win| fired. This must stand.
    room.winnerId = "uB";
    room.loserId = "uA";
    await endBattle(room, h.deps.sendToUser, "ko");
    expect(db.matchCreate).toHaveBeenCalledTimes(1);

    // Invoke the timer body directly — this is exactly what a timer that
    // escaped the teardown would run.
    resolveReconnectGrace(room.id, "b", h.deps);

    expect(room.winnerId).toBe("uB");
    expect(room.loserId).toBe("uA");
    expect(room.endReason).toBe("ko");
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    tearDown(room);
  });

  it("endBattle clears both sides' grace timers so nothing outlives the room", async () => {
    const room = makeActiveRoom();
    const h = makeHarness([]);
    beginDisconnectGrace("uA", h.deps);
    beginDisconnectGrace("uB", h.deps);
    expect(room.a.graceTimer).toBeTruthy();
    expect(room.b.graceTimer).toBeTruthy();

    await endBattle(room, h.deps.sendToUser, "cancelled");
    expect(room.a.graceTimer).toBeNull();
    expect(room.b.graceTimer).toBeNull();
    expect(room.a.awayAt).toBeNull();
    expect(room.b.awayAt).toBeNull();

    const eventCount = h.events.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.events.length).toBe(eventCount);
    expect(db.matchCreate).toHaveBeenCalledTimes(1);
    tearDown(room);
  });

  it("resumes off presence alone when the resume hook was never called", async () => {
    // Belt and braces: `online` is the authority, so a missed connection hook
    // must not cost a rated loss.
    const room = makeActiveRoom();
    const h = makeHarness(["uA"]);
    beginDisconnectGrace("uB", h.deps);
    h.present.add("uB");                    // back, but nobody told the room
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1_000);

    expect(room.status).toBe("active");
    expect(room.b.awayAt).toBeNull();
    expect(h.of("battle:opponent-back")).toHaveLength(1);
    expect(db.matchCreate).not.toHaveBeenCalled();
    tearDown(room);
  });

  it("leaves an invited room alone — an invite is cancelled, never graced", () => {
    const room = makeActiveRoom();
    room.status = "invited";
    const h = makeHarness(["uA"]);
    const result = beginDisconnectGrace("uB", h.deps);

    expect(result.battleIds).toEqual([]);
    expect(room.b.awayAt).toBeUndefined();
    expect(room.b.graceTimer).toBeUndefined();
    expect(h.of("battle:opponent-away")).toHaveLength(0);
    tearDown(room);
  });
});

// ── B. The watchdog / grace interleave, with the REAL watchdog ────────────
// startBattle installs the AFK watchdog as a setInterval, so this describe
// runs a real simulator battle under fake timers and drives that interval.

describe("AFK watchdog yields to the reconnect grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    db.matchCreate.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const id of [...battleRooms.keys()]) {
      if (id.startsWith("b_rc")) battleRooms.delete(id);
    }
  });

  /** Start a real battle and drain the simulator to a quiet turn 1. Both
   *  |request| payloads must have landed before the caller touches
   *  lastChoiceAt: the player pumps re-stamp it on every request, so a test
   *  that rewinds the clock too early has its rewind silently undone by the
   *  next microtask turn. */
  async function startAndSettle(room: BattleRoom, h: ReturnType<typeof makeHarness>) {
    room.status = "invited";              // startBattle upgrades it
    await startBattle(null as never, room, h.deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreviewFake(room, (ms) => vi.advanceTimersByTimeAsync(ms));
    for (let i = 0; i < 500; i++) {
      if (room.log.some((l) => l.startsWith("|turn|1")) && room.a.request && room.b.request) break;
      await Promise.resolve();
    }
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(room.log.some((l) => l.startsWith("|turn|1"))).toBe(true);
    expect(room.expiryTimer).toBeTruthy();   // the real watchdog is installed
  }

  it("skips the turn-timeout check while a side is away", async () => {
    const room = makeActiveRoom("random50");
    const h = makeHarness(["uA", "uB"]);
    await startAndSettle(room, h);

    // A turn that is 1 s from timing out, then a disconnect.
    //
    // Without the skip, the next poll lands inside the grace window (the
    // interval is phase-anchored to startBattle, not to lastChoiceAt), the
    // elapsed check is already true, and the away player is timeout-forfeited
    // by the watchdog — the exact outcome the grace exists to prevent,
    // reached through a different door.
    room.lastChoiceAt = Date.now() - (TURN_TIMEOUT_MS - 1_000);
    h.present.delete("uB");
    beginDisconnectGrace("uB", h.deps);

    await vi.advanceTimersByTimeAsync(WATCHDOG_POLL_MS + 1_000);
    // The watchdog's own predicate is now TRUE — this is what makes the
    // assertion below a real test of the guard and not of the arithmetic.
    expect(Date.now() - room.lastChoiceAt).toBeGreaterThan(TURN_TIMEOUT_MS);
    expect(room.status).toBe("active");
    expect(room.endReason).toBeUndefined();
    expect(h.of("battle:complete")).toHaveLength(0);

    await endBattle(room, undefined, "cancelled");
    tearDown(room);
  });

  it("credits the clock so the next poll after a reconnect does not time them out", async () => {
    // Skipping the poll is necessary but not sufficient. lastChoiceAt does not
    // advance while a side is away, so a player who returns near the end of a
    // turn is timeout-forfeited by the very next poll — under a minute after a
    // SUCCESSFUL reconnect, staring at a live board.
    const room = makeActiveRoom("random50");
    const h = makeHarness(["uA", "uB"]);
    await startAndSettle(room, h);

    // 50 s left on the turn — deliberately more than one poll interval, so
    // the outcome depends on the credit rather than on poll granularity.
    room.lastChoiceAt = Date.now() - (TURN_TIMEOUT_MS - 50_000);
    const uncredited = room.lastChoiceAt;
    h.present.delete("uB");
    beginDisconnectGrace("uB", h.deps);
    await vi.advanceTimersByTimeAsync(40_000);   // still inside the grace
    h.present.add("uB");
    endDisconnectGrace("uB", h.deps);
    expect(room.lastChoiceAt).toBe(uncredited + 40_000);

    await vi.advanceTimersByTimeAsync(WATCHDOG_POLL_MS + 1_000);
    // The counterfactual, asserted rather than argued: on the uncredited
    // clock this poll's predicate is true and they lose.
    expect(Date.now() - uncredited).toBeGreaterThan(TURN_TIMEOUT_MS);
    expect(Date.now() - room.lastChoiceAt).toBeLessThan(TURN_TIMEOUT_MS);
    expect(room.status).toBe("active");
    expect(room.endReason).toBeUndefined();
    expect(h.of("battle:complete")).toHaveLength(0);

    await endBattle(room, undefined, "cancelled");
    tearDown(room);
  });

  it("still times out a genuinely AFK player once nobody is away", async () => {
    // The guard must not disable the watchdog permanently.
    const room = makeActiveRoom("anything-goes");
    const h = makeHarness(["uA", "uB"]);
    await startAndSettle(room, h);

    room.a.movedAt = Date.now();          // A moved, B never did
    room.lastChoiceAt = Date.now() - (TURN_TIMEOUT_MS + 1_000);

    await vi.advanceTimersByTimeAsync(WATCHDOG_POLL_MS + 1_000);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("timeout");
    expect(room.winnerId).toBe("uA");
    tearDown(room);
  });
});

// ── C. Queue truth ────────────────────────────────────────────────────────

describe("matchmaking queue survives a disconnect instead of lying about it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const id of queuedUserIds()) cancelQueueGrace(id);
    matchmakingQueue.length = 0;
  });
  afterEach(() => {
    for (const id of queuedUserIds()) cancelQueueGrace(id);
    matchmakingQueue.length = 0;
    vi.useRealTimers();
  });

  const entry = (userId: string) => ({
    userId,
    username: userId.toUpperCase(),
    team: [{ speciesKey: "pikachu", level: 50, moves: [{ id: "thunderShock" }] }],
    joinedAt: Date.now(),
  });

  it("holds a disconnected player's slot and hides it from pairing", async () => {
    const h = makeHarness([]);
    joinQueue(entry("q1"));
    joinQueue(entry("q2"));

    expect(beginQueueGrace("q1", h.deps)).toBe(true);
    // Held, not dropped: the slot and its FIFO position survive.
    expect(matchmakingQueue).toHaveLength(2);
    expect(queueIndexOf("q1")).toBe(0);
    // …and invisible to pairing. Popping an absent player is how the 3-second
    // matchmaking ticker used to defeat the hold within one tick: the caller
    // finds them offline and drops the entry permanently, emitting nothing.
    expect(popQueuePair()).toBeNull();

    // A live third player pairs with q2 around the held entry.
    joinQueue(entry("q3"));
    const pair = popQueuePair();
    expect(pair?.map((e) => e.userId)).toEqual(["q2", "q3"]);
    expect(queuedUserIds()).toEqual(["q1"]);

    // Hold expires while they're still gone → dropped, and the caller is
    // told so it can emit battle:queue:left + re-broadcast the size. The old
    // code dropped them here with nothing emitted, so the client's
    // "Searching for opponent… 14m 32s" toast ticked forever.
    await vi.advanceTimersByTimeAsync(QUEUE_GRACE_MS + 1_000);
    expect(queueIndexOf("q1")).toBe(-1);
    expect(h.queueDropped).toEqual(["q1"]);
  });

  it("releases the hold on reconnect, on re-queue and on explicit dequeue", async () => {
    const h = makeHarness([]);
    joinQueue(entry("q1"));
    joinQueue(entry("q2"));

    beginQueueGrace("q1", h.deps);
    endDisconnectGrace("q1", h.deps);
    expect(matchmakingQueue[0].awayAt).toBeNull();
    expect(popQueuePair()?.map((e) => e.userId)).toEqual(["q1", "q2"]);

    // Re-queue clears a stale hold, so a later expiry can't dequeue them.
    joinQueue(entry("q4"));
    beginQueueGrace("q4", h.deps);
    joinQueue(entry("q4"));
    await vi.advanceTimersByTimeAsync(QUEUE_GRACE_MS + 1_000);
    expect(queueIndexOf("q4")).toBe(0);
    expect(h.queueDropped).toEqual([]);

    // An orphan timer that outlived its entry must not dequeue a later
    // re-queue either.
    beginQueueGrace("q4", h.deps);
    leaveQueue("q4");
    joinQueue(entry("q4"));
    await vi.advanceTimersByTimeAsync(QUEUE_GRACE_MS + 1_000);
    expect(queueIndexOf("q4")).toBe(0);
    expect(h.queueDropped).toEqual([]);
  });

  it("reports whether a reconnecting user still holds a queue slot", () => {
    const h = makeHarness([]);
    joinQueue(entry("q1"));
    beginQueueGrace("q1", h.deps);
    expect(endDisconnectGrace("q1", h.deps).queueHeld).toBe(true);
    // Second time: nothing held, so the caller knows not to claim a resume.
    expect(endDisconnectGrace("q1", h.deps).queueHeld).toBe(false);
  });
});

// ── D. Rejoin / sync ack contract ─────────────────────────────────────────

describe("battle:rejoin / battle:sync ack shapes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    db.matchCreate.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const id of [...battleRooms.keys()]) {
      if (id.startsWith("b_rc")) battleRooms.delete(id);
    }
  });

  it("answers a live battle with a usable snapshot", () => {
    const room = makeActiveRoom("random50");
    room.a.request = { active: [{ moves: [{ id: "thundershock" }] }], side: { id: "p1" } };
    room.a.log = ["|player|p1|Alice", "|turn|1"];
    const res = resolveRejoin("uA", room.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.snapshot).toEqual({
      battleId: room.id,
      format: "random50",
      side: "a",
      opponent: { id: "uB", username: "Bob" },
      levelCap: 50,
      request: room.a.request,
      log: ["|player|p1|Alice", "|turn|1"],
      turnDeadlineAt: room.lastChoiceAt + TURN_TIMEOUT_MS,
    });
    tearDown(room);
  });

  it("discovers the battle when the client lost its battleId", () => {
    const room = makeActiveRoom();
    const res = resolveRejoin("uB");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.snapshot.side).toBe("b");
    expect(res.snapshot.levelCap).toBeNull();   // anything-goes has no cap
    tearDown(room);
  });

  it('distinguishes "gone" from "not_in_battle"', () => {
    const room = makeActiveRoom();
    // A battle the server does not have → the restart case. The client shows
    // "voided by a server restart, not rated".
    expect(resolveRejoin("uA", "b_does_not_exist")).toEqual({ ok: false, reason: "gone" });
    // A real battle you are not in — and we don't confirm the id exists
    // beyond saying you're not in it.
    expect(resolveRejoin("uC", room.id)).toEqual({ ok: false, reason: "not_in_battle" });
    // A fresh page load with no battleId. This MUST NOT be "gone", or every
    // battle-free reload shows the voided banner.
    tearDown(room);
    battleRooms.delete(room.id);
    expect(resolveRejoin("uC")).toEqual({ ok: false, reason: "not_in_battle" });
  });

  it("replays the real outcome before acking gone, so a forfeit is not reported as voided", async () => {
    // The hard tail: a player forfeited WHILE AWAY has no sockets, so their
    // battle:complete was dropped; the room is deleted five seconds later. If
    // "gone" were the whole answer they'd be told the match was voided and
    // unrated when in fact they lost and their rating moved.
    const room = makeActiveRoom("random50");
    const h = makeHarness(["uA"]);
    beginDisconnectGrace("uB", h.deps);
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 1_000);
    expect(room.endReason).toBe("forfeit");

    // Within the 5 s tail the room is still present but no longer active.
    const inTail = makeHarness([]);
    expect(resolveRejoin("uB", room.id, inTail.deps)).toEqual({ ok: false, reason: "gone" });
    expect(inTail.of("battle:complete")).toHaveLength(1);
    expect(inTail.of("battle:complete")[0].payload).toMatchObject({
      battleId: room.id, winnerId: "uA", loserId: "uB", reason: "forfeit",
    });

    // …and after the room is deleted, same answer plus the same replay.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(battleRooms.has(room.id)).toBe(false);
    const afterTail = makeHarness([]);
    expect(resolveSync("uB", room.id, afterTail.deps)).toEqual({ ok: false, reason: "gone" });
    expect(afterTail.of("battle:complete")).toHaveLength(1);

    // A third party must never be handed someone else's result.
    const stranger = makeHarness([]);
    expect(resolveSync("uC", room.id, stranger.deps)).toEqual({ ok: false, reason: "gone" });
    expect(stranger.of("battle:complete")).toHaveLength(0);
    tearDown(room);
  });

  it("battle:sync confirms a live battle and reports an unknown one as gone", () => {
    const room = makeActiveRoom();
    expect(resolveSync("uA", room.id)).toEqual({ ok: true, battleId: room.id });
    expect(resolveSync("uA", "b_evaporated")).toEqual({ ok: false, reason: "gone" });
    expect(resolveSync("uC", room.id)).toEqual({ ok: false, reason: "gone" });
    expect(resolveSync("uA", undefined)).toEqual({ ok: false, reason: "gone" });
    tearDown(room);
  });
});

// ── E. Anti-cheat: the rejoin snapshot must not leak the opponent ─────────
// Real seeded @pkmn/sim battle, real timers. This is the test that stops the
// rejoin from being a cheat: room.log is the omniscient channel (-1) and
// carries both sides' secret |split| halves plus both |request| payloads.

describe("rejoin snapshot leaks nothing about the opponent", () => {
  function makeSecretRoom(format: string): BattleRoom {
    const id = `b_rcSecret_${format}`;
    const room: BattleRoom = {
      id,
      status: "invited",
      format,
      createdAt: Date.now(),
      lastChoiceAt: Date.now(),
      a: {
        userId: "uA", username: "Alice", stream: null, request: null, connected: true,
        team: [
          { speciesKey: "pikachu", name: "LeadA", level: 50, moves: [{ id: "thunderShock" }] },
          // Never sent out, so it is never revealed to the opponent — the
          // canary for a leak.
          { speciesKey: "snorlax", name: "SecretAlpha", level: 50, moves: [{ id: "tackle" }] },
        ],
      },
      b: {
        userId: "uB", username: "Bob", stream: null, request: null, connected: true,
        team: [
          { speciesKey: "geodude", name: "LeadB", level: 50, moves: [{ id: "tackle" }] },
          { speciesKey: "lapras", name: "SecretBravo", level: 50, moves: [{ id: "tackle" }] },
        ],
      },
      log: [],
      stream: null,
      expiryTimer: null,
      spectators: new Set(),
    };
    battleRooms.set(id, room);
    return room;
  }

  async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("replays only bytes that client already received live", async () => {
    const room = makeSecretRoom("anything-goes");
    const h = makeHarness(["uA", "uB"]);
    await startBattle(null as never, room, h.deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await waitFor(() => room.log.some((l) => l.startsWith("|turn|1")));

    // Exact equality with the delivered stream is the security argument: a
    // replay that equals what the client already had cannot leak anything.
    for (const [side, userId] of [["a", "uA"], ["b", "uB"]] as const) {
      const delivered = h.events
        .filter((e) => e.userId === userId && e.event === "battle:state")
        .map((e) => e.payload.chunk as string)
        .join("\n")
        .split("\n")
        .filter(Boolean);
      expect(delivered.length).toBeGreaterThan(5);
      expect(snapshotForSide(room, userId)!.log).toEqual(delivered);
      expect(snapshotForSide(room, userId)!.side).toBe(side);
    }

    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });

  it("contains no trace of the opponent's unrevealed team or private request", async () => {
    const room = makeSecretRoom("random50");
    const h = makeHarness(["uA", "uB"]);
    await startBattle(null as never, room, h.deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await waitFor(() =>
      room.log.some((l) => l.startsWith("|turn|1"))
      && room.a.request != null && room.b.request != null
    );

    const snapA = snapshotForSide(room, "uA")!;
    const snapB = snapshotForSide(room, "uB")!;
    const jsonA = JSON.stringify(snapA);
    const jsonB = JSON.stringify(snapB);

    // Each side's benched Pokémon is never sent out, so it is never revealed
    // to the opponent — the canary. Each side sees its own and NOT the
    // other's, anywhere in the payload: not in the log, not in the request,
    // not in a stray field.
    expect(jsonA).toContain("SecretAlpha");
    expect(jsonA).not.toContain("SecretBravo");
    expect(jsonB).toContain("SecretBravo");
    expect(jsonB).not.toContain("SecretAlpha");

    // Generalised: no line that was exclusive to the opponent's stream may
    // appear in this side's replay. This is the format-independent version of
    // the assertion above — it holds whatever @pkmn/sim decides to split.
    const aLines = new Set(room.a.log ?? []);
    const bOnly = (room.b.log ?? []).filter((l) => !aLines.has(l));
    expect(bOnly.length).toBeGreaterThan(0);          // B really does have private lines
    for (const line of bOnly) expect(snapA.log).not.toContain(line);

    // And the structural point behind using the per-side log at all: room.log
    // is the omniscient channel, and |request| payloads arrive as `sideupdate`
    // so they never reach it. room.log is therefore not merely unsafe to
    // replay, it is also insufficient — it cannot rebuild a chooser.
    expect(room.log.some((l) => l.startsWith("|request|"))).toBe(false);
    expect(snapA.log.some((l) => l.startsWith("|request|"))).toBe(true);
    expect(snapA.log).not.toEqual(room.log);

    // request is this side's own, by identity.
    expect(snapA.request).toBe(room.a.request);
    expect(snapA.request).not.toBe(room.b.request);
    expect(snapB.request).toBe(room.b.request);

    // No stray keys — in particular no `team`, and nothing that could carry
    // the other side's state.
    expect(Object.keys(snapA).sort()).toEqual([
      "battleId", "format", "levelCap", "log", "opponent", "request", "side", "turnDeadlineAt",
    ]);
    expect(snapA.levelCap).toBe(50);                     // random50
    expect(snapA.opponent).toEqual({ id: "uB", username: "Bob" });

    // A non-participant gets nothing at all.
    expect(snapshotForSide(room, "uC")).toBeNull();

    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });
});
