-- CreateTable
-- Additive: append-only save-history checkpoints. No existing table is
-- touched. IF NOT EXISTS keeps a rerun/partial apply from failing the deploy.
CREATE TABLE IF NOT EXISTS "SaveSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "saveVersion" INTEGER NOT NULL,
    "saveData" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaveSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SaveSnapshot_userId_createdAt_idx" ON "SaveSnapshot" ("userId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "SaveSnapshot"
    ADD CONSTRAINT "SaveSnapshot_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
