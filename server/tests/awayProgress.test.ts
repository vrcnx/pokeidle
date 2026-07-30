// Away-time catch-up progress — br_876bae56ef21c9021c, and the loudest
// sentiment in chat: "its annoying to always have to keep the game open… if the
// PC shuts down nothing is counted in the background, same when the tab is
// minimized, by the browser itself, switching tabs, or opening a fullscreen
// game."
//
// The simulation is a setTimeout chain; browsers clamp background-tab timers to
// ~1/second and freeze them once a tab is discarded, so progress cannot be
// simulated while away — it has to be computed ON RETURN from elapsed time.
//
// WHAT THESE TESTS EXIST TO PROTECT, in priority order:
//
//   1. The save-version / CAS discipline is NOT involved. This route must never
//      read or write saveData, and must never bump saveVersion. Payment goes
//      through the PendingGrant inbox, which already owns exactly-once delivery
//      and the saveAdoptSeq rules. That path has produced a currency-printing
//      bug and a prize-destroying bug; this feature reuses it rather than
//      extending it, and the "never writes the save" test is the assertion.
//   2. The same away period can never be paid twice. The gate is a conditional
//      UPDATE on `awayClaimedAt`; a lost gate must roll the grant back with it.
//   3. The clock is entirely server-side, so a tampered client clock is worth
//      nothing, and a backwards clock can never mint a negative prize.
//   4. Idling is never optimal — the rate stays an order of magnitude under a
//      deliberately PESSIMISTIC estimate of active income.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let current: any = null;
  return {
    setDb: (db: any) => { current = db; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => current.client[prop],
    }),
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({ sendToUserGlobal: vi.fn(), kickSession: vi.fn() }));
vi.mock("../src/lib/middleware.js", () => ({
  requireUser: async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: c.req.header("x-test-user") ?? "u1", username: "tester", email: "", name: null, isAdmin: false });
    await next();
  },
}));

import app from "../src/routes/away.js";
import {
  AWAY_CAP_MS, AWAY_MIN_MS, AWAY_MONEY_PER_HOUR_BASE,
  awayMoneyPerHour, awayPeriodStart, computeAwayProgress,
} from "../src/lib/awayProgress.js";
import { foldPrizesIntoSave } from "../src/lib/prizeGrant.js";

const H = 3_600_000;

// ── In-memory Prisma fake ───────────────────────────────────────────────
// Models only what the claim touches, plus the two things that make the
// safety argument testable: updateMany's conditional WHERE (the gate) and
// $transaction rollback of THIS transaction's own writes.
interface FakeUser {
  id: string; saveUpdatedAt: Date; awayClaimedAt: Date | null;
  saveData: string | null; saveVersion: number;
}

class FakeDb {
  users = new Map<string, FakeUser>();
  grants: Array<{ id: string; userId: string; prizes: string; source: string; summary: string; deliveredAt: Date | null }> = [];
  nextId = 1;
  /** Fires once immediately before the gate's updateMany, so a test can
   *  interleave a competing claim exactly where the race lives. */
  beforeGateOnce: (() => void) | null = null;
  client: any;

  constructor() {
    const self = this;
    const matches = (u: FakeUser, where: any) => {
      if (where.id !== undefined && u.id !== where.id) return false;
      if ("awayClaimedAt" in where) {
        const w = where.awayClaimedAt;
        if (w === null) return u.awayClaimedAt === null;
        if (w instanceof Date) return u.awayClaimedAt !== null && u.awayClaimedAt.getTime() === w.getTime();
        return false;
      }
      return true;
    };
    const make = (journal?: Map<string, FakeUser>) => ({
      user: {
        findUnique: async ({ where, select }: any) => {
          const u = self.users.get(where.id);
          if (!u) return null;
          if (!select) return { ...u };
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = (u as any)[k];
          return out;
        },
        updateMany: async ({ where, data }: any) => {
          if (self.beforeGateOnce) { const f = self.beforeGateOnce; self.beforeGateOnce = null; f(); }
          let count = 0;
          for (const u of self.users.values()) {
            if (!matches(u, where)) continue;
            if (journal && !journal.has(u.id)) journal.set(u.id, { ...u });
            Object.assign(u, data);
            count++;
          }
          return { count };
        },
      },
      pendingGrant: {
        create: async ({ data, select }: any) => {
          const row = {
            id: "g" + self.nextId++, userId: data.userId, prizes: data.prizes,
            source: data.source, summary: data.summary, deliveredAt: null,
          };
          self.grants.push(row);
          return select ? { id: row.id } : row;
        },
      },
      $transaction: async (fn: any) => {
        // Roll back only THIS transaction's writes. Restoring a whole snapshot
        // would also undo a COMMITTED write from a competing transaction, which
        // no database does.
        const journal = new Map<string, FakeUser>();
        const grantsBefore = self.grants.length;
        const idBefore = self.nextId;
        const rollback = () => {
          for (const [k, pre] of journal) self.users.set(k, pre);
          self.grants.length = grantsBefore;
          self.nextId = idBefore;
        };
        try {
          const res = await fn(make(journal));
          if (res === null) rollback();   // the handler lost the gate
          return res;
        } catch (e) { rollback(); throw e; }
      },
    });
    this.client = make();
  }

  seed(id: string, opts: { awayMs?: number; badges?: number; awayClaimedAt?: Date | null; saveVersion?: number }) {
    this.users.set(id, {
      id,
      saveUpdatedAt: new Date(Date.now() - (opts.awayMs ?? 0)),
      awayClaimedAt: opts.awayClaimedAt ?? null,
      saveData: JSON.stringify({ defeatedGyms: new Array(opts.badges ?? 0).fill("g"), money: 1000 }),
      saveVersion: opts.saveVersion ?? 5,
    });
  }
}

let db: FakeDb;
beforeEach(() => { db = new FakeDb(); h.setDb(db); });

const claim = async (user = "u1") => {
  const res = await app.request("/claim", { method: "POST", headers: { "x-test-user": user } });
  return { status: res.status, body: await res.json() as any };
};
const status = async (user = "u1") => {
  const res = await app.request("/status", { method: "GET", headers: { "x-test-user": user } });
  return { status: res.status, body: await res.json() as any };
};

describe("the reward policy (pure)", () => {
  it("pays nothing below the minimum away time — a reload is not a reward", () => {
    expect(computeAwayProgress(0, 8).money).toBe(0);
    expect(computeAwayProgress(AWAY_MIN_MS - 1, 8).money).toBe(0);
    expect(computeAwayProgress(AWAY_MIN_MS, 8).money).toBeGreaterThan(0);
  });

  it("clamps a BACKWARDS clock to zero — never a negative prize", () => {
    // saveUpdatedAt comes from the server's own new Date(), so an NTP
    // correction between an upload and a claim can put it in the future. A
    // negative duration would become a negative money prize: a currency SINK
    // the player never agreed to.
    const r = computeAwayProgress(-5 * H, 16);
    expect(r.elapsedMs).toBe(0);
    expect(r.money).toBe(0);
  });

  it("caps accrual, and reports that it capped", () => {
    const r = computeAwayProgress(30 * 24 * H, 16);
    expect(r.creditedMs).toBe(AWAY_CAP_MS);
    expect(r.capped).toBe(true);
  });

  it("bounds the badge multiplier so it cannot be inflated", () => {
    expect(awayMoneyPerHour(-5)).toBe(awayMoneyPerHour(0));
    expect(awayMoneyPerHour(999)).toBe(awayMoneyPerHour(16));
    expect(awayMoneyPerHour(0)).toBe(AWAY_MONEY_PER_HOUR_BASE);
    for (let b = 1; b <= 16; b++) {
      expect(awayMoneyPerHour(b)).toBeGreaterThanOrEqual(awayMoneyPerHour(b - 1));
    }
  });

  it("stays an order of magnitude WORSE than a pessimistic active-income floor", () => {
    // Active income is trainer prize money (reducer.ts trainerPrize =
    // classBase * topLevel) and in a town the loop starts a fight on every
    // idle tick. Floor: the CHEAPEST class (bugCatcher, 12), a level-50
    // opponent, and a deliberately slow 30s per fight. Real late-game play is
    // several times this.
    const activeFloorPerHour = (3600 / 30) * 12 * 50;      // $72,000/h
    const awayCeilingPerHour = awayMoneyPerHour(16);
    expect(awayCeilingPerHour).toBeLessThan(activeFloorPerHour / 10);
  });

  it("anchors the away period on the LATER of last-upload and last-claim", () => {
    const t0 = new Date("2026-07-29T00:00:00Z");
    const t1 = new Date("2026-07-29T06:00:00Z");
    expect(awayPeriodStart(t0, null)!.getTime()).toBe(t0.getTime());
    expect(awayPeriodStart(t0, t1)!.getTime()).toBe(t1.getTime());
    // A later UPLOAD must win, or the player is paid for time spent playing.
    expect(awayPeriodStart(t1, t0)!.getTime()).toBe(t1.getTime());
    // No upload and no claim = no anchor to measure from.
    expect(awayPeriodStart(null, null)).toBeNull();
  });
});

describe("GET /status", () => {
  it("reports what is owed WITHOUT consuming it — reads never deliver", () => {
    // Same rule the save route documents: a read has no way to know the reader
    // absorbed it, so delivery only ever happens on a write.
    db.seed("u1", { awayMs: 8 * H, badges: 8 });
    return status().then(({ status: code, body }) => {
      expect(code).toBe(200);
      expect(body.money).toBeGreaterThan(0);
      expect(body.claimable).toBe(true);
      expect(db.users.get("u1")!.awayClaimedAt).toBeNull();
      expect(db.grants).toHaveLength(0);
    });
  });

  it("echoes the rules so the client does not keep a second copy that drifts", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 8 });
    const { body } = await status();
    expect(body.minMs).toBe(AWAY_MIN_MS);
    expect(body.capMs).toBe(AWAY_CAP_MS);
  });
});

describe("POST /claim", () => {
  it("owes the reward as ONE undelivered PendingGrant row", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 8 });
    const { body } = await claim();
    expect(body.claimed).toBe(true);
    expect(body.money).toBeGreaterThan(0);
    expect(db.grants).toHaveLength(1);
    expect(db.grants[0].source).toBe("away-progress");
    // Undelivered: POST /api/saves folds it into the next upload under its own
    // deliveredAt-IS-NULL compare-and-swap. That is the whole safety argument.
    expect(db.grants[0].deliveredAt).toBeNull();
    const prizes = JSON.parse(db.grants[0].prizes);
    expect(prizes).toEqual([{ kind: "money", amount: body.money }]);
  });

  it("NEVER touches the save — no saveData write, no saveVersion bump", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 16 });
    const before = { ...db.users.get("u1")! };
    await claim();
    const after = db.users.get("u1")!;
    expect(after.saveData).toBe(before.saveData);
    expect(after.saveVersion).toBe(before.saveVersion);
  });

  it("pays the same away period only once", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 8 });
    const first = await claim();
    expect(first.body.claimed).toBe(true);
    const second = await claim();
    expect(second.body.claimed).toBe(false);
    expect(second.body.money).toBe(0);
    expect(db.grants).toHaveLength(1);
  });

  it("rolls the grant back when it loses the gate to a concurrent claim", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 8 });
    // Interleave the competitor EXACTLY between this request's read of
    // awayClaimedAt and its conditional update of it — classic check-then-act,
    // which is why the gate is a WHERE and not an if.
    let raced = false;
    db.beforeGateOnce = () => {
      db.users.get("u1")!.awayClaimedAt = new Date();
      raced = true;
    };
    const { body } = await claim();
    expect(raced).toBe(true);
    expect(body.claimed).toBe(false);
    expect(db.grants).toHaveLength(0);
    // And it must report the FRESH amount, not the one it computed but will
    // never pay — otherwise the UI promises money that never arrives.
    expect(body.money).toBe(0);
  });

  it("pays again for a genuinely new absence", async () => {
    db.seed("u1", { awayMs: 20 * H, badges: 8 });
    const first = await claim();
    expect(first.body.claimed).toBe(true);
    expect(first.body.capped).toBe(true);
    // The player leaves again for 8h without uploading.
    const stamped = db.users.get("u1")!.awayClaimedAt!;
    db.users.get("u1")!.awayClaimedAt = new Date(stamped.getTime() - 8 * H);
    const second = await claim();
    expect(second.body.claimed).toBe(true);
    expect(db.grants).toHaveLength(2);
  });

  it("does NOT consume a below-minimum period, so it can keep accruing", async () => {
    db.seed("u1", { awayMs: 2 * 60_000, badges: 8 });
    const { body } = await claim();
    expect(body.claimed).toBe(false);
    expect(db.users.get("u1")!.awayClaimedAt).toBeNull();
  });

  it("pays nothing to an account that has never saved", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 8, saveVersion: 0 });
    const { body } = await claim();
    expect(body.claimed).toBe(false);
    expect(db.grants).toHaveLength(0);
  });

  it("404s an unknown account", async () => {
    const { status: code } = await claim("ghost");
    expect(code).toBe(404);
  });

  it("scales with badges read from the STORED save, not from the request", async () => {
    db.seed("a", { awayMs: 8 * H, badges: 0 });
    db.seed("b", { awayMs: 8 * H, badges: 8 });
    db.seed("c", { awayMs: 8 * H, badges: 16 });
    const a = (await claim("a")).body, b = (await claim("b")).body, c = (await claim("c")).body;
    expect(a.money).toBeLessThan(b.money);
    expect(b.money).toBeLessThan(c.money);
  });

  it("still claims when the stored save is unparseable, at the base rate", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 8 });
    db.users.get("u1")!.saveData = "{not json";
    const { body } = await claim();
    expect(body.claimed).toBe(true);
    expect(body.moneyPerHour).toBe(AWAY_MONEY_PER_HOUR_BASE);
  });

  it("cannot be turned into a payment loop by hammering it", async () => {
    db.seed("u1", { awayMs: 8 * H, badges: 16 });
    let paid = 0, limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await claim();
      if (r.status === 429) limited++;
      else if (r.body.claimed) paid++;
    }
    expect(paid).toBe(1);
    expect(limited).toBeGreaterThan(0);
    expect(db.grants).toHaveLength(1);
  });
});

describe("delivery rides the existing inbox", () => {
  it("folds into a save as money only, leaving the collection untouched", () => {
    const save = {
      money: 5_000,
      party: [{ id: "1", speciesKey: "pikachu", level: 20 }],
      box: [{ id: "2", speciesKey: "gastly", level: 15 }],
      pokedexCaught: ["pikachu", "gastly"],
      inventory: { pokeball: 10 },
    };
    const amount = computeAwayProgress(AWAY_CAP_MS, 16).money;
    const { save: after, applied } = foldPrizesIntoSave(save, [{ kind: "money", amount }], "gAway");
    expect(after.money).toBe(5_000 + amount);
    expect(applied).toEqual([{ kind: "money", amount }]);
    expect(after.party).toEqual(save.party);
    expect(after.box).toEqual(save.box);
    expect(after.pokedexCaught).toEqual(save.pokedexCaught);
    expect(after.inventory).toEqual(save.inventory);
  });

  it("reports no credit at the money ceiling, rather than a phantom one", () => {
    const amount = computeAwayProgress(AWAY_CAP_MS, 16).money;
    const { save, applied } = foldPrizesIntoSave({ money: 999_999_999 }, [{ kind: "money", amount }], "gAway2");
    expect(save.money).toBe(999_999_999);
    expect(applied).toHaveLength(0);
  });
});
