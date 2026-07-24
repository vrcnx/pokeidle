-- CreateTable
-- Additive: one new table backing per-account OBS/stream auto-login keys.
-- No existing table is touched. IF NOT EXISTS keeps a rerun/partial apply
-- from failing the deploy.
CREATE TABLE IF NOT EXISTS "StreamKey" (
    "id"         TEXT NOT NULL,
    "userId"     TEXT NOT NULL,
    "key"        TEXT NOT NULL,
    "enabled"    BOOLEAN NOT NULL DEFAULT true,
    "label"      TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,

    CONSTRAINT "StreamKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StreamKey_userId_key" ON "StreamKey" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "StreamKey_key_key" ON "StreamKey" ("key");
CREATE INDEX IF NOT EXISTS "StreamKey_key_idx" ON "StreamKey" ("key");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "StreamKey"
    ADD CONSTRAINT "StreamKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
