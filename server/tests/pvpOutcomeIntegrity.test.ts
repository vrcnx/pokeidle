// Outcome-integrity regressions for PvP: four defects that all live in the seam
// between "the battle ended" and "who the record says won".
//
// Every one was reproduced by EXECUTION against a real @pkmn/sim battle before
// it was fixed, and the reproduction is what each test still runs.
//
//   1. pumpOmniLog wrote room.winnerId / loserId / endReason on a `|win|` line
//      with no status guard. endBattle does not decide the winner — it only
//      persists whatever the room says — so a chunk drained after some other
//      end path finished the battle RENAMED the winner on a completed room,
//      after the PvpMatch row and the ELO had already gone out naming the other
//      player, and tournamentRunner.battleOutcome reads room.winnerId off the
//      finished room for the five seconds before deletion. The only thing
//      standing in the way was endBattle's room.stream.destroy() killing the
//      pump first — and endBattle deliberately SWALLOWS a throw from destroy().
//      Reproduced with exactly that: row says uB, room said uA.
//
//   2. cancelReconnectGrace pushed room.lastChoiceAt into the FUTURE. Its
//      comment claimed "lastChoiceAt can never be pushed past now"; the
//      invariant assumed lastChoiceAt <= awayAt, but the OPPONENT keeps playing
//      during the away window and every choice / |request| re-stamps the clock
//      to now, so the credit landed on top of a clock that had already moved.
//      Measured at +10 s with a single opponent choice mid-window.
//
//   3. A VOIDED battle published both players' full teams. The shutdown drain
//      and the both-sides-away branch write a "cancelled" PvpMatch row, and the
//      row carried the raw team JSON — species, nickname, item, ability, moves,
//      IVs, EVs, including Pokémon that never took the field — which
//      GET /pvp/match/:id/replay hands to either participant. A cancelled row
//      is read as dead by the bracket, so the pairing is RE-RUN: the same two
//      players meet again with one side's team known, in a format that
//      deliberately disables Team Preview.
//
//   4. startBattle accepted new battles during the shutdown drain. socket.ts
//      guarded its own four entry points and exported an isShuttingDown() with
//      zero consumers in src/, while tournamentRunner's bracket ticker and the
//      admin start-match route call startBattle directly — so the ticker could
//      spawn a real battle into a process that was already exiting, after the
//      drain's sweep had run and with nothing left to void it.
//
// DB stubbing follows pvp.test.ts: vi.mock replaces ../src/db.js so nothing
// here can construct a PrismaClient. Nothing imports ../src/socket.js.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  endBattle,
  applyChoice,
  flushPvpPersists,
  beginReconnectGrace,
  cancelReconnectGrace,
  beginDisconnectGrace,
  endDisconnectGrace,
  beginDrain,
  isDraining,
  resetDrainForTests,
  RECONNECT_GRACE_MS,
  MAX_TURN_CREDIT_MS,
  TURN_TIMEOUT_MS,
  WATCHDOG_POLL_MS,
  type BattleRoom,
  type GraceDeps,
} from "../src/pvp.js";

// ── Harness ───────────────────────────────────────────────────────────────

const io = { to: () => ({ emit: () => {} }) } as any;
const rows = () => db.matchCreate.mock.calls.map((c: any) => c[0].data);
const eloUpdates = () => db.ratingUpdate.mock.calls.map((c: any) => c[0]);
const eloWinnerId = () => eloUpdates().find((u: any) => u.data.wins)?.where.userId;
const forfeitedUserId = () => eloUpdates().find((u: any) => u.data.forfeits)?.where.userId;

function makeHarness(present: string[]) {
  const p = new Set(present);
  const events: { userId: string; event: string; payload: any }[] = [];
  const deps: GraceDeps = {
    sendToUser: (userId, event, payload) => { events.push({ userId, event, payload }); },
    isPresent: (u) => p.has(u),
  };
  return { present: p, deps, events, of: (e: string) => events.filter((x) => x.event === e) };
}

// A deterministic one-hit KO. Turn 1 produces `|win|`, which is what makes both
// the "buffered win" reproduction and the CONTROL below repeatable.
//
// THIS FIXTURE HAS TO SURVIVE LEVEL NORMALISATION — do not "simplify" it back.
//
// startBattle normalises every Pokémon to levelCapForFormat, and for random50
// that is Lv 50 in BOTH directions (lib/pvpFormat.ts's normalizeTeamLevel). It
// used to only ever LOWER, which is the defect that made the rated ladder
// unplayable for ~94% of real accounts, so the raising half is a production fix
// and not negotiable. The consequence for this file is that the levels below
// are NOT what fights: the Lv 100 Machamp is normalised DOWN to 50 and the Lv 5
// Magikarp is normalised UP to 50, so the two are at parity and a 60-BP
// neutral move no longer one-shots anything.
//
// Concretely, the original fixture was Aerial Ace, and after normalisation it
// deals 46-54 to a Lv 50 Magikarp's 95 HP — two turns, so the CONTROL's
// one-turn script left the battle "active" and the previous attempt at the
// production fix was REVERTED over the resulting failure. The assertion was
// always right; the setup was what assumed a cap.
//
// So: Close Combat. 120 BP with Fighting STAB off Machamp's base 130 Attack
// deals a minimum of 135 to those 95 HP even at zero EVs and a neutral nature
// — a guaranteed turn-1 KO at Lv 50 AND at Lv 100 (the "tournament" rooms
// below have no cap, so they normalise nothing). 100% accuracy, so no roll
// decides whether the test passes. Magikarp is faster at parity (Spe 100 vs
// 55) and moves first with Splash, which changes the ORDER inside turn 1 but
// not the outcome. Custom Game does not enforce learnsets — see
// lib/pvpTeamValidation.ts — so the fixture is free to pick the move that makes
// the turn deterministic.
const killerTeam = [{
  speciesKey: "machamp", nickname: "SLUGGER", level: 100,
  ability: "guts", moves: [{ id: "closeCombat" }],
}];
const doomedTeam = [{
  speciesKey: "magikarp", nickname: "DOOMED", level: 5,
  ability: "swiftSwim", moves: [{ id: "splash" }],
}];

let seq = 0;
function makeRoom(format: string, aTeam: unknown, bTeam: unknown): BattleRoom {
  const id = `b_oi${++seq}`;
  const room: BattleRoom = {
    id, status: "invited", format,
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: aTeam as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: bTeam as never, stream: null, request: null, connected: true },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  db.matchCreate.mockClear();
  db.ratingUpdate.mockClear();
  db.ratingUpsert.mockClear();
  resetDrainForTests();
});
afterEach(() => {
  resetDrainForTests();
  for (const [id, room] of [...battleRooms]) {
    if (id.startsWith("b_oi")) tearDown(room);
  }
});

// ══ 1 · the omniscient pump may not rewrite a finished battle ═════════════

describe("a buffered |win| cannot rename the winner of a finished battle", () => {
  it("keeps the forfeit result when the simulator's win arrives after the end", async () => {
    const h = makeHarness(["uA", "uB"]);
    const room = makeRoom("random50", killerTeam, doomedTeam);
    await startBattle(io, room, h.deps.sendToUser!);
    await settle(150);

    // Reproduce the one condition the old code depended on and does not
    // enforce: endBattle wraps room.stream.destroy() in try/catch and swallows
    // the throw, so a destroy that fails leaves the omni pump running on a
    // finished battle. `write` still forwards, so the simulator is real.
    const real = room.stream!;
    room.stream = {
      write: (d: string) => real.write(d),
      destroy: () => { throw new Error("destroy failed"); },
    };

    // Both choices in one synchronous block: A's write resolves the turn and
    // the |win| is produced, but the pump only drains on a later microtask.
    applyChoice(room, "uB", "move 1");
    applyChoice(room, "uA", "move 1");
    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(false);

    // Another end path lands first — here the away player A is forfeited, so
    // B is the winner of record. This is the ordering that used to corrupt.
    room.winnerId = "uB";
    room.loserId = "uA";
    await endBattle(room, h.deps.sendToUser, "forfeit");
    await flushPvpPersists(1_000);
    await settle(250);   // let the pump drain the |win| chunk

    // The room is what the tournament bracket reads for the five seconds
    // before deletion. It must agree with the row and with the ratings.
    expect(room.status).toBe("completed");
    expect(room.winnerId).toBe("uB");
    expect(room.loserId).toBe("uA");
    expect(room.endReason).toBe("forfeit");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].winnerId).toBe("uB");
    expect(rows()[0].endReason).toBe("forfeit");
    expect(eloWinnerId()).toBe("uB");
    expect(forfeitedUserId()).toBe("uA");
    // Exactly one battle:complete per participant, all naming the same winner.
    const done = h.of("battle:complete");
    expect(done).toHaveLength(2);
    expect(done.every((e) => e.payload.winnerId === "uB")).toBe(true);
  }, 20_000);

  it("CONTROL: a normal KO still ends the battle and still logs the win line", async () => {
    // The guard must not be so eager that it drops the win that ENDS a battle:
    // the |win| line is pushed to room.log and read on the same pass, and the
    // persisted battleLog is snapshotted inside endBattle.
    //
    // The turn script below is one turn because killerTeam is built to KO in
    // one turn AFTER level normalisation, not before it — see the note on the
    // fixture. If this ever fails with "expected 'active' to be 'completed'",
    // the matchup stopped reaching a KO at Lv 50; fix the matchup or add turns.
    // Do NOT reach for the production level rule: normalising in both
    // directions is the fix, and weakening it to a downward-only cap is the
    // regression this comment exists to prevent for the second time.
    const h = makeHarness(["uA", "uB"]);
    const room = makeRoom("random50", killerTeam, doomedTeam);
    await startBattle(io, room, h.deps.sendToUser!);
    await settle(150);
    applyChoice(room, "uB", "move 1");
    applyChoice(room, "uA", "move 1");
    await settle(300);
    await flushPvpPersists(1_000);

    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("ko");
    expect(room.winnerId).toBe("uA");
    expect(room.loserId).toBe("uB");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].winnerId).toBe("uA");
    expect(rows()[0].battleLog).toContain("|win|Alice");
    expect(eloWinnerId()).toBe("uA");
  }, 20_000);
});

// ══ 2 · the turn clock may not be pushed into the future ══════════════════

describe("reconnect credit never pushes the turn clock past now", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-29T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  function stubRoom(): BattleRoom {
    const room = makeRoom("random50", killerTeam, doomedTeam);
    room.status = "active";
    room.stream = { write: () => undefined, destroy: () => undefined };
    return room;
  }

  it("clamps the credit when the opponent moved during the away window", async () => {
    const room = stubRoom();
    const h = makeHarness(["uB"]);

    beginReconnectGrace(room, "a", h.deps);          // A drops at t0
    await vi.advanceTimersByTimeAsync(10_000);
    applyChoice(room, "uB", "move 1");               // opponent moves: clock = now
    await vi.advanceTimersByTimeAsync(30_000);
    h.present.add("uA");
    cancelReconnectGrace(room, "a", h.deps);         // A returns 40 s in

    // Before the fix this was Date.now() + 10_000, so turnDeadlineAt shipped to
    // both clients was 10 s later than anything the server intended to enforce.
    expect(room.lastChoiceAt).toBe(Date.now());
    expect(room.lastChoiceAt - Date.now()).toBe(0);
    // The absence meter still charges the FULL absence. That is what
    // graceSuppressesWatchdog spends, so clamping the clock must not clamp this
    // or a flapping client buys unlimited watchdog silence again.
    expect(room.a.graceCreditedMs).toBe(40_000);
  });

  it("still hands back the whole away window when nothing else moved", async () => {
    const room = stubRoom();
    const h = makeHarness(["uB"]);
    const before = room.lastChoiceAt;

    beginReconnectGrace(room, "a", h.deps);
    await vi.advanceTimersByTimeAsync(20_000);
    h.present.add("uA");
    cancelReconnectGrace(room, "a", h.deps);

    expect(room.lastChoiceAt).toBe(before + 20_000);
    expect(room.a.graceCreditedMs).toBe(20_000);
  });

  it("never overshoots across a whole battle of episodes, whatever the opponent does", async () => {
    const room = stubRoom();
    const h = makeHarness(["uB"]);
    for (let i = 0; i < 6; i++) {
      h.present.delete("uA");
      beginReconnectGrace(room, "a", h.deps);
      await vi.advanceTimersByTimeAsync(20_000);
      applyChoice(room, "uB", "move 1");             // opponent plays mid-window
      await vi.advanceTimersByTimeAsync(20_000);
      h.present.add("uA");
      cancelReconnectGrace(room, "a", h.deps);
      expect(room.lastChoiceAt).toBeLessThanOrEqual(Date.now());
      await vi.advanceTimersByTimeAsync(1_000);
    }
    // Meter charged the real absence and stopped at the documented ceiling.
    expect(room.a.graceCreditedMs).toBe(MAX_TURN_CREDIT_MS);
  });
});

// ══ 2b · the clamp must not reopen the flap deadlock ══════════════════════

describe("the clamp did not reopen the watchdog deadlock", () => {
  it("a flapper whose opponent keeps re-stamping the clock still gets forfeited", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["uA", "uB"]);
    // Real battle, because the watchdog interval installed by startBattle is
    // half of what's under test here.
    const room = makeRoom("random50", [
      { speciesKey: "pikachu", name: "A1", level: 50, moves: [{ id: "thunderShock" }] },
      { speciesKey: "bulbasaur", name: "A2", level: 50, moves: [{ id: "tackle" }] },
    ], [
      { speciesKey: "pikachu", name: "B1", level: 50, moves: [{ id: "thunderShock" }] },
      { speciesKey: "bulbasaur", name: "B2", level: 50, moves: [{ id: "tackle" }] },
    ]);
    await startBattle(io, room, h.deps.sendToUser!);
    await vi.advanceTimersByTimeAsync(0);

    // Phase 1: A flaps to dodge every watchdog poll, and B submits a choice at
    // the very END of each away window — so every millisecond of credit is
    // clamped away and NOTHING lands on the turn clock. If the absence meter
    // were charged with the clamped amount instead of the real absence, A's
    // budget would stay empty and the stand-down would be unbounded again.
    let elapsed = 0;
    for (let i = 0; i < 3 && room.status === "active"; i++) {
      h.present.delete("uA");
      beginDisconnectGrace("uA", h.deps);
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 300);
      applyChoice(room, "uB", "move 1");
      await vi.advanceTimersByTimeAsync(200);
      h.present.add("uA");
      endDisconnectGrace("uA", h.deps);
      await vi.advanceTimersByTimeAsync(5);
      elapsed += RECONNECT_GRACE_MS - 95;
    }
    expect(room.a.graceCreditedMs).toBe(MAX_TURN_CREDIT_MS);

    // Phase 2: A keeps flapping, B waits like a real opponent would. This must
    // terminate; before the bound existed it ran for four simulated hours.
    while (elapsed < 60 * 60_000 && room.status === "active") {
      h.present.delete("uA");
      beginDisconnectGrace("uA", h.deps);
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS - 200);
      h.present.add("uA");
      endDisconnectGrace("uA", h.deps);
      await vi.advanceTimersByTimeAsync(5);
      elapsed += RECONNECT_GRACE_MS - 195;
    }
    vi.useRealTimers();
    await settle(10);

    expect(room.status).toBe("completed");
    expect(elapsed).toBeLessThan(TURN_TIMEOUT_MS + MAX_TURN_CREDIT_MS + WATCHDOG_POLL_MS * 6);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].winnerId).toBe("uB");
    expect(rows()[0].loserId).toBe("uA");
    expect(forfeitedUserId()).toBe("uA");
    tearDown(room);
  }, 30_000);
});

// ══ 3 · a voided battle publishes no teams ════════════════════════════════

describe("a voided battle's row publishes nothing the battle did not reveal", () => {
  const bTeamWithCanary = [
    { speciesKey: "magikarp", nickname: "DOOMED", level: 5, moves: [{ id: "splash" }] },
    {
      speciesKey: "skarmory", nickname: "BCANARY", level: 50, ability: "keenEye",
      heldItem: "shedShell", moves: [{ id: "braveBird" }, { id: "whirlwind" }],
      ivs: { hp: 3, attack: 2, defense: 1, spAttack: 30, spDefense: 29, speed: 28 },
      evs: { hp: 252, attack: 0, defense: 232, spAttack: 0, spDefense: 24, speed: 0 },
    },
  ];

  it("writes the row, keeps the log, and blanks both teams on a drain-style void", async () => {
    const h = makeHarness(["uA", "uB"]);
    const room = makeRoom("random50", killerTeam, bTeamWithCanary);
    await startBattle(io, room, h.deps.sendToUser!);
    await settle(150);

    // Exactly what the shutdown drain does to every live room.
    await endBattle(room, h.deps.sendToUser, "cancelled");
    await flushPvpPersists(1_000);

    expect(rows()).toHaveLength(1);
    const row = rows()[0];
    // Still a real record: the bracket needs to read this row as dead, and
    // both players need their battle:complete.
    expect(row.status).toBe("cancelled");
    expect(row.endReason).toBe("cancelled");
    expect(row.winnerId).toBeNull();
    expect(h.of("battle:complete")).toHaveLength(2);
    // Unrated.
    expect(eloUpdates()).toHaveLength(0);
    // The teams are gone. The canary never took the field — proved against the
    // log — so the row was publishing strictly more than the battle revealed,
    // to a pairing that gets RE-RUN.
    expect(row.battleLog).not.toContain("Skarmory");
    expect(row.userATeam).toBe("[]");
    expect(row.userBTeam).toBe("[]");
    for (const token of ["BCANARY", "skarmory", "shedShell", "keenEye", "whirlwind", "SLUGGER", "machamp"]) {
      expect(JSON.stringify({ a: row.userATeam, b: row.userBTeam })).not.toContain(token);
    }
    // The log is deliberately kept: every line in it was already delivered to
    // both players live, and it is the only diagnostic a void leaves behind.
    expect(String(row.battleLog).length).toBeGreaterThan(0);
  }, 20_000);

  it("CONTROL: a battle that was actually PLAYED still persists both teams", async () => {
    const h = makeHarness(["uA", "uB"]);
    const room = makeRoom("random50", killerTeam, bTeamWithCanary);
    await startBattle(io, room, h.deps.sendToUser!);
    await settle(150);
    room.winnerId = "uA";
    room.loserId = "uB";
    await endBattle(room, h.deps.sendToUser, "forfeit");
    await flushPvpPersists(1_000);

    const row = rows()[0];
    expect(row.status).toBe("completed");
    expect(row.userATeam).toContain("machamp");
    expect(row.userBTeam).toContain("BCANARY");
  }, 20_000);
});

// ══ 4 · the drain refuses new battles at the source ══════════════════════

describe("startBattle refuses while the process is draining", () => {
  it("throws before creating a simulator, so the caller's catch can clean up", async () => {
    const h = makeHarness(["uA", "uB"]);
    // drainForShutdown() latches exactly this, before its sweep — it cannot be
    // called from a test because it ends in process.exit(0).
    beginDrain();
    expect(isDraining()).toBe(true);

    const room = makeRoom("tournament", killerTeam, doomedTeam);
    let announced = 0;
    await expect(
      startBattle(io, room, h.deps.sendToUser!, () => { announced++; }),
    ).rejects.toThrow(/restarting/);

    // Nothing was started: no onReady (so no battle:start reached a client), no
    // simulator, no watchdog interval, and the room is still "invited" so the
    // caller's catch deletes it. This is the state tournamentRunner and
    // routes/admin.ts both expect on a refusal.
    expect(announced).toBe(0);
    expect(room.status).toBe("invited");
    expect(room.stream).toBeNull();
    expect(room.expiryTimer).toBeNull();
    expect(h.events).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });

  it("still starts battles normally once the latch is clear", async () => {
    const h = makeHarness(["uA", "uB"]);
    beginDrain();
    resetDrainForTests();
    const room = makeRoom("tournament", killerTeam, doomedTeam);
    let announced = 0;
    await startBattle(io, room, h.deps.sendToUser!, () => { announced++; });
    await settle(100);
    expect(announced).toBe(1);
    expect(room.status).toBe("active");
    expect(room.stream).not.toBeNull();
    tearDown(room);
  }, 20_000);
});
