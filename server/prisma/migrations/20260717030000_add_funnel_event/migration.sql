-- CreateTable
-- Additive: one new table, the new-player funnel. No existing table is
-- touched. IF NOT EXISTS keeps a rerun/partial apply from failing the deploy.
CREATE TABLE IF NOT EXISTS "FunnelEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FunnelEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FunnelEvent_userId_type_key" ON "FunnelEvent" ("userId", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FunnelEvent_type_createdAt_idx" ON "FunnelEvent" ("type", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FunnelEvent"
    ADD CONSTRAINT "FunnelEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
