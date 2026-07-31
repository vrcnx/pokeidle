// PROXY INTEGRITY — the three defects an adversarial pass found by driving
// POST /api/auctions/:id/bids, not by reading it.
//
// auctionRoute.test.ts proves the happy paths and the single-request attacks.
// This file proves the ones that only appear when two requests overlap, or
// when the proxy row and the auction row disagree. Every case below FAILED
// against the first implementation; each is pinned here so it cannot come
// back.
//
//   1. BRANCH A LEAKED A RIVAL'S SECRET MAXIMUM. `auction` and the proxy row
//      are two separate un-transacted reads, so "I am currentBidderId" did
//      not imply "this row is mine". A rival's bid landing between the two
//      reads — or a row stranded on a previous leader by one degraded write —
//      made the route reply "Your maximum is $X" with somebody else's X, in
//      the message and in the `yourMax` field.
//
//   2. A LEADER'S RAISED MAXIMUM WAS SILENTLY DISCARDED. raiseOwnProxyMax
//      does not move `currentBid`, so the price CAS could not see it: a
//      challenger who had already read the old maximum overwrote the raise
//      with it. A $9,000,000 maximum, acknowledged `ok: true`, lost the lot
//      to a $6,000,000 one.
//
//   3. THE BALANCE CAP LOST LOTS SILENTLY. `auction:proxy_dropped` only fired
//      when the leader could not cover the MINIMUM step. The commoner case —
//      a maximum that would have won outright, stopped by the synced balance
//      — sent a bare "you were outbid" and no explanation at all. That is the
//      exact silent failure the no-escrow money model may not have.

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
import { __resetProxyAvailability } from "../src/lib/auctionProxy.js";

interface AuctionRow {
  id: string; sellerId: string; pokemonId: string; pokemonSnapshot: string;
  startingBid: number; currentBid: number; currentBidderId: string | null;
  status: string; endsAt: Date; createdAt: Date; updatedAt: Date; settledAt: Date | null;
}
interface BidRow { id: string; auctionId: string; bidderId: string; amount: number; createdAt: Date }
interface ProxyRow { auctionId: string; bidderId: string; maxAmount: number; createdAt: Date; updatedAt: Date }
interface UserRow { id: string; username: string; saveData: string | null; saveVersion: number }

/**
 * The same in-memory Prisma as auctionRoute.test.ts, plus two interleaving
 * hooks. They fire at the exact points where a second request can land inside
 * the first one: between the auction read and the proxy read, and immediately
 * before the proxy compare-and-swap. Both windows are real — they span whole
 * DB round-trips in production.
 */
class FakeDb {
  users: UserRow[] = [];
  auctions: AuctionRow[] = [];
  bids: BidRow[] = [];
  proxies: ProxyRow[] = [];
  /** Throw a table-level error exactly ONCE, then behave normally again. */
  proxyThrowsOnce = false;
  beforeProxyReadOnce: (() => Promise<void>) | null = null;
  beforeProxyUpdateOnce: (() => Promise<void>) | null = null;
  private seq = 0;

  private boom() {
    if (this.proxyThrowsOnce) {
      this.proxyThrowsOnce = false;
      throw new Error('relation "AuctionProxyBid" does not exist in the current database.');
    }
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
  private pick(row: any, select: any) {
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
  }

  client: any = {
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
        return u ? this.pick(u, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        this.users.filter((u) => this.matchWhere(u, where)).map((u) => this.pick(u, select)),
      updateMany: async ({ where }: any) => ({ count: this.users.filter((u) => this.matchWhere(u, where)).length }),
    },
    auction: {
      findUnique: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => x.id === where.id);
        return a ? this.pick(a, select) : null;
      },
      findFirst: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => this.matchWhere(x, where));
        return a ? this.pick(a, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        this.auctions.filter((a) => this.matchWhere(a, where ?? {})).map((a) => this.pick(a, select)),
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
        return this.pick(row, select);
      },
    },
    bid: {
      create: async ({ data }: any) => {
        const row: BidRow = { id: `b${++this.seq}`, createdAt: new Date(), ...data };
        this.bids.push(row);
        return row;
      },
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
        return rows.map((b) => this.pick(b, select));
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
        this.boom();
        if (this.beforeProxyReadOnce) {
          const fn = this.beforeProxyReadOnce;
          this.beforeProxyReadOnce = null;
          await fn();
        }
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        return p ? this.pick(p, select) : null;
      },
      findMany: async ({ where, select }: any) => {
        this.boom();
        return this.proxies.filter((p) => this.matchWhere(p, where)).map((p) => this.pick(p, select));
      },
      updateMany: async ({ where, data }: any) => {
        this.boom();
        if (this.beforeProxyUpdateOnce) {
          const fn = this.beforeProxyUpdateOnce;
          this.beforeProxyUpdateOnce = null;
          await fn();
        }
        const hit = this.proxies.filter((p) => this.matchWhere(p, where));
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      },
      upsert: async ({ where, create, update }: any) => {
        this.boom();
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (p) { Object.assign(p, update); return p; }
        const row: ProxyRow = { createdAt: new Date(), updatedAt: new Date(), ...create };
        this.proxies.push(row);
        return row;
      },
    },
  };
}

let db: FakeDb;

const save = (money: number) => JSON.stringify({ money, party: [{ id: "p1", name: "pika" }], box: [] });
const seedUser = (id: string, username: string, money: number) => {
  db.users.push({ id, username, saveData: save(money), saveVersion: 1 });
};
const setMoney = (id: string, m: number) => { db.users.find((u) => u.id === id)!.saveData = save(m); };

function seedAuction(over: Partial<AuctionRow> = {}): void {
  db.auctions.push({
    id: over.id ?? "a1", sellerId: "seller", pokemonId: "mon1",
    pokemonSnapshot: JSON.stringify({ id: "mon1", name: "gyarados", level: 66, speciesKey: "gyarados" }),
    startingBid: 500_000, currentBid: 0, currentBidderId: null, status: "active",
    endsAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(), settledAt: null,
    ...over,
  });
}

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
const bid = (id: string, amount: number) => call("POST", `/${id}/bids`, { amount });

beforeEach(() => {
  db = new FakeDb();
  h.setDb(db);
  h.emits.length = 0;
  h.direct.length = 0;
  h.setUser("u1", "alice");
  __resetProxyAvailability();
  seedUser("seller", "seller", 1_000);
  seedUser("u1", "alice", 900_000_000);
  seedUser("u2", "bob", 900_000_000);
});

// ════════════════════════════════════════════════════════════════════
describe("1. a maximum is never read back to a caller who does not own it", () => {
  it("RACE: a rival's bid landing between the two reads does not leak their max", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 700_000);                       // alice leads
    expect(db.auctions[0].currentBidderId).toBe("u1");

    const RIVAL_SECRET = 123_456_789;
    // bob's entire request lands between alice's `auction.findUnique` and her
    // `auctionProxyBid.findUnique` — one round-trip apart, neither in a
    // transaction. Alice's in-flight request now holds a stale auction row
    // that still says she leads, and a proxy row that is bob's.
    db.beforeProxyReadOnce = async () => {
      h.setUser("u2", "bob");
      await bid("a1", RIVAL_SECRET);
      h.setUser("u1", "alice");
    };
    const res = await bid("a1", 1);                 // the cheapest possible probe

    expect(db.proxies[0]).toMatchObject({ bidderId: "u2", maxAmount: RIVAL_SECRET });
    expect(JSON.stringify(res.body)).not.toContain(String(RIVAL_SECRET));
    expect(JSON.stringify(res.body)).not.toContain("123,456,789");
    expect(res.body.yourMax).toBeUndefined();
    expect(res.status).toBe(400);
  });

  it("STRANDED ROW: one degraded write desyncs the row, and it still does not leak", async () => {
    seedAuction({ id: "a1" });
    const SECRET = 55_555_555;
    await bid("a1", SECRET);                        // alice's maximum is stored

    // A single table-level error on the next proxy read latches auctionProxy
    // into degraded mode for this process: bob's bid moves the price but
    // writeLeaderProxy no-ops, so the row stays on ALICE while the auction
    // says BOB. The desync outlives the blip.
    db.proxyThrowsOnce = true;
    h.setUser("u2", "bob");
    await bid("a1", 60_000_000);
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(db.proxies[0].bidderId).toBe("u1");      // the desync, reproduced

    __resetProxyAvailability();                     // a restart clears the latch
    // bob is genuinely the leader, so branch A is entered — but the row he
    // would be shown is alice's.
    const res = await bid("a1", 1_000);
    expect(JSON.stringify(res.body)).not.toContain(String(SECRET));
    expect(JSON.stringify(res.body)).not.toContain("55,555,555");
    expect(res.body.error).toBe("You're already the highest bidder on this auction.");
  });

  it("the owner still sees their OWN maximum, so the guard is not a blanket refusal", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 5_000_000);
    const res = await bid("a1", 1_000_000);         // a lowering attempt
    expect(res.status).toBe(400);
    expect(res.body.yourMax).toBe(5_000_000);
    expect(res.body.error).toContain("$5,000,000");
    expect((await bid("a1", 6_000_000)).status).toBe(200);
    expect(db.proxies[0].maxAmount).toBe(6_000_000);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("2. a raised maximum cannot be overwritten by a stale challenger", () => {
  it("the higher maximum wins, and the loser gets a retryable 409", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 5_000_000);                     // alice leads, max 5M
    expect(db.proxies[0]).toMatchObject({ bidderId: "u1", maxAmount: 5_000_000 });

    // bob resolved against the 5,000,000 he read. Alice raises to 9,000,000
    // before his write lands — invisible to a predicate on `currentBid`,
    // because raising a maximum does not move the price.
    let aliceAck: any = null;
    db.beforeProxyUpdateOnce = async () => {
      h.setUser("u1", "alice");
      aliceAck = await bid("a1", 9_000_000);
      h.setUser("u2", "bob");
    };
    h.setUser("u2", "bob");
    const bobRes = await bid("a1", 6_000_000);

    // Alice was told her maximum is 9,000,000 — that must remain true.
    expect(aliceAck.status).toBe(200);
    expect(aliceAck.body.yourMax).toBe(9_000_000);
    expect(db.proxies[0]).toMatchObject({ bidderId: "u1", maxAmount: 9_000_000 });
    // 9,000,000 beats 6,000,000. The lot stays with alice and bob is told to
    // retry rather than being handed a win against a number nobody holds.
    expect(db.auctions[0].currentBidderId).toBe("u1");
    expect(bobRes.status).toBe(409);
    expect(bobRes.body.error).toBe("someone else just bid — refresh and try again");
    // Nothing partial committed: no bid row, no price move.
    expect(db.bids.filter((b) => b.bidderId === "u2")).toHaveLength(0);
    expect(db.auctions[0].currentBid).toBe(500_000);
  });

  it("bob's retry then resolves against the REAL maximum", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 5_000_000);
    await bid("a1", 9_000_000);                     // alice raises, no contest
    h.setUser("u2", "bob");
    const res = await bid("a1", 6_000_000);
    expect(res.status).toBe(200);
    expect(res.body.outbidImmediately).toBe(true);  // 9M defends
    expect(db.auctions[0].currentBidderId).toBe("u1");
    expect(db.auctions[0].currentBid).toBeLessThanOrEqual(9_000_000);
  });

  it("the guard does not fire on lots with no stored maximum (all live listings)", async () => {
    // The shape of every one of the auctions that predate proxy bidding:
    // a real currentBid and currentBidderId, and no proxy row at all.
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 4_000_012, currentBidderId: "u1" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u1", amount: 4_000_012, createdAt: new Date() });
    h.setUser("u2", "bob");
    const min = (await bid("a1", 1)).body.minNextBid;
    const res = await bid("a1", min);
    expect(res.status).toBe(200);
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(db.auctions[0].currentBid).toBe(min);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("3. losing to the balance cap is never silent", () => {
  it("a maximum that WOULD have won, stopped by the balance, says so", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 50_000_000);                    // alice, max 50M
    setMoney("u1", 2_000_000);                      // she spends down to 2M
    h.setUser("u2", "bob");
    // bob's 2,500,000 is far below alice's 50,000,000 maximum. He only wins
    // because the server will not raise past what her synced balance covers.
    const res = await bid("a1", 2_500_000);

    expect(res.body.youAreHighBidder).toBe(true);
    expect(db.auctions[0].currentBidderId).toBe("u2");
    const drop = h.direct.find((d) => d.event === "auction:proxy_dropped");
    expect(drop).toBeTruthy();
    expect(drop!.userId).toBe("u1");
    expect(drop!.payload).toMatchObject({ auctionId: "a1", yourMax: 50_000_000, balance: 2_000_000 });
    // And the ordinary outbid notice still goes out — they are complementary.
    expect(h.direct.find((d) => d.event === "auction:outbid")).toBeTruthy();
  });

  it("but a leader simply beaten by a bigger maximum is NOT told their max is paused", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 5_000_000);                     // alice, max 5M, fully funded
    h.setUser("u2", "bob");
    await bid("a1", 8_000_000);                     // bob just values it more
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(h.direct.find((d) => d.event === "auction:proxy_dropped")).toBeUndefined();
    expect(h.direct.find((d) => d.event === "auction:outbid")).toBeTruthy();
  });

  it("nor is a leader whose capped maximum still successfully defends", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 50_000_000);
    setMoney("u1", 4_000_000);
    h.setUser("u2", "bob");
    const res = await bid("a1", 1_000_000);
    expect(res.body.youAreHighBidder).toBe(false);  // alice holds
    expect(h.direct.find((d) => d.event === "auction:proxy_dropped")).toBeUndefined();
  });

  it("the drop notice carries no other player's number", async () => {
    seedAuction({ id: "a1" });
    await bid("a1", 50_000_000);
    setMoney("u1", 2_000_000);
    h.setUser("u2", "bob");
    await bid("a1", 2_500_000);
    const drop = h.direct.find((d) => d.event === "auction:proxy_dropped")!;
    // Everything in it is alice's own, or already public.
    expect(Object.keys(drop.payload).sort()).toEqual(["auctionId", "balance", "priceNow", "yourMax"]);
    expect(drop.payload.priceNow).toBe(db.auctions[0].currentBid);
    // bob's maximum (2,500,000) is NOT in it — only the resulting price.
    expect(JSON.stringify(drop.payload)).not.toContain("2500000");
  });
});
