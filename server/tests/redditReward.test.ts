// The Reddit post reward, which pays for an UNVERIFIED link.
//
// Nothing checks that the post is real. That is deliberate (see
// lib/redditReward.ts), and it means the tests that matter here are not about
// correctness of a happy path — they are about the two guards that are doing
// all of the work:
//
//   one claim per ACCOUNT   (primary key)
//   one claim per LINK      (unique index on the NORMALISED url)
//
// The second is only as good as the normaliser. Reddit's own share button
// appends `?utm_source=share`, so "the same link submitted twice" is the
// ordinary case rather than a clever attack, and most of this file is about
// which strings have to collapse to one key.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    posts: new Map<string, { userId: string; url: string; urlKey: string }>(),
    config: null as null | { enabled: boolean; prizes: string | null },
    grants: [] as Array<{ userId: string; sourceId: string | null; prizes: unknown[] }>,
  },
}));

class FakeP2002 extends Error {
  code = "P2002";
  constructor() { super("Unique constraint failed"); this.name = "PrismaClientKnownRequestError"; }
}

vi.mock("../src/db.js", () => ({
  prisma: {
    redditPost: {
      // BOTH constraints enforced for real. A fake that modelled only the
      // primary key would pass every test here while the live schema let a
      // hundred accounts claim one link.
      create: async ({ data }: { data: { userId: string; url: string; urlKey: string } }) => {
        if (state.posts.has(data.userId)) throw new FakeP2002();
        for (const p of state.posts.values()) if (p.urlKey === data.urlKey) throw new FakeP2002();
        state.posts.set(data.userId, { ...data });
        return data;
      },
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const row = state.posts.get(where.userId);
        return row ? { ...row } : null;
      },
    },
    redditRewardConfig: {
      findUnique: async () => state.config,
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

const { claimRedditPost, normalizeRedditUrl, getRedditRewardStatus } =
  await import("../src/lib/redditReward.js");

const PRIZES = JSON.stringify([{ kind: "item", itemId: "ultraball", quantity: 10 }]);

beforeEach(() => {
  state.posts.clear();
  state.grants.length = 0;
  state.config = { enabled: true, prizes: PRIZES };
});

const POST = "https://www.reddit.com/r/pokemon/comments/abc123/i_made_a_game/";

describe("what counts as a Reddit link", () => {
  it("takes the ordinary forms, including a paste with no scheme", () => {
    for (const raw of [
      POST,
      "http://reddit.com/r/pokemon/comments/abc123/i_made_a_game",
      "reddit.com/r/pokemon/comments/abc123/i_made_a_game",
      "https://redd.it/abc123",
    ]) {
      expect(normalizeRedditUrl(raw), raw).not.toBeNull();
    }
  });

  it("refuses anything that is not Reddit", () => {
    for (const raw of [
      "", "   ", "not a url", "https://example.com/r/pokemon/comments/abc",
      "https://reddit.com.evil.example/r/x/comments/abc",
      "https://twitter.com/someone/status/1",
      // A bare host is not a post.
      "https://reddit.com", "https://reddit.com/",
    ]) {
      expect(normalizeRedditUrl(raw), raw).toBeNull();
    }
  });

  it("collapses every spelling of ONE post to one key", () => {
    // Reddit's share button appends utm parameters, old.reddit is a different
    // host for the same thread, and a trailing slash is a coin flip. All four
    // are the same post and must not be four claims.
    const keys = new Set([
      POST,
      "https://www.reddit.com/r/pokemon/comments/abc123/i_made_a_game",
      "https://old.reddit.com/r/pokemon/comments/abc123/i_made_a_game/",
      "https://np.reddit.com/r/Pokemon/comments/abc123/i_made_a_game/?utm_source=share&utm_medium=web",
      "reddit.com/r/pokemon/comments/abc123/i_made_a_game#comment",
    ].map((u) => normalizeRedditUrl(u)!.urlKey));
    expect([...keys]).toHaveLength(1);
  });

  it("does NOT collapse two genuinely different posts", () => {
    const a = normalizeRedditUrl(POST)!.urlKey;
    const b = normalizeRedditUrl("https://www.reddit.com/r/pokemon/comments/xyz789/another/")!.urlKey;
    expect(a).not.toBe(b);
  });

  it("reads the subreddit when the path has one, and shrugs when it does not", () => {
    expect(normalizeRedditUrl(POST)!.subreddit).toBe("pokemon");
    expect(normalizeRedditUrl("https://redd.it/abc123")!.subreddit).toBeNull();
  });
});

describe("claiming", () => {
  it("pays once and records the link", async () => {
    const res = await claimRedditPost("u1", POST);
    expect(res.ok).toBe(true);
    expect(state.grants).toHaveLength(1);
    expect(state.posts.get("u1")?.url).toBe(POST);
  });

  it("refuses a second claim from the same account", async () => {
    await claimRedditPost("u1", POST);
    const res = await claimRedditPost("u1", "https://www.reddit.com/r/pokemon/comments/zzz/other/");
    expect(res).toEqual({ ok: false, reason: "already_claimed" });
    expect(state.grants).toHaveLength(1);
  });

  it("refuses the SAME LINK from a different account", async () => {
    // The laziest farm: one post, a hundred accounts.
    await claimRedditPost("u1", POST);
    const res = await claimRedditPost("u2", POST);
    expect(res).toEqual({ ok: false, reason: "link_used" });
    expect(state.grants).toHaveLength(1);
  });

  it("refuses the same link dressed up with tracking parameters", async () => {
    await claimRedditPost("u1", POST);
    const res = await claimRedditPost(
      "u2",
      "https://old.reddit.com/r/Pokemon/comments/abc123/i_made_a_game?utm_source=share",
    );
    expect(res).toEqual({ ok: false, reason: "link_used" });
    expect(state.grants).toHaveLength(1);
  });

  it("tells the two refusals apart, because they need different copy", async () => {
    await claimRedditPost("u1", POST);
    const mine = await claimRedditPost("u1", "https://reddit.com/r/x/comments/new/");
    const theirs = await claimRedditPost("u2", POST);
    expect(mine).not.toEqual(theirs);
  });

  it("two claims landing together pay once", async () => {
    const [a, b] = await Promise.all([
      claimRedditPost("u1", POST),
      claimRedditPost("u1", POST),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(state.grants).toHaveLength(1);
  });

  it("refuses junk without writing anything", async () => {
    const res = await claimRedditPost("u1", "have some free stuff please");
    expect(res).toEqual({ ok: false, reason: "bad_url" });
    expect(state.posts.size).toBe(0);
    expect(state.grants).toHaveLength(0);
  });
});

describe("the switch", () => {
  it("pays nothing while it is off", async () => {
    state.config = { enabled: false, prizes: PRIZES };
    expect(await claimRedditPost("u1", POST)).toEqual({ ok: false, reason: "disabled" });
    expect(state.posts.size).toBe(0);
  });

  it("treats a never-configured row as off", async () => {
    state.config = null;
    expect(await claimRedditPost("u1", POST)).toEqual({ ok: false, reason: "disabled" });
  });

  it("treats enabled-with-no-prizes as off rather than paying nothing", async () => {
    // A promotion that advertises itself and hands over an empty grant is
    // worse than one that is not running.
    state.config = { enabled: true, prizes: null };
    expect(await claimRedditPost("u1", POST)).toEqual({ ok: false, reason: "disabled" });
  });

  it("treats a malformed prize row as off rather than throwing on every load", async () => {
    state.config = { enabled: true, prizes: "{not json" };
    expect(await claimRedditPost("u1", POST)).toEqual({ ok: false, reason: "disabled" });
    expect((await getRedditRewardStatus("u1")).enabled).toBe(false);
  });
});

describe("the status a player sees", () => {
  it("reports not-claimed with the prize on offer", async () => {
    const s = await getRedditRewardStatus("u1");
    expect(s).toMatchObject({ enabled: true, claimed: false, url: null });
    expect(s.prizes).toHaveLength(1);
  });

  it("shows the link back after claiming", async () => {
    await claimRedditPost("u1", POST);
    const s = await getRedditRewardStatus("u1");
    expect(s).toMatchObject({ claimed: true, url: POST });
  });
});
