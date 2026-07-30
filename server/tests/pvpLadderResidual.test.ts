// The residual findings, reproduced by EXECUTION and then pinned.
//
// tests/pvpLadderPolicy.test.ts proves the arithmetic, tests/pvpLadderSettle.ts
// proves what only Postgres arbitrates, tests/pvpLadderWiring.ts proves endBattle
// calls the thing at all, and tests/pvpLadderMoneyPrinter.ts attacks the gate.
// This file is the LAST set of confirmed findings, each one reproduced against
// the real code before it was fixed:
//
//   1. RATING WAS MANUFACTURABLE OFF THE PAYING PATH, AND RATING PRICES THE CASH
//      20x. Executed: 40 instant forfeit invites (which mint nothing, and whose
//      opponent you CHOOSE) moved an account past a tier boundary, and the next
//      matchmade KO paid the higher tier. Measured cost to Diamond was 448 thrown
//      invite matches — ~90 minutes of scripted play — after which the main
//      claimed $200,000 per 20h instead of $10,000. The anti-collusion argument
//      in lib/pvpLadder.ts said rating "is the one PvP quantity a ring cannot
//      manufacture"; that sentence was FALSE, because the quantity that priced
//      the money was live PlayerRating and live PlayerRating moves on paths that
//      pay nothing and let you pick your opponent.
//   2. THE POLICY ALLOWLIST CONTRADICTED THE OWNER'S DECISION. It still carried
//      "invite", and GET /pvp/me/ladder therefore advertised a payable invite
//      path plus a hardcoded `invitesPay: true`, to players, in a game where a
//      friend invite pays nothing.
//   3. A MISSING MIGRATION WAS AN UNDIAGNOSABLE SILENT NO-OP. Setting
//      PVP_LADDER_REWARDS=1 before 20260730130000 lands makes every rated battle
//      raise 42P01 and pay nothing — fail-closed, but the log said only
//      "pvp_ladder_settle_failed", which names neither the cause nor the fix.
//   4. A SYNCHRONOUS THROW IN THE REWARD BLOCK LEAKED THE ROOM. The block sits
//      between sendToUser and `setTimeout(() => battleRooms.delete(...))`, so a
//      throw there rejected endBattle AND skipped the reaper.
//   5. THE HEADER OVERSTATED THE FOREIGN KEY as "where a BOT DIES". By execution
//      the FK is unreachable: gate 3 refuses a synthetic id inside
//      computeLadderReward first, so the INSERT never runs.
//
// DB stubbing follows tests/pvpLadderWiring.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => {
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
    /** Arms finding 3: the baseline table does not exist yet. */
    baselineTableMissing: false,
  };

  const missingRelation = (relation: string) => {
    const e: any = new Error(`relation "${relation}" does not exist`);
    e.code = "42P01";
    e.meta = { code: "42P01", message: `relation "${relation}" does not exist` };
    return e;
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
      // The WITNESSED climb: lifetime sum of this account's ledger ratingDelta.
      // Matched before the windowed read below — both select FROM PvpLadderEarn.
      if (sql.includes("AS witnessed_delta")) {
        const [userId] = values;
        return [{
          witnessed_delta: state.earns
            .filter((e) => e.userId === userId)
            .reduce((a, e) => a + Number(e.ratingDelta ?? 0), 0),
        }];
      }
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
        if (state.baselineTableMissing) throw missingRelation("PvpLadderBaseline");
        return state.baselines.filter((b) => values.includes(b.userId));
      }
      throw new Error(`unmodelled query: ${sql}`);
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join("?");
      if (sql.includes('INSERT INTO "PvpLadderEarn"')) {
        // `tier` is CAPTURED, not skipped: it is the column that records which
        // rating actually priced the payment, so a clamped payout is visible in
        // the audit rather than only in the amount.
        const [id, matchId, userId, opponentUserId, , provenance, result, endReason,
          turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
          bpBeforeDecay, tier, createdAt] = values;
        for (const fk of [userId, opponentUserId]) {
          if (!state.users.has(fk)) throw new Error(`23503 FK violation: ${fk} is not a User`);
        }
        if (state.earns.some((e) => e.matchId === matchId && e.userId === userId)) return 0;
        state.earns.push({
          id, matchId, userId, opponentUserId, provenance, result, endReason,
          turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
          bpBeforeDecay, tier,
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
        if (state.baselineTableMissing) throw missingRelation("PvpLadderBaseline");
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
  LADDER_BP_ITEM_ID,
  LADDER_BP_WIN,
  LADDER_PAYABLE_PROVENANCE,
  LADDER_WITNESSED_BASE_RATING,
  LADDER_WIN_BONUS_BP,
  computeLadderReward,
  settleLadderEarn,
  structuralRefusal,
  type LadderMatchDescription,
  type LadderResult,
  type LadderSideState,
} from "../src/lib/pvpLadder.js";
import { PVP_BADGE_TIERS } from "../src/lib/pvpBadge.js";
import { parsePrizes } from "../src/lib/giveaway.js";

const BRONZE = PVP_BADGE_TIERS[0];
const DIAMOND = PVP_BADGE_TIERS[PVP_BADGE_TIERS.length - 1];

// ── Fixtures ────────────────────────────────────────────────────────

let seq = 0;
function queueRoom(): BattleRoom {
  const room: BattleRoom = {
    id: `b_r${++seq}`, status: "active", format: "random50",
    ladderProvenance: "queue",
    createdAt: Date.now() - 5 * 60_000, lastChoiceAt: Date.now(),
    a: { userId: "uA", username: "Alice", team: [] as never, stream: null, request: null, connected: true },
    b: { userId: "uB", username: "Bob", team: [] as never, stream: null, request: null, connected: true },
    log: ["|start", "|turn|1", "|turn|2", "|turn|3", "|turn|4", "|turn|5", "|turn|6", "|win|Alice"],
    stream: null, expiryTimer: null, spectators: new Set(),
  };
  battleRooms.set(room.id, room);
  return room;
}

async function finish(
  room: BattleRoom,
  reason: "ko" | "forfeit" | "cancelled" = "ko",
  sendToUser?: (userId: string, event: string, payload: unknown) => void,
): Promise<void> {
  room.winnerId = room.a.userId;
  room.loserId = room.b.userId;
  await endBattle(room, sendToUser, reason);
  await flushPvpPersists();
}

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

/** Pre-existing ledger rows for one account, as if it had already played N
 *  payable matchmade matches worth `delta` rating each. This is the ONLY way to
 *  build a witnessed climb, which is the entire point of the fix. */
function seedWitnessedClimb(userId: string, opponentUserId: string, deltas: number[]): void {
  for (const d of deltas) {
    h.state.earns.push({
      id: `seed${++seq}`, matchId: `m_seed${seq}`, userId, opponentUserId,
      provenance: "queue", result: d > 0 ? "win" : "loss", endReason: "ko",
      turns: 6, durationMs: 300_000, ratingBefore: 0, ratingAfter: 0, ratingDelta: d,
      meetingIndex: 1, bp: 0, milestoneBp: 0, moneyAwarded: 0, winBonusPaid: false,
      // Outside the rolling window, so these seeds cannot move the BP cap, the
      // decay or the meeting count — only the LIFETIME witnessed climb.
      createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000),
    });
  }
}

// ── Pure-policy fixtures ────────────────────────────────────────────

function sideState(over: Partial<LadderSideState> & { userId: string; result: LadderResult }): LadderSideState {
  const won = over.result === "win";
  return {
    opponentUserId: over.userId === "alice" ? "bob" : "alice",
    realAccount: true,
    ratingBefore: 1000,
    ratingAfter: won ? 1016 : 984,
    ratingDelta: won ? 16 : -16,
    priorMeetingsVsOpponentInWindow: 0,
    bpEarnedInWindowBeforeThis: 0,
    milestoneBpInWindowBeforeThis: 0,
    milestoneBaselineRating: 0,
    witnessedRatingDeltaBefore: 0,
    winBonusOnCooldown: false,
    milestonesAlreadyAwarded: [],
    ...over,
  };
}

function duel(a: Partial<LadderSideState> = {}, b: Partial<LadderSideState> = {}): LadderMatchDescription {
  return {
    matchId: "b_test", provenance: "queue", rated: true, endReason: "ko",
    turns: 6, durationMs: 300_000,
    sides: [
      sideState({ userId: "alice", result: "win", ...a }),
      sideState({ userId: "bob", result: "loss", ...b }),
    ],
  };
}

beforeEach(() => {
  const s = h.state;
  s.users = new Set(["uA", "uB"]);
  s.ratings = new Map();
  s.earns = []; s.bonusClaims = []; s.milestones = []; s.baselines = [];
  s.grants = []; s.matches = []; s.errors = [];
  s.baselineTableMissing = false;
  h.recordError.mockClear();
  process.env.PVP_LADDER_REWARDS = "1";
});

afterEach(() => {
  delete process.env.PVP_LADDER_REWARDS;
  vi.restoreAllMocks();
  for (const [id, room] of [...battleRooms]) {
    if (!id.startsWith("b_r")) continue;
    if (room.expiryTimer) clearInterval(room.expiryTimer);
    battleRooms.delete(id);
  }
});

// ════════════════════════════════════════════════════════════════════
// 1. RATING MANUFACTURED OFF THE PAYING PATH CANNOT PRICE THE CASH
// ════════════════════════════════════════════════════════════════════
// THE REPRODUCTION, executed against the real endBattle: an account whose live
// PlayerRating is Diamond but whose ladder has WITNESSED nothing was paid
// $200,000 for its first matchmade win. Every rating point in that 1700 came
// from paths the ladder does not pay for and where you choose your opponent —
// friend invites, which are rated by the owner's own decision, and instant
// forfeits, which need no turns, no 20s and no simulator.
//
// The fix does NOT re-spec anything the owner settled: invites stay rated,
// invites still pay nothing, and cash is still tier-priced. It changes only
// WHICH rating prices the cash, from one a ring can manufacture to one it
// cannot — which is what lib/pvpLadder.ts's anti-collusion block already
// CLAIMED was happening.
describe("the cash bonus is priced by rating the ladder has WITNESSED", () => {
  it("FINDING: a Diamond rating built entirely off the paying path pays BRONZE", async () => {
    // 1700 = the measured end state of ~448 thrown invite forfeits against 5
    // alts. No ladder rows exist for this account: not one of those matches was
    // payable, so not one of them is witnessed.
    h.state.ratings.set("uA", { rating: 1700, peakRating: 1700 });
    h.state.ratings.set("uB", { rating: 1700, peakRating: 1700 });

    await finish(queueRoom());

    // Before the fix this was DIAMOND.winBonusMoney — $200,000.
    expect(owed("uA").money).toBe(BRONZE.winBonusMoney);
    expect(owed("uA").money).not.toBe(DIAMOND.winBonusMoney);
    // …and the ledger records the tier it actually PAID, so the audit cannot be
    // read as "Diamond was underpaid".
    expect(h.state.earns.find((e) => e.userId === "uA")!.tier).toBe(BRONZE.id);
  });

  it("pays the REAL tier once the climb was actually made on the paying path", async () => {
    // Same live rating, same match — the only difference is that this account's
    // 700 points are in the ledger, i.e. they were won on the queue, against
    // opponents it did not choose, in matches that each passed every gate.
    h.state.ratings.set("uA", { rating: 1700, peakRating: 1700 });
    h.state.ratings.set("uB", { rating: 1700, peakRating: 1700 });
    seedWitnessedClimb("uA", "uOther", Array.from({ length: 22 }, () => 32));

    await finish(queueRoom());

    expect(owed("uA").money).toBe(DIAMOND.winBonusMoney);
    // The row for THIS match, not one of the seeded ones behind it.
    expect(h.state.earns.find((e) => e.userId === "uA" && e.moneyAwarded > 0)!.tier)
      .toBe(DIAMOND.id);
  });

  it("costs an honest Bronze player exactly nothing — the whole live ladder today", async () => {
    // Production, read-only, 2026-07-30: 4 PlayerRating rows, ratings 984–1016,
    // max peak 1016. Every one of them is Bronze on both numbers, so this rule
    // changes NOBODY's payout on the day it ships.
    h.state.ratings.set("uA", { rating: 1016, peakRating: 1016 });
    h.state.ratings.set("uB", { rating: 984, peakRating: 1000 });

    await finish(queueRoom());

    expect(owed("uA")).toEqual({
      bp: LADDER_BP_WIN + LADDER_WIN_BONUS_BP,
      money: BRONZE.winBonusMoney,
    });
    expect(h.state.errors).toEqual([]);
  });

  it("counts THIS match's own delta, so the witnessed rating is never stale", () => {
    // A win that crosses a tier boundary is priced at the tier it just reached,
    // not the one it left — otherwise every promotion would be paid one match
    // late for no reason.
    const atBoundary = computeLadderReward(duel({
      ratingBefore: 1099, ratingAfter: 1101, ratingDelta: 2,
      // 99 points of witnessed climb already banked, +2 from this match = 1101.
      witnessedRatingDeltaBefore: 99,
    }));
    expect(atBoundary.sides[0].pricedRating).toBe(1101);
    expect(atBoundary.sides[0].tier).toBe("silver");
  });

  it("clamps DOWN only — a witnessed climb can never price above the live rating", () => {
    // The clamp is a min(), so an account whose ledger says it climbed further
    // than its live rating (it lost those points back on invites) is priced by
    // the live rating. Paying the HIGHER of the two would be a second faucet.
    const s = computeLadderReward(duel({
      ratingBefore: 1000, ratingAfter: 1016, ratingDelta: 16,
      witnessedRatingDeltaBefore: 5_000,
    })).sides[0];
    expect(s.pricedRating).toBe(1016);
    expect(s.tier).toBe(BRONZE.id);
  });

  it("treats an UNREADABLE witnessed history as Bronze, not as unlimited", () => {
    for (const bad of [null, NaN, Infinity, undefined as unknown as number]) {
      const s = computeLadderReward(duel({
        ratingBefore: 1684, ratingAfter: 1700, ratingDelta: 16,
        witnessedRatingDeltaBefore: bad as number | null,
      })).sides[0];
      expect(s.pricedRating).toBe(LADDER_WITNESSED_BASE_RATING);
      expect(s.money).toBe(BRONZE.winBonusMoney);
    }
  });

  it("does NOT clamp the milestone, because a suppressed crossing is lost FOREVER", () => {
    // Deliberate asymmetry, and the reason is the shape of each faucet: the cash
    // bonus returns every 20h, so clamping it only derates a payment that will
    // come round again. A milestone is paid ONLY on the match that crosses the
    // threshold, so a clamp does not delay it — it destroys it, permanently, for
    // an honest player whose climb happened to be on invites. Milestones already
    // have three gates of their own (crossing, frozen baseline, once-ever key)
    // plus a per-window cap, and they mint an unspendable currency.
    const s = computeLadderReward(duel({
      ratingBefore: 1099, ratingAfter: 1101, ratingDelta: 2,
      witnessedRatingDeltaBefore: 0,   // nothing witnessed but this match itself
      milestoneBaselineRating: 1000,
    })).sides[0];
    // Cash: priced at 1000 + 0 + 2 = 1002, i.e. Bronze, not the Silver its live
    // 1101 would have bought.
    expect(s.pricedRating).toBe(LADDER_WITNESSED_BASE_RATING + 2);
    expect(s.tier).toBe(BRONZE.id);
    expect(s.money).toBe(BRONZE.winBonusMoney);
    // Milestone: PAID, on the live crossing, because a clamp here would destroy
    // it rather than derate it.
    expect(s.milestones.map((m) => m.threshold)).toEqual([1100]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. THE ALLOWLIST AGREES WITH THE OWNER'S DECISION
// ════════════════════════════════════════════════════════════════════
// MATCHMADE ONLY. Asked directly, the owner said no friendly payout.
//
// It was already enforced by omission at the room field, which is the shape that
// survives a refactor. But the POLICY layer underneath still listed "invite" as
// payable, so the defence was one layer thick: widening `BattleRoom
// .ladderProvenance` by one word would have silently re-enabled invite payouts
// with nothing beneath it to refuse them — and GET /pvp/me/ladder was already
// telling players invites pay, so that wrong change would have looked like a bug
// fix.
describe("a friend invite is refused by the POLICY too, not only by omission", () => {
  it("FINDING: the allowlist no longer carries a value the owner ruled out", () => {
    expect([...LADDER_PAYABLE_PROVENANCE]).toEqual(["queue"]);
  });

  it("refuses an invite even if a room somehow asserts one", () => {
    // The second layer: even a room that hands the settle `provenance: "invite"`
    // — which no construction site can do, and which is now also a type error —
    // is refused by the pure policy, before any query.
    expect(structuralRefusal({
      provenance: "invite", rated: true, endReason: "ko", turns: 6, durationMs: 300_000,
    })).toBe("not_human_pvp");
    expect(computeLadderReward({ ...duel(), provenance: "invite" }).eligible).toBe(false);
  });

  it("stayed an ALLOWLIST — nothing enumerates a bot anywhere", () => {
    expect((LADDER_PAYABLE_PROVENANCE as readonly string[]).includes("bot")).toBe(false);
    expect(structuralRefusal({
      provenance: undefined, rated: true, endReason: "ko", turns: 6, durationMs: 300_000,
    })).toBe("not_human_pvp");
  });

  it("FINDING: GET /pvp/me/ladder no longer tells players that invites pay", () => {
    // routes/pvp.ts hardcoded `invitesPay: true` beside a comment asserting
    // friend invites DO pay, citing 76% of matches — three player-facing
    // statements contradicting the settled decision. It mints nothing, but a
    // rewards panel built on it would promise money that never arrives.
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "routes", "pvp.ts"), "utf8",
    );
    expect(/invitesPay:\s*true/.test(src)).toBe(false);
    // …and it is DERIVED from the allowlist rather than retyped, so the two can
    // never disagree again — including if the owner ever reverses the decision.
    expect(/invitesPay:\s*\(?LADDER_PAYABLE_PROVENANCE/.test(src)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. A MISSING MIGRATION SAYS SO
// ════════════════════════════════════════════════════════════════════
describe("the deploy-order hazard is diagnosable, not just fail-closed", () => {
  it("FINDING: names the missing migration instead of logging a generic failure", async () => {
    h.state.baselineTableMissing = true;
    h.state.ratings.set("uA", { rating: 1000, peakRating: 1000 });
    h.state.ratings.set("uB", { rating: 1000, peakRating: 1000 });

    await finish(queueRoom());

    // Still fail-CLOSED: nothing is paid.
    expect(h.state.grants).toEqual([]);
    expect(h.state.earns).toEqual([]);
    // …and now LOUD in the way an operator can act on at 3am.
    const err = h.state.errors.find((e) => e.message === "pvp_ladder_migration_missing");
    expect(err).toBeTruthy();
    expect(String(err.meta.migration)).toContain("20260730130000_add_pvp_ladder_baseline");
    expect(String(err.meta.remedy)).toMatch(/migrate/i);
  });

  it("does not mistake an ordinary failure for a missing migration", async () => {
    // Aimed at the LADDER transaction only — the first $transaction of the
    // battle is applyEloUpdate's, and failing that would prove nothing about the
    // reward path.
    const original = h.prisma.$transaction;
    let calls = 0;
    h.prisma.$transaction = async (fn: any) => {
      if (++calls > 1) throw new Error("connection reset by peer");
      return original(fn);
    };
    try {
      h.state.ratings.set("uA", { rating: 1000, peakRating: 1000 });
      await finish(queueRoom());
      expect(h.state.errors.map((e) => e.message)).toContain("pvp_ladder_settle_failed");
      expect(h.state.errors.map((e) => e.message)).not.toContain("pvp_ladder_migration_missing");
    } finally {
      h.prisma.$transaction = original;
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. THE REWARD BLOCK CANNOT LEAK A ROOM
// ════════════════════════════════════════════════════════════════════
describe("a SYNCHRONOUS throw in the reward block cannot break endBattle", () => {
  it("FINDING: endBattle still resolves, the room is still reaped, the throw is recorded", async () => {
    vi.useFakeTimers();
    try {
      const room = queueRoom();
      // Arm a synchronous failure INSIDE the reward block: the first thing it
      // does after the guard is `Date.now() - outcome.startedAt`. Armed from the
      // battle:complete send, i.e. once both players already have their result,
      // which is exactly the window the block sits in.
      let armed = false;
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => {
        if (armed) { armed = false; throw new Error("synthetic synchronous failure"); }
        return realNow();
      });

      const sent: string[] = [];
      await expect(finish(room, "ko", (userId, event) => {
        sent.push(`${userId}:${event}`);
        if (event === "battle:complete") armed = true;
      })).resolves.toBeUndefined();

      // The battle result reached both humans regardless.
      expect(sent).toEqual(["uA:battle:complete", "uB:battle:complete"]);
      // The reward failure was reported rather than swallowed.
      expect(h.state.errors.map((e) => e.message)).toContain("pvp_ladder_settle_threw");
      // …and THE ROOM IS STILL REAPED. Before the fix the throw skipped this
      // timer entirely, so the room stayed in `battleRooms` forever — which
      // benches both players from the queue, from invites and from tournament
      // pairings, because "already in a battle" is checked against that map.
      vi.advanceTimersByTime(6_000);
      expect(battleRooms.has(room.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. THE HEADER'S FOREIGN-KEY CLAIM, MEASURED
// ════════════════════════════════════════════════════════════════════
describe("the bot gate's layers are documented in the order they actually fire", () => {
  it("FINDING: gate 3 refuses a synthetic opponent BEFORE any INSERT reaches the FK", async () => {
    // lib/pvpLadder.ts used to present the FOREIGN KEY as layer 2, "where a BOT
    // DIES", predicting a 23503 and a logged pvp_ladder_settle_failed. By
    // execution the FK is unreachable: `saveVersion > 0` refuses the synthetic id
    // inside computeLadderReward first, which is a LadderRefusal, so the INSERT
    // never runs and nothing is logged. It still fails CLOSED either way — the
    // claim was just stated more strongly than it is true.
    const settled = await settleLadderEarn({
      matchId: "b_fk", provenance: "queue",
      winnerId: "uA", loserId: "bot:b_fk", endReason: "ko",
      logLines: ["|turn|1", "|turn|2", "|turn|3", "|turn|4"],
      durationMs: 300_000,
      ratingDelta: { aDelta: 16, bDelta: -16, aRating: 1016, bRating: 984 },
    });
    expect(settled.paid).toBe(false);
    expect(settled.reason).toBe("opponent_not_a_real_account");
    // No FK error, because no INSERT ran.
    expect(h.state.earns).toEqual([]);
    expect(h.state.errors).toEqual([]);
  });

  it("the header says so, rather than claiming the FK is what kills a bot", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "pvpLadder.ts"), "utf8",
    );
    const header = src.slice(0, src.indexOf('import { randomBytes }'));
    expect(header).toContain("UNREACHABLE IN PRACTICE");
    expect(/where a BOT DIES/i.test(header)).toBe(false);
  });
});
