// Paying the Discord rank ladder exactly once, for an identity that can be
// DETACHED at will.
//
// The curve is tested next door. What is tested here is the ledger, and it
// exists because of one fact: /unlink is a button. Every version of the
// exploit starts by pressing it, so every test below is some arrangement of
// unlink-and-try-again.
//
// The two guards are database constraints, not application code, so the fakes
// below enforce them for real — a fake that let a duplicate key through would
// certify nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    claims: new Map<string, { discordId: string; userId: string; paidTier: number; paidAtRank: number }>(),
    xp: new Map<string, number>(),
    links: new Map<string, string>(), // userId -> discordId
    grants: [] as Array<{ userId: string; sourceId: string | null; prizes: unknown[] }>,
  },
}));

class FakeP2002 extends Error {
  code = "P2002";
  constructor() { super("Unique constraint failed"); this.name = "PrismaClientKnownRequestError"; }
}

vi.mock("../src/db.js", () => ({
  prisma: {
    discordRankClaim: {
      // A COPY, because Prisma returns a fresh object. Handing back the live
      // Map value would alias the row the compare-and-swap is about to mutate,
      // and the caller's "what had I been paid before" read would silently
      // become "what am I being paid to" — every race test would then pass by
      // measuring nothing.
      findUnique: async ({ where }: { where: { discordId: string } }) => {
        const row = state.claims.get(where.discordId);
        return row ? { ...row } : null;
      },

      // BOTH constraints, enforced. The primary key on discordId and the
      // unique index on userId are the whole anti-farm mechanism; a fake that
      // only modelled one of them would pass every test here while the real
      // schema failed.
      create: async ({ data }: { data: { discordId: string; userId: string; paidTier: number; paidAtRank: number } }) => {
        if (state.claims.has(data.discordId)) throw new FakeP2002();
        for (const c of state.claims.values()) if (c.userId === data.userId) throw new FakeP2002();
        state.claims.set(data.discordId, { ...data });
        return data;
      },

      // The REAL compare-and-swap. Reports a count, and the count is what
      // decides whether a payout happens.
      updateMany: async ({ where, data }: {
        where: { discordId: string; paidTier: { lt: number } };
        data: { paidTier: number; paidAtRank: number };
      }) => {
        const row = state.claims.get(where.discordId);
        if (!row || !(row.paidTier < where.paidTier.lt)) return { count: 0 };
        row.paidTier = data.paidTier;
        row.paidAtRank = data.paidAtRank;
        return { count: 1 };
      },

      count: async ({ where }: { where: { userId: string } }) =>
        [...state.claims.values()].filter((c) => c.userId === where.userId).length,
    },
    discordXp: {
      findUnique: async ({ where }: { where: { discordId: string } }) =>
        state.xp.has(where.discordId) ? { xp: state.xp.get(where.discordId) } : null,
    },
    discordLink: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        state.links.has(where.userId) ? { discordId: state.links.get(where.userId) } : null,
    },
  },
}));

vi.mock("../src/lib/prizeGrant.js", () => ({
  enqueuePrizeGrant: async (
    userId: string,
    prizes: unknown[],
    meta: { source: string; sourceId?: string },
  ) => {
    state.grants.push({ userId, sourceId: meta.sourceId ?? null, prizes });
    return { id: `g${state.grants.length}` };
  },
}));

vi.mock("../src/lib/errorReporting.js", () => ({ recordError: async () => undefined }));

const { awardDiscordRank, getDiscordRankStatus } = await import("../src/lib/discordRankRewards.js");
const { totalXpForLevel } = await import("../src/lib/discordXp.js");
const { tiersReachedAtRank } = await import("../src/lib/discordRankTiers.js");

beforeEach(() => {
  state.claims.clear();
  state.xp.clear();
  state.links.clear();
  state.grants.length = 0;
});

const itemTotal = (id: string) =>
  state.grants
    .flatMap((g) => g.prizes as Array<{ kind: string; itemId?: string; quantity?: number }>)
    .filter((p) => p.kind === "item" && p.itemId === id)
    .reduce((n, p) => n + (p.quantity ?? 0), 0);

describe("paying once", () => {
  it("pays nothing below the first rank", async () => {
    expect(await awardDiscordRank("u1", "d1", 4)).toBeNull();
    expect(state.grants).toHaveLength(0);
  });

  it("pays the first tier and records the mark", async () => {
    const award = await awardDiscordRank("u1", "d1", 5);
    expect(award?.to).toBe(1);
    expect(state.grants).toHaveLength(1);
    expect(state.claims.get("d1")?.paidTier).toBe(1);
  });

  it("pays nothing the second time at the same rank", async () => {
    await awardDiscordRank("u1", "d1", 12);
    const before = state.grants.length;
    expect(await awardDiscordRank("u1", "d1", 12)).toBeNull();
    expect(state.grants).toHaveLength(before);
  });

  it("pays only the NEW tiers when a rank climbs", async () => {
    await awardDiscordRank("u1", "d1", 10);   // tiers 1–2
    state.grants.length = 0;
    const award = await awardDiscordRank("u1", "d1", 20); // tiers 3–4
    expect(award).toMatchObject({ from: 2, to: 4 });
    // Two tiers of Great Balls, not four tiers' worth.
    expect(itemTotal("greatball")).toBe(20);
  });

  it("two level-ups landing together pay once, not twice", async () => {
    await awardDiscordRank("u1", "d1", 5);
    state.grants.length = 0;
    const [a, b] = await Promise.all([
      awardDiscordRank("u1", "d1", 20),
      awardDiscordRank("u1", "d1", 20),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(state.grants).toHaveLength(1);
  });

  it("two FIRST awards landing together pay once, not twice", async () => {
    const [a, b] = await Promise.all([
      awardDiscordRank("u1", "d1", 20),
      awardDiscordRank("u1", "d1", 20),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(state.grants).toHaveLength(1);
  });
});

describe("the two anti-farm guards", () => {
  it("refuses a Discord account rebound to a SECOND game account", async () => {
    await awardDiscordRank("u1", "d1", 30);
    const paid = state.grants.length;

    // /unlink, then link the same Discord account to a fresh game account.
    expect(await awardDiscordRank("u2", "d1", 30)).toBeNull();
    expect(state.grants).toHaveLength(paid);
    // And the fresh account got nothing at all.
    expect(state.grants.every((g) => g.userId === "u1")).toBe(true);
  });

  it("refuses a game account claimed by a SECOND Discord account", async () => {
    await awardDiscordRank("u1", "d1", 30);
    const paid = state.grants.length;

    // /unlink, then link a different, already-high-ranked Discord account.
    expect(await awardDiscordRank("u1", "d2", 100)).toBeNull();
    expect(state.grants).toHaveLength(paid);
  });

  it("does not let a rebound Discord account climb further on a new game account", async () => {
    await awardDiscordRank("u1", "d1", 10);
    state.grants.length = 0;
    // The Discord account keeps chatting, then rebinds. The extra ranks are
    // real, but they belong to a pair that no longer exists.
    expect(await awardDiscordRank("u2", "d1", 30)).toBeNull();
    expect(state.grants).toHaveLength(0);
  });

  it("still pays the ORIGINAL pair after a failed rebind attempt", async () => {
    await awardDiscordRank("u1", "d1", 10);
    await awardDiscordRank("u2", "d1", 30);  // refused
    state.grants.length = 0;

    // The real owner carries on and is not collateral damage.
    const award = await awardDiscordRank("u1", "d1", 30);
    expect(award).toMatchObject({ from: 2, to: 6 });
    expect(state.grants).toHaveLength(1);
  });
});

describe("the status read", () => {
  it("reports an unlinked account without inventing a ladder", async () => {
    const s = await getDiscordRankStatus("u1");
    expect(s.linked).toBe(false);
    expect(s.track).toEqual([]);
  });

  it("settles ranks earned BEFORE linking", async () => {
    // The ordinary order of events: chat your way to rank 20, link afterwards.
    // The level-up hook never fired for this account, so the read is the only
    // thing that will ever pay it.
    state.xp.set("d1", totalXpForLevel(20));
    state.links.set("u1", "d1");

    const s = await getDiscordRankStatus("u1");
    expect(s.rank).toBe(20);
    expect(s.reachedTier).toBe(tiersReachedAtRank(20));
    expect(s.paidTier).toBe(s.reachedTier);
    expect(state.grants).toHaveLength(1);
  });

  it("is idempotent — reading twice does not pay twice", async () => {
    state.xp.set("d1", totalXpForLevel(20));
    state.links.set("u1", "d1");
    await getDiscordRankStatus("u1");
    await getDiscordRankStatus("u1");
    expect(state.grants).toHaveLength(1);
  });

  it("says so when the game account was already claimed by another Discord account", async () => {
    await awardDiscordRank("u1", "dOld", 30);
    state.xp.set("dNew", totalXpForLevel(50));
    state.links.set("u1", "dNew");

    const s = await getDiscordRankStatus("u1");
    expect(s.claimedByAnother).toBe(true);
    // And it does NOT draw ticks against stops this account was never paid for.
    expect(s.paidTier).toBe(0);
    expect(s.track.some((t) => t.state === "paid")).toBe(false);
  });

  it("draws a window, never the whole ladder", async () => {
    state.xp.set("d1", totalXpForLevel(80));
    state.links.set("u1", "d1");
    const s = await getDiscordRankStatus("u1");
    expect(s.track.length).toBeLessThanOrEqual(10);
    expect(s.track.some((t) => t.state === "next")).toBe(true);
  });

  it("never starts the window below the first tier", async () => {
    state.xp.set("d1", 0);
    state.links.set("u1", "d1");
    const s = await getDiscordRankStatus("u1");
    expect(s.track[0]?.tier).toBe(1);
  });
});
