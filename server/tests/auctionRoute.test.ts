// POST /api/auctions and POST /api/auctions/:id/bids executed against the
// REAL route handlers with an in-memory fake Prisma.
//
// This is the execution-level proof the brief demanded: a typecheck cannot
// see a rejected bid with no explanation, and it cannot see a maximum
// leaking into a response body. Every assertion below reads an ACTUAL
// response body or an ACTUAL emitted socket payload.
//
// Stubbing: ../src/db.js is a swappable in-memory fake; ../src/socket.js is a
// spy; ../src/lib/middleware.js injects a switchable current user. Nothing
// here can open a DB connection or a socket.

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
// The real limiter is a module-level token bucket shared by every test in
// this file, so 20 bids in would start returning 429 and mask the assertions.
// Rate limiting is not what these tests are proving.
vi.mock("../src/lib/rateLimit.js", () => ({
  makeRateLimiter: () => ({ consume: () => true, remaining: () => 999 }),
}));
vi.mock("../src/lib/saveAdopt.js", () => ({ emitSaveAdopt: () => undefined }));

import app from "../src/routes/auctions.js";
import { __resetProxyAvailability } from "../src/lib/auctionProxy.js";
import { MAX_BID, MIN_STARTING_BID } from "../src/lib/auctionBidRules.js";

// ── In-memory Prisma fake ───────────────────────────────────────────────

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
  /** Set to a table name to make it behave as if the migration never ran. */
  missingProxyTable = false;
  /** Runs once, immediately before the next auction.updateMany applies. */
  beforeAuctionUpdateOnce: (() => Promise<void>) | null = null;
  private seq = 0;

  private matchWhere<T extends Record<string, any>>(row: T, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === "object" && "in" in (v as any)) {
        if (!(v as any).in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  }

  /** PendingGrant rows. A cancelled listing comes back through here now. */
  grants: { userId: string; prizes: string; source: string; sourceId: string | null }[] = [];

  client: any = {
    $transaction: async (fn: any) => {
      const snap = {
        auctions: this.auctions.map((a) => ({ ...a })),
        bids: this.bids.map((b) => ({ ...b })),
        proxies: this.proxies.map((p) => ({ ...p })),
        grants: this.grants.length,
      };
      try {
        return await fn(this.client);
      } catch (e) {
        this.auctions = snap.auctions; this.bids = snap.bids; this.proxies = snap.proxies;
        // A rolled-back cancel must not leave the lot owed.
        this.grants.length = snap.grants;
        throw e;
      }
    },
    pendingGrant: {
      create: async ({ data }: any) => {
        this.grants.push({ ...data });
        return { id: `g${this.grants.length}` };
      },
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
        if (this.beforeAuctionUpdateOnce) {
          const fn = this.beforeAuctionUpdateOnce;
          this.beforeAuctionUpdateOnce = null;
          await fn();
        }
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
        if (this.missingProxyTable) throw Object.assign(new Error("no table"), { code: "P2021" });
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (!p) return null;
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, (p as any)[k]])) : p;
      },
      findMany: async ({ where, select }: any) => {
        if (this.missingProxyTable) throw Object.assign(new Error("no table"), { code: "P2021" });
        return this.proxies.filter((p) => this.matchWhere(p, where))
          .map((p) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, (p as any)[k]])) : p));
      },
      updateMany: async ({ where, data }: any) => {
        if (this.missingProxyTable) throw Object.assign(new Error("no table"), { code: "P2021" });
        const hit = this.proxies.filter((p) => this.matchWhere(p, where));
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      },
      upsert: async ({ where, create, update }: any) => {
        if (this.missingProxyTable) throw Object.assign(new Error("no table"), { code: "P2021" });
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (p) { Object.assign(p, update); return p; }
        const row: ProxyRow = { createdAt: new Date(), updatedAt: new Date(), ...create };
        this.proxies.push(row); return row;
      },
    },
  };
}

let db: FakeDb;

function save(money: number, inventory: Record<string, number> = {}) {
  return JSON.stringify({ money, party: [{ id: "p1", name: "pika" }], box: [], inventory });
}

function seedUser(id: string, username: string, money: number, inventory: Record<string, number> = {}) {
  db.users.push({ id, username, saveData: save(money, inventory), saveVersion: 1 });
}

/** The seller's live inventory, straight out of the fake save. */
function invOf(userId: string): Record<string, number> {
  const u = db.users.find((x) => x.id === userId)!;
  return JSON.parse(u.saveData!).inventory ?? {};
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

/** Drive the real route. Returns { status, body }. */
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
  seedUser("u1", "alice", 100_000_000);
  seedUser("u2", "bob", 100_000_000);
  seedUser("u3", "carol", 100_000_000);
});

// ════════════════════════════════════════════════════════════════════
describe("minimum starting bid — refused AT CREATION, with a message", () => {
  beforeEach(() => {
    db.users.find((u) => u.id === "u1")!.saveData = JSON.stringify({
      money: 5_000, party: [{ id: "m1" }, { id: "m2" }], box: [{ id: "m3" }],
    });
  });

  it("refuses a $1 listing and NAMES the floor", async () => {
    const res = await call("POST", "/", { pokemonId: "m3", startingBid: 1, durationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Starting bid must be at least $500.");
    expect(res.body.minStartingBid).toBe(500);
    // The message a player can act on — not "invalid request".
    expect(res.body.error).not.toContain("invalid");
    expect(db.auctions).toHaveLength(0);
  });

  it("refuses the old $100 form default", async () => {
    const res = await call("POST", "/", { pokemonId: "m3", startingBid: 100, durationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("$500");
  });

  it("accepts exactly the floor", async () => {
    const res = await call("POST", "/", { pokemonId: "m3", startingBid: MIN_STARTING_BID, durationMinutes: 60 });
    expect(res.status).toBe(201);
    expect(res.body.auction.startingBid).toBe(500);
  });

  it("CRAFTED PAYLOAD: a client that skips the form cannot bypass the floor", async () => {
    for (const crafted of [0, -1, 1, 499, 499.9, "500", null, NaN]) {
      const res = await call("POST", "/", { pokemonId: "m3", startingBid: crafted, durationMinutes: 60 });
      expect(res.status).toBe(400);
    }
    expect(db.auctions).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("minimum increment — refused with an actionable message", () => {
  beforeEach(() => {
    // A $500,000 lot already at $500,000 with one bid from bob.
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u2" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u2", maxAmount: 500_000, createdAt: new Date(), updatedAt: new Date() });
  });

  it("REFUSES the old +$1 creep, and the message states the number and the reason", async () => {
    const res = await bid("a1", 500_001);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Minimum bid is $510,000 — the current $500,000 plus a $10,000 raise.");
    expect(res.body.minNextBid).toBe(510_000);
    expect(res.body.minIncrement).toBe(10_000);
    // Machine-readable too, so the client can prefill rather than guess.
    expect(res.body.currentBid).toBe(500_000);
  });

  it("ACCEPTS exactly the minimum", async () => {
    const res = await bid("a1", 510_000);
    expect(res.status).toBe(200);
    expect(res.body.currentBid).toBe(510_000);
    expect(res.body.youAreHighBidder).toBe(true);
    expect(db.auctions[0].currentBid).toBe(510_000);
  });

  it("refuses one below the minimum, accepts at it — the boundary is exact", async () => {
    expect((await bid("a1", 509_999)).status).toBe(400);
    expect((await bid("a1", 510_000)).status).toBe(200);
  });

  it("CRAFTED PAYLOAD: the body cannot influence the computed minimum", async () => {
    // A caller inventing its own floor/step/bidCount changes nothing: the
    // server recomputes from the auction row and the Bid table.
    const res = await call("POST", "/a1/bids", {
      amount: 500_001, minNextBid: 1, minIncrement: 1, bidCount: 0,
      distinctBidders: 99, startingBid: 1, currentBid: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.minNextBid).toBe(510_000);
    expect(db.auctions[0].currentBid).toBe(500_000);
  });

  it("escalates as a SMALL group trades raises, and the message keeps up", async () => {
    // alice and bob alternate. Each rejection quotes the new, higher step.
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      h.setUser(i % 2 === 0 ? "u1" : "u2", i % 2 === 0 ? "alice" : "bob");
      const low = await bid("a1", db.auctions[0].currentBid + 1);
      expect(low.status).toBe(400);
      steps.push(low.body.minIncrement);
      const ok = await bid("a1", low.body.minNextBid);
      expect(ok.status).toBe(200);
    }
    // Monotone non-decreasing, and it actually rose.
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(steps[steps.length - 1]).toBeGreaterThan(steps[0]);
  });

  it("does NOT escalate when many different people each bid once", async () => {
    for (let i = 4; i <= 12; i++) seedUser(`n${i}`, `n${i}`, 100_000_000);
    const steps: number[] = [];
    for (let i = 4; i <= 12; i++) {
      h.setUser(`n${i}`, `n${i}`);
      const low = await bid("a1", db.auctions[0].currentBid + 1);
      steps.push(low.body.minIncrement);
      await bid("a1", low.body.minNextBid);
    }
    // Flat $10,000 the whole way — healthy price discovery is not taxed.
    expect(new Set(steps)).toEqual(new Set([10_000]));
  });
});

// ════════════════════════════════════════════════════════════════════
describe("THE MAXIMUM IS SECRET — proven against real response bodies", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u2" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u2", maxAmount: 90_000_000, createdAt: new Date(), updatedAt: new Date() });
  });

  const SECRET = 90_000_000;

  /** Deep scan for the secret in ANY position of ANY payload. */
  function containsSecret(v: unknown): boolean {
    if (v === SECRET) return true;
    if (typeof v === "string" && v.includes(String(SECRET))) return true;
    if (Array.isArray(v)) return v.some(containsSecret);
    if (v && typeof v === "object") return Object.values(v).some(containsSecret);
    return false;
  }

  it("GET / (browse) does not carry a rival's maximum", async () => {
    const res = await call("GET", "/");
    expect(res.status).toBe(200);
    expect(containsSecret(res.body)).toBe(false);
    expect(res.body.auctions[0].yourMax).toBeNull();
  });

  it("GET /:id (detail + bid history) does not carry it", async () => {
    const res = await call("GET", "/a1");
    expect(containsSecret(res.body)).toBe(false);
    expect(res.body.auction.yourMax).toBeNull();
  });

  it("GET /mine does not carry it", async () => {
    const res = await call("GET", "/mine");
    expect(containsSecret(res.body)).toBe(false);
  });

  it("the PUBLIC auction payload has an exact, audited key set", async () => {
    const res = await call("GET", "/");
    expect(Object.keys(res.body.auctions[0]).sort()).toEqual([
      "bidCount", "createdAt", "currentBid", "currentBidderUsername", "distinctBidders",
      "endsAt", "id", "minIncrement", "minNextBid", "pokemon", "sellerUsername",
      "settledAt", "startingBid", "status", "yourMax", "youAreHighBidder", "youAreSeller",
      // Item lots. `lotKind` says which of `pokemon` / `item` is filled; the
      // other is null. Both are public by construction — the browse list has
      // to draw the thing being sold — and neither can carry a maximum.
      "lotKind", "item",
    ].sort());
  });

  it("PROBING: a losing bid reveals only that the leader is above it", async () => {
    const res = await bid("a1", 600_000);
    expect(res.status).toBe(200);
    expect(res.body.outbidImmediately).toBe(true);
    expect(res.body.yourMax).toBeNull();
    expect(containsSecret(res.body)).toBe(false);
    // The price moved to the prober's OWN number exactly — not to the leader's
    // maximum, and not to "their number plus a step" either. Both of those are
    // functions of the secret; this one is a function only of what the prober
    // already typed, which is what makes a probe worth nothing.
    expect(res.body.currentBid).toBe(600_000);
    expect(res.body.currentBid).toBeLessThan(SECRET);
  });

  it("PROBING is self-punishing: a probe that clears the max WINS the lot", async () => {
    const res = await bid("a1", 95_000_000);
    expect(res.status).toBe(200);
    expect(res.body.youAreHighBidder).toBe(true);
    // Committed at the BEATEN maximum plus one step. The step is a function
    // of the price the auction was at when the bid landed ($500,000 -> a
    // $10,000 tier step), not of the maximum it just cleared.
    expect(db.auctions[0].currentBid).toBe(90_010_000);
    expect(db.auctions[0].currentBidderId).toBe("u1");
    // There is no retraction endpoint: the prober now owns this commitment.
    expect(await bid("a1", 1_000)).toMatchObject({ status: 400 });
  });

  it("the SOCKET payload does not carry it either", async () => {
    await bid("a1", 600_000);
    expect(h.emits.length).toBeGreaterThan(0);
    for (const e of h.emits) expect(containsSecret(e.payload)).toBe(false);
    for (const d of h.direct) expect(containsSecret(d.payload)).toBe(false);
  });

  it("the bid HISTORY never records a standing maximum", async () => {
    await bid("a1", 600_000);
    const res = await call("GET", "/a1");
    for (const b of res.body.bids) expect(b.amount).not.toBe(SECRET);
    // The prober's own row records what THEY committed, which is already
    // at or below the public price.
    const mine = res.body.bids.find((b: any) => b.username === "alice");
    expect(mine.amount).toBeLessThanOrEqual(db.auctions[0].currentBid);
  });

  it("you DO see your own maximum, and only your own", async () => {
    h.setUser("u2", "bob");
    const res = await call("GET", "/");
    expect(res.body.auctions[0].yourMax).toBe(SECRET);
    h.setUser("u3", "carol");
    const other = await call("GET", "/");
    expect(other.body.auctions[0].yourMax).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
describe("proxy resolution", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
  });

  it("an opening max takes the lot at the ASK, not at the max", async () => {
    const res = await bid("a1", 5_000_000);
    expect(res.status).toBe(200);
    expect(res.body.currentBid).toBe(500_000);   // the seller's ask
    expect(res.body.yourMax).toBe(5_000_000);    // held secretly
    expect(db.proxies[0]).toMatchObject({ bidderId: "u1", maxAmount: 5_000_000 });
  });

  it("the lot goes to whoever valued it highest, not whoever clicked last", async () => {
    await bid("a1", 5_000_000);                     // alice
    h.setUser("u2", "bob");
    const b = await bid("a1", 800_000);             // bob, lower max
    expect(b.body.outbidImmediately).toBe(true);
    h.setUser("u3", "carol");
    const c = await bid("a1", 900_000);             // carol, later but lower
    expect(c.body.outbidImmediately).toBe(true);
    expect(db.auctions[0].currentBidderId).toBe("u1"); // alice still holds
  });

  it("TIE: equal maxima — the EARLIER submission wins, deterministically", async () => {
    await bid("a1", 3_000_000);                     // alice first
    h.setUser("u2", "bob");
    const b = await bid("a1", 3_000_000);           // bob, identical max
    expect(b.status).toBe(200);
    expect(b.body.youAreHighBidder).toBe(false);
    expect(db.auctions[0].currentBidderId).toBe("u1");
    expect(db.auctions[0].currentBid).toBe(3_000_000);
    // And it is stable whichever order the two accounts are seeded in.
  });

  it("neither maximum is ever exceeded", async () => {
    await bid("a1", 2_000_000);
    h.setUser("u2", "bob");
    await bid("a1", 1_400_000);
    expect(db.auctions[0].currentBid).toBeLessThanOrEqual(2_000_000);
    expect(db.auctions[0].currentBid).toBeGreaterThanOrEqual(1_400_000);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("self-bidding, shill bidding and retraction", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
  });

  it("a SELLER cannot bid on their own lot", async () => {
    h.setUser("seller", "seller");
    const res = await bid("a1", 5_000_000);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("you can't bid on your own auction");
  });

  it("the HIGH BIDDER cannot bid against themselves — 32% of all real bids", async () => {
    await bid("a1", 1_000_000);
    const res = await bid("a1", 1_100_000);
    expect(res.status).toBe(200);
    expect(res.body.priceMoved).toBe(false);            // raised the max only
    expect(db.auctions[0].currentBid).toBe(500_000);    // price did NOT move
    expect(db.bids).toHaveLength(1);                    // no second Bid row
    expect(db.proxies[0].maxAmount).toBe(1_100_000);
  });

  it("RETRACTION: a maximum cannot be lowered or withdrawn", async () => {
    await bid("a1", 5_000_000);
    const res = await bid("a1", 1_000_000);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("can't be lowered or withdrawn");
    expect(db.proxies[0].maxAmount).toBe(5_000_000);
  });

  it("re-submitting the SAME maximum is refused (no no-op ratchet)", async () => {
    await bid("a1", 5_000_000);
    const res = await bid("a1", 5_000_000);
    expect(res.status).toBe(400);
  });

  it("a seller cannot cancel out from under a bidder", async () => {
    await bid("a1", 1_000_000);
    h.setUser("seller", "seller");
    const res = await call("POST", "/a1/cancel");
    expect(res.status).toBe(409);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("affordability — money is NOT escrowed, and the failure is visible", () => {
  beforeEach(() => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
  });

  it("(c) a maximum above your balance is refused, and the balance is NAMED", async () => {
    db.users.find((u) => u.id === "u1")!.saveData = save(750_000);
    const res = await bid("a1", 5_000_000);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Your maximum can't exceed your balance of $750,000.");
    expect(res.body.yourBalance).toBe(750_000);
  });

  // THE BUG THIS FIXES, in its exact production shape: 10 of the 78
  // contested auctions ended `cancelled` because the winner could not pay.
  // Without the cap, alice's stored $50,000,000 maximum would auto-defend
  // and "win" at a price her $505,000 balance cannot cover — the seller gets
  // nothing and the mon bounces back.
  it("(b) a leader who can no longer afford the DEFENCE is dropped, and told", async () => {
    await bid("a1", 50_000_000);                       // alice leads, max 50M
    db.users.find((u) => u.id === "u1")!.saveData = save(505_000); // she spends it
    h.setUser("u2", "bob");
    // bob's max is far BELOW alice's stored maximum. An uncapped proxy would
    // hand the lot to alice at a price she provably cannot pay.
    const res = await bid("a1", 600_000);
    expect(res.status).toBe(200);
    expect(res.body.youAreHighBidder).toBe(true);      // bob takes it instead
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(db.auctions[0].currentBid).toBe(510_000);
    // The winning price is payable by the winner. That is the invariant.
    expect(db.auctions[0].currentBid).toBeLessThanOrEqual(100_000_000);
    // The drop is LOUD, addressed to the dropped player, with real numbers.
    const drop = h.direct.find((d) => d.event === "auction:proxy_dropped");
    expect(drop).toBeTruthy();
    expect(drop!.userId).toBe("u1");
    expect(drop!.payload).toMatchObject({
      auctionId: "a1", yourMax: 50_000_000, balance: 505_000, priceNow: 510_000,
    });
    // The stored maximum is replaced by the new leader's — not left dangling.
    expect(db.proxies).toHaveLength(1);
    expect(db.proxies[0].bidderId).toBe("u2");
  });

  it("a leader who can still cover the minimum DEFENDS at their capped max", async () => {
    await bid("a1", 50_000_000);
    db.users.find((u) => u.id === "u1")!.saveData = save(2_000_000);
    h.setUser("u2", "bob");
    const res = await bid("a1", 1_000_000);
    expect(res.body.youAreHighBidder).toBe(false);     // alice holds
    expect(db.auctions[0].currentBidderId).toBe("u1");
    // Capped at what she can actually pay, not at her stored $50,000,000.
    expect(db.auctions[0].currentBid).toBeLessThanOrEqual(2_000_000);
    expect(h.direct.find((d) => d.event === "auction:proxy_dropped")).toBeUndefined();
    // Her STORED maximum is untouched — a balance dip is not a retraction.
    expect(db.proxies[0].maxAmount).toBe(50_000_000);
  });

  it("THE INVARIANT: the winning price never exceeds the winner's synced balance", async () => {
    for (const [uid, bal, max] of [["u1", 9_000_000, 9_000_000], ["u2", 4_000_000, 4_000_000],
      ["u3", 7_000_000, 7_000_000]] as const) {
      db.users.find((u) => u.id === uid)!.saveData = save(bal);
      h.setUser(uid, uid);
      await bid("a1", max);
    }
    const winner = db.auctions[0].currentBidderId!;
    const bal = JSON.parse(db.users.find((u) => u.id === winner)!.saveData!).money;
    expect(db.auctions[0].currentBid).toBeLessThanOrEqual(bal);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("anti-snipe — complements the proxy, and cannot be farmed", () => {
  it("a price-moving bid in the final minute EXTENDS endsAt", async () => {
    const endsAt = new Date(Date.now() + 20_000);
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null, endsAt });
    const res = await bid("a1", 5_000_000);
    expect(new Date(res.body.endsAt).getTime()).toBeGreaterThan(endsAt.getTime());
  });

  it("RAISING YOUR OWN MAXIMUM DOES NOT EXTEND — the leader cannot stall forever", async () => {
    const endsAt = new Date(Date.now() + 20_000);
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null, endsAt });
    await bid("a1", 1_000_000);
    const after = db.auctions[0].endsAt;
    for (let i = 2; i <= 6; i++) {
      const res = await bid("a1", 1_000_000 * i);
      expect(res.body.priceMoved).toBe(false);
      expect(new Date(res.body.endsAt).getTime()).toBe(after.getTime());
    }
    expect(db.auctions[0].endsAt.getTime()).toBe(after.getTime());
  });

  it("a last-second max BELOW the hidden leader's still extends, and still loses", async () => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null,
      endsAt: new Date(Date.now() + 20_000) });
    await bid("a1", 50_000_000);
    const before = db.auctions[0].endsAt.getTime();
    h.setUser("u2", "bob");
    const res = await bid("a1", 2_000_000);
    expect(res.body.outbidImmediately).toBe(true);
    expect(new Date(res.body.endsAt).getTime()).toBeGreaterThanOrEqual(before);
  });
});

// ════════════════════════════════════════════════════════════════════
describe("concurrency — the CAS is unchanged and still arbitrates", () => {
  it("two simultaneous bids CANNOT both win", async () => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    // bob's entire request lands between alice's read and alice's CAS.
    db.beforeAuctionUpdateOnce = async () => {
      const prev = { ...h.user };
      h.setUser("u2", "bob");
      await bid("a1", 5_000_000);
      h.setUser(prev.id, prev.username);
    };
    const alice = await bid("a1", 4_000_000);
    expect(alice.status).toBe(409);
    expect(alice.body.error).toBe("someone else just bid — refresh and try again");
    // Exactly one winner, one Bid row, one stored maximum.
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(db.bids).toHaveLength(1);
    expect(db.proxies).toHaveLength(1);
  });

  it("the losing writer commits NOTHING — no bid row, no stray maximum", async () => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u2" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
    db.proxies.push({ auctionId: "a1", bidderId: "u2", maxAmount: 500_000, createdAt: new Date(), updatedAt: new Date() });
    db.beforeAuctionUpdateOnce = async () => {
      h.setUser("u3", "carol");
      await bid("a1", 600_000);
      h.setUser("u1", "alice");
    };
    const alice = await bid("a1", 510_000);
    expect(alice.status).toBe(409);
    expect(db.bids.filter((b) => b.bidderId === "u1")).toHaveLength(0);
    expect(db.proxies.filter((p) => p.bidderId === "u1")).toHaveLength(0);
  });

  it("two proxies racing never exceed either maximum and always terminate", async () => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 0, currentBidderId: null });
    const maxes = [3_000_000, 7_000_000, 5_500_000, 9_000_000, 6_250_000];
    const users = ["u1", "u2", "u3", "u1", "u2"];
    for (let i = 0; i < maxes.length; i++) {
      h.setUser(users[i], users[i]);
      await bid("a1", maxes[i]);
    }
    expect(db.auctions[0].currentBid).toBeLessThanOrEqual(Math.max(...maxes));
    expect(db.proxies).toHaveLength(1);         // exactly one stored maximum, always
  });
});

// ════════════════════════════════════════════════════════════════════
describe("degraded mode — the migration has not been applied yet", () => {
  it("bidding still works, with the new increment enforced", async () => {
    seedAuction({ id: "a1", startingBid: 500_000, currentBid: 500_000, currentBidderId: "u2" });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: 500_000, createdAt: new Date() });
    db.missingProxyTable = true;

    expect((await bid("a1", 500_001)).status).toBe(400);   // increment enforced
    const ok = await bid("a1", 510_000);
    expect(ok.status).toBe(200);
    expect(db.auctions[0].currentBid).toBe(510_000);
    expect(db.auctions[0].currentBidderId).toBe("u1");
    // And browsing still works with no maximum anywhere.
    const list = await call("GET", "/");
    expect(list.status).toBe(200);
    expect(list.body.auctions[0].yourMax).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// THE MONEY CEILING. `minAcceptableBid` clamps to MAX_BID, so at
// `currentBid === MAX_BID` the required minimum EQUALS the current price
// rather than exceeding it — the one place the "the minimum always rises"
// invariant cannot hold, because there is no larger integer the schema can
// store. Left unguarded that turns the ceiling into a free transfer: a
// later bidder matches the standing price and takes the lot without paying
// a cent more, which contradicts both the documented behaviour ("at
// MAX_BID the lot accepts no further raises") and the tie rule (an exact
// match LOSES to the incumbent).
//
// Unreachable against today's data — the largest balance in production is
// ~$110M and the largest live ask is $20M — but it is a tie case, and the
// tie rule has to hold at every price or it is not a rule.
describe("the money ceiling — a lot at MAX_BID cannot change hands for free", () => {
  it("refuses a matching bid at MAX_BID and leaves the incumbent holding the lot", async () => {
    seedAuction({
      id: "a1", startingBid: 500_000, currentBid: MAX_BID, currentBidderId: "u2",
    });
    db.bids.push({ id: "b0", auctionId: "a1", bidderId: "u2", amount: MAX_BID, createdAt: new Date() });
    // The challenger must be able to AFFORD the ceiling, or the affordability
    // check refuses first and this test passes without ever reaching the
    // branch it exists to cover. (It did, on the first run.)
    db.users.find((u) => u.id === "u1")!.saveData = JSON.stringify({
      money: MAX_BID, party: [{ id: "p1", name: "pika" }], box: [],
    });

    // MAX_BID is the largest amount zod will accept, so this is the only
    // bid a challenger can even submit against a lot at the ceiling.
    const res = await bid("a1", MAX_BID);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("$999,999,999");

    // The incumbent still holds it, at the same price, and no Bid row was
    // written for the challenger.
    expect(db.auctions[0].currentBidderId).toBe("u2");
    expect(db.auctions[0].currentBid).toBe(MAX_BID);
    expect(db.bids.filter((b) => b.bidderId === "u1")).toHaveLength(0);
  });

  it("still accepts a genuine raise one dollar below the ceiling", async () => {
    // The guard must key on the PRICE being at the ceiling, not on the
    // amount, or it would refuse every large legitimate bid.
    seedAuction({ id: "a2", startingBid: 500_000, currentBid: 100_000_000, currentBidderId: "u2" });
    db.bids.push({ id: "b1", auctionId: "a2", bidderId: "u2", amount: 100_000_000, createdAt: new Date() });
    db.users.find((u) => u.id === "u1")!.saveData = JSON.stringify({
      money: MAX_BID, party: [{ id: "p1", name: "pika" }], box: [],
    });

    const res = await bid("a2", MAX_BID);
    expect(res.status).toBe(200);
    expect(db.auctions[0].currentBidderId).toBe("u1");
  });
});

// ════════════════════════════════════════════════════════════════════
describe("item lots — selling a machine", () => {
  // TMs are reusable and capped at one per player, which is what makes a
  // market for them exist at all: the second TM26 you turn up is worth
  // nothing to you and everything to somebody who has none. Every rule below
  // follows from that cap.
  beforeEach(() => {
    db.users.length = 0;
    seedUser("seller", "seller", 1_000, { tm26: 1 });
    seedUser("u1", "alice", 100_000_000, {});
    seedUser("u2", "bob", 100_000_000, { tm26: 1 });
    h.setUser("seller", "seller");
  });

  const listMachine = (itemId = "tm26", startingBid = 500_000) =>
    call("POST", "/", { itemId, startingBid, durationMinutes: 60 });

  it("lists a machine the seller owns, and ESCROWS it out of the bag", async () => {
    const res = await listMachine();
    expect(res.status).toBe(201);
    expect(res.body.auction.lotKind).toBe("item");
    expect(res.body.auction.item).toEqual({ itemId: "tm26", quantity: 1 });
    expect(res.body.auction.pokemon).toBeNull();
    // Gone from the seller's save the moment it is listed — it cannot be
    // taught from, sold to a shop, or listed twice while it is up.
    expect(invOf("seller").tm26).toBeUndefined();
  });

  it("refuses a machine the seller does not have", async () => {
    const res = await listMachine("tm24");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/don't have/);
  });

  it("refuses anything that is not a machine", async () => {
    const res = await call("POST", "/", { itemId: "masterball", startingBid: 500_000, durationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/TMs and HMs/);
  });

  it("refuses a quantity above one", async () => {
    const res = await call("POST", "/", { itemId: "tm26", itemQuantity: 2, startingBid: 500_000, durationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/one at a time/);
  });

  it("refuses a body that names both a Pokemon and an item", async () => {
    const res = await call("POST", "/", { pokemonId: "p1", itemId: "tm26", startingBid: 500_000, durationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not both/);
  });

  it("refuses a body that names neither", async () => {
    const res = await call("POST", "/", { startingBid: 500_000, durationMinutes: 60 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Pokemon or an item/);
  });

  it("refuses a second listing of the same machine", async () => {
    await listMachine();
    // The escrow already took it, so this is the belt to that braces — but
    // the message has to name the real reason, not "you don't have it".
    db.users.find((u) => u.id === "seller")!.saveData = save(1_000, { tm26: 1 });
    const again = await listMachine();
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already have that machine listed/);
  });

  it("gives the machine back when the seller cancels", async () => {
    const listed = await listMachine();
    expect(invOf("seller").tm26).toBeUndefined();
    const cancelled = await call("POST", `/${listed.body.auction.id}/cancel`);
    expect(cancelled.status).toBe(200);
    // Back as a GRANT, not a save rewrite. Cancelling used to rebuild the
    // seller's save from their last-uploaded bytes and bump saveAdoptSeq,
    // which makes the client adopt server bytes wholesale — so pulling a
    // listing cost you everything you had played since your last sync.
    expect(db.grants.flatMap((g) => JSON.parse(g.prizes)))
      .toContainEqual({ kind: "item", itemId: "tm26", quantity: 1 });
    expect(db.grants[0].source).toBe("auction-return");
    // And the save itself is untouched, which is the whole point.
    expect(invOf("seller").tm26).toBeUndefined();
  });

  it("refuses a bid from someone who already owns that machine", async () => {
    const listed = await listMachine();
    h.setUser("u2", "bob"); // bob already has tm26
    const res = await bid(listed.body.auction.id, 500_000);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already have that machine/);
  });

  it("accepts a bid from someone who does not", async () => {
    const listed = await listMachine();
    h.setUser("u1", "alice"); // alice has none
    const res = await bid(listed.body.auction.id, 500_000);
    expect(res.status).toBe(200);
  });

  it("browses alongside Pokemon lots, each labelled", async () => {
    await listMachine();
    seedAuction({ id: "mon-lot" });
    h.setUser("u1", "alice");
    const res = await call("GET", "/");
    const kinds = res.body.auctions.map((a: any) => a.lotKind).sort();
    expect(kinds).toEqual(["item", "pokemon"]);
    const item = res.body.auctions.find((a: any) => a.lotKind === "item");
    expect(item.item.itemId).toBe("tm26");
    expect(item.pokemon).toBeNull();
    const mon = res.body.auctions.find((a: any) => a.lotKind === "pokemon");
    expect(mon.item).toBeNull();
    expect(mon.pokemon).not.toBeNull();
  });
});
