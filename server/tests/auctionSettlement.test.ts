// Auction settlement: the money movement is server-authoritative, so BOTH
// sides' writes must bump saveAdoptSeq in the same update — without it the
// buyer's client re-uploads a blob that still has the money and no mon
// (+500,000 minted, "bought a shiny, never received it"). And a lost CAS
// must commit NOTHING.
//
// Stubbing: ../src/db.js is an in-memory fake; ../src/socket.js a spy.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  let prismaImpl: any = {};
  return {
    setPrisma: (p: any) => { prismaImpl = p; },
    prismaProxy: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => prismaImpl[prop],
    }),
    sent: [] as { userId: string; event: string; payload: unknown }[],
  };
});

vi.mock("../src/db.js", () => ({ prisma: h.prismaProxy }));
vi.mock("../src/socket.js", () => ({
  sendToUserGlobal: (userId: string, event: string, payload: unknown) => {
    h.sent.push({ userId, event, payload });
  },
}));

import { settleDueAuctions } from "../src/lib/auctionSettlement.js";

const mon = {
  id: "escrow1", speciesKey: "lapras", level: 40, totalExp: 1000,
  maxHp: 120, currentHp: 120, attack: 60, defense: 60, spAttack: 60, spDefense: 60, speed: 40,
};

interface UserRow {
  saveData: string; saveVersion: number; username: string; saveAdoptSeq: number;
}

function makeWorld(over: { lot?: "pokemon" | "item" } = {}) {
  const users: Record<string, UserRow> = {
    seller: {
      username: "SellerSue", saveVersion: 10, saveAdoptSeq: 3,
      saveData: JSON.stringify({ money: 50, party: [], box: [] }),
    },
    buyer: {
      username: "BuyerBob", saveVersion: 20, saveAdoptSeq: 7,
      saveData: JSON.stringify({ money: 1_000, party: [], box: [] }),
    },
  };
  const auction: Record<string, unknown> = over.lot === "item"
    ? {
        id: "a1", status: "active", endsAt: new Date(Date.now() - 60_000),
        sellerId: "seller", currentBidderId: "buyer", currentBid: 500,
        lotKind: "item", itemId: "tm26", itemQty: 1,
        pokemonId: null, pokemonSnapshot: null,
      }
    : {
        id: "a1", status: "active", endsAt: new Date(Date.now() - 60_000),
        sellerId: "seller", currentBidderId: "buyer", currentBid: 500,
        lotKind: "pokemon", itemId: null, itemQty: null,
        pokemonSnapshot: JSON.stringify(mon),
      };
  const updates: { model: string; where: any; data: any }[] = [];
  /** When set, the named user's CAS misses once (simulating a concurrent autosave). */
  let failCasOnce: string | null = null;

  const client: any = {
    auction: {
      findMany: async () => (auction.status === "active" ? [{ id: auction.id as string }] : []),
      findUnique: async () => ({ ...auction }),
      updateMany: async ({ where, data }: any) => {
        updates.push({ model: "auction", where, data });
        if (where.status === "active" && auction.status !== "active") return { count: 0 };
        Object.assign(auction, data);
        return { count: 1 };
      },
    },
    user: {
      findUnique: async ({ where }: any) =>
        users[where.id] ? { ...users[where.id], id: where.id } : null,
      updateMany: async ({ where, data }: any) => {
        updates.push({ model: "user", where, data });
        const u = users[where.id];
        if (!u || (where.saveVersion !== undefined && where.saveVersion !== u.saveVersion)) {
          return { count: 0 };
        }
        if (failCasOnce === where.id) {
          failCasOnce = null;
          return { count: 0 };
        }
        if (data.saveData !== undefined) u.saveData = data.saveData;
        if (data.saveVersion?.increment) u.saveVersion += data.saveVersion.increment;
        if (data.saveAdoptSeq?.increment) u.saveAdoptSeq += data.saveAdoptSeq.increment;
        return { count: 1 };
      },
    },
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const usersSnap = JSON.parse(JSON.stringify(users));
      const auctionSnap = { ...auction };
      try {
        return await fn(client);
      } catch (e) {
        Object.assign(users, JSON.parse(JSON.stringify(usersSnap)));
        Object.assign(auction, auctionSnap);
        throw e;
      }
    },
  };
  return {
    client, users, auction, updates,
    setFailCasOnce: (id: string) => { failCasOnce = id; },
  };
}

beforeEach(() => {
  h.sent.length = 0;
});

describe("auction settlement", () => {
  it("bumps saveAdoptSeq on BOTH sides in the same update as the save write", async () => {
    const w = makeWorld();
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("sold");
    // Seller got the money, buyer got the mon and paid.
    const sellerSave = JSON.parse(w.users.seller.saveData);
    const buyerSave = JSON.parse(w.users.buyer.saveData);
    expect(sellerSave.money).toBe(550);
    expect(buyerSave.money).toBe(500);
    expect(buyerSave.party.some((m: any) => m.id === "escrow1")).toBe(true);

    // THE invariant: every settlement write carries the adopt bump.
    const userWrites = w.updates.filter((u) => u.model === "user");
    expect(userWrites).toHaveLength(2);
    for (const write of userWrites) {
      expect(write.data.saveAdoptSeq).toEqual({ increment: 1 });
      expect(write.data.saveVersion).toEqual({ increment: 1 });
      expect(write.where.saveVersion).toBeDefined(); // CAS, not blind
    }
    expect(w.users.seller.saveAdoptSeq).toBe(4);
    expect(w.users.buyer.saveAdoptSeq).toBe(8);

    // Both clients are told to adopt the copies that hold the outcome.
    expect(h.sent).toContainEqual({ userId: "seller", event: "save:adopt", payload: {} });
    expect(h.sent).toContainEqual({ userId: "buyer", event: "save:adopt", payload: {} });
    expect(h.sent.some((s) => s.event === "auction:sold" && s.userId === "seller")).toBe(true);
    expect(h.sent.some((s) => s.event === "auction:won" && s.userId === "buyer")).toBe(true);
  });

  it("a lost CAS commits nothing and the sweep retries from a fresh read", async () => {
    const w = makeWorld();
    h.setPrisma(w.client);
    // First attempt: seller's CAS loses to a concurrent autosave; the
    // transaction must roll back whole. The retry then succeeds.
    w.setFailCasOnce("seller");
    await settleDueAuctions();

    // Retry succeeded — final state is fully settled, exactly once.
    expect(w.auction.status).toBe("sold");
    expect(JSON.parse(w.users.seller.saveData).money).toBe(550);
    expect(JSON.parse(w.users.buyer.saveData).money).toBe(500);
    // The failed attempt never wrote the buyer or flipped the auction:
    // after the seller claim missed, the transaction aborted before them.
    const buyerWrites = w.updates.filter((u) => u.model === "user" && u.where.id === "buyer");
    expect(buyerWrites).toHaveLength(1); // only the successful attempt
  });

  it("a winner who cannot pay cancels the sale and returns the escrowed mon to the seller", async () => {
    const w = makeWorld();
    w.users.buyer.saveData = JSON.stringify({ money: 10, party: [], box: [] });
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("cancelled");
    const sellerSave = JSON.parse(w.users.seller.saveData);
    expect(sellerSave.money).toBe(50); // no proceeds
    expect(sellerSave.box.some((m: any) => m.id === "escrow1")).toBe(true); // escrow returned
    expect(JSON.parse(w.users.buyer.saveData).money).toBe(10); // untouched
  });
});

// ════════════════════════════════════════════════════════════════════
describe("settling an ITEM lot", () => {
  // Same transaction, same CAS, same adopt bump — the only thing that differs
  // is where the lot lands. These pin that the item half did not quietly skip
  // any of the guarantees the Pokemon half spent several incidents earning.
  it("delivers the machine to the winner's bag and pays the seller", async () => {
    const w = makeWorld({ lot: "item" });
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("sold");
    const sellerSave = JSON.parse(w.users.seller.saveData);
    const buyerSave = JSON.parse(w.users.buyer.saveData);
    expect(sellerSave.money).toBe(550);
    expect(buyerSave.money).toBe(500);
    expect(buyerSave.inventory.tm26).toBe(1);
    // The seller does NOT get it back — it left their bag at listing time.
    expect(sellerSave.inventory?.tm26).toBeUndefined();
  });

  it("carries the same adopt bump and CAS on both sides", async () => {
    const w = makeWorld({ lot: "item" });
    h.setPrisma(w.client);
    await settleDueAuctions();
    const userWrites = w.updates.filter((u) => u.model === "user");
    expect(userWrites).toHaveLength(2);
    for (const write of userWrites) {
      expect(write.data.saveAdoptSeq).toEqual({ increment: 1 });
      expect(write.where.saveVersion).toBeDefined();
    }
  });

  it("returns the machine to the seller when the winner cannot pay", async () => {
    const w = makeWorld({ lot: "item" });
    w.users.buyer.saveData = JSON.stringify({ money: 10, party: [], box: [], inventory: {} });
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("cancelled");
    expect(JSON.parse(w.users.seller.saveData).inventory.tm26).toBe(1);
    expect(JSON.parse(w.users.buyer.saveData).money).toBe(10);
  });

  it("cancels rather than delivering a machine the winner already found", async () => {
    // ── THE CAP, ENFORCED WHERE IT MATTERS ────────────────────────────
    // The bid route refuses a bidder who already holds the machine, but a
    // 48-hour listing gives them plenty of time to turn one up on a route
    // afterwards. Delivering here would mint a second copy of something the
    // game caps at one — and they would have paid for it. Cancelling returns
    // the machine to the seller and moves no money.
    const w = makeWorld({ lot: "item" });
    w.users.buyer.saveData = JSON.stringify({ money: 1_000, party: [], box: [], inventory: { tm26: 1 } });
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("cancelled");
    expect(JSON.parse(w.users.buyer.saveData).money).toBe(1_000); // paid nothing
    expect(JSON.parse(w.users.buyer.saveData).inventory.tm26).toBe(1); // still one
    expect(JSON.parse(w.users.seller.saveData).inventory.tm26).toBe(1); // returned
  });

  it("returns the machine when the listing expires with no bids", async () => {
    const w = makeWorld({ lot: "item" });
    w.auction.currentBidderId = null;
    w.auction.currentBid = 0;
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("expired");
    expect(JSON.parse(w.users.seller.saveData).inventory.tm26).toBe(1);
  });
});
