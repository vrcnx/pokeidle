// GET /api/giveaways and GET /api/giveaways/history, executed against the
// REAL route handlers with an in-memory fake Prisma — the same stubbing shape
// as savesRoute.test.ts. Nothing here opens a DB connection.
//
// The route is the layer where the privacy rules become real: the projection
// can only refuse to emit a losing entrant if the QUERY never loaded one.
// So the fake deliberately honours `include.entries.where`, and the tests
// assert on what the fake was asked for as well as on what came back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current[prop],
    }),
    viewer: { id: "u_me", username: "phoenix" },
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/lib/middleware.js", () => ({
  requireUser: async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: h.viewer.id, username: h.viewer.username, email: "", name: null, isAdmin: false });
    await next();
  },
}));

import app, { _resetGiveawayStatsCache } from "../src/routes/giveaways.js";

// ── Fixtures, from the real production rows ─────────────────────────
const MASTERBALL = '[{"kind":"item","itemId":"masterball","quantity":1}]';
const STONES =
  '[{"kind":"item","itemId":"moonstone","quantity":1},{"kind":"item","itemId":"firestone","quantity":1}]';
const MEW =
  '[{"kind":"pokemon","label":"Shiny Mew (Lv70)","mon":{"speciesKey":"mew","level":70,"isShiny":true}}]';

interface Row {
  id: string; title: string; description: string; status: string;
  createdAt: Date; startsAt: Date | null; endsAt: Date | null; drawnAt: Date | null;
  winnerCount: number; minAccountLevel: number | null; prizes: string;
  drawSeed: string | null; ownerId: string;
}
interface Entry { id: string; giveawayId: string; userId: string; username: string; isWinner: boolean }

const T = (iso: string) => new Date(iso);

let rows: Row[] = [];
let entries: Entry[] = [];
let grants: { userId: string; source: string; sourceId: string | null; deliveredAt: Date | null }[] = [];
/** Everything the route asked the DB for, so the tests can check the QUERY. */
let queries: any[] = [];

function giveaway(o: Partial<Row> & { id: string }): Row {
  return {
    title: "Master Ball Drop", description: "One each.", status: "drawn",
    createdAt: T("2026-07-24T23:37:32.285Z"), startsAt: null, endsAt: null,
    drawnAt: T("2026-07-25T20:02:14.359Z"), winnerCount: 10, minAccountLevel: null,
    prizes: MASTERBALL, drawSeed: "seed_" + o.id, ownerId: "u_admin", ...o,
  };
}

/** Matches the tiny slice of Prisma `where` the routes actually use. */
function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.status) {
    if (typeof where.status === "string" && r.status !== where.status) return false;
    if (where.status.in && !where.status.in.includes(r.status)) return false;
  }
  if (where.createdAt?.lt && !(r.createdAt.getTime() < new Date(where.createdAt.lt).getTime())) return false;
  return true;
}

function entriesFor(giveawayId: string, include: any) {
  const sel = include?.entries;
  let list = entries.filter((e) => e.giveawayId === giveawayId);
  if (sel?.where?.OR) {
    list = list.filter((e) =>
      sel.where.OR.some((cond: any) =>
        (cond.userId !== undefined && e.userId === cond.userId) ||
        (cond.isWinner !== undefined && e.isWinner === cond.isWinner),
      ),
    );
  }
  return list.map((e) => ({ userId: e.userId, username: e.username, isWinner: e.isWinner }));
}

const db = {
  giveaway: {
    findMany: async (args: any) => {
      queries.push({ model: "giveaway.findMany", args });
      const out = rows
        .filter((r) => matchesWhere(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, args.take ?? 1000);
      return out.map((r) => ({
        ...r,
        entries: entriesFor(r.id, args.include),
        _count: { entries: entries.filter((e) => e.giveawayId === r.id).length },
      }));
    },
    count: async (args: any) => rows.filter((r) => matchesWhere(r, args.where)).length,
    findFirst: async (args: any) => {
      const out = rows
        .filter((r) => matchesWhere(r, args.where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      return out ? { createdAt: out.createdAt } : null;
    },
  },
  giveawayEntry: {
    count: async (args: any) =>
      entries.filter((e) => (args.where?.isWinner == null || e.isWinner === args.where.isWinner)).length,
    findMany: async (args: any) => {
      let list = entries.filter((e) => args.where?.isWinner == null || e.isWinner === args.where.isWinner);
      if (args.distinct?.includes("userId")) {
        const seen = new Set<string>();
        list = list.filter((e) => (seen.has(e.userId) ? false : (seen.add(e.userId), true)));
      }
      return list.map((e) => ({ userId: e.userId }));
    },
    groupBy: async (args: any) => {
      const mine = entries.filter((e) => e.userId === args.where.userId);
      const buckets = new Map<boolean, number>();
      for (const e of mine) buckets.set(e.isWinner, (buckets.get(e.isWinner) ?? 0) + 1);
      return [...buckets].map(([isWinner, n]) => ({ isWinner, _count: { _all: n } }));
    },
  },
  pendingGrant: {
    findMany: async (args: any) => {
      queries.push({ model: "pendingGrant.findMany", args });
      return grants
        .filter((g) =>
          g.userId === args.where.userId &&
          g.source === args.where.source &&
          args.where.sourceId.in.includes(g.sourceId),
        )
        .map((g) => ({ sourceId: g.sourceId, deliveredAt: g.deliveredAt }));
    },
  },
};

h.setDb(db);

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() as any };
};

beforeEach(() => {
  queries = [];
  grants = [];
  _resetGiveawayStatsCache();
  rows = [
    // Unpublished. Production is holding one of these right now.
    giveaway({ id: "draft1", title: "Shiny Time", status: "draft", drawnAt: null, prizes: MEW, createdAt: T("2026-07-29T22:52:43.617Z") }),
    giveaway({ id: "live1", title: "Master Ball Drop III", status: "open", drawnAt: null, drawSeed: null, createdAt: T("2026-07-29T08:00:00.000Z"), endsAt: T("2026-07-31T08:00:00.000Z") }),
    giveaway({ id: "past1", title: "Evolution Stone Bundle", status: "drawn", prizes: STONES, winnerCount: 2, createdAt: T("2026-07-27T08:08:44.322Z"), drawnAt: T("2026-07-28T03:10:11.379Z") }),
    giveaway({ id: "past2", title: "Master Ball Drop", status: "drawn", createdAt: T("2026-07-24T23:37:32.285Z") }),
    giveaway({ id: "cancelled1", title: "Scrapped", status: "cancelled", createdAt: T("2026-07-20T00:00:00.000Z") }),
  ];
  entries = [
    { id: "e1", giveawayId: "live1", userId: "u_me", username: "phoenix", isWinner: false },
    { id: "e2", giveawayId: "live1", userId: "u_a", username: "koruem", isWinner: false },
    { id: "e3", giveawayId: "live1", userId: "u_b", username: "naill", isWinner: false },
    { id: "e4", giveawayId: "past1", userId: "u_me", username: "phoenix", isWinner: true },
    { id: "e5", giveawayId: "past1", userId: "u_a", username: "koruem", isWinner: true },
    { id: "e6", giveawayId: "past1", userId: "u_c", username: "sak4i", isWinner: false },
    { id: "e7", giveawayId: "past2", userId: "u_a", username: "koruem", isWinner: true },
    { id: "e8", giveawayId: "past2", userId: "u_d", username: "dudsdiem", isWinner: false },
  ];
});

describe("GET /api/giveaways", () => {
  it("returns live giveaways and history, and nothing else", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    expect(body.giveaways.map((g: any) => g.id)).toEqual(["live1", "past1", "past2"]);
  });

  it("never returns a draft or a cancelled giveaway", async () => {
    const { body } = await get("/");
    const ids = body.giveaways.map((g: any) => g.id);
    expect(ids).not.toContain("draft1");
    expect(ids).not.toContain("cancelled1");
    // And not merely filtered on the way out — the QUERY excluded them.
    for (const q of queries.filter((x) => x.model === "giveaway.findMany")) {
      const s = q.args.where.status;
      expect(typeof s === "string" ? [s] : s.in).not.toContain("draft");
      expect(typeof s === "string" ? [s] : s.in).not.toContain("cancelled");
    }
  });

  it("only ever loads the viewer's row and the winners' rows", async () => {
    // The load-bearing one. A losing entrant's row must not enter this process
    // at all — non-exposure by construction, not by remembering to filter.
    await get("/");
    const listQueries = queries.filter((q) => q.model === "giveaway.findMany");
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of listQueries) {
      expect(q.args.include.entries.where).toEqual({
        OR: [{ userId: "u_me" }, { isWinner: true }],
      });
      // …and the count comes from the DB, not from those rows.
      expect(q.args.include._count).toEqual({ select: { entries: true } });
    }
  });

  it("reports the true entrant count even though it loaded two rows", async () => {
    const { body } = await get("/");
    const live = body.giveaways.find((g: any) => g.id === "live1");
    expect(live.entryCount).toBe(3);
    expect(live.hasEntered).toBe(true);
  });

  it("names winners but never a loser", async () => {
    const { body } = await get("/");
    const flat = JSON.stringify(body);
    expect(flat).toContain("koruem");   // winner of past1 and past2
    expect(flat).not.toContain("sak4i");    // entered past1, lost
    expect(flat).not.toContain("dudsdiem"); // entered past2, lost
  });

  it("emits no user id anywhere in the payload", async () => {
    const { body } = await get("/");
    const flat = JSON.stringify(body);
    for (const id of ["u_me", "u_a", "u_b", "u_c", "u_d", "u_admin"]) {
      expect(flat, `leaked ${id}`).not.toContain(id);
    }
  });

  it("withholds the draw seed on the live giveaway and publishes it on drawn ones", async () => {
    const { body } = await get("/");
    const by = (id: string) => body.giveaways.find((g: any) => g.id === id);
    expect(by("live1").drawSeed).toBeNull();
    expect(by("live1").winners).toEqual([]);
    expect(by("past1").drawSeed).toBe("seed_past1");
  });

  it("carries the mon blob so a Pokémon prize can be drawn as a Pokémon", async () => {
    rows.push(giveaway({ id: "mew1", title: "Shiny Mew", status: "drawn", prizes: MEW, createdAt: T("2026-07-26T00:00:00.000Z") }));
    const { body } = await get("/");
    const mew = body.giveaways.find((g: any) => g.id === "mew1");
    expect(mew.prizes[0].mon.speciesKey).toBe("mew");
    expect(mew.prizes[0].mon.isShiny).toBe(true);
  });
});

describe("GET /api/giveaways — stats", () => {
  it("counts only public giveaways, and reports the viewer's own record", async () => {
    const { body } = await get("/");
    expect(body.stats).toEqual({
      total: 3,             // live1 + past1 + past2; draft and cancelled excluded
      prizesAwarded: 3,     // three isWinner entries
      distinctWinners: 2,   // u_me and u_a
      firstAt: "2026-07-24T23:37:32.285Z",
      you: { entered: 2, won: 1 },
    });
  });

  it("reports a zeroed record for somebody who has never entered", async () => {
    entries = entries.filter((e) => e.userId !== "u_me");
    _resetGiveawayStatsCache();
    const { body } = await get("/");
    expect(body.stats.you).toEqual({ entered: 0, won: 0 });
  });
});

describe("GET /api/giveaways — the viewer's own delivery state", () => {
  it("asks only about the viewer's own grants, for giveaways they won", async () => {
    await get("/");
    const q = queries.find((x) => x.model === "pendingGrant.findMany");
    expect(q.args.where.userId).toBe("u_me");
    expect(q.args.where.source).toBe("giveaway");
    // past1 is the only one they won. live1 and past2 are not asked about.
    expect(q.args.where.sourceId.in).toEqual(["past1"]);
  });

  it("says delivered / queued / unknown, and never guesses", async () => {
    grants = [{ userId: "u_me", source: "giveaway", sourceId: "past1", deliveredAt: null }];
    let body = (await get("/")).body;
    expect(body.giveaways.find((g: any) => g.id === "past1").youWonDelivered).toBe(false);

    grants = [{ userId: "u_me", source: "giveaway", sourceId: "past1", deliveredAt: T("2026-07-28T04:00:00.000Z") }];
    body = (await get("/")).body;
    expect(body.giveaways.find((g: any) => g.id === "past1").youWonDelivered).toBe(true);

    // No grant row: production holds 68 wins against 33 grants, so this is the
    // common case on older giveaways. null, not false.
    grants = [];
    body = (await get("/")).body;
    expect(body.giveaways.find((g: any) => g.id === "past1").youWonDelivered).toBeNull();
  });

  it("is null on giveaways the viewer did not win", async () => {
    grants = [{ userId: "u_me", source: "giveaway", sourceId: "past2", deliveredAt: new Date() }];
    const { body } = await get("/");
    expect(body.giveaways.find((g: any) => g.id === "past2").youWonDelivered).toBeNull();
  });
});

describe("GET /api/giveaways/history", () => {
  it("returns finished giveaways only — no live, no draft, no cancelled", async () => {
    const { status, body } = await get("/history");
    expect(status).toBe(200);
    expect(body.giveaways.map((g: any) => g.id)).toEqual(["past1", "past2"]);
    expect(body.hasMore).toBe(false);
  });

  it("pages backwards from a cursor and reports whether there is more", async () => {
    for (let i = 0; i < 5; i++) {
      rows.push(giveaway({
        id: `old${i}`, title: `Old ${i}`, status: "drawn",
        createdAt: T(`2026-07-1${i}T00:00:00.000Z`),
      }));
    }
    const first = await get("/history?limit=3");
    expect(first.body.giveaways.map((g: any) => g.id)).toEqual(["past1", "past2", "old4"]);
    expect(first.body.hasMore).toBe(true);

    const second = await get(`/history?limit=3&before=${encodeURIComponent(first.body.nextBefore)}`);
    expect(second.body.giveaways.map((g: any) => g.id)).toEqual(["old3", "old2", "old1"]);
    expect(second.body.hasMore).toBe(true);

    const third = await get(`/history?limit=3&before=${encodeURIComponent(second.body.nextBefore)}`);
    expect(third.body.giveaways.map((g: any) => g.id)).toEqual(["old0"]);
    expect(third.body.hasMore).toBe(false);
    expect(third.body.nextBefore).not.toBeNull();
  });

  it("caps the page size rather than trusting the caller", async () => {
    expect((await get("/history?limit=999")).status).toBe(400);
    expect((await get("/history?limit=0")).status).toBe(400);
    expect((await get("/history?before=not-a-date")).status).toBe(400);
  });

  it("applies the same entry narrowing as the list route", async () => {
    await get("/history");
    const q = queries.filter((x) => x.model === "giveaway.findMany").at(-1);
    expect(q.args.include.entries.where).toEqual({ OR: [{ userId: "u_me" }, { isWinner: true }] });
  });

  it("leaks no losing entrant and no user id", async () => {
    const flat = JSON.stringify((await get("/history")).body);
    expect(flat).not.toContain("sak4i");
    expect(flat).not.toContain("dudsdiem");
    expect(flat).not.toContain("u_me");
    expect(flat).not.toContain("u_admin");
  });

  it("returns an empty page rather than an error when the archive runs out", async () => {
    const { status, body } = await get("/history?before=2020-01-01T00:00:00.000Z");
    expect(status).toBe(200);
    expect(body.giveaways).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.nextBefore).toBeNull();
  });
});

describe("GET /api/giveaways — hasMoreHistory", () => {
  it("is false while the whole archive fits in the list response", async () => {
    expect((await get("/")).body.hasMoreHistory).toBe(false);
  });

  it("is true once the combined cap starts truncating history", async () => {
    // 30 open giveaways is absurd, but it is exactly the shape that pushes
    // history off the end of the combined slice.
    for (let i = 0; i < 30; i++) {
      rows.push(giveaway({
        id: `live${i + 2}`, status: "open", drawnAt: null, drawSeed: null,
        createdAt: T(`2026-07-29T09:${String(i).padStart(2, "0")}:00.000Z`),
      }));
    }
    const { body } = await get("/");
    expect(body.hasMoreHistory).toBe(true);
    // Live giveaways are never the ones dropped — that is why the route runs
    // two queries instead of one ordered-and-capped query.
    expect(body.giveaways.every((g: any) => g.status === "open")).toBe(true);
  });
});
