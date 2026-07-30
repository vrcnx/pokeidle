// THE WIRING: endBattle → settleLadderEarn, proved by running real battles.
//
// tests/pvpLadderPolicy.test.ts proves the arithmetic and
// tests/pvpLadderSettle.test.ts proves what only Postgres can arbitrate. Both
// call the ladder module directly, so between them they proved everything except
// the thing that actually pays anybody: whether endBattle calls it, with the
// right fields, from rooms built the way socket.ts builds them.
//
// That gap was the whole defect. settleLadderEarn had ZERO callers, and the
// `provenance` it documents as `room.ladderProvenance` was a field no
// construction site set — so the feature was 130 passing tests and a faucet that
// could never open.
//
// Every test below drives the REAL endBattle against room literals copied from
// the four places src/ builds one, and asserts against the PendingGrant inbox —
// the only place a reward can legitimately appear.
//
//   1. A BOT BATTLE PAYS ZERO. This is the exploit that matters: ~8 of 10 queue
//      attempts never match, so a player can generate bot battles endlessly with
//      no second human. If one paid, it is an infinite money printer.
//   2. A FRIEND INVITE PAYS ZERO — the owner's decision, enforced by omission.
//   3. A FORFEIT, TIMEOUT OR CANCELLATION PAYS NOBODY, so you cannot profit from
//      an opponent disconnecting and cannot be profited from by disconnecting.
//   4. A RATED MATCHMADE WIN PAYS EXACTLY ONCE, even if endBattle is invoked
//      twice.
//   5. The gate is POSITIVE: a room type nobody has written yet pays nothing,
//      because it cannot accidentally assert human consent.
//
// The gate is also audited at the SOURCE level, because "exactly one writer" is
// a property of the file, not of any single execution.
//
// DB stubbing follows pvpOutcomeIntegrity.test.ts (vi.mock of ../src/db.js so
// nothing can construct a PrismaClient) plus ../src/socket.js, which
// lib/prizeGrant.ts imports for its fire-and-forget "gift:pending" nudge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => {
  // ── The fake database ────────────────────────────────────────────
  // Only what this seam touches: the Elo rows, the PvpMatch insert, and the
  // ladder's own raw SQL. Anything else is a hard failure rather than a silent
  // empty result, so a stray query cannot look like a legitimate refusal.
  const state = {
    users: new Set<string>(["uA", "uB"]),
    ratings: new Map<string, { rating: number; peakRating: number }>(),
    earns: [] as any[],
    bonusClaims: [] as any[],
    milestones: [] as any[],
    baselines: [] as any[],
    grants: [] as any[],
    matches: [] as any[],
    errors: [] as any[],
    nextId: 1,
  };

  const client: any = {
    user: {
      findMany: async ({ where }: any) =>
        (where?.id?.in ?? [])
          .filter((id: string) => state.users.has(id))
          .map((id: string) => ({ id, saveVersion: 7 })),
      findUnique: async ({ where }: any) =>
        state.users.has(where.id) ? { id: where.id } : null,
      update: async () => { throw new Error("the reward must never touch the save"); },
    },
    pendingGrant: {
      create: async ({ data }: any) => {
        const row = { id: "g" + state.nextId++, ...data };
        state.grants.push(row);
        return { id: row.id };
      },
    },
    pvpMatch: { create: async ({ data }: any) => { state.matches.push(data); return data; } },
    playerRating: {
      upsert: async ({ where }: any) => {
        const r = state.ratings.get(where.userId) ?? { rating: 1000, peakRating: 1000 };
        state.ratings.set(where.userId, r);
        return { userId: where.userId, ...r };
      },
      update: async ({ where, data }: any) => {
        const r = state.ratings.get(where.userId) ?? { rating: 1000, peakRating: 1000 };
        state.ratings.set(where.userId, {
          rating: typeof data.rating === "number" ? data.rating : r.rating,
          peakRating: typeof data.peakRating === "number" ? data.peakRating : r.peakRating,
        });
        return {};
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join("?");
      if (sql.includes('FROM "PvpLadderEarn" e')) {
        const [opponentId, , bonusCutoff, userId, windowStart] = values;
        const mine = state.earns.filter(
          (e) => e.userId === userId && e.createdAt.getTime() > windowStart.getTime(),
        );
        return [{
          bp_window: mine.reduce((a, e) => a + e.bp, 0),
          milestone_window: mine.reduce((a, e) => a + e.milestoneBp, 0),
          meetings: mine.filter((e) => e.opponentUserId === opponentId).length,
          bonus_on_cooldown: state.bonusClaims.filter(
            (b) => b.userId === userId && b.claimedAt.getTime() > bonusCutoff.getTime(),
          ).length,
        }];
      }
      if (sql.includes('FROM "PvpBadgeMilestone"')) {
        return state.milestones
          .filter((m) => m.userId === values[0])
          .map((m) => ({ threshold: m.threshold }));
      }
      if (sql.includes('FROM "PvpLadderBaseline"')) {
        return state.baselines.filter((b) => values.includes(b.userId));
      }
      throw new Error(`unmodelled query: ${sql}`);
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join("?");
      if (sql.includes('INSERT INTO "PvpLadderEarn"')) {
        const [id, matchId, userId, opponentUserId, , provenance, result, endReason,
          turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
          , , createdAt] = values;
        // THE BOT GATE AS A CONSTRAINT: both columns are FKs to User(id), so a
        // synthetic `bot:<battleId>` id raises 23503 and takes both sides' rows
        // and both grants down together.
        for (const fk of [userId, opponentUserId]) {
          if (!state.users.has(fk)) throw new Error(`23503 FK violation: ${fk} is not a User`);
        }
        if (state.earns.some((e) => e.matchId === matchId && e.userId === userId)) return 0;
        state.earns.push({
          id, matchId, userId, opponentUserId, provenance, result, endReason,
          turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
          bp: 0, milestoneBp: 0, moneyAwarded: 0, winBonusPaid: false, createdAt,
        });
        return 1;
      }
      if (sql.includes('INSERT INTO "PvpWinBonusClaim"')) {
        const [userId, claimedAt, , , , , , cutoff] = values;
        const existing = state.bonusClaims.find((b) => b.userId === userId);
        if (!existing) { state.bonusClaims.push({ userId, claimedAt }); return 1; }
        if (existing.claimedAt.getTime() > cutoff.getTime()) return 0;
        existing.claimedAt = claimedAt;
        return 1;
      }
      if (sql.includes('INSERT INTO "PvpBadgeMilestone"')) {
        const [userId, threshold, , , bp] = values;
        if (state.milestones.some((m) => m.userId === userId && m.threshold === threshold)) return 0;
        state.milestones.push({ userId, threshold, bp });
        return 1;
      }
      if (sql.includes('INSERT INTO "PvpLadderBaseline"')) {
        const [ratingAfter, createdAt, userId] = values;
        const pr = state.ratings.get(userId);
        if (!pr) return 0;
        if (state.baselines.some((b) => b.userId === userId)) return 0;
        state.baselines.push({
          userId, rating: Math.max(pr.peakRating, pr.rating, ratingAfter), createdAt,
        });
        return 1;
      }
      if (sql.includes('UPDATE "PvpLadderEarn"')) {
        const [bp, milestoneBp, moneyAwarded, winBonusPaid, grantId, id] = values;
        const row = state.earns.find((e) => e.id === id);
        if (row) Object.assign(row, { bp, milestoneBp, moneyAwarded, winBonusPaid, grantId });
        return 1;
      }
      throw new Error(`unmodelled statement: ${sql}`);
    },
    $transaction: async (fn: any) => {
      // Snapshot/restore is enough here: nothing in this file runs two settles
      // concurrently (pvpLadderSettle.test.ts owns the interleaving proofs).
      const snap = JSON.stringify({
        e: state.earns, b: state.bonusClaims, m: state.milestones,
        bl: state.baselines, g: state.grants,
      });
      try {
        return await fn(client);
      } catch (e) {
        const prev = JSON.parse(snap);
        state.earns = prev.e.map((r: any) => ({ ...r, createdAt: new Date(r.createdAt) }));
        state.bonusClaims = prev.b.map((r: any) => ({ ...r, claimedAt: new Date(r.claimedAt) }));
        state.milestones = prev.m;
        state.baselines = prev.bl;
        state.grants = prev.g;
        throw e;
      }
    },
  };

  return {
    state,
    prisma: client,
    recordError: vi.fn(async (e: any) => { state.errors.push(e); }),
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../src/socket.js", () => ({ sendToUserGlobal: vi.fn(), kickSession: vi.fn() }));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: h.recordError }));

import {
  battleRooms,
  endBattle,
  flushPvpPersists,
  type BattleRoom,
} from "../src/pvp.js";
import {
  LADDER_BP_CAP_PER_WINDOW,
  LADDER_BP_ITEM_ID,
  LADDER_BP_LOSS,
  LADDER_BP_WIN,
  LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW,
  LADDER_MILESTONE_BP_CAP_PER_WINDOW,
  LADDER_WIN_BONUS_BP,
} from "../src/lib/pvpLadder.js";
import { PVP_BADGE_TIERS } from "../src/lib/pvpBadge.js";
import { parsePrizes } from "../src/lib/giveaway.js";

const BRONZE_MONEY = PVP_BADGE_TIERS[0].winBonusMoney;

// ── Room fixtures, copied from the four construction sites ───────────
// Deliberately literal rather than factored through one builder with a flag: the
// property under test is what each SITE does or does not write, and a shared
// builder would let one site's omission be supplied by another's default.

let seq = 0;
function baseSides() {
  return {
    a: { userId: "uA", username: "Alice", team: [] as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: [] as never, stream: null, request: null, connected: true },
  };
}

/** A five-minute, six-turn battle: comfortably past LADDER_MIN_TURNS and
 *  LADDER_MIN_DURATION_MS, so a refusal below is never the short-battle floor
 *  wearing the wrong name. */
function realBattleLog(): string[] {
  return ["|start", "|turn|1", "|turn|2", "|turn|3", "|turn|4", "|turn|5", "|turn|6", "|win|Alice"];
}

function register(room: BattleRoom): BattleRoom {
  room.createdAt = Date.now() - 5 * 60_000;
  room.log = realBattleLog();
  room.status = "active";
  battleRooms.set(room.id, room);
  return room;
}

/** socket.ts tryPairAndSpawnRoom — the ONLY payable path. */
function queueRoom(): BattleRoom {
  return register({
    id: `b_w${++seq}`, status: "invited", format: "random50",
    ladderProvenance: "queue",
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    ...baseSides(),
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  });
}

/** socket.ts battle:invite. NOTE the format: an invite may be "random50" too,
 *  so it is RATED — which is exactly why a format check could never have been
 *  the gate. It carries no provenance, and that is the whole difference. */
function inviteRoom(format = "random50"): BattleRoom {
  return register({
    id: `b_w${++seq}`, status: "invited", format,
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    ...baseSides(),
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  });
}

/** socket.ts battle:bot. The synthetic opponent id is the real one. */
function botRoom(format = "bot"): BattleRoom {
  const id = `b_w${++seq}`;
  const sides = baseSides();
  return register({
    id, status: "invited", format,
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    a: sides.a,
    b: {
      userId: `bot:${id}`, username: "Youngster Joey AI", team: [] as never,
      stream: null, request: null, connected: true, awayAt: null,
      isBot: true, botTier: "rookie" as never,
    },
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  });
}

/** lib/tournamentRunner.ts / routes/admin.ts, and the shape of every room type
 *  nobody has written yet: no provenance, because it never heard of rewards. */
function tournamentRoom(): BattleRoom {
  return register({
    id: `b_w${++seq}`, status: "invited", format: "tournament",
    createdAt: Date.now(), lastChoiceAt: Date.now(),
    ...baseSides(),
    tournamentId: "t_1",
    log: [], stream: null, expiryTimer: null, spectators: new Set(),
  });
}

/** Drive a finished battle exactly as the production callers do: the CALLER
 *  writes the outcome, endBattle only persists it. */
async function finish(
  room: BattleRoom,
  reason: "ko" | "tie" | "forfeit" | "timeout" | "cancelled",
  winner: "a" | "b" | null = "a",
): Promise<void> {
  if (winner) {
    room.winnerId = winner === "a" ? room.a.userId : room.b.userId;
    room.loserId = winner === "a" ? room.b.userId : room.a.userId;
  }
  await endBattle(room, undefined, reason);
  // The reward is fire-and-forget, enlisted in the same drain the PvpMatch
  // insert uses — so this is the production mechanism, not a test-only hook.
  await flushPvpPersists();
}

/** BP + money actually OWED through the inbox. The only place a reward can
 *  legitimately appear: there is no save write anywhere in this feature. */
function owed(userId: string): { bp: number; money: number } {
  let bp = 0, money = 0;
  for (const g of h.state.grants.filter((x) => x.userId === userId)) {
    for (const p of parsePrizes(g.prizes)) {
      if (p.kind === "item" && p.itemId === LADDER_BP_ITEM_ID) bp += p.quantity;
      if (p.kind === "money") money += p.amount;
    }
  }
  return { bp, money };
}

function expectNobodyPaid() {
  expect(h.state.grants).toEqual([]);
  expect(h.state.earns).toEqual([]);
  expect(h.state.bonusClaims).toEqual([]);
  expect(owed("uA")).toEqual({ bp: 0, money: 0 });
  expect(owed("uB")).toEqual({ bp: 0, money: 0 });
}

beforeEach(() => {
  const s = h.state;
  s.users = new Set(["uA", "uB"]);
  s.ratings = new Map();
  s.earns = []; s.bonusClaims = []; s.milestones = []; s.baselines = [];
  s.grants = []; s.matches = []; s.errors = [];
  h.recordError.mockClear();
  // The faucet is OFF by default in production and in every other test file, so
  // every test here that expects a payment has to open it — which is itself the
  // assertion that a deploy forgetting the env var mints nothing.
  process.env.PVP_LADDER_REWARDS = "1";
});

afterEach(() => {
  delete process.env.PVP_LADDER_REWARDS;
  for (const [id, room] of [...battleRooms]) {
    if (!id.startsWith("b_w")) continue;
    if (room.expiryTimer) clearInterval(room.expiryTimer);
    battleRooms.delete(id);
  }
});

// ════════════════════════════════════════════════════════════════════
// 0. THE HOOK EXISTS AT ALL
// ════════════════════════════════════════════════════════════════════
describe("a rated matchmade battle actually pays", () => {
  it("pays both sides through the inbox, from the real endBattle", async () => {
    await finish(queueRoom(), "ko");
    // The winner: BP for the win, BP for the once-per-cooldown bonus, and the
    // tier-priced cash.
    expect(owed("uA")).toEqual({
      bp: LADDER_BP_WIN + LADDER_WIN_BONUS_BP,
      money: BRONZE_MONEY,
    });
    // The loser is paid too — with ~34 players an hour the scarce resource is
    // opponents, and a ladder where losing pays zero teaches the better player's
    // victims to stop queueing.
    expect(owed("uB")).toEqual({ bp: LADDER_BP_LOSS, money: 0 });
    expect(h.state.errors).toEqual([]);
  });

  it("records the match id, the pairing path and the measured turns/duration", async () => {
    const room = queueRoom();
    await finish(room, "ko");
    const a = h.state.earns.find((e) => e.userId === "uA")!;
    expect(a.matchId).toBe(room.id);
    expect(a.provenance).toBe("queue");
    expect(a.endReason).toBe("ko");
    // Counted from room.log, which exists NOWHERE ELSE once the room is dropped.
    expect(a.turns).toBe(6);
    // …and measured from room.createdAt, likewise unrecoverable: PvpMatch
    // .createdAt is stamped at insert time, so finishedAt - createdAt is 0 for
    // every row ever written.
    expect(a.durationMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(a.ratingDelta).toBe(16);
  });

  it("passes endReason, not reason — the field name the ledger reads", async () => {
    // The proposed hook passed `reason:`, which does not compile and, had it been
    // silently accepted, would have made `endReason` undefined and refused every
    // payment as end_reason_undefined.
    await finish(queueRoom(), "ko");
    expect(h.state.earns.map((e) => e.endReason)).toEqual(["ko", "ko"]);
  });

  it("mints nothing when the master switch is off, with the same room", async () => {
    delete process.env.PVP_LADDER_REWARDS;
    await finish(queueRoom(), "ko");
    expectNobodyPaid();
    // …and the battle itself is entirely unaffected: the row still lands.
    expect(h.state.matches).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// 1. A BOT BATTLE PAYS ZERO — the exploit that matters
// ════════════════════════════════════════════════════════════════════
describe("a bot battle pays ZERO", () => {
  it("pays nothing for a practice battle the player won", async () => {
    h.state.users.add("uA");
    await finish(botRoom(), "ko");
    expectNobodyPaid();
    // Not an error either: an unpaid bot battle is the NORMAL answer, and
    // logging it would bury the real failures.
    expect(h.state.errors).toEqual([]);
  });

  it("pays nothing even if a bot room is given a rated format", async () => {
    // The denylist that was rejected — `format !== "bot"` — dies here, and so
    // does `format === "random50"`, which is the predicate applyEloUpdate itself
    // uses. A bot task reusing random50 for the Lv50 cap is the natural thing to
    // do, and it must not become a money printer.
    await finish(botRoom("random50"), "ko");
    expectNobodyPaid();
  });

  it("pays nothing even if a bot seat is handed a real User row", async () => {
    // Likely, eventually: a bot given a User row so its username renders. The
    // provenance gate refuses first, before any query.
    const room = botRoom();
    h.state.users.add(room.b.userId);
    await finish(room, "ko");
    expectNobodyPaid();
  });

  it("cannot be farmed: fifty consecutive bot wins pay nothing at all", async () => {
    for (let i = 0; i < 50; i++) await finish(botRoom(), "ko");
    expectNobodyPaid();
    expect(h.state.errors).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. A FRIEND INVITE PAYS ZERO — the owner's decision
// ════════════════════════════════════════════════════════════════════
describe("a friend-invite battle pays ZERO", () => {
  it("pays nothing for a rated invite between two real accounts", async () => {
    await finish(inviteRoom("random50"), "ko");
    expectNobodyPaid();
    expect(h.state.errors).toEqual([]);
  });

  it("pays nothing for an anything-goes invite either", async () => {
    await finish(inviteRoom("anything-goes"), "ko");
    expectNobodyPaid();
  });

  it("still rates the invite — the reward is refused, the ladder is not", async () => {
    // random50 invites move Elo (endBattle's rating block keys on the format),
    // and that stays true: the owner refused a PAYOUT, not competitive play.
    await finish(inviteRoom("random50"), "ko");
    expect(h.state.ratings.get("uA")!.rating).toBe(1016);
    expect(h.state.ratings.get("uB")!.rating).toBe(984);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. THE GATE IS POSITIVE — omission is refusal
// ════════════════════════════════════════════════════════════════════
describe("a room that never heard of rewards pays nothing, with no code of its own", () => {
  it("pays nothing for a tournament / admin-started room", async () => {
    await finish(tournamentRoom(), "ko");
    expectNobodyPaid();
  });

  it("pays nothing for a brand-new room type nobody has written yet", async () => {
    // The literal shape a future feature produces: every field endBattle needs,
    // and no idea that rewards exist.
    const room = register({
      id: `b_w${++seq}`, status: "invited", format: "some-future-mode",
      createdAt: Date.now(), lastChoiceAt: Date.now(),
      ...baseSides(),
      log: [], stream: null, expiryTimer: null, spectators: new Set(),
    });
    await finish(room, "ko");
    expectNobodyPaid();
  });

  it("has exactly ONE writer of ladderProvenance in all of src/", () => {
    // The property is about the FILES, not about any one execution: a second
    // writer is how a positive gate quietly becomes a denylist. Same shape as
    // pvpBot.test.ts's audit of `isBot`, and for the same reason.
    const src = path.resolve(process.cwd(), "src");
    const files: string[] = [];
    (function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) files.push(p);
      }
    })(src);
    expect(files.length).toBeGreaterThan(10);

    const writes: string[] = [];
    for (const f of files) {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        // `ladderProvenance: x` / `= x`, but not `===`, not the declaration
        // `ladderProvenance?:`, and not prose in a comment.
        if (/\bladderProvenance\s*(:|=(?!=))\s*/.test(line)
          && !/^\s*(\*|\/\/)/.test(line)
          && !/ladderProvenance\?:/.test(line)) {
          writes.push(`${path.basename(f)}: ${line.trim()}`);
        }
      }
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^socket\.ts:/);
    expect(writes[0]).toMatch(/ladderProvenance:\s*"queue"/);
    // And nothing anywhere writes the other allowlisted value. The room field's
    // TYPE already makes that a compile error; this is the belt to those braces,
    // because a type is only as good as the next `as any`.
    for (const f of files) {
      expect(/ladderProvenance\s*[:=]\s*"invite"/.test(fs.readFileSync(f, "utf8")))
        .toBe(false);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. A FORFEIT / TIMEOUT / CANCELLATION IS NEVER A PAYDAY
// ════════════════════════════════════════════════════════════════════
describe("nobody profits from a battle that was not fought to a finish", () => {
  it("pays nobody when the opponent disconnects and is forfeited out", async () => {
    // The reconnect-grace forfeit: uA is still here, uB's socket went away. uA
    // gets the rating win and no BP, which is the documented cost.
    await finish(queueRoom(), "forfeit");
    expectNobodyPaid();
    expect(h.state.ratings.get("uA")!.rating).toBe(1016);
  });

  it("pays nobody when the AFK watchdog times a battle out", async () => {
    await finish(queueRoom(), "timeout");
    expectNobodyPaid();
  });

  it("pays nobody for a cancelled battle, including the shutdown drain's", async () => {
    await finish(queueRoom(), "cancelled", null);
    expectNobodyPaid();
    // A cancelled room is not even rated, so there is nothing to refuse.
    expect(h.state.ratings.size).toBe(0);
  });

  it("pays the FORFEITER nothing either — you cannot profit from being forfeited", async () => {
    await finish(queueRoom(), "forfeit", "b");
    expectNobodyPaid();
  });

  it("pays nothing for a scripted instant KO, however it is labelled", async () => {
    const room = queueRoom();
    room.createdAt = Date.now();          // under the 20s floor
    room.log = ["|start", "|turn|1", "|win|Alice"];
    await finish(room, "ko");
    expectNobodyPaid();
  });

  it("pays nothing for a tie, because a tie is never rated", async () => {
    // pvp.ts leaves winnerId/loserId unset on a tie, so the rating block never
    // runs — and an unrated result is never a ladder result.
    await finish(queueRoom(), "tie", null);
    expectNobodyPaid();
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. EXACTLY ONCE
// ════════════════════════════════════════════════════════════════════
describe("a rated matchmade win pays exactly once", () => {
  it("pays once when endBattle is invoked twice on the same room", async () => {
    const room = queueRoom();
    await finish(room, "ko");
    const paid = owed("uA");
    // The double-end gate returns early here, which is the FIRST defence.
    await finish(room, "ko");
    expect(owed("uA")).toEqual(paid);
    expect(h.state.grants).toHaveLength(2);
  });

  it("pays once even when the room is re-opened underneath endBattle", async () => {
    // Defeats the in-process gate deliberately: status is forced back to
    // "active", so the second endBattle runs the whole body again — a second Elo
    // update, a second PvpMatch insert, a second settle. Only the ledger's UNIQUE
    // (matchId, userId) can arbitrate that, and it is what does.
    const room = queueRoom();
    await finish(room, "ko");
    const paid = owed("uA");
    room.status = "active";
    room.log = realBattleLog();
    await finish(room, "ko");
    expect(owed("uA")).toEqual(paid);
    expect(h.state.earns.filter((e) => e.userId === "uA")).toHaveLength(1);
    // …and the replay wrote nothing at all, not even a phantom meeting.
    expect(h.state.earns).toHaveLength(2);
    // A replay is a normal race, not a failure worth paging anyone about.
    expect(h.state.errors).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. THE DAILY CAP AND THE DECAY HOLD ACROSS REAL BATTLES
// ════════════════════════════════════════════════════════════════════
describe("caps and decay hold across a day of real battles", () => {
  it("decays repeat wins against the SAME opponent", async () => {
    const bp: number[] = [];
    for (let i = 0; i < 5; i++) {
      await finish(queueRoom(), "ko");
      const row = h.state.earns.filter((e) => e.userId === "uA").at(-1)!;
      bp.push(row.bp);
    }
    // 3, 3, 2, 2, 1 — plus the one-off win bonus on the first. The floor is
    // deliberate: a shape that reaches zero teaches your only available opponent
    // to stop playing you.
    expect(bp).toEqual([LADDER_BP_WIN + LADDER_WIN_BONUS_BP, 3, 2, 2, 1]);
  });

  it("holds BOTH rolling caps over a long day, milestones included", async () => {
    // 40 real matchmade wins in one window, which is also enough Elo to climb
    // past Silver — so this exercises the ordinary faucet and the milestone
    // faucet at once. The caps are the whole defence against a collusion ring, so
    // they have to hold against the real hook, not just the policy function.
    for (let i = 0; i < 40; i++) await finish(queueRoom(), "ko");
    const mine = h.state.earns.filter((e) => e.userId === "uA");
    const battleBp = mine.reduce((a, e) => a + e.bp, 0);
    const milestoneBp = mine.reduce((a, e) => a + e.milestoneBp, 0);

    expect(battleBp).toBe(LADDER_BP_CAP_PER_WINDOW);
    expect(milestoneBp).toBeLessThanOrEqual(LADDER_MILESTONE_BP_CAP_PER_WINDOW);
    // THE HONEST HEADLINE, executed end to end: 25 + 40, not the 115 that a
    // lifetime milestone stack payable in one window used to allow.
    expect(battleBp + milestoneBp).toBeLessThanOrEqual(LADDER_MAX_BP_ONE_ACCOUNT_ONE_WINDOW);
    expect(owed("uA").bp).toBe(battleBp + milestoneBp);
    // The climb really did happen, so the milestone half is not passing by
    // being zero.
    expect(h.state.ratings.get("uA")!.rating).toBeGreaterThan(1100);
    expect(milestoneBp).toBeGreaterThan(0);
    // One cash bonus, whatever the match count.
    expect(owed("uA").money).toBe(BRONZE_MONEY);
  });

  it("pays a milestone only above the frozen baseline, through the real hook", async () => {
    // The account was already at 1310 before rewards existed — the state the
    // migration backfill freezes. It dips (a loss), then wins its way back over
    // 1300, which is the staggered retroactive dump: every account above a
    // threshold is one defeat away from re-crossing it.
    h.state.ratings.set("uA", { rating: 1290, peakRating: 1310 });
    h.state.ratings.set("uB", { rating: 1290, peakRating: 1290 });
    h.state.baselines.push({ userId: "uA", rating: 1310, createdAt: new Date() });
    h.state.baselines.push({ userId: "uB", rating: 1290, createdAt: new Date() });

    await finish(queueRoom(), "ko");
    expect(h.state.ratings.get("uA")!.rating).toBeGreaterThan(1300);
    expect(h.state.milestones).toEqual([]);
    // The battle still paid — the baseline costs the milestone, not the match.
    expect(owed("uA").bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);
  });

  it("keeps the first-win bonus after losing four times to the same person", async () => {
    // REGRESSION: the win bonus used to require the battle's own BP to survive
    // per-opponent decay, so a player who lost four times to one rival and
    // finally won the fifth was paid $0 and 0 BP for the win. With ~8 people
    // playing PvP that is the weaker half of every rivalry, permanently — and a
    // daily bonus must not be destroyed by having played.
    for (let i = 0; i < 4; i++) await finish(queueRoom(), "ko", "b");
    expect(owed("uA")).toEqual({ bp: 4 * LADDER_BP_LOSS, money: 0 });

    await finish(queueRoom(), "ko", "a");
    const win = h.state.earns.filter((e) => e.userId === "uA").at(-1)!;
    expect(win.winBonusPaid).toBe(true);
    expect(win.moneyAwarded).toBe(BRONZE_MONEY);
    // …and the BP for that win is real too: decayed to the floor, not to zero.
    expect(win.bp).toBeGreaterThanOrEqual(1 + LADDER_WIN_BONUS_BP);
    expect(owed("uA").money).toBe(BRONZE_MONEY);
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. A REWARD CAN NEVER DAMAGE A BATTLE
// ════════════════════════════════════════════════════════════════════
describe("a failing reward cannot corrupt an outcome", () => {
  it("still ships the result, the row and the rating when the settle throws", async () => {
    // The table is missing — the pre-migration state, and the loudest realistic
    // failure. Every rated battle must still complete, be recorded and be rated.
    const original = h.prisma.$transaction;
    let calls = 0;
    h.prisma.$transaction = async (fn: any) => {
      // The FIRST transaction is applyEloUpdate's; only the settle's fails.
      if (++calls > 1) throw new Error('relation "PvpLadderEarn" does not exist');
      return original(fn);
    };
    try {
      const events: string[] = [];
      const room = queueRoom();
      room.winnerId = "uA"; room.loserId = "uB";
      await endBattle(room, (_u, e) => { events.push(e); }, "ko");
      await flushPvpPersists();

      expect(events.filter((e) => e === "battle:complete")).toHaveLength(2);
      expect(h.state.matches).toHaveLength(1);
      expect(h.state.matches[0].winnerId).toBe("uA");
      expect(h.state.ratings.get("uA")!.rating).toBe(1016);
      expect(h.state.grants).toEqual([]);
      // Recorded, not swallowed: a reward that silently fails to pay is a
      // support ticket nobody can answer. And because this particular failure IS
      // the pre-migration state, it is reported by the name of its own fix rather
      // than as a generic settle failure.
      expect(h.state.errors.map((e) => e.message)).toContain("pvp_ladder_migration_missing");
      expect(h.state.errors.find((e) => e.message === "pvp_ladder_migration_missing").meta.migration)
        .toBe("20260730120000_add_pvp_ladder");
    } finally {
      h.prisma.$transaction = original;
    }
  });

  it("never lets the reward decide who won", async () => {
    // The outcome is frozen before the ELO await and read from that freeze, so a
    // late write to room.winnerId — socket.ts's battle:cancel does exactly this —
    // cannot redirect a payment.
    const room = queueRoom();
    room.winnerId = "uA"; room.loserId = "uB";
    const ended = endBattle(room, undefined, "ko");
    room.winnerId = "uB"; room.loserId = "uA";   // the late writer
    await ended;
    await flushPvpPersists();
    expect(h.state.earns.find((e) => e.result === "win")!.userId).toBe("uA");
    expect(owed("uA").money).toBe(BRONZE_MONEY);
    expect(owed("uB").money).toBe(0);
  });
});
