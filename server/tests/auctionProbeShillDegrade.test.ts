// THREE ATTACKS AND ONE OUTAGE, driven through the REAL Hono route.
//
// Each describe block below started life as a REPRODUCTION — it was written
// against the code as it stood, run, and observed to fail. The failing
// observation is quoted in each block's header. They are kept as regression
// tests so the same attack cannot come back.
//
//   1. PROBING FOR A RIVAL'S SECRET MAXIMUM. A cautious prober who never
//      overshoots used to read the leader's exact maximum out of the public
//      price, at zero commitment, and stop before winning.
//   2. SHILL LADDERS. A seller's alt walked an honest bidder up toward their
//      maximum and NOTHING was written anywhere. The brief required the
//      suspicious case be logged.
//   3. A TRANSIENT DATABASE ERROR. One blip disabled proxy bidding for the
//      whole process forever and stranded the stored maximum on a player who
//      no longer led, which GET / then showed back to them.
//
// Stubbing matches tests/auctionRoute.test.ts: in-memory db, spy socket,
// switchable user, no rate limiter, no real clock dependency.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop as string],
    }),
    user: { id: "u1", username: "alice" },
    setUser: (id: string, username: string) => { h.user.id = id; h.user.username = username; },
    emits: [] as Array<{ room: string; event: string; payload: any }>,
    direct: [] as Array<{ userId: string; event: string; payload: any }>,
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: any) => { h.emits.push({ room, event, payload }); },
    }),
  }),
  sendToUserGlobal: (userId: string, event: string, payload: any) => {
    h.direct.push({ userId, event, payload });
  },
}));
vi.mock("../src/lib/middleware.js", () => ({
  requireUser: async (c: any, next: () => Promise<void>) => {
    c.set("user", { ...h.user, email: "", name: null, isAdmin: false });
    await next();
  },
  blockStream: async (_c: any, next: () => Promise<void>) => { await next(); },
}));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: async () => undefined }));
vi.mock("../src/lib/rateLimit.js", () => ({
  makeRateLimiter: () => ({ consume: () => true, remaining: () => 999 }),
}));
vi.mock("../src/lib/saveAdopt.js", () => ({ emitSaveAdopt: () => undefined }));

import app from "../src/routes/auctions.js";
import { __resetProxyAvailability, proxyBiddingAvailable } from "../src/lib/auctionProxy.js";
import { flushShillWatch } from "../src/lib/auctionShillWatch.js";

// ── In-memory Prisma fake (adds AdminAudit + $executeRaw) ───────────────

interface AuctionRow {
  id: string; sellerId: string; pokemonId: string; pokemonSnapshot: string;
  startingBid: number; currentBid: number; currentBidderId: string | null;
  status: string; endsAt: Date; createdAt: Date; updatedAt: Date; settledAt: Date | null;
}
interface BidRow { id: string; auctionId: string; bidderId: string; amount: number; createdAt: Date }
interface ProxyRow { auctionId: string; bidderId: string; maxAmount: number; createdAt: Date; updatedAt: Date }
interface UserRow { id: string; username: string; saveData: string | null; saveVersion: number }
interface AuditRow { id: string; adminId: string; action: string; targetId: string | null; meta: string | null }

class FakeDb {
  users: UserRow[] = [];
  auctions: AuctionRow[] = [];
  bids: BidRow[] = [];
  proxies: ProxyRow[] = [];
  audits: AuditRow[] = [];
  /** Permanently absent table (the migration never ran). */
  missingProxyTable = false;
  /** Throw ONCE from the next proxy-table call, then behave normally. */
  proxyThrowOnce: unknown = null;
  private seq = 0;

  private guardProxy() {
    if (this.missingProxyTable) throw Object.assign(new Error("no table"), { code: "P2021" });
    if (this.proxyThrowOnce) { const e = this.proxyThrowOnce; this.proxyThrowOnce = null; throw e; }
  }

  private matchWhere<T extends Record<string, any>>(row: T, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === "object" && "in" in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  }

  client: any = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (!sql.includes("AdminAudit")) throw new Error(`unexpected raw sql: ${sql}`);
      const [id, adminId, action, targetId, meta] = values as any[];
      this.audits.push({ id, adminId, action, targetId, meta });
      return 1;
    },
    $transaction: async (fn: any) => {
      const snap = {
        auctions: this.auctions.map((a) => ({ ...a })),
        bids: this.bids.map((b) => ({ ...b })),
        proxies: this.proxies.map((p) => ({ ...p })),
      };
      try {
        return await fn(this.client);
      } catch (e) {
        this.auctions = snap.auctions; this.bids = snap.bids; this.proxies = snap.proxies;
        throw e;
      }
    },
    user: {
      findUnique: async ({ where, select }: any) => {
        const u = this.users.find((x) => x.id === where.id);
        if (!u) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (u as any)[k]])) : u;
      },
      findMany: async ({ where, select }: any) => this.users
        .filter((u) => this.matchWhere(u, where))
        .map((u) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (u as any)[k]])) : u)),
      updateMany: async ({ where, data }: any) => {
        const hit = this.users.filter((u) => this.matchWhere(u, where));
        for (const u of hit) {
          for (const [k, v] of Object.entries<any>(data)) {
            if (v && typeof v === "object" && "increment" in v) (u as any)[k] += v.increment;
            else (u as any)[k] = v;
          }
        }
        return { count: hit.length };
      },
    },
    auction: {
      findUnique: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => x.id === where.id);
        if (!a) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (a as any)[k]])) : { ...a };
      },
      findFirst: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => this.matchWhere(x, where));
        if (!a) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (a as any)[k]])) : { ...a };
      },
      findMany: async ({ where, select }: any) => this.auctions
        .filter((a) => this.matchWhere(a, where ?? {}))
        .map((a) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (a as any)[k]])) : { ...a })),
      updateMany: async ({ where, data }: any) => {
        const hit = this.auctions.filter((a) => this.matchWhere(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
      create: async ({ data, select }: any) => {
        const row: AuctionRow = {
          id: `a${++this.seq}`, currentBid: 0, currentBidderId: null, status: "active",
          createdAt: new Date(), updatedAt: new Date(), settledAt: null, ...data,
        };
        this.auctions.push(row);
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (row as any)[k]])) : row;
      },
    },
    bid: {
      create: async ({ data }: any) => {
        const row: BidRow = { id: `b${++this.seq}`, createdAt: new Date(), ...data };
        this.bids.push(row);
        return row;
      },
      count: async ({ where }: any) => this.bids.filter((b) => this.matchWhere(b, where)).length,
      findMany: async ({ where, select, distinct }: any) => {
        let rows = this.bids.filter((b) => this.matchWhere(b, where));
        if (distinct) {
          const seen = new Set<string>();
          rows = rows.filter((b) => {
            const k = distinct.map((d: string) => (b as any)[d]).join("|");
            if (seen.has(k)) return false;
            seen.add(k); return true;
          });
        }
        return rows.map((b) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (b as any)[k]])) : b));
      },
      groupBy: async ({ by, where }: any) => {
        const rows = this.bids.filter((b) => this.matchWhere(b, where));
        const groups = new Map<string, any>();
        for (const b of rows) {
          const key = by.map((k: string) => (b as any)[k]).join("|");
          if (!groups.has(key)) {
            groups.set(key, { ...Object.fromEntries(by.map((k: string) => [k, (b as any)[k]])), _count: { _all: 0 } });
          }
          groups.get(key)._count._all += 1;
        }
        return [...groups.values()];
      },
    },
    auctionProxyBid: {
      findUnique: async ({ where, select }: any) => {
        this.guardProxy();
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (!p) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (p as any)[k]])) : p;
      },
      findMany: async ({ where, select }: any) => {
        this.guardProxy();
        return this.proxies.filter((p) => this.matchWhere(p, where))
          .map((p) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (p as any)[k]])) : p));
      },
      updateMany: async ({ where, data }: any) => {
        this.guardProxy();
        const hit = this.proxies.filter((p) => this.matchWhere(p, where));
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      },
      upsert: async ({ where, create, update }: any) => {
        this.guardProxy();
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (p) { Object.assign(p, update); return p; }
        const row: ProxyRow = { createdAt: new Date(), updatedAt: new Date(), ...create };
        this.proxies.push(row); return row;
      },
    },
  };
}

let db: FakeDb;

const save = (money: number) =>
  JSON.stringify({ money, party: [{ id: "p1", name: "pika" }], box: [] });

function seedUser(id: string, username: string, money: number) {
  db.users.push({ id, username, saveData: save(money), saveVersion: 1 });
}

function seedAuction(over: Partial<AuctionRow> = {}): AuctionRow {
  const row: AuctionRow = {
    id: over.id ?? "auc1", sellerId: "seller", pokemonId: "mon1",
    pokemonSnapshot: JSON.stringify({ id: "mon1", name: "gyarados", level: 66, speciesKey: "gyarados" }),
    startingBid: 500_000, currentBid: 0, currentBidderId: null, status: "active",
    endsAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(), settledAt: null,
    ...over,
  };
  db.auctions.push(row);
  return row;
}

async function call(method: string, path: string, body?: unknown, raw?: string) {
  const res = await app.request(path, {
    method,
    headers: (body !== undefined || raw !== undefined) ? { "Content-Type": "application/json" } : undefined,
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* */ }
  return { status: res.status, body: parsed };
}

const bid = (id: string, amount: number) => call("POST", `/${id}/bids`, { amount });

beforeEach(() => {
  db = new FakeDb();
  h.setDb(db);
  h.emits.length = 0;
  h.direct.length = 0;
  h.setUser("u1", "alice");
  __resetProxyAvailability();
  seedUser("seller", "seller", 1_000);
  seedUser("u1", "alice", 999_999_999);
  seedUser("u2", "bob", 999_999_999);
  seedUser("u3", "carol", 999_999_999);
});

// ════════════════════════════════════════════════════════════════════
// ATTACK 1 — READING A RIVAL'S SECRET MAXIMUM BY PROBING
//
// REPRODUCED BEFORE THE FIX, against a secret maximum of $90,000,000 on a
// lot standing at $500,000: a prober who never overshoots drove the price up
// in losing bids and read the maximum EXACTLY off the 8th probe, still
// losing, still committed to nothing. The tell was that a losing bid could
// leave the price at a number the prober had not chosen — `min(leaderMax,
// myBid + step)` returns `leaderMax` whenever the cap binds, so the response
// body was a direct function of the secret.
//
// THE FIX is in resolveProxy: a losing challenge now leaves the price at
// EXACTLY the challenger's own submitted maximum and never at the leader's.
// The response is then a function only of what the prober already knew.
// ════════════════════════════════════════════════════════════════════
describe("ATTACK: probing for the leader's secret maximum", () => {
  const SECRET = 90_000_000;

  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u2" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u2", maxAmount: SECRET, createdAt: new Date(), updatedAt: new Date() });
  });

  const reset = () => {
    db.auctions[0].currentBid = 500_000;
    db.auctions[0].currentBidderId = "u2";
    db.proxies[0] = { auctionId: "a1", bidderId: "u2", maxAmount: SECRET, createdAt: new Date(), updatedAt: new Date() };
  };

  it("a LOSING probe leaves the price at the prober's own number, never at the secret", async () => {
    for (const probe of [600_000, 5_000_000, 50_000_000, 89_000_000, 89_999_999]) {
      reset();
      const res = await bid("a1", probe);
      expect(res.status).toBe(200);
      expect(res.body.outbidImmediately).toBe(true);
      // THE WHOLE ATTACK IN ONE ASSERTION: the price the prober is shown is
      // the number the prober typed. Nothing about the secret survives.
      expect(res.body.currentBid).toBe(probe);
      expect(JSON.stringify(res.body)).not.toContain(String(SECRET));
    }
  });

  it("a probe landing EXACTLY on the secret is indistinguishable from any other loss", async () => {
    // The one case where the price does equal the secret — because the prober
    // typed that number themselves. What matters is that the RESPONSE gives
    // them no way to know they hit it: it is byte-identical in shape to a
    // probe $1 lower, so there is no "you found it" signal to stop on.
    reset();
    const onTheNose = await bid("a1", SECRET);
    reset();
    const justUnder = await bid("a1", SECRET - 1);
    for (const [k, v] of Object.entries(onTheNose.body)) {
      if (k === "currentBid") continue;                 // each equals its own probe
      expect(v).toEqual((justUnder.body as any)[k]);
    }
    expect(onTheNose.body.currentBid).toBe(SECRET);      // == the prober's own bid
    expect(justUnder.body.currentBid).toBe(SECRET - 1);  // == the prober's own bid
    expect(onTheNose.body.youAreHighBidder).toBe(false); // ties go to the incumbent
  });

  it("A CAUTIOUS PROBER RUNS OUT OF INFORMATION: 60 losing probes disclose nothing", async () => {
    // The exact attack: walk the price up, never overshoot, read the max off
    // the first response that returns a number you did not choose. Before the
    // fix this terminated with `discovered === SECRET` in single-digit probes.
    let discovered: number | null = null;
    let price = db.auctions[0].currentBid;
    for (let i = 0; i < 60 && discovered === null; i++) {
      const detail = await call("GET", "/a1");
      const probe = detail.body.auction.minNextBid;
      if (probe > SECRET) break;                 // would win — the prober stops
      const res = await bid("a1", probe);
      if (res.status !== 200) break;
      if (res.body.youAreHighBidder) break;      // overshot; no longer free
      if (res.body.currentBid !== probe) discovered = res.body.currentBid;
      if (res.body.currentBid === price) break;  // no progress
      price = res.body.currentBid;
    }
    expect(discovered).toBeNull();
    // And the price never sits on the secret as a parting gift.
    expect(db.auctions[0].currentBid).not.toBe(SECRET);
    expect(db.auctions[0].currentBidderId).toBe("u2");
  });

  it("a probe that CLEARS the maximum still wins and still commits — probing is not free", async () => {
    const res = await bid("a1", 95_000_000);
    expect(res.status).toBe(200);
    expect(res.body.youAreHighBidder).toBe(true);
    // Learning the number costs you the lot at that number plus a step.
    expect(db.auctions[0].currentBid).toBe(SECRET + 10_000);
    expect(db.auctions[0].currentBidderId).toBe("u1");
  });

  it("the incumbent still holds, and their stored maximum is untouched by a probe", async () => {
    await bid("a1", 40_000_000);
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(db.proxies[0]).toMatchObject({ bidderId: "u2", maxAmount: SECRET });
  });
});

// ════════════════════════════════════════════════════════════════════
// ATTACK 2 — SHILL LADDER, PREVIOUSLY UNLOGGED
//
// REPRODUCED BEFORE THE FIX: a third account drove an honest bidder from
// $500,000 upward in 12 consecutive LOSING raises without ever taking the
// lead, and `db.audits` was empty — nothing was written anywhere. The brief
// required "you can stop the trivial case and you should log the suspicious
// one"; only the trivial case (seller bids own lot) was handled.
// ════════════════════════════════════════════════════════════════════
describe("ATTACK: shill / probe ladder is now LOGGED", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u2" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u2", maxAmount: 90_000_000, createdAt: new Date(), updatedAt: new Date() });
  });

  it("a 12-raise losing ladder from one account writes an audit trail", async () => {
    for (let i = 0; i < 12; i++) {
      const detail = await call("GET", "/a1");
      const res = await bid("a1", detail.body.auction.minNextBid);
      expect(res.status).toBe(200);
      expect(res.body.youAreHighBidder).toBe(false);   // never takes the lead
    }
    await flushShillWatch();
    const rows = db.audits.filter((r) => r.action === "auction.repeat_losing_bids");
    expect(rows.length).toBeGreaterThan(0);
    const meta = JSON.parse(rows[rows.length - 1].meta!);
    expect(rows[0].targetId).toBe("a1");
    expect(meta.bidderId).toBe("u1");
    expect(meta.sellerId).toBe("seller");
    expect(meta.losingBidsByThisBidder).toBeGreaterThanOrEqual(4);
  });

  it("an HONEST bidder — one bid, or two — is NOT logged", async () => {
    await bid("a1", 600_000);
    h.setUser("u3", "carol");
    await bid("a1", 900_000);
    await flushShillWatch();
    expect(db.audits.filter((r) => r.action === "auction.repeat_losing_bids")).toHaveLength(0);
  });

  it("a WINNING bidder is not logged however many times they raise", async () => {
    // carol takes the lot outright, then raises her own maximum repeatedly.
    h.setUser("u3", "carol");
    await bid("a1", 95_000_000);
    for (let i = 1; i <= 8; i++) await bid("a1", 95_000_000 + i * 1_000_000);
    await flushShillWatch();
    expect(db.audits.filter((r) => r.action === "auction.repeat_losing_bids")).toHaveLength(0);
  });

  it("the TRIVIAL case — a seller bidding their own lot — is refused AND logged", async () => {
    h.setUser("seller", "seller");
    const res = await bid("a1", 95_000_000);
    expect(res.status).toBe(400);
    await flushShillWatch();
    const rows = db.audits.filter((r) => r.action === "auction.self_bid_blocked");
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe("a1");
    expect(JSON.parse(rows[0].meta!).sellerId).toBe("seller");
  });

  it("a failing audit write NEVER fails the bid", async () => {
    db.client.$executeRaw = async () => { throw new Error("audit table on fire"); };
    for (let i = 0; i < 6; i++) {
      const detail = await call("GET", "/a1");
      const res = await bid("a1", detail.body.auction.minNextBid);
      expect(res.status).toBe(200);
    }
    await flushShillWatch();
  });
});

// ════════════════════════════════════════════════════════════════════
// ATTACK 3 — ONE TRANSIENT DB ERROR DISABLED PROXY BIDDING FOREVER
//
// REPRODUCED BEFORE THE FIX: a single thrown error whose message merely
// CONTAINED the substring "does not exist in the current database" latched
// `proxyTableMissing` for the life of the process. The price then moved to
// the challenger while `writeLeaderProxy` no-opped, leaving the stored row
// on the PREVIOUS leader — and GET / handed that player back a `yourMax` of
// $55,555,555 on a lot they no longer led.
// ════════════════════════════════════════════════════════════════════
describe("OUTAGE: a transient proxy-table error", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u1" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u1", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u1", maxAmount: 55_555_555, createdAt: new Date(), updatedAt: new Date() });
  });

  it("a LOOSE message match no longer disables proxy bidding at all", async () => {
    // This is a Postgres error about some OTHER relation. It used to latch.
    db.proxyThrowOnce = new Error(
      'relation "SomeUnrelatedTable" does not exist in the current database',
    );
    h.setUser("u2", "bob");
    // The request may fail, but proxy bidding must still be ON afterwards.
    await bid("a1", 600_000).catch(() => undefined);
    expect(proxyBiddingAvailable()).toBe(true);
  });

  it("a REAL missing-table error degrades, then RECOVERS after the cooldown", async () => {
    db.proxyThrowOnce = Object.assign(new Error("relation does not exist"), { code: "P2021" });
    h.setUser("u2", "bob");
    await bid("a1", 600_000).catch(() => undefined);
    expect(proxyBiddingAvailable()).toBe(false);
    // Not a permanent sentence: the next request after the cooldown re-probes.
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect(proxyBiddingAvailable()).toBe(true);
    vi.useRealTimers();
  });

  it("a STRANDED row is never resolved as the leader's maximum", async () => {
    // Force the desync directly: the price moved to bob, the row stayed on
    // alice. Before the fix, bob's next bid resolved against alice's
    // $55,555,555 — and alice's own GET showed her a max she no longer held.
    db.auctions[0].currentBid = 600_000;
    db.auctions[0].currentBidderId = "u2";
    // row still says u1 / 55,555,555

    h.setUser("u3", "carol");
    const res = await bid("a1", 700_000);
    expect(res.status).toBe(200);
    // carol must WIN — she was not racing a real maximum. Before the fix the
    // stranded 55,555,555 defended and beat her.
    expect(res.body.youAreHighBidder).toBe(true);
    expect(db.auctions[0].currentBidderId).toBe("u3");
    expect(JSON.stringify(res.body)).not.toContain("55555555");
  });

  it("GET / never shows a maximum to a player who does not hold the lot", async () => {
    db.auctions[0].currentBid = 600_000;
    db.auctions[0].currentBidderId = "u2";     // bob leads
    // stranded row still says alice
    h.setUser("u1", "alice");
    const res = await call("GET", "/");
    expect(res.body.auctions[0].youAreHighBidder).toBe(false);
    expect(res.body.auctions[0].yourMax).toBeNull();
    const mine = await call("GET", "/mine");
    expect(JSON.stringify(mine.body)).not.toContain("55555555");
  });

  it("branch A refuses to read back a row that is not provably yours", async () => {
    db.auctions[0].currentBidderId = "u1";
    db.proxies[0].bidderId = "u2";              // stranded on somebody else
    const res = await bid("a1", 1_000);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("55555555");
  });
});

// ════════════════════════════════════════════════════════════════════
// THE VIEWER'S OWN LISTING, and refusals that explain themselves.
//
// REPRODUCED BEFORE THE FIX: GET / gave the client no way to tell that a lot
// was the viewer's own, so Browse rendered a full, enabled bid box on it and
// the player only learned after a round trip. And every type-level refusal
// returned the bare string "invalid bid" with no explanation.
// ════════════════════════════════════════════════════════════════════
describe("own-listing flag and self-explaining refusals", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null, sellerId: "u1" });
  });

  it("GET / marks the viewer's OWN listing so the client can stop offering a bid box", async () => {
    const mine = await call("GET", "/");
    expect(mine.body.auctions[0].youAreSeller).toBe(true);
    h.setUser("u2", "bob");
    const theirs = await call("GET", "/");
    expect(theirs.body.auctions[0].youAreSeller).toBe(false);
  });

  it("every crafted bid payload is refused with an ACTIONABLE message", async () => {
    h.setUser("u2", "bob");
    const cases: Array<[unknown, RegExp]> = [
      [0, /whole number|at least/i],
      [-1, /whole number|at least/i],
      [510_000.5, /whole number/i],
      [1e12, /too large|maximum/i],
      ["510000", /number/i],
      [null, /number/i],
      [true, /number/i],
      [[510_000], /number/i],
      [{}, /number/i],
    ];
    for (const [amount, pattern] of cases) {
      const res = await call("POST", "/a1/bids", { amount });
      expect(res.status).toBe(400);
      expect(res.body.error, `payload ${JSON.stringify(amount)}`).toMatch(pattern);
      expect(res.body.error).not.toBe("invalid bid");
    }
    // Malformed JSON and an empty body are explained too.
    for (const raw of ["", "{", "not json"]) {
      const res = await call("POST", "/a1/bids", undefined, raw);
      expect(res.status).toBe(400);
      expect(res.body.error).not.toBe("invalid bid");
      expect(res.body.error).toMatch(/amount|number/i);
    }
    expect(db.auctions[0].currentBid).toBe(0);
    expect(db.bids).toHaveLength(0);
  });

  it("crafted CREATE payloads are refused with an actionable message too", async () => {
    db.users.find((u) => u.id === "u1")!.saveData = JSON.stringify({
      money: 5_000, party: [{ id: "m1" }, { id: "m2" }], box: [{ id: "m3" }],
    });
    const bad: Array<[unknown, unknown]> = [
      [500.5, 60], ["500", 60], [null, 60], [true, 60], [[], 60], [{}, 60],
      [1e12, 60], [500, 1], [500, 99_999], [500, "60"],
    ];
    for (const [startingBid, durationMinutes] of bad) {
      const res = await call("POST", "/", { pokemonId: "m3", startingBid, durationMinutes });
      expect(res.status).toBe(400);
      expect(res.body.error, `create ${JSON.stringify([startingBid, durationMinutes])}`)
        .not.toBe("invalid request");
      expect(typeof res.body.error).toBe("string");
      expect(res.body.error.length).toBeGreaterThan(12);
    }
    expect(db.auctions.filter((a) => a.sellerId === "u1" && a.pokemonId === "m3")).toHaveLength(0);
  });
});
