-- CreateTable
CREATE TABLE "DailyActive" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyActive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "username" TEXT NOT NULL,
    "displayUsername" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "saveData" TEXT,
    "saveVersion" INTEGER NOT NULL DEFAULT 0,
    "saveUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountLevel" INTEGER NOT NULL DEFAULT 0,
    "totalCaughtLevels" INTEGER NOT NULL DEFAULT 0,
    "pokedexCaughtCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "bannedUntil" TIMESTAMP(3),
    "banReason" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friend" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapPosition" (
    "locationId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "MapPosition_pkey" PRIMARY KEY ("locationId")
);

-- CreateTable
CREATE TABLE "MapCrop" (
    "regionId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "MapCrop_pkey" PRIMARY KEY ("regionId")
);

-- CreateTable
CREATE TABLE "BugReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT,
    "reporterName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "page" TEXT,
    "userAgent" TEXT,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BugReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'error',
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "source" TEXT,
    "userId" TEXT,
    "username" TEXT,
    "userAgent" TEXT,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PvpMatch" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userAUsername" TEXT NOT NULL,
    "userATeam" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "userBUsername" TEXT NOT NULL,
    "userBTeam" TEXT NOT NULL,
    "winnerId" TEXT,
    "loserId" TEXT,
    "endReason" TEXT,
    "battleLog" TEXT,
    "tournamentId" TEXT,

    CONSTRAINT "PvpMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "drawnAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "winnerCount" INTEGER NOT NULL DEFAULT 1,
    "prizes" TEXT NOT NULL,
    "minAccountLevel" INTEGER,
    "drawSeed" TEXT,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayEntry" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isWinner" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "levelCap" INTEGER,
    "status" TEXT NOT NULL,
    "bracket" TEXT,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentEntry" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "seed" INTEGER,
    "eliminated" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerRating" (
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 1000,
    "peakRating" INTEGER NOT NULL DEFAULT 1000,
    "matchesPlayed" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "forfeits" INTEGER NOT NULL DEFAULT 0,
    "lastMatchAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerRating_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "TradeRecord" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAId" TEXT NOT NULL,
    "userAUsername" TEXT NOT NULL,
    "userASentMon" TEXT NOT NULL,
    "userASentSpecies" TEXT NOT NULL,
    "userASentLevel" INTEGER NOT NULL,
    "userBId" TEXT NOT NULL,
    "userBUsername" TEXT NOT NULL,
    "userBSentMon" TEXT NOT NULL,
    "userBSentSpecies" TEXT NOT NULL,
    "userBSentLevel" INTEGER NOT NULL,

    CONSTRAINT "TradeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyActive_day_idx" ON "DailyActive"("day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyActive_userId_day_key" ON "DailyActive"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "Friend_receiverId_status_idx" ON "Friend"("receiverId", "status");

-- CreateIndex
CREATE INDEX "Friend_requesterId_status_idx" ON "Friend"("requesterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Friend_requesterId_receiverId_key" ON "Friend"("requesterId", "receiverId");

-- CreateIndex
CREATE INDEX "BugReport_status_createdAt_idx" ON "BugReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BugReport_reporterId_idx" ON "BugReport"("reporterId");

-- CreateIndex
CREATE INDEX "ErrorLog_kind_createdAt_idx" ON "ErrorLog"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_userId_createdAt_idx" ON "ErrorLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_adminId_createdAt_idx" ON "AdminAudit"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_targetId_createdAt_idx" ON "AdminAudit"("targetId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_channelId_createdAt_idx" ON "ChatMessage"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "PvpMatch_userAId_createdAt_idx" ON "PvpMatch"("userAId", "createdAt");

-- CreateIndex
CREATE INDEX "PvpMatch_userBId_createdAt_idx" ON "PvpMatch"("userBId", "createdAt");

-- CreateIndex
CREATE INDEX "PvpMatch_tournamentId_idx" ON "PvpMatch"("tournamentId");

-- CreateIndex
CREATE INDEX "Giveaway_status_createdAt_idx" ON "Giveaway"("status", "createdAt");

-- CreateIndex
CREATE INDEX "GiveawayEntry_giveawayId_isWinner_idx" ON "GiveawayEntry"("giveawayId", "isWinner");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayEntry_giveawayId_userId_key" ON "GiveawayEntry"("giveawayId", "userId");

-- CreateIndex
CREATE INDEX "Tournament_status_createdAt_idx" ON "Tournament"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TournamentEntry_tournamentId_eliminated_idx" ON "TournamentEntry"("tournamentId", "eliminated");

-- CreateIndex
CREATE INDEX "TournamentEntry_userId_idx" ON "TournamentEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentEntry_tournamentId_userId_key" ON "TournamentEntry"("tournamentId", "userId");

-- CreateIndex
CREATE INDEX "PlayerRating_rating_idx" ON "PlayerRating"("rating");

-- CreateIndex
CREATE INDEX "TradeRecord_userAId_createdAt_idx" ON "TradeRecord"("userAId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeRecord_userBId_createdAt_idx" ON "TradeRecord"("userBId", "createdAt");

-- AddForeignKey
ALTER TABLE "DailyActive" ADD CONSTRAINT "DailyActive_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

