// The missing half of "a buffered |win| cannot rename the winner".
//
// ─── Why this file exists ─────────────────────────────────────────────────
//
// tests/pvpOutcomeIntegrity.test.ts section 1 reproduces the corruption: a
// simulator |win| that is still sitting in the stream when some OTHER end path
// finishes the battle used to be drained afterwards and rewrite winnerId on a
// completed room, after the PvpMatch row and the ELO had already gone out naming
// the other player.
//
// It asserts, correctly, that the |win| has NOT yet reached room.log before
// endBattle lands (that is what makes the line "buffered"), and then asserts the
// outcome is unchanged afterwards. What it never asserts is that the |win| ever
// ARRIVED. So if the fixture stopped producing a turn-1 KO — which it did once
// already, when level normalisation started raising as well as lowering and a
// 60-BP Aerial Ace no longer one-shot a Lv 50 Magikarp — section 1 would keep
// passing while testing nothing at all: no win line to buffer, no drain, no
// rename to prevent.
//
// The CONTROL immediately below it does catch that, which is why this is a
// robustness hole rather than a live defect; but the pair is only self-defending
// as long as both halves stay in the same file, and that file is one of the six
// spec files this work is not allowed to edit. So the missing assertion lives
// here instead, along with an explicit check of the precondition section 1
// silently depends on.
//
// This file deliberately does NOT re-test the guard itself. It tests that the
// reproduction is REAL: the win line arrives, it names the other player, and the
// room still refuses to change its mind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const ratingUpsert = vi.fn(async ({ where }: { where: { userId: string } }) => ({
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
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      $executeRaw: vi.fn(async () => 1),
    },
  };
});
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));

import {
  applyChoice,
  battleRooms,
  endBattle,
  flushPvpPersists,
  startBattle,
  type BattleRoom,
} from "../src/pvp.js";

const io = { to: () => ({ emit: () => {} }) } as never;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rows = () => db.matchCreate.mock.calls.map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data);

// The same fixture shape section 1 depends on, restated here so this file's
// precondition test is meaningful on its own: Close Combat off Machamp's base
// 130 Attack is a guaranteed turn-1 KO on a Magikarp at parity, at Lv 50 (after
// random50 normalisation) as well as at Lv 100.
const killerTeam = [{
  speciesKey: "machamp", nickname: "SLUGGER", level: 100,
  ability: "guts", moves: [{ id: "closeCombat" }],
}];
const doomedTeam = [{
  speciesKey: "magikarp", nickname: "DOOMED", level: 5,
  ability: "swiftSwim", moves: [{ id: "splash" }],
}];

let seq = 0;
function makeRoom(format: string): BattleRoom {
  const id = `b_bw${++seq}`;
  const room: BattleRoom = {
    id, status: "invited", format,
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: killerTeam as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: doomedTeam as never, stream: null, request: null, connected: true },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  };
  battleRooms.set(id, room);
  return room;
}

const events: { userId: string; event: string; payload: unknown }[] = [];
const sendToUser = (userId: string, event: string, payload: unknown) => { events.push({ userId, event, payload }); };

beforeEach(() => {
  events.length = 0;
  db.matchCreate.mockClear();
  db.ratingUpdate.mockClear();
  db.ratingUpsert.mockClear();
});
afterEach(() => {
  for (const [id, room] of [...battleRooms]) {
    if (!id.startsWith("b_bw")) continue;
    if (room.expiryTimer) clearInterval(room.expiryTimer);
    if (room.a.graceTimer) clearTimeout(room.a.graceTimer);
    if (room.b.graceTimer) clearTimeout(room.b.graceTimer);
    battleRooms.delete(id);
  }
});

// ══ 1 · the precondition section 1 depends on and does not state ══════════

describe("the fixture really does produce a turn-1 win", () => {
  it("KOs in one turn AFTER level normalisation, in the rated format", async () => {
    const room = makeRoom("random50");
    await startBattle(io, room, sendToUser);
    await settle(200);
    // Both sides genuinely at Lv 50 — the raise as well as the lower. If a
    // future change makes normalisation lowering-only again, the Magikarp is
    // back at Lv 5 and this assertion is the one that says so.
    expect(room.log.some((l) => l.startsWith("|switch|p1a: SLUGGER|Machamp, L50"))).toBe(true);
    expect(room.log.some((l) => l.startsWith("|switch|p2a: DOOMED|Magikarp, L50"))).toBe(true);

    applyChoice(room, "uB", "move 1");
    applyChoice(room, "uA", "move 1");
    await settle(250);
    // ONE turn. This is the property "buffered |win|" is built on.
    expect(room.log.filter((l) => l.startsWith("|turn|"))).toHaveLength(1);
    expect(room.log.some((l) => l === "|win|Alice")).toBe(true);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("ko");
    expect(room.winnerId).toBe("uA");
    await flushPvpPersists(1_000);
  }, 20_000);
});

// ══ 2 · the buffered win ARRIVES, and is still refused ═══════════════════

describe("a |win| drained after the battle ended", () => {
  it("really does arrive, and really does name the other player", async () => {
    const room = makeRoom("random50");
    await startBattle(io, room, sendToUser);
    await settle(200);

    // The one condition the corruption needed: endBattle swallows a throw from
    // room.stream.destroy(), so a destroy that fails leaves the omni pump
    // running against a finished battle. `write` still forwards, so the
    // simulator is real.
    const real = room.stream!;
    room.stream = {
      write: (d: string) => real.write(d),
      destroy: () => { throw new Error("destroy failed"); },
    } as typeof room.stream;

    // Both choices in one synchronous block: the turn resolves and the |win| is
    // produced, but the pump only drains on a later microtask.
    applyChoice(room, "uB", "move 1");
    applyChoice(room, "uA", "move 1");
    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(false);

    // Another end path lands first. A is forfeited, so B is the winner of
    // record — the opposite of what the simulator is about to say.
    room.winnerId = "uB";
    room.loserId = "uA";
    await endBattle(room, sendToUser, "forfeit");
    await flushPvpPersists(1_000);
    await settle(300);

    // THE ASSERTION THAT WAS MISSING. Without it, a fixture that stopped
    // one-shotting turns the whole reproduction into a no-op that still passes.
    const win = room.log.filter((l) => l.startsWith("|win|"));
    expect(win, "the buffered |win| never arrived — this test proved nothing").toHaveLength(1);
    expect(win[0]).toBe("|win|Alice");
    // The line arrived AFTER the row was written, which is what made the
    // original defect possible: the persisted battleLog is snapshotted inside
    // endBattle, so it cannot contain it.
    expect(rows()).toHaveLength(1);
    expect(String(rows()[0].battleLog)).not.toContain("|win|");

    // …and the outcome did not move an inch.
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("forfeit");
    expect(room.winnerId).toBe("uB");
    expect(room.loserId).toBe("uA");
    expect(rows()[0].winnerId).toBe("uB");
    expect(rows()[0].endReason).toBe("forfeit");
    const done = events.filter((e) => e.event === "battle:complete");
    expect(done).toHaveLength(2);
    expect(done.every((e) => (e.payload as { winnerId: string }).winnerId === "uB")).toBe(true);
  }, 20_000);

  it("cannot rewrite the REASON of a timeout either", async () => {
    // The other field the drain writes is endReason ("ko"), and it writes it
    // before it looks at the name. A timeout that had already been recorded
    // would come back as a KO — the room and the row would disagree about how
    // the match ended even when they agree about who won.
    const room = makeRoom("random50");
    await startBattle(io, room, sendToUser);
    await settle(200);
    const real = room.stream!;
    room.stream = {
      write: (d: string) => real.write(d),
      destroy: () => { throw new Error("destroy failed"); },
    } as typeof room.stream;

    applyChoice(room, "uB", "move 1");
    applyChoice(room, "uA", "move 1");
    room.winnerId = "uB";
    room.loserId = "uA";
    await endBattle(room, sendToUser, "timeout");
    await flushPvpPersists(1_000);
    await settle(300);

    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(true);
    expect(room.endReason).toBe("timeout");
    expect(rows()[0].endReason).toBe("timeout");
    // One row, not two: the late drain must not have called endBattle again.
    expect(rows()).toHaveLength(1);
  }, 20_000);
});

// ══ 3 · the hole itself, demonstrated ════════════════════════════════════

describe("without the arrival assertion the reproduction is vacuous", () => {
  it("passes every assertion section 1 makes, with no |win| anywhere", async () => {
    // Identical sequence, one difference: neither side can KO the other (Splash
    // vs Splash), so no |win| is ever produced and there is nothing to buffer,
    // nothing to drain and nothing to rename. This is the state the file was in
    // when the fixture was Aerial Ace and level normalisation started raising as
    // well as lowering.
    const room = makeRoom("random50");
    room.a.team = [{
      speciesKey: "magikarp", nickname: "HARMLESS", level: 50,
      ability: "swiftSwim", moves: [{ id: "splash" }],
    }] as never;
    await startBattle(io, room, sendToUser);
    await settle(200);
    const real = room.stream!;
    room.stream = {
      write: (d: string) => real.write(d),
      destroy: () => { throw new Error("destroy failed"); },
    } as typeof room.stream;

    applyChoice(room, "uB", "move 1");
    applyChoice(room, "uA", "move 1");
    // Section 1's pre-end assertion. Passes for the WRONG reason.
    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(false);

    room.winnerId = "uB";
    room.loserId = "uA";
    await endBattle(room, sendToUser, "forfeit");
    await flushPvpPersists(1_000);
    await settle(300);

    // Every one of section 1's post-end assertions, verbatim in effect — all
    // still green against a battle that never produced a win line.
    expect(room.status).toBe("completed");
    expect(room.winnerId).toBe("uB");
    expect(room.loserId).toBe("uA");
    expect(room.endReason).toBe("forfeit");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].winnerId).toBe("uB");
    expect(rows()[0].endReason).toBe("forfeit");
    const done = events.filter((e) => e.event === "battle:complete");
    expect(done).toHaveLength(2);
    expect(done.every((e) => (e.payload as { winnerId: string }).winnerId === "uB")).toBe(true);

    // And the assertion added by section 2 above is the one that would have
    // caught it: no |win| ever arrived.
    expect(room.log.filter((l) => l.startsWith("|win|"))).toHaveLength(0);
    expect(room.log.filter((l) => l.startsWith("|turn|")).length).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
