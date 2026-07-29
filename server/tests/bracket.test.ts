// Bracket generation/advancement (pure) + the tournament runner's
// compare-and-swap: losing the bracket race must abort the tick cleanly,
// and the already-in-battle guard is what keeps a replayed pairing from
// spawning a second (orphaned) battle for the same players.
//
// Stubbing: ../src/db.js is a swappable fake; ../src/socket.js provides
// scriptable isOnline / getIo / sendToUserGlobal. No DB, no sockets.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let prismaImpl: any = {};
  const online = new Set<string>();
  return {
    setPrisma: (p: any) => { prismaImpl = p; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => prismaImpl[prop],
    }),
    online,
    sent: [] as { userId: string; event: string }[],
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({
  getIo: () => ({}) as never,
  isOnline: (id: string) => h.online.has(id),
  sendToUserGlobal: (userId: string, event: string) => { h.sent.push({ userId, event }); },
}));

import {
  generateBracket,
  advanceBracket,
  championOf,
  seedOrder,
  DOUBLE_BYE,
} from "../src/lib/bracket.js";
import {
  tickTournament,
  startTournamentBattle,
  type RunnerEnv,
  type TournamentRow,
} from "../src/lib/tournamentRunner.js";
import { battleRooms, type BattleRoom } from "../src/pvp.js";

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    userId: `u${i + 1}`,
    username: `player${i + 1}`,
    seed: i + 1,
  }));

describe("bracket (pure)", () => {
  it("uses the standard slot order so #1 and #2 can only meet in the final", () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const b = generateBracket(entries(8));
    const r1 = b.rounds[0].matches.map((m) => [
      (m.a as any).userId, (m.b as any).userId,
    ]);
    expect(r1).toEqual([["u1", "u8"], ["u4", "u5"], ["u2", "u7"], ["u3", "u6"]]);
  });

  it("refuses a winner who is not in the match (no eliminating the actual winner)", () => {
    const b = generateBracket(entries(2));
    const out = advanceBracket(b, { "r0.m0": "someone_else" });
    expect(out.bracket.rounds[0].matches[0].winnerId).toBeNull();
    expect(out.eliminatedUserIds).toEqual([]);
    expect(out.complete).toBe(false);
  });

  it("advances, eliminates the loser, and crowns a champion", () => {
    const b = generateBracket(entries(2));
    const out = advanceBracket(b, { "r0.m0": "u2" });
    expect(out.championId).toBe("u2");
    expect(out.eliminatedUserIds).toEqual(["u1"]);
    expect(championOf(out.bracket)).toBe("u2");
  });

  it("byes auto-resolve and the DOUBLE_BYE sentinel can never be champion", () => {
    const b = generateBracket(entries(3)); // padded to 4 with one bye
    const bye = b.rounds[0].matches.find((m) => m.winBy === "bye");
    expect(bye?.winnerId).toBe("u1"); // top seed gets the bye
    expect(championOf({ rounds: [{ index: 0, matches: [{ id: "x", a: { kind: "bye" }, b: { kind: "bye" }, winnerId: DOUBLE_BYE }] }] } as never)).toBeNull();
  });
});

// ── Runner CAS ──────────────────────────────────────────────────────────

function liveRow(bracketJson: string): TournamentRow {
  return {
    id: "t1", name: "Cup", status: "live", levelCap: null,
    roundWindowMinutes: 1440, bracket: bracketJson,
  };
}

function envWith(overrides: Partial<RunnerEnv>): RunnerEnv {
  return {
    isOnline: () => true,
    lastSeenAt: async () => Date.now(),
    startMatch: async () => ({ ok: true, battleId: "b_fresh" }),
    battleOutcome: async () => ({ state: "pending" }),
    now: () => Date.now(),
    ...overrides,
  };
}

describe("tournament runner — bracket CAS", () => {
  beforeEach(() => {
    h.online.clear();
    h.sent.length = 0;
    battleRooms.clear();
  });

  it("winning the CAS persists the started battle into the bracket", async () => {
    const bracket = generateBracket(entries(2));
    const persisted: string[] = [];
    const actions = await tickTournament(
      liveRow(JSON.stringify(bracket)),
      envWith({}),
      async (patch) => { persisted.push(patch.bracket); },
      async () => undefined,
    );
    expect(actions.some((a) => a.kind === "started")).toBe(true);
    const saved = JSON.parse(persisted[persisted.length - 1]);
    expect(saved.rounds[0].matches[0].battleId).toBe("b_fresh");
  });

  it("losing the CAS aborts the tick with no crash and no actions applied", async () => {
    // Same shape the production runOne uses: persist throws when the
    // updateMany-with-old-bracket-in-WHERE matches zero rows.
    class BracketRace extends Error {}
    const bracket = generateBracket(entries(2));
    const startMatch = vi.fn(async () => ({ ok: true as const, battleId: "b_loser" }));
    await expect(
      tickTournament(
        liveRow(JSON.stringify(bracket)),
        envWith({ startMatch }),
        async () => { throw new BracketRace(); },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(BracketRace);
    // The battle WAS spawned before the race was lost — which is exactly why
    // the in-battle guard below must exist.
    expect(startMatch).toHaveBeenCalledTimes(1);
  });

  it("the loser's live battle blocks a duplicate spawn for the same players (no orphaned battle)", async () => {
    // The CAS loser's battle is still alive in battleRooms even though the
    // winning bracket never recorded its battleId. The next tick re-reads
    // the winner's bracket and tries to start the pairing again —
    // startTournamentBattle must refuse rather than orphan a second battle.
    h.online.add("uA").add("uB");
    const room: BattleRoom = {
      id: "b_lost", status: "active", format: "tournament",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      a: { userId: "uA", username: "A", team: [], stream: null, request: null, connected: true },
      b: { userId: "uB", username: "B", team: [], stream: null, request: null, connected: true },
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    };
    battleRooms.set(room.id, room);
    h.setPrisma({
      user: {
        findUnique: async ({ where }: any) => ({
          id: where.id, username: where.id,
          saveData: JSON.stringify({ party: [{ id: "m1", speciesKey: "pikachu", level: 5 }] }),
        }),
      },
    });
    const res = await startTournamentBattle(
      { id: "t1", levelCap: null },
      {
        id: "r0.m0",
        a: { kind: "player", userId: "uA", username: "A", seed: 1 },
        b: { kind: "player", userId: "uB", username: "B", seed: 2 },
      },
    );
    expect(res).toEqual({ ok: false, reason: "one or both participants are already in a battle" });
    battleRooms.delete(room.id);
  });

  it("refuses to spawn against an offline player (a doomed room burns the pairing)", async () => {
    h.online.add("uA"); // uB offline
    const res = await startTournamentBattle(
      { id: "t1", levelCap: null },
      {
        id: "r0.m0",
        a: { kind: "player", userId: "uA", username: "A", seed: 1 },
        b: { kind: "player", userId: "uB", username: "B", seed: 2 },
      },
    );
    expect(res).toEqual({ ok: false, reason: "B is offline" });
  });
});
