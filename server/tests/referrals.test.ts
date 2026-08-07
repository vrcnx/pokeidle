// The referral programme's payout rules.
//
// This is a promotion that mints tradeable items, so the properties worth
// pinning are all about paying the RIGHT number of times:
//
//   * once per friend, never twice for the same friend;
//   * never past the cap;
//   * the milestone exactly once, on the cap-th friend, even when signups
//     land together;
//   * never to somebody referring themselves;
//   * and the row is recorded even when the programme is off, so turning it
//     on later does not lose the history — and does not back-pay it either.
//
// The cap and the milestone are the ones that would actually cost money if
// wrong, and the race is the way they go wrong: COUNT(*)+1 read before an
// insert lets two concurrent signups both claim the last slot. The ordinal's
// unique constraint is what stops that, so the fake below ENFORCES it rather
// than accepting whatever it is handed — a fake that cannot fail the way the
// database fails would certify nothing.
//
// db.js and the grant path are stubbed so nothing reaches a database.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    codes: [] as Array<{ userId: string; code: string }>,
    referrals: [] as Array<{ referredUserId: string; referrerUserId: string; ordinal: number }>,
    grants: [] as Array<{ userId: string; source: string; sourceId: string | null; prizes: unknown[] }>,
    config: null as
      | { enabled: boolean; perReferral: string | null; milestone: string | null; shinyPool: string | null; perReferralCap: number }
      | null,
  },
}));

/** The P2002 the real client throws, with the `target` the handlers read. */
class FakeP2002 extends Error {
  code = "P2002";
  meta: { target: string[] };
  constructor(target: string[]) {
    super("Unique constraint failed");
    this.name = "PrismaClientKnownRequestError";
    this.meta = { target };
  }
}

vi.mock("@prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: FakeP2002 },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    referralCode: {
      findUnique: async ({ where }: { where: { userId?: string; code?: string } }) =>
        state.codes.find(
          (c) => (where.userId && c.userId === where.userId) || (where.code && c.code === where.code),
        ) ?? null,
      create: async ({ data }: { data: { userId: string; code: string } }) => {
        if (state.codes.some((c) => c.userId === data.userId)) throw new FakeP2002(["userId"]);
        if (state.codes.some((c) => c.code === data.code)) throw new FakeP2002(["code"]);
        state.codes.push(data);
        return data;
      },
    },
    referral: {
      findFirst: async ({ where }: { where: { referrerUserId: string } }) =>
        state.referrals
          .filter((r) => r.referrerUserId === where.referrerUserId)
          .sort((a, b) => b.ordinal - a.ordinal)[0] ?? null,
      count: async ({ where }: { where: { referrerUserId: string } }) =>
        state.referrals.filter((r) => r.referrerUserId === where.referrerUserId).length,
      create: async ({ data }: { data: { referredUserId: string; referrerUserId: string; ordinal: number } }) => {
        // The primary key: one referrer per referred account, forever.
        if (state.referrals.some((r) => r.referredUserId === data.referredUserId)) {
          throw new FakeP2002(["referredUserId"]);
        }
        // The unique index that makes the cap race-safe.
        if (state.referrals.some(
          (r) => r.referrerUserId === data.referrerUserId && r.ordinal === data.ordinal,
        )) {
          throw new FakeP2002(["referrerUserId", "ordinal"]);
        }
        state.referrals.push(data);
        return data;
      },
    },
    referralConfig: { findUnique: async () => state.config },
    pendingGrant: {
      count: async ({ where }: { where: { userId?: string; source?: string; sourceId?: string } }) =>
        state.grants.filter(
          (g) =>
            (where.userId === undefined || g.userId === where.userId) &&
            (where.source === undefined || g.source === where.source) &&
            (where.sourceId === undefined || g.sourceId === where.sourceId),
        ).length,
    },
  },
}));

vi.mock("../src/lib/prizeGrant.js", () => ({
  enqueuePrizeGrant: async (
    userId: string,
    prizes: unknown[],
    meta: { source: string; sourceId?: string },
  ) => {
    state.grants.push({ userId, source: meta.source, sourceId: meta.sourceId ?? null, prizes });
    return { id: `g${state.grants.length}` };
  },
}));

vi.mock("../src/lib/errorReporting.js", () => ({ recordError: async () => undefined }));

const {
  attributeSignup, getOrCreateReferralCode, getReferralSummary, normaliseCode,
  REFERRAL_SOURCE, REFERRAL_MILESTONE_SOURCE,
} = await import("../src/lib/referrals.js");

/** The programme as configured by default: on, cap 10, one Master Ball each. */
const ON = {
  enabled: true,
  perReferral: null,
  milestone: null,
  shinyPool: JSON.stringify([
    { kind: "pokemon", label: "Shiny Gyarados", mon: { speciesKey: "gyarados", isShiny: true } },
  ]),
  perReferralCap: 10,
};

beforeEach(() => {
  state.codes = [{ userId: "alice", code: "ABCD2345" }];
  state.referrals = [];
  state.grants = [];
  state.config = { ...ON };
});

describe("referral codes", () => {
  it("survives being retyped off a screenshot", () => {
    // The whole reason for the restricted alphabet and the normaliser: a code
    // read aloud, or pasted with the punctuation of the sentence around it,
    // has to reach the same row.
    expect(normaliseCode(" abcd2345 ")).toBe("ABCD2345");
    expect(normaliseCode("abcd-2345.")).toBe("ABCD2345");
  });

  it("mints one code per account and keeps returning it", async () => {
    const first = await getOrCreateReferralCode("bob");
    const second = await getOrCreateReferralCode("bob");
    expect(second).toBe(first);
    expect(state.codes.filter((c) => c.userId === "bob")).toHaveLength(1);
  });

  it("never contains a character that reads as another one", async () => {
    // 0/O and 1/I/L are the ones that get transcribed wrong.
    for (let i = 0; i < 40; i++) {
      const code = await getOrCreateReferralCode(`u${i}`);
      expect(code).not.toMatch(/[01OIL]/);
      expect(code).toHaveLength(8);
    }
  });
});

describe("attributing a signup", () => {
  it("pays the referrer for a friend who signs up", async () => {
    const res = await attributeSignup("newbie", "ABCD2345");
    expect(res).toMatchObject({ ok: true, ordinal: 1, paid: true });
    expect(state.grants).toHaveLength(1);
    expect(state.grants[0]).toMatchObject({ userId: "alice", source: REFERRAL_SOURCE });
  });

  it("refuses to let anyone refer themselves", async () => {
    const res = await attributeSignup("alice", "ABCD2345");
    expect(res).toEqual({ ok: false, reason: "self_referral" });
    expect(state.grants).toHaveLength(0);
  });

  it("refuses an unknown code without inventing a referrer", async () => {
    const res = await attributeSignup("newbie", "ZZZZ9999");
    expect(res).toEqual({ ok: false, reason: "unknown_code" });
    expect(state.referrals).toHaveLength(0);
  });

  it("credits one account to ONE referrer, forever", async () => {
    state.codes.push({ userId: "carol", code: "WXYZ7777" });
    await attributeSignup("newbie", "ABCD2345");
    // Same account, second code — the primary key refuses it.
    const second = await attributeSignup("newbie", "WXYZ7777");
    expect(second).toEqual({ ok: false, reason: "already_referred" });
    expect(state.grants.filter((g) => g.userId === "carol")).toHaveLength(0);
  });
});

describe("the cap and the milestone", () => {
  const refer = (n: number) =>
    Promise.all(Array.from({ length: n }, (_, i) => attributeSignup(`f${i}`, "ABCD2345")));

  it("pays one Master Ball per friend up to the cap", async () => {
    await refer(10);
    expect(state.grants.filter((g) => g.source === REFERRAL_SOURCE)).toHaveLength(10);
  });

  it("stops paying past the cap but still records the friend", async () => {
    await refer(13);
    expect(state.referrals).toHaveLength(13);
    expect(state.grants.filter((g) => g.source === REFERRAL_SOURCE)).toHaveLength(10);
  });

  it("pays the milestone exactly once, on the tenth", async () => {
    await refer(10);
    const milestone = state.grants.filter((g) => g.source === REFERRAL_MILESTONE_SOURCE);
    expect(milestone).toHaveLength(1);
    // The money half, and one mon drawn from the pool.
    const prizes = milestone[0].prizes as Array<{ kind: string; amount?: number }>;
    expect(prizes.some((p) => p.kind === "money" && p.amount === 1_000_000)).toBe(true);
    expect(prizes.filter((p) => p.kind === "pokemon")).toHaveLength(1);
  });

  it("does not pay the milestone twice when signups land together", async () => {
    // THE RACE THIS EXISTS FOR. Ten concurrent signups: without the ordinal's
    // unique constraint several would read the same count, several would
    // believe they were the tenth, and the million would be paid more than
    // once. Every ordinal must be distinct and the milestone must be single.
    await refer(10);
    const ordinals = state.referrals.map((r) => r.ordinal).sort((a, b) => a - b);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(state.grants.filter((g) => g.source === REFERRAL_MILESTONE_SOURCE)).toHaveLength(1);
  });

  it("pays a shiny on a server nobody has configured", async () => {
    // The property the committed default pool exists for. `shinyPool: null`
    // is what every fresh deployment has, and it used to mean the milestone
    // paid its money half and nothing else — a bonus that advertised a shiny
    // and delivered cash until an operator remembered to stock it.
    state.config = { ...ON, shinyPool: null };
    await refer(10);
    const milestone = state.grants.filter((g) => g.source === REFERRAL_MILESTONE_SOURCE);
    expect(milestone).toHaveLength(1);
    const prizes = milestone[0].prizes as Array<{ kind: string; label?: string }>;
    expect(prizes.some((p) => p.kind === "money")).toBe(true);
    const mon = prizes.find((p) => p.kind === "pokemon");
    expect(mon, "no shiny in the milestone on an unconfigured server").toBeDefined();
    expect(mon?.label).toMatch(/^Shiny /);
  });

  it("draws from the pool, so two milestones are not always the same mon", async () => {
    // A "random" shiny that is the same species every time is a fixed prize
    // wearing the word random. The pool is drawn from per payout, so across
    // enough referrers more than one species should appear.
    const seen = new Set<string>();
    // The DEFAULT pool (24 mons), not the fixture's one-mon pool — drawing
    // repeatedly from a pool of one proves nothing.
    state.config = { ...ON, shinyPool: null };
    for (let r = 0; r < 25; r++) {
      state.codes = [{ userId: `ref${r}`, code: `CODE${String(r).padStart(4, "0")}` }];
      state.referrals = [];
      state.grants = [];
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => attributeSignup(`f${r}_${i}`, `CODE${String(r).padStart(4, "0")}`)),
      );
      const m = state.grants.find((g) => g.source === REFERRAL_MILESTONE_SOURCE);
      const mon = (m?.prizes as Array<{ kind: string; label?: string }>)?.find((p) => p.kind === "pokemon");
      if (mon?.label) seen.add(mon.label);
    }
    expect(seen.size, `every milestone drew the same shiny: ${[...seen]}`).toBeGreaterThan(1);
  });
});

describe("an untouched deployment", () => {
  // Nothing seeds ReferralConfig, so "no row" is the state every deployment
  // starts in — and it has to mean RUNNING. It meant paused first, which,
  // combined with a card that hides itself when the programme is off, shipped
  // a feature that was built, correct, deployed and invisible. This is the
  // test that would have caught that being true.
  beforeEach(() => { state.config = null; });

  it("is running, with the prizes the programme was asked for", async () => {
    const res = await attributeSignup("newbie", "ABCD2345");
    expect(res).toMatchObject({ ok: true, paid: true });
    const prizes = state.grants[0].prizes as Array<{ kind: string; itemId?: string }>;
    expect(prizes).toEqual([{ kind: "item", itemId: "masterball", quantity: 1 }]);
  });

  it("shows the card, because the card is hidden only when it is off", async () => {
    const summary = await getReferralSummary("alice");
    expect(summary.enabled).toBe(true);
  });
});

describe("when the programme is switched off", () => {
  beforeEach(() => { state.config = { ...ON, enabled: false }; });

  it("still records where the account came from", async () => {
    const res = await attributeSignup("newbie", "ABCD2345");
    expect(res).toMatchObject({ ok: true, paid: false });
    expect(state.referrals).toHaveLength(1);
  });

  it("pays nothing, and does not owe it later", async () => {
    // The deliberate half: turning the programme on does not back-pay what it
    // collected while off. Retroactive payment across an unknown window is how
    // an operator finds they owe ten thousand Master Balls.
    await attributeSignup("newbie", "ABCD2345");
    expect(state.grants).toHaveLength(0);
    state.config = { ...ON, enabled: true };
    const summary = await getReferralSummary("alice");
    expect(summary.total).toBe(1);
    expect(summary.paid).toBe(0);
  });
});

describe("the card's own numbers", () => {
  it("counts friends and payments separately, because they differ past the cap", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => attributeSignup(`f${i}`, "ABCD2345")));
    const summary = await getReferralSummary("alice");
    expect(summary.total).toBe(12);
    expect(summary.paid).toBe(10);
    expect(summary.cap).toBe(10);
    expect(summary.milestoneReached).toBe(true);
  });

  it("describes the reward from the config, not from a hardcoded string", async () => {
    state.config = {
      ...ON,
      perReferral: JSON.stringify([{ kind: "item", itemId: "ultraball", quantity: 3 }]),
    };
    const summary = await getReferralSummary("alice");
    expect(summary.perReferralSummary).toContain("ultraball");
  });
});
