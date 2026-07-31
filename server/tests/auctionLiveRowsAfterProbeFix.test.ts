// THE 24 LIVE AUCTIONS MUST NOT BREAK — RE-PROVED AFTER THE PROBE FIX.
//
// tests/auctionLiveAuctionsUnbroken.test.ts already proves this against a
// snapshot taken when the rule was first written. Production has moved since
// (26 active -> 24; the two sub-$500 shinies have ended; nine fresh $1,000,000
// listings have appeared), and this change alters two things that touch live
// rows — the losing-branch price and the sub-$1,000 base step — so the claim
// is re-measured against the table as it stands rather than inherited.
//
// Every row below is REAL, read read-only from production Postgres
// (SELECT only, no writes) immediately after the fix, with bidder and seller
// ids anonymised and the Pokemon snapshots dropped. Their SHAPES — starting
// bid, current bid, who holds it, and the full real bid history that the
// escalation is keyed on — are exact.
//
// Each row is driven through the ACTUAL route:
//   1. GET /:id to read the minimum the API itself states;
//   2. POST exactly that number — must be accepted;
//   3. POST one dollar below it — must be refused, with the minimum named.
//
// POINT-IN-TIME SNAPSHOT, not a live query: no connection is opened and
// nothing here can flake or drift.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop as string],
    }),
    user: { id: "newcomer", username: "newcomer" },
    setUser: (id: string) => { h.user.id = id; h.user.username = id; },
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({
  getIo: () => ({ to: () => ({ emit: () => undefined }) }),
  sendToUserGlobal: () => undefined,
}));
vi.mock("../src/lib/middleware.js", () => ({
  requireUser: async (c: any, next: () => Promise<void>) => {
    c.set("user", { ...h.user, email: "", name: null, isAdmin: false });
    await next();
  },
  blockStream: async (_c: any, next: () => Promise<void>) => { await next(); },
}));
vi.mock("../src/lib/errorReporting.js", () => ({ recordError: async () => undefined }));
vi.mock("../src/lib/saveAdopt.js", () => ({ emitSaveAdopt: () => undefined }));
vi.mock("../src/lib/rateLimit.js", () => ({
  makeRateLimiter: () => ({ consume: () => true, remaining: () => 999 }),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: async () => undefined }));

import app from "../src/routes/auctions.js";
import { MIN_STARTING_BID } from "../src/lib/auctionBidRules.js";
import { __resetProxyAvailability } from "../src/lib/auctionProxy.js";

interface LiveRow {
  id: string; sellerId: string; startingBid: number; currentBid: number;
  currentBidderId: string | null; bids: Array<[string, number]>;
}

// Read-only from production. 24 rows, status "active".
const LIVE: LiveRow[] = [
  { id: "viw0vc43", sellerId: "seller0", startingBid: 5_000_000, currentBid: 5_000_002, currentBidderId: "bidder0", bids: [["bidder1", 5_000_000], ["bidder1", 5_000_001], ["bidder0", 5_000_002]] },
  { id: "qp8r3ufo", sellerId: "seller1", startingBid: 5_000_000, currentBid: 5_000_000, currentBidderId: "bidder2", bids: [["bidder2", 5_000_000]] },
  { id: "a0gn5rya", sellerId: "seller2", startingBid: 2_000_000, currentBid: 2_000_000, currentBidderId: "bidder3", bids: [["bidder3", 2_000_000]] },
  { id: "z9r6hjin", sellerId: "seller2", startingBid: 5_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "fzofy76k", sellerId: "seller2", startingBid: 5_000_000, currentBid: 5_000_000, currentBidderId: "bidder3", bids: [["bidder3", 5_000_000]] },
  { id: "9kim1ecr", sellerId: "seller1", startingBid: 1_500_000, currentBid: 1_500_002, currentBidderId: "bidder3", bids: [["bidder3", 1_500_000], ["bidder4", 1_500_001], ["bidder3", 1_500_002]] },
  { id: "k36umnbu", sellerId: "seller1", startingBid: 2_500_000, currentBid: 2_500_000, currentBidderId: "bidder3", bids: [["bidder3", 2_500_000]] },
  { id: "mnvgbh5t", sellerId: "seller1", startingBid: 2_500_000, currentBid: 2_500_002, currentBidderId: "bidder3", bids: [["bidder3", 2_500_000], ["bidder5", 2_500_001], ["bidder3", 2_500_002]] },
  { id: "7el6rcqp", sellerId: "seller1", startingBid: 2_500_000, currentBid: 2_500_001, currentBidderId: "bidder5", bids: [["bidder5", 2_500_000], ["bidder5", 2_500_001]] },
  { id: "jy8r2kym", sellerId: "seller2", startingBid: 20_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "41h03kdh", sellerId: "seller1", startingBid: 5_000_000, currentBid: 5_000_000, currentBidderId: "bidder3", bids: [["bidder3", 5_000_000]] },
  { id: "t2jmvwb3", sellerId: "seller1", startingBid: 1_500_000, currentBid: 1_500_000, currentBidderId: "bidder3", bids: [["bidder3", 1_500_000]] },
  { id: "6kw6lyxz", sellerId: "seller1", startingBid: 500_000, currentBid: 500_002, currentBidderId: "bidder6", bids: [["bidder6", 500_000], ["bidder1", 500_001], ["bidder6", 500_002]] },
  { id: "wcp6vyz1", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "yxdhs8gn", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "ts9w90q5", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "majovt9z", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "wbqk2qai", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "40x7h1ni", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "57mwritp", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "onsxceqh", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "5cznu787", sellerId: "seller1", startingBid: 1_000_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "ev692ll9", sellerId: "seller1", startingBid: 2_500_000, currentBid: 0, currentBidderId: null, bids: [] },
  { id: "ad5ph5aj", sellerId: "seller3", startingBid: 3_000_000, currentBid: 0, currentBidderId: null, bids: [] },
];

class FakeDb {
  users: any[] = [];
  auctions: any[] = [];
  bids: any[] = [];
  proxies: any[] = [];
  private seq = 0;

  private match(row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === "object" && "in" in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  }

  private pick(row: any, select: any) {
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
  }

  client: any = {
    $executeRaw: async () => 1,
    $transaction: async (fn: any) => fn(this.client),
    user: {
      findUnique: async ({ where, select }: any) => {
        const u = this.users.find((x) => x.id === where.id);
        return u ? this.pick(u, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        this.users.filter((u) => this.match(u, where)).map((u) => this.pick(u, select)),
      updateMany: async () => ({ count: 1 }),
    },
    auction: {
      findUnique: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => x.id === where.id);
        return a ? this.pick(a, select) : null;
      },
      findFirst: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => this.match(x, where));
        return a ? this.pick(a, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        this.auctions.filter((a) => this.match(a, where ?? {})).map((a) => this.pick(a, select)),
      updateMany: async ({ where, data }: any) => {
        const hit = this.auctions.filter((a) => this.match(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
    },
    bid: {
      create: async ({ data }: any) => {
        const row = { id: `nb${++this.seq}`, createdAt: new Date(), ...data };
        this.bids.push(row); return row;
      },
      findMany: async ({ where, select, distinct }: any) => {
        let rows = this.bids.filter((b) => this.match(b, where));
        if (distinct) {
          const seen = new Set<string>();
          rows = rows.filter((b) => {
            const k = distinct.map((d: string) => b[d]).join("|");
            if (seen.has(k)) return false;
            seen.add(k); return true;
          });
        }
        return rows.map((b) => this.pick(b, select));
      },
      groupBy: async ({ by, where }: any) => {
        const rows = this.bids.filter((b) => this.match(b, where));
        const groups = new Map<string, any>();
        for (const b of rows) {
          const key = by.map((k: string) => b[k]).join("|");
          if (!groups.has(key)) {
            groups.set(key, { ...Object.fromEntries(by.map((k: string) => [k, b[k]])), _count: { _all: 0 } });
          }
          groups.get(key)._count._all += 1;
        }
        return [...groups.values()];
      },
    },
    auctionProxyBid: {
      // PRODUCTION STATE, verified read-only: the migration is UNAPPLIED and
      // this table does not exist. Every live row therefore takes the
      // "no incumbent maximum" path on its next bid — which is exactly the
      // path being proved safe here.
      findUnique: async () => { throw Object.assign(new Error("no table"), { code: "P2021" }); },
      findMany: async () => { throw Object.assign(new Error("no table"), { code: "P2021" }); },
      updateMany: async () => { throw Object.assign(new Error("no table"), { code: "P2021" }); },
      upsert: async () => { throw Object.assign(new Error("no table"), { code: "P2021" }); },
    },
  };
}

let db: FakeDb;

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* */ }
  return { status: res.status, body: parsed };
}

function reseed() {
  db = new FakeDb();
  h.setDb(db);
  __resetProxyAvailability();
  const money = JSON.stringify({ money: 900_000_000, party: [{ id: "p1" }], box: [] });
  for (const id of ["newcomer", "seller0", "seller1", "seller2", "seller3",
    "bidder0", "bidder1", "bidder2", "bidder3", "bidder4", "bidder5", "bidder6"]) {
    db.users.push({ id, username: id, saveData: money, saveVersion: 1 });
  }
  let n = 0;
  for (const row of LIVE) {
    db.auctions.push({
      id: row.id, sellerId: row.sellerId, pokemonId: `mon-${row.id}`,
      pokemonSnapshot: JSON.stringify({ id: `mon-${row.id}`, name: "lot", level: 100, speciesKey: "mew" }),
      startingBid: row.startingBid, currentBid: row.currentBid, currentBidderId: row.currentBidderId,
      status: "active", endsAt: new Date(Date.now() + 6 * 3_600_000),
      createdAt: new Date(Date.now() - 3_600_000), updatedAt: new Date(), settledAt: null,
    });
    for (const [bidderId, amount] of row.bids) {
      db.bids.push({ id: `hb${++n}`, auctionId: row.id, bidderId, amount, createdAt: new Date(Date.now() - 1_000 * n) });
    }
  }
  h.setUser("newcomer");
}

beforeEach(reseed);

describe("the 24 live production auctions, driven through the real route", () => {
  it("NO live currentBid is retroactively illegal", () => {
    for (const row of LIVE) {
      if (row.currentBid > 0) expect(row.currentBid).toBeGreaterThanOrEqual(row.startingBid);
    }
  });

  it("EVERY live auction states a minimum, and accepts exactly it", async () => {
    for (const row of LIVE) {
      reseed();
      const detail = await call("GET", `/${row.id}`);
      expect(detail.status, row.id).toBe(200);
      const min = detail.body.auction.minNextBid;
      expect(min, row.id).toBeGreaterThan(row.currentBid);
      const ok = await call("POST", `/${row.id}/bids`, { amount: min });
      expect(ok.status, `${row.id} @ ${min}`).toBe(200);
      expect(ok.body.ok).toBe(true);
      expect(db.auctions.find((a) => a.id === row.id).currentBid).toBe(min);
    }
  });

  it("EVERY live auction refuses one dollar below its minimum, and NAMES the minimum", async () => {
    for (const row of LIVE) {
      reseed();
      const detail = await call("GET", `/${row.id}`);
      const min = detail.body.auction.minNextBid;
      const low = await call("POST", `/${row.id}/bids`, { amount: min - 1 });
      expect(low.status, row.id).toBe(400);
      expect(low.body.minNextBid, row.id).toBe(min);
      expect(low.body.error).toContain("$");
      expect(low.body.error).not.toBe("invalid bid");
      expect(db.auctions.find((a) => a.id === row.id).currentBid).toBe(row.currentBid);
    }
  });

  it("no live minimum raise exceeds 10% of the live price", async () => {
    for (const row of LIVE) {
      reseed();
      const detail = await call("GET", `/${row.id}`);
      const a = detail.body.auction;
      if (a.currentBid === 0) {
        // Unbid: the minimum is the seller's own ask, verbatim.
        expect(a.minNextBid).toBe(row.startingBid);
        expect(a.minIncrement).toBe(0);
      } else {
        expect(a.minIncrement).toBeLessThanOrEqual(Math.floor(a.currentBid * 0.1));
        expect(a.minIncrement).toBeGreaterThan(0);
      }
    }
  });

  it("the CURRENT holder of a live lot cannot be beaten by a stale stored maximum", async () => {
    // AuctionProxyBid does not exist in production, so every live lot's leader
    // has committed exactly `currentBid` and nothing more. A challenger who
    // meets the minimum must therefore TAKE the lot outright — no phantom
    // proxy defends it.
    for (const row of LIVE.filter((r) => r.currentBidderId !== null)) {
      reseed();
      const detail = await call("GET", `/${row.id}`);
      const res = await call("POST", `/${row.id}/bids`, { amount: detail.body.auction.minNextBid });
      expect(res.body.youAreHighBidder, row.id).toBe(true);
      expect(db.auctions.find((a) => a.id === row.id).currentBidderId).toBe("newcomer");
    }
  });

  it("a live SELLER is still refused on their own lot, and the client is told up front", async () => {
    for (const row of LIVE.slice(0, 6)) {
      reseed();
      h.setUser(row.sellerId);
      const list = await call("GET", "/");
      expect(list.body.auctions.find((a: any) => a.id === row.id).youAreSeller).toBe(true);
      const res = await call("POST", `/${row.id}/bids`, { amount: 90_000_000 });
      expect(res.status).toBe(400);
    }
  });

  it("no live listing sits below the $500 floor — and if one did it would still be biddable", async () => {
    expect(LIVE.filter((r) => r.startingBid < MIN_STARTING_BID)).toHaveLength(0);
    // The two that DID (both since ended) are still covered: the floor is a
    // creation-time rule, so a grandfathered row keeps taking its own ask.
    reseed();
    db.auctions.push({
      id: "legacy100", sellerId: "seller0", pokemonId: "legacy", pokemonSnapshot: "{}",
      startingBid: 100, currentBid: 0, currentBidderId: null, status: "active",
      endsAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(), settledAt: null,
    });
    const detail = await call("GET", "/legacy100");
    expect(detail.body.auction.minNextBid).toBe(100);
    expect((await call("POST", "/legacy100/bids", { amount: 100 })).status).toBe(200);
    // And its NEXT raise is $50, not the $100 (a 100% raise) the old bottom
    // tier demanded of exactly these grandfathered rows.
    const after = await call("GET", "/legacy100");
    expect(after.body.auction.minNextBid).toBe(150);
  });
});
