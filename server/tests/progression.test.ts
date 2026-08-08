// Paying out the level ladder, exactly once per tier, forever.
//
// The curve is tested next door in progressionTiers.test.ts. What is tested
// here is the ledger, and it exists because of one fact about the game:
//
//   `accountLevel` is derived from the Pokemon a player currently HOLDS
//   (lib/level.ts), so releasing a boxful LOWERS it.
//
// That makes the obvious implementation — pay when level >= N — a loop the
// player can run for free: level up, collect, release, re-level, collect the
// same tiers again. So the tests below are mostly about a mark that refuses to
// move backwards, and about two save uploads landing at the same moment.
//
// db.js and the grant path are stubbed; nothing reaches a database.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    claims: new Map<string, { paidTier: number; paidAtLevel: number; backfilled: boolean }>(),
    grants: [] as Array<{ userId: string; sourceId: string | null; prizes: unknown[] }>,
  },
}));

class FakeP2002 extends Error {
  code = "P2002";
  constructor() { super("Unique constraint failed"); this.name = "PrismaClientKnownRequestError"; }
}

vi.mock("@prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: FakeP2002 },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    progressionClaim: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        state.claims.get(where.userId) ?? null,
      create: async ({ data }: { data: { userId: string; paidTier: number; paidAtLevel: number; backfilled: boolean } }) => {
        if (state.claims.has(data.userId)) throw new FakeP2002();
        state.claims.set(data.userId, {
          paidTier: data.paidTier, paidAtLevel: data.paidAtLevel, backfilled: data.backfilled,
        });
        return data;
      },
      // The REAL compare-and-swap, enforced: a fake that always reports 1 could
      // not fail the way the database fails, and the race test below would
      // certify nothing.
      updateMany: async ({ where, data }: {
        where: { userId: string; paidTier: { lt: number } };
        data: { paidTier: number; paidAtLevel: number };
      }) => {
        const cur = state.claims.get(where.userId);
        if (!cur || !(cur.paidTier < where.paidTier.lt)) return { count: 0 };
        state.claims.set(where.userId, { ...cur, ...data });
        return { count: 1 };
      },
    },
  },
}));

vi.mock("../src/lib/prizeGrant.js", () => ({
  enqueuePrizeGrant: async (
    userId: string, prizes: unknown[], meta: { source: string; sourceId?: string },
  ) => {
    state.grants.push({ userId, sourceId: meta.sourceId ?? null, prizes });
    return { id: `g${state.grants.length}` };
  },
}));

vi.mock("../src/lib/errorReporting.js", () => ({ recordError: async () => undefined }));

const { awardProgression, getProgressionStatus } = await import("../src/lib/progression.js");
const { tiersReachedAt } = await import("../src/lib/progressionTiers.js");

const moneyPaid = () =>
  state.grants.flatMap((g) => g.prizes as Array<{ kind: string; amount?: number }>)
    .reduce((s, p) => (p.kind === "money" ? s + (p.amount ?? 0) : s), 0);

beforeEach(() => {
  state.claims.clear();
  state.grants = [];
});

describe("an account that has never been paid", () => {
  it("is back-paid everything it had already passed, in ONE grant", async () => {
    // The launch-day case: a player who was level 1,200 before this existed.
    const res = await awardProgression("veteran", 1200);
    expect(res).not.toBeNull();
    expect(res!.from).toBe(0);
    expect(res!.to).toBe(tiersReachedAt(1200));
    expect(res!.backfilled).toBe(true);
    // 53 tiers, one grant. As 53 grants it would be 53 toasts for one event.
    expect(state.grants).toHaveLength(1);
  });

  it("marks the row as backfilled, so launch day is distinguishable later", async () => {
    // "Earned 53 tiers by playing" and "was handed 53 on launch day" are the
    // same rows in PendingGrant, and only one of them says anything about the
    // game.
    await awardProgression("veteran", 1200);
    expect(state.claims.get("veteran")!.backfilled).toBe(true);

    await awardProgression("newbie", 5);
    const second = await awardProgression("newbie", 10);
    expect(second!.backfilled).toBe(false);
  });

  it("pays nothing to an account below the first tier", async () => {
    expect(await awardProgression("fresh", 4)).toBeNull();
    expect(state.grants).toHaveLength(0);
    expect(state.claims.has("fresh")).toBe(false);
  });
});

describe("the mark never moves backwards", () => {
  it("pays nothing when the player releases Pokemon and drops a tier", async () => {
    // THE REASON THIS LEDGER EXISTS. Level is derived from what you hold, so
    // this is not hypothetical — it is one bulk release away.
    await awardProgression("player", 500);
    const paidAfterClimb = moneyPaid();
    expect(paidAfterClimb).toBeGreaterThan(0);

    const dropped = await awardProgression("player", 200);
    expect(dropped).toBeNull();
    expect(moneyPaid()).toBe(paidAfterClimb);
    // And the mark itself is untouched.
    expect(state.claims.get("player")!.paidTier).toBe(tiersReachedAt(500));
  });

  it("pays only the NEW span when they climb back past their old peak", async () => {
    await awardProgression("player", 500);
    const afterFirst = moneyPaid();
    await awardProgression("player", 200);      // released
    const res = await awardProgression("player", 600);  // climbed past the peak
    expect(res).not.toBeNull();
    expect(res!.from).toBe(tiersReachedAt(500));
    expect(res!.to).toBe(tiersReachedAt(600));
    // The 500-tier span is NOT paid a second time.
    const delta = moneyPaid() - afterFirst;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(afterFirst);
  });

  it("is a no-op when nothing new was crossed", async () => {
    await awardProgression("player", 300);
    state.grants = [];
    expect(await awardProgression("player", 300)).toBeNull();
    expect(await awardProgression("player", 310)).toBeNull(); // same tier
    expect(state.grants).toHaveLength(0);
  });
});

describe("two save uploads landing together", () => {
  it("pays the span once, not twice", async () => {
    // Two tabs, a retry, a reconnect flush. Read-then-write would let both see
    // the same mark, compute the same span and pay it twice. The compare-and-
    // swap is what makes the loser a no-op.
    await awardProgression("racer", 200);
    const before = moneyPaid();
    state.grants = [];

    const [a, b] = await Promise.all([
      awardProgression("racer", 400),
      awardProgression("racer", 400),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners, "both uploads paid the same span").toHaveLength(1);
    expect(state.grants).toHaveLength(1);
    expect(moneyPaid()).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });

  it("survives two FIRST awards racing for the same new account", async () => {
    // No row yet, so both take the create path and one hits the primary key.
    const [a, b] = await Promise.all([
      awardProgression("brandnew", 300),
      awardProgression("brandnew", 300),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(state.grants).toHaveLength(1);
  });
});

describe("what the card is told", () => {
  it("reports the paid mark and the reached mark separately", async () => {
    // They differ in the window between crossing a tier and the upload that
    // pays it. Showing only one would either claim an unpaid reward was
    // collected, or hide a tier the player can see they reached.
    await awardProgression("player", 200);
    const s = await getProgressionStatus("player", 260);
    expect(s.paidTier).toBe(tiersReachedAt(200));
    expect(s.reachedTier).toBe(tiersReachedAt(260));
    expect(s.reachedTier).toBeGreaterThan(s.paidTier);
  });

  it("gives a progress fraction inside the current gap", async () => {
    const s = await getProgressionStatus("nobody", 1210);
    expect(s.nextLevel).toBe(1225);
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(1);
    expect(s.nextSummary).toBeTruthy();
  });
});
