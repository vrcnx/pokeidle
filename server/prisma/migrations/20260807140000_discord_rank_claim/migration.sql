-- How far up the Discord rank ladder an account has been paid.
--
-- The two keys ARE the anti-farm mechanism, so they are constraints rather
-- than checks in application code:
--   * discordId as the primary key stops one Discord account claiming twice.
--   * the unique index on userId stops one game account being paid by a
--     second Discord account after an unlink/relink.
--
-- discordId is deliberately NOT a foreign key to "DiscordLink": that row is
-- deleted by /unlink, and this claim has to outlive it or the whole guard
-- evaporates on the first unlink.
CREATE TABLE "DiscordRankClaim" (
    "discordId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paidTier" INTEGER NOT NULL DEFAULT 0,
    "paidAtRank" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordRankClaim_pkey" PRIMARY KEY ("discordId")
);

CREATE UNIQUE INDEX "DiscordRankClaim_userId_key" ON "DiscordRankClaim"("userId");

ALTER TABLE "DiscordRankClaim" ADD CONSTRAINT "DiscordRankClaim_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
