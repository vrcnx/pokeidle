// Wiring guards for lib/pvpFormat.ts.
//
// That module was written, documented and then imported by NOTHING for its
// whole life: pvp.ts kept a hardcoded `gen5customgame@@@!Team Preview` of its
// own and a level "cap" that only ever LOWERED. Both halves are now wired, and
// both halves are the kind of thing that gets quietly reverted — one because a
// clause name looks like a harmless string, the other because raising a level
// breaks a test fixture that assumed a cap. So each is pinned by execution
// against the real simulator rather than by a comment.
//
// What is deliberately NOT re-asserted here: everything tests/pvpRejoinLeak.ts,
// pvpBattleView.ts and pvpOutcomeIntegrity.ts already own. The one overlap is
// the side-exclusive-lines property, and it is here because those files run
// against a battle whose format they build themselves — this one runs it
// against the format string production actually ships, which is where a future
// clause addition would break it.

import { afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  prisma: {
    pvpMatch: { create: vi.fn(async () => ({})) },
    playerRating: { upsert: vi.fn(async () => ({ rating: 1000, peakRating: 1000 })), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => ({ aDelta: 0, bDelta: 0, aRating: 0, bRating: 0 })),
    $executeRaw: vi.fn(async () => 1),
  },
}));
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));

import { BattleStreams, Teams } from "@pkmn/sim";
import {
  simFormatId,
  SIM_BASE_FORMAT_ID,
  normalizeTeamLevel,
  clauseSummary,
} from "../src/lib/pvpFormat.js";
import {
  adaptTeamForSimulator,
  battleRooms,
  checkTeamForFormat,
  endBattle,
  levelCapForFormat,
  startBattle,
  type BattleRoom,
} from "../src/pvp.js";
import { answerTeamPreview, passTeamPreview } from "./support/teamPreview.js";

const io = { to: () => ({ emit: () => {} }) } as never;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The format string production ships. Read through simFormatId rather than
 *  copied, so this file cannot drift from the thing it is guarding — which is
 *  exactly what it did the day Team Preview was turned on and this constant
 *  still said `false`: every assertion below kept passing against a format
 *  string nothing shipped any more. */
const PROD_FORMAT = simFormatId(true);
/** The same rule list WITH the Team Preview removal, i.e. what shipped before
 *  the picker existed. Kept as the CONTROL for section 2 rather than deleted:
 *  "the phase does not start a battle on its own" is only meaningful next to a
 *  format where turn 1 opens immediately. */
const NO_PREVIEW_FORMAT = simFormatId(false);

// ── A battle driven straight at the simulator ─────────────────────────────
// Bypasses pvp.ts entirely: the question in this half of the file is what the
// SIMULATOR does with a rule name, and routing through pvp.ts would only add a
// layer that could swallow the answer.

const packed = (team: unknown[]) =>
  Teams.pack(adaptTeamForSimulator(team as never).sets as never);

const oneOnOne = {
  a: [{ speciesKey: "machamp", nickname: "ALPHA", level: 50, ability: "guts", moves: [{ id: "closeCombat" }] }],
  b: [{ speciesKey: "snorlax", nickname: "BRAVO", level: 50, ability: "thickFat", moves: [{ id: "bodySlam" }] }],
};

interface Probe {
  started: boolean;
  throws: string[];
  p1: string[];
  p2: string[];
  omni: string[];
}

/** Start a battle on `formatid`, optionally play `turns` turns, and report what
 *  came out of all three channels. A rule the simulator does not recognise
 *  throws out of the stream pump rather than degrading, which is exactly why
 *  this is measured instead of assumed. */
async function probe(formatid: string, turns = 0): Promise<Probe> {
  const omniStream = new BattleStreams.BattleStream();
  const ps = BattleStreams.getPlayerStreams(omniStream);
  const out: Probe = { started: false, throws: [], p1: [], p2: [], omni: [] };
  const pump = async (s: AsyncIterable<string>, into: string[]) => {
    try {
      for await (const chunk of s) for (const l of chunk.split("\n")) if (l) into.push(l);
    } catch (e) { out.throws.push(e instanceof Error ? e.message : String(e)); }
  };
  void pump(ps.p1, out.p1);
  void pump(ps.p2, out.p2);
  void pump(ps.omniscient, out.omni);
  try {
    omniStream.write([
      `>start {"formatid":${JSON.stringify(formatid)},"seed":[9,8,7,6]}`,
      `>player p1 {"name":"Alice","team":${JSON.stringify(packed(oneOnOne.a))}}`,
      `>player p2 {"name":"Bob","team":${JSON.stringify(packed(oneOnOne.b))}}`,
    ].join("\n"));
  } catch (e) { out.throws.push(e instanceof Error ? e.message : String(e)); }
  await settle(120);
  // Answer Team Preview before trying to move. `default` is the identity order,
  // so the one-Pokemon fixture leads with the same mon either way — and on a
  // format that REMOVED the phase these two writes are refused with an |error|
  // on the player stream and nothing else changes, which is what lets one probe
  // serve both halves of section 2.
  try { omniStream.write(">p1 default"); omniStream.write(">p2 default"); }
  catch (e) { out.throws.push(e instanceof Error ? e.message : String(e)); }
  await settle(100);
  for (let t = 0; t < turns; t++) {
    try { omniStream.write(">p1 move 1"); omniStream.write(">p2 move 1"); }
    catch (e) { out.throws.push(e instanceof Error ? e.message : String(e)); break; }
    await settle(80);
  }
  await settle(120);
  try { omniStream.destroy(); } catch { /* already gone */ }
  out.started = out.omni.some((l) => l.startsWith("|start"));
  return out;
}

// ══ 1 · every declared rule id is one the simulator actually knows ═════════

describe("the format string production ships is accepted by the real simulator", () => {
  it("starts a battle on the whole rule list at once", async () => {
    const r = await probe(PROD_FORMAT, 1);
    expect(r.throws).toEqual([]);
    expect(r.started).toBe(true);
    // A rule failure surfaces as a throw, so the battle also has to have
    // actually produced play — otherwise "no throw" proves very little.
    expect(r.omni.some((l) => l.startsWith("|turn|"))).toBe(true);
  }, 20_000);

  it("starts on each declared rule INDIVIDUALLY, so a bad one cannot hide behind a good one", async () => {
    const declared = PROD_FORMAT.slice(`${SIM_BASE_FORMAT_ID}@@@`.length).split(",");
    // No `!`-prefixed entries any more: the only one there ever was is
    // `!Team Preview`, and the phase is on. If a future removal is added, it
    // belongs in its own section — re-declaring one alongside itself is its own
    // error ("Multiple \"!teampreview\" rules").
    expect(declared.filter((r) => r.startsWith("!"))).toEqual([]);
    expect(declared.length).toBeGreaterThan(1);
    for (const rule of declared) {
      const r = await probe(`${SIM_BASE_FORMAT_ID}@@@${rule}`);
      expect(r.throws, `rule "${rule}" was rejected by the simulator`).toEqual([]);
      expect(r.started, `rule "${rule}" prevented |start`).toBe(true);
    }
  }, 40_000);

  it("declares neither of the two ids that are known to kill every battle", async () => {
    // These are not superstition, and the proof is below: an unrecognised or
    // duplicated rule does not degrade, it throws before `|start`, so shipping
    // one is a total PvP outage — the same class of failure as the |tier|
    // prefix bug. "Sleep Clause" is what the competitive community calls the
    // rule and what Showdown's own UI displays, which is exactly why it is the
    // mistake that gets made.
    expect(PROD_FORMAT).not.toMatch(/(^|,)Sleep Clause(,|$)/);
    expect(PROD_FORMAT).not.toContain("Cancel Mod");
    // The real id IS declared.
    expect(PROD_FORMAT).toContain("Sleep Clause Mod");

    const wrongSleep = await probe(`${SIM_BASE_FORMAT_ID}@@@Sleep Clause`);
    expect(wrongSleep.started).toBe(false);
    expect(wrongSleep.throws.join(" ")).toContain('Unrecognized rule "Sleep Clause"');

    const dupeCancel = await probe(`${SIM_BASE_FORMAT_ID}@@@Cancel Mod`);
    expect(dupeCancel.started).toBe(false);
    expect(dupeCancel.throws.join(" ")).toContain("already exists");
  }, 30_000);
});

// ══ 2 · Team Preview is ON, and it is answerable ══════════════════════════
//
// This section said the opposite for the whole life of PvP: "Team Preview is
// off, and that is load-bearing rather than tidy". It was true — a phase with
// nothing able to answer it stranded every battle until the AFK watchdog — and
// what changed is not the measurement but the client and the auto-lock. So the
// old assertion is KEPT, as the control: the same probe that now reaches turn 1
// on the production format is run against a format string with no answer, and
// it still fails to start. That is the difference between "the phase is
// harmless" and "the phase is answered".

describe("Team Preview is on, and the phase is answerable", () => {
  it("opens on the preview request, then on turn 1 once both sides answer", async () => {
    expect(PROD_FORMAT).not.toContain("!Team Preview");
    const r = await probe(PROD_FORMAT);
    // FIRST request: the phase. No active slot, no moves — exactly the payload
    // that used to strand a battle.
    const first = JSON.parse(r.p1.find((l) => l.startsWith("|request|"))!.slice("|request|".length));
    expect(first.teamPreview).toBe(true);
    expect(first.active).toBeUndefined();
    // The preamble that drives the picker, on BOTH streams.
    expect(r.p1).toContain("|clearpoke");
    expect(r.p1).toContain("|teampreview");
    expect(r.p1.filter((l) => l.startsWith("|poke|"))).toHaveLength(2);
    expect(r.p2.filter((l) => l.startsWith("|poke|"))).toEqual(r.p1.filter((l) => l.startsWith("|poke|")));
    // …and the probe's `default` answers really did resolve it: the battle
    // started and the NEXT request is a real action request.
    expect(r.started).toBe(true);
    const last = JSON.parse(r.p1.filter((l) => l.startsWith("|request|")).pop()!.slice("|request|".length));
    expect(last.teamPreview).toBeUndefined();
    expect(last.active?.[0]?.moves?.length).toBeGreaterThan(0);
  }, 20_000);

  it("CONTROL: unanswered, the phase really does strand the battle", async () => {
    // The outage, still reproducible — this is what the auto-lock in pvp.ts's
    // startBattle exists to prevent, and without it here the test above would
    // only prove that answering works, not that answering is REQUIRED.
    const omniStream = new BattleStreams.BattleStream();
    const ps = BattleStreams.getPlayerStreams(omniStream);
    const p1: string[] = [];
    const omni: string[] = [];
    const pump = async (s: AsyncIterable<string>, into: string[]) => {
      try { for await (const c of s) for (const l of c.split("\n")) if (l) into.push(l); }
      catch { /* destroyed below */ }
    };
    void pump(ps.p1, p1);
    void pump(ps.p2, []);
    void pump(ps.omniscient, omni);
    omniStream.write([
      `>start {"formatid":${JSON.stringify(PROD_FORMAT)},"seed":[9,8,7,6]}`,
      `>player p1 {"name":"Alice","team":${JSON.stringify(packed(oneOnOne.a))}}`,
      `>player p2 {"name":"Bob","team":${JSON.stringify(packed(oneOnOne.b))}}`,
    ].join("\n"));
    await settle(150);
    // A move choice against a preview request is refused, verbatim.
    omniStream.write(">p1 move 1");
    omniStream.write(">p2 move 1");
    await settle(200);
    expect(omni.some((l) => l.startsWith("|start"))).toBe(false);
    expect(omni.some((l) => l.startsWith("|turn|"))).toBe(false);
    expect(p1.some((l) => l.includes("You need a teampreview response"))).toBe(true);
    try { omniStream.destroy(); } catch { /* already gone */ }
  }, 20_000);

  it("CONTROL: the removal clause still works, so the flag is a real switch", async () => {
    // simFormatId(false) is what shipped before the picker. Turn 1 opens
    // immediately with a real action request and no |poke| lines at all.
    const r = await probe(NO_PREVIEW_FORMAT);
    expect(r.throws).toEqual([]);
    expect(r.started).toBe(true);
    expect(r.p1.filter((l) => l.startsWith("|poke|"))).toEqual([]);
    const first = JSON.parse(r.p1.find((l) => l.startsWith("|request|"))!.slice("|request|".length));
    expect(first.teamPreview).toBeUndefined();
    expect(first.active?.[0]?.moves?.length).toBeGreaterThan(0);
  }, 20_000);
});

// ══ 3 · the clauses did not widen the per-side privacy boundary ═══════════

describe("adding the battle clauses did not split the per-side streams", () => {
  it("keeps |request| the only side-exclusive line on the PRODUCTION format", async () => {
    // The belief that blocked this wiring was that "HP Percentage Mod" splits
    // the secret/shared halves of every |split| block, which would break
    // pvpRejoinLeak's core assertion. It does not: Custom Game runs debug:true
    // → reportExactHP, and reportExactHP wins over reportPercentages. Pinned
    // here against the shipped format string so that if a future clause DOES
    // split them, this fails rather than the rejoin replay quietly turning
    // into a leak.
    const r = await probe(PROD_FORMAT, 3);
    expect(r.throws).toEqual([]);
    expect(r.omni.some((l) => l.startsWith("|-damage|"))).toBe(true);
    const s1 = new Set(r.p1);
    const s2 = new Set(r.p2);
    const only1 = r.p1.filter((l) => !s2.has(l));
    const only2 = r.p2.filter((l) => !s1.has(l));
    expect(only1.length).toBeGreaterThan(0);
    expect(only2.length).toBeGreaterThan(0);
    expect(only1.filter((l) => !l.startsWith("|request|"))).toEqual([]);
    expect(only2.filter((l) => !l.startsWith("|request|"))).toEqual([]);
    // And foe HP is still EXACT, which is the other half of the same finding:
    // the rule is declared, accepted, and does not deliver hidden HP. Hiding it
    // remains an open item on our side of the stream.
    expect(r.p1.some((l) => /^\|switch\|p2a: BRAVO\|Snorlax, L50.*\|\d{3,}\/\d{3,}$/.test(l))).toBe(true);
  }, 25_000);
});

// ══ 4 · levels normalise in BOTH directions ══════════════════════════════

describe("a format level normalises up as well as down", () => {
  const rooms: BattleRoom[] = [];
  afterEach(async () => {
    for (const room of rooms.splice(0)) {
      if (room.expiryTimer) clearInterval(room.expiryTimer);
      await endBattle(room, undefined, "cancelled");
      battleRooms.delete(room.id);
    }
  });

  const makeRoom = (format: string, aTeam: unknown, bTeam: unknown): BattleRoom => {
    const room: BattleRoom = {
      id: `b_fw${Math.random().toString(16).slice(2, 8)}`,
      status: "invited", format,
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: { userId: "uA", username: "Alice", team: aTeam as never, stream: null, request: null, connected: true },
      b: { userId: "uB", username: "Bob", team: bTeam as never, stream: null, request: null, connected: true },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(room.id, room);
    rooms.push(room);
    return room;
  };

  const under = [{ speciesKey: "caterpie", nickname: "UNDERSIZED", level: 9, moves: [{ id: "tackle" }] }];
  const over = [{ speciesKey: "snorlax", nickname: "OVERSIZED", level: 100, moves: [{ id: "bodySlam" }] }];

  it("pulls a Lv 9 UP to 50 and a Lv 100 DOWN to 50 in the rated queue", async () => {
    // THE fix. Of the 2,299 accounts with a party, 87.0% are entirely under Lv
    // 50 and 6.7% are mixed, so under the old lowering-only cap ~94% of players
    // entered a queue advertised as "Lv 50" undersized while their opponent was
    // brought down to it. Both directions, one assertion each, on a real battle.
    const room = makeRoom("random50", under, over);
    expect(levelCapForFormat("random50")).toBe(50);
    await startBattle(io, room, () => {});
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(250);
    expect(room.log.some((l) => l.startsWith("|switch|p1a: UNDERSIZED|Caterpie, L50"))).toBe(true);
    expect(room.log.some((l) => l.startsWith("|switch|p2a: OVERSIZED|Snorlax, L50"))).toBe(true);
    // Nothing under Lv 50 is left anywhere in the battle's own record.
    expect(room.log.some((l) => /^\|switch\|.*, L9[,|]/.test(l))).toBe(false);
    // The player's own Pokémon is untouched: normalizeTeamLevel copies, and
    // room.*.team is what the PvpMatch row and the replay endpoint publish.
    expect(room.a.team[0].level).toBe(9);
    expect(room.b.team[0].level).toBe(100);
  }, 20_000);

  it("raising is a real stat change, not a relabelled level", async () => {
    // The simulator re-derives stats from base + IVs + EVs + level, so a raised
    // mon fights with genuine Lv 50 stats. A Lv 9 Caterpie has 30-ish HP; a Lv
    // 50 one has three figures. If the level were only cosmetic the HP in the
    // switch line would give it away.
    const room = makeRoom("random50", under, over);
    await startBattle(io, room, () => {});
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(250);
    const line = room.log.find((l) => l.startsWith("|switch|p1a: UNDERSIZED"))!;
    const hp = Number(line.split("|").pop()!.split("/")[1]);
    expect(hp).toBeGreaterThan(99);
  }, 20_000);

  it("leaves an anything-goes team and a practice team exactly as they are", async () => {
    // The null case still means "ship it as-is". anything-goes is unrated and
    // named for it, and a bot room is LEVEL-MATCHED to the player by
    // lib/pvpBotRoster.ts — normalising it to 50 would drag the human's own
    // team up too and invalidate every roster decision.
    expect(levelCapForFormat("anything-goes")).toBeNull();
    expect(levelCapForFormat("bot")).toBeNull();
    expect(levelCapForFormat("tournament", { levelCap: undefined } as never)).toBeNull();
    const room = makeRoom("anything-goes", under, over);
    await startBattle(io, room, () => {});
    // Team Preview is ON, so the first |request| both sides get is
    // `{"teamPreview":true}` and nothing below happens until it is answered.
    // See tests/support/teamPreview.ts.
    await passTeamPreview(room);
    await settle(250);
    expect(room.log.some((l) => l.startsWith("|switch|p1a: UNDERSIZED|Caterpie, L9"))).toBe(true);
    // Showdown omits the level from `details` when it is 100, because 100 is
    // the protocol's implicit default — so "still Lv 100" reads as a Snorlax
    // with no level segment at all, not as "L100".
    const oversized = room.log.find((l) => l.startsWith("|switch|p2a: OVERSIZED|"))!;
    expect(oversized).toMatch(/^\|switch\|p2a: OVERSIZED\|Snorlax(, [MF])?\|\d+\/\d+$/);
    expect(oversized).not.toContain(", L");
    expect(room.log.some((l) => l.includes(", L50"))).toBe(false);
  }, 20_000);

  it("normalizeTeamLevel itself raises, lowers, and passes a null through by identity", () => {
    const team = [{ level: 5 }, { level: 50 }, { level: 100 }];
    expect(normalizeTeamLevel(team, 50).map((p) => p.level)).toEqual([50, 50, 50]);
    // A null cap must return the SAME array — anything else would make the
    // "leave it exactly as it is" case a copy that a caller could mutate
    // believing it was the player's own team.
    expect(normalizeTeamLevel(team, null)).toBe(team);
    // An already-correct mon is passed through by identity, so a raise never
    // silently drops fields the shape does not declare.
    const same = normalizeTeamLevel(team, 50);
    expect(same[1]).toBe(team[1]);
    expect(same[0]).not.toBe(team[0]);
  });
});

// ══ 5 · team-composition clauses refuse BEFORE the battle ════════════════

describe("a clause violation is a message, not a battle that never starts", () => {
  const rooms: BattleRoom[] = [];
  afterEach(async () => {
    for (const room of rooms.splice(0)) {
      if (room.expiryTimer) clearInterval(room.expiryTimer);
      if (room.status === "active") await endBattle(room, undefined, "cancelled");
      battleRooms.delete(room.id);
    }
  });

  const evasive = [{ speciesKey: "gyarados", nickname: "DODGER", level: 50, moves: [{ id: "waterfall" }, { id: "doubleTeam" }] }];
  const ohko = [{ speciesKey: "rhydon", nickname: "DIGGER", level: 50, moves: [{ id: "fissure" }] }];
  const moody = [{ speciesKey: "snorlax", nickname: "LUCKY", level: 50, ability: "moody", moves: [{ id: "bodySlam" }] }];
  const clean = [{ speciesKey: "snorlax", nickname: "HONEST", level: 50, ability: "thickFat", moves: [{ id: "bodySlam" }] }];

  it("names the Pokémon and the clause, and reports every violation at once", () => {
    for (const format of ["random50", "tournament"]) {
      const e = checkTeamForFormat(evasive, format);
      expect(e.ok).toBe(false);
      if (!e.ok) {
        expect(e.violations.map((v) => v.code)).toEqual(["evasion"]);
        expect(e.error).toContain("DODGER");
        expect(e.error).toContain("Evasion Clause");
      }
      expect(checkTeamForFormat(ohko, format).ok).toBe(false);
      expect(checkTeamForFormat(moody, format).ok).toBe(false);
      expect(checkTeamForFormat(clean, format).ok).toBe(true);
    }
    // Every violation, not just the first: somebody fixing a team is told all
    // of it at once instead of discovering one more problem per attempt.
    const both = checkTeamForFormat([...evasive, ...ohko, ...moody], "random50");
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.violations.map((v) => v.code).sort()).toEqual(["evasion", "moody", "ohko"]);
  });

  it("says nothing about a private invite or a practice battle", () => {
    // Every message in lib/pvpFormat.ts says "ranked". A friend invite is
    // called anything-goes and a practice battle against our own AI is unrated
    // and unrecorded, so refusing either would be friction with nothing behind
    // it — and Species Clause stays off everywhere (19.8% of real accounts
    // would have their current party refused).
    for (const format of ["anything-goes", "bot"]) {
      expect(checkTeamForFormat(evasive, format).ok).toBe(true);
      expect(checkTeamForFormat(ohko, format).ok).toBe(true);
      expect(checkTeamForFormat(moody, format).ok).toBe(true);
    }
    // Species Clause is off everywhere, including in the label helper the
    // client will eventually render — turning it on needs a team-builder
    // warning first, not a one-line flip here.
    expect(clauseSummary({ speciesClause: false })).not.toContain("Species Clause");
    expect(checkTeamForFormat(
      [clean[0], { ...clean[0], nickname: "TWIN" }],
      "random50",
    ).ok).toBe(true);
  });

  it("startBattle refuses without touching the room, so the caller's catch still works", async () => {
    // The bracket ticker and the admin start-match route build rooms straight
    // from saved parties and never pass through socket.ts's intake, so this is
    // the only place they can be refused. Same contract as the drain latch:
    // the room comes back exactly as it was handed over, because every caller's
    // catch deletes an "invited" room and tells both players why.
    const room: BattleRoom = {
      id: "b_fwclause", status: "invited", format: "tournament",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: { userId: "uA", username: "Alice", team: clean as never, stream: null, request: null, connected: true },
      b: { userId: "uB", username: "Bob", team: ohko as never, stream: null, request: null, connected: true },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(room.id, room);
    rooms.push(room);
    let announced = 0;
    await expect(startBattle(io, room, () => {}, () => { announced++; })).rejects.toThrow(/OHKO Clause/);
    expect(announced).toBe(0);
    expect(room.status).toBe("invited");
    expect(room.stream).toBeNull();
    expect(room.expiryTimer).toBeNull();
    expect(room.log).toEqual([]);
    // The message names WHOSE team it was — a one-sided message leaves the
    // other player wondering which of them is being refused.
    await expect(startBattle(io, room, () => {})).rejects.toThrow(/Bob's team/);
  }, 20_000);
});
