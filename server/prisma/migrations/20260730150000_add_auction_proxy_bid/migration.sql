-- Proxy (maximum) bids for the auction house.
-- Policy + arithmetic: server/src/lib/auctionBidRules.ts.
-- Route: server/src/routes/auctions.ts (POST /:id/bids).
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- ONE new table and nothing else. No existing table is touched: "Auction" and
-- "Bid" are not altered, no column is added to them, nothing is retyped,
-- nothing dropped, no backfill, no data rewritten. Safe to apply against the
-- live server while it is serving traffic, and every statement is
-- IF NOT EXISTS so a rerun or a partially-applied deploy is a no-op rather
-- than a failure. Modelled on 20260730120000_add_pvp_ladder.
--
-- Verified read-only against production on 2026-07-30 before this file was
-- written: "AuctionProxyBid" does not exist, and there are 26 live auctions
-- whose rows this migration does not read or write.
--
-- ── WHY A SEPARATE TABLE AND NOT THREE COLUMNS ON "Auction" ──────────
-- THIS IS THE SECRECY MECHANISM, and it is the whole reason for the shape.
--
-- A bidder's maximum is the one value in this feature that must never reach
-- another player. The alternative design — "topProxyMax" / "topProxyBidderId"
-- columns on "Auction" — makes every SELECT on that table a potential leak,
-- and routes/auctions.ts contains exactly the footgun that would fire:
--
--     const auction = await prisma.auction.findUnique({ where: { id } });
--
-- with no `select`. That reads every column into request scope, so the max
-- would be one accidental `...auction` spread away from the wire, forever,
-- in a file other people will keep editing. The AUCTION_SELECT allowlist
-- protects the two list routes but NOT that call.
--
-- With the maximum in its own table, no query against "Auction" can return it
-- by accident. Leaking it requires deliberately joining a table whose only
-- purpose is this, which a reviewer will notice. The guarantee is structural
-- rather than remembered.
--
-- Second reason, and it matters for THIS deploy: the running server never
-- names this table until the new code ships. railway.json runs
-- `prisma migrate deploy && npm start`, so the table exists before the code
-- that reads it — and if that ordering is ever broken, auctionProxy.ts
-- degrades to plain (non-proxy) bidding rather than failing every bid,
-- because a missing table is a table-level error it can catch instead of a
-- column-level error inside an unrelated query it cannot.
--
-- ── WHY THE PRIMARY KEY IS "auctionId" ALONE ─────────────────────────
-- At most ONE maximum is ever stored per auction: the CURRENT LEADER'S. A
-- beaten maximum is consumed and discarded the instant it loses, which is
-- what makes proxy resolution closed-form (one comparison, no loop, nothing
-- to iterate, nothing to deadlock). The primary key is that invariant
-- expressed as a constraint: the schema cannot hold a queue of live maxima
-- even if the application tried to write one.
CREATE TABLE IF NOT EXISTS "AuctionProxyBid" (
    "auctionId" TEXT         NOT NULL,

    -- The leader. Redundant with "Auction"."currentBidderId" BY DESIGN — the
    -- route asserts the two agree on every write, so a divergence is a free
    -- corruption detector rather than an unnoticed inconsistency.
    "bidderId"  TEXT         NOT NULL,

    -- THE SECRET. Never selected by any route that serialises an auction for
    -- another player; returned to its OWN owner only, behind a positive
    -- `bidderId === viewerId` identity check.
    "maxAmount" INTEGER      NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuctionProxyBid_pkey" PRIMARY KEY ("auctionId"),

    -- A maximum of zero or less is not a bid. Mirrors the zod bound on the
    -- route so the database refuses it even if a future edit forgets to.
    CONSTRAINT "AuctionProxyBid_positive" CHECK ("maxAmount" > 0),

    -- Cascade: a deleted auction's stored maximum is meaningless, and a
    -- deleted account cannot hold a leading position.
    CONSTRAINT "AuctionProxyBid_auctionId_fkey"
        FOREIGN KEY ("auctionId") REFERENCES "Auction"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuctionProxyBid_bidderId_fkey"
        FOREIGN KEY ("bidderId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- "which auctions am I currently the proxy leader on?" — the My Auctions view
-- and the insufficient-funds drop notice both read by bidder.
CREATE INDEX IF NOT EXISTS "AuctionProxyBid_bidderId_idx"
    ON "AuctionProxyBid" ("bidderId");
