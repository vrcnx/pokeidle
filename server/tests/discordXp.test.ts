// Community XP — the level curve, the cooldown, and the boundary that keeps
// this a separate currency from the game economy.
//
// The curve is pure and gets exhaustive treatment because it is the part
// everyone will compare against other bots. The cooldown gets the careful
// treatment because it is the entire anti-abuse story.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    rows: new Map<string, { discordId: string; xp: number; messages: number; lastAwardAt: Date | null; label: string | null }>(),
    config: null as Record<string, unknown> | null,
  },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    discordConfig: { findUnique: async () => state.config },
    discordXp: {
      findUnique: async ({ where }: { where: { discordId: string } }) =>
        state.rows.get(where.discordId) ?? null,
      create: async ({ data }: { data: any }) => {
        if (state.rows.has(data.discordId)) throw new Error("PK conflict");
        const row = {
          discordId: data.discordId, xp: data.xp ?? 0, messages: data.messages ?? 0,
          lastAwardAt: data.lastAwardAt ?? null, label: data.label ?? null,
        };
        state.rows.set(row.discordId, row);
        return row;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = state.rows.get(where.discordId);
        if (!existing) {
          const row = { discordId: where.discordId, xp: create.xp ?? 0, messages: 0, lastAwardAt: null, label: create.label ?? null };
          state.rows.set(row.discordId, row);
          return row;
        }
        if (update.xp?.increment) existing.xp += update.xp.increment;
        if (update.label) existing.label = update.label;
        return existing;
      },
      // Mirrors the real conditional update: only applies when the WHERE
      // matches, and reports how many rows it touched.
      updateMany: async ({ where, data }: any) => {
        const row = state.rows.get(where.discordId);
        if (!row) return { count: 0 };
        const cutoff = where.OR?.[1]?.lastAwardAt?.lt as Date | undefined;
        const passes = row.lastAwardAt === null || (cutoff !== undefined && row.lastAwardAt < cutoff);
        if (!passes) return { count: 0 };
        if (data.xp?.increment) row.xp += data.xp.increment;
        if (data.messages?.increment) row.messages += data.messages.increment;
        if (data.lastAwardAt) row.lastAwardAt = data.lastAwardAt;
        if (data.label) row.label = data.label;
        return { count: 1 };
      },
      count: async ({ where }: any) => {
        const gt = where?.xp?.gt ?? -1;
        return [...state.rows.values()].filter((r) => r.xp > gt).length;
      },
      findMany: async ({ take }: any) =>
        [...state.rows.values()].sort((a, b) => b.xp - a.xp).slice(0, take),
    },
  },
}));

import {
  XP_DEFAULTS,
  XP_EVENTS,
  awardEventXp,
  awardMessageXp,
  levelFromXp,
  totalXpForLevel,
  xpFor,
  xpForNextLevel,
  xpLeaderboard,
} from "../src/lib/discordXp.js";

const A = "111111111111111111";

function enable(extra: Record<string, unknown> = {}) {
  state.config = { xpEnabled: true, ...extra };
}

beforeEach(() => {
  state.rows = new Map();
  state.config = null;
});

describe("the level curve", () => {
  it("matches 5L² + 50L + 100 — the curve this community already has intuitions for", () => {
    expect(xpForNextLevel(0)).toBe(100);
    expect(xpForNextLevel(1)).toBe(155);
    expect(xpForNextLevel(10)).toBe(1100);
    expect(xpForNextLevel(50)).toBe(15100);
  });

  it("is self-consistent: totalXpForLevel is the sum of every step below it", () => {
    for (const target of [0, 1, 5, 20]) {
      let manual = 0;
      for (let l = 0; l < target; l++) manual += xpForNextLevel(l);
      expect(totalXpForLevel(target)).toBe(manual);
    }
  });

  it("round-trips: the exact total for a level lands on that level with 0 progress", () => {
    // The property that would break silently if the curve and the reader ever
    // disagreed — a level boundary that reports the level below it.
    for (const level of [1, 2, 7, 15, 30]) {
      const lv = levelFromXp(totalXpForLevel(level));
      expect(lv.level).toBe(level);
      expect(lv.intoLevel).toBe(0);
    }
  });

  it("reports one XP short of a boundary as the level below, nearly complete", () => {
    const boundary = totalXpForLevel(10);
    const lv = levelFromXp(boundary - 1);
    expect(lv.level).toBe(9);
    expect(lv.intoLevel).toBe(xpForNextLevel(9) - 1);
    expect(lv.progress).toBeGreaterThan(0.99);
  });

  it("handles zero, negatives and rubbish without throwing", () => {
    // XP comes from a database column; a corrupt or absurd value must degrade,
    // not spin the loop forever or emit NaN.
    for (const xp of [0, -50, NaN, undefined as unknown as number]) {
      const lv = levelFromXp(xp);
      expect(lv.level).toBe(0);
      expect(Number.isFinite(lv.intoLevel)).toBe(true);
    }
    expect(levelFromXp(1e12).level).toBeLessThanOrEqual(1000);
  });
});

describe("message XP", () => {
  it("awards nothing while the feature is off", async () => {
    const res = await awardMessageXp(A, "chan", "someone");
    expect(res).toMatchObject({ awarded: 0, skipped: "disabled" });
    expect(state.rows.size).toBe(0);
  });

  it("awards within the configured range and creates the row", async () => {
    enable();
    const res = await awardMessageXp(A, "chan", "someone");
    expect(res.awarded).toBeGreaterThanOrEqual(XP_DEFAULTS.perMessageMin);
    expect(res.awarded).toBeLessThanOrEqual(XP_DEFAULTS.perMessageMax);
    expect(state.rows.get(A)?.messages).toBe(1);
  });

  it("REFUSES a second message inside the cooldown", async () => {
    // The anti-abuse story in one test. Without this, XP measures typing speed.
    enable();
    await awardMessageXp(A, "chan", "someone");
    const xpAfterFirst = state.rows.get(A)!.xp;
    const second = await awardMessageXp(A, "chan", "someone");
    expect(second).toMatchObject({ awarded: 0, skipped: "cooldown" });
    expect(state.rows.get(A)!.xp).toBe(xpAfterFirst);
    // `messages` counts PAID messages, so it must not move either.
    expect(state.rows.get(A)!.messages).toBe(1);
  });

  it("awards again once the cooldown has elapsed", async () => {
    enable();
    await awardMessageXp(A, "chan", "someone");
    const row = state.rows.get(A)!;
    row.lastAwardAt = new Date(Date.now() - (XP_DEFAULTS.cooldownSec + 5) * 1000);
    const second = await awardMessageXp(A, "chan", "someone");
    expect(second.awarded).toBeGreaterThan(0);
    expect(state.rows.get(A)!.messages).toBe(2);
  });

  it("the cooldown is a conditional UPDATE, so concurrent messages cannot both pay", async () => {
    // Two messages arriving together. A read-then-write would let both through;
    // the WHERE clause on lastAwardAt means exactly one wins.
    enable();
    await awardMessageXp(A, "chan", "someone");
    state.rows.get(A)!.lastAwardAt = new Date(Date.now() - 999_000);
    const before = state.rows.get(A)!.xp;
    const [r1, r2] = await Promise.all([
      awardMessageXp(A, "chan", "someone"),
      awardMessageXp(A, "chan", "someone"),
    ]);
    const paid = [r1, r2].filter((r) => r.awarded > 0);
    expect(paid).toHaveLength(1);
    expect(state.rows.get(A)!.xp).toBe(before + paid[0].awarded);
  });

  it("awards nothing in an ignored channel", async () => {
    enable({ xpIgnoredChannels: "spam-chan, bot-chan" });
    const res = await awardMessageXp(A, "bot-chan", "someone");
    expect(res).toMatchObject({ awarded: 0, skipped: "ignored_channel" });
  });

  it("reports a level-up against the level BEFORE the award", async () => {
    enable({ xpPerMessageMin: 200, xpPerMessageMax: 200 });
    const res = await awardMessageXp(A, "chan", "someone");
    // 200 XP crosses level 1 (100) and lands inside level 1.
    expect(res.previousLevel).toBe(0);
    expect(res.level).toBe(1);
    expect(res.leveledUp).toBe(true);
  });

  it("degrades to a fixed rate when min and max are configured backwards", async () => {
    // Operator input. A negative range would otherwise produce NaN awards.
    enable({ xpPerMessageMin: 50, xpPerMessageMax: 10 });
    const res = await awardMessageXp(A, "chan", "someone");
    expect(res.awarded).toBe(50);
  });
});

describe("event XP", () => {
  it("pays the flat bonus and has no cooldown", async () => {
    // Each event is already gated by something that cannot repeat — a unique
    // constraint or a one-per-account row — so a cooldown here would only
    // block legitimate distinct events.
    enable();
    const first = await awardEventXp(A, "giveawayEntry");
    const second = await awardEventXp(A, "bugReport");
    expect(first.awarded).toBe(XP_EVENTS.giveawayEntry);
    expect(second.awarded).toBe(XP_EVENTS.bugReport);
    expect(state.rows.get(A)!.xp).toBe(XP_EVENTS.giveawayEntry + XP_EVENTS.bugReport);
  });

  it("awards nothing while the feature is off", async () => {
    expect(await awardEventXp(A, "link")).toMatchObject({ awarded: 0, skipped: "disabled" });
  });

  it("does not touch the messages counter — that counts paid MESSAGES", async () => {
    enable();
    await awardEventXp(A, "link");
    expect(state.rows.get(A)!.messages).toBe(0);
  });
});

describe("standings", () => {
  it("ranks by a COUNT of higher scores, so it stays correct outside the top N", async () => {
    enable();
    state.rows.set("a", { discordId: "a", xp: 5000, messages: 0, lastAwardAt: null, label: "a" });
    state.rows.set("b", { discordId: "b", xp: 3000, messages: 0, lastAwardAt: null, label: "b" });
    state.rows.set("c", { discordId: "c", xp: 10, messages: 0, lastAwardAt: null, label: "c" });
    expect((await xpFor("c"))!.rank).toBe(3);
    expect((await xpFor("a"))!.rank).toBe(1);
  });

  it("returns null for someone who has never earned, rather than a zero row", async () => {
    // The bot renders this as "no XP yet" copy rather than as level 0 with a
    // rank, which would imply they are on the board.
    expect(await xpFor("nobody")).toBeNull();
  });

  it("orders the leaderboard by XP and numbers it from 1", async () => {
    state.rows.set("a", { discordId: "a", xp: 10, messages: 0, lastAwardAt: null, label: "a" });
    state.rows.set("b", { discordId: "b", xp: 900, messages: 0, lastAwardAt: null, label: "b" });
    const board = await xpLeaderboard(10);
    expect(board.map((r) => r.label)).toEqual(["b", "a"]);
    expect(board.map((r) => r.rank)).toEqual([1, 2]);
  });
});

describe("the currency boundary", () => {
  it("never enqueues a prize grant — XP is not convertible into game value", async () => {
    // The load-bearing property. If this module ever gains a payout path, chat
    // becomes a faucet on the game economy whose tap is "type in a text box".
    //
    // Asserted on the IMPORT rather than on the text: the file's own comments
    // name enqueuePrizeGrant precisely to say that nothing calls it, so a
    // substring check passes for the wrong reason today and fails for the wrong
    // reason tomorrow. An import statement is the thing that would actually
    // have to appear.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/lib/discordXp.ts", import.meta.url), "utf8"),
    );
    const importsPrizeGrant = /^\s*import[\s\S]*?from\s+["'][^"']*prizeGrant\.js["']/m.test(src);
    expect(importsPrizeGrant).toBe(false);
  });
});
