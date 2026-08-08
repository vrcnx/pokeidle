-- The Reddit post reward.
--
-- The two unique constraints ARE the anti-farm mechanism, because nothing
-- verifies the link itself (a deliberate product call — see the model comment
-- in schema.prisma). They are constraints rather than application checks so a
-- race cannot get between them:
--   * userId as the primary key  → one claim per account, ever
--   * unique urlKey              → one claim per link, so a hundred accounts
--                                  cannot paste the same URL
CREATE TABLE "RedditPost" (
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "urlKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedditPost_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "RedditPost_urlKey_key" ON "RedditPost"("urlKey");
CREATE INDEX "RedditPost_createdAt_idx" ON "RedditPost"("createdAt");
CREATE INDEX "RedditPost_status_idx" ON "RedditPost"("status");

ALTER TABLE "RedditPost" ADD CONSTRAINT "RedditPost_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Off by default. Referrals are self-limiting — somebody has to create an
-- account for a payout. This one pays for a text box, so an operator turns it
-- on knowingly rather than discovering it is already running.
CREATE TABLE "RedditRewardConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "prizes" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedditRewardConfig_pkey" PRIMARY KEY ("id")
);
