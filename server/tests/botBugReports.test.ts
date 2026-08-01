// Ingesting Discord bug reports into the existing BugReport triage queue.
//
// The property that matters is IDEMPOTENCY. The bot listens for new messages
// AND sweeps recent channel history on every boot, so the same message is
// submitted more than once by construction — on every redeploy, for every
// report still inside the sweep window. If a duplicate created a row, the
// triage queue would fill with copies after a few deploys, which is how an
// operator stops reading it.
//
// The guard is `discordMessageId UNIQUE` in the database, NOT a check in the
// route, so this exercises the P2002 path rather than a pre-check.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    reports: [] as Array<{ id: string; discordMessageId: string | null; reporterId: string | null; reporterName: string; title: string; description: string; page: string | null; source: string }>,
    /** discordId → userId, as DiscordLink would resolve it. */
    links: new Map<string, string>(),
    users: new Map<string, string>(),
  },
}));

// ASYNC factory so the real Prisma error class can be imported.
//
// A plain `new Error()` with `.code = "P2002"` bolted on does NOT satisfy the
// route's `instanceof Prisma.PrismaClientKnownRequestError` check, so a mock
// that throws one exercises the 500 path and reports a passing duplicate test
// as a failure — or worse, would let a broken catch look fine. The real class
// is what Prisma throws in production, so it is what the mock throws here.
vi.mock("../src/db.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
  prisma: {
    bugReport: {
      create: async ({ data }: { data: any }) => {
        if (
          data.discordMessageId &&
          state.reports.some((r) => r.discordMessageId === data.discordMessageId)
        ) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "5.22.0",
            meta: { target: ["discordMessageId"] },
          });
        }
        const row = { id: `br${state.reports.length + 1}`, ...data };
        state.reports.push(row);
        return { id: row.id };
      },
    },
    discordLink: {
      findUnique: async ({ where }: { where: { discordId?: string; userId?: string } }) => {
        if (where.discordId) {
          const userId = state.links.get(where.discordId);
          return userId ? { userId, discordId: where.discordId } : null;
        }
        return null;
      },
    },
    user: {
      findFirst: async ({ where }: { where: { id?: string } }) => {
        const username = where.id ? state.users.get(where.id) : undefined;
        return username ? { id: where.id, username } : null;
      },
      findMany: async () => [],
      findUnique: async () => null,
    },
    playerRating: { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0 },
    pendingGrant: { findMany: async () => [], count: async () => 0 },
    giveaway: { findUnique: async () => null, findMany: async () => [] },
    chatMessage: { create: async () => ({}) },
    discordConfig: { findUnique: async () => null },
  },
  };
});
vi.mock("../src/socket.js", () => ({ getIo: () => null, sendToUserGlobal: vi.fn() }));

import botRoute from "../src/routes/bot.js";

const TOKEN = "b".repeat(32);
const MSG = "999888777666555444";

async function post(body: Record<string, unknown>) {
  const res = await botRoute.request("http://local/bug-reports", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const valid = {
  discordMessageId: MSG,
  discordId: "111111111111111111",
  discordName: "someone",
  messageUrl: "https://discord.com/channels/1/2/3",
  title: "Trade window freezes",
  description: "When I lock in a trade the whole window stops responding and I have to reload.",
};

beforeEach(() => {
  process.env.BOT_TOKEN = TOKEN;
  state.reports = [];
  state.links = new Map();
  state.users = new Map();
});

describe("ingest", () => {
  it("creates a report tagged as coming from Discord", async () => {
    const r = await post(valid);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false });
    expect(state.reports).toHaveLength(1);
    expect(state.reports[0]).toMatchObject({
      source: "discord",
      discordMessageId: MSG,
      title: "Trade window freezes",
      // The jump link lives in `page`, which the triage UI already renders.
      page: "https://discord.com/channels/1/2/3",
    });
  });

  it("is IDEMPOTENT — the boot sweep re-submits every report on every deploy", async () => {
    await post(valid);
    const again = await post(valid);
    // Success-shaped, because the state the caller wanted is true. Reporting
    // this as an error would make every restart log a wall of failures.
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(state.reports).toHaveLength(1);
  });

  it("attributes to a game account when the reporter has linked one", async () => {
    state.links.set("111111111111111111", "u1");
    state.users.set("u1", "ash");
    const r = await post(valid);
    expect(r.body.linkedTo).toBe("ash");
    // BOTH identities: the game account to investigate with, the Discord
    // handle to reply to.
    expect(state.reports[0].reporterId).toBe("u1");
    expect(state.reports[0].reporterName).toBe("ash (@someone)");
  });

  it("still ingests an unlinked reporter, named by their Discord handle", async () => {
    const r = await post(valid);
    expect(r.body.linkedTo).toBeNull();
    expect(state.reports[0].reporterId).toBeNull();
    expect(state.reports[0].reporterName).toBe("@someone");
  });

  it("rejects chatter that is too short to be a report", async () => {
    // Bug channels are full of "+1" and "same here". Without a floor every one
    // of those becomes a row in the triage queue.
    const r = await post({ ...valid, description: "same" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("too_short");
    expect(state.reports).toHaveLength(0);
  });

  it("rejects a post with no title", async () => {
    const r = await post({ ...valid, title: "" });
    expect(r.status).toBe(400);
    expect(state.reports).toHaveLength(0);
  });

  it("requires a message id, since that is the idempotency key", async () => {
    const r = await post({ ...valid, discordMessageId: "" });
    expect(r.status).toBe(400);
  });

  it("strips control and RTL-override characters from player text", async () => {
    // Same sanitiser as the trade board. A U+202E in a report title would
    // visually reverse the rest of the row in the admin table.
    await post({ ...valid, title: "Trade‮ window bug", description: valid.description });
    expect(state.reports[0].title).not.toContain("‮");
  });

  it("bounds title and description to the in-game report's limits", async () => {
    await post({ ...valid, title: "T".repeat(300), description: "D".repeat(9000) });
    expect(state.reports[0].title.length).toBeLessThanOrEqual(120);
    expect(state.reports[0].description.length).toBeLessThanOrEqual(4000);
  });

  it("is behind the BOT_TOKEN gate like every other bot route", async () => {
    const res = await botRoute.request("http://local/bug-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect(res.status).toBe(401);
    expect(state.reports).toHaveLength(0);
  });
});
