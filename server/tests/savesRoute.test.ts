// POST /api/saves — executed against the REAL route handler with an
// in-memory fake Prisma. This is the execution-level test the session's
// bugs demanded: the exactly-once grant delivery under the two-tab
// interleaving (the P2025-style CAS double), the versionless-write
// regression guard, and the GrantRace rollback.
//
// Stubbing: ../src/db.js is replaced by a swappable in-memory fake (below);
// ../src/socket.js by a spy; ../src/lib/middleware.js by a pass-through
// that injects a fixed user. Nothing here can open a DB connection or a
// socket. Tests pass fully offline.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop],
    }),
    sendToUserGlobal: undefined as unknown as ReturnType<typeof import("vitest")["vi"]["fn"]>,
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => {
  const fn = vi.fn();
  h.sendToUserGlobal = fn as never;
  return { sendToUserGlobal: fn };
});
vi.mock("../src/lib/middleware.js", () => ({
  requireUser: async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: "u1", username: "tester", email: "", name: null, isAdmin: false });
    await next();
  },
}));

import app from "../src/routes/saves.js";

// ── In-memory Prisma fake ───────────────────────────────────────────────
// Implements exactly the surface routes/saves.ts (and the libs it calls)
// touches. $transaction snapshots state and restores it on throw, so the
// GrantRace rollback is real.

interface GrantRow {
  id: string; userId: string; prizes: string; summary: string;
  attempts: number; deliveredAt: Date | null; deliveredSaveVersion?: number;
  lastError?: string; createdAt: Date;
}

class FakeDb {
  user: {
    id: string; saveVersion: number; saveAdoptSeq: number; saveData: string | null;
    saveUpdatedAt: Date; accountLevel: number; totalCaughtLevels: number; pokedexCaughtCount: number;
  };
  grants: GrantRow[] = [];
  /** Next user.findUnique reports this saveVersion (consumed once) —
   *  simulates a read that raced a concurrent commit. */
  readVersionOverrideOnce: number | null = null;
  /** Fired once after a user.update applies — lets a test interleave a
   *  "concurrent uploader delivered the grants" between the save write and
   *  the grant CAS. */
  onUserUpdateOnce: (() => void) | null = null;
  /** Grant ids delivered by a CONCURRENT (already-committed) transaction —
   *  rolling back THIS request's transaction must not undo those. */
  externallyDelivered = new Set<string>();
  client: any;

  constructor(saveData: Record<string, unknown>, saveVersion = 5, saveAdoptSeq = 1) {
    this.user = {
      id: "u1", saveVersion, saveAdoptSeq, saveData: JSON.stringify(saveData),
      saveUpdatedAt: new Date(), accountLevel: 0, totalCaughtLevels: 0, pokedexCaughtCount: 0,
    };
    this.client = this.makeClient();
  }

  save(): Record<string, unknown> {
    return JSON.parse(this.user.saveData ?? "{}");
  }

  addGrant(id: string, prizes: unknown[], attempts = 0): void {
    this.grants.push({
      id, userId: "u1", prizes: JSON.stringify(prizes), summary: "prize",
      attempts, deliveredAt: null, createdAt: new Date(this.grants.length),
    });
  }

  private pick(row: Record<string, unknown>, select?: Record<string, boolean>) {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
    return out;
  }

  private makeClient(): any {
    const db = this;
    return {
      user: {
        findUnique: async ({ where, select }: any) => {
          if (where.id !== db.user.id) return null;
          const row: Record<string, unknown> = { ...db.user };
          if (db.readVersionOverrideOnce !== null) {
            row.saveVersion = db.readVersionOverrideOnce;
            db.readVersionOverrideOnce = null;
          }
          return db.pick(row, select);
        },
        update: async ({ where, data, select }: any) => {
          const miss =
            where.id !== db.user.id ||
            (where.saveVersion !== undefined && where.saveVersion !== db.user.saveVersion);
          if (miss) {
            const e: any = new Error("Record to update not found.");
            e.code = "P2025";
            throw e;
          }
          if (data.saveData !== undefined) db.user.saveData = data.saveData;
          if (data.saveVersion?.increment) db.user.saveVersion += data.saveVersion.increment;
          if (data.saveAdoptSeq?.increment) db.user.saveAdoptSeq += data.saveAdoptSeq.increment;
          if (data.saveUpdatedAt) db.user.saveUpdatedAt = data.saveUpdatedAt;
          for (const k of ["accountLevel", "totalCaughtLevels", "pokedexCaughtCount"] as const) {
            if (data[k] !== undefined) db.user[k] = data[k];
          }
          const hook = db.onUserUpdateOnce;
          db.onUserUpdateOnce = null;
          hook?.();
          return db.pick({ ...db.user }, select);
        },
      },
      pendingGrant: {
        findMany: async ({ where, take, select }: any) => {
          let rows = db.grants.filter(
            (g) => g.userId === where.userId && (where.deliveredAt === null ? g.deliveredAt === null : true),
          );
          rows = [...rows].sort((a, b) =>
            a.attempts - b.attempts || a.createdAt.getTime() - b.createdAt.getTime());
          if (take) rows = rows.slice(0, take);
          return rows.map((r) => db.pick(r as never, select));
        },
        updateMany: async ({ where, data }: any) => {
          const ids: string[] | null = where.id?.in ?? (typeof where.id === "string" ? [where.id] : null);
          let count = 0;
          for (const g of db.grants) {
            if (ids && !ids.includes(g.id)) continue;
            if (where.deliveredAt === null && g.deliveredAt !== null) continue;
            if (where.attempts?.lt !== undefined && !(g.attempts < where.attempts.lt)) continue;
            count += 1;
            if (data.deliveredAt) g.deliveredAt = data.deliveredAt;
            if (data.deliveredSaveVersion !== undefined) g.deliveredSaveVersion = data.deliveredSaveVersion;
            if (data.attempts?.increment) g.attempts += data.attempts.increment;
            if (data.lastError !== undefined) g.lastError = data.lastError;
          }
          return { count };
        },
        count: async ({ where }: any) =>
          db.grants.filter((g) => g.userId === where.userId && g.deliveredAt === null).length,
      },
      // maybeSnapshot: report a fresh snapshot so the interval gate skips.
      saveSnapshot: {
        findFirst: async () => ({ createdAt: new Date() }),
        create: async () => ({}),
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
      },
      $executeRaw: async () => 1,
      $transaction: async (fn: (tx: any) => Promise<unknown>) => {
        const userSnap = { ...db.user };
        const grantsSnap = db.grants.map((g) => ({ ...g }));
        try {
          return await fn(db.client);
        } catch (e) {
          db.user = userSnap;
          db.grants = grantsSnap;
          // A concurrent transaction's committed writes survive our rollback.
          for (const g of db.grants) {
            if (db.externallyDelivered.has(g.id) && g.deliveredAt === null) {
              g.deliveredAt = new Date();
            }
          }
          throw e;
        }
      },
    };
  }
}

let db: FakeDb;

const baseSave = () => ({
  money: 100,
  inventory: { pokeball: 3 },
  party: [],
  box: [],
  defeatedGyms: ["g1", "g2"],
  pokedexCaught: ["pikachu"],
});

beforeEach(() => {
  db = new FakeDb(baseSave());
  h.setDb(db);
  (h.sendToUserGlobal as any).mockClear?.();
});

async function post(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("versioned uploads", () => {
  it("accepts an ordinary versioned write and bumps only saveVersion", async () => {
    const { status, json } = await post({
      saveData: { ...baseSave(), money: 120 },
      expectedSaveVersion: 5,
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.saveVersion).toBe(6);
    expect(db.save().money).toBe(120);
    expect(db.user.saveAdoptSeq).toBe(1); // no server-added bytes → no adopt
  });

  it("rejects a milestone regression on ANY write, versioned included", async () => {
    const { status, json } = await post({
      saveData: { ...baseSave(), defeatedGyms: ["g1"] },
      expectedSaveVersion: 5,
    });
    expect(status).toBe(409);
    expect(json.error).toBe("regression_blocked");
    expect(db.user.saveVersion).toBe(5);
  });

  it("409s a stale version, and the 409 carries the adopt seq (the invariant)", async () => {
    const { status, json } = await post({
      saveData: baseSave(),
      expectedSaveVersion: 3,
    });
    expect(status).toBe(409);
    expect(json.serverSaveVersion).toBe(5);
    expect(json.serverSaveAdoptSeq).toBe(1);
  });
});

describe("blind writes (no expectedSaveVersion) — may add, never subtract", () => {
  it("accepts a blind write that only adds", async () => {
    const { status } = await post({ saveData: { ...baseSave(), money: 150 } });
    expect(status).toBe(200);
    expect(db.save().money).toBe(150);
  });

  it("refuses (400, not 409) a blind write that would destroy value, and stores nothing", async () => {
    db.user.saveData = JSON.stringify({ ...baseSave(), money: 900_000, inventory: { masterball: 5 } });
    const { status, json } = await post({
      saveData: { ...baseSave(), money: 1, inventory: {} },
    });
    expect(status).toBe(400);
    expect(json.error).toBe("versionless_regression");
    expect(json.losses.map((l: any) => l.field)).toEqual(
      expect.arrayContaining(["money", "inventory.masterball"]),
    );
    expect(json.serverSaveAdoptSeq).toBe(1);
    expect(JSON.parse(db.user.saveData!).money).toBe(900_000); // untouched
    expect(db.user.saveVersion).toBe(5);
  });
});

describe("exactly-once grant delivery — the two-tab interleaving", () => {
  it("tab A collects the grant; tab B (stale read fast-path) 409s and cannot re-collect", async () => {
    db.addGrant("g1", [{ kind: "money", amount: 500 }]);

    // Tab A: knows version 5, promises grant handling.
    const a = await post({ saveData: baseSave(), expectedSaveVersion: 5, grantAck: 1 });
    expect(a.status).toBe(200);
    expect(a.json.grantsApplied).toEqual([{ kind: "money", amount: 500 }]);
    expect(db.save().money).toBe(600);
    expect(db.user.saveVersion).toBe(6);
    expect(db.user.saveAdoptSeq).toBe(2); // server added bytes → adopt bump
    expect(db.grants[0].deliveredAt).not.toBeNull();
    expect(db.grants[0].deliveredSaveVersion).toBe(6);
    // Every session gets told to adopt the copy that holds the prize.
    expect(h.sendToUserGlobal).toHaveBeenCalledWith("u1", "save:adopt", {});

    // Tab B: still on version 5 with its stale pre-prize blob.
    const b = await post({ saveData: baseSave(), expectedSaveVersion: 5, grantAck: 1 });
    expect(b.status).toBe(409);
    // The response that teaches B the new version ALSO carries the adopt seq.
    expect(b.json.serverSaveVersion).toBe(6);
    expect(b.json.serverSaveAdoptSeq).toBe(2);
    // The prize survived: exactly one delivery, bytes intact.
    expect(db.save().money).toBe(600);
    expect(db.grants.filter((g) => g.deliveredAt !== null)).toHaveLength(1);
  });

  it("P2025 CAS double: a tab that passed the fast-path read still loses the write CAS", async () => {
    db.addGrant("g1", [{ kind: "money", amount: 500 }]);
    const a = await post({ saveData: baseSave(), expectedSaveVersion: 5, grantAck: 1 });
    expect(a.status).toBe(200); // server is now at version 6, money 600

    // Tab B's step-2 read raced A's commit and still saw version 5, so the
    // friendly fast-path 409 does NOT fire. The database must arbitrate.
    db.readVersionOverrideOnce = 5;
    const b = await post({ saveData: baseSave(), expectedSaveVersion: 5, grantAck: 1 });
    expect(b.status).toBe(409);
    expect(b.json.reason).toContain("another device wrote");
    expect(b.json.serverSaveVersion).toBe(6);
    expect(b.json.serverSaveAdoptSeq).toBe(2);
    // Nothing about B's attempt reached the row.
    expect(db.save().money).toBe(600);
    expect(db.user.saveVersion).toBe(6);
    expect(db.grants.filter((g) => g.deliveredAt !== null)).toHaveLength(1);
  });

  it("GrantRace: losing the deliveredAt CAS rolls the save write back whole", async () => {
    db.addGrant("g1", [{ kind: "money", amount: 500 }]);
    // Between this request's save write and its grant CAS, a concurrent
    // upload delivers the grant (its own transaction committed first).
    db.onUserUpdateOnce = () => {
      db.grants[0].deliveredAt = new Date();
      db.externallyDelivered.add("g1");
    };
    const r = await post({ saveData: baseSave(), expectedSaveVersion: 5, grantAck: 1 });
    expect(r.status).toBe(409);
    expect(r.json.reason).toContain("concurrent upload delivered pending grants");
    // THE property: the losing request wrote NOTHING — its user.update
    // (money 600, version 6) rolled back with the transaction. A commit here
    // would have been a paid prize erased by a plain save.
    expect(db.user.saveVersion).toBe(5);
    expect(db.save().money).toBe(100);
  });

  it("grantAck without a version collects nothing — grants stay owed", async () => {
    db.addGrant("g1", [{ kind: "money", amount: 500 }]);
    const r = await post({ saveData: { ...baseSave(), money: 150 }, grantAck: 1 }); // blind
    expect(r.status).toBe(200);
    expect(r.json.grantsApplied).toBeUndefined();
    expect(db.grants[0].deliveredAt).toBeNull();
    expect(db.save().money).toBe(150);
  });

  it("an unfoldable grant defers (attempts++) without blocking the player's own save", async () => {
    // A level-200 mon can never pass validateSave — permanently unfoldable.
    db.addGrant("gBad", [{
      kind: "pokemon", label: "Broken",
      mon: { speciesKey: "missingno", level: 200, totalExp: 0, maxHp: 10, currentHp: 10,
             attack: 1, defense: 1, spAttack: 1, spDefense: 1, speed: 1 },
    }]);
    const r = await post({ saveData: baseSave(), expectedSaveVersion: 5, grantAck: 1 });
    expect(r.status).toBe(200);
    expect(r.json.grantsApplied).toBeUndefined();
    // Fire-and-forget bookkeeping lands on the microtask queue.
    await new Promise((res) => setTimeout(res, 10));
    expect(db.grants[0].deliveredAt).toBeNull(); // still owed, will retry
    expect(db.grants[0].attempts).toBe(1);
    expect(db.grants[0].lastError).toContain("level must be");
  });
});

describe("GET /api/saves", () => {
  it("reports the save, version, adopt seq and owed-grant count without delivering", async () => {
    db.addGrant("g1", [{ kind: "money", amount: 500 }]);
    const res = await app.request("/", { method: "GET" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.saveVersion).toBe(5);
    expect(json.saveAdoptSeq).toBe(1);
    expect(json.pendingGrants).toBe(1);
    expect(db.grants[0].deliveredAt).toBeNull(); // read never delivers
  });
});
