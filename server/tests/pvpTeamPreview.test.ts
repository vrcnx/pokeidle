// Team Preview: the protocol, the auto-lock, and the information boundary.
//
// ─── The failure this file exists to make impossible ──────────────────────
//
// Team Preview shipped OFF for the whole life of PvP, and the reason is
// recorded in three places in the source: Custom Game ships it ON, the first
// |request| a player gets is `{"teamPreview":true}` with no active slot and no
// moves, no client could answer that, and every battle sat until the 5-minute
// AFK watchdog forfeited it. Turning the clause back on without an answer for
// that is not a regression, it is an outage — every battle, every format.
//
// So this file measures three things, none of which is asserted from memory:
//
//   1. THE PROTOCOL. What the simulator actually sends, what choice strings it
//      actually accepts, and what it refuses. Section 1 runs real battles.
//   2. THE AUTO-LOCK. That it starts a battle nobody answered, that it does NOT
//      overwrite a lead somebody DID pick (with the negative control that
//      proves the naive version does), and that it cannot fire outside the
//      phase.
//   3. THE PAYLOAD. That the |request| is one-sided and the `|poke|` lines carry
//      species/level/gender and nothing else — measured against a canary
//      Pokemon built out of exactly the things that must not cross.
//
// DB stubbing follows pvp.test.ts: vi.mock replaces ../src/db.js so nothing here
// can construct a PrismaClient. Nothing imports ../src/socket.js.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: {
    pvpMatch: { create: vi.fn(async () => ({})) },
    playerRating: { upsert: vi.fn(async () => ({ rating: 1000, peakRating: 1000 })), update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async () => ({ aDelta: 0, bDelta: 0, aRating: 0, bRating: 0 })),
    $executeRaw: vi.fn(async () => 1),
  },
}));

import { BattleStreams, Teams } from "@pkmn/sim";
import { simFormatId } from "../src/lib/pvpFormat.js";
import {
  TEAM_PREVIEW_LOCK_MS,
  isTeamPreviewRequest,
  parsePokeLine,
  redactPreviewItems,
} from "../src/lib/pvpTeamPreview.js";
import {
  adaptTeamForSimulator,
  applyChoice,
  battleRooms,
  endBattle,
  isAwaitingTeamPreview,
  resolveRejoin,
  resolveTeamPreviewLock,
  startBattle,
  turnDeadlineFor,
  type BattleRoom,
} from "../src/pvp.js";

const io = { to: () => ({ emit: () => {} }) } as never;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The format string production ships, read through simFormatId so this file
 *  cannot drift from the thing it is guarding. */
const PROD_FORMAT = simFormatId(true);

// ══ Section 0 · the pure module ═══════════════════════════════════════════

describe("lib/pvpTeamPreview — the pure half", () => {
  it("recognises a preview request and nothing else", () => {
    expect(isTeamPreviewRequest({ teamPreview: true, side: {} })).toBe(true);
    expect(isTeamPreviewRequest({ teamPreview: false })).toBe(false);
    expect(isTeamPreviewRequest({ active: [{ moves: [] }] })).toBe(false);
    // Nothing coerced: a truthy non-`true` must not pass, or a payload shape
    // change would silently turn every request into a preview request.
    expect(isTeamPreviewRequest({ teamPreview: 1 })).toBe(false);
    expect(isTeamPreviewRequest({ teamPreview: "yes" })).toBe(false);
    expect(isTeamPreviewRequest(null)).toBe(false);
    expect(isTeamPreviewRequest(undefined)).toBe(false);
    expect(isTeamPreviewRequest("teamPreview")).toBe(false);
  });

  it("parses a |poke| line into its three fields", () => {
    expect(parsePokeLine("|poke|p1|Pikachu, L50, F|item"))
      .toEqual({ side: "p1", details: "Pikachu, L50, F", item: "item" });
    expect(parsePokeLine("|poke|p2|Snorlax, L50, M|"))
      .toEqual({ side: "p2", details: "Snorlax, L50, M", item: "" });
    expect(parsePokeLine("|switch|p1a: X|Pikachu, L50, F|110/110")).toBeNull();
    expect(parsePokeLine("|teampreview")).toBeNull();
    expect(parsePokeLine("")).toBeNull();
  });

  it("strips the held-item flag, and leaves everything else byte-identical", () => {
    const chunk = [
      "|clearpoke",
      "|poke|p1|Pikachu, L50, F|item",
      "|poke|p1|Snorlax, L50, M|",
      "|poke|p2|Skarmory, L50, M|item",
      "|teampreview",
    ].join("\n");
    expect(redactPreviewItems(chunk)).toBe([
      "|clearpoke",
      "|poke|p1|Pikachu, L50, F|",
      "|poke|p1|Snorlax, L50, M|",
      "|poke|p2|Skarmory, L50, M|",
      "|teampreview",
    ].join("\n"));
    // A redacted line is INDISTINGUISHABLE from an honestly item-less one —
    // both end in a bare trailing pipe — so "this one was censored" is not
    // itself a signal.
    expect(redactPreviewItems("|poke|p1|Pikachu, L50, F|item"))
      .toBe(redactPreviewItems("|poke|p1|Pikachu, L50, F|"));
  });

  it("returns the same object for a chunk with nothing to redact", () => {
    // The overwhelmingly common case: every chunk after the preamble. Identity
    // rather than equality, so the hot path is proven not to allocate.
    const battle = "|move|p1a: X|Thunderbolt|p2a: Y\n|-damage|p2a: Y|100/155";
    expect(redactPreviewItems(battle)).toBe(battle);
    const itemless = "|poke|p1|Pikachu, L50, F|";
    expect(redactPreviewItems(itemless)).toBe(itemless);
  });

  it("keeps the lock short enough that the AFK watchdog can never be the resolver", () => {
    // The phase is resolved by its own deadline, never by the 5-minute turn
    // watchdog — that watchdog forfeiting somebody is the original outage.
    expect(TEAM_PREVIEW_LOCK_MS).toBeGreaterThan(5_000);
    expect(TEAM_PREVIEW_LOCK_MS).toBeLessThanOrEqual(30_000);
  });
});

// ══ Section 1 · the protocol, measured against the real simulator ═════════
// Straight at @pkmn/sim, no pvp.ts: the question here is what the SIMULATOR
// does, and routing through our own module would only add a layer that could
// swallow the answer.

interface Probe {
  started: boolean;
  p1: string[];
  p2: string[];
  omni: string[];
  write: (s: string) => void;
  battle: { requestState?: string; sides?: readonly { id?: string; isChoiceDone?: () => boolean }[] };
  destroy: () => void;
}

const packed = (team: unknown[]) =>
  Teams.pack(adaptTeamForSimulator(team as never).sets as never);

const mon = (nickname: string, speciesKey: string, extra: Record<string, unknown> = {}) => ({
  speciesKey, nickname, level: 50, moves: [{ id: "tackle" }], ...extra,
});

const SIX_A = [
  mon("A1", "pikachu"), mon("A2", "snorlax"), mon("A3", "gengar"),
  mon("A4", "machamp"), mon("A5", "lapras"), mon("A6", "arcanine"),
];
const SIX_B = [
  mon("B1", "charizard"), mon("B2", "blastoise"), mon("B3", "venusaur"),
  mon("B4", "alakazam"), mon("B5", "dragonite"), mon("B6", "tyranitar"),
];

async function probe(a = SIX_A, b = SIX_B): Promise<Probe> {
  const stream = new BattleStreams.BattleStream();
  const ps = BattleStreams.getPlayerStreams(stream);
  const out = { p1: [] as string[], p2: [] as string[], omni: [] as string[] };
  const pump = async (s: AsyncIterable<string>, into: string[]) => {
    try { for await (const c of s) for (const l of c.split("\n")) if (l) into.push(l); }
    catch { /* the destroy at the end of a test */ }
  };
  void pump(ps.p1, out.p1);
  void pump(ps.p2, out.p2);
  void pump(ps.omniscient, out.omni);
  stream.write([
    `>start {"formatid":${JSON.stringify(PROD_FORMAT)},"seed":[4,3,2,1]}`,
    `>player p1 {"name":"Alice","team":${JSON.stringify(packed(a))}}`,
    `>player p2 {"name":"Bob","team":${JSON.stringify(packed(b))}}`,
  ].join("\n"));
  await settle(140);
  return {
    ...out,
    get started() { return out.omni.some((l) => l === "|start"); },
    write: (s: string) => stream.write(s),
    battle: (stream as unknown as { battle: Probe["battle"] }).battle,
    destroy: () => { try { stream.destroy(); } catch { /* already gone */ } },
  } as Probe;
}

const lead = (p: Probe, side: "p1" | "p2") =>
  p.omni.find((l) => l.startsWith(`|switch|${side}a:`))?.split("|")[2]?.split(": ")[1] ?? null;
const errorsOn = (lines: string[]) => lines.filter((l) => l.startsWith("|error|"));
const firstRequest = (lines: string[]) => {
  const l = lines.find((x) => x.startsWith("|request|"));
  return l ? JSON.parse(l.slice("|request|".length)) : null;
};

describe("the Team Preview protocol, as the simulator actually speaks it", () => {
  it("opens the phase with clearpoke / poke / teampreview and a one-sided request", async () => {
    const p = await probe();
    // The preamble, in order.
    expect(p.p1).toContain("|clearpoke");
    expect(p.p1).toContain("|teampreview");
    expect(p.p1.indexOf("|clearpoke")).toBeLessThan(p.p1.indexOf("|teampreview"));
    // Both sides' rosters, twelve lines, on BOTH streams — this is the shared
    // channel, and it is the only thing that crosses.
    const pokes = p.p1.filter((l) => l.startsWith("|poke|"));
    expect(pokes).toHaveLength(12);
    expect(p.p2.filter((l) => l.startsWith("|poke|"))).toEqual(pokes);
    expect(pokes[0]).toBe("|poke|p1|Pikachu, L50, F|");
    // The battle has NOT started: no |start, no |turn|, no |teamsize|.
    expect(p.started).toBe(false);
    expect(p.p1.some((l) => l.startsWith("|turn|"))).toBe(false);
    expect(p.p1.some((l) => l.startsWith("|teamsize|"))).toBe(false);
    // The request is a preview request with no active slot and no moves.
    const rq = firstRequest(p.p1);
    expect(rq.teamPreview).toBe(true);
    expect(rq.active).toBeUndefined();
    expect(p.battle.requestState).toBe("teampreview");
    p.destroy();
  }, 20_000);

  it("accepts `team <slot>` and leads with that slot", async () => {
    const p = await probe();
    p.write(">p1 team 3");
    p.write(">p2 team 1");
    await settle(200);
    expect(p.started).toBe(true);
    expect(lead(p, "p1")).toBe("A3");
    expect(lead(p, "p2")).toBe("B1");
    expect(errorsOn(p.p1)).toEqual([]);
    // The rest of the team keeps its relative order behind the chosen lead —
    // which is why the client only has to send a lead, not a permutation.
    const rq = JSON.parse(p.p1.filter((l) => l.startsWith("|request|")).pop()!.slice("|request|".length));
    expect(rq.side.pokemon.map((m: { ident: string }) => m.ident.split(": ")[1]))
      .toEqual(["A3", "A1", "A2", "A4", "A5", "A6"]);
    p.destroy();
  }, 20_000);

  it("accepts `default` and a full permutation, in both spellings", async () => {
    for (const [choice, expected] of [
      ["default", "A1"],
      ["team 231456", "A2"],
      ["team 2, 3, 1", "A2"],
      ["team 6", "A6"],
    ] as const) {
      const p = await probe();
      p.write(`>p1 ${choice}`);
      p.write(">p2 default");
      await settle(200);
      expect(p.started, `"${choice}" did not start the battle`).toBe(true);
      expect(lead(p, "p1"), `"${choice}" led with the wrong slot`).toBe(expected);
      expect(errorsOn(p.p1)).toEqual([]);
      p.destroy();
    }
  }, 40_000);

  it("refuses an out-of-range slot, a duplicate, and every non-team choice", async () => {
    for (const [choice, fragment] of [
      ["team 7", "You do not have a Pokémon in slot 7"],
      ["team 0", "You do not have a Pokémon in slot 0"],
      ["team 1,1,2", "can only switch in once"],
      ["move 1", "You need a teampreview response"],
      ["switch 2", "You need a teampreview response"],
      ["pass", "Not a move or switch request"],
    ] as const) {
      const p = await probe();
      p.write(`>p1 ${choice}`);
      p.write(">p2 default");
      await settle(200);
      expect(p.started, `"${choice}" was accepted and should not have been`).toBe(false);
      expect(errorsOn(p.p1).join(" "), `"${choice}" produced the wrong error`).toContain(fragment);
      // A refusal leaves the side UNLOCKED, which is what makes the auto-lock's
      // isChoiceDone sweep able to rescue it.
      expect(p.battle.sides![0].isChoiceDone!()).toBe(false);
      p.destroy();
    }
  }, 40_000);

  it("lets a player change their mind: a second `team` overwrites the first", async () => {
    const p = await probe();
    p.write(">p1 team 1");
    await settle(60);
    expect(p.battle.sides![0].isChoiceDone!()).toBe(true);
    p.write(">p1 team 4");
    await settle(60);
    p.write(">p2 default");
    await settle(200);
    expect(lead(p, "p1")).toBe("A4");
    p.destroy();
  }, 20_000);

  it("reports per-side lock state, which is the only way to know who has answered", async () => {
    // The simulator publishes NO acknowledgement for an accepted choice — only
    // an |error| for a refused one — so "did this side answer" cannot be derived
    // from the stream. `isChoiceDone()` is the authority, and the auto-lock is
    // built on it.
    const p = await probe();
    expect(p.battle.sides!.map((s) => s.isChoiceDone!())).toEqual([false, false]);
    p.write(">p1 team 2");
    await settle(80);
    expect(p.battle.sides!.map((s) => s.isChoiceDone!())).toEqual([true, false]);
    p.destroy();
  }, 20_000);

  it("NEGATIVE CONTROL: a blind `default` sweep clobbers a lead the player chose", async () => {
    // This is the bug the auto-lock is written around, reproduced so the guard
    // above it is not decoration. p1 picks Machamp; a sweep that writes
    // `default` to BOTH sides sends out Pikachu instead.
    const naive = await probe();
    naive.write(">p1 team 4");
    await settle(80);
    naive.write(">p1 default");
    naive.write(">p2 default");
    await settle(200);
    expect(naive.started).toBe(true);
    expect(lead(naive, "p1")).toBe("A1");        // ← the clobber
    naive.destroy();

    // The shipped rule — sweep only sides that are not done — preserves it.
    const guarded = await probe();
    guarded.write(">p1 team 4");
    await settle(80);
    for (const s of guarded.battle.sides!) {
      if (!s.isChoiceDone!()) guarded.write(`>${s.id} default`);
    }
    await settle(200);
    expect(guarded.started).toBe(true);
    expect(lead(guarded, "p1")).toBe("A4");      // ← the choice survives
    expect(lead(guarded, "p2")).toBe("B1");      // ← the absent side gets identity
    guarded.destroy();
  }, 30_000);
});

// ══ Section 2 · the information boundary ══════════════════════════════════

/** A Pokemon built entirely out of things Team Preview must NOT reveal. Every
 *  token below is checked by name against the opponent's whole payload. */
const CANARY_TOKENS = [
  "ACANARY", "rockyHelmet", "Rocky Helmet", "rockyhelmet",
  "ironBarbs", "Iron Barbs", "ironbarbs",
  "gyroBall", "Gyro Ball", "gyroball",
  "leechSeed", "Leech Seed", "leechseed",
];

/** A canary Pokemon built entirely out of things Team Preview must not reveal.
 *  Ferrothorn holds Rocky Helmet, so the simulator's own `|poke|` line carries
 *  the held-item marker — which is the one thing the raw protocol reveals
 *  beyond species, and the thing the server strips. */
const CANARY_TEAM = [
  mon("ACANARY", "ferrothorn", {
    ability: "ironBarbs",
    heldItem: "rockyHelmet",
    isShiny: true,
    moves: [{ id: "gyroBall" }, { id: "leechSeed" }],
    ivs: { hp: 3, attack: 2, defense: 1, spAttack: 30, spDefense: 29, speed: 28 },
    evs: { hp: 252, attack: 0, defense: 232, spAttack: 0, spDefense: 24, speed: 0 },
  }),
  mon("A2", "snorlax"),
];
const PLAIN_TEAM = [mon("B1", "charizard"), mon("B2", "blastoise")];

describe("what a side may learn about the other, measured on the payload itself", () => {
  it("puts NOTHING about the opponent in the |request| — it is entirely one-sided", async () => {
    const p = await probe(CANARY_TEAM, PLAIN_TEAM);
    const rq2 = firstRequest(p.p2);
    expect(rq2.teamPreview).toBe(true);
    // Two keys. Not a subset check: a future simulator field carrying anything
    // about the other side has to fail here rather than be waved through.
    expect(Object.keys(rq2).sort()).toEqual(["side", "teamPreview"]);
    expect(rq2.side.id).toBe("p2");
    const rq2Json = JSON.stringify(rq2);
    for (const token of [...CANARY_TOKENS, "p1"]) {
      expect(rq2Json, `p2's preview request leaked "${token}"`).not.toContain(token);
    }
    // Not passing by typo: every token IS reachable, on the canary's own side.
    const p1Json = JSON.stringify(firstRequest(p.p1));
    expect(p1Json).toContain("ACANARY");
    expect(p1Json).toContain("gyroball");
    expect(p1Json).toContain("rockyhelmet");
    p.destroy();
  }, 20_000);

  it("POSITIVE CONTROL: the raw simulator DOES publish a held-item marker", async () => {
    // The leak this closes, proved to exist before proving it is gone. Without
    // this the redaction test below would pass just as well against a
    // simulator that never emitted the flag at all.
    const p = await probe(CANARY_TEAM, PLAIN_TEAM);
    const canaryLine = p.p2.find((l) => l.startsWith("|poke|p1|Ferrothorn"))!;
    expect(canaryLine).toBeDefined();
    expect(canaryLine.endsWith("|item")).toBe(true);
    // …and the plain Snorlax beside it does not, so the marker really is the
    // per-Pokemon held-item signal and not a constant suffix.
    expect(p.p2.find((l) => l.startsWith("|poke|p1|Snorlax"))!.endsWith("|item")).toBe(false);
    p.destroy();
  }, 20_000);

  it("strips it on every channel a player or spectator can reach", async () => {
    const seen: Record<string, string[]> = { uA: [], uB: [] };
    const room = makeRoom("random50", CANARY_TEAM, PLAIN_TEAM);
    await startBattle(io, room, (u, e, pl) => {
      if (e === "battle:state") seen[u]?.push(...String((pl as { chunk: string }).chunk).split("\n").filter(Boolean));
    });
    await settle(250);

    const pokes = (lines: string[]) => lines.filter((l) => l.startsWith("|poke|"));
    // THE ITEM MARKER, on all five channels: both player sockets, both per-side
    // replay logs (what a rejoin re-sends), and the omniscient log that is
    // persisted as PvpMatch.battleLog and fanned out live to spectators.
    for (const [where, lines] of [
      ["uA's stream", seen.uA], ["uB's stream", seen.uB],
      ["A's replay log", room.a.log ?? []], ["B's replay log", room.b.log ?? []],
      ["the omniscient log", room.log],
    ] as const) {
      expect(pokes(lines).length, `${where} had no |poke| lines at all`).toBe(4);
      for (const line of pokes(lines)) {
        expect(line.endsWith("|"), `${where} leaked a held-item marker: ${line}`).toBe(true);
      }
    }
    // THE CANARY TOKENS, on the channels that must not carry them. uA's own
    // stream is deliberately NOT in this list and that is not an exemption: it
    // carries uA's own |request|, which is where their nickname, item, ability,
    // moves and spread legitimately live. Checking it would only assert that a
    // player cannot see their own team.
    for (const [where, lines] of [
      ["uB's stream", seen.uB],
      ["B's replay log", room.b.log ?? []],
      ["the omniscient log (spectators + persisted replay)", room.log],
    ] as const) {
      for (const token of [...CANARY_TOKENS, "shiny"]) {
        expect(lines.join("\n"), `${where} leaked "${token}"`).not.toContain(token);
      }
    }
    // …and the control for that exemption: uA's own stream DOES carry it, so
    // the three checks above are testing a boundary rather than an empty set.
    expect(seen.uA.join("\n")).toContain("ACANARY");
    // SYMMETRY, which is the security property and not just tidiness: the two
    // player streams' |poke| blocks are byte-identical, so `|poke|` never
    // becomes a side-exclusive line and tests/pvpRejoinLeak's "only |request|
    // crosses" invariant survives.
    expect(pokes(seen.uA)).toEqual(pokes(seen.uB));
    // Species, level and gender DO cross — that is the phase.
    expect(pokes(seen.uB).some((l) => l.startsWith("|poke|p1|Ferrothorn, L50"))).toBe(true);
  }, 20_000);
});

// ══ Section 3 · the room, the auto-lock and a battle that finishes ════════

let seq = 0;
const rooms: BattleRoom[] = [];

afterEach(async () => {
  for (const room of rooms.splice(0)) {
    if (room.expiryTimer) clearInterval(room.expiryTimer);
    if (room.previewTimer) clearTimeout(room.previewTimer);
    await endBattle(room, undefined, "cancelled");
    battleRooms.delete(room.id);
  }
});

function makeRoom(format = "random50", a = SIX_A.slice(0, 2), b = SIX_B.slice(0, 2)): BattleRoom {
  const room: BattleRoom = {
    id: `b_tp${++seq}`,
    status: "invited",
    format,
    createdAt: Date.now(),
    lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: a as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: b as never, stream: null, request: null, connected: true },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  };
  battleRooms.set(room.id, room);
  rooms.push(room);
  return room;
}

describe("a room in Team Preview", () => {
  it("enters the phase, renders a SHORT deadline, and leaves it when both answer", async () => {
    const events: { userId: string; event: string; payload: any }[] = [];
    const room = makeRoom();
    await startBattle(io, room, (u, e, pl) => void events.push({ userId: u, event: e, payload: pl }));
    await settle(250);

    // The phase is on, both sides are in it, and the deadline the client is
    // shipped is the PREVIEW one — not the five-minute turn clock.
    expect(isAwaitingTeamPreview(room, "uA")).toBe(true);
    expect(isAwaitingTeamPreview(room, "uB")).toBe(true);
    expect(room.previewDeadlineAt).toBeGreaterThan(Date.now());
    expect(room.previewDeadlineAt! - Date.now()).toBeLessThanOrEqual(TEAM_PREVIEW_LOCK_MS);
    expect(turnDeadlineFor(room)).toBe(room.previewDeadlineAt);
    const shipped = events.filter((e) => e.event === "battle:state").pop()!;
    expect(shipped.payload.turnDeadlineAt).toBe(room.previewDeadlineAt);
    // A stranger is not "awaiting" anything.
    expect(isAwaitingTeamPreview(room, "uNobody")).toBe(false);

    // Both answer.
    expect(applyChoice(room, "uA", "team 2").ok).toBe(true);
    expect(applyChoice(room, "uB", "default").ok).toBe(true);
    await settle(250);

    // The phase is over, the deadline reverted to the turn clock, and the timer
    // was disarmed rather than left to fire against a live turn.
    expect(isAwaitingTeamPreview(room, "uA")).toBe(false);
    expect(room.previewDeadlineAt ?? null).toBeNull();
    expect(room.previewTimer ?? null).toBeNull();
    expect(turnDeadlineFor(room)).toBeGreaterThan(Date.now() + TEAM_PREVIEW_LOCK_MS);
    // …and the battle really opened, on the lead that was chosen.
    expect(room.log).toContain("|start");
    expect(room.log.some((l) => l.startsWith("|switch|p1a: A2|Snorlax"))).toBe(true);
    expect(room.log.some((l) => l.startsWith("|turn|1"))).toBe(true);
  }, 20_000);

  it("plays a whole battle through the phase, to a real |win|", async () => {
    // End to end: the thing the outage prevented. One Pokemon each so the KO is
    // quick, and a Machamp against a Magikarp so it is certain.
    const room = makeRoom(
      "random50",
      [mon("SLUGGER", "machamp", { ability: "guts", moves: [{ id: "closeCombat" }] })],
      [mon("DOOMED", "magikarp", { ability: "swiftSwim", moves: [{ id: "splash" }] })],
    );
    const done: unknown[] = [];
    await startBattle(io, room, (_u, e, pl) => { if (e === "battle:complete") done.push(pl); });
    await settle(250);
    expect(isAwaitingTeamPreview(room, "uA")).toBe(true);
    applyChoice(room, "uA", "default");
    applyChoice(room, "uB", "default");
    await settle(300);
    expect(room.log.some((l) => l.startsWith("|turn|1"))).toBe(true);

    applyChoice(room, "uA", "move 1");
    applyChoice(room, "uB", "move 1");
    await settle(400);
    expect(room.log.some((l) => l === "|win|Alice")).toBe(true);
    expect(room.status).toBe("completed");
    expect(room.winnerId).toBe("uA");
    expect(done).toHaveLength(2);
  }, 20_000);

  it("auto-locks a side that never answers, and does not touch the side that did", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    // A picks Snorlax. B goes quiet.
    expect(applyChoice(room, "uA", "team 2").ok).toBe(true);
    await settle(120);
    expect(isAwaitingTeamPreview(room, "uB")).toBe(true);

    // Fire the deadline directly rather than sleeping twenty seconds: this is
    // the exact body the timer runs.
    resolveTeamPreviewLock(room);
    await settle(300);

    expect(room.log).toContain("|start");
    expect(room.log.some((l) => l.startsWith("|switch|p1a: A2|Snorlax"))).toBe(true);  // A's pick kept
    expect(room.log.some((l) => l.startsWith("|switch|p2a: B1|Charizard"))).toBe(true); // B got identity
    expect(room.status).toBe("active");
    expect(room.previewDeadlineAt ?? null).toBeNull();
  }, 20_000);

  it("auto-locks BOTH sides when neither answers, so a dead room still starts", async () => {
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    resolveTeamPreviewLock(room);
    await settle(300);
    expect(room.log).toContain("|start");
    expect(room.log.some((l) => l.startsWith("|turn|1"))).toBe(true);
    expect(room.status).toBe("active");
    // Neither player CHOSE anything, so neither is credited with a move — the
    // AFK watchdog's tiebreak must still see two silent players.
    expect(room.a.movedAt ?? 0).toBe(0);
    expect(room.b.movedAt ?? 0).toBe(0);
  }, 20_000);

  it("really does fire on its own, on the real timer", async () => {
    // The three cases above call resolveTeamPreviewLock directly. This one
    // proves the timer is actually armed and actually reaches it, because "the
    // body is right" and "the body runs" are different claims and only the
    // second one prevents the outage.
    vi.useFakeTimers();
    try {
      const room = makeRoom();
      await startBattle(io, room, () => {});
      await vi.advanceTimersByTimeAsync(200);
      expect(isAwaitingTeamPreview(room, "uA")).toBe(true);
      expect(room.previewTimer).toBeTruthy();
      await vi.advanceTimersByTimeAsync(TEAM_PREVIEW_LOCK_MS + 500);
      expect(room.log).toContain("|start");
      expect(room.previewDeadlineAt ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
      await settle(20);
    }
  }, 20_000);

  it("cannot submit `default` MOVES once the phase is over", async () => {
    // The dangerous inverse of the auto-lock: a timer that fired during a live
    // turn would answer for two players who were mid-decision. The gate is the
    // simulator's own requestState, so this calls the resolver at the worst
    // possible moment and measures that it does nothing.
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    applyChoice(room, "uA", "default");
    applyChoice(room, "uB", "default");
    await settle(300);
    const turnsBefore = room.log.filter((l) => l.startsWith("|turn|")).length;
    expect(turnsBefore).toBe(1);
    expect((room.stream as unknown as { battle: { requestState: string } }).battle.requestState).toBe("move");
    // Both sides answered the PREVIEW, so movedAt is legitimately set. The
    // property under test is that the resolver adds nothing to it — a
    // before/after comparison, not a null check.
    const movedBefore = [room.a.movedAt, room.b.movedAt];
    const seqBefore = [room.a.requestSeq, room.b.requestSeq];

    resolveTeamPreviewLock(room);
    resolveTeamPreviewLock(room);
    await settle(300);
    // No choice was submitted for anybody: still turn 1, no new request, and
    // neither side was credited with a move it did not make.
    expect(room.log.filter((l) => l.startsWith("|turn|")).length).toBe(turnsBefore);
    expect([room.a.movedAt, room.b.movedAt]).toEqual(movedBefore);
    expect([room.a.requestSeq, room.b.requestSeq]).toEqual(seqBefore);
    // The simulator is still waiting for two real move choices.
    expect((room.stream as unknown as { battle: { sides: { isChoiceDone(): boolean }[] } })
      .battle.sides.map((s) => s.isChoiceDone())).toEqual([false, false]);
  }, 20_000);

  it("survives a stream with no battle handle, and a finished room, without throwing", async () => {
    // resolveTeamPreviewLock runs out of a bare setTimeout, where a throw is
    // process death. Both of the shapes it can meet in the wild:
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);
    const real = room.stream!;
    room.stream = { write: (d: string) => real.write(d), destroy: () => real.destroy() };
    expect(() => resolveTeamPreviewLock(room)).not.toThrow();
    room.stream = real;
    await endBattle(room, undefined, "cancelled");
    expect(() => resolveTeamPreviewLock(room)).not.toThrow();
    expect(room.previewTimer ?? null).toBeNull();
  }, 20_000);

  it("PRACTICE: the AI answers the phase itself, long before the auto-lock", async () => {
    // ─── THE BOT DECISION, AND WHY IT WENT THIS WAY ──────────────────
    //
    // The choice was "skip Team Preview for practice battles" or "leave it on
    // and have the AI lock instantly". It is ON, for two reasons and not one:
    //
    //   * a practice battle exists to rehearse the ladder, and a practice mode
    //     that omits the ladder's opening phase teaches the wrong game. PvP
    //     population is ~34 active an hour, so for most players the AI battle
    //     IS most of their PvP — if Team Preview never appeared there, most
    //     players would first meet it in a rated match with a clock running;
    //   * it costs NOTHING to leave on, which is what this test measures. The
    //     AI answers through @pkmn/sim's own RandomPlayerAI.chooseTeamPreview
    //     (which returns `default`), on the ordinary 600-1200 ms think timer
    //     the room already gives it, so the human never waits on it and no
    //     bot-specific code exists anywhere for the phase.
    //
    // The alternative would have meant a format branch — a second SIM_FORMAT_ID
    // — and two ruleset code paths to keep in step for a saving of about one
    // second.
    const room = makeRoom("bot");
    room.b.userId = `bot:${room.id}`;
    room.b.username = "Youngster Joey AI";
    room.b.isBot = true;
    room.b.botTier = "trainer";
    await startBattle(io, room, () => {});
    // Past the AI's 600-1200 ms think window, and nowhere near the 20-second
    // auto-lock — the gap between those two numbers is the whole claim.
    await settle(1_600);
    // The human is still in the phase, and the AI is NOT — it answered on its
    // own, with the auto-lock still ~18 seconds away.
    expect(isAwaitingTeamPreview(room, "uA")).toBe(true);
    expect(room.previewDeadlineAt! - Date.now()).toBeGreaterThan(TEAM_PREVIEW_LOCK_MS - 5_000);
    const done = (room.stream as unknown as { battle: { sides: { isChoiceDone(): boolean }[] } })
      .battle.sides.map((s) => s.isChoiceDone());
    expect(done).toEqual([false, true]);

    // And the moment the human answers, the battle opens — no auto-lock needed.
    expect(applyChoice(room, "uA", "team 2").ok).toBe(true);
    await settle(300);
    expect(room.log).toContain("|start");
    expect(room.log.some((l) => l.startsWith("|turn|1"))).toBe(true);
    expect(room.previewDeadlineAt ?? null).toBeNull();
  }, 20_000);

  it("hands a rejoin mid-preview the roster, the preview deadline, and its own request", async () => {
    // A reload during Team Preview is a case that could not exist before. The
    // snapshot has to rebuild the picker, which means the |poke| lines and the
    // preview request — and it must ship the SHORT deadline, or the client
    // renders a countdown four and a half minutes longer than the auto-lock
    // about to run.
    const room = makeRoom();
    await startBattle(io, room, () => {});
    await settle(250);

    const ack = resolveRejoin("uA", room.id);
    expect(ack.ok).toBe(true);
    if (!ack.ok) return;
    const snap = ack.snapshot;
    expect(snap.log).toContain("|clearpoke");
    expect(snap.log).toContain("|teampreview");
    expect(snap.log.filter((l) => l.startsWith("|poke|"))).toHaveLength(4);
    expect(isTeamPreviewRequest(snap.request)).toBe(true);
    expect((snap.request as { side: { id: string } }).side.id).toBe("p1");
    expect(snap.turnDeadlineAt).toBe(room.previewDeadlineAt);
    // Every |request| in the replay is this side's own.
    const sides = new Set(snap.log
      .filter((l) => l.startsWith("|request|"))
      .map((l) => JSON.parse(l.slice("|request|".length)).side?.id));
    expect(sides).toEqual(new Set(["p1"]));
  }, 20_000);
});
