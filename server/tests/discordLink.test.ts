// The link-code store: minting, normalising, single use, expiry, and the
// one-to-one binding rules.
//
// discordLink.ts imports ../db.js at module top, so prisma is stubbed —
// nothing here can reach a database. The stub is a hand-rolled fake rather
// than a mock library because the interesting assertions are about WHICH
// queries run and in what order, and a fake makes those readable.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface CodeRow {
  code: string;
  discordId: string;
  discordLabel: string;
  expiresAt: Date;
}

const db = {
  rows: new Map<string, { discordId: string; userId: string }>(),
  /** Pending link codes, keyed by code. The real store is a table now — it was
   *  a Map inside discordLink.ts, and a deploy wiping it mid-link is the bug
   *  that moved it. The fake keeps the same constraints the migration does:
   *  `code` unique as the primary key, `discordId` unique so minting replaces. */
  codes: new Map<string, CodeRow>(),
  /** Lets one test make the pre-check miss, so the P2002 catch is reachable. */
  findUniqueOverride: null as null | (() => null),
  /** Forces the next N generated codes to collide, so the mint retry loop is
   *  reachable without waiting on a 1-in-600-million coincidence. */
  forceCodeCollisions: 0,
};

// ASYNC factory so the REAL Prisma error class can be imported. A plain Error
// with `.code = "P2002"` bolted on does not satisfy redeemLinkCode's
// `instanceof Prisma.PrismaClientKnownRequestError`, so a hand-rolled one would
// silently skip the branch it is meant to cover.
vi.mock("../src/db.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
  prisma: {
    discordLink: {
      findUnique: async ({ where }: { where: { discordId?: string; userId?: string } }) => {
        if (db.findUniqueOverride) return db.findUniqueOverride();
        if (where.discordId) return db.rows.get(where.discordId) ?? null;
        if (where.userId) {
          for (const r of db.rows.values()) if (r.userId === where.userId) return r;
        }
        return null;
      },
      create: async ({ data }: { data: { discordId: string; userId: string } }) => {
        for (const r of db.rows.values()) {
          if (r.userId === data.userId) {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "5.22.0",
              meta: { target: ["userId"] },
            });
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
    discordLinkCode: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { discordId: string };
        create: CodeRow;
        update: Omit<CodeRow, "discordId">;
      }) => {
        // Primary-key collision on `code`, which is what the mint loop retries.
        if (db.forceCodeCollisions > 0 && !db.codes.has(create.code)) {
          db.forceCodeCollisions--;
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
            meta: { target: ["code"] },
          });
        }
        const existing = [...db.codes.values()].find((r) => r.discordId === where.discordId);
        if (existing) {
          // Unique on discordId: the old row is REPLACED, not added to.
          db.codes.delete(existing.code);
          const row = { ...existing, ...update, discordId: where.discordId };
          db.codes.set(row.code, row);
          return row;
        }
        if (db.codes.has(create.code)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
            meta: { target: ["code"] },
          });
        }
        db.codes.set(create.code, create);
        return create;
      },
      findFirst: async ({
        where,
      }: {
        where: { code: string; expiresAt?: { gt: Date } };
      }) => {
        const row = db.codes.get(where.code);
        if (!row) return null;
        // Expiry is part of the WHERE in the real query, so it is here too —
        // an expired row must be invisible even before the sweep removes it.
        if (where.expiresAt?.gt && row.expiresAt <= where.expiresAt.gt) return null;
        return row;
      },
      // `where` is optional: _resetCodesForTest calls deleteMany({}) to drop
      // everything, which is a legitimate Prisma call shape.
      deleteMany: async (args?: { where?: { code?: string; expiresAt?: { lte: Date } } }) => {
        const where = args?.where ?? {};
        let count = 0;
        for (const [k, r] of [...db.codes]) {
          const byCode = where.code !== undefined && r.code === where.code;
          const byExpiry = where.expiresAt?.lte !== undefined && r.expiresAt <= where.expiresAt.lte;
          const all = where.code === undefined && where.expiresAt === undefined;
          if (byCode || byExpiry || all) {
            db.codes.delete(k);
            count++;
          }
        }
        return { count };
      },
    },
  },
  };
});

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

async function mint(discordId = DISCORD_A, label = "trainer#0001"): Promise<string> {
  const r = await mintLinkCode(discordId, label);
  if ("error" in r) throw new Error("unexpected capacity error");
  return r.code;
}

beforeEach(async () => {
  await _resetCodesForTest();
  db.rows.clear();
  db.findUniqueOverride = null;
  vi.useRealTimers();
});

describe("normalizeCode", () => {
  it("uppercases and strips the separators people type into a grouped code", async () => {
    expect(normalizeCode("abc-234")).toBe("ABC234");
    expect(normalizeCode("ABC 234")).toBe("ABC234");
    expect(normalizeCode("abc_234")).toBe("ABC234");
  });

  it("does NOT strip arbitrary invalid characters — prose must not become a code", async () => {
    // This is the important one. A "drop anything outside the alphabet" rule
    // turns "Code: ABC234" into "CDEABC", because C, D and E are valid code
    // characters — a confident lookup of somebody else's code rather than a
    // failed lookup of this one.
    expect(normalizeCode("Code: ABC234")).not.toBe("ABC234");
    expect(normalizeCode("Code: ABC234")).toBe("CODE:A");
  });

  it("never returns more than the code length", async () => {
    expect(normalizeCode("ABCDEFGHJK")).toHaveLength(6);
  });
});

describe("mintLinkCode", () => {
  it("mints a six-character code from the unambiguous alphabet", async () => {
    const code = await mint();
    expect(code).toHaveLength(6);
    // No character that has a lookalike ever appears.
    expect(code).not.toMatch(/[OIL01UV]/);
  });

  it("REPLACES a previous code for the same Discord user", async () => {
    const first = await mint();
    const second = await mint();
    expect(second).not.toBe(first);
    // The old one is dead — otherwise running /link five times leaves five
    // live codes, four of which the player has forgotten about.
    expect(await peekLinkCode(first)).toBeNull();
    expect(await peekLinkCode(second)).not.toBeNull();
  });

  it("carries the Discord label so the site can name the account", async () => {
    const code = await mint(DISCORD_A, "someone#1234");
    expect((await peekLinkCode(code))?.discordLabel).toBe("someone#1234");
  });
});

describe("redeemLinkCode", () => {
  it("binds the account and consumes the code", async () => {
    const code = await mint();
    const res = await redeemLinkCode(code, "user-a");
    expect(res).toMatchObject({ ok: true, discordId: DISCORD_A });
    expect(await userIdForDiscord(DISCORD_A)).toBe("user-a");
    // Single use: the same code cannot bind a second account.
    const again = await redeemLinkCode(code, "user-b");
    expect(again).toEqual({ ok: false, reason: "unknown_code" });
  });

  it("is idempotent when the exact binding already exists", async () => {
    const code1 = await mint();
    await redeemLinkCode(code1, "user-a");
    const code2 = await mint();
    // Same Discord, same game account — the state they asked for is already
    // true, so this reports success rather than sending them to /unlink.
    expect(await redeemLinkCode(code2, "user-a")).toMatchObject({ ok: true });
  });

  it("refuses a Discord account already bound to a DIFFERENT game account", async () => {
    await redeemLinkCode(await mint(), "user-a");
    const code = await mint();
    expect(await redeemLinkCode(code, "user-b")).toEqual({
      ok: false,
      reason: "discord_already_linked",
    });
  });

  it("refuses a game account already bound to a different Discord account", async () => {
    await redeemLinkCode(await mint(DISCORD_A), "user-a");
    const code = await mint(DISCORD_B);
    expect(await redeemLinkCode(code, "user-a")).toEqual({
      ok: false,
      reason: "account_already_linked",
    });
  });

  it("maps a P2002 race to the same answer the pre-check would have given", async () => {
    // The pre-check exists only to produce a good message; the UNIQUE
    // constraint is the guard. This drives the CATCH rather than the check:
    // findUnique is stubbed to report "nothing there" so the pre-check passes,
    // exactly as it would for two concurrent redeems, and create then loses to
    // the constraint.
    db.rows.set("racer", { discordId: "racer", userId: "user-a" });
    const findUnique = db.findUniqueOverride;
    db.findUniqueOverride = () => null; // pre-check sees a clear field
    try {
      const code = await mint(DISCORD_B);
      expect(await redeemLinkCode(code, "user-a")).toEqual({
        ok: false,
        reason: "account_already_linked",
      });
    } finally {
      db.findUniqueOverride = findUnique;
    }
  });

  it("rejects an expired code", async () => {
    vi.useFakeTimers();
    const code = await mint();
    vi.advanceTimersByTime(LINK_CODE_TTL_MS + 1_000);
    expect(await redeemLinkCode(code, "user-a")).toEqual({ ok: false, reason: "unknown_code" });
    expect(await userIdForDiscord(DISCORD_A)).toBeNull();
  });

  it("does not put a code back after a failed redeem", async () => {
    await redeemLinkCode(await mint(DISCORD_A), "user-a");
    const code = await mint(DISCORD_B);
    // Fails: user-a is taken.
    await redeemLinkCode(code, "user-a");
    // The code was consumed anyway, so it cannot be retried. "Already linked"
    // does not become false by trying again, and a code that survives a failed
    // redeem is a code an attacker can retry.
    expect(await peekLinkCode(code)).toBeNull();
  });
});

describe("unlink", () => {
  it("severs from the Discord side and is idempotent", async () => {
    await redeemLinkCode(await mint(), "user-a");
    expect(await unlinkDiscord(DISCORD_A)).toEqual({ removed: true });
    expect(await unlinkDiscord(DISCORD_A)).toEqual({ removed: false });
    expect(await userIdForDiscord(DISCORD_A)).toBeNull();
  });

  it("severs from the game side", async () => {
    await redeemLinkCode(await mint(), "user-a");
    expect(await unlinkUser("user-a")).toEqual({ removed: true });
    expect(await userIdForDiscord(DISCORD_A)).toBeNull();
  });

  it("frees the Discord account to bind a new game account", async () => {
    await redeemLinkCode(await mint(), "user-a");
    await unlinkDiscord(DISCORD_A);
    expect(await redeemLinkCode(await mint(), "user-b")).toMatchObject({ ok: true });
    expect(await userIdForDiscord(DISCORD_A)).toBe("user-b");
  });
});

// ── Behaviour that only exists now the store is a table ──────────────
//
// The bug that moved it: codes lived in a Map, a deploy restarted the process,
// and every outstanding code vanished. The player was told their code was
// "wrong or has expired" about a code that was neither — silent, and blaming
// their typing. A table cannot be restarted away.

describe("the code store is durable and constraint-enforced", () => {
  it("retries when a generated code collides with a live one", async () => {
    // Two mints landing on the same six characters would, unhandled, rebind
    // someone else's pending link. The database detects it now; the loop just
    // rolls again. Forced here because the real odds are ~1 in 600 million.
    db.forceCodeCollisions = 3;
    const code = await mint(DISCORD_A);
    expect(code).toHaveLength(6);
    expect(db.forceCodeCollisions).toBe(0);
    expect(await peekLinkCode(code)).not.toBeNull();
  });

  it("gives up rather than looping forever if every code collides", async () => {
    db.forceCodeCollisions = 999;
    const r = await mintLinkCode(DISCORD_A, "trainer#0001");
    expect(r).toEqual({ error: "capacity" });
    db.forceCodeCollisions = 0;
  });

  it("is single-use even when two requests race the same code", async () => {
    const code = await mint(DISCORD_A);
    // Both find the row; the DELETE decides. Exactly one may bind.
    const [a, b] = await Promise.all([
      redeemLinkCode(code, "user-a"),
      redeemLinkCode(code, "user-b"),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok);
    expect(loser).toMatchObject({ ok: false });
    // And the code is gone either way.
    expect(await peekLinkCode(code)).toBeNull();
  });

  it("keeps one live code per Discord account, not one per /link run", async () => {
    const first = await mint(DISCORD_A);
    const second = await mint(DISCORD_A);
    const third = await mint(DISCORD_A);
    expect(await peekLinkCode(first)).toBeNull();
    expect(await peekLinkCode(second)).toBeNull();
    expect(await peekLinkCode(third)).not.toBeNull();
    expect(db.codes.size).toBe(1);
  });

  it("sweeps expired rows on mint without touching live ones", async () => {
    vi.useFakeTimers();
    const stale = await mint(DISCORD_A);
    vi.advanceTimersByTime(LINK_CODE_TTL_MS + 1);
    // A different user minting is what triggers the sweep.
    const fresh = await mint(DISCORD_B);
    expect(await peekLinkCode(stale)).toBeNull();
    expect(await peekLinkCode(fresh)).not.toBeNull();
    vi.useRealTimers();
  });
});
