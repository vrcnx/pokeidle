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
  /** Every PendingGrant row written. The seller's proceeds land here, not in a save. */
  const grants: { userId: string; prizes: string; source: string; sourceId: string | null }[] = [];
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
    pendingGrant: {
      create: async ({ data }: any) => {
        grants.push({ ...data });
        return { id: `g${grants.length}` };
      },
    },
    $executeRaw: async () => 1,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const usersSnap = JSON.parse(JSON.stringify(users));
      const auctionSnap = { ...auction };
      // Grants roll back with everything else. Without this the fake would
      // report a seller as paid by an attempt that threw, which is precisely
      // the property the settlement relies on when it enlists the grant in its
      // own transaction — a test that cannot see the rollback cannot prove it.
      const grantsSnap = grants.length;
      try {
        return await fn(client);
      } catch (e) {
        Object.assign(users, JSON.parse(JSON.stringify(usersSnap)));
        Object.assign(auction, auctionSnap);
        grants.length = grantsSnap;
        throw e;
      }
    },
  };
  return {
    client, users, auction, updates, grants,
    setFailCasOnce: (id: string) => { failCasOnce = id; },
  };
}

beforeEach(() => {
  h.sent.length = 0;
});

describe("auction settlement", () => {
  it("pays the seller by grant and NEVER rewrites their save", async () => {
    // This is the regression test for the reported save loss. A settlement
    // used to rewrite the seller's blob and bump saveAdoptSeq, forcing their
    // client to adopt server bytes wholesale mid-session; everything they had
    // played since their last autosave was discarded. Sellers reported it as
    // "my levels and Pokémon reset but my money and League were fine" —
    // because the money was the one thing the settlement wrote.
    const w = makeWorld();
    const sellerBytesBefore = w.users.seller.saveData;
    const sellerVersionBefore = w.users.seller.saveVersion;
    const sellerAdoptBefore = w.users.seller.saveAdoptSeq;
    h.setPrisma(w.client);
    await settleDueAuctions();

    expect(w.auction.status).toBe("sold");

    // The seller's stored save is byte-identical, same version, same adopt
    // counter. Nothing to adopt means nothing can be lost.
    expect(w.users.seller.saveData).toBe(sellerBytesBefore);
    expect(w.users.seller.saveVersion).toBe(sellerVersionBefore);
    expect(w.users.seller.saveAdoptSeq).toBe(sellerAdoptBefore);
    expect(w.updates.filter((u) => u.model === "user" && u.where.id === "seller")).toHaveLength(0);

    // They are paid, in full, through the inbox instead.
    expect(w.grants).toHaveLength(1);
    expect(w.grants[0].userId).toBe("seller");
    expect(w.grants[0].source).toBe("auction-sale");
    expect(w.grants[0].sourceId).toBe("a1"); // one payout per auction, ever
    expect(JSON.parse(w.grants[0].prizes)).toEqual([{ kind: "money", amount: 500 }]);

    // The BUYER still gets the old treatment, and must: a bid is a DEDUCTION,
    // which no grant can express, so their bytes are rewritten under a CAS and
    // they are told to adopt. Without that they keep the money and the mon.
    const buyerSave = JSON.parse(w.users.buyer.saveData);
    expect(buyerSave.money).toBe(500);
    expect(buyerSave.party.some((m: any) => m.id === "escrow1")).toBe(true);
    const buyerWrites = w.updates.filter((u) => u.model === "user" && u.where.id === "buyer");
    expect(buyerWrites).toHaveLength(1);
    expect(buyerWrites[0].data.saveAdoptSeq).toEqual({ increment: 1 });
    expect(buyerWrites[0].data.saveVersion).toEqual({ increment: 1 });
    expect(buyerWrites[0].where.saveVersion).toBeDefined(); // CAS, not blind
    expect(w.users.buyer.saveAdoptSeq).toBe(8);

    // ONLY the buyer is told to adopt. Telling the seller to would throw away
    // exactly the play this change exists to protect.
    expect(h.sent).toContainEqual({ userId: "buyer", event: "save:adopt", payload: {} });
    expect(h.sent.some((s) => s.userId === "seller" && s.event === "save:adopt")).toBe(false);

    // Both are still NOTIFIED — the seller's news is the toast, not the bytes.
    expect(h.sent.some((s) => s.event === "auction:sold" && s.userId === "seller")).toBe(true);
    expect(h.sent.some((s) => s.event === "auction:won" && s.userId === "buyer")).toBe(true);
  });

  it("does not quote the seller a money total it did not write", async () => {
    // The old payload carried newMoney/newSaveVersion and the client SET its
    // balance from them. Those numbers are now unknowable server-side — the
    // seller's save was not written and the grant has not folded — so sending
    // them would be the same overwrite-live-state bug at smaller scale.
    const w = makeWorld();
    h.setPrisma(w.client);
    await settleDueAuctions();

    const sold = h.sent.find((s) => s.event === "auction:sold")!;
    expect(sold.payload).not.toHaveProperty("newMoney");
    expect(sold.payload).not.toHaveProperty("newSaveVersion");
    expect(sold.payload).toMatchObject({ auctionId: "a1", amount: 500 });
  });

  it("a lost CAS commits nothing — grant included — and the sweep retries", async () => {
    const w = makeWorld();
    h.setPrisma(w.client);
    // The buyer is now the only side with a CAS to lose, so this is where a
    // concurrent autosave collides. The whole transaction must roll back,
    // INCLUDING the seller's grant: an attempt that failed to take the money
    // from the buyer must not leave the seller owed it.
    w.setFailCasOnce("buyer");
    await settleDueAuctions();

    // Retry succeeded — final state is fully settled, exactly once.
    expect(w.auction.status).toBe("sold");
    expect(JSON.parse(w.users.buyer.saveData).money).toBe(500);
    // Exactly ONE grant survives, not one per attempt. This is the property
    // that makes enlisting in the settlement's transaction worth doing: paying
    // the seller on a rolled-back attempt would mint money out of a retry.
    expect(w.grants).toHaveLength(1);
    expect(w.grants[0].userId).toBe("seller");
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
    expect(buyerSave.money).toBe(500);
    expect(buyerSave.inventory.tm26).toBe(1);
    // Paid by grant, exactly like a Pokemon lot — the lot kind changes where
    // the goods land, never how the seller is paid.
    expect(JSON.parse(w.grants[0].prizes)).toEqual([{ kind: "money", amount: 500 }]);
    // The seller does NOT get it back — it left their bag at listing time.
    expect(sellerSave.inventory?.tm26).toBeUndefined();
  });

  it("carries the adopt bump and CAS on the side that is actually written", async () => {
    const w = makeWorld({ lot: "item" });
    h.setPrisma(w.client);
    await settleDueAuctions();
    // One write, the buyer's, for the same reason as a Pokemon lot: they are
    // the only side money is taken from.
    const userWrites = w.updates.filter((u) => u.model === "user");
    expect(userWrites).toHaveLength(1);
    expect(userWrites[0].where.id).toBe("buyer");
    expect(userWrites[0].data.saveAdoptSeq).toEqual({ increment: 1 });
    expect(userWrites[0].where.saveVersion).toBeDefined();
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
