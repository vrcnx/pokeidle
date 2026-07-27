-- CreateTable
--
-- Additive ONLY. One new table; no existing table, column, index or
-- constraint is touched, so this is safe to apply while the current server
-- build is live and old clients are mid-session: nothing that exists today
-- reads or writes "PendingGrant", and nothing that exists today changes
-- behaviour because it appeared. The new code path is gated on the client
-- opting in (`grantAck` on POST /api/saves), so a client that predates this
-- deploy keeps behaving exactly as it does now and simply collects its
-- prizes on its next page load.
--
-- IF NOT EXISTS / duplicate_object guards keep a rerun or a partially
-- applied deploy from failing `prisma migrate deploy`.
CREATE TABLE IF NOT EXISTS "PendingGrant" (
    "id"                   TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "prizes"               TEXT NOT NULL,
    "source"               TEXT NOT NULL,
    "sourceId"             TEXT,
    "summary"              TEXT NOT NULL,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt"          TIMESTAMP(3),
    "deliveredSaveVersion" INTEGER,
    "attempts"             INTEGER NOT NULL DEFAULT 0,
    "lastError"            TEXT,

    CONSTRAINT "PendingGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Hot path: "what does this user still owe?", run on every accepted save
-- upload, so it must never be a sequential scan.
CREATE INDEX IF NOT EXISTS "PendingGrant_userId_deliveredAt_idx"
    ON "PendingGrant" ("userId", "deliveredAt");

-- Ops sweep: "what is owed across all accounts, oldest first?"
CREATE INDEX IF NOT EXISTS "PendingGrant_deliveredAt_createdAt_idx"
    ON "PendingGrant" ("deliveredAt", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PendingGrant"
    ADD CONSTRAINT "PendingGrant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
