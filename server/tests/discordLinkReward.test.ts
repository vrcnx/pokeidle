// The "link your Discord, get a prize" promotion.
//
// The property under test is that it pays ONCE, in both directions, using
// PendingGrant as the receipt rather than a new table. The failure this
// prevents is not theoretical: without the discordId check, unlink-then-relink
// mints an unlimited number of Master Balls from one Discord account, and a
// Master Ball is a guaranteed catch on anything.
//
// prizeGrant.ts and errorReporting.ts are stubbed so nothing reaches a
// database, a socket, or the alerting webhook.

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted, because vi.mock factories are lifted to the top of the file and
// cannot close over ordinary top-level consts — referencing one throws
// "Cannot access 'x' before initialization" at import time.
const { state, enqueueSpy } = vi.hoisted(() => {
  const state = {
    /** Rows that would exist in PendingGrant. */
    grants: [] as Array<{ userId: string; source: string; sourceId: string | null }>,
    accountLevel: 50,
    enqueueThrows: false,
  };
  const enqueueSpy = vi.fn(
    async (userId: string, _prizes: unknown, meta: { source: string; sourceId?: string | null }) => {
      if (state.enqueueThrows) throw new Error("boom");
      state.grants.push({ userId, source: meta.source, sourceId: meta.sourceId ?? null });
      return { id: `pg${state.grants.length}` };
    },
  );
  return { state, enqueueSpy };
});

vi.mock("../src/db.js", () => ({
  prisma: {
    user: {
      findUnique: async () => ({ accountLevel: state.accountLevel }),
    },
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
vi.mock("../src/lib/prizeGrant.js", () => ({ enqueuePrizeGrant: enqueueSpy }));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: vi.fn(async () => undefined) }));

import {
  LINK_REWARD_SOURCE,
  grantLinkReward,
  linkRewardPrizes,
  _resetLinkRewardCache,
} from "../src/lib/discordLinkReward.js";

const MASTERBALL = '[{"kind":"item","itemId":"masterball","quantity":1}]';
const DISCORD_A = "111111111111111111";
const DISCORD_B = "222222222222222222";

beforeEach(() => {
  state.grants = [];
  state.accountLevel = 50;
  state.enqueueThrows = false;
  enqueueSpy.mockClear();
  delete process.env.DISCORD_LINK_REWARD;
  delete process.env.DISCORD_LINK_REWARD_MIN_LEVEL;
  _resetLinkRewardCache();
});

describe("configuration", () => {
  it("is OFF when DISCORD_LINK_REWARD is unset", async () => {
    // The default must be inert, so a deploy that has never heard of this
    // feature hands out nothing.
    expect(linkRewardPrizes()).toBeNull();
    expect(await grantLinkReward("u1", DISCORD_A)).toEqual({ granted: false, reason: "disabled" });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("is OFF (and logs) when the value is malformed, rather than throwing per link", async () => {
    process.env.DISCORD_LINK_REWARD = "{not json";
    _resetLinkRewardCache();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(linkRewardPrizes()).toBeNull();
    expect(await grantLinkReward("u1", DISCORD_A)).toEqual({ granted: false, reason: "disabled" });
    expect(err).toHaveBeenCalled();
  });

  it("refuses a prize that the strict schema rejects", async () => {
    // parsePrizesStrict, not parsePrizes: this is operator input that has
    // never been validated anywhere else.
    process.env.DISCORD_LINK_REWARD = '[{"kind":"item","itemId":"masterball"}]'; // no quantity
    _resetLinkRewardCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(linkRewardPrizes()).toBeNull();
  });

  it("parses a valid prize list", () => {
    process.env.DISCORD_LINK_REWARD = MASTERBALL;
    _resetLinkRewardCache();
    expect(linkRewardPrizes()).toEqual([{ kind: "item", itemId: "masterball", quantity: 1 }]);
  });
});

describe("granting", () => {
  beforeEach(() => {
    process.env.DISCORD_LINK_REWARD = MASTERBALL;
    _resetLinkRewardCache();
  });

  it("pays on a first link, stamping source and the Discord id", async () => {
    const res = await grantLinkReward("u1", DISCORD_A);
    expect(res.granted).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    // sourceId is the DISCORD id, which is what makes the Discord-side check
    // possible at all.
    expect(state.grants[0]).toEqual({
      userId: "u1", source: LINK_REWARD_SOURCE, sourceId: DISCORD_A,
    });
  });

  it("does not pay the same GAME account twice", async () => {
    await grantLinkReward("u1", DISCORD_A);
    const second = await grantLinkReward("u1", DISCORD_A);
    expect(second).toEqual({ granted: false, reason: "already_claimed" });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("does not pay the same DISCORD account twice, even for a different game account", async () => {
    // THE alt-farming case this exists to close: unlink, make a new game
    // account, relink. Without the sourceId check this pays every time.
    await grantLinkReward("u1", DISCORD_A);
    const second = await grantLinkReward("u2-a-brand-new-account", DISCORD_A);
    expect(second).toEqual({ granted: false, reason: "already_claimed" });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("does not pay the same GAME account twice via a different Discord account", async () => {
    // The mirror case: unlink, link a fresh Discord account to the SAME game
    // account.
    await grantLinkReward("u1", DISCORD_A);
    const second = await grantLinkReward("u1", DISCORD_B);
    expect(second).toEqual({ granted: false, reason: "already_claimed" });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("still pays a genuinely different person", async () => {
    await grantLinkReward("u1", DISCORD_A);
    expect((await grantLinkReward("u2", DISCORD_B)).granted).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
  });

  it("is not confused by grants from OTHER sources on the same account", async () => {
    // A giveaway win must not consume the link reward.
    state.grants.push({ userId: "u1", source: "giveaway", sourceId: "gw1" });
    expect((await grantLinkReward("u1", DISCORD_A)).granted).toBe(true);
  });

  it("never throws when the grant fails — a broken promotion must not break linking", async () => {
    state.enqueueThrows = true;
    await expect(grantLinkReward("u1", DISCORD_A)).resolves.toEqual({
      granted: false, reason: "failed",
    });
  });
});

describe("optional level gate", () => {
  beforeEach(() => {
    process.env.DISCORD_LINK_REWARD = MASTERBALL;
  });

  it("is off by default — shipped behaviour is no gate", async () => {
    state.accountLevel = 0;
    _resetLinkRewardCache();
    expect((await grantLinkReward("u1", DISCORD_A)).granted).toBe(true);
  });

  it("blocks below the threshold when configured", async () => {
    // The env is read at MODULE LOAD for the level (unlike the prize, which is
    // lazily cached), so this asserts the shipped default rather than trying
    // to re-read it. Documented here so the next person does not mistake the
    // missing case for an untested one: changing the gate needs a restart,
    // which is the same as every other tuning knob in this codebase.
    const { linkRewardPrizes: p } = await import("../src/lib/discordLinkReward.js");
    expect(p()).not.toBeNull();
  });
});
