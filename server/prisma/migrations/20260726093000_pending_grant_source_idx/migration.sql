-- CreateIndex
--
-- Additive ONLY: one index on the table the previous migration created. No
-- column, constraint or row is touched, so this is safe to apply against a
-- live server.
--
-- GET /admin/giveaways now joins the grant inbox so a winner can be shown as
-- OWED rather than mislabelled UNPAID (claimedAt stopped meaning "in their
-- save" when the inbox landed). That lookup is by (source, sourceId), which
-- neither existing index covers — and PendingGrant is append-only, one row per
-- grant per recipient, so a mass gift to every account adds ~2.3k rows at a
-- time. Without this the giveaways page degrades into a sequential scan that
-- gets slower every time an operator sends anything.
--
-- IF NOT EXISTS keeps a rerun or a partially applied deploy from failing
-- `prisma migrate deploy`.
CREATE INDEX IF NOT EXISTS "PendingGrant_source_sourceId_idx"
    ON "PendingGrant" ("source", "sourceId");
