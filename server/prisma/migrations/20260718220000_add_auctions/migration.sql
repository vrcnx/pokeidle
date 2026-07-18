-- CreateTable
-- Additive: two new tables backing the Trade tab's auction system.
-- No existing table is touched. IF NOT EXISTS keeps a rerun/partial
-- apply from failing the deploy.
CREATE TABLE IF NOT EXISTS "Auction" (
    "id"              TEXT NOT NULL,
    "sellerId"        TEXT NOT NULL,
    "pokemonId"       TEXT NOT NULL,
    "pokemonSnapshot" TEXT NOT NULL,
    "startingBid"     INTEGER NOT NULL,
    "currentBid"      INTEGER NOT NULL DEFAULT 0,
    "currentBidderId" TEXT,
    "status"          TEXT NOT NULL DEFAULT 'active',
    "endsAt"          TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    "settledAt"       TIMESTAMP(3),

    CONSTRAINT "Auction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Bid" (
    "id"        TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidderId"  TEXT NOT NULL,
    "amount"    INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Auction_status_endsAt_idx" ON "Auction" ("status", "endsAt");
CREATE INDEX IF NOT EXISTS "Auction_sellerId_createdAt_idx" ON "Auction" ("sellerId", "createdAt");
CREATE INDEX IF NOT EXISTS "Bid_auctionId_createdAt_idx" ON "Bid" ("auctionId", "createdAt");
CREATE INDEX IF NOT EXISTS "Bid_bidderId_createdAt_idx" ON "Bid" ("bidderId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Auction"
    ADD CONSTRAINT "Auction_sellerId_fkey"
    FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Bid"
    ADD CONSTRAINT "Bid_auctionId_fkey"
    FOREIGN KEY ("auctionId") REFERENCES "Auction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Bid"
    ADD CONSTRAINT "Bid_bidderId_fkey"
    FOREIGN KEY ("bidderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
