-- CreateTable
-- Additive: two new tables for admin-created chat polls. No existing
-- table is touched. IF NOT EXISTS keeps a rerun/partial apply from
-- failing the deploy.
CREATE TABLE IF NOT EXISTS "Poll" (
    "id"        TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"  TIMESTAMP(3),
    "question"  TEXT NOT NULL,
    "options"   TEXT NOT NULL,
    "status"    TEXT NOT NULL DEFAULT 'draft',
    "ownerId"   TEXT NOT NULL,

    CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PollVote" (
    "id"          TEXT NOT NULL,
    "pollId"      TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "username"    TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Poll_status_createdAt_idx" ON "Poll" ("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "PollVote_pollId_userId_key" ON "PollVote" ("pollId", "userId");
CREATE INDEX IF NOT EXISTS "PollVote_pollId_optionIndex_idx" ON "PollVote" ("pollId", "optionIndex");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "PollVote"
    ADD CONSTRAINT "PollVote_pollId_fkey"
    FOREIGN KEY ("pollId") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PollVote"
    ADD CONSTRAINT "PollVote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
