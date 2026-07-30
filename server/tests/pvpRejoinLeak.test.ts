// Info-leak audit of the PvP reconnect path, at the ACK boundary.
//
// tests/pvpReconnect.test.ts already pins the core property against
// snapshotForSide(). This file audits the thing the client actually receives —
// the `battle:rejoin` ack produced by resolveRejoin() after a real
// disconnect/reconnect round trip through beginDisconnectGrace() /
// endDisconnectGrace() — and it widens the net from "the opponent's bench
// NICKNAME must not appear" to every field a cheater would want:
//
//   species · nickname · held item · ability · move names · derived stats
//   (which encode the opponent's IVs/EVs/nature) · their |request| payload
//
// Why this needs a real @pkmn/sim battle rather than a fixture: the leak this
// guards against is a property of which protocol lines @pkmn/sim routes to
// which channel, and that is exactly what a fixture would assume rather than
// test. getPlayerStreams() sends `sideupdate` (the |request| carrier) only to
// that side's own stream and splits every |split| block into a secret half for
// the owner and a shared half for the foe. The per-side BattleSide.log records
// what came off THAT boundary, so a replay re-sends only bytes the same client
// already had. This test is what makes that a fact instead of a comment.
//
// The battle is driven to real damage, real faints and a real forced-switch
// request before the disconnect, because "no leak" is trivially true on turn 1
// where nothing has been revealed and nothing is private yet.

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: {
    pvpMatch: { create: vi.fn(() => Promise.resolve({})) },
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    $transaction: vi.fn(() => Promise.resolve({ aDelta: 0, bDelta: 0, aRating: 0, bRating: 0 })),
  },
}));

import {
  startBattle,
  endBattle,
  applyChoice,
  battleRooms,
  beginDisconnectGrace,
  endDisconnectGrace,
  resolveRejoin,
  resolveSync,
  type BattleRoom,
  type GraceDeps,
} from "../src/pvp.js";
import { answerTeamPreview, passTeamPreview } from "./support/teamPreview.js";

// ── Teams with zero token overlap ────────────────────────────────────────
// Every species / nickname / item / ability / move on one side is absent from
// the other, so a single substring hit is unambiguous evidence of a crossing.
// The third Pokémon on each side is NEVER sent out: that one is the canary —
// nothing about it is ever public, so it may not appear in the opponent's
// payload under any circumstance.
const teamA = [
  {
    speciesKey: "gyarados", nickname: "ALICELEAD", level: 50,
    ability: "intimidate", heldItem: "leftovers", nature: "Adamant",
    moves: [{ id: "waterfall" }, { id: "dragonDance" }, { id: "earthquake" }, { id: "iceFang" }],
    ivs: { hp: 29, attack: 28, defense: 27, spAttack: 26, spDefense: 25, speed: 24 },
    evs: { hp: 4, attack: 252, defense: 0, spAttack: 0, spDefense: 0, speed: 252 },
  },
  {
    speciesKey: "alakazam", nickname: "ALICEBENCH", level: 50,
    ability: "magicGuard", heldItem: "lifeOrb", nature: "Timid",
    moves: [{ id: "psychic" }, { id: "focusBlast" }, { id: "shadowBall" }, { id: "recover" }],
    ivs: { hp: 23, attack: 22, defense: 21, spAttack: 31, spDefense: 20, speed: 31 },
    evs: { hp: 0, attack: 0, defense: 0, spAttack: 252, spDefense: 4, speed: 252 },
  },
  {
    speciesKey: "ferrothorn", nickname: "ALICECANARY", level: 50,
    ability: "ironBarbs", heldItem: "rockyHelmet", nature: "Relaxed",
    moves: [{ id: "gyroBall" }, { id: "spikes" }, { id: "leechSeed" }, { id: "powerWhip" }],
    ivs: { hp: 19, attack: 18, defense: 17, spAttack: 16, spDefense: 15, speed: 0 },
    evs: { hp: 252, attack: 48, defense: 208, spAttack: 0, spDefense: 0, speed: 0 },
  },
];

const teamB = [
  {
    speciesKey: "jolteon", nickname: "BOBLEAD", level: 50,
    ability: "voltAbsorb", heldItem: "choiceSpecs", nature: "Timid",
    moves: [{ id: "thunderbolt" }, { id: "shadowBall" }, { id: "hiddenPower" }, { id: "voltSwitch" }],
    ivs: { hp: 13, attack: 12, defense: 11, spAttack: 31, spDefense: 10, speed: 31 },
    evs: { hp: 0, attack: 0, defense: 4, spAttack: 252, spDefense: 0, speed: 252 },
  },
  {
    speciesKey: "snorlax", nickname: "BOBBENCH", level: 50,
    ability: "thickFat", heldItem: "chestoBerry", nature: "Careful",
    moves: [{ id: "bodySlam" }, { id: "rest" }, { id: "curse" }, { id: "crunch" }],
    ivs: { hp: 9, attack: 8, defense: 7, spAttack: 6, spDefense: 5, speed: 4 },
    evs: { hp: 252, attack: 24, defense: 0, spAttack: 0, spDefense: 232, speed: 0 },
  },
  {
    speciesKey: "skarmory", nickname: "BOBCANARY", level: 50,
    ability: "sturdy", heldItem: "shedShell", nature: "Impish",
    moves: [{ id: "braveBird" }, { id: "roost" }, { id: "whirlwind" }, { id: "stealthRock" }],
    ivs: { hp: 3, attack: 2, defense: 1, spAttack: 30, spDefense: 29, speed: 28 },
    evs: { hp: 252, attack: 0, defense: 232, spAttack: 0, spDefense: 24, speed: 0 },
  },
];

/** Tokens that exist ONLY on the canary — the Pokémon that never appears.
 *  Zero of these may show up in the opponent's payload, ever, with no
 *  "but it was revealed in play" exemption available. */
const A_CANARY_TOKENS = [
  "ALICECANARY", "Ferrothorn", "ferrothorn", "ironbarbs", "Iron Barbs",
  "rockyhelmet", "Rocky Helmet", "gyroball", "Gyro Ball", "leechseed",
  "Leech Seed", "powerwhip", "Power Whip",
];
const B_CANARY_TOKENS = [
  "BOBCANARY", "Skarmory", "skarmory", "sturdy", "Sturdy",
  "shedshell", "Shed Shell", "whirlwind", "Whirlwind", "bravebird",
  "Brave Bird", "stealthrock", "Stealth Rock",
];

function makeRoom(id: string): BattleRoom {
  const room: BattleRoom = {
    id,
    status: "invited",
    format: "random50",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: teamA as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: teamB as never, stream: null, request: null, connected: true },
    log: [],
    stream: null,
    expiryTimer: null,
    spectators: new Set(),
  };
  battleRooms.set(id, room);
  return room;
}

interface Sent { userId: string; event: string; payload: any }

function makeDeps(present: Set<string>) {
  const events: Sent[] = [];
  const deps: GraceDeps = {
    sendToUser: (userId, event, payload) => void events.push({ userId, event, payload: payload as any }),
    isPresent: (id) => present.has(id),
    onQueueDropped: () => undefined,
  };
  return { events, deps };
}

/** Every protocol line the transport was asked to deliver to `userId`, in
 *  order — i.e. Showdown's own per-player privacy boundary, as actually
 *  observed by that client. */
function liveLines(events: Sent[], userId: string): string[] {
  return events
    .filter((e) => e.userId === userId && e.event === "battle:state")
    .flatMap((e) => String(e.payload.chunk).split("\n"))
    .filter(Boolean);
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answer whatever request each side is holding until both sides have lost a
 *  Pokémon (so |-damage|, |faint| and a forceSwitch request all really
 *  happened) or the deadline passes. The player-stream |request| payload has
 *  no `rqid`, so "already answered" is tracked by counting that side's own
 *  |request| lines. */
async function playUntilRich(room: BattleRoom, budgetMs: number): Promise<void> {
  const answered: Record<string, number> = { uA: 0, uB: 0 };
  const switched: Record<string, boolean> = { uA: false, uB: false };
  const drive = (userId: "uA" | "uB", side: typeof room.a) => {
    const rq = side.request as any;
    if (!rq || rq.wait) return;
    const seen = (side.log ?? []).filter((l) => l.startsWith("|request|")).length;
    if (seen <= answered[userId]) return;
    answered[userId] = seen;
    const bench = (rq.side?.pokemon ?? [])
      .map((p: any, k: number) => ({ p, k }))
      .filter(({ p }: any) => !p.active && p.condition !== "0 fnt");
    if (rq.forceSwitch) {
      applyChoice(room, userId, bench.length > 0 ? `switch ${bench[0].k + 1}` : "default");
      return;
    }
    // One voluntary switch each: reveals the SECOND mon on both sides and
    // leaves the third as a clean canary.
    if (!switched[userId] && bench.length > 0) {
      switched[userId] = true;
      applyChoice(room, userId, `switch ${bench[0].k + 1}`);
      return;
    }
    applyChoice(room, userId, "move 1");
  };
  const faints = () => room.log.filter((l) => l.startsWith("|faint|")).length;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && room.status === "active" && faints() < 2) {
    drive("uA", room.a);
    drive("uB", room.b);
    await settle(25);
  }
  await settle(250);
}

describe("battle:rejoin ack — the opponent's private state must not cross", () => {
  it("hands each side back exactly its own delivered byte stream, and nothing else", async () => {
    const room = makeRoom("b_leakack1");
    const present = new Set(["uA", "uB"]);
    const { events, deps } = makeDeps(present);

    await startBattle(null as never, room, deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(300);
    await playUntilRich(room, 8_000);

    // The battle has to have produced something worth hiding, or the rest of
    // this test proves nothing.
    expect(room.log.some((l) => l.startsWith("|-damage|"))).toBe(true);
    expect(room.log.some((l) => l.startsWith("|faint|"))).toBe(true);
    expect(room.status).toBe("active");

    const aLive = liveLines(events, "uA");
    const bLive = liveLines(events, "uB");
    const aSeen = new Set(aLive);
    const bSeen = new Set(bLive);

    // Each side genuinely has private lines the other never received —
    // otherwise "nothing crossed" would be vacuous.
    const onlyB = bLive.filter((l) => !aSeen.has(l));
    const onlyA = aLive.filter((l) => !bSeen.has(l));
    expect(onlyB.length).toBeGreaterThan(0);
    expect(onlyA.length).toBeGreaterThan(0);
    // ...and every one of them is a |request| — the only side-private carrier
    // in the protocol. If @pkmn/sim ever starts splitting something else
    // per-side, this is where we find out.
    expect(onlyB.every((l) => l.startsWith("|request|"))).toBe(true);
    expect(onlyA.every((l) => l.startsWith("|request|"))).toBe(true);

    // Full round trip: last socket drops, socket comes back, client rejoins.
    for (const [userId, side, other] of [["uA", "a", "uB"], ["uB", "b", "uA"]] as const) {
      present.delete(userId);
      beginDisconnectGrace(userId, deps);
      present.add(userId);
      endDisconnectGrace(userId, deps);

      const ack = resolveRejoin(userId, room.id, deps);
      expect(ack.ok).toBe(true);
      if (!ack.ok) return;
      const snap = ack.snapshot;

      // THE security argument, stated as an equality: the replay is byte-for-
      // byte the stream this client already received. A replay equal to what
      // you already had cannot leak anything, whatever the simulator decides
      // to put in it — no allowlist to keep in sync, no format flag to trust.
      expect(snap.log).toEqual(liveLines(events, userId));
      expect(snap.side).toBe(side);
      // Nothing that only the opponent ever saw.
      const otherOnly = liveLines(events, other).filter(
        (l) => !new Set(liveLines(events, userId)).has(l),
      );
      for (const line of otherOnly) expect(snap.log).not.toContain(line);
    }

    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });

  it("leaks no species, nickname, item, ability, move or stat of the opponent's unrevealed Pokémon", async () => {
    const room = makeRoom("b_leakack2");
    const present = new Set(["uA", "uB"]);
    const { events, deps } = makeDeps(present);

    await startBattle(null as never, room, deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(300);
    await playUntilRich(room, 8_000);

    present.delete("uA");
    beginDisconnectGrace("uA", deps);
    present.add("uA");
    endDisconnectGrace("uA", deps);

    const aAck = resolveRejoin("uA", room.id, deps);
    const bAck = resolveRejoin("uB", room.id, deps);
    expect(aAck.ok && bAck.ok).toBe(true);
    if (!aAck.ok || !bAck.ok) return;
    const aJson = JSON.stringify(aAck.snapshot);
    const bJson = JSON.stringify(bAck.snapshot);

    // ─── The boundary Team Preview moved, and the one it did not ────────
    //
    // Before Team Preview this loop ran over every canary token including the
    // species, on the reasoning that a Pokémon which never took the field is
    // wholly private. Team Preview publishes the SPECIES of all six on both
    // sides before turn 1 — `|poke|p2|Skarmory, L50, M|`, on the shared channel,
    // to both players — so the species half of that claim is now false by
    // design, and asserting it would only mean the phase had failed to happen.
    //
    // Nothing else moved. A nickname, a held item, an ability, a move and a
    // stat spread are all still invisible to the opponent, before the phase and
    // after it, and the |request| payload that carries them is still entirely
    // one-sided. So the loop runs over the tokens MINUS the species, and the
    // species is asserted PRESENT immediately below — which is a stronger test
    // than the original, because a regression that reverted the redaction (or
    // widened the request) now has to get past a positive and a negative
    // assertion rather than one blanket negative that a disabled phase would
    // satisfy for free.
    const speciesTokens = new Set(["Ferrothorn", "ferrothorn", "Skarmory", "skarmory"]);
    const privateOf = (all: string[]) => all.filter((tk) => !speciesTokens.has(tk));
    for (const token of privateOf(B_CANARY_TOKENS)) {
      expect(aJson, `A's snapshot leaked B's private token "${token}"`).not.toContain(token);
    }
    for (const token of privateOf(A_CANARY_TOKENS)) {
      expect(bJson, `B's snapshot leaked A's private token "${token}"`).not.toContain(token);
    }
    // The phase really did happen, and it really did reveal exactly the species.
    expect(aJson).toContain("|teampreview");
    expect(aJson).toContain("Skarmory");
    expect(bJson).toContain("Ferrothorn");
    // …and NOT the held-item marker the simulator's own `|poke|` line carries.
    // Both canaries hold an item (Rocky Helmet / Shed Shell), so an unstripped
    // `|poke|…|item` would be here. This is the assertion that fails if
    // redactPreviewItems is ever removed from the player pump.
    expect(aJson).not.toContain("|item");
    expect(bJson).not.toContain("|item");
    // Each side does see its own canary — proof the tokens are reachable at
    // all, so the assertions above are not passing by typo.
    expect(aJson).toContain("ALICECANARY");
    expect(bJson).toContain("BOBCANARY");

    // Derived stats encode IVs + EVs + nature. Showdown puts them in the
    // |request| payload, so leaking the opponent's request leaks their spread.
    // Both sides' spreads are deliberately unique, so compare the numbers.
    const statsOf = (snapJson: string, ident: string): string | null => {
      const i = snapJson.indexOf(ident);
      if (i < 0) return null;
      const j = snapJson.indexOf('"stats"', i);
      return j < 0 ? null : snapJson.slice(j, j + 90);
    };
    const bOwnStats = statsOf(bJson, "p2: BOBLEAD");
    expect(bOwnStats).not.toBeNull();
    expect(aJson).not.toContain(bOwnStats!);      // A must not hold B's spread
    const aOwnStats = statsOf(aJson, "p1: ALICELEAD");
    expect(aOwnStats).not.toBeNull();
    expect(bJson).not.toContain(aOwnStats!);

    // No |request| in my replay belongs to the other side, and my own
    // `request` is mine by identity.
    const requestSides = (log: string[]) => [...new Set(log
      .filter((l) => l.startsWith("|request|"))
      .map((l) => {
        try { return (JSON.parse(l.slice("|request|".length)) as any)?.side?.id ?? "-"; }
        catch { return "?"; }
      }))];
    expect(requestSides(aAck.snapshot.log)).toEqual(["p1"]);
    expect(requestSides(bAck.snapshot.log)).toEqual(["p2"]);
    expect(aAck.snapshot.request).toBe(room.a.request);
    expect(bAck.snapshot.request).toBe(room.b.request);
    expect((aAck.snapshot.request as any)?.side?.id).toBe("p1");
    expect((bAck.snapshot.request as any)?.side?.id).toBe("p2");

    // And no route into either raw team: `team` is the un-adapted game object,
    // carrying IVs/EVs/nature for all six.
    expect(aJson).not.toContain('"speciesKey"');
    expect(bJson).not.toContain('"speciesKey"');
    expect(Object.keys(aAck.snapshot).sort()).toEqual([
      "battleId", "format", "levelCap", "log", "opponent", "request", "side", "turnDeadlineAt",
    ]);

    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });

  it("gives a non-participant no battle content on either probe", async () => {
    const room = makeRoom("b_leakack3");
    const present = new Set(["uA", "uB", "uC"]);
    const { events, deps } = makeDeps(present);

    await startBattle(null as never, room, deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(300);
    await playUntilRich(room, 3_000);

    const before = events.length;
    // Naming a real, live battle id you are not in must not confirm content.
    expect(resolveRejoin("uC", room.id, deps)).toEqual({ ok: false, reason: "not_in_battle" });
    expect(resolveRejoin("uC", undefined, deps)).toEqual({ ok: false, reason: "not_in_battle" });
    expect(resolveSync("uC", room.id, deps)).toEqual({ ok: false, reason: "gone" });
    // Not even a pushed event — replayOutcome checks participation itself.
    expect(events.slice(before)).toEqual([]);

    // Same after the room is gone: a stranger gets "gone" and no replayed
    // outcome, while a participant gets their own result back.
    room.winnerId = "uB";
    room.loserId = "uA";
    await endBattle(room, deps.sendToUser, "forfeit");
    battleRooms.delete(room.id);

    const afterDelete = events.length;
    expect(resolveRejoin("uC", room.id, deps)).toEqual({ ok: false, reason: "gone" });
    expect(resolveSync("uC", room.id, deps)).toEqual({ ok: false, reason: "gone" });
    expect(events.slice(afterDelete)).toEqual([]);

    const participantMark = events.length;
    expect(resolveRejoin("uA", room.id, deps)).toEqual({ ok: false, reason: "gone" });
    const replayed = events.slice(participantMark);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ userId: "uA", event: "battle:complete" });
    // The remembered outcome is an outcome, not a battle: no log, no teams.
    expect(Object.keys(replayed[0].payload).sort()).toEqual([
      "battleId", "loserId", "ratingDelta", "reason", "winnerId",
    ]);
  });

  it("survives hostile battleId shapes without widening what it answers", async () => {
    // The ONLY client-supplied input either resolver takes is payload.battleId
    // (`side` is derived from the authenticated userId via sideOf). asBattleId
    // narrows anything that is not a non-empty string away, so an object with a
    // toString, an array or a number must fall through to the discovery branch
    // and still return only the caller's own battle.
    const room = makeRoom("b_leakack4");
    const present = new Set(["uA", "uB", "uC"]);
    const { deps } = makeDeps(present);
    await startBattle(null as never, room, deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(300);

    const hostile: unknown[] = [
      { toString: () => room.id },
      [room.id],
      42,
      "",
      null,
      undefined,
      { battleId: room.id },
    ];
    for (const shape of hostile) {
      // A stranger learns nothing from any of them.
      expect(resolveRejoin("uC", shape, deps)).toEqual({ ok: false, reason: "not_in_battle" });
      expect(resolveSync("uC", shape, deps)).toEqual({ ok: false, reason: "gone" });
      // A participant gets their OWN battle back, never somebody else's.
      const ack = resolveRejoin("uA", shape, deps);
      expect(ack.ok).toBe(true);
      if (ack.ok) expect(ack.snapshot.side).toBe("a");
      // sync refuses every non-string id rather than guessing.
      expect(resolveSync("uA", shape, deps)).toEqual({ ok: false, reason: "gone" });
    }

    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });
});

// ── The per-side log is safe BY CONSTRUCTION, not by format flag ──────────
// Two structural facts about @pkmn/sim's channels underpin every assertion
// above, and neither is pinned anywhere else:
//
//   * `sideupdate` (the only |request| carrier) is routed to that side's own
//     stream and NOT to the omniscient channel — so room.log is not just
//     structurally unsafe to replay, it is functionally insufficient: it cannot
//     rebuild a player's board at all.
//   * a player's own channel gets the `secret` half of its own |split| blocks
//     and the `shared` half of the foe's. In THIS format those halves are
//     identical for HP (Custom Game sets debug: true → reportExactHP), which is
//     why room.log currently looks interchangeable with a player's own stream.
//     That equality is a coincidence of one flag; the per-side log does not
//     depend on it.
describe("the channel boundary the per-side log sits on", () => {
  it("keeps every |request| out of the omniscient log and every foe request out of each side's", async () => {
    const room = makeRoom("b_leakchan");
    const present = new Set(["uA", "uB"]);
    const { events, deps } = makeDeps(present);
    await startBattle(null as never, room, deps.sendToUser!);
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(300);
    await playUntilRich(room, 6_000);

    // Both sides really did receive requests, so the assertion below is not
    // vacuous.
    const reqOf = (lines: string[]) => lines.filter((l) => l.startsWith("|request|"));
    expect(reqOf(room.a.log ?? []).length).toBeGreaterThan(1);
    expect(reqOf(room.b.log ?? []).length).toBeGreaterThan(1);

    // FACT 1: channel -1 carries none of them. A room.log replay would leave a
    // rejoined client with no chooser at all — the reason the per-side log
    // exists is functional as well as privacy.
    expect(reqOf(room.log)).toEqual([]);

    // FACT 2: no side holds the other's request lines.
    const sideIdsIn = (lines: string[]) => [...new Set(reqOf(lines).map((l) => {
      try { return (JSON.parse(l.slice("|request|".length)) as any)?.side?.id ?? "-"; }
      catch { return "?"; }
    }))];
    expect(sideIdsIn(room.a.log ?? [])).toEqual(["p1"]);
    expect(sideIdsIn(room.b.log ?? [])).toEqual(["p2"]);

    // And the per-side log is exactly the transport's own delivery record for
    // that user — the property that makes a replay incapable of leaking.
    expect(room.a.log).toEqual(liveLines(events, "uA"));
    expect(room.b.log).toEqual(liveLines(events, "uB"));

    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  });
});
