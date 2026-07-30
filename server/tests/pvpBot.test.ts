// AI practice battles — pinned by EXECUTION, not by reading the guards.
//
// A bot is a player with NO SOCKET, and that is the whole difficulty: every
// mechanism in pvp.ts that assumes a socket is a candidate failure, and
// sendToUser silently no-ops for a user with no sockets — so a bug on the bot
// side produces no error line anywhere. Everything here therefore drives a
// REAL @pkmn/sim battle with a real brain attached and asserts on outcomes,
// never on the presence of a guard.
//
// Four defects were found this way while building it, and each has a case
// below whose failure would be exactly the production symptom:
//
//  1. TWO `for await` CONSUMERS ON ONE PLAYER STREAM DO NOT BOTH SEE THE DATA.
//     getPlayerStreams pushes each side's lines into an ObjectReadWriteStream
//     whose next() shifts one shared buffer, so the first loop takes
//     everything. Measured on a live battle: consumer A got 2 chunks including
//     the |request|, consumer B got 0. Attaching RandomPlayerAI.start() to
//     playerStreams.p2 while the room's own pump also reads p2 therefore
//     yields a SILENTLY MUTE bot that never answers, with nothing logged, and
//     the battle dies to the AFK watchdog five minutes later.
//
//  2. THE AFK WATCHDOG DECLARED THE ABSENT HUMAN THE WINNER. The bot writes
//     into its own player stream and so never passes through applyChoice,
//     which is what stamps movedAt. With room.b.movedAt undefined, the
//     watchdog's `aMoved > bMoved` tiebreak resolves to the human — the player
//     who walked away wins. Fixed by stamping from the brain's choose(), which
//     means the watchdog needs no bot branch at all.
//
//  3. A WRITE TO A DESTROYED STREAM THROWS SYNCHRONOUSLY
//     (`Error: Push after end of read stream`). Out of a bare setTimeout
//     callback that is an uncaught exception: process death, taking every
//     other live battle with it.
//
//  4. RandomPlayerAI.receiveError RETHROWS anything that is not
//     "[Unavailable choice]", and receiveRequest itself throws when it can
//     find no legal choice. An escaped throw leaves the bot mute.
//
// DB stubbing follows tests/pvp.test.ts and tests/pvpForfeitBounds.test.ts:
// vi.mock replaces ../src/db.js, so nothing here can construct a PrismaClient.
// Nothing imports ../src/socket.js — every helper under test takes its
// transport and its presence predicate as a parameter.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const ratingUpsert = vi.fn(async ({ where }: any) => ({
    userId: where.userId, rating: 1000, peakRating: 1000,
  }));
  const ratingUpdate = vi.fn(async () => ({}));
  const matchCreate = vi.fn(async () => ({}));
  const tx = { playerRating: { upsert: ratingUpsert, update: ratingUpdate } };
  const transaction = vi.fn(async (fn: any) => fn(tx));
  return {
    ratingUpsert, ratingUpdate, matchCreate, transaction,
    prisma: {
      pvpMatch: { create: matchCreate },
      playerRating: { upsert: ratingUpsert, update: ratingUpdate },
      $transaction: transaction,
      $executeRaw: vi.fn(async () => 1),
    },
  };
});
vi.mock("../src/db.js", () => ({ prisma: db.prisma }));

import fs from "node:fs";
import path from "node:path";
import { BattleStreams, Dex, toID } from "@pkmn/sim";
import {
  battleRooms,
  startBattle,
  endBattle,
  applyChoice,
  isBotRoom,
  beginDisconnectGrace,
  beginReconnectGrace,
  snapshotForSide,
  resolveRejoin,
  resolveSync,
  releaseBotBattlesFor,
  turnTimeoutFor,
  TURN_TIMEOUT_MS,
  BOT_TURN_TIMEOUT_MS,
  BOT_WATCHDOG_POLL_MS,
  WATCHDOG_POLL_MS,
  TEAM_PREVIEW_LOCK_MS,
  RECONNECT_GRACE_MS,
  type BattleRoom,
  type GraceDeps,
} from "../src/pvp.js";
import {
  BOT_TRAINERS, buildBotTeam, movesFor, rankTrainers, bstOf, profileOf, matchDistance,
} from "../src/lib/pvpBotRoster.js";
import { createBotSeat, type BotTier } from "../src/lib/pvpBotBrain.js";

const DEX = Dex.forFormat("gen5customgame");
const io = { to: () => ({ emit: () => {} }) } as any;

const HUMAN_ID = "uHuman";
const HUMAN_NAME = "Ash";

interface Harness {
  present: Set<string>;
  deps: GraceDeps;
  events: { userId: string; event: string; payload: any }[];
  send: (userId: string, event: string, payload: unknown) => void;
}

function makeHarness(present: string[] = [HUMAN_ID]): Harness {
  const p = new Set(present);
  const events: Harness["events"] = [];
  const send = (userId: string, event: string, payload: unknown) => {
    events.push({ userId, event, payload });
  };
  return {
    present: p,
    events,
    send,
    deps: { sendToUser: send, isPresent: (u) => p.has(u) },
  };
}

let seq = 0;

/** A human-vs-AI room in exactly the shape socket.ts's battle:bot builds. */
function botRoom(opts: {
  levels?: number[];
  tier?: BotTier;
  trainer?: string;
} = {}): { room: BattleRoom; botId: string; botLabel: string } {
  const levels = opts.levels ?? [25, 25];
  const id = `b_bot${++seq}`;
  const human = levels.map((level, i) => ({
    id: `m${i}`,
    speciesKey: i === 0 ? "pikachu" : "bulbasaur",
    name: i === 0 ? "Pika" : "Bulba",
    level,
    moves: i === 0 ? [{ id: "thunderShock" }] : [{ id: "tackle" }],
  }));
  const plan = buildBotTeam(human, opts.trainer ?? "youngster");
  const botId = `bot:${id}`;
  const room: BattleRoom = {
    id,
    status: "invited",
    format: "bot",
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: {
      userId: HUMAN_ID, username: HUMAN_NAME, team: human as never,
      stream: null, request: null, connected: true,
    },
    b: {
      userId: botId, username: plan.label, team: plan.team as never,
      stream: null, request: null, connected: true, awayAt: null,
      isBot: true, botTier: opts.tier ?? "trainer",
    },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  };
  battleRooms.set(id, room);
  return { room, botId, botLabel: plan.label };
}

/** Start it for real. Fake timers are already installed by beforeEach; the
 *  0-tick lets the simulator's own promise chain deliver the preamble. */
async function liveBotBattle(
  h: Harness,
  opts?: Parameters<typeof botRoom>[0] & {
    /** Leave the human silent through Team Preview as well as through the
     *  battle. For the watchdog tests whose whole premise is "this player never
     *  chose ANYTHING" — with the phase on, answering it would stamp movedAt
     *  and quietly turn them into a player who chose once. */
    humanSilent?: boolean;
  },
) {
  const made = botRoom(opts);
  await startBattle(io, made.room, h.send, () => {
    h.send(HUMAN_ID, "battle:start", {
      battleId: made.room.id, format: "bot",
      opponent: { id: made.botId, username: made.botLabel }, you: "a",
    });
  });
  await vi.advanceTimersByTimeAsync(0);

  // ─── TEAM PREVIEW, AND THE BOT'S HALF OF IT ─────────────────────────
  //
  // The AI answers this phase entirely on its own: pvp.ts hands its chunks to
  // the brain, and RandomPlayerAI.chooseTeamPreview returns `default` — so the
  // bot seat needs no code here and locks in on its ordinary 600-1200 ms think
  // timer. That is the whole justification for leaving Team Preview ON in
  // practice battles rather than skipping it: the phase a player rehearses
  // against the AI is the phase they will meet on the ladder, and the
  // "opponent" never keeps them waiting.
  //
  // The HUMAN half is this loop. Advancing time is what lets the bot's think
  // timer fire, so both halves resolve together.
  for (let i = 0; i < 20; i++) {
    const req = made.room.a.request as { teamPreview?: boolean } | null;
    if (!req?.teamPreview && made.room.a.request) break;
    if (req?.teamPreview && !opts?.humanSilent) applyChoice(made.room, HUMAN_ID, "default");
    await vi.advanceTimersByTimeAsync(200);
    // A silent human is left in the phase on purpose; the server's own
    // 20-second auto-lock is what gets that battle to turn 1, and the tests
    // that ask for this are the ones measuring what happens next.
    if (opts?.humanSilent) break;
  }
  return made;
}

/** Does the human have a decision to make right now?
 *
 *  Team Preview counts. Its request carries neither `active` nor `forceSwitch`
 *  — those are the two fields this used to test — so before this line every
 *  driver in the file silently decided the human had nothing to do, never
 *  answered the phase, and sat there until the 20-second auto-lock (or, on fake
 *  timers, forever). `default` is a legal answer to it, which is why the
 *  drivers below need no second branch. */
function humanMustChoose(room: BattleRoom): boolean {
  const req = room.a.request as any;
  if (!req || req.wait) return false;
  return !!(req.active || req.forceSwitch || req.teamPreview);
}

/** Drive the HUMAN with `default` and let the bot answer on its own think
 *  timers, until somebody wins. `default` is always legal, which is the point:
 *  the human side of this test contributes no strategy, so anything the
 *  battle does is the simulator and the brain. */
async function playToEnd(room: BattleRoom, maxSteps = 400): Promise<void> {
  for (let i = 0; i < maxSteps && room.status === "active"; i++) {
    if (humanMustChoose(room)) applyChoice(room, HUMAN_ID, "default");
    // Past the bot's 600–1200 ms think window, but well under the 30 s
    // watchdog poll so a slow battle is never timed out mid-test.
    await vi.advanceTimersByTimeAsync(1_500);
  }
}

function rows() { return db.matchCreate.mock.calls.map((c: any) => c[0].data); }

/** Every DB surface a rated result would touch. Asserted as a group so a new
 *  write path added to endBattle cannot slip past one of them. */
function expectNothingRated(): void {
  expect(db.matchCreate).not.toHaveBeenCalled();
  expect(db.ratingUpsert).not.toHaveBeenCalled();
  expect(db.ratingUpdate).not.toHaveBeenCalled();
  expect(db.transaction).not.toHaveBeenCalled();
}

function tearDown(room: BattleRoom): void {
  if (room.expiryTimer) clearInterval(room.expiryTimer);
  if (room.a.graceTimer) clearTimeout(room.a.graceTimer);
  if (room.b.graceTimer) clearTimeout(room.b.graceTimer);
  if (room.a.botTimer) clearTimeout(room.a.botTimer);
  if (room.b.botTimer) clearTimeout(room.b.botTimer);
  battleRooms.delete(room.id);
}

beforeEach(() => {
  db.matchCreate.mockClear();
  db.ratingUpdate.mockClear();
  db.ratingUpsert.mockClear();
  db.transaction.mockClear();
  battleRooms.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const r of Array.from(battleRooms.values())) tearDown(r);
  battleRooms.clear();
});

// ═══ 1. The bot actually plays ════════════════════════════════════════════
// This is the case that fails if anything ever double-consumes p2. A mute bot
// still produces a "running" battle for a while, so the assertion is not
// "did it start" but "did the AI submit choices and did the battle finish".

describe("a bot battle plays itself out", () => {
  it("runs to a real winner with the AI submitting every one of its own choices", async () => {
    const h = makeHarness();
    const { room, botId, botLabel } = await liveBotBattle(h, { levels: [25, 25] });
    expect(room.status).toBe("active");

    await playToEnd(room);

    // The battle really ended, from the simulator's own |win| line.
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("ko");
    expect(room.log.some((l) => l.startsWith("|win|"))).toBe(true);
    expect([HUMAN_ID, botId]).toContain(room.winnerId);
    // Several turns actually happened — a mute bot cannot get past turn 1,
    // because the simulator will not advance until both sides have chosen.
    expect(room.log.some((l) => l === "|turn|3")).toBe(true);
    // …and the AI is the one that chose, every time. movedAt is stamped by the
    // brain's own choose(), and it is what stops defect 2 above.
    expect(room.b.movedAt).toBeGreaterThan(0);

    // The human's replay source is intact and side-scoped: pumpPlayerStream
    // ran on p1 verbatim, which is what makes battle:rejoin work unchanged.
    expect((room.a.log ?? []).some((l) => l.startsWith("|request|"))).toBe(true);
    // Nothing was ever addressed to a socket-less seat.
    expect(h.events.some((e) => e.userId === botId)).toBe(false);
    // The label the player saw can never be mistaken for a human handle:
    // usernames are [A-Za-z0-9_] only, so a space is impossible.
    expect(botLabel).toMatch(/ AI$/);
    expect(botLabel).toContain(" ");
  });

  it("level-matches the AI to the human slot-for-slot, and never caps the human", async () => {
    const h = makeHarness();
    // 87% of real accounts are entirely under Lv 50, so this is the case that
    // matters: a flat Lv 50 bot would be a non-battle.
    const { room } = await liveBotBattle(h, { levels: [7, 4, 12] });
    const humanLevels = room.a.team.map((m: any) => m.level).sort((x, y) => y - x);
    const botLevels = room.b.team.map((m: any) => m.level).sort((x, y) => y - x);
    expect(botLevels).toEqual(humanLevels);
    expect(room.b.team).toHaveLength(3);
    // format "bot" has no level cap, so the player's own team is untouched.
    expect(room.a.team.map((m: any) => m.level)).toEqual([7, 4, 12]);
    await endBattle(room, h.send, "cancelled");
  });
});

// ═══ 2. NEVER RATED, NEVER RECORDED — proved on every end path ════════════

describe("a bot battle is never rated and never recorded", () => {
  const endPaths: [string, (room: BattleRoom, h: Harness) => Promise<void>][] = [
    ["a real KO", async (room) => { await playToEnd(room); }],
    ["an explicit forfeit (the arena's Forfeit button)", async (room, h) => {
      room.winnerId = room.b.userId;
      room.loserId = HUMAN_ID;
      await endBattle(room, h.send, "forfeit");
    }],
    ["the AFK turn-timeout watchdog", async (room) => {
      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    }],
    ["the reconnect-grace expiry after the human vanishes", async (room, h) => {
      h.present.delete(HUMAN_ID);
      beginDisconnectGrace(HUMAN_ID, h.deps);
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 50);
    }],
    ["the shutdown drain's cancel", async (room, h) => {
      await endBattle(room, h.send, "cancelled");
    }],
  ];

  for (const [label, end] of endPaths) {
    it(`writes no PvpMatch row and moves no rating through ${label}`, async () => {
      const h = makeHarness();
      const { room, botId } = await liveBotBattle(h, { levels: [25] });
      await end(room, h);

      expect(room.status === "completed" || room.status === "cancelled").toBe(true);
      // Guard 2: no row at all. A row marked format:"bot" would still land in
      // GET /pvp/me/history (no format filter) and inflate the hub's displayed
      // win streak with wins over an AI.
      expect(rows()).toHaveLength(0);
      // Guard 1: no rating surface touched, by any route.
      expectNothingRated();
      // …and the payload the human receives says so.
      const complete = h.events.filter((e) => e.event === "battle:complete");
      expect(complete.length).toBeGreaterThan(0);
      expect(complete[0].userId).toBe(HUMAN_ID);
      expect(complete[0].payload.ratingDelta).toBeNull();
      expect(h.events.some((e) => e.userId === botId)).toBe(false);
      // The DURABLE flag survives endBattle nulling the brain — which is the
      // only reason the two guards above could run at all.
      expect(isBotRoom(room)).toBe(true);
      expect(room.b.bot ?? null).toBeNull();
    });
  }

  it("stays unrated when the room carries the RATED format string", async () => {
    // The requirement is that the guard cannot be defeated by a format string,
    // and the file claims two INDEPENDENT guards for exactly that. Only the
    // format one was covered: every case above runs on format "bot", where the
    // `room.format === "random50"` test already fails, so `!botMatch` was never
    // the thing doing the work and deleting it would not have failed a test.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [50] });
    room.format = "random50";
    room.winnerId = HUMAN_ID;
    room.loserId = room.b.userId;
    await endBattle(room, h.send, "ko");
    expect(rows()).toHaveLength(0);
    expectNothingRated();
    const complete = h.events.filter((e) => e.event === "battle:complete");
    expect(complete[0].payload.ratingDelta).toBeNull();
  });

  it("CONTROL: the same helpers DO rate a real random50 battle", async () => {
    // Without this the suite above would pass just as happily if endBattle had
    // stopped rating everything.
    const h = makeHarness([HUMAN_ID, "uOther"]);
    const id = `b_ctl${++seq}`;
    const team = (n: string) => [{ speciesKey: "pikachu", name: n, level: 50, moves: [{ id: "thunderShock" }] }];
    const room: BattleRoom = {
      id, status: "invited", format: "random50",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: { userId: HUMAN_ID, username: HUMAN_NAME, team: team("A"), stream: null, request: null, connected: true },
      b: { userId: "uOther", username: "Gary", team: team("B"), stream: null, request: null, connected: true },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(id, room);
    await startBattle(io, room, h.send);
    await vi.advanceTimersByTimeAsync(0);
    room.winnerId = HUMAN_ID;
    room.loserId = "uOther";
    await endBattle(room, h.send, "forfeit");
    expect(rows()).toHaveLength(1);
    expect(db.ratingUpdate).toHaveBeenCalled();
    expect(isBotRoom(room)).toBe(false);
  });
});

// ═══ 3. The watchdog must not reward the human for walking away ═══════════

describe("the AFK watchdog and the AI seat", () => {
  it("gives the win to the AI when the HUMAN goes silent mid-battle", async () => {
    // THE regression. The bot never touches applyChoice, so without the
    // movedAt stamp in its choose() this asserts the exact opposite: aMoved
    // (the human's one real choice) beats bMoved (0) and the player who
    // abandoned the battle is declared the winner of it.
    const h = makeHarness();
    // TWO Pokémon on purpose, and it is not cosmetic: with one each, the single
    // human choice below can trade into a KO and the battle ends "ko" before
    // the watchdog ever runs — a flaky test that silently stops testing the
    // watchdog. With two, one human choice can at most force a switch, and the
    // turn cannot advance again without them, so the timeout is the only exit.
    const { room, botId } = await liveBotBattle(h, { levels: [25, 25] });
    // One human choice, then nothing — the "I closed the tab but my socket is
    // still open" case, which starts no reconnect grace at all.
    expect(humanMustChoose(room)).toBe(true);
    applyChoice(room, HUMAN_ID, "default");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(room.a.movedAt).toBeGreaterThan(0);
    expect(room.b.movedAt).toBeGreaterThan(0);
    expect(room.status).toBe("active");

    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("timeout");
    expect(room.winnerId).toBe(botId);
    expect(room.loserId).toBe(HUMAN_ID);
    expectNothingRated();
  });

  it("gives the win to the AI even when the human never chooses at all", async () => {
    // The other half of the tiebreak. Without the movedAt stamp both sides read
    // 0, `aMoved !== bMoved` is false, and the watchdog deliberately leaves
    // winnerId UNSET — a winnerless "completed" battle, which is the state the
    // tournament runner can never advance past.
    const h = makeHarness();
    // Silent from the FIRST request, which since Team Preview is the preview
    // request itself. That makes this the end-to-end version of the same story:
    // the phase's own 20-second auto-lock writes `default` for the missing
    // human and the battle reaches turn 1 anyway, the bot keeps playing, and
    // the turn watchdog then resolves it — with the AI named, because the AI is
    // the only side that ever stamped movedAt.
    const { room, botId } = await liveBotBattle(h, { levels: [25], humanSilent: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(room.a.movedAt ?? 0).toBe(0);
    expect(room.b.movedAt).toBeGreaterThan(0);
    // Still in Team Preview at 2 s, and out of it once the auto-lock has run.
    expect((room.a.request as any)?.teamPreview).toBe(true);
    await vi.advanceTimersByTimeAsync(TEAM_PREVIEW_LOCK_MS + 2_000);
    expect((room.a.request as any)?.teamPreview ?? false).toBe(false);
    expect(room.log.some((l) => l === "|start")).toBe(true);
    expect(room.a.movedAt ?? 0).toBe(0);   // the auto-lock is NOT a choice by them
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    expect(room.endReason).toBe("timeout");
    expect(room.winnerId).toBe(botId);
    expectNothingRated();
  });

  it("never stands the watchdog down for the AI seat, so a bot battle always terminates", async () => {
    // graceSuppressesWatchdog returns false while awayAt is null, and the AI's
    // awayAt must stay null forever. If it were ever set, the watchdog would
    // step aside for a side that can never come back: a HANG, which this
    // codebase already argues is worse than a bad loss.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    expect(room.b.awayAt ?? null).toBeNull();
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + WATCHDOG_POLL_MS * 2);
    expect(room.b.awayAt ?? null).toBeNull();
    expect(room.status).not.toBe("active");
  });
});

// ═══ 4. The reconnect machinery must not see a bot at all ════════════════

describe("reconnect grace never runs for the AI seat", () => {
  it("beginDisconnectGrace for the bot's own id holds nothing", async () => {
    const h = makeHarness();
    const { room, botId } = await liveBotBattle(h, { levels: [25] });
    const held = beginDisconnectGrace(botId, h.deps);
    expect(held.battleIds).toEqual([]);
    expect(held.queueHeld).toBe(false);
    expect(room.b.awayAt ?? null).toBeNull();
    expect(room.b.graceTimer ?? null).toBeNull();
    await endBattle(room, h.send, "cancelled");
  });

  it("beginReconnectGrace called directly on the bot side is refused", async () => {
    // Defence in depth: unreachable today, and the failure it prevents is a
    // permanent hang, so it is asserted rather than assumed.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    h.events.length = 0;
    beginReconnectGrace(room, "b", h.deps);
    expect(room.b.awayAt ?? null).toBeNull();
    expect(room.b.graceTimer ?? null).toBeNull();
    expect(h.events.filter((e) => e.event === "battle:opponent-away")).toHaveLength(0);
    await endBattle(room, h.send, "cancelled");
  });

  it("the AI is never announced as away, and the human is never told it left", async () => {
    const h = makeHarness();
    const { room, botLabel } = await liveBotBattle(h, { levels: [25] });
    await playToEnd(room, 60);
    const away = h.events.filter(
      (e) => e.event === "battle:opponent-away" || e.event === "battle:opponent-back",
    );
    expect(away).toHaveLength(0);
    expect(h.events.some((e) => e.payload?.username === botLabel)).toBe(false);
  });
});

// ═══ 5. A human abandoning a bot battle must free everything ═════════════

describe("an abandoned bot battle is reclaimed", () => {
  it("forfeits to the AI when the human's grace expires, then drops the room", async () => {
    const h = makeHarness();
    const { room, botId } = await liveBotBattle(h, { levels: [25] });
    h.present.delete(HUMAN_ID);
    const held = beginDisconnectGrace(HUMAN_ID, h.deps);
    expect(held.battleIds).toEqual([room.id]);
    expect(room.a.awayAt).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 50);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("forfeit");
    expect(room.winnerId).toBe(botId);
    expectNothingRated();

    // Everything the room held is released: brain, think timer, queued chunks,
    // simulator, watchdog interval — and then the room itself.
    expect(room.b.bot ?? null).toBeNull();
    expect(room.b.botTimer ?? null).toBeNull();
    expect(room.b.botQueue ?? null).toBeNull();
    expect(room.stream).toBeNull();
    expect(room.expiryTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(battleRooms.has(room.id)).toBe(false);
  });

  it("destroying the simulator really does end all three derived streams", async () => {
    // The reason the above is not a stream leak, measured directly rather than
    // inferred: endBattle's room.stream.destroy() ends the getPlayerStreams
    // driver loop, which pushEnd()s every derived stream, which terminates all
    // three `for await` pumps.
    vi.useRealTimers();
    const omni = new BattleStreams.BattleStream();
    const ps = BattleStreams.getPlayerStreams(omni);
    const ended = { p1: false, p2: false, omni: false };
    void (async () => { for await (const _c of ps.p1) { /* drain */ } ended.p1 = true; })();
    void (async () => { for await (const _c of ps.p2) { /* drain */ } ended.p2 = true; })();
    void (async () => { for await (const _c of ps.omniscient) { /* drain */ } ended.omni = true; })();
    await new Promise((r) => setTimeout(r, 20));
    expect(ended).toEqual({ p1: false, p2: false, omni: false });
    omni.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toEqual({ p1: true, p2: true, omni: true });
  });

  it("writing to a destroyed player stream throws SYNCHRONOUSLY — why the think timer is guarded", async () => {
    vi.useRealTimers();
    const omni = new BattleStreams.BattleStream();
    const ps = BattleStreams.getPlayerStreams(omni);
    void (async () => { for await (const _c of ps.omniscient) { /* drain */ } })();
    omni.destroy();
    await new Promise((r) => setTimeout(r, 20));
    // Out of a bare setTimeout callback this is an uncaught exception, i.e.
    // process death. Three guards in scheduleBotTurn exist for this one line.
    expect(() => ps.p2.write("move 1")).toThrow(/Push after end of read stream/);
  });
});

// ═══ 6. The late-write crash guard, exercised for real ═══════════════════

describe("the AI think timer can never crash the process", () => {
  it("swallows a write to a stream that died under it, and ENDS the battle", async () => {
    // Reproduce the race the guards exist for: kill the simulator WITHOUT
    // going through endBattle (which would clear the timer), so the pending
    // think timer fires on a room that still says "active" with a non-null
    // room.stream — and its write throws.
    //
    // The battle must also not be left standing. It used to be: measured, the
    // room stayed "active" with botFailures stuck at 1 (no further chunk can
    // arrive to arm another think timer, so the three-strike counter is
    // unreachable), the human sat in front of a live-looking board, and only the
    // AFK watchdog resolved it — minutes later, with the AI as the winner.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
    try {
      // A think timer is armed the moment the bot's first chunk lands.
      expect(room.b.botTimer ?? null).not.toBeNull();
      room.stream!.destroy();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(errors).toEqual([]);
      // Resolved in seconds, not minutes, and never rated or recorded.
      expect(room.status).toBe("cancelled");
      expect(room.endReason).toBe("cancelled");
      expectNothingRated();
      // The think timer and the brain are gone with it — no timer left holding
      // the room alive.
      expect(room.b.botTimer ?? null).toBeNull();
      expect(room.b.bot ?? null).toBeNull();
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUncaught);
      await endBattle(room, h.send, "cancelled");
    }
  });

  it("ends the battle when the brain cannot write at all, instead of freezing the board", async () => {
    // The failure mode the three-strike counter cannot reach. Measured on the
    // shipped code: kill the AI seat's stream and botFailures stops at 1 and
    // STAYS there — a further strike needs another chunk, and no chunk can ever
    // arrive — so the room sat "active" with zero events for 30 s of simulated
    // time and the human then waited out the whole turn clock and LOST it (the
    // bot's movedAt is ahead of theirs).
    //
    // The brain holds its stream by reference, so poisoning `write` in place is
    // what a dead stream looks like from inside the brain: the decision throws,
    // the `default` fallback throws too, and a fallback that cannot even write
    // `default` is proof that no number of further strikes would help.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(room.status).toBe("active");
    (room.b.stream as unknown as { write: (d: string) => void }).write = () => {
      throw new Error("Push after end of read stream");
    };
    // Make it the bot's turn again so the poisoned write is reached.
    if (humanMustChoose(room)) applyChoice(room, HUMAN_ID, "default");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(room.status).toBe("cancelled");
    expect(room.endReason).toBe("cancelled");
    // The human is TOLD, once, and it is not a loss for them.
    const done = h.events.filter((e) => e.event === "battle:complete");
    expect(done).toHaveLength(1);
    expect(done[0].userId).toBe(HUMAN_ID);
    expect(done[0].payload.winnerId ?? null).toBeNull();
    expect(done[0].payload.ratingDelta ?? null).toBeNull();
    expectNothingRated();
  });

  it("endBattle clears the pending think timer", async () => {
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    expect(room.b.botTimer ?? null).not.toBeNull();
    await endBattle(room, h.send, "cancelled");
    expect(room.b.botTimer ?? null).toBeNull();
    // Nothing left to fire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(room.status).toBe("cancelled");
  });
});

// ═══ 7. The arena contract: a rejoin still leaks nothing ════════════════

describe("battle:rejoin works unchanged, and still hides the AI's bench", () => {
  it("replays the human's own side and never the bot's unrevealed Pokémon", async () => {
    const h = makeHarness();
    const { room, botId, botLabel } = await liveBotBattle(h, { levels: [25, 25, 25] });
    // A few steps only, deliberately: the interesting state is a battle in
    // which most of the AI's team has not been sent out yet, so the assertion
    // below has something to be absent.
    await playToEnd(room, 3);

    const snap = snapshotForSide(room, HUMAN_ID)!;
    expect(snap.side).toBe("a");
    expect(snap.format).toBe("bot");
    expect(snap.opponent).toEqual({ id: botId, username: botLabel });
    expect(snap.levelCap).toBeNull();
    const blob = JSON.stringify(snap);
    // ─── WHAT TEAM PREVIEW MOVED HERE ───────────────────────────────
    //
    // This used to assert that every one of the AI's species which had NOT yet
    // switched in was absent from the human's snapshot. Team Preview publishes
    // all of them — `|poke|p2|Ekans, L25, M|` — to the human before turn 1, on
    // the shared channel, by design, so that assertion now only measures
    // whether the phase failed to happen. It is inverted rather than deleted:
    // every species must be PRESENT, which is a claim the old version could
    // never have made and which fails loudly if the phase regresses.
    const all = room.b.team.map((m: any) => toID(m.speciesKey));
    for (const k of all) {
      expect(blob.toLowerCase(), `preview should have revealed ${k}`).toContain(k);
    }
    // The line that did NOT move: the AI's own |request| payload, which carries
    // its stats, its EV/IV spread and its full movepool for all three. That is
    // the private channel, and the human's replay must contain only their own.
    const requestSides = new Set(
      snap.log
        .filter((l) => l.startsWith("|request|"))
        .map((l) => {
          try { return (JSON.parse(l.slice("|request|".length)) as any)?.side?.id ?? "-"; }
          catch { return "?"; }
        }),
    );
    expect(requestSides).toEqual(new Set(["p1"]));
    // …and the held-item marker on the preview lines, which the server strips
    // on every channel.
    expect(blob).not.toContain("|item");
    // A stranger gets nothing at all.
    expect(snapshotForSide(room, "uSomeoneElse")).toBeNull();
    if (room.status === "active") await endBattle(room, h.send, "cancelled");
  });

  it("the no-battleId discovery path finds a bot battle after a page reload", async () => {
    // Nothing is advanced here: a battle that has just started is definitely
    // live, so this asserts the discovery walk rather than racing a KO.
    const h = makeHarness();
    const { room, botId } = await liveBotBattle(h, { levels: [25] });
    const ack = resolveRejoin(HUMAN_ID);
    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.snapshot.battleId).toBe(room.id);
      expect(ack.snapshot.opponent.id).toBe(botId);
    }
    // …and a bot battle is not discoverable by anybody else.
    expect(resolveRejoin("uSomeoneElse")).toEqual({ ok: false, reason: "not_in_battle" });
    await endBattle(room, h.send, "cancelled");
  });
});

// ═══ 8. Roster invariants ════════════════════════════════════════════════

describe("the bot roster", () => {
  const allSpecies = [...new Set(BOT_TRAINERS.flatMap((t) => t.pool.map((e) => e.key)))];

  it("has 8 trainers whose labels always say AI and can never collide with a username", () => {
    expect(BOT_TRAINERS).toHaveLength(8);
    for (const t of BOT_TRAINERS) {
      expect(t.label).toMatch(/ AI$/);
      // validateUsername (lib/nameChange.ts) allows only [A-Za-z0-9_], so a
      // space makes a collision with — or an impersonation of — a real handle
      // impossible. This is also what makes pumpOmniLog's |win|<name> match
      // against room.b.username safe.
      expect(t.label).not.toMatch(/^[A-Za-z0-9_]+$/);
      // A POOL, not a fixed six. Six entries could only ever fit one point in
      // the game — which is exactly the finding this shape fixes — so every
      // trainer needs enough range to field a fair team at Lv 5 and at Lv 95.
      expect(t.pool.length, `${t.id} pool size`).toBeGreaterThanOrEqual(12);
      // Something available from level 1, or a low-level party gets whatever
      // the fallback happens to pick.
      expect(t.pool.some((e) => e.minLevel <= 1), `${t.id} has a base form`).toBe(true);
      for (const e of t.pool) {
        expect(e.minLevel, `${t.id}/${e.key} gate`).toBeGreaterThanOrEqual(1);
        expect(e.minLevel, `${t.id}/${e.key} gate`).toBeLessThanOrEqual(100);
      }
      // No duplicate keys inside one pool — a duplicate is a wasted slot the
      // matcher can never use twice anyway.
      const keys = t.pool.map((e) => e.key);
      expect(new Set(keys).size, `${t.id} distinct species`).toBe(keys.length);
      // SPAN is the property that makes trainer choice flavour rather than
      // difficulty: the pool has to reach from an early-game body to a
      // fully-evolved one, or this trainer can only ever be a joke or a wall.
      const bsts = keys.map(bstOf);
      expect(Math.min(...bsts), `${t.id} weakest`).toBeLessThanOrEqual(350);
      expect(Math.max(...bsts), `${t.id} strongest`).toBeGreaterThanOrEqual(440);
    }
  });

  it("only uses species the simulator knows AND whose key survives the client's normalisation", () => {
    for (const key of allSpecies) {
      expect(DEX.species.get(toID(key)).exists, `${key} in sim dex`).toBe(true);
      // parseDetails in game/src/state/pvpBattleView.ts rebuilds the foe's
      // speciesKey with exactly this normalisation, then looks it up in
      // pokemonTable. A key that changes shape here renders as a blank sprite
      // with no type badges — which is why nidoranF / nidoranM / mrMime / hoOh
      // are deliberately excluded from the roster.
      expect(key.toLowerCase().replace(/[^a-z0-9]/g, ""), `${key} is case-stable`).toBe(key);
    }
  });

  // The half of the roster contract the server cannot import. game/src/data/
  // pokemon.ts is CLIENT code and nothing under server/src may import it — but a
  // TEST may READ it, and that turns "verified by hand once" into "fails if
  // anyone adds a species the client cannot draw". The client resolves a foe's
  // sprite through pokemonTable[speciesKey].id and its type badges through
  // pokemonTable[speciesKey]?.types, so a missing key is a blank hole in the
  // arena. `munchlax` was a real casualty of this check: it is the natural
  // low-level stand-in for Snorlax, it exists in the Gen-5 dex, and it is NOT in
  // the client table.
  it("only uses species game/src/data/pokemon.ts can actually draw", () => {
    const file = path.resolve(process.cwd(), "../game/src/data/pokemon.ts");
    let src: string;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      // A server-only checkout has no game/. Say so loudly rather than passing
      // silently, but do not fail a suite that cannot possibly know the answer.
      console.warn(`[pvpBot] SKIPPED client-sprite check: cannot read ${file}`);
      return;
    }
    const clientKeys = new Set(
      [...src.matchAll(/^\s{4}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]),
    );
    expect(clientKeys.size).toBeGreaterThan(200);
    for (const key of allSpecies) {
      expect(clientKeys.has(key), `${key} is in game/src/data/pokemon.ts`).toBe(true);
    }
  });

  it("gives every species at least one WORKING damaging move at every level, and never a denied one", () => {
    // The levels that matter: 5 is the production median party level, 2–3 is a
    // fresh starter, 80+ is the p90 tail.
    const denied = [
      "fling", "naturalgift", "frustration", "snore", "dreameater", "focuspunch",
      "lastresort", "bide", "counter", "mirrorcoat", "metalburst", "spitup",
      "trumpcard", "present", "beatup", "teleport",
      "flail", "reversal", "endeavor", "memento", "healingwish", "lunardance",
      "explosion", "selfdestruct", "hyperbeam", "gigaimpact", "blastburn",
      "hydrocannon", "frenzyplant", "rockwrecker", "roaroftime",
    ];
    const variable = new Set([
      "lowkick", "seismictoss", "magnitude", "nightshade", "dragonrage",
      "sonicboom", "superfang", "electroball", "gyroball", "grassknot",
      "heavyslam", "return", "psywave", "crushgrip", "wringout",
    ]);
    for (const key of allSpecies) {
      for (const level of [2, 3, 5, 10, 25, 50, 80, 100]) {
        const moves = movesFor(key, level);
        expect(moves.length, `${key} @${level} has moves`).toBeGreaterThan(0);
        expect(moves.length, `${key} @${level} at most four moves`).toBeLessThanOrEqual(4);
        expect(new Set(moves).size, `${key} @${level} no duplicate moves`).toBe(moves.length);
        const attacks = moves.filter((id) => {
          const m = DEX.moves.get(id);
          // "Working" means it can actually deal damage — a 0-BP move is only
          // an attack if it is one of the measured variable-power ones. Without
          // that distinction the generator happily picked Frustration, which
          // deals 1.
          return m.exists && m.category !== "Status"
            && (m.basePower > 0 || variable.has(m.id));
        });
        expect(attacks.length, `${key} @${level} has a damaging move (${moves.join(",")})`)
          .toBeGreaterThan(0);
        for (const id of moves) {
          expect(DEX.moves.get(id).exists, `${key} @${level} knows a real move: ${id}`).toBe(true);
          expect(denied, `${key} @${level} must not get ${id}`).not.toContain(id);
        }
      }
    }
  });

  // This used to assert the DESCENDING sort, i.e. [3,41,17] -> [41,17,3].
  // The sort was the bug: SIM_FORMAT_ID disables Team Preview, so turn 1 is
  // always the human's party slot 1 against the bot's slot 1, and sorting
  // pointed the bot's highest-level Pokémon at whatever the player happens to
  // lead with. Measured over all 1,069 production parties with >=2 Pokémon,
  // 18.8% opened against a bot lead >=10 levels above their own and 1.9%
  // >=50 levels — worst real case a Lv 14 lead facing Lv 100.
  it("mirrors the human's levels IN PARTY ORDER, clamps the team size, and survives junk", () => {
    const plan = buildBotTeam([{ level: 3 }, { level: 41 }, { level: 17 }], "hiker");
    expect(plan.team.map((m) => m.level)).toEqual([3, 41, 17]);
    expect(plan.trainerId).toBe("hiker");
    // The lead is the property that matters, on every shape of party.
    for (const party of [
      [{ level: 14 }, { level: 100 }],
      [{ level: 100 }, { level: 14 }],
      [{ level: 5 }, { level: 60 }, { level: 5 }, { level: 88 }],
    ]) {
      expect(buildBotTeam(party, "hiker").team[0].level).toBe(party[0].level);
    }
    // Never more than six, never fewer than one, never out of 1..100.
    expect(buildBotTeam(Array.from({ length: 9 }, () => ({ level: 50 }))).team).toHaveLength(6);
    expect(buildBotTeam([]).team).toHaveLength(1);
    expect(buildBotTeam([{ level: 0 }, { level: 999 }]).team.map((m) => m.level)).toEqual([1, 100]);
    expect(buildBotTeam([{ level: NaN }]).team[0].level).toBe(5);
    // An unknown trainer id falls back rather than throwing: refusing a
    // practice battle over a bad string is worse than fighting a Hiker.
    expect(BOT_TRAINERS.map((t) => t.id)).toContain(
      buildBotTeam([{ level: 10 }], "nope").trainerId,
    );
    // No held items and a neutral nature — 637 of 7,035 real party Pokémon
    // hold an item and the AI never does, an asymmetry left running in the
    // human's favour on purpose.
    for (const m of plan.team) {
      expect(m.heldItem).toBeNull();
      expect(m.nature).toBe("Hardy");
      expect(m.isShiny).toBe(false);
    }
  });
});

// ═══ 8b. POWER matching, not just level matching ═════════════════════════
// THE FINDING: pickTrainer was uniformly random over eight FIXED early-game
// rosters, so which trainer you rolled decided the battle. Measured on 2,309
// real production parties with the same brain on both sides (so a deviation
// from 50% is the team and nothing else): at max party level <=10 the Ace
// Trainer won 100% and the Bug Catcher 38%; at max party level >=60 the
// Youngster won 0% and the Bug Catcher 6%. The cases below pin the mechanism
// that fixed it — a pool matched per slot on offence / bulk / speed, with the
// bot's IVs and EV budget matched to the human Pokémon it is standing against.

describe("the AI is power-matched, not only level-matched", () => {
  const evTotal = (m: { evs: Record<string, number> }) =>
    Object.values(m.evs).reduce((a, b) => a + b, 0);

  it("never fields a 540-BST team against a Lv 7 party, whichever trainer is asked for", () => {
    // The exact case from the finding: a Lv 5-10 player who drew Ace Trainer AI
    // met level-matched Gyarados (540) / Snorlax (540) / Arcanine (555) with a
    // party whose own mean was 299.
    const party = [
      { level: 7, speciesKey: "charmander" },
      { level: 7, speciesKey: "pidgey" },
      { level: 5, speciesKey: "rattata" },
    ];
    for (const t of BOT_TRAINERS) {
      const plan = buildBotTeam(party, t.id);
      for (const m of plan.team) {
        expect(bstOf(m.speciesKey), `${t.id} fields ${m.speciesKey} at Lv 7`)
          .toBeLessThanOrEqual(400);
      }
    }
  });

  it("never fields a Lv 95 Kakuna against a Lv 95 party, whichever trainer is asked for", () => {
    // The other end of the same finding: a Lv 95 player drawing Bug Catcher AI
    // fought a Lv 95 Kakuna, BST 205, best move Bug Bite.
    const party = [
      { level: 95, speciesKey: "blastoise", moves: [{ id: "surf" }, { id: "icebeam" }] },
      { level: 95, speciesKey: "dragonite", moves: [{ id: "outrage" }] },
    ];
    for (const t of BOT_TRAINERS) {
      const plan = buildBotTeam(party, t.id);
      for (const m of plan.team) {
        expect(bstOf(m.speciesKey), `${t.id} fields ${m.speciesKey} at Lv 95`)
          .toBeGreaterThanOrEqual(390);
      }
    }
  });

  it("matches each slot to the human Pokémon in it, on a deliberately lopsided party", () => {
    const party = [
      { level: 90, speciesKey: "dragonite", moves: [{ id: "outrage" }] },
      { level: 90, speciesKey: "caterpie", moves: [{ id: "tackle" }] },
    ];
    const plan = buildBotTeam(party, "acetrainer");
    // Same level in both slots, so ONLY power can tell them apart — and it does.
    expect(plan.team.map((m) => m.level)).toEqual([90, 90]);
    expect(bstOf(plan.team[0].speciesKey)).toBeGreaterThan(bstOf(plan.team[1].speciesKey) + 100);
  });

  it("gates evolved forms by level, so a Lv 5 fight is between base forms", () => {
    // Even for a party the matcher would love to answer with a Golem: a Lv 5
    // 600-BST Pokémon must not summon one.
    const plan = buildBotTeam([{ level: 5, speciesKey: "dragonite" }], "hiker");
    expect(plan.team[0].level).toBe(5);
    const gate = BOT_TRAINERS.find((t) => t.id === "hiker")!.pool
      .find((e) => e.key === plan.team[0].speciesKey)!;
    expect(gate.minLevel).toBeLessThanOrEqual(5);
  });

  it("matches the bot's IVs and EV budget to the human's, in both directions", () => {
    const perfect = { hp: 31, attack: 31, defense: 31, spAttack: 31, spDefense: 31, speed: 31 };
    const average = { hp: 15, attack: 16, defense: 14, spAttack: 17, spDefense: 15, speed: 16 };
    const trained = { hp: 6, attack: 252, defense: 0, spAttack: 0, spDefense: 0, speed: 252 };

    // A perfect team meets a perfect bot.
    const vsPerfect = buildBotTeam([{ level: 80, speciesKey: "gengar", ivs: perfect }], "psychic");
    expect(vsPerfect.team[0].ivs.hp).toBe(31);
    // The production average (mean IV 15.7 over 7,035 party Pokémon) meets an
    // average bot. This is the gear advantage the flat-31 bot used to carry:
    // isolated by execution it was worth 17 points of win rate at Lv <=10.
    const vsAverage = buildBotTeam([{ level: 80, speciesKey: "gengar", ivs: average }], "psychic");
    expect(vsAverage.team[0].ivs.hp).toBeGreaterThanOrEqual(14);
    expect(vsAverage.team[0].ivs.hp).toBeLessThanOrEqual(17);
    expect(new Set(Object.values(vsAverage.team[0].ivs)).size).toBe(1);

    // EVs: budget only, spent the bot's own way, and never more than the human's.
    const vsTrained = buildBotTeam([{ level: 80, speciesKey: "gengar", evs: trained }], "psychic");
    expect(evTotal(vsTrained.team[0])).toBe(510);
    for (const v of Object.values(vsTrained.team[0].evs)) expect(v).toBeLessThanOrEqual(252);
    // An untrained human means an untrained bot.
    const vsUntrained = buildBotTeam([{ level: 80, speciesKey: "gengar" }], "psychic");
    expect(evTotal(vsUntrained.team[0])).toBe(0);
    // Absent IVs still read as perfect, which is what every other caller passes
    // and is the safe direction (equal to a perfect build, never better).
    expect(vsUntrained.team[0].ivs.speed).toBe(31);
  });

  it("opens the TM pool only as far as the human's own best move power", () => {
    // MEASURED: at max party level >=60 the human's best move averages 100 BP —
    // TMs they taught it — while a level-up pool mostly tops out in the 70s, and
    // that gap was most of why every trainer won 0-25% of high-level battles.
    const bp = (ids: string[]) => Math.max(...ids.map((id) => DEX.moves.get(id).basePower || 0));
    const levelUp = movesFor("snorlax", 90);              // bodyslam/crunch/heavyslam — 85
    expect(bp(movesFor("snorlax", 90, 120))).toBeGreaterThan(bp(levelUp));
    // …and NEVER past the human's own best. This is the whole safety property:
    // the top-up can close a gap and cannot open one. The bound is
    // max(cap, what levelling up already taught it) — the cap governs the TM
    // top-up, and a Machoke does not forget its own Cross Chop because the human
    // brought something weaker.
    for (const cap of [90, 100, 120, 140]) {
      for (const key of ["snorlax", "machoke"] as const) {
        const level = key === "snorlax" ? 90 : 74;
        const floor = bp(movesFor(key, level));
        expect(bp(movesFor(key, level, cap)), `${key} cap ${cap}`)
          .toBeLessThanOrEqual(Math.max(cap, floor));
      }
    }
    // A human with nothing special changes nothing: levelling up is still the
    // floor, and the bot is not clipped BELOW what its own level taught it.
    expect(movesFor("snorlax", 90, 40)).toEqual(levelUp);
    expect(movesFor("snorlax", 90, 60)).toEqual(levelUp);
    const plan = buildBotTeam(
      [{ level: 90, speciesKey: "snorlax", moves: [{ id: "tackle" }] }], "acetrainer",
    );
    expect(plan.team[0].speciesKey).toBe("snorlax");
    expect(plan.team[0].moves.map((m) => m.id)).toEqual(levelUp);
  });

  it("ranks trainers by fit and offers one that is neither over- nor under-matched", () => {
    const party = [
      { level: 40, speciesKey: "charizard", moves: [{ id: "flamethrower" }] },
      { level: 38, speciesKey: "gyarados", moves: [{ id: "surf" }] },
    ];
    const ranked = rankTrainers(party);
    expect(ranked).toHaveLength(8);
    // Sorted best-first, and every entry carries both axes the hub labels with.
    for (const r of ranked) {
      expect(Number.isFinite(r.fit)).toBe(true);
      expect(Number.isFinite(r.edge)).toBe(true);
    }
    expect(ranked[0].fit).toBeLessThanOrEqual(ranked[ranked.length - 1].fit);
    // The recommendation is a REAL fit: its team lands close to the party's own
    // build on the same profile the matcher uses.
    const plan = buildBotTeam(party, ranked[0].trainer.id);
    for (const [i, m] of plan.team.entries()) {
      const human = party[i];
      const match = { level: human.level, iv: 31, evTotal: 0, matchPower: 0 };
      const d = matchDistance(profileOf(m.speciesKey, match), profileOf(human.speciesKey, match));
      expect(d, `${m.speciesKey} vs ${human.speciesKey}`).toBeLessThan(1.2);
    }
  });

  it("honours an explicitly named trainer, so the hub's offer is never a lie", () => {
    // The hub says "Fight Hiker AI?" and passes that id back. If the server
    // substituted a better-fitting trainer, the offer would be a promise the
    // battle breaks.
    for (const t of BOT_TRAINERS) {
      const plan = buildBotTeam([{ level: 30, speciesKey: "pikachu" }], t.id);
      expect(plan.trainerId).toBe(t.id);
      expect(plan.label).toBe(t.label);
    }
    // And an unknown id falls back to the RECOMMENDATION rather than a random
    // roll or an error.
    const fallback = buildBotTeam([{ level: 30, speciesKey: "pikachu" }], "not-a-trainer");
    expect(BOT_TRAINERS.map((t) => t.id)).toContain(fallback.trainerId);
  });

  it("builds a six-Pokémon team fast enough to sit in a socket handler", () => {
    // The matcher runs (8 trainers x pool x 6 slots) profile comparisons and a
    // learnset walk per candidate. Before caching that measured 355 ms of
    // synchronous work per battle:bot, which is a third of a second of event
    // loop for every other live battle.
    const party = [
      { level: 88, speciesKey: "blastoise", moves: [{ id: "surf" }] },
      { level: 74, speciesKey: "pidgeot", moves: [{ id: "flystandard" }] },
      { level: 42, speciesKey: "rhydon", moves: [{ id: "earthquake" }] },
      { level: 5, speciesKey: "pikachu", moves: [{ id: "thunderShock" }] },
      { level: 60, speciesKey: "gengar", moves: [{ id: "shadowBall" }] },
      { level: 33, speciesKey: "parasect", moves: [{ id: "slash" }] },
    ];
    buildBotTeam(party);              // warm the per-species caches
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) buildBotTeam(party);
    const per = (performance.now() - t0) / 20;
    expect(per, `${per.toFixed(1)} ms per build`).toBeLessThan(60);
  });
});

// ═══ 9. Both tiers are real and both answer ══════════════════════════════

describe("difficulty tiers", () => {
  for (const tier of ["rookie", "trainer"] as BotTier[]) {
    it(`the ${tier} tier answers its requests and finishes a battle`, async () => {
      const h = makeHarness();
      const { room } = await liveBotBattle(h, { levels: [25], tier });
      await playToEnd(room);
      expect(room.status).toBe("completed");
      expect(room.b.movedAt).toBeGreaterThan(0);
      expectNothingRated();
    });
  }
});

// ═══ 10. Status moves are a LAST RESORT, at every level ══════════════════
//
// THE BUG THIS PINS, measured with the numbers that found it: chooseMove
// scored damaging moves as `power * eff * acc * stab * (atk / def)` where `atk`
// was our COMPUTED stat and `def` was the foe's BASE stat, then compared the
// product to a flat `STATUS_SCORE = 8`. Because the two sides of the ratio were
// different kinds of number, the product scaled with level — so below roughly
// Lv 20 every attack scored under 8 and a status move won.
//
// Over 100 full battles per level with the same trainer on both sides, the share
// of the bot's move decisions spent on a status move while a damaging move was
// legal and not type-immune was 49.7% at Lv 5, 31.6% at Lv 7 and 0.0% from
// Lv 25 up — 288 of the Lv-5 cases taken at or below 25% of its own HP. The
// production median party level is 5, so that was the MODAL bot battle: the bot
// used Harden about half its turns and read as broken software.
//
// Level-parameterised on purpose. A test at one level cannot catch a bug whose
// entire shape is "it only happens at low level", and the low levels are where
// the players are.
describe("the heuristic bot attacks instead of stalling, at every level", () => {
  /** Drive one real chooseMove and return the move id it answered with. */
  function askForMove(
    meSpecies: string, meMoves: string[], level: number, foeSpecies: string,
  ): string {
    let written = "";
    const stream = {
      write: (d: string) => { written = d; },
      destroy() { /* */ },
    } as never;
    const seat = createBotSeat(stream, "trainer", {});
    const me = DEX.species.get(toID(meSpecies));
    const foe = DEX.species.get(toID(foeSpecies));
    const stat = (base: number) => Math.floor(((2 * base + 31) * level) / 100) + 5;
    const hp = (base: number) => Math.floor(((2 * base + 31) * level) / 100) + level + 10;
    // The foe's switch-in is how the brain learns its species and level, from
    // the same shared protocol lines the human's client decodes.
    seat.receive(
      `|switch|p2a: Foe|${foe.name}, L${level}, M|${hp(foe.baseStats.hp)}/${hp(foe.baseStats.hp)}`,
    );
    seat.receive(`|request|${JSON.stringify({
      active: [{
        moves: meMoves.map((id) => {
          const md = DEX.moves.get(id);
          return {
            move: md.name, id: md.id, pp: md.pp, maxpp: md.pp,
            target: md.target, disabled: false,
          };
        }),
      }],
      side: {
        id: "p1", name: "Bot",
        pokemon: [{
          ident: "p1a: Me", details: `${me.name}, L${level}, M`,
          condition: `${hp(me.baseStats.hp)}/${hp(me.baseStats.hp)}`, active: true,
          stats: {
            atk: stat(me.baseStats.atk), def: stat(me.baseStats.def),
            spa: stat(me.baseStats.spa), spd: stat(me.baseStats.spd),
            spe: stat(me.baseStats.spe),
          },
          moves: meMoves.map((m) => toID(m)),
        }],
      },
    })}`);
    const slot = Number(/move (\d+)/.exec(written)?.[1] ?? 0);
    return slot > 0 ? toID(meMoves[slot - 1]) : written;
  }

  // Every one of these answered with the STATUS move at the low levels before
  // the fix — the exact pairs are on the record in lib/pvpBotBrain.ts.
  const CASES: [string, string[], string][] = [
    ["beedrill", ["poisonsting", "furyattack", "harden", "stringshot"], "weedle"],
    ["kakuna", ["poisonsting", "harden", "stringshot"], "charmander"],
    ["ekans", ["poisonsting", "wrap", "leer"], "pidgey"],
    ["poliwag", ["bubble", "watersport"], "squirtle"],
    ["geodude", ["tackle", "defensecurl", "mudsport"], "squirtle"],
    ["sandshrew", ["scratch", "defensecurl"], "charmander"],
  ];
  for (const level of [2, 3, 5, 7, 10, 15, 20, 30, 50, 80, 100]) {
    it(`never spends a Lv ${level} turn on a status move when an attack would land`, () => {
      for (const [me, moves, foe] of CASES) {
        const picked = askForMove(me, moves, level, foe);
        const md = DEX.moves.get(picked);
        expect(md.exists, `${me} L${level} answered with a real move (${picked})`).toBe(true);
        expect(
          md.category,
          `L${level} ${me} vs ${foe} chose ${md.name} over ${moves.filter((m) => DEX.moves.get(m).category !== "Status").join("/")}`,
        ).not.toBe("Status");
      }
    });
  }

  it("DOES fall back to a status move when every attack is type-immune", () => {
    // Normal into a Ghost is 0x, so there is genuinely nothing better and the
    // last-resort branch is the correct answer rather than a wasted turn.
    const picked = askForMove("rattata", ["tackle", "quickattack", "tailwhip"], 25, "gastly");
    expect(DEX.moves.get(picked).category).toBe("Status");
    expect(picked).toBe("tailwhip");
  });
});

// ═══ 11. The row guard is DOUBLE-KEYED, like the ELO guard ═══════════════
// FINDING: the PvpMatch-row guard read `!isBotRoom(room)` alone while the ELO
// guard read the format as well, so the two were not equally hard to defeat.
// With isBot absent and the format still "bot" a row WAS written — measured —
// and GET /pvp/me/history selects on participation with no format clause, so it
// would have entered the hub's LAST 10 pip tape and computeStreak.

describe("no PvpMatch row can escape on either key alone", () => {
  it("writes nothing when isBot is gone but the format still says bot", async () => {
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    // Corrupt exactly ONE of the two keys.
    delete room.b.isBot;
    expect(isBotRoom(room)).toBe(false);
    expect(room.format).toBe("bot");
    room.winnerId = HUMAN_ID;
    room.loserId = "bot:whatever";
    await endBattle(room, h.send, "ko");
    await vi.advanceTimersByTimeAsync(50);
    expectNothingRated();
  });

  it("writes nothing when the format is gone but isBot is still set", async () => {
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    room.format = "random50";
    expect(isBotRoom(room)).toBe(true);
    room.winnerId = HUMAN_ID;
    room.loserId = "bot:whatever";
    await endBattle(room, h.send, "ko");
    await vi.advanceTimersByTimeAsync(50);
    expectNothingRated();
  });

  it("CONTROL: a real random50 room with neither key still writes its row", async () => {
    const h = makeHarness(["uA", "uB"]);
    const room: BattleRoom = {
      id: "b_ctl1", status: "invited", format: "random50",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: {
        userId: "uA", username: "Alice", stream: null, request: null, connected: true,
        team: [{ speciesKey: "pikachu", name: "P", level: 50, moves: [{ id: "thunderShock" }] }] as never,
      },
      b: {
        userId: "uB", username: "Bob", stream: null, request: null, connected: true,
        team: [{ speciesKey: "bulbasaur", name: "B", level: 50, moves: [{ id: "tackle" }] }] as never,
      },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(room.id, room);
    await startBattle(io, room, h.send);
    await vi.advanceTimersByTimeAsync(0);
    room.winnerId = "uA";
    room.loserId = "uB";
    await endBattle(room, h.send, "ko");
    await vi.advanceTimersByTimeAsync(50);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].format).toBe("random50");
    expect(db.transaction).toHaveBeenCalled();
    tearDown(room);
  });
});

// ═══ 12. applyChoice cannot kill the process, and cannot be spammed ══════

describe("applyChoice is guarded and its clock credit is bounded", () => {
  it("answers an error instead of THROWING when the stream died under it", async () => {
    // FINDING: the write was unguarded, and the two checks in front of it are not
    // sufficient — a destroyed-but-not-nulled stream passes both `status ===
    // "active"` and `room.stream != null`. Measured: this threw "Push after end
    // of read stream" straight out of a socket.io event handler, which is an
    // uncaught exception and takes every other live battle down with the process.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    // A stream whose write throws is EXACTLY the state a destroyed one is in —
    // `writing to a destroyed player stream throws SYNCHRONOUSLY` above pins that
    // mechanism against the real simulator. Substituting it here reproduces the
    // hazard without leaving a half-destroyed @pkmn/sim battle to push errors
    // into the pumps for the rest of the run.
    const real = room.stream!;
    room.stream = {
      write: () => { throw new Error("Push after end of read stream"); },
      destroy: () => real.destroy(),
    };
    // The room still LOOKS live, which is the whole point: status "active" and a
    // non-null stream pass both of applyChoice's checks.
    expect(room.status).toBe("active");
    expect(room.stream).not.toBeNull();
    // Captured rather than assumed null: the human has already made one real
    // choice by now — the Team Preview answer — so `answeredSeq` is legitimately
    // set before the poisoned write. The property under test is that the FAILED
    // write does not advance it, and a before/after comparison states that
    // directly instead of relying on the player never having chosen.
    const creditedBefore = room.a.answeredSeq ?? null;
    const clockBefore = room.lastChoiceAt;
    let threw: unknown = null;
    let result: { ok: boolean; error?: string } | null = null;
    try {
      result = applyChoice(room, HUMAN_ID, "default");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
    expect(result?.ok).toBe(false);
    // The clock is NOT credited for a write that never landed.
    expect(room.a.answeredSeq ?? null).toBe(creditedBefore);
    expect(room.lastChoiceAt).toBe(clockBefore);
    await endBattle(room, h.send, "cancelled");
  });

  it("credits the turn clock ONCE per request, so a re-sent choice cannot hold a room open", async () => {
    // FINDING: every accepted write re-stamped lastChoiceAt, including a
    // duplicate for a turn the simulator had already answered. Measured: the
    // duplicate acked ok and pushed the clock forward by the full 5,399 ms gap,
    // and 30 simulated minutes of re-sent choices into a frozen board left the
    // room "active" — holding a simulator and both players' battle slot forever.
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25, 25] });
    await vi.advanceTimersByTimeAsync(0);

    const seqBefore = room.a.requestSeq ?? 0;
    expect(seqBefore).toBeGreaterThan(0);          // the simulator asked us something
    // Park the AI so the only thing that can move the clock is the human. (The
    // bot stamps through the same creditChoice when it answers its own request,
    // which is what keeps the AFK watchdog from crowning an idle human.)
    if (room.b.botTimer) clearTimeout(room.b.botTimer);
    room.b.botTimer = null;
    room.b.bot = null;
    expect(applyChoice(room, HUMAN_ID, "default").ok).toBe(true);
    const clockAfterFirst = room.lastChoiceAt;
    const movedAfterFirst = room.a.movedAt;

    // A duplicate for the SAME request buys nothing, however many times it comes.
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < 5; i++) {
      expect(applyChoice(room, HUMAN_ID, "default").ok).toBe(true);
    }
    expect(room.lastChoiceAt).toBe(clockAfterFirst);
    expect(room.a.movedAt).toBe(movedAfterFirst);
    expect(room.a.answeredSeq).toBe(room.a.requestSeq);

    // A NEW request re-opens the credit — a long real battle is unaffected.
    await vi.advanceTimersByTimeAsync(2_000);
    room.a.requestSeq = (room.a.requestSeq ?? 0) + 1;
    expect(applyChoice(room, HUMAN_ID, "default").ok).toBe(true);
    expect(room.lastChoiceAt).toBeGreaterThan(clockAfterFirst);
    await endBattle(room, h.send, "cancelled");
  });

  it("a client re-sending into a frozen board still times out on the turn clock", async () => {
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [50] });
    await vi.advanceTimersByTimeAsync(0);
    // Freeze the board: the AI seat stops answering, so no new request can
    // arrive for the human either.
    if (room.b.botTimer) clearTimeout(room.b.botTimer);
    room.b.botTimer = null;
    room.b.bot = null;
    // Now hammer it the way a retrying client would.
    for (let i = 0; i < 40 && room.status === "active"; i++) {
      applyChoice(room, HUMAN_ID, "default");
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(room.status).not.toBe("active");
    expect(room.endReason).toBe("timeout");
    expectNothingRated();
  });
});

// ═══ 13. The AI seat is not a caller ═════════════════════════════════════
// FINDING: applyChoice refused a choice aimed at the AI seat, but resolveRejoin,
// resolveSync and snapshotForSide had no such guard — measured,
// resolveRejoin("bot:<battleId>") returned ok:true with a snapshot carrying the
// AI's own |request| payload, and the no-id discovery path found the bot's own
// battle for it. Unreachable in production (a userId comes only from
// auth.api.getSession and a cuid has no colon) — defence in depth, and the
// asymmetry with applyChoice was the actual defect.

describe("nothing hands a battle to the AI's own seat", () => {
  it("refuses rejoin, sync, snapshot and discovery for the bot userId", async () => {
    const h = makeHarness();
    const { room, botId } = await liveBotBattle(h, { levels: [25] });
    await vi.advanceTimersByTimeAsync(0);
    // The seat really is a side of the room, and really does hold a request.
    expect(room.b.userId).toBe(botId);
    expect(room.b.request).not.toBeNull();

    expect(resolveRejoin(botId, room.id)).toEqual({ ok: false, reason: "not_in_battle" });
    expect(resolveSync(botId, room.id)).toEqual({ ok: false, reason: "gone" });
    expect(snapshotForSide(room, botId)).toBeNull();
    expect(resolveRejoin(botId)).toEqual({ ok: false, reason: "not_in_battle" });
    // …and the HUMAN is unaffected.
    const mine = resolveRejoin(HUMAN_ID, room.id);
    expect(mine.ok).toBe(true);
    await endBattle(room, h.send, "cancelled");
  });
});

// ═══ 14. A practice battle must not bench the rated queue ════════════════
// FINDING: "already in a battle" is checked against battleRooms, so an abandoned
// practice battle benched its player from the rated queue, from invites and from
// tournament pairings — measured at 345,000 ms when a second tab kept them
// present so no reconnect grace ever started.

describe("a practice battle never blocks a real one", () => {
  it("releaseBotBattlesFor ends the practice battle and frees the slot", async () => {
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    expect(room.status).toBe("active");
    const ended = releaseBotBattlesFor(HUMAN_ID, h.send);
    expect(ended).toEqual([room.id]);
    // Unrated, unrecorded, and no winner: they LEFT a practice battle, they did
    // not lose one.
    expect(room.status).toBe("cancelled");
    expect(room.winnerId ?? null).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expectNothingRated();
    // Idempotent, and it never touches anything else.
    expect(releaseBotBattlesFor(HUMAN_ID, h.send)).toEqual([]);
  });

  it("touches nobody else's battle, and no rated battle at all", async () => {
    const h = makeHarness(["uA", "uB"]);
    const rated: BattleRoom = {
      id: "b_rated1", status: "invited", format: "random50",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: {
        userId: HUMAN_ID, username: HUMAN_NAME, stream: null, request: null, connected: true,
        team: [{ speciesKey: "pikachu", name: "P", level: 50, moves: [{ id: "thunderShock" }] }] as never,
      },
      b: {
        userId: "uB", username: "Bob", stream: null, request: null, connected: true,
        team: [{ speciesKey: "bulbasaur", name: "B", level: 50, moves: [{ id: "tackle" }] }] as never,
      },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(rated.id, rated);
    await startBattle(io, rated, h.send);
    await vi.advanceTimersByTimeAsync(0);
    // Someone else's practice battle, with the same shape.
    const other = botRoom({ levels: [25] });
    other.room.a.userId = "uOther";
    await startBattle(io, other.room, h.send);
    await vi.advanceTimersByTimeAsync(0);

    expect(releaseBotBattlesFor(HUMAN_ID, h.send)).toEqual([]);
    expect(rated.status).toBe("active");
    expect(other.room.status).toBe("active");
    tearDown(rated);
    tearDown(other.room);
  });

  it("gives a bot room a much shorter turn clock, and tells the client the truth", async () => {
    const h = makeHarness();
    const { room } = await liveBotBattle(h, { levels: [25] });
    expect(turnTimeoutFor(room)).toBe(BOT_TURN_TIMEOUT_MS);
    expect(BOT_TURN_TIMEOUT_MS).toBeLessThan(TURN_TIMEOUT_MS);
    expect(BOT_WATCHDOG_POLL_MS).toBeLessThan(WATCHDOG_POLL_MS);
    // The deadline the client renders is the one the watchdog enforces — a
    // shorter clock with a five-minute countdown on screen would be a lie.
    const state = h.events.filter((e) => e.event === "battle:state").at(-1)!;
    expect(state.payload.turnDeadlineAt).toBe(room.lastChoiceAt + BOT_TURN_TIMEOUT_MS);
    const snap = snapshotForSide(room, HUMAN_ID)!;
    expect(snap.turnDeadlineAt).toBe(room.lastChoiceAt + BOT_TURN_TIMEOUT_MS);

    // And it really is reclaimed on that clock rather than the rated one.
    await vi.advanceTimersByTimeAsync(BOT_TURN_TIMEOUT_MS + BOT_WATCHDOG_POLL_MS * 2);
    expect(room.status).toBe("completed");
    expect(room.endReason).toBe("timeout");
    expectNothingRated();
  });

  it("CONTROL: a rated room keeps the full five-minute clock", async () => {
    const h = makeHarness(["uA", "uB"]);
    const room: BattleRoom = {
      id: "b_rated2", status: "invited", format: "random50",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: {
        userId: "uA", username: "Alice", stream: null, request: null, connected: true,
        team: [{ speciesKey: "pikachu", name: "P", level: 50, moves: [{ id: "thunderShock" }] }] as never,
      },
      b: {
        userId: "uB", username: "Bob", stream: null, request: null, connected: true,
        team: [{ speciesKey: "bulbasaur", name: "B", level: 50, moves: [{ id: "tackle" }] }] as never,
      },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(room.id, room);
    await startBattle(io, room, h.send);
    await vi.advanceTimersByTimeAsync(0);
    expect(turnTimeoutFor(room)).toBe(TURN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(BOT_TURN_TIMEOUT_MS + BOT_WATCHDOG_POLL_MS * 2);
    expect(room.status).toBe("active");
    tearDown(room);
  });
});

// ═══ 15. isBot is unforgeable — an EXECUTED audit of the source ══════════
// The two rating guards are only as good as "nothing can write these fields",
// so that claim gets a test rather than a paragraph. Reads src/ off disk; no
// import, no mocking, and it fails the day someone adds a second writer.

describe("the rating guards cannot be reached from a payload", () => {
  const srcFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...srcFiles(full));
      else if (e.name.endsWith(".ts")) out.push(full);
    }
    return out;
  };
  const files = srcFiles(path.resolve(process.cwd(), "src"));

  it("has exactly one site that writes isBot, and it is a literal", () => {
    expect(files.length).toBeGreaterThan(10);
    const writes: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const line of text.split("\n")) {
        // `isBot: x` (object literal member) or `isBot = x` (assignment), but
        // NOT `isBot === x` / `isBot !== x`, which are reads, and not the
        // declaration `isBot?:` or a comment.
        if (/\bisBot\s*(:|=(?!=))\s*/.test(line) && !/^\s*(\*|\/\/)/.test(line) && !/isBot\?:/.test(line)) {
          writes.push(`${path.basename(f)}: ${line.trim()}`);
        }
      }
    }
    // One writer only, and it is the constant `true` inside battle:bot's room
    // literal — not a value taken from anywhere.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/isBot:\s*true/);
    expect(writes[0]).toMatch(/^socket\.ts:/);
  });

  it("never reassigns room.format after construction, and never spreads client data into a side", () => {
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(/\broom\.format\s*=(?!=)/.test(text), `${path.basename(f)} reassigns room.format`).toBe(false);
    }
    // The side-spread check is scoped to the files that actually CONSTRUCT a
    // BattleRoom — a `a: { ...x }` anywhere else (bracket.ts builds tournament
    // pairings with the same field names) is a different thing entirely.
    const builders = files.filter((f) => /:\s*BattleRoom\s*=\s*\{/.test(fs.readFileSync(f, "utf8")));
    expect(builders.length).toBeGreaterThanOrEqual(2);
    for (const f of builders) {
      const text = fs.readFileSync(f, "utf8");
      expect(/\b[ab]:\s*\{\s*\.\.\./.test(text), `${path.basename(f)} spreads into a side`).toBe(false);
    }
  });

  it("has exactly one caller of applyEloUpdate and one PvpMatch write", () => {
    const pvp = fs.readFileSync(path.resolve(process.cwd(), "src/pvp.ts"), "utf8");
    const callers: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      for (const line of text.split("\n")) {
        if (/applyEloUpdate\(/.test(line) && !/export async function|^\s*\*/.test(line)) {
          callers.push(`${path.basename(f)}: ${line.trim()}`);
        }
      }
    }
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatch(/^pvp\.ts:/);
    // The row write is inside the double-keyed guard.
    expect(pvp).toContain('if (!botMatch && room.format !== "bot") {');
    const rowWrites = files.filter((f) => /prisma\.pvpMatch\s*\n?\s*\.?\s*create/.test(fs.readFileSync(f, "utf8")));
    expect(rowWrites.map((f) => path.basename(f))).toEqual(["pvp.ts"]);
  });

  it("a hostile trainer id cannot poison anything or escape the AI label", () => {
    for (const hostile of ["__proto__", "constructor", "prototype", "toString", "", "x".repeat(500)]) {
      const before = Object.getOwnPropertyNames(Object.prototype).join(",");
      const plan = buildBotTeam([{ level: 10, speciesKey: "pikachu" }], hostile);
      expect(BOT_TRAINERS.map((t) => t.id)).toContain(plan.trainerId);
      expect(plan.label).toMatch(/ AI$/);
      expect(Object.getOwnPropertyNames(Object.prototype).join(",")).toBe(before);
    }
  });
});
