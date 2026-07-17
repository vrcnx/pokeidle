-- CreateTable
-- Purely additive: one new table for the pinned server-wide banner.
-- No existing table is touched. IF NOT EXISTS keeps it idempotent so a
-- partial/rerun apply cannot fail the deploy.
CREATE TABLE IF NOT EXISTS "Announcement" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "href" TEXT,
    "linkLabel" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Announcement_active_createdAt_idx" ON "Announcement" ("active", "createdAt");
