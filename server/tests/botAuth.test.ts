// The BOT_TOKEN gate on /api/bot.
//
// This is the whole security boundary for a surface that reads player data, so
// the properties below are pinned rather than assumed: fail closed when unset,
// refuse a short secret, refuse a wrong secret, and accept only the Bearer
// form.
//
// routes/bot.ts pulls in db.js, socket.js and the giveaway/prize libs at module
// top. All of them are stubbed — no test may touch a database or a socket
// server (see vitest.config.ts).

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
  },
}));
vi.mock("../src/socket.js", () => ({ getIo: () => null, sendToUserGlobal: vi.fn() }));

import botRoute from "../src/routes/bot.js";

const GOOD = "b".repeat(32);

/** Hit the route directly through Hono's fetch, no HTTP server needed. */
async function hit(path: string, headers: Record<string, string> = {}) {
  return botRoute.request(`http://local${path}`, { headers });
}

beforeEach(() => {
  delete process.env.BOT_TOKEN;
  vi.restoreAllMocks();
});

describe("BOT_TOKEN gate", () => {
  it("FAILS CLOSED when BOT_TOKEN is unset — the API simply does not exist", async () => {
    // No token configured must never mean "no auth required". This is the
    // property that makes an unconfigured deploy safe rather than wide open.
    const res = await hit("/leaderboard", { authorization: `Bearer ${GOOD}` });
    expect(res.status).toBe(401);
  });

  it("refuses a token shorter than 32 chars even when the caller matches it", async () => {
    // A short secret is misconfiguration, not a weak-but-honoured credential.
    // Mirrors adminApiKey's rule. Silenced because the route logs the refusal.
    const short = "a".repeat(31);
    process.env.BOT_TOKEN = short;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await hit("/leaderboard", { authorization: `Bearer ${short}` });
    expect(res.status).toBe(401);
    expect(err).toHaveBeenCalled();
  });

  it("refuses a wrong token of the same length", async () => {
    process.env.BOT_TOKEN = GOOD;
    const res = await hit("/leaderboard", { authorization: `Bearer ${"c".repeat(32)}` });
    expect(res.status).toBe(401);
  });

  it("refuses a token of a different length (the timingSafeEqual guard)", async () => {
    process.env.BOT_TOKEN = GOOD;
    const res = await hit("/leaderboard", { authorization: `Bearer ${"b".repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it("refuses a missing Authorization header", async () => {
    process.env.BOT_TOKEN = GOOD;
    expect((await hit("/leaderboard")).status).toBe(401);
  });

  it("refuses a raw token that is not in Bearer form", async () => {
    // Only the Bearer form is accepted — internal.ts allows a second header
    // for the renderer, and this surface deliberately does not.
    process.env.BOT_TOKEN = GOOD;
    expect((await hit("/leaderboard", { authorization: GOOD })).status).toBe(401);
  });

  it("accepts the correct token", async () => {
    process.env.BOT_TOKEN = GOOD;
    const res = await hit("/leaderboard", { authorization: `Bearer ${GOOD}` });
    expect(res.status).toBe(200);
  });

  it("gates EVERY route, not just the ones with obvious data", async () => {
    // The middleware is mounted on "*", and this is what proves a route added
    // later cannot accidentally sit outside it.
    for (const path of ["/profile", "/rank", "/team", "/dex", "/prizes", "/roles/desired", "/link"]) {
      expect((await hit(path)).status, path).toBe(401);
    }
  });
});

describe("subject resolution", () => {
  beforeEach(() => { process.env.BOT_TOKEN = GOOD; });

  it("tells an unlinked caller to run /link instead of erroring", async () => {
    const res = await hit("/profile?discordId=123456789012345678", {
      authorization: `Bearer ${GOOD}`,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("unlinked");
    // The copy is what the bot prints verbatim, so it has to be an
    // instruction rather than a failure.
    expect(body.reason).toContain("/link");
  });

  it("reports a genuinely unknown username differently from an unlinked caller", async () => {
    const res = await hit("/profile?username=nobody", { authorization: `Bearer ${GOOD}` });
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });
});
