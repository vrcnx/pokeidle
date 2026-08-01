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
    /** The DiscordConfig singleton, or null when no row exists yet. */
    config: null as { linkReward: string | null; linkRewardEnabled: boolean } | null,
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
    discordConfig: {
      findUnique: async () => state.config,
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
} from "../src/lib/discordLinkReward.js";

const MASTERBALL = '[{"kind":"item","itemId":"masterball","quantity":1}]';
const DISCORD_A = "111111111111111111";
const DISCORD_B = "222222222222222222";

/** Set the DiscordConfig singleton the way the admin dashboard would. */
function configure(linkReward: string | null, linkRewardEnabled = true) {
  state.config = { linkReward, linkRewardEnabled };
}

beforeEach(() => {
  state.grants = [];
  state.accountLevel = 50;
  state.enqueueThrows = false;
  state.config = null;
  enqueueSpy.mockClear();
});

describe("configuration", () => {
  it("is OFF when no DiscordConfig row exists at all", async () => {
    // Absent and disabled are the SAME state — the migration seeds nothing, so
    // a deploy that has never touched the dashboard hands out nothing.
    expect(await linkRewardPrizes()).toBeNull();
    expect(await grantLinkReward("u1", DISCORD_A)).toEqual({ granted: false, reason: "disabled" });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("is OFF when a prize is configured but the switch is off", async () => {
    // Pausing must not require clearing the prize — losing the configuration
    // in order to turn something off is how an operator turns it back on with
    // the wrong thing in it.
    configure(MASTERBALL, false);
    expect(await linkRewardPrizes()).toBeNull();
    expect(await grantLinkReward("u1", DISCORD_A)).toEqual({ granted: false, reason: "disabled" });
  });

  it("is OFF when enabled with an empty prize list", async () => {
    configure("[]", true);
    expect(await linkRewardPrizes()).toBeNull();
  });

  it("is OFF (and logs) when the stored row is malformed, rather than throwing per link", async () => {
    configure("{not json", true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await linkRewardPrizes()).toBeNull();
    expect(await grantLinkReward("u1", DISCORD_A)).toEqual({ granted: false, reason: "disabled" });
    expect(err).toHaveBeenCalled();
  });

  it("refuses a prize that the strict schema rejects", async () => {
    // parsePrizesStrict, not parsePrizes: the row is operator input. The
    // lenient reader is only for rows something else already validated.
    configure('[{"kind":"item","itemId":"masterball"}]', true); // no quantity
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await linkRewardPrizes()).toBeNull();
  });

  it("reads a valid row", async () => {
    configure(MASTERBALL, true);
    expect(await linkRewardPrizes()).toEqual([{ kind: "item", itemId: "masterball", quantity: 1 }]);
  });

  it("picks up a change with no restart — the whole point of leaving env", async () => {
    configure(MASTERBALL, true);
    expect(await linkRewardPrizes()).toHaveLength(1);
    configure('[{"kind":"money","amount":5000}]', true);
    // No cache to invalidate: an operator who saves a new prize and
    // immediately tests /link must get the new one, or the dashboard looks
    // broken.
    expect(await linkRewardPrizes()).toEqual([{ kind: "money", amount: 5000 }]);
  });
});

describe("granting", () => {
  beforeEach(() => configure(MASTERBALL, true));

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
  beforeEach(() => configure(MASTERBALL, true));

  it("is off by default — shipped behaviour is no gate", async () => {
    // The product decision was to ship frictionless. A level-0 account, which
    // is what a brand-new signup is, must still be paid.
    state.accountLevel = 0;
    expect((await grantLinkReward("u1", DISCORD_A)).granted).toBe(true);
  });
});
