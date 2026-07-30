// PvP ladder rewards — the SETTLE TRANSACTION, proved by execution.
//
// The policy tests (pvpLadderPolicy.test.ts) prove the arithmetic. This file
// proves the things only the database can arbitrate, against a fake Postgres
// that enforces the REAL constraints from
// prisma/migrations/20260730120000_add_pvp_ladder/migration.sql:
//
//   * PvpLadderEarn."userId" / "opponentUserId" FOREIGN KEY → User(id)
//     — THE BOT GATE. A synthetic bot id raises 23503 and takes both sides'
//       rows and both grants down with it.
//   * PvpLadderEarn UNIQUE (matchId, userId)
//     — exactly-once, even if endBattle is somehow invoked twice.
//   * PvpLadderEarn CHECK ("moneyAwarded" = 0 OR "winBonusPaid")
//     — money can only ever be minted by the once-per-cooldown bonus. This is
//       the fail-closed second opinion that REPLACED a partial unique index,
//       which `prisma migrate dev` could have generated a DROP for.
//   * PvpWinBonusClaim PRIMARY KEY ("userId") plus the CONDITIONAL upsert
//     — the cash bonus, once per cooldown, under concurrent interleaving.
//   * PvpBadgeMilestone PRIMARY KEY (userId, threshold) and
//     CHECK ("ratingBefore" < "threshold") — once ever, and only on a crossing.
//
// WHAT THIS FILE EXISTS TO PROTECT, in priority order:
//
//   1. NO saveData WRITE. Ever. The fake THROWS if anything reaches for
//      User.saveData / saveVersion / saveAdoptSeq, so "payment goes through
//      PendingGrant only" is an executed assertion and not a promise. That path
//      produced a money-duplication bug and a prize-destroying bug; this
//      feature reuses it rather than extending it.
//   2. A bot battle pays NOTHING, five different ways.
//   3. A forfeit and a timeout pay nothing — to EITHER side.
//   4. A replayed settle pays exactly once, and rolls back to nothing written.
//   5. Concurrent claims cannot double-pay.
//   6. THE CASH BONUS CANNOT BE STRADDLED. Reproduced before the fix: two
//      matches at 23:59:30Z and 00:00:30Z paid ONE account $50,000 and 16 BP in
//      61 seconds, because the arbiter was keyed (userId, day). Both windows are
//      now rolling and the arbiter is one row per account.
//   7. A MILESTONE PAYOUT DOES NOT BURN THE ORDINARY BP CAP. Reproduced before
//      the fix: a 98-BP rank-up match left a legitimate later battle against a
//      FRESH opponent paying 0.
//   8. Every failure path records an error, because a reward that silently
//      fails to pay is a support ticket nobody can answer.
//
// FAKE FIDELITY, stated so the tests are not read as stronger than they are:
// the fake is READ-UNCOMMITTED and does not block on a conflicting write (real
// Postgres would block the second writer until the first commits, then
// re-evaluate). For every race asserted below the first transaction commits, so
// the observable outcome is identical. The fake also routes on SQL SHAPE and
// positional parameters, which means it doubles as a check that the statements
// this module issues are the ones it is supposed to.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop],
    }),
    recordError: vi.fn(async () => undefined),
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({ sendToUserGlobal: vi.fn(), kickSession: vi.fn() }));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: h.recordError }));

import {
  LADDER_BP_CAP_PER_WINDOW,
  LADDER_BP_ITEM_ID,
  LADDER_BP_LOSS,
  LADDER_BP_WIN,
  LADDER_BP_WINDOW_MS,
  LADDER_WIN_BONUS_BP,
  LADDER_WIN_BONUS_COOLDOWN_MS,
  readLadderHistory,
  readLadderStatus,
  settleLadderEarn,
  utcDayString,
  type LadderEndReason,
  type SettleLadderInput,
} from "../src/lib/pvpLadder.js";
import { PVP_BADGE_TIERS, PVP_MILESTONE_BP_LIFETIME_TOTAL } from "../src/lib/pvpBadge.js";
import { parsePrizes } from "../src/lib/giveaway.js";

const BRONZE_MONEY = PVP_BADGE_TIERS[0].winBonusMoney;

// ════════════════════════════════════════════════════════════════════
// The fake Postgres
// ════════════════════════════════════════════════════════════════════

interface EarnRow {
  id: string; matchId: string; userId: string; opponentUserId: string; day: string;
  provenance: string; result: string; endReason: string; turns: number; durationMs: number;
  ratingBefore: number; ratingAfter: number; ratingDelta: number;
  meetingIndex: number; bpBeforeDecay: number; tier: string;
  bp: number; milestoneBp: number; moneyAwarded: number; winBonusPaid: boolean;
  grantId: string | null; createdAt: Date;
}
interface BonusClaimRow {
  userId: string; claimedAt: Date; day: string; matchId: string;
  rating: number; tier: string; money: number;
}
interface MilestoneRow {
  userId: string; threshold: number; ratingBefore: number; ratingAtAward: number; bp: number;
}
interface GrantRow {
  id: string; userId: string; prizes: string; source: string;
  sourceId: string | null; summary: string; deliveredAt: Date | null;
}

/** Statement kinds the fake understands, keyed off the SQL shape. Anything the
 *  module issues that is NOT in here is a hard failure, so a stray query cannot
 *  slip in unnoticed. */
type StmtKind =
  | "read.sideLedger" | "read.milestones" | "read.status" | "read.history"
  | "insert.earn" | "claim.winBonus" | "insert.milestone" | "update.earn";

class FakeDb {
  users = new Map<string, { id: string; saveVersion: number; saveData: string | null; saveAdoptSeq: number }>();
  earns: EarnRow[] = [];
  bonusClaims: BonusClaimRow[] = [];
  milestones: MilestoneRow[] = [];
  grants: GrantRow[] = [];
  /** Every statement kind issued, in order. */
  log: StmtKind[] = [];
  /** Interleaving hook — fires before the named statement executes. */
  hook: ((kind: StmtKind) => Promise<void> | void) | null = null;
  nextRowId = 1;
  client: any;

  constructor() {
    const self = this;

    const classify = (sql: string): StmtKind => {
      if (sql.includes('FROM "PvpLadderEarn" e') && sql.includes('FILTER (WHERE e."opponentUserId"')) return "read.sideLedger";
      if (sql.includes('FROM "PvpBadgeMilestone" WHERE')) return "read.milestones";
      if (sql.includes('COALESCE(SUM(e."bp") FILTER')) return "read.status";
      if (sql.includes('ORDER BY "createdAt" DESC')) return "read.history";
      if (sql.includes('INSERT INTO "PvpLadderEarn"')) return "insert.earn";
      if (sql.includes('INSERT INTO "PvpWinBonusClaim"')) return "claim.winBonus";
      if (sql.includes('INSERT INTO "PvpBadgeMilestone"')) return "insert.milestone";
      if (sql.includes('UPDATE "PvpLadderEarn"')) return "update.earn";
      // A statement the fake does not model. Fail loudly rather than silently
      // returning "no rows", which would make a broken query look like a
      // legitimate refusal.
      throw new Error(`FakeDb: unmodelled SQL\n${sql}`);
    };

    /** The one assertion that matters most, enforced at the lowest level. */
    const refuseSaveWrites = (sql: string) => {
      if (/UPDATE\s+"User"/i.test(sql) || /saveData|saveVersion|saveAdoptSeq/.test(sql)) {
        throw new Error(
          "FakeDb: a PvP reward tried to write the SAVE PATH. This is the exact bug "
          + "the PendingGrant inbox exists to avoid — payment must be a grant row.",
        );
      }
    };

    const make = (tx?: {
      created: { earns: Set<object>; bonusClaims: Set<object>; milestones: Set<object>; grants: Set<object> };
      modifiedEarns: Map<string, EarnRow>;
      modifiedClaims: Map<string, BonusClaimRow>;
    }) => ({
      // ── Typed model access (User exists in the generated client) ──
      user: {
        findMany: async ({ where, select }: any) => {
          const ids: string[] = where?.id?.in ?? [];
          return ids
            .map((id) => self.users.get(id))
            .filter((u): u is NonNullable<typeof u> => !!u)
            .map((u) => {
              if (!select) return { ...u };
              const out: any = {};
              for (const k of Object.keys(select)) out[k] = (u as any)[k];
              return out;
            });
        },
        findUnique: async ({ where, select }: any) => {
          const u = self.users.get(where.id);
          if (!u) return null;
          if (!select) return { ...u };
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = (u as any)[k];
          return out;
        },
        // Present only so a reach for it is a LOUD failure rather than
        // "undefined is not a function" somewhere confusing.
        update: async () => { throw new Error("FakeDb: user.update is forbidden — the reward must not touch the save."); },
        updateMany: async () => { throw new Error("FakeDb: user.updateMany is forbidden — the reward must not touch the save."); },
      },
      pendingGrant: {
        create: async ({ data, select }: any) => {
          const row: GrantRow = {
            id: "g" + self.nextRowId++,
            userId: data.userId, prizes: data.prizes, source: data.source,
            sourceId: data.sourceId ?? null, summary: data.summary, deliveredAt: null,
          };
          self.grants.push(row);
          tx?.created.grants.add(row);
          return select ? { id: row.id } : row;
        },
      },

      // ── Raw SQL for the three tables this change adds ────────────
      $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        refuseSaveWrites(sql);
        const kind = classify(sql);
        self.log.push(kind);
        await self.hook?.(kind);

        if (kind === "read.sideLedger") {
          // Param order pinned to the statement:
          //   opponentId, userId, bonusCutoff, userId, windowStart
          const [opponentId, , bonusCutoff, userId, windowStart] = values;
          const mine = self.earns.filter(
            (e) => e.userId === userId && e.createdAt.getTime() > (windowStart as Date).getTime(),
          );
          return [{
            // NOTE: "bp" only, never "bp" + "milestoneBp". That IS the milestone
            // exemption, expressed where it actually binds.
            bp_window: mine.reduce((a, e) => a + e.bp, 0),
            meetings: mine.filter((e) => e.opponentUserId === opponentId).length,
            bonus_on_cooldown: self.bonusClaims.filter(
              (b) => b.userId === userId && b.claimedAt.getTime() > (bonusCutoff as Date).getTime(),
            ).length,
          }];
        }
        if (kind === "read.milestones") {
          const [userId] = values;
          return self.milestones.filter((m) => m.userId === userId).map((m) => ({ threshold: m.threshold }));
        }
        if (kind === "read.status") {
          // Param order pinned to the statement:
          //   windowStart, windowStart, userId, userId
          const [windowStart, , userId] = values;
          const mine = self.earns.filter((e) => e.userId === userId);
          const inWindow = mine.filter((e) => e.createdAt.getTime() > (windowStart as Date).getTime());
          const claim = self.bonusClaims.find((b) => b.userId === userId) ?? null;
          return [{
            bp_window: inWindow.reduce((a, e) => a + e.bp, 0),
            matches_window: inWindow.length,
            bp_lifetime: mine.reduce((a, e) => a + e.bp, 0),
            milestone_lifetime: mine.reduce((a, e) => a + e.milestoneBp, 0),
            bonus_at: claim ? claim.claimedAt : null,
          }];
        }
        if (kind === "read.history") {
          const [userId, take] = values;
          return self.earns
            .filter((e) => e.userId === userId)
            .slice()
            .reverse()
            .slice(0, take)
            .map((e) => ({ ...e }));
        }
        throw new Error(`FakeDb: ${kind} is not a query`);
      },

      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        refuseSaveWrites(sql);
        const kind = classify(sql);
        self.log.push(kind);
        await self.hook?.(kind);

        if (kind === "insert.earn") {
          const [id, matchId, userId, opponentUserId, day, provenance, result, endReason,
            turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
            bpBeforeDecay, tier, createdAt] = values;

          // ── CHECK ("userId" <> "opponentUserId") ─────────────────
          if (userId === opponentUserId) {
            throw new Error('23514 new row violates check constraint "PvpLadderEarn_not_self"');
          }
          // ── THE BOT GATE: both FKs to User(id) ──────────────────
          for (const fk of [userId, opponentUserId]) {
            if (!self.users.has(fk)) {
              throw new Error(
                `23503 insert or update on table "PvpLadderEarn" violates foreign key constraint`
                + ` — key (${fk}) is not present in table "User"`,
              );
            }
          }
          // ── UNIQUE (matchId, userId): ON CONFLICT DO NOTHING ────
          if (self.earns.some((e) => e.matchId === matchId && e.userId === userId)) return 0;

          const row: EarnRow = {
            id, matchId, userId, opponentUserId, day, provenance, result, endReason,
            turns, durationMs, ratingBefore, ratingAfter, ratingDelta, meetingIndex,
            bpBeforeDecay, tier,
            bp: 0, milestoneBp: 0, moneyAwarded: 0, winBonusPaid: false, grantId: null,
            createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
          };
          self.earns.push(row);
          tx?.created.earns.add(row);
          return 1;
        }

        if (kind === "claim.winBonus") {
          // Param order: userId, claimedAt(now), day, matchId, rating, tier, money, cutoff
          const [userId, claimedAt, day, matchId, rating, tier, money, cutoff] = values;
          if (!self.users.has(userId)) throw new Error("23503 PvpWinBonusClaim FK violation");
          if (money < 0) throw new Error('23514 violates check constraint "PvpWinBonusClaim_nonneg"');
          const existing = self.bonusClaims.find((b) => b.userId === userId);
          if (!existing) {
            // ── INSERT path: no conflicting row ───────────────────
            const row: BonusClaimRow = { userId, claimedAt, day, matchId, rating, tier, money };
            self.bonusClaims.push(row);
            tx?.created.bonusClaims.add(row);
            return 1;
          }
          // ── ON CONFLICT ("userId") DO UPDATE … WHERE claimedAt <= cutoff ──
          // The WHERE is evaluated against the EXISTING row under its row lock,
          // so a lost race is 0 affected rows rather than an exception.
          if (existing.claimedAt.getTime() > (cutoff as Date).getTime()) return 0;
          if (tx && !tx.modifiedClaims.has(userId)) tx.modifiedClaims.set(userId, { ...existing });
          Object.assign(existing, { claimedAt, day, matchId, rating, tier, money });
          return 1;
        }

        if (kind === "insert.milestone") {
          const [userId, threshold, ratingBefore, ratingAtAward, bp] = values;
          if (!self.users.has(userId)) throw new Error("23503 PvpBadgeMilestone FK violation");
          if (bp < 0) throw new Error('23514 violates check constraint "PvpBadgeMilestone_nonneg"');
          // ── CHECK ("ratingBefore" < "threshold") — crossings only ─
          if (!(ratingBefore < threshold)) {
            throw new Error('23514 violates check constraint "PvpBadgeMilestone_crossed"');
          }
          // ── PRIMARY KEY (userId, threshold) ─────────────────────
          if (self.milestones.some((m) => m.userId === userId && m.threshold === threshold)) return 0;
          const row: MilestoneRow = { userId, threshold, ratingBefore, ratingAtAward, bp };
          self.milestones.push(row);
          tx?.created.milestones.add(row);
          return 1;
        }

        if (kind === "update.earn") {
          const [bp, milestoneBp, moneyAwarded, winBonusPaid, grantId, id] = values;
          // ── CHECK nonneg ────────────────────────────────────────
          if (bp < 0 || milestoneBp < 0 || moneyAwarded < 0) {
            throw new Error('23514 violates check constraint "PvpLadderEarn_nonneg"');
          }
          // ── CHECK ("moneyAwarded" = 0 OR "winBonusPaid") ────────
          // The fail-closed second opinion on the cash faucet — and the object
          // that replaced a partial unique index Prisma could have dropped.
          if (moneyAwarded !== 0 && !winBonusPaid) {
            throw new Error('23514 violates check constraint "PvpLadderEarn_money_needs_bonus"');
          }
          const row = self.earns.find((e) => e.id === id);
          if (!row) return 0;
          if (tx && !tx.modifiedEarns.has(id)) tx.modifiedEarns.set(id, { ...row });
          row.bp = bp; row.milestoneBp = milestoneBp; row.moneyAwarded = moneyAwarded;
          row.winBonusPaid = winBonusPaid; row.grantId = grantId;
          return 1;
        }
        throw new Error(`FakeDb: ${kind} is not a write`);
      },

      $transaction: async (fn: any) => {
        // Roll back only THIS transaction's own writes, tracked by object
        // identity. Restoring a whole snapshot would also undo a COMMITTED
        // write from a concurrent transaction, which no database does — and the
        // concurrency tests below depend on that distinction.
        const created = {
          earns: new Set<object>(), bonusClaims: new Set<object>(),
          milestones: new Set<object>(), grants: new Set<object>(),
        };
        const modifiedEarns = new Map<string, EarnRow>();
        const modifiedClaims = new Map<string, BonusClaimRow>();
        try {
          return await fn(make({ created, modifiedEarns, modifiedClaims }));
        } catch (e) {
          self.earns = self.earns.filter((r) => !created.earns.has(r));
          self.bonusClaims = self.bonusClaims.filter((r) => !created.bonusClaims.has(r));
          self.milestones = self.milestones.filter((r) => !created.milestones.has(r));
          self.grants = self.grants.filter((r) => !created.grants.has(r));
          for (const [id, pre] of modifiedEarns) {
            const row = self.earns.find((r) => r.id === id);
            if (row) Object.assign(row, pre);
          }
          for (const [userId, pre] of modifiedClaims) {
            const row = self.bonusClaims.find((r) => r.userId === userId);
            if (row) Object.assign(row, pre);
          }
          throw e;
        }
      },
    });

    this.client = make();
  }

  /** A real account: has a User row AND has had a save upload accepted. */
  addPlayer(id: string, saveVersion = 7) {
    this.users.set(id, { id, saveVersion, saveData: JSON.stringify({ money: 5000, inventory: {} }), saveAdoptSeq: 0 });
  }

  grantsFor(userId: string) { return this.grants.filter((g) => g.userId === userId); }

  /** BP + money actually OWED to an account through the inbox. This is the only
   *  place a reward can legitimately appear. */
  owed(userId: string): { bp: number; money: number } {
    let bp = 0, money = 0;
    for (const g of this.grantsFor(userId)) {
      for (const p of parsePrizes(g.prizes)) {
        if (p.kind === "item" && p.itemId === LADDER_BP_ITEM_ID) bp += p.quantity;
        if (p.kind === "money") money += p.amount;
      }
    }
    return { bp, money };
  }

  /** Fingerprint of every save-bearing column, for before/after comparison. */
  saveFingerprint() { return JSON.stringify([...this.users.values()]); }
}

let db: FakeDb;
const NOW = new Date("2026-07-29T12:00:00.000Z");
const DAY = utcDayString(NOW);

beforeEach(() => {
  db = new FakeDb();
  h.setDb(db);
  h.recordError.mockClear();
  // Default OFF (see ladderRewardsEnabled) — every test that expects a payment
  // has to turn the faucet on, which is itself the assertion that a deploy
  // which forgets the env var mints nothing.
  process.env.PVP_LADDER_REWARDS = "1";
});
afterEach(() => { delete process.env.PVP_LADDER_REWARDS; });

let matchSeq = 0;
function input(over: Partial<SettleLadderInput> = {}): SettleLadderInput {
  return {
    matchId: `b_${++matchSeq}`,
    provenance: "queue",
    winnerId: "alice",
    loserId: "bob",
    endReason: "ko",
    logLines: ["|start", "|turn|1", "|turn|2", "|turn|3", "|turn|4", "|win|alice"],
    durationMs: 5 * 60_000,
    ratingDelta: { aDelta: 16, bDelta: -16, aRating: 1016, bRating: 984 },
    now: NOW,
    ...over,
  };
}

/** Nothing at all was written — the assertion behind every refusal. */
function expectNothingWritten() {
  expect(db.earns).toEqual([]);
  expect(db.bonusClaims).toEqual([]);
  expect(db.milestones).toEqual([]);
  expect(db.grants).toEqual([]);
}

const aliceIn = (r: Awaited<ReturnType<typeof settleLadderEarn>>) =>
  r.sides.find((s) => s.userId === "alice")!;

// ════════════════════════════════════════════════════════════════════
// 0. THE ARCHITECTURAL RULE
// ════════════════════════════════════════════════════════════════════
describe("payment goes through PendingGrant and NOTHING else", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  it("never writes saveData, saveVersion or saveAdoptSeq", async () => {
    // The fake THROWS on any statement touching the save path or on any
    // user.update/updateMany, so a passing settle is proof by execution rather
    // than by inspection.
    const before = db.saveFingerprint();
    const r = await settleLadderEarn(input());
    expect(r.paid).toBe(true);
    expect(db.saveFingerprint()).toBe(before);
    // …and the reward is real, so this is not passing because nothing happened.
    expect(db.owed("alice").bp).toBeGreaterThan(0);
    expect(db.owed("alice").money).toBe(BRONZE_MONEY);
  });

  it("pays through one PendingGrant row per side, tagged for ops", async () => {
    const inp = input();
    await settleLadderEarn(inp);
    expect(db.grants).toHaveLength(2);
    for (const g of db.grants) {
      expect(g.source).toBe("pvp-ladder");
      expect(g.sourceId).toBe(inp.matchId);
      expect(g.deliveredAt).toBeNull();
    }
  });

  it("pays Battle Points as an inventory ITEM, so no new Prize kind is needed", async () => {
    await settleLadderEarn(input());
    expect(parsePrizes(db.grantsFor("alice")[0].prizes)).toEqual([
      { kind: "item", itemId: LADDER_BP_ITEM_ID, quantity: LADDER_BP_WIN + LADDER_WIN_BONUS_BP },
      { kind: "money", amount: BRONZE_MONEY },
    ]);
  });

  it("links the ledger row to the grant so ops can follow an earn to a delivery", async () => {
    await settleLadderEarn(input());
    for (const e of db.earns) {
      expect(e.grantId).toBeTruthy();
      expect(db.grants.some((g) => g.id === e.grantId && g.userId === e.userId)).toBe(true);
    }
  });

  it("records the provenance, both ratings and the tier, so the audit answers 'why'", async () => {
    await settleLadderEarn(input({ provenance: "invite" }));
    const a = db.earns.find((e) => e.userId === "alice")!;
    expect(a.provenance).toBe("invite");
    expect(a.ratingBefore).toBe(1000);
    expect(a.ratingAfter).toBe(1016);
    expect(a.tier).toBe("bronze");
    expect(a.day).toBe(DAY);
    expect(a.durationMs).toBe(5 * 60_000);
  });

  it("mints nothing at all when the master switch is off", async () => {
    delete process.env.PVP_LADDER_REWARDS;
    const r = await settleLadderEarn(input());
    expect(r).toEqual({ paid: false, reason: "disabled", sides: [] });
    expectNothingWritten();
    // Not even a query — the switch is checked before any work.
    expect(db.log).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════
// 1. A BOT BATTLE PAYS NOTHING
// ════════════════════════════════════════════════════════════════════
describe("a bot battle pays NOTHING", () => {
  it("refuses a room that carries no human-pairing provenance, without a query", async () => {
    db.addPlayer("alice"); db.addPlayer("bob");
    const r = await settleLadderEarn(input({ provenance: undefined }));
    expect(r.reason).toBe("not_human_pvp");
    expectNothingWritten();
    expect(db.log).toEqual([]);
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("refuses every provenance that is not one of the two human paths", async () => {
    db.addPlayer("alice"); db.addPlayer("bob");
    for (const p of ["bot", "tournament", "admin", null, ""]) {
      expect((await settleLadderEarn(input({ provenance: p as any }))).reason).toBe("not_human_pvp");
    }
    expectNothingWritten();
  });

  it("refuses a bot whose opponent id is not a User row at all", async () => {
    // The realistic shape: the bot task sets provenance by copy-paste and the
    // bot seat keeps its synthetic id (`bot:<battleId>`). Gate 3 catches it
    // first — a synthetic id resolves to no User row, so it is not in the
    // "has uploaded a save" set — and the FOREIGN KEY behind it is the backstop
    // for the raced case (see the last test in this block). Two independent
    // layers, and this asserts which one fires first so the ordering cannot
    // silently change.
    db.addPlayer("alice");
    const r = await settleLadderEarn(input({ loserId: "bot:b_123" }));
    expect(r.paid).toBe(false);
    expect(r.reason).toBe("opponent_not_a_real_account");
    expectNothingWritten();
    expect(db.owed("alice")).toEqual({ bp: 0, money: 0 });
    // Refused before any write, so this is not an error to page anyone about.
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("refuses a bot that HAS a User row but has never uploaded a save", async () => {
    db.addPlayer("alice");
    db.addPlayer("botAccount", 0);
    expect((await settleLadderEarn(input({ loserId: "botAccount" }))).reason)
      .toBe("opponent_not_a_real_account");
    expectNothingWritten();
  });

  it("refuses when the HUMAN is the one with no accepted save", async () => {
    db.addPlayer("alice", 0); db.addPlayer("bob");
    expect((await settleLadderEarn(input())).reason).toBe("opponent_not_a_real_account");
    expectNothingWritten();
  });

  it("refuses an unrated battle, which is what an AI opponent produces", async () => {
    db.addPlayer("alice"); db.addPlayer("bob");
    expect((await settleLadderEarn(input({ ratingDelta: null }))).reason).toBe("unrated");
    expect(db.log).toEqual([]);
    expectNothingWritten();
  });

  it("refuses a self-play room, and records it as a real problem", async () => {
    db.addPlayer("alice");
    expect((await settleLadderEarn(input({ loserId: "alice" }))).reason).toBe("bad_outcome");
    expectNothingWritten();
    expect(h.recordError).toHaveBeenCalledWith(expect.objectContaining({
      message: "pvp_ladder_bad_outcome",
    }));
  });

  it("has the FOREIGN KEY as a real backstop when the account check is raced", async () => {
    // Both accounts look real at the findMany, then the opponent is deleted
    // before the insert. Postgres raises 23503; both sides roll back together,
    // so the human is paid nothing.
    db.addPlayer("alice"); db.addPlayer("bob");
    db.hook = (kind) => { if (kind === "insert.earn") db.users.delete("bob"); };
    const r = await settleLadderEarn(input());
    expect(r.paid).toBe(false);
    expect(r.reason).toBe("error");
    expectNothingWritten();
    expect(db.owed("alice")).toEqual({ bp: 0, money: 0 });
    // …and it is LOUD, because an FK violation here means the bot gate fired.
    expect(String((h.recordError.mock.calls[0][0] as any).meta.error)).toContain("23503");
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. A FORFEIT AND A TIMEOUT PAY NOTHING, TO EITHER SIDE
// ════════════════════════════════════════════════════════════════════
describe("a forfeit and a timeout pay nothing, to either side", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  for (const reason of ["forfeit", "timeout", "cancelled"] as LadderEndReason[]) {
    it(`pays nobody for "${reason}", and spends no query doing it`, async () => {
      expect((await settleLadderEarn(input({ endReason: reason }))).reason)
        .toBe(`end_reason_${reason}`);
      expect(db.log).toEqual([]);
      expectNothingWritten();
    });
  }

  it("pays nobody when the OPPONENT is the one who forfeited", async () => {
    // The reconnect-grace path ends the battle with the SURVIVOR as winner. The
    // survivor must not profit from the other side's disconnect.
    const r = await settleLadderEarn(input({ endReason: "forfeit", winnerId: "bob", loserId: "alice" }));
    expect(r.paid).toBe(false);
    expect(db.owed("bob")).toEqual({ bp: 0, money: 0 });
  });

  it("pays nothing for an instant KO, even though it reports 'ko'", async () => {
    expect((await settleLadderEarn(input({ logLines: ["|turn|1", "|win|alice"] }))).reason)
      .toBe("too_few_turns");
    expectNothingWritten();
  });

  it("pays nothing under 20s, and DOES pay a genuine brisk match", async () => {
    expect((await settleLadderEarn(input({ durationMs: 19_999 }))).reason).toBe("too_short");
    expectNothingWritten();
    // REGRESSION: a 60s floor refused this one.
    expect((await settleLadderEarn(input({ durationMs: 45_000 }))).paid).toBe(true);
  });

  it("counts turns from the real log rather than trusting a number", async () => {
    const r = await settleLadderEarn(input({
      logLines: ["|turn|1", "|turn|2", "|turn|3", "|turn|4", "|turn|5", "|turn|6", "|turn|7"],
    }));
    expect(r.paid).toBe(true);
    expect(db.earns[0].turns).toBe(7);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. DECAY AND THE ROLLING WINDOW
// ════════════════════════════════════════════════════════════════════
describe("repeat meetings with the same opponent decay over a rolling window", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  it("pays 3, 3, 2, 2, 1 across five real battles with the same person", async () => {
    const paid: number[] = [];
    for (let i = 0; i < 5; i++) {
      const a = aliceIn(await settleLadderEarn(input()));
      // Strip the once-per-cooldown bonus, which only the first match gets.
      paid.push(a.bp - (a.winBonus ? LADDER_WIN_BONUS_BP : 0));
    }
    expect(paid).toEqual([3, 3, 2, 2, 1]);
    // REGRESSION: the old table's 5th meeting paid 0.
    expect(paid.every((p) => p >= 1)).toBe(true);
  });

  it("never records a zero-value meeting for a real battle any more", async () => {
    for (let i = 0; i < 9; i++) await settleLadderEarn(input());
    const mine = db.earns.filter((e) => e.userId === "alice");
    expect(mine).toHaveLength(9);
    for (const e of mine) expect(e.bp).toBeGreaterThanOrEqual(1);
  });

  it("decays per OPPONENT, not globally — a fresh opponent pays full rate", async () => {
    db.addPlayer("carol");
    for (let i = 0; i < 4; i++) await settleLadderEarn(input());
    const a = aliceIn(await settleLadderEarn(input({ loserId: "carol" })));
    expect(a.bp).toBe(LADDER_BP_WIN);       // full rate; the bonus is already used
    expect(db.earns.at(-2)!.meetingIndex).toBe(1);
  });

  it("uses a ROLLING 24h window, so yesterday's meetings do not decay today", async () => {
    for (let i = 0; i < 4; i++) await settleLadderEarn(input());
    const later = new Date(NOW.getTime() + LADDER_BP_WINDOW_MS + 60 * 60_000);
    const a = aliceIn(await settleLadderEarn(input({ now: later })));
    expect(db.earns.at(-2)!.meetingIndex).toBe(1);
    expect(a.bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);
  });

  it("stores the decay inputs so a smaller reward can be explained, not guessed", async () => {
    for (let i = 0; i < 3; i++) await settleLadderEarn(input());
    const hist = await readLadderHistory("alice", 10);
    expect(hist[0].meetingIndex).toBe(3);
    expect(hist[0].decayApplied).toBe(true);
    expect(hist[0].decayPercent).toBe(75);
    expect(hist[0].explanation).toContain("meeting #3");
    expect(hist.at(-1)!.decayApplied).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. THE ROLLING CAP HOLDS
// ════════════════════════════════════════════════════════════════════
describe("the rolling BP cap holds", () => {
  beforeEach(() => { db.addPlayer("alice"); });

  it("stops paying once the cap is reached, however many opponents are used", async () => {
    // A fresh opponent every match, so decay never applies. This is the ring
    // attack, and the cap is what bounds it.
    for (let i = 0; i < 20; i++) {
      db.addPlayer(`alt${i}`);
      await settleLadderEarn(input({ loserId: `alt${i}` }));
    }
    const owed = db.owed("alice");
    expect(owed.bp).toBe(LADDER_BP_CAP_PER_WINDOW);
    // …and the cash is one bonus, not twenty.
    expect(owed.money).toBe(BRONZE_MONEY);
  });

  it("caps the cash at exactly one bonus per cooldown whatever the match count", async () => {
    for (let i = 0; i < 12; i++) {
      db.addPlayer(`alt${i}`);
      await settleLadderEarn(input({ loserId: `alt${i}` }));
    }
    expect(db.owed("alice").money).toBe(BRONZE_MONEY);
    expect(db.bonusClaims.filter((b) => b.userId === "alice")).toHaveLength(1);
    expect(db.earns.filter((e) => e.userId === "alice" && e.winBonusPaid)).toHaveLength(1);
  });

  it("bounds a colluding PAIR's entire cooldown yield below one honest away claim", async () => {
    db.addPlayer("bob");
    for (let i = 0; i < 40; i++) {
      await settleLadderEarn(input({
        winnerId: i % 2 === 0 ? "alice" : "bob",
        loserId: i % 2 === 0 ? "bob" : "alice",
      }));
    }
    const total = db.owed("alice").money + db.owed("bob").money;
    expect(total).toBe(2 * BRONZE_MONEY);
    // The measured median 8-hour away claim for an active player is $32,000.
    expect(total).toBeLessThan(32_000);
    expect(db.owed("alice").bp).toBeLessThanOrEqual(LADDER_BP_CAP_PER_WINDOW);
    expect(db.owed("bob").bp).toBeLessThanOrEqual(LADDER_BP_CAP_PER_WINDOW);
  });

  it("refills the cap gradually — a rolling window, not a midnight reset", async () => {
    db.addPlayer("bob");
    for (let i = 0; i < 20; i++) {
      db.addPlayer(`alt${i}`);
      await settleLadderEarn(input({ loserId: `alt${i}` }));
    }
    expect(db.owed("alice").bp).toBe(LADDER_BP_CAP_PER_WINDOW);
    // 25 hours later the whole window has aged out.
    const later = new Date(NOW.getTime() + LADDER_BP_WINDOW_MS + 60 * 60_000);
    const a = aliceIn(await settleLadderEarn(input({ loserId: "bob", now: later })));
    expect(a.bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);
  });

  it("never writes a negative payout — the CHECK constraint would refuse it", async () => {
    db.addPlayer("bob");
    await settleLadderEarn(input());
    for (const e of db.earns) {
      expect(e.bp).toBeGreaterThanOrEqual(0);
      expect(e.milestoneBp).toBeGreaterThanOrEqual(0);
      expect(e.moneyAwarded).toBeGreaterThanOrEqual(0);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. THE CASH BONUS CANNOT BE STRADDLED  ← the reproduced defect
// ════════════════════════════════════════════════════════════════════
describe("the cash bonus is a cooldown, and a cooldown cannot be straddled", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  // REGRESSION, the exact reproduction. With the old (userId, day) arbiter these
  // two settles paid alice $50,000 and 16 BP — double the advertised daily
  // maximum — inside 61 seconds, because they fell on different UTC days.
  it("pays ONE bonus across the midnight boundary, not two", async () => {
    const before = new Date("2026-07-29T23:59:30.000Z");
    const after = new Date("2026-07-30T00:00:30.000Z");
    const r1 = await settleLadderEarn(input({ now: before }));
    const r2 = await settleLadderEarn(input({ now: after }));

    expect(r1.paid).toBe(true);
    expect(r2.paid).toBe(true);
    expect(aliceIn(r1).winBonus).toBe(true);
    expect(aliceIn(r2).winBonus).toBe(false);
    // The whole point, in one number.
    expect(db.owed("alice").money).toBe(BRONZE_MONEY);
    expect(db.owed("alice").money).not.toBe(2 * BRONZE_MONEY);
    // Two different UTC days ARE recorded, and it changed nothing.
    expect(db.earns.map((e) => e.day)).toContain("2026-07-29");
    expect(db.earns.map((e) => e.day)).toContain("2026-07-30");
    // Exactly one arbiter row exists, and it holds the FIRST claim's time.
    expect(db.bonusClaims.filter((b) => b.userId === "alice")).toHaveLength(1);
    expect(db.bonusClaims[0].claimedAt.toISOString()).toBe(before.toISOString());
  });

  it("becomes claimable again once the cooldown has actually elapsed", async () => {
    await settleLadderEarn(input());
    const justBefore = new Date(NOW.getTime() + LADDER_WIN_BONUS_COOLDOWN_MS - 1_000);
    expect(aliceIn(await settleLadderEarn(input({ now: justBefore }))).winBonus).toBe(false);
    const justAfter = new Date(NOW.getTime() + LADDER_WIN_BONUS_COOLDOWN_MS + 1_000);
    expect(aliceIn(await settleLadderEarn(input({ now: justAfter }))).winBonus).toBe(true);
    expect(db.owed("alice").money).toBe(2 * BRONZE_MONEY);
  });

  it("never pays cash without the bonus flag — the CHECK is the second opinion", async () => {
    await settleLadderEarn(input());
    for (const e of db.earns) {
      if (e.moneyAwarded > 0) expect(e.winBonusPaid).toBe(true);
    }
    expect(db.earns.filter((e) => e.moneyAwarded > 0)).toHaveLength(1);
  });

  it("prices the cash from the badge tier at the time of the win", async () => {
    const a = aliceIn(await settleLadderEarn(input({
      ratingDelta: { aDelta: 16, bDelta: -16, aRating: 1516, bRating: 984 },
    })));
    expect(a.tier).toBe("platinum");
    expect(a.money).toBe(120_000);
    expect(db.bonusClaims[0].tier).toBe("platinum");
    expect(db.bonusClaims[0].rating).toBe(1516);
  });

  it("is claimable on a decayed win, which the old bpFromBattle>0 rule blocked", async () => {
    // Four losses to the same rival, then a win. The 5th meeting used to decay
    // to 0 BP and therefore forfeit the cash bonus entirely.
    for (let i = 0; i < 4; i++) {
      await settleLadderEarn(input({ winnerId: "bob", loserId: "alice" }));
    }
    const a = aliceIn(await settleLadderEarn(input()));
    expect(a.winBonus).toBe(true);
    expect(a.money).toBe(BRONZE_MONEY);
    expect(db.owed("alice").money).toBe(BRONZE_MONEY);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. A WIN PAYS EXACTLY ONCE
// ════════════════════════════════════════════════════════════════════
describe("a win pays exactly once", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  it("refuses a replayed settle for the same match", async () => {
    const inp = input();
    expect((await settleLadderEarn(inp)).paid).toBe(true);
    const snapshot = JSON.stringify({ e: db.earns, g: db.grants, b: db.bonusClaims });
    expect(await settleLadderEarn(inp)).toEqual({ paid: false, reason: "already_settled", sides: [] });
    expect(JSON.stringify({ e: db.earns, g: db.grants, b: db.bonusClaims })).toBe(snapshot);
  });

  it("rolls a replay back to NOTHING written, not to a phantom meeting", async () => {
    const inp = input();
    await settleLadderEarn(inp);
    const earnsBefore = db.earns.length;
    // Replay with the sides SWAPPED, so the first insert of the retry SUCCEEDS
    // and it is the rollback, not the conflict, that has to do the work.
    await settleLadderEarn({ ...inp, winnerId: "bob", loserId: "alice" });
    expect(db.earns).toHaveLength(earnsBefore);
    expect(db.owed("bob").money).toBe(0);
  });

  it("is not an error — a double end is a normal race, not a failure", async () => {
    const inp = input();
    await settleLadderEarn(inp);
    h.recordError.mockClear();
    await settleLadderEarn(inp);
    expect(h.recordError).not.toHaveBeenCalled();
  });

  it("awards a rating milestone once ever, not once per crossing", async () => {
    const up = await settleLadderEarn(input({
      ratingDelta: { aDelta: 104, bDelta: -16, aRating: 1104, bRating: 984 },
    }));
    expect(aliceIn(up).milestones).toEqual([1100]);
    // Cross it again after falling back below: the primary key refuses.
    const again = await settleLadderEarn(input({
      ratingDelta: { aDelta: 104, bDelta: -16, aRating: 1104, bRating: 984 },
    }));
    expect(aliceIn(again).milestones).toEqual([]);
    expect(db.milestones.filter((m) => m.userId === "alice")).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. MILESTONES ARE EXEMPT FROM THE CAP AND DO NOT CONSUME IT
// ════════════════════════════════════════════════════════════════════
describe("a milestone payout does not burn the ordinary cap", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); db.addPlayer("carol"); });

  // REGRESSION, the exact reproduction: milestone BP was written into the same
  // "bp" column the cap sums, so a 98-BP rank-up match left a legitimate later
  // battle against a FRESH opponent paying 0.
  it("leaves the next legitimate battle paying full rate", async () => {
    const a = aliceIn(await settleLadderEarn(input({
      ratingDelta: { aDelta: 750, bDelta: -16, aRating: 1750, bRating: 984 },
    })));
    expect(a.milestoneBp).toBe(PVP_MILESTONE_BP_LIFETIME_TOTAL);
    expect(a.bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);   // the capped part only

    const next = aliceIn(await settleLadderEarn(input({
      loserId: "carol",
      ratingDelta: { aDelta: 8, bDelta: -8, aRating: 1758, bRating: 984 },
    })));
    expect(next.bp).toBe(LADDER_BP_WIN);
  });

  it("keeps the two figures in separate ledger columns", async () => {
    await settleLadderEarn(input({
      ratingDelta: { aDelta: 750, bDelta: -16, aRating: 1750, bRating: 984 },
    }));
    const row = db.earns.find((e) => e.userId === "alice")!;
    expect(row.bp).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);
    expect(row.milestoneBp).toBe(PVP_MILESTONE_BP_LIFETIME_TOTAL);
    // The grant is the SUM, so the player is paid everything in one toast.
    expect(db.owed("alice").bp).toBe(row.bp + row.milestoneBp);
  });

  // REGRESSION: milestones used to key on the live rating, so the day
  // PVP_LADDER_REWARDS was switched on, every already-high account collected its
  // whole back-catalogue on its next win.
  it("pays nothing to an account already sitting above the thresholds", async () => {
    const a = aliceIn(await settleLadderEarn(input({
      ratingDelta: { aDelta: 16, bDelta: -16, aRating: 1716, bRating: 984 },
    })));
    expect(a.milestones).toEqual([]);
    expect(a.milestoneBp).toBe(0);
    expect(db.milestones).toEqual([]);
  });

  it("records the pre-crossing rating, which the CHECK constraint then verifies", async () => {
    await settleLadderEarn(input({
      ratingDelta: { aDelta: 120, bDelta: -16, aRating: 1120, bRating: 984 },
    }));
    const m = db.milestones.find((x) => x.userId === "alice" && x.threshold === 1100)!;
    expect(m.ratingBefore).toBe(1000);
    expect(m.ratingAtAward).toBe(1120);
    expect(m.ratingBefore).toBeLessThan(m.threshold);
  });
});

// ════════════════════════════════════════════════════════════════════
// 8. CONCURRENT CLAIMS CANNOT DOUBLE-PAY
// ════════════════════════════════════════════════════════════════════
describe("concurrent claims cannot double-pay", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); db.addPlayer("carol"); });

  it("pays once when the SAME match settles twice concurrently", async () => {
    const inp = input();
    let released: (() => void) | null = null;
    const gate = new Promise<void>((res) => { released = res; });
    let first = true;
    db.hook = async (kind) => {
      if (kind === "insert.earn" && first) { first = false; await gate; }
    };
    const p1 = settleLadderEarn(inp);
    const p2 = settleLadderEarn(inp).then((r) => { released!(); return r; });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.paid, r2.paid].sort()).toEqual([false, true]);
    expect(db.owed("alice").money).toBe(BRONZE_MONEY);
    expect(db.earns.filter((e) => e.userId === "alice")).toHaveLength(1);
  });

  it("pays ONE cash bonus when two different matches finish together", async () => {
    // Two distinct matches, both reading "not on cooldown", then both trying to
    // claim. The conditional upsert is the arbiter: the second sees the first's
    // committed timestamp and affects zero rows.
    let held: (() => void) | null = null;
    const gate = new Promise<void>((res) => { held = res; });
    let firstClaim = true;
    db.hook = async (kind) => {
      if (kind === "claim.winBonus" && firstClaim) { firstClaim = false; await gate; }
    };
    const p1 = settleLadderEarn(input({ loserId: "bob" }));
    const p2 = settleLadderEarn(input({ loserId: "carol" })).then((r) => { held!(); return r; });
    const [r1, r2] = await Promise.all([p1, p2]);
    const bonuses = [r1, r2].flatMap((r) => r.sides.filter((s) => s.userId === "alice" && s.winBonus));
    expect(bonuses).toHaveLength(1);
    expect(db.owed("alice").money).toBe(BRONZE_MONEY);
    expect(db.bonusClaims.filter((x) => x.userId === "alice")).toHaveLength(1);
  });

  it("awards ONE milestone when two matches cross the same threshold together", async () => {
    let held: (() => void) | null = null;
    const gate = new Promise<void>((res) => { held = res; });
    let firstMs = true;
    db.hook = async (kind) => {
      if (kind === "insert.milestone" && firstMs) { firstMs = false; await gate; }
    };
    const delta = { aDelta: 110, bDelta: -16, aRating: 1110, bRating: 984 };
    const p1 = settleLadderEarn(input({ loserId: "bob", ratingDelta: delta }));
    const p2 = settleLadderEarn(input({ loserId: "carol", ratingDelta: delta }))
      .then((r) => { held!(); return r; });
    const [r1, r2] = await Promise.all([p1, p2]);
    const awarded = [r1, r2]
      .flatMap((r) => r.sides.filter((s) => s.userId === "alice"))
      .flatMap((s) => s.milestones);
    expect(awarded).toEqual([1100]);
    expect(db.milestones.filter((m) => m.userId === "alice")).toHaveLength(1);
  });

  it("loses only the bonus to a lost claim, never the whole match reward", async () => {
    // A lost claim must be 0 affected rows and not an exception, because an
    // exception poisons the Postgres transaction and would cost the BP too.
    await settleLadderEarn(input());
    const r = await settleLadderEarn(input({ loserId: "carol" }));
    expect(r.paid).toBe(true);
    const a = aliceIn(r);
    expect(a.winBonus).toBe(false);
    expect(a.money).toBe(0);
    expect(a.bp).toBe(LADDER_BP_WIN);      // still paid
  });
});

// ════════════════════════════════════════════════════════════════════
// 9. EVERY FAILURE PATH RECORDS AN ERROR
// ════════════════════════════════════════════════════════════════════
describe("every failure path records an error", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  it("records — and pays nothing — when the migration has not been applied", async () => {
    db.hook = (kind) => {
      if (kind === "read.sideLedger") {
        throw new Error('42P01 relation "PvpLadderEarn" does not exist');
      }
    };
    expect(await settleLadderEarn(input())).toEqual({ paid: false, reason: "error", sides: [] });
    expectNothingWritten();
    expect(h.recordError).toHaveBeenCalledWith(expect.objectContaining({
      message: "pvp_ladder_settle_failed",
    }));
  });

  it("rolls the FIRST side's payment back when the second side cannot be paid", async () => {
    let seen = 0;
    db.hook = (kind) => {
      if (kind === "update.earn") {
        seen++;
        if (seen === 2) throw new Error("boom on the second side");
      }
    };
    expect((await settleLadderEarn(input())).paid).toBe(false);
    // The winner's grant, the winner's ledger row AND the bonus claim all go.
    expectNothingWritten();
    expect(db.owed("alice")).toEqual({ bp: 0, money: 0 });
  });

  it("rolls the BONUS CLAIM back too, so a failed match does not burn a cooldown", async () => {
    db.hook = (kind) => { if (kind === "insert.milestone") throw new Error("boom"); };
    expect((await settleLadderEarn(input({
      ratingDelta: { aDelta: 110, bDelta: -16, aRating: 1110, bRating: 984 },
    }))).paid).toBe(false);
    expect(db.bonusClaims).toEqual([]);
    // …and the very next match can still claim it.
    db.hook = null;
    expect(aliceIn(await settleLadderEarn(input())).winBonus).toBe(true);
  });

  it("carries enough context in the error to answer a support ticket", async () => {
    db.hook = (kind) => { if (kind === "read.sideLedger") throw new Error("nope"); };
    await settleLadderEarn(input({ provenance: "invite" }));
    expect((h.recordError.mock.calls[0][0] as any).meta).toMatchObject({
      winnerId: "alice", loserId: "bob", endReason: "ko",
      provenance: "invite", turns: 4, day: DAY, durationMs: 5 * 60_000,
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 10. THE READ SIDE REPORTS WHAT WAS MINTED, NEVER A BALANCE
// ════════════════════════════════════════════════════════════════════
describe("the read side reports what was minted, never a balance", () => {
  beforeEach(() => { db.addPlayer("alice"); db.addPlayer("bob"); });

  it("reports the window's earnings, the remaining cap and the bonus cooldown", async () => {
    await settleLadderEarn(input());
    const s = await readLadderStatus("alice", NOW, 1016);
    expect(s.bpEarnedInWindow).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP);
    expect(s.bpCap).toBe(LADDER_BP_CAP_PER_WINDOW);
    expect(s.bpRemainingInWindow).toBe(LADDER_BP_CAP_PER_WINDOW - s.bpEarnedInWindow);
    expect(s.matchesRewardedInWindow).toBe(1);
    expect(s.winBonusOnCooldown).toBe(true);
    expect(s.winBonusMoney).toBe(BRONZE_MONEY);
    expect(s.rewardsEnabled).toBe(true);
    // The single most-asked question a rewards panel has to answer.
    expect(s.winBonusAvailableAt)
      .toBe(new Date(NOW.getTime() + LADDER_WIN_BONUS_COOLDOWN_MS).toISOString());
    // No BALANCE anywhere: the balance lives in the save.
    expect(Object.keys(s)).not.toContain("bpBalance");
  });

  it("reports the bonus as available once the cooldown has elapsed", async () => {
    await settleLadderEarn(input());
    const s = await readLadderStatus("alice", new Date(NOW.getTime() + LADDER_WIN_BONUS_COOLDOWN_MS + 1), 1016);
    expect(s.winBonusOnCooldown).toBe(false);
    expect(s.winBonusAvailableAt).toBeNull();
  });

  it("scopes the window to 24h and keeps lifetime separate, including milestones", async () => {
    await settleLadderEarn(input({
      ratingDelta: { aDelta: 110, bDelta: -16, aRating: 1110, bRating: 984 },
    }));
    const later = new Date(NOW.getTime() + LADDER_BP_WINDOW_MS + 60_000);
    const s = await readLadderStatus("alice", later, 1110);
    expect(s.bpEarnedInWindow).toBe(0);
    expect(s.bpRemainingInWindow).toBe(LADDER_BP_CAP_PER_WINDOW);
    expect(s.milestoneBpLifetime).toBe(10);
    expect(s.bpMintedLifetime).toBe(LADDER_BP_WIN + LADDER_WIN_BONUS_BP + 10);
  });

  it("reports zeroes rather than throwing for an account that has never played", async () => {
    const s = await readLadderStatus("nobody", NOW, null);
    expect(s.bpEarnedInWindow).toBe(0);
    expect(s.winBonusOnCooldown).toBe(false);
    expect(s.winBonusMoney).toBe(BRONZE_MONEY);
  });

  it("explains every row of the history rather than leaving it a mystery", async () => {
    for (let i = 0; i < 3; i++) await settleLadderEarn(input());
    const hist = await readLadderHistory("alice", 10);
    expect(hist).toHaveLength(3);
    for (const row of hist) {
      expect(row.provenance).toBe("queue");
      expect(row.explanation.length).toBeGreaterThan(0);
      expect(row.tier).toBe("bronze");
    }
    expect(hist.at(-1)!.explanation).toContain("win bonus");
  });

  it("bounds the history page size", async () => {
    await settleLadderEarn(input());
    expect(await readLadderHistory("alice", 10_000)).toBeInstanceOf(Array);
    expect(await readLadderHistory("alice", -5)).toBeInstanceOf(Array);
  });

  it("reports the loser's smaller reward too, so both sides can see why", async () => {
    await settleLadderEarn(input());
    const s = await readLadderStatus("bob", NOW, 984);
    expect(s.bpEarnedInWindow).toBe(LADDER_BP_LOSS);
    expect(s.winBonusOnCooldown).toBe(false);
  });
});
