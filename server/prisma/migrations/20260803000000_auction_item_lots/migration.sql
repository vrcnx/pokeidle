-- Auctions can sell an ITEM, not just a Pokemon.
--
-- ── WHY ──────────────────────────────────────────────────────────────
-- TMs shipped as real items: reusable, capped at one per player, and mostly
-- found rather than bought. That creates a market the game had no way to
-- express — you turn up TM26 Earthquake on a route you were farming for
-- something else, you already have it, and there is nothing you can do with
-- the second one except leave it in the bag. Meanwhile the player who wants
-- it is waiting on the TM Mart's rotation or a 1.5% drop.
--
-- Auctions already solve exactly this problem for Pokemon, with proxy
-- bidding, a shill watch, and an all-or-nothing settlement that has been
-- through several rounds of hardening. Building a second market beside it
-- would mean re-earning all of that.
--
-- ── ADDITIVE ONLY ────────────────────────────────────────────────────
-- Three new columns and two DROP NOT NULLs. Nothing is deleted, nothing is
-- retyped, and no existing row changes value: `lotKind` defaults to
-- 'pokemon', which is what every row already in this table is. Safe to apply
-- while the server is running, and every statement is guarded so a rerun or a
-- half-applied deploy is a no-op.
--
-- ── WHY THE POKEMON COLUMNS BECOME NULLABLE ──────────────────────────
-- An item lot has no Pokemon. The alternative — a sentinel like '' or a
-- separate table — either lies in the column or duplicates the entire
-- bidding and settlement path for the sake of one field. NULL is what "this
-- lot is not a Pokemon" means, and the CHECK below is what stops it meaning
-- anything else.

ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "lotKind" TEXT NOT NULL DEFAULT 'pokemon';
ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "itemId" TEXT;
ALTER TABLE "Auction" ADD COLUMN IF NOT EXISTS "itemQty" INTEGER;

ALTER TABLE "Auction" ALTER COLUMN "pokemonId" DROP NOT NULL;
ALTER TABLE "Auction" ALTER COLUMN "pokemonSnapshot" DROP NOT NULL;

-- A lot must actually carry the thing it claims to be selling.
--
-- This is the constraint that makes the nullable columns safe. Without it a
-- bug could write lotKind='item' with no itemId, and the row would sit in the
-- browse list as an unsellable ghost until settlement tried to deliver
-- nothing — the failure would surface hours later, in the one code path that
-- moves other people's money.
--
-- Wrapped because ADD CONSTRAINT has no IF NOT EXISTS in the PostgreSQL
-- versions this runs on; the exception makes a rerun a no-op.
DO $$
BEGIN
  ALTER TABLE "Auction" ADD CONSTRAINT "Auction_lot_shape_check" CHECK (
    ("lotKind" = 'pokemon' AND "pokemonId" IS NOT NULL AND "pokemonSnapshot" IS NOT NULL)
    OR
    ("lotKind" = 'item' AND "itemId" IS NOT NULL AND "itemQty" IS NOT NULL AND "itemQty" > 0)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Browsing filters by kind ("show me the TMs"), always alongside status.
CREATE INDEX IF NOT EXISTS "Auction_lotKind_status_endsAt_idx"
  ON "Auction" ("lotKind", "status", "endsAt");
