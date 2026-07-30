// applyChoice and the PHASE a battle is actually in.
//
// ─── The two defects this file pins ───────────────────────────────────────
//
// Both were confirmed by execution against the shipped Team Preview code, and
// both are properties of applyChoice's fire-and-forget write rather than of
// Team Preview itself — the phase is simply the first time the simulator has
// had two mutually-exclusive request kinds to be wrong about.
//
//  1. THE OPTIMISTIC ACK. `applyChoice(room, "uA", "move 1")` during Team
//     Preview wrote the choice, returned `{ok: true}`, and the simulator's
//     refusal arrived ~300 ms later on the player's own stream as
//
//         |error|[Invalid choice] Can't move: You need a teampreview response
//
//     so the caller — the socket ack, i.e. the client — was told a discarded
//     choice had landed. Not a stall (the 20-second auto-lock rescues the
//     battle) but a lie, and the client has no way to correlate a late |error|
//     with the choice that caused it. The mirror case is a `team` choice sent
//     after the phase closed, which came back as
//
//         |error|[Invalid choice] Can't choose for Team Preview: Not a Team
//         Preview request
//
//     — same shape, same optimistic ack. The fix makes the whole check
//     synchronous: the request the server ALREADY holds says which kind of
//     answer it wants, so applyChoice can refuse before touching the stream.
//
//  2. THE PREVIEW ANSWER COUNTED AS A MOVE. creditChoice ran on every
//     whitelisted choice, `team N` included, so answering Team Preview stamped
//     `side.movedAt`. runTurnWatchdog's last-resort tiebreak is "the side that
//     moved most recently wins", with "never moved" (undefined → 0) losing to
//     anyone who moved at all — and its own comment says a genuine double
//     no-show must resolve with NO winner so the tournament runner decides it
//     by seed. A player who picked a lead and then walked away was therefore
//     handed a turn-1 timeout win over a player who did exactly the same thing
//     one second earlier. Picking a lead is not moving.
//
// Neither fix may cost the phase its own liveness, so this file also re-proves
// the things that made Team Preview shippable: `team`/`default` still land,
// the auto-lock still starts an unanswered battle, and a real battle still
// reaches turn 1 and completes.
//
// DB stubbing follows tests/pvpTeamPreview.test.ts — nothing here may construct
// a PrismaClient, and nothing imports ../src/socket.js.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: {
    pvpMatch: { create: vi.fn(async () => ({})) },
    playerRating: {
      upsert: vi.fn(async () => ({ rating: 1000, peakRating: 1000 })),
      update: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async () => ({ aDelta: 0, bDelta: 0, aRating: 0, bRating: 0 })),
    $executeRaw: vi.fn(async () => 1),
  },
}));

import {
  TURN_TIMEOUT_MS,
  WATCHDOG_POLL_MS,
  applyChoice,
  battleRooms,
  isAwaitingTeamPreview,
  startBattle,
  type BattleRoom,
} from "../src/pvp.js";
import { passTeamPreview, passTeamPreviewFake } from "./support/teamPreview.js";

const io = { to: () => ({ emit: () => {} }) } as never;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mon = (nickname: string, speciesKey: string) => ({
  speciesKey, nickname, level: 50, moves: [{ id: "tackle" }, { id: "growl" }],
});
const TEAM_A = [mon("A1", "pikachu"), mon("A2", "snorlax"), mon("A3", "gengar")];
const TEAM_B = [mon("B1", "charizard"), mon("B2", "blastoise"), mon("B3", "venusaur")];

let seq = 0;
const live: BattleRoom[] = [];

function makeRoom(): BattleRoom {
  const room: BattleRoom = {
    id: `b_cp${++seq}`,
    status: "invited",
    format: "random50",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: TEAM_A as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: TEAM_B as never, stream: null, request: null, connected: true },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  };
  battleRooms.set(room.id, room);
  live.push(room);
  return room;
}

function tearDown(room: BattleRoom): void {
  if (room.expiryTimer) clearInterval(room.expiryTimer);
  if (room.previewTimer) clearTimeout(room.previewTimer);
  if (room.a.graceTimer) clearTimeout(room.a.graceTimer);
  if (room.b.graceTimer) clearTimeout(room.b.graceTimer);
  try { room.stream?.destroy(); } catch { /* already gone */ }
  battleRooms.delete(room.id);
}

afterEach(() => {
  for (const room of live.splice(0)) tearDown(room);
  vi.useRealTimers();
});

/** Every `|error|` line the simulator has sent to this side. The defect's own
 *  signature: with the optimistic ack the refusal shows up HERE, hundreds of
 *  milliseconds after applyChoice already said ok. */
const errorsFor = (room: BattleRoom, side: "a" | "b") =>
  (room[side].log ?? []).filter((l) => l.startsWith("|error|"));

// ══ 1 · a choice for the wrong phase is refused synchronously ═════════════

describe("applyChoice refuses a choice the current request cannot take", () => {
  it("REPRODUCTION: a move choice during Team Preview is rejected, not written", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    expect(isAwaitingTeamPreview(room, "uA")).toBe(true);

    const res = applyChoice(room, "uA", "move 1");

    // THE DEFECT: this used to be `{ok: true}`.
    expect(res.ok).toBe(false);
    expect(res.error).toBe("team preview: pick a lead first");

    // And the write never happened, so the simulator never had to refuse it.
    // Before the fix an |error| landed here ~300 ms later; the wait is
    // deliberately longer than that so its absence is measured, not assumed.
    await settle(400);
    expect(errorsFor(room, "a")).toEqual([]);
    expect(isAwaitingTeamPreview(room, "uA")).toBe(true);
  }, 20_000);

  it("refuses switch and pass in the phase too, for the same reason", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    for (const choice of ["switch 2", "pass"]) {
      const res = applyChoice(room, "uB", choice);
      expect(res.ok, `"${choice}" was accepted during Team Preview`).toBe(false);
      expect(res.error).toBe("team preview: pick a lead first");
    }
    await settle(400);
    expect(errorsFor(room, "b")).toEqual([]);
  }, 20_000);

  it("still accepts every choice the phase DOES take, and the battle starts", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);

    // `team N`, `default` and `undo` are all live during the phase — the first
    // two are what the client sends (state/pvp.ts lockTeamPreview), and `undo`
    // must keep working or a player could not change their mind.
    expect(applyChoice(room, "uA", "undo").ok).toBe(true);
    expect(applyChoice(room, "uA", "team 3").ok).toBe(true);
    expect(applyChoice(room, "uB", "default").ok).toBe(true);
    await settle(300);

    expect(isAwaitingTeamPreview(room, "uA")).toBe(false);
    expect(isAwaitingTeamPreview(room, "uB")).toBe(false);
    expect(errorsFor(room, "a")).toEqual([]);
    expect(errorsFor(room, "b")).toEqual([]);
    // The lead really is the one that was asked for — the guard did not quietly
    // swallow the choice it claimed to accept.
    expect(room.log.some((l) => l.startsWith("|switch|p1a:") && l.includes("Gengar"))).toBe(true);
  }, 20_000);

  it("REPRODUCTION: a team choice AFTER the phase is rejected, not written", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await passTeamPreview(room);
    await settle(150);
    expect(isAwaitingTeamPreview(room, "uA")).toBe(false);

    const res = applyChoice(room, "uA", "team 2");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("team preview is over");

    await settle(400);
    expect(errorsFor(room, "a")).toEqual([]);
  }, 20_000);

  it("leaves ordinary turn choices completely alone", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await passTeamPreview(room);
    await settle(150);

    expect(applyChoice(room, "uA", "move 1").ok).toBe(true);
    expect(applyChoice(room, "uB", "move 1").ok).toBe(true);
    await settle(300);
    expect(errorsFor(room, "a")).toEqual([]);
    expect(errorsFor(room, "b")).toEqual([]);
    expect(room.log.some((l) => l === "|turn|2")).toBe(true);
  }, 20_000);

  it("the format guard is still the outer one: junk never reaches the phase test", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    // A non-whitelisted string is refused for being junk, NOT for being
    // off-phase — the injection guard has to stay the first thing that runs.
    expect(applyChoice(room, "uA", ">start {}")).toEqual({
      ok: false, error: "invalid choice format",
    });
    expect(applyChoice(room, "uNobody", "team 1")).toEqual({
      ok: false, error: "not in battle",
    });
  }, 20_000);
});

// ══ 2 · answering Team Preview is not moving ══════════════════════════════

describe("a Team Preview answer does not count as a move", () => {
  it("REPRODUCTION: `team N` does not stamp movedAt", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);

    expect(room.a.movedAt).toBeUndefined();
    expect(applyChoice(room, "uA", "team 2").ok).toBe(true);
    // THE DEFECT: this used to be a timestamp.
    expect(room.a.movedAt).toBeUndefined();
    expect(applyChoice(room, "uB", "default").ok).toBe(true);
    expect(room.b.movedAt).toBeUndefined();

    await settle(300);
    // Turn 1 has arrived and NEITHER side has moved — which is the truth.
    expect(room.a.movedAt).toBeUndefined();
    expect(room.b.movedAt).toBeUndefined();

    // A real move still stamps, or the tiebreak would have no input at all.
    expect(applyChoice(room, "uA", "move 1").ok).toBe(true);
    expect(typeof room.a.movedAt).toBe("number");
    expect(room.b.movedAt).toBeUndefined();
  }, 20_000);

  it("still re-anchors the AFK clock, so answering is not punished", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    room.lastChoiceAt = Date.now() - 60_000;
    expect(applyChoice(room, "uA", "team 1").ok).toBe(true);
    // The five-minute clock restarts: a player who interacted is not closer to
    // being forfeited than one who did not.
    expect(Date.now() - room.lastChoiceAt).toBeLessThan(1_000);
  }, 20_000);

  it("REPRODUCTION: a turn-1 double no-show has NO winner, even if one side picked a lead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    const room = makeRoom();
    await startBattle(io, room, () => {});

    // uA answers the preview. uB never does — the auto-lock covers them.
    await passTeamPreviewFake(room, (ms) => vi.advanceTimersByTimeAsync(ms), { a: "uA", b: "uNobody" });
    await vi.advanceTimersByTimeAsync(0);
    expect(room.a.movedAt).toBeUndefined();

    // Now BOTH sides walk away on turn 1. Run out the whole turn clock.
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2 + 1_000);
    vi.useRealTimers();
    await settle(20);

    expect(room.status).toBe("completed");
    // THE DEFECT: uA used to win here, purely for having answered the picker.
    expect(room.winnerId).toBeUndefined();
    expect(room.loserId).toBeUndefined();
  }, 30_000);

  it("a side that actually MOVED still wins the turn-1 timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T12:00:00Z"));
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await passTeamPreviewFake(room, (ms) => vi.advanceTimersByTimeAsync(ms));
    await vi.advanceTimersByTimeAsync(0);

    // uB submits a real move; uA never does. The tiebreak still has an answer,
    // so the fix did not disarm the mechanism — it only stopped feeding it
    // preview answers.
    expect(applyChoice(room, "uB", "move 1").ok).toBe(true);
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2 + 1_000);
    vi.useRealTimers();
    await settle(20);

    expect(room.status).toBe("completed");
    expect(room.winnerId).toBe("uB");
    expect(room.loserId).toBe("uA");
  }, 30_000);
});
