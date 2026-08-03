// THE REAL auction house components, RENDERED.
//
// Ported from tests/auctionCardRender.test.ts, which drove the old
// AuctionCard. The page was rebuilt as master/detail — a card that only
// compares, and one panel that commits — so the components changed shape, but
// the three defects that suite pinned are properties of the FEATURE, not of
// the old markup, and they have to survive the rewrite:
//
//   1. A bid box offered on a listing the player owns. The server always
//      refused it; the player found out after a round trip, via a toast.
//   2. A bid input carrying `min` above `max` — two native constraints no
//      value can satisfy at once — when the minimum exceeded the balance.
//   3. Copy promising "nobody else can see this number" about a maximum a
//      rival could read exactly by probing with bids.
//
// A typecheck cannot see any of those. These render the ACTUAL components
// with react-dom/server and read the ACTUAL markup a player would receive.

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const MONEY = { value: 900_000_000 };

vi.mock("../src/state/GameContext", () => ({
  useGame: () => ({
    state: { money: MONEY.value, party: [], box: [], inventory: {} },
    dispatch: () => undefined,
    syncNow: async () => undefined,
  }),
}));
vi.mock("../src/components/Sprite", () => ({
  PokemonSprite: () => null,
  Sprite: () => null,
}));
vi.mock("../src/components/Toast", () => ({ pushToast: () => undefined }));
vi.mock("../src/state/auctions", () => ({
  watchAuction: () => undefined,
  unwatchAuction: () => undefined,
  onAuctionBid: () => () => undefined,
  onAuctionOutbid: () => () => undefined,
  onAuctionProxyDropped: () => () => undefined,
}));
vi.mock("../src/net/api", () => ({
  api: {
    listAuctions: async () => ({ auctions: [] }),
    myAuctions: async () => ({ selling: [], bidding: [] }),
    getAuction: async () => ({ auction: null, bids: [] }),
    createAuction: async () => ({ auction: null }),
    placeBid: async () => ({ ok: true }),
    cancelAuction: async () => ({ ok: true }),
  },
}));

import { LotDetail } from "../src/components/AuctionLotAside";
import { LotCard } from "../src/components/AuctionHouse";
import type { PublicAuction } from "../src/net/api";

function auction(over: Partial<PublicAuction> = {}): PublicAuction {
  return {
    id: "a1",
    sellerUsername: "someone",
    youAreSeller: false,
    lotKind: "pokemon",
    pokemon: { id: "m1", name: "Gyarados", nickname: null, level: 66, speciesKey: "gyarados", isShiny: false },
    item: null,
    startingBid: 500_000,
    currentBid: 500_000,
    currentBidderUsername: "bob",
    bidCount: 1,
    distinctBidders: 1,
    minNextBid: 510_000,
    minIncrement: 10_000,
    youAreHighBidder: false,
    yourMax: null,
    status: "active",
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    settledAt: null,
    ...over,
  } as PublicAuction;
}

const panel = (a: PublicAuction) => renderToStaticMarkup(createElement(LotDetail, { lot: a }));
const card = (a: PublicAuction) => renderToStaticMarkup(createElement(LotCard, {
  lot: a, selected: false, paused: false, onSelect: () => undefined,
} as never));

/** Attributes of the bid-row number input, or null if there isn't one. */
function bidInput(html: string): Record<string, string> | null {
  const m = /<input([^>]*type="number"[^>]*)>/.exec(html);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const am of m[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[am[1]] = am[2];
  return attrs;
}

// ── Defect 1 ──────────────────────────────────────────────────────────────
describe("YOUR OWN LISTING gets an explanation, not a bid box", () => {
  it("renders no bid input on your own lot", () => {
    const html = panel(auction({ youAreSeller: true, sellerUsername: "me" }));
    expect(html).toContain("your listing");
    expect(bidInput(html)).toBeNull();
    expect(html).not.toContain("Your maximum");
  });

  it("offers to pull an unbid listing, and refuses to on a bid one", () => {
    const unbid = panel(auction({ youAreSeller: true, bidCount: 0, currentBid: 0, currentBidderUsername: null }));
    expect(unbid).toContain("Pull the listing");
    const bidOn = panel(auction({ youAreSeller: true, bidCount: 3 }));
    expect(bidOn).not.toContain("Pull the listing");
    expect(bidOn).toContain("has to run to the end");
  });

  it("still renders the bid box on somebody ELSE'S lot", () => {
    const html = panel(auction({ youAreSeller: false }));
    expect(html).not.toContain("your listing");
    expect(bidInput(html)).not.toBeNull();
  });

  it("keeps the price and the clock visible on your own lot", () => {
    const html = panel(auction({ youAreSeller: true, currentBid: 2_000_000 }));
    expect(html).toContain("$2,000,000");
    expect(html).toContain("Ends in");
  });
});

// ── Defect 2 ──────────────────────────────────────────────────────────────
describe("THE BID INPUT NEVER CARRIES CONTRADICTORY CONSTRAINTS", () => {
  it("sets a min and never a max, so the pair cannot contradict", () => {
    // The old input carried `max = your balance`, which meant a lot whose
    // minimum was above your balance rendered min=90250000 max=6000000 — a
    // range with nothing in it. The balance is enforced in words and on the
    // button instead, where it can explain itself.
    MONEY.value = 6_000_000;
    const html = panel(auction({ currentBid: 90_000_000, minNextBid: 90_250_000, minIncrement: 250_000 }));
    const input = bidInput(html)!;
    expect(input.min).toBe("90250000");
    expect(input.max).toBeUndefined();
    MONEY.value = 900_000_000;
  });

  it("says in words that you cannot cover it, before anything is typed", () => {
    MONEY.value = 6_000_000;
    const html = panel(auction({ currentBid: 90_000_000, minNextBid: 90_250_000, minIncrement: 250_000 }));
    expect(html).toContain("can&#x27;t cover the current minimum");
    expect(html).toContain("$90,250,000");
    MONEY.value = 900_000_000;
  });

  it("across a sweep of balances, min is never above max when max is present", () => {
    for (const money of [0, 1, 500, 509_999, 510_000, 1_000_000, 900_000_000]) {
      MONEY.value = money;
      const input = bidInput(panel(auction()))!;
      if (input.max !== undefined) {
        expect(Number(input.min), `balance ${money}`).toBeLessThanOrEqual(Number(input.max));
      }
    }
    MONEY.value = 900_000_000;
  });
});

// ── Defect 3 ──────────────────────────────────────────────────────────────
describe("THE SECRECY PROMISE DOES NOT OVERCLAIM", () => {
  it("never claims nobody can see the maximum", () => {
    // A rival CAN read it exactly, by probing with bids until one sticks.
    // The old copy said "Nobody else can see this number"; saying only that
    // it is hidden, and that you pay no more than you must, is true.
    const html = panel(auction({ youAreHighBidder: true, yourMax: 4_000_000 }));
    expect(html.toLowerCase()).not.toContain("nobody else can see");
    expect(html).toContain("hidden maximum");
    expect(html).toContain("$4,000,000");
  });
});

// ── The prefill, which was off by up to $50,000 ────────────────────────────
describe("THE RULE IS STATED BEFORE THE PLAYER TYPES, and prefilled", () => {
  it("prefills the exact minimum on a contested lot", () => {
    const input = bidInput(panel(auction()))!;
    expect(input.value).toBe("510000");
    expect(input.min).toBe("510000");
  });

  it("prefills above your own maximum while you are leading", () => {
    const input = bidInput(panel(auction({
      youAreHighBidder: true, yourMax: 4_000_000, currentBid: 700_000,
      minNextBid: 710_000, minIncrement: 10_000,
    })))!;
    expect(Number(input.min)).toBeGreaterThan(4_000_000);
    expect(Number(input.value)).toBeGreaterThan(4_000_000);
  });
});

// ── The rebuild's own promises ────────────────────────────────────────────
describe("a card compares; it does not commit", () => {
  // The entire point of the split. If a form ever creeps back onto a card,
  // the page is back to six inputs down the screen.
  it("renders NO input and NO bid control", () => {
    const html = card(auction());
    expect(html).not.toContain("<input");
    expect(html).not.toContain("How bidding works");
    expect(html).not.toContain("Your maximum");
  });

  it("carries the four things a comparison needs", () => {
    const html = card(auction({ currentBid: 2_500_000 }));
    expect(html).toContain("Gyarados");     // what
    expect(html).toContain("$2,500,000");   // how much
    expect(html).toMatch(/\d+[hm]/);        // how long
    expect(html).toContain("Current");
  });

  it("labels an unbid lot as a starting price, not a current one", () => {
    const html = card(auction({ currentBid: 0, bidCount: 0, currentBidderUsername: null }));
    expect(html).toContain("Starting");
    expect(html).not.toContain("Current");
  });

  it("badges your standing only when you have one", () => {
    expect(card(auction())).not.toContain("Winning");
    expect(card(auction({ youAreHighBidder: true }))).toContain("Winning");
    expect(card(auction({ youAreSeller: true }))).toContain("Your listing");
  });
});

describe("an item lot renders as a machine, not as a broken Pokemon", () => {
  const machineLot = (over: Partial<PublicAuction> = {}) => auction({
    lotKind: "item",
    pokemon: null,
    item: { itemId: "tm24", quantity: 1 },
    ...over,
  });

  it("names the machine and its move on the card", () => {
    const html = card(machineLot());
    expect(html).toContain("TM24");
    expect(html).toContain("Thunderbolt");
  });

  it("shows the move's numbers in the panel", () => {
    const html = panel(machineLot());
    expect(html).toContain("Thunderbolt");
    expect(html).toContain("Electric");
  });

  it("tells a buyer who owns nothing that can learn it", () => {
    // The mocked game state has an empty party and box, so this is the
    // "worth nothing to you" case — the one thing a price cannot tell you.
    const html = panel(machineLot());
    expect(html).toContain("Nothing you own can learn this move.");
  });

  it("does not render a Pokemon's IV bars for a machine", () => {
    expect(panel(machineLot())).not.toContain("ah-ivs");
  });
});
