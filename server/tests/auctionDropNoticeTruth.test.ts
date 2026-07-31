// `auction:proxy_dropped` must only ever fire when the BALANCE is what bit.
//
// The client renders that event as, verbatim:
//   "Your maximum is paused — your synced balance is $X and bidding has
//    passed it. Sync and raise your maximum to stay in."
// plus a durable red badge reading "Maximum paused / Bidding has passed your
// synced balance, so we stopped raising for you."
//
// So the event is a factual claim about the player's MONEY. Firing it for a
// leader who was simply outbid tells a player holding $500,000,000 that their
// balance ran out. That is not a generic message, it is a WRONG one, and it
// is the common shape rather than an edge case: a bidder who submits the
// stated minimum ends up with `maxAmount === currentBid`, so the next
// challenger's `required` clears their maximum immediately.
//
// Measured against the route before the guard:
//   drop fired with { yourMax: 500000, balance: 500000000 }
//
// These cases drive the REAL route and read the REAL emitted payloads.
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
    direct: [] as Array<{ userId: string; event: string; payload: any }>,
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({
  getIo: () => null,
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
import { __resetProxyAvailability } from "../src/lib/auctionProxy.js";

interface AuctionRow {
  id: string; sellerId: string; pokemonId: string; pokemonSnapshot: string;
  startingBid: number; currentBid: number; currentBidderId: string | null;
  status: string; endsAt: Date; createdAt: Date; updatedAt: Date; settledAt: Date | null;
}
interface BidRow { id: string; auctionId: string; bidderId: string; amount: number; createdAt: Date }
interface ProxyRow { auctionId: string; bidderId: string; maxAmount: number; createdAt: Date; updatedAt: Date }
interface UserRow { id: string; username: string; saveData: string | null; saveVersion: number }

class FakeDb {
  users: UserRow[] = [];
  auctions: AuctionRow[] = [];
  bids: BidRow[] = [];
  proxies: ProxyRow[] = [];
  private seq = 0;
  private matchWhere(row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === "object" && "in" in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  }
  client: any = {
    $transaction: async (fn: any) => fn(this.client),
    user: {
      findUnique: async ({ where, select }: any) => {
        const u = this.users.find((x) => x.id === where.id);
        if (!u) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (u as any)[k]])) : u;
      },
      findMany: async ({ where, select }: any) => this.users
        .filter((u) => this.matchWhere(u, where))
        .map((u) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (u as any)[k]])) : u)),
      updateMany: async () => ({ count: 1 }),
    },
    auction: {
      findUnique: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => x.id === where.id);
        if (!a) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (a as any)[k]])) : { ...a };
      },
      findFirst: async () => null,
      findMany: async ({ where, select }: any) => this.auctions
        .filter((a) => this.matchWhere(a, where ?? {}))
        .map((a) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (a as any)[k]])) : { ...a })),
      updateMany: async ({ where, data }: any) => {
        const hit = this.auctions.filter((a) => this.matchWhere(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
    },
    bid: {
      create: async ({ data }: any) => {
        const row: BidRow = { id: `b${++this.seq}`, createdAt: new Date(), ...data };
        this.bids.push(row); return row;
      },
      findMany: async ({ where, select }: any) => this.bids
        .filter((b) => this.matchWhere(b, where))
        .map((b) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (b as any)[k]])) : b)),
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
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (!p) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (p as any)[k]])) : p;
      },
      findMany: async ({ where, select }: any) => this.proxies
        .filter((p) => this.matchWhere(p, where))
        .map((p) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (p as any)[k]])) : p)),
      updateMany: async () => ({ count: 1 }),
      upsert: async ({ where, create, update }: any) => {
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (p) { Object.assign(p, update); return p; }
        const row: ProxyRow = { createdAt: new Date(), updatedAt: new Date(), ...create };
        this.proxies.push(row); return row;
      },
    },
  };
}

let db: FakeDb;

const save = (money: number) => JSON.stringify({ money, party: [{ id: "p1" }], box: [] });

/** A lot at $500,000 whose leader (bob) holds `leaderMax` and `leaderMoney`. */
function seed(leaderMax: number, leaderMoney: number) {
  db.users.push({ id: "seller", username: "seller", saveData: save(1_000), saveVersion: 1 });
  db.users.push({ id: "u1", username: "alice", saveData: save(500_000_000), saveVersion: 1 });
  db.users.push({ id: "u2", username: "bob", saveData: save(leaderMoney), saveVersion: 1 });
  db.auctions.push({
    id: "a1", sellerId: "seller", pokemonId: "m1",
    pokemonSnapshot: JSON.stringify({ id: "m1", name: "gyarados", level: 66, speciesKey: "gyarados" }),
    startingBid: 400_000, currentBid: 500_000, currentBidderId: "u2", status: "active",
    endsAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(), settledAt: null,
  });
  db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
  db.proxies.push({ auctionId: "a1", bidderId: "u2", maxAmount: leaderMax, createdAt: new Date(), updatedAt: new Date() });
}

async function bid(amount: number) {
  const res = await app.request("/a1/bids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const dropped = () => h.direct.find((d) => d.event === "auction:proxy_dropped");
const outbid = () => h.direct.find((d) => d.event === "auction:outbid");

beforeEach(() => {
  db = new FakeDb();
  h.setDb(db);
  h.direct.length = 0;
  h.setUser("u1", "alice");
  __resetProxyAvailability();
});

describe("the proxy-paused notice is a claim about MONEY and must be true", () => {
  it("does NOT fire when the leader's maximum was merely exhausted", async () => {
    // bob typed the stated minimum, so his maximum IS the current price. His
    // balance is $500,000,000 — money is not remotely his problem.
    seed(500_000, 500_000_000);
    const res = await bid(510_000);
    expect(res.status).toBe(200);
    expect(res.body.youAreHighBidder).toBe(true);
    // He is told he was outbid, which is exactly what happened...
    expect(outbid()).toBeTruthy();
    // ...and NOT that his balance ran out, which did not happen.
    expect(dropped()).toBeUndefined();
  });

  it("DOES fire when the balance is genuinely what stopped the defence", async () => {
    // bob's maximum would have defended at $510,000; his balance cannot.
    seed(50_000_000, 505_000);
    const res = await bid(600_000);
    expect(res.status).toBe(200);
    expect(res.body.youAreHighBidder).toBe(true);
    const d = dropped();
    expect(d).toBeTruthy();
    expect(d!.userId).toBe("u2");
    expect(d!.payload).toMatchObject({ auctionId: "a1", yourMax: 50_000_000, balance: 505_000 });
    // The claim the client makes from this payload is now checkable and true.
    expect(d!.payload.balance).toBeLessThan(d!.payload.yourMax);
  });

  it("EVERY drop notice ever emitted satisfies balance < yourMax", async () => {
    // Sweep the whole (max, money) space around the boundary and assert the
    // invariant the client's wording depends on.
    const seen: Array<{ max: number; money: number; fired: boolean }> = [];
    for (const max of [500_000, 505_000, 510_000, 2_000_000, 50_000_000]) {
      for (const money of [1_000, 505_000, 510_000, 2_000_000, 500_000_000]) {
        db = new FakeDb(); h.setDb(db); h.direct.length = 0; h.setUser("u1", "alice");
        seed(max, money);
        await bid(600_000);
        const d = dropped();
        seen.push({ max, money, fired: !!d });
        if (d) {
          expect(d.payload.balance, `max=${max} money=${money}`).toBeLessThan(d.payload.yourMax);
        }
      }
    }
    // The sweep actually exercised both outcomes — it is not vacuous.
    expect(seen.some((s) => s.fired)).toBe(true);
    expect(seen.some((s) => !s.fired)).toBe(true);
  });
});
