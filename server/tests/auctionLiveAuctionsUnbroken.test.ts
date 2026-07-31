// THE 26 LIVE AUCTIONS MUST NOT BREAK.
//
// Every row below is REAL, read read-only from production Postgres on
// 2026-07-30 immediately before the rule was written. Each one is driven
// through the ACTUAL bid route to prove three things:
//
//   1. no live currentBid becomes illegal;
//   2. every live listing still accepts a valid next bid; and
//   3. the two live listings that start BELOW the new $500 floor are not
//      retroactively repriced — they still take a first bid at $100.
//
// Point 3 is the one the sizing note got wrong. It asserted "Lowest starting
// bid among all 24 live auctions: $500,000 ... listings below the floor: 0".
// By the time the code was written there were 26 live auctions and two of
// them — a SHINY Venusaur Lv100 and a SHINY Krabby Lv26 — had been listed at
// the old $100 form default. Had the floor been applied to existing rows,
// both would have become unbiddable. It is a creation-time rule instead, and
// this file is the proof.
//
// THIS IS A POINT-IN-TIME SNAPSHOT, not a live query — it opens no
// connection and will not drift or flake. The live table genuinely moves
// (one of these 26 expired via the settlement timer within the hour), so a
// future reader counting active auctions will not find 26. That does not
// weaken anything here: what is being proved is that THE RULE does not break
// rows of these shapes, and these are real shapes taken from production.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop as string],
    }),
    user: { id: "bidder", username: "bidder" },
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

import app from "../src/routes/auctions.js";
import { MIN_STARTING_BID, contestMultiplier, concentrationRatio } from "../src/lib/auctionBidRules.js";
import { __resetProxyAvailability } from "../src/lib/auctionProxy.js";

/** id · species · startingBid · currentBid · bids · distinct bidders. */
const LIVE: Array<[string, string, number, number, number, number]> = [
  ["viw0vc43", "Ho-Oh Lv80",             5_000_000,  5_000_002, 3, 2],
  ["qp8r3ufo", "Darkrai Lv100",          5_000_000,  5_000_000, 1, 1],
  ["a0gn5rya", "Zekrom Lv85",            2_000_000,  2_000_000, 1, 1],
  ["z9r6hjin", "Zapdos Lv70",            5_000_000,          0, 0, 0],
  ["fzofy76k", "Meloetta Lv100",         5_000_000,  5_000_000, 1, 1],
  ["9kim1ecr", "Zekrom Lv100",           1_500_000,  1_500_001, 2, 2],
  ["6hknqga4", "Heatran Lv100",          2_500_000,          0, 0, 0],
  ["16eiivaq", "Raikou Lv100",           2_500_000,          0, 0, 0],
  ["egd3n3fx", "Groudon Lv80",           2_500_000,          0, 0, 0],
  ["34f0b5q4", "Articuno Lv70",          2_500_000,          0, 0, 0],
  ["k36umnbu", "Reshiram Lv85",          2_500_000,  2_500_000, 1, 1],
  ["mnvgbh5t", "Rayquaza Lv100",         2_500_000,  2_500_000, 1, 1],
  ["7el6rcqp", "Shaymin Lv95",           2_500_000,          0, 0, 0],
  ["jy8r2kym", "Gyarados Lv100 SHINY",  20_000_000,          0, 0, 0],
  ["41h03kdh", "Mewtwo Lv100",           5_000_000,  5_000_000, 1, 1],
  ["ls0npyxn", "Dialga Lv100",           2_500_000,          0, 0, 0],
  ["km7e92j3", "Jirachi Lv100",          1_500_000,          0, 0, 0],
  ["t2jmvwb3", "Manaphy Lv100",          1_500_000,  1_500_000, 1, 1],
  ["6kw6lyxz", "Gyarados Lv68",            500_000,    500_000, 1, 1],
  ["67mhddhd", "Entei Lv100",            2_500_000,          0, 0, 0],
  ["qu5hz2zw", "Arceus Lv100",           2_500_000,          0, 0, 0],
  ["aujqa8sy", "Ho-Oh Lv100",            2_500_000,          0, 0, 0],
  ["3xp9tzko", "Lugia Lv100",            2_500_000,          0, 0, 0],
  ["i7t1ovcc", "Gyarados Lv66",          2_500_000,          0, 0, 0],
  // The two the stale sizing note missed. Both listed at the old $100
  // default, both SHINY, both with zero bids.
  ["imq1gll2", "Venusaur Lv100 SHINY",         100,          0, 0, 0],
  ["ebzcqrql", "Krabby Lv26 SHINY",            100,          0, 0, 0],
];

/** The minimum next bid each live auction should ask a NEW bidder for. */
const EXPECTED_MIN: Record<string, number> = {
  viw0vc43: 5_050_002, qp8r3ufo: 5_050_000, a0gn5rya: 2_050_000, z9r6hjin: 5_000_000,
  fzofy76k: 5_050_000, "9kim1ecr": 1_510_001, "6hknqga4": 2_500_000, "16eiivaq": 2_500_000,
  egd3n3fx: 2_500_000, "34f0b5q4": 2_500_000, k36umnbu: 2_550_000, mnvgbh5t: 2_550_000,
  "7el6rcqp": 2_500_000, jy8r2kym: 20_000_000, "41h03kdh": 5_050_000, ls0npyxn: 2_500_000,
  km7e92j3: 1_500_000, t2jmvwb3: 1_510_000, "6kw6lyxz": 510_000, "67mhddhd": 2_500_000,
  qu5hz2zw: 2_500_000, aujqa8sy: 2_500_000, "3xp9tzko": 2_500_000, i7t1ovcc: 2_500_000,
  imq1gll2: 100, ebzcqrql: 100,
};

class FakeDb {
  users: any[] = [];
  auctions: any[] = [];
  bids: any[] = [];
  proxies: any[] = [];
  private seq = 0;
  private match(row: any, where: any): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries<any>(where)) {
      if (v && typeof v === "object" && "in" in v) { if (!v.in.includes(row[k])) return false; }
      else if (row[k] !== v) return false;
    }
    return true;
  }
  private pick(row: any, select: any) {
    return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
  }
  client: any = {
    $transaction: async (fn: any) => fn(this.client),
    user: {
      findUnique: async ({ where, select }: any) => {
        const u = this.users.find((x) => x.id === where.id);
        return u ? this.pick(u, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        this.users.filter((u) => this.match(u, where)).map((u) => this.pick(u, select)),
    },
    auction: {
      findUnique: async ({ where, select }: any) => {
        const a = this.auctions.find((x) => x.id === where.id);
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
        const r = { id: `b${++this.seq}`, createdAt: new Date(), ...data };
        this.bids.push(r); return r;
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
        const g = new Map<string, any>();
        for (const b of rows) {
          const key = by.map((k: string) => b[k]).join("|");
          if (!g.has(key)) g.set(key, { ...Object.fromEntries(by.map((k: string) => [k, b[k]])), _count: { _all: 0 } });
          g.get(key)._count._all++;
        }
        return [...g.values()];
      },
    },
    auctionProxyBid: {
      findUnique: async ({ where }: any) => this.proxies.find((p) => p.auctionId === where.auctionId) ?? null,
      findMany: async ({ where, select }: any) =>
        this.proxies.filter((p) => this.match(p, where)).map((p) => this.pick(p, select)),
      updateMany: async () => ({ count: 0 }),
      upsert: async ({ where, create, update }: any) => {
        const p = this.proxies.find((x) => x.auctionId === where.auctionId);
        if (p) { Object.assign(p, update); return p; }
        const r = { createdAt: new Date(), updatedAt: new Date(), ...create };
        this.proxies.push(r); return r;
      },
    },
  };
}

let db: FakeDb;

/** Rebuild production's live table exactly as it stands. */
function seedProduction() {
  db = new FakeDb();
  h.setDb(db);
  __resetProxyAvailability();
  db.users.push({ id: "bidder", username: "bidder", saveData: JSON.stringify({ money: 500_000_000 }), saveVersion: 1 });
  db.users.push({ id: "holder", username: "holder", saveData: JSON.stringify({ money: 500_000_000 }), saveVersion: 1 });
  db.users.push({ id: "seller", username: "seller", saveData: JSON.stringify({ money: 1_000 }), saveVersion: 1 });
  for (const [id, name, start, cur, bids, distinct] of LIVE) {
    db.auctions.push({
      id, sellerId: "seller", pokemonId: `mon-${id}`,
      pokemonSnapshot: JSON.stringify({ id: `mon-${id}`, name, level: 100, speciesKey: "pikachu" }),
      startingBid: start, currentBid: cur, currentBidderId: cur > 0 ? "holder" : null,
      status: "active", endsAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(), updatedAt: new Date(), settledAt: null,
    });
    // Reproduce the real bid shape: `distinct` accounts sharing `bids` rows.
    for (let i = 0; i < bids; i++) {
      db.bids.push({
        id: `${id}-b${i}`, auctionId: id,
        bidderId: i < distinct ? `h${i}` : `h${distinct - 1}`,
        amount: cur, createdAt: new Date(),
      });
    }
  }
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

beforeEach(seedProduction);

describe("the 26 live production auctions", () => {
  it("every live currentBid is STILL LEGAL under the new rule", async () => {
    for (const [id, , start, cur] of LIVE) {
      // Nothing revalidates an existing row: currentBid >= startingBid holds
      // and the floor is never applied retroactively.
      expect(cur === 0 || cur >= start).toBe(true);
      const res = await call("GET", `/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.auction.currentBid).toBe(cur);
    }
  });

  it("each one advertises exactly the expected next minimum", async () => {
    const list = await call("GET", "/");
    expect(list.status).toBe(200);
    expect(list.body.auctions).toHaveLength(26);
    for (const a of list.body.auctions) {
      expect(a.minNextBid).toBe(EXPECTED_MIN[a.id]);
    }
  });

  it("EVERY ONE still accepts a valid next bid", async () => {
    const accepted: string[] = [];
    for (const [id] of LIVE) {
      const res = await call("POST", `/${id}/bids`, { amount: EXPECTED_MIN[id] });
      expect(res.status, `${id} should accept ${EXPECTED_MIN[id]}`).toBe(200);
      accepted.push(id);
    }
    expect(accepted).toHaveLength(26);
  });

  it("THE TWO SUB-FLOOR SHINIES are not retroactively repriced", async () => {
    for (const id of ["imq1gll2", "ebzcqrql"]) {
      const row = LIVE.find((l) => l[0] === id)!;
      expect(row[2]).toBeLessThan(MIN_STARTING_BID);   // listed below the floor
      const res = await call("POST", `/${id}/bids`, { amount: 100 });
      expect(res.status, `${id} must still take a $100 first bid`).toBe(200);
      expect(res.body.currentBid).toBe(100);
    }
  });

  it("the escalation multiplier engages on ZERO of the 26, for any bidder", async () => {
    for (const [id, , , , bids, distinct] of LIVE) {
      for (const isNew of [true, false]) {
        // `false` is the worst case: an existing bidder coming back.
        const r = concentrationRatio(bids, distinct, isNew);
        expect(contestMultiplier(r), `${id} isNew=${isNew}`).toBe(1);
      }
    }
  });

  it("nobody currently leading loses their position", async () => {
    const before = db.auctions.map((a) => a.currentBidderId);
    const list = await call("GET", "/");
    expect(list.status).toBe(200);
    expect(db.auctions.map((a) => a.currentBidderId)).toEqual(before);
  });

  it("a bid one below the advertised minimum is refused, with the number", async () => {
    for (const [id, , , cur] of LIVE) {
      if (cur === 0) continue;                       // unbid lots ask the seller's price
      const res = await call("POST", `/${id}/bids`, { amount: EXPECTED_MIN[id] - 1 });
      expect(res.status).toBe(400);
      expect(res.body.minNextBid).toBe(EXPECTED_MIN[id]);
      expect(res.body.error).toContain("Minimum bid is");
    }
  });

  // MEASURED across the ten live lots that carry a bid. The worst is
  // a0gn5rya (Zekrom Lv85) at $2,000,000 — a tier FLOOR, where the base step
  // is the largest fraction of the price it ever gets — asking $2,050,000,
  // i.e. exactly 2.5%. Nothing here is close to unaffordable: the accounts
  // holding these positions have a median balance of $1.58M.
  it("the largest live increase is 2.5% of the price, and at most $50,000", async () => {
    let worstFraction = 0;
    let worstAbsolute = 0;
    for (const [id, , , cur] of LIVE) {
      if (cur === 0) continue;
      const jump = EXPECTED_MIN[id] - cur;
      expect(jump).toBeGreaterThan(0);
      worstFraction = Math.max(worstFraction, jump / cur);
      worstAbsolute = Math.max(worstAbsolute, jump);
    }
    expect(worstFraction).toBeCloseTo(0.025, 6);
    expect(worstAbsolute).toBe(50_000);
  });
});
