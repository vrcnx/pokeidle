// Route ORDER on /api/bot.
//
// This file exists because of a bug that reached production: `/tournaments/
// pending` was registered AFTER `/tournaments/:id`, so Hono — which matches in
// registration order — captured the literal string "pending" as an id. The
// announce poll got a 404 whose body read "I couldn't find a tournament with
// that id", which is the most misleading possible failure: it names a cause
// that is not the cause, and the endpoint looks implemented because it returns
// valid JSON.
//
// The lib-level tests could never have caught it. They call
// botTournamentsPending() directly and it works perfectly; the defect was
// entirely in how the route was reached. So this suite goes through the Hono
// app the way the bot does.
//
// The general rule being pinned: EVERY literal path segment must be registered
// before a parameterised sibling that could swallow it. Add a
// `/tournaments/archive` below `/tournaments/:id` and it breaks the same way.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: {
    user: { findFirst: async () => null, findUnique: async () => null, findMany: async () => [] },
    playerRating: { findUnique: async () => null, findFirst: async () => null, findMany: async () => [], count: async () => 0 },
    discordLink: { findUnique: async () => null, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    pendingGrant: { findMany: async () => [] },
    giveaway: { findUnique: async () => null, create: async () => ({ id: "g1" }) },
    giveawayEntry: { create: async () => ({}) },
    chatMessage: { create: async () => ({}) },
    // Empty everywhere: this suite is about WHICH handler runs, not what it
    // returns. A route that reaches the right handler returns the right SHAPE
    // even with no rows, and shape is what the assertions look at.
    tournament: { findMany: async () => [], findUnique: async () => null, updateMany: async () => ({ count: 1 }) },
  },
}));
vi.mock("../src/socket.js", () => ({ getIo: () => null, sendToUserGlobal: vi.fn() }));

import botRoute from "../src/routes/bot.js";

const TOKEN = "b".repeat(32);

async function hit(path: string, init: RequestInit = {}) {
  const res = await botRoute.request(`http://local${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON bodies are a failure the assertions will surface */
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

beforeEach(() => {
  process.env.BOT_TOKEN = TOKEN;
});

describe("literal paths win over parameterised siblings", () => {
  it("/tournaments/pending reaches the announce poll, not the :id handler", async () => {
    const { status, body } = await hit("/tournaments/pending");

    expect(status).toBe(200);
    // The poll's shape. Both keys present is what distinguishes it from the
    // detail handler, which returns { v, linked, tournament }.
    expect(body).toHaveProperty("toAnnounce");
    expect(body).toHaveProperty("toReport");
    expect(Array.isArray(body.toAnnounce)).toBe(true);
  });

  it("does NOT answer /tournaments/pending with the not-found copy", async () => {
    // The precise regression. This body is what shipped, and it is worth
    // asserting against by content rather than only by status: a future
    // reordering could return 404 for an unrelated reason and this test should
    // say which one.
    const { body } = await hit("/tournaments/pending");
    expect(body.reason).not.toBe("I couldn't find a tournament with that id.");
    expect(body.error).toBeUndefined();
  });
});

describe("the parameterised routes still work", () => {
  it("/tournaments/:id 404s for an unknown id, with copy the bot can print", async () => {
    const { status, body } = await hit("/tournaments/nope");
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(typeof body.reason).toBe("string");
  });

  it("/tournaments lists", async () => {
    const { status, body } = await hit("/tournaments?limit=3");
    expect(status).toBe(200);
    expect(Array.isArray(body.tournaments)).toBe(true);
    // Unlinked caller — the bot renders "run /link" off this rather than
    // implying the user is simply not entered.
    expect(body.linked).toBe(false);
  });

  it("POST /tournaments/:id/announced claims, and validates its body", async () => {
    const ok = await hit("/tournaments/t1/announced", {
      method: "POST",
      body: JSON.stringify({ messageId: "m1", channelId: "c1" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.claimed).toBe(true);

    const bad = await hit("/tournaments/t1/announced", {
      method: "POST",
      body: JSON.stringify({ messageId: "m1" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  it("POST /tournaments/:id/reported claims", async () => {
    const { status, body } = await hit("/tournaments/t1/reported", { method: "POST" });
    expect(status).toBe(200);
    expect(body.claimed).toBe(true);
  });
});

describe("the gate still covers every tournament path", () => {
  it.each([
    "/tournaments",
    "/tournaments/pending",
    "/tournaments/t1",
  ])("%s is 401 without a token", async (path) => {
    const res = await botRoute.request(`http://local${path}`);
    expect(res.status).toBe(401);
  });
});
