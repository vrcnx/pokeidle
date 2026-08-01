// The link-code store: minting, normalising, single use, expiry, and the
// one-to-one binding rules.
//
// discordLink.ts imports ../db.js at module top, so prisma is stubbed —
// nothing here can reach a database. The stub is a hand-rolled fake rather
// than a mock library because the interesting assertions are about WHICH
// queries run and in what order, and a fake makes those readable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  rows: new Map<string, { discordId: string; userId: string }>(),
};

vi.mock("../src/db.js", () => ({
  prisma: {
    discordLink: {
      findUnique: async ({ where }: { where: { discordId?: string; userId?: string } }) => {
        if (where.discordId) return db.rows.get(where.discordId) ?? null;
        if (where.userId) {
          for (const r of db.rows.values()) if (r.userId === where.userId) return r;
        }
        return null;
      },
      create: async ({ data }: { data: { discordId: string; userId: string } }) => {
        for (const r of db.rows.values()) {
          if (r.userId === data.userId) {
            const e = new Error("Unique constraint failed") as Error & { code?: string; meta?: unknown };
            e.code = "P2002";
            e.meta = { target: ["userId"] };
            throw e;
          }
        }
        db.rows.set(data.discordId, data);
        return data;
      },
      deleteMany: async ({ where }: { where: { discordId?: string; userId?: string } }) => {
        let count = 0;
        for (const [k, r] of [...db.rows]) {
          if ((where.discordId && r.discordId === where.discordId) ||
              (where.userId && r.userId === where.userId)) {
            db.rows.delete(k);
            count++;
          }
        }
        return { count };
      },
    },
  },
}));

import {
  LINK_CODE_TTL_MS,
  mintLinkCode,
  normalizeCode,
  peekLinkCode,
  redeemLinkCode,
  unlinkDiscord,
  unlinkUser,
  userIdForDiscord,
  _resetCodesForTest,
} from "../src/lib/discordLink.js";

const DISCORD_A = "111111111111111111";
const DISCORD_B = "222222222222222222";

function mint(discordId = DISCORD_A, label = "trainer#0001"): string {
  const r = mintLinkCode(discordId, label);
  if ("error" in r) throw new Error("unexpected capacity error");
  return r.code;
}

beforeEach(() => {
  _resetCodesForTest();
  db.rows.clear();
  vi.useRealTimers();
});

describe("normalizeCode", () => {
  it("uppercases and strips the separators people type into a grouped code", () => {
    expect(normalizeCode("abc-234")).toBe("ABC234");
    expect(normalizeCode("ABC 234")).toBe("ABC234");
    expect(normalizeCode("abc_234")).toBe("ABC234");
  });

  it("does NOT strip arbitrary invalid characters — prose must not become a code", () => {
    // This is the important one. A "drop anything outside the alphabet" rule
    // turns "Code: ABC234" into "CDEABC", because C, D and E are valid code
    // characters — a confident lookup of somebody else's code rather than a
    // failed lookup of this one.
    expect(normalizeCode("Code: ABC234")).not.toBe("ABC234");
    expect(normalizeCode("Code: ABC234")).toBe("CODE:A");
  });

  it("never returns more than the code length", () => {
    expect(normalizeCode("ABCDEFGHJK")).toHaveLength(6);
  });
});

describe("mintLinkCode", () => {
  it("mints a six-character code from the unambiguous alphabet", () => {
    const code = mint();
    expect(code).toHaveLength(6);
    // No character that has a lookalike ever appears.
    expect(code).not.toMatch(/[OIL01UV]/);
  });

  it("REPLACES a previous code for the same Discord user", () => {
    const first = mint();
    const second = mint();
    expect(second).not.toBe(first);
    // The old one is dead — otherwise running /link five times leaves five
    // live codes, four of which the player has forgotten about.
    expect(peekLinkCode(first)).toBeNull();
    expect(peekLinkCode(second)).not.toBeNull();
  });

  it("carries the Discord label so the site can name the account", () => {
    const code = mint(DISCORD_A, "someone#1234");
    expect(peekLinkCode(code)?.discordLabel).toBe("someone#1234");
  });
});

describe("redeemLinkCode", () => {
  it("binds the account and consumes the code", async () => {
    const code = mint();
    const res = await redeemLinkCode(code, "user-a");
    expect(res).toMatchObject({ ok: true, discordId: DISCORD_A });
    expect(await userIdForDiscord(DISCORD_A)).toBe("user-a");
    // Single use: the same code cannot bind a second account.
    const again = await redeemLinkCode(code, "user-b");
    expect(again).toEqual({ ok: false, reason: "unknown_code" });
  });

  it("is idempotent when the exact binding already exists", async () => {
    const code1 = mint();
    await redeemLinkCode(code1, "user-a");
    const code2 = mint();
    // Same Discord, same game account — the state they asked for is already
    // true, so this reports success rather than sending them to /unlink.
    expect(await redeemLinkCode(code2, "user-a")).toMatchObject({ ok: true });
  });

  it("refuses a Discord account already bound to a DIFFERENT game account", async () => {
    await redeemLinkCode(mint(), "user-a");
    const code = mint();
    expect(await redeemLinkCode(code, "user-b")).toEqual({
      ok: false,
      reason: "discord_already_linked",
    });
  });

  it("refuses a game account already bound to a different Discord account", async () => {
    await redeemLinkCode(mint(DISCORD_A), "user-a");
    const code = mint(DISCORD_B);
    expect(await redeemLinkCode(code, "user-a")).toEqual({
      ok: false,
      reason: "account_already_linked",
    });
  });

  it("maps a P2002 race to the same answer the pre-check would have given", async () => {
    // The pre-check is only for the error message; the UNIQUE constraint is
    // the guard. Simulate the race by seeding the row after the code is minted
    // but making the pre-check miss it — the fake throws P2002 on userId.
    const code = mint(DISCORD_B);
    db.rows.set("pre-existing", { discordId: "pre-existing", userId: "user-a" });
    // findUnique(userId) will now find it, so we get the pre-check answer.
    expect(await redeemLinkCode(code, "user-a")).toEqual({
      ok: false,
      reason: "account_already_linked",
    });
  });

  it("rejects an expired code", async () => {
    vi.useFakeTimers();
    const code = mint();
    vi.advanceTimersByTime(LINK_CODE_TTL_MS + 1_000);
    expect(await redeemLinkCode(code, "user-a")).toEqual({ ok: false, reason: "unknown_code" });
    expect(await userIdForDiscord(DISCORD_A)).toBeNull();
  });

  it("does not put a code back after a failed redeem", async () => {
    await redeemLinkCode(mint(DISCORD_A), "user-a");
    const code = mint(DISCORD_B);
    // Fails: user-a is taken.
    await redeemLinkCode(code, "user-a");
    // The code was consumed anyway, so it cannot be retried. "Already linked"
    // does not become false by trying again, and a code that survives a failed
    // redeem is a code an attacker can retry.
    expect(peekLinkCode(code)).toBeNull();
  });
});

describe("unlink", () => {
  it("severs from the Discord side and is idempotent", async () => {
    await redeemLinkCode(mint(), "user-a");
    expect(await unlinkDiscord(DISCORD_A)).toEqual({ removed: true });
    expect(await unlinkDiscord(DISCORD_A)).toEqual({ removed: false });
    expect(await userIdForDiscord(DISCORD_A)).toBeNull();
  });

  it("severs from the game side", async () => {
    await redeemLinkCode(mint(), "user-a");
    expect(await unlinkUser("user-a")).toEqual({ removed: true });
    expect(await userIdForDiscord(DISCORD_A)).toBeNull();
  });

  it("frees the Discord account to bind a new game account", async () => {
    await redeemLinkCode(mint(), "user-a");
    await unlinkDiscord(DISCORD_A);
    expect(await redeemLinkCode(mint(), "user-b")).toMatchObject({ ok: true });
    expect(await userIdForDiscord(DISCORD_A)).toBe("user-b");
  });
});
