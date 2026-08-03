// WHAT A DEGRADED PROXY TABLE IS ALLOWED TO DO, and what a shill ladder is
// allowed to cost.
//
// Both blocks below started as REPRODUCTIONS against the code as it stood at
// df26eb8. Each failing observation is quoted in its block header. They are
// kept as regression tests.
//
//   1. THE SILENT RULE CHANGE. df26eb8 replaced a permanent latch with a 60s
//      cooldown, which fixed the PERMANENCE but not the SILENCE: inside the
//      window the route still fell through to plain highest-bid-wins, ignored
//      the stored maximum, and committed the price move WITHOUT writing the
//      proxy row — stranding it on the former leader. Reproduced below.
//   2. THE SHILL LADDER'S PAPER TRAIL. df26eb8 logs a repeat loser within ONE
//      lot. The signal the brief actually asked for — the same (seller,
//      bidder) pair recurring ACROSS a seller's lots — was left as a manual
//      admin cross-reference, so nothing in the row told an operator that the
//      pair had form. Reproduced below.
//
// Stubbing matches tests/auctionProbeShillDegrade.test.ts: in-memory db, spy
// socket, switchable user, no rate limiter, no real clock dependency.

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
    errors: [] as Array<Record<string, unknown>>,
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
// The LOUDNESS channel. Captured rather than silenced, because "the fallback
// must be loud" is the property under test.
vi.mock("../src/lib/errorReporting.js", () => ({
  recordError: async (e: Record<string, unknown>) => { h.errors.push(e); },
}));
vi.mock("../src/lib/rateLimit.js", () => ({
  makeRateLimiter: () => ({ consume: () => true, remaining: () => 999 }),
}));
vi.mock("../src/lib/saveAdopt.js", () => ({ emitSaveAdopt: () => undefined }));

import app from "../src/routes/auctions.js";
import { __resetProxyAvailability } from "../src/lib/auctionProxy.js";
import { flushShillWatch } from "../src/lib/auctionShillWatch.js";

// ── In-memory Prisma fake ───────────────────────────────────────────────

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
  /** Every proxy-table statement actually attempted, for re-probe proofs. */
  proxyCalls = 0;
  private seq = 0;

  private guardProxy() {
    this.proxyCalls += 1;
    if (this.missingProxyTable) throw Object.assign(new Error("no table"), { code: "P2021" });
    if (this.proxyThrowOnce) { const e = this.proxyThrowOnce; this.proxyThrowOnce = null; throw e; }
  }

  private matchWhere<T extends Record<string, any>>(row: T, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === "object" && "in" in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
      } else if (v && typeof v === "object" && "not" in (v as any)) {
        if (row[k] === (v as any).not) return false;
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

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  h.errors.length = 0;
  h.setUser("u1", "alice");
  __resetProxyAvailability();
  seedUser("seller", "seller", 1_000);
  seedUser("u1", "alice", 999_999_999);
  seedUser("u2", "bob", 999_999_999);
  seedUser("u3", "carol", 999_999_999);
});

// ════════════════════════════════════════════════════════════════════
// 1. A DEGRADED PROXY TABLE MAY NOT QUIETLY CHANGE THE AUCTION'S RULES
//
// REPRODUCED against df26eb8, with alice leading at $500,000 behind a stored
// maximum of $55,555,555 and ONE transient P2021 on the next proxy read:
//
//     bid  -> 200 {"ok":true,"currentBid":510000,"youAreHighBidder":true}
//     auction.currentBidderId  'u3'      <- carol took the lot for $510,000
//     proxies[0]  {bidderId:'u1', maxAmount:55555555}   <- STRANDED on alice
//
// Alice's $55.5M maximum was ignored, carol won a lot alice had committed
// 108x more to, and the row was left pointing at a player who no longer led.
// Nothing in the response, the socket payload or the client said the rules
// had changed. That is the silent latch, one cooldown window shorter.
//
// THE RULE NOW: if the maximum cannot be read, the bid is REFUSED. A player
// who is told "try again in a moment" has lost nothing; a player who is
// silently switched to a different auction format has lost the lot.
// ════════════════════════════════════════════════════════════════════
describe("a degraded proxy table refuses bids instead of changing the rules", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u1" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u1", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u1", maxAmount: 55_555_555, createdAt: new Date(), updatedAt: new Date() });
  });

  it("ONE transient blip does not hand the lot to a challenger who bid less", async () => {
    db.proxyThrowOnce = Object.assign(new Error("relation does not exist"), { code: "P2021" });
    h.setUser("u3", "carol");

    const res = await bid("a1", 510_000);

    // REFUSED, and refused in a way the player can act on.
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/try again|moment|temporarily/i);
    expect(res.body.retryable).toBe(true);

    // NOTHING MOVED. The price, the leader, the bid history and the stored
    // maximum are all exactly as they were.
    expect(db.auctions[0].currentBid).toBe(500_000);
    expect(db.auctions[0].currentBidderId).toBe("u1");
    expect(db.bids).toHaveLength(1);
    expect(db.proxies[0]).toMatchObject({ bidderId: "u1", maxAmount: 55_555_555 });

    // And it was LOUD.
    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.errors[0].message).toBe("auction_proxy_table_missing");
  });

  it("the refusal never leaks the maximum it could not read", async () => {
    db.proxyThrowOnce = Object.assign(new Error("relation does not exist"), { code: "P2021" });
    h.setUser("u3", "carol");
    const res = await bid("a1", 510_000);
    expect(JSON.stringify(res.body)).not.toContain("55555555");
    expect(JSON.stringify(res.body)).not.toContain("55,555,555");
  });

  it("the very next bid re-probes — there is no cooldown to sit out", async () => {
    db.proxyThrowOnce = Object.assign(new Error("relation does not exist"), { code: "P2021" });
    h.setUser("u3", "carol");
    expect((await bid("a1", 510_000)).status).toBe(503);

    // No timer is advanced, no process is restarted. The blip is over, so the
    // next request works — and it resolves against the REAL maximum.
    const ok = await bid("a1", 600_000);
    expect(ok.status).toBe(200);
    expect(ok.body.youAreHighBidder).toBe(false);      // alice's 55.5M defended
    expect(db.auctions[0].currentBidderId).toBe("u1");
    expect(db.proxies[0]).toMatchObject({ bidderId: "u1", maxAmount: 55_555_555 });
  });

  it("a genuinely absent table refuses every bid and strands no row", async () => {
    db.missingProxyTable = true;
    h.setUser("u3", "carol");
    for (let i = 0; i < 3; i++) {
      const res = await bid("a1", 510_000 + i * 10_000);
      expect(res.status).toBe(503);
    }
    expect(db.auctions[0].currentBid).toBe(500_000);
    expect(db.auctions[0].currentBidderId).toBe("u1");
    expect(db.bids).toHaveLength(1);
    // Every attempt really hit the table rather than short-circuiting on a
    // cached flag — that is what makes recovery instant.
    expect(db.proxyCalls).toBeGreaterThanOrEqual(3);
  });

  it("an unrelated relation error is NOT treated as a missing proxy table", async () => {
    // Somebody else's outage. It must surface as a real error, not quietly
    // disable proxy bidding, and not be miscounted as a proxy-table incident.
    db.proxyThrowOnce = new Error('relation "SomeUnrelatedTable" does not exist in the current database');
    h.setUser("u3", "carol");
    const res = await bid("a1", 510_000).catch(() => ({ status: 500, body: null as any }));
    expect(res.status).not.toBe(200);
    expect(h.errors.some((e) => e.message === "auction_proxy_table_missing")).toBe(false);
    expect(db.auctions[0].currentBidderId).toBe("u1");
  });

  it("raising your OWN maximum is refused too, not answered with a false 409", async () => {
    // Branch A used to return "someone else just bid — refresh and try again"
    // when the table was unreachable. Nobody had bid; that message is a lie
    // and it sends the player to re-read a page that will not help.
    db.missingProxyTable = true;
    h.setUser("u1", "alice");
    const res = await bid("a1", 60_000_000);
    expect(res.status).toBe(503);
    expect(res.body.error).not.toMatch(/someone else just bid/i);
  });

  it("BROWSING still works while the table is down — reading is not bidding", async () => {
    // Refusing a bid protects the auction's rules. Refusing the whole browse
    // page would just be an outage, and shows nobody anything they could act
    // on. The maximum is simply absent.
    db.missingProxyTable = true;
    h.setUser("u1", "alice");
    const list = await call("GET", "/");
    expect(list.status).toBe(200);
    expect(list.body.auctions[0].yourMax).toBeNull();
    expect(h.errors.some((e) => e.message === "auction_proxy_table_missing")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. A SHILL LADDER LEAVES A TRAIL THAT NAMES THE PAIR
//
// REPRODUCED against df26eb8: carol drove alice from $500,000 to $1,440,000
// in 12 raises without once taking the lead. df26eb8 does write a row at the
// 4th, 8th and 12th losing bid — but every one of those rows describes ONE
// lot in isolation, so the operator reading it cannot tell a determined
// honest bidder from an alt that has done the same thing on five of the same
// seller's listings. The brief's actual signal — the (seller, bidder) pair
// recurring across lots — was left entirely to a manual cross-reference.
//
// WHAT CAN AND CANNOT BE DETECTED is stated in auctionShillWatch.ts. This
// block pins the part that IS mechanisable.
// ════════════════════════════════════════════════════════════════════
describe("a shill ladder is recorded with the cross-lot signal attached", () => {
  const auditsFor = (action: string) =>
    db.audits.filter((a) => a.action === action).map((a) => JSON.parse(a.meta ?? "{}"));

  it("the 12-raise ladder is logged, and the price it produced is on the row", async () => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    h.setUser("u1", "alice");
    await bid("a1", 500_000);                    // honest bidder, max 500k
    // Alice raises her hidden maximum to something a ladder can climb toward.
    await bid("a1", 5_000_000);

    h.setUser("u3", "carol");                    // the seller's alt
    let price = db.auctions[0].currentBid;
    for (let i = 0; i < 12; i++) {
      const detail = await call("GET", "/a1");
      const next = detail.body.auction.minNextBid;
      const res = await bid("a1", next);
      expect(res.status).toBe(200);
      expect(res.body.youAreHighBidder).toBe(false);   // never takes the lead
      price = db.auctions[0].currentBid;
    }
    await flushShillWatch();

    expect(price).toBeGreaterThan(500_000);
    expect(db.auctions[0].currentBidderId).toBe("u1");  // alice still holds it

    const rows = auditsFor("auction.repeat_losing_bids");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].sellerId).toBe("seller");
    expect(rows[0].bidderId).toBe("u3");
  });

  it("the row carries the CROSS-LOT count for the (seller, bidder) pair", async () => {
    // Carol has already lost repeatedly on two of this seller's other lots.
    // That history is what separates an alt from a determined bidder, and it
    // belongs ON the row rather than in an operator's head.
    for (const id of ["old1", "old2"]) {
      seedAuction({ id, sellerId: "seller", currentBid: 900_000, currentBidderId: "u2", status: "ended" });
      for (let i = 0; i < 5; i++) {
        db.bids.push({ id: `${id}-b${i}`, auctionId: id, bidderId: "u3", amount: 100_000 + i, createdAt: new Date() });
      }
    }
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    h.setUser("u1", "alice");
    await bid("a1", 500_000);
    await bid("a1", 5_000_000);

    h.setUser("u3", "carol");
    for (let i = 0; i < 4; i++) {
      const detail = await call("GET", "/a1");
      await bid("a1", detail.body.auction.minNextBid);
    }
    await flushShillWatch();

    const rows = auditsFor("auction.repeat_losing_bids");
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[rows.length - 1];
    // The pair has form: lots against this seller where carol bid and lost.
    expect(row.lotsBidAgainstThisSeller).toBeGreaterThanOrEqual(3);
    expect(row.sellerId).toBe("seller");
    expect(row.bidderId).toBe("u3");
  });

  it("an account whose ONLY activity is one seller's lots is flagged as such", async () => {
    for (const id of ["old1", "old2"]) {
      seedAuction({ id, sellerId: "seller", currentBid: 900_000, currentBidderId: "u2", status: "ended" });
      for (let i = 0; i < 5; i++) {
        db.bids.push({ id: `${id}-b${i}`, auctionId: id, bidderId: "u3", amount: 100_000 + i, createdAt: new Date() });
      }
    }
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    h.setUser("u1", "alice");
    await bid("a1", 500_000);
    await bid("a1", 5_000_000);
    h.setUser("u3", "carol");
    for (let i = 0; i < 4; i++) {
      const detail = await call("GET", "/a1");
      await bid("a1", detail.body.auction.minNextBid);
    }
    await flushShillWatch();

    const row = auditsFor("auction.repeat_losing_bids").pop()!;
    // Carol has never bid on anybody else's listing.
    expect(row.exclusiveToThisSeller).toBe(true);
  });

  it("a bidder spread across MANY sellers is not flagged as exclusive", async () => {
    seedUser("seller2", "seller2", 1_000);
    seedAuction({ id: "other", sellerId: "seller2", currentBid: 900_000, currentBidderId: "u2", status: "ended" });
    for (let i = 0; i < 5; i++) {
      db.bids.push({ id: `other-b${i}`, auctionId: "other", bidderId: "u3", amount: 100_000 + i, createdAt: new Date() });
    }
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    h.setUser("u1", "alice");
    await bid("a1", 500_000);
    await bid("a1", 5_000_000);
    h.setUser("u3", "carol");
    for (let i = 0; i < 4; i++) {
      const detail = await call("GET", "/a1");
      await bid("a1", detail.body.auction.minNextBid);
    }
    await flushShillWatch();

    const row = auditsFor("auction.repeat_losing_bids").pop()!;
    expect(row.exclusiveToThisSeller).toBe(false);
  });

  it("the watch NEVER fails or refuses a bid, however broken the audit table", async () => {
    db.client.$executeRaw = async () => { throw new Error("audit table on fire"); };
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    h.setUser("u1", "alice");
    await bid("a1", 500_000);
    await bid("a1", 5_000_000);
    h.setUser("u3", "carol");
    for (let i = 0; i < 6; i++) {
      const detail = await call("GET", "/a1");
      expect((await bid("a1", detail.body.auction.minNextBid)).status).toBe(200);
    }
    await flushShillWatch();
  });
});
