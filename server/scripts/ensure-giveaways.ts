#!/usr/bin/env tsx
// Creates the Giveaway + GiveawayEntry tables, additively and
// idempotently. Same reasoning as scripts/ensure-daily-active.ts: this
// repo has no migrations dir, so `prisma db push` would diff the whole
// schema against production and drop whatever it considers drift.
// Adding two tables does not justify that risk.
//
//   npx tsx scripts/ensure-giveaways.ts
//
// Safe to run repeatedly. Safe to run before or after deploying the
// code — the giveaway routes surface a clear error while the tables are
// absent rather than 500ing.

import { prisma } from "../src/db.js";

async function main() {
  console.log("Ensuring Giveaway tables…");

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Giveaway" (
      "id"              TEXT NOT NULL,
      "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "startsAt"        TIMESTAMP(3),
      "endsAt"          TIMESTAMP(3),
      "drawnAt"         TIMESTAMP(3),
      "title"           TEXT NOT NULL,
      "description"     TEXT NOT NULL,
      "status"          TEXT NOT NULL DEFAULT 'draft',
      "winnerCount"     INTEGER NOT NULL DEFAULT 1,
      "prizes"          TEXT NOT NULL,
      "minAccountLevel" INTEGER,
      "drawSeed"        TEXT,
      "ownerId"         TEXT NOT NULL,
      CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Giveaway_status_createdAt_idx"
      ON "Giveaway" ("status", "createdAt")
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GiveawayEntry" (
      "id"         TEXT NOT NULL,
      "giveawayId" TEXT NOT NULL,
      "userId"     TEXT NOT NULL,
      "username"   TEXT NOT NULL,
      "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "isWinner"   BOOLEAN NOT NULL DEFAULT false,
      "claimedAt"  TIMESTAMP(3),
      CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("id")
    )
  `);
  // This unique is what makes it a fair draw rather than a spam contest.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "GiveawayEntry_giveawayId_userId_key"
      ON "GiveawayEntry" ("giveawayId", "userId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "GiveawayEntry_giveawayId_isWinner_idx"
      ON "GiveawayEntry" ("giveawayId", "isWinner")
  `);

  for (const [name, sql] of [
    ["GiveawayEntry -> Giveaway", `
      ALTER TABLE "GiveawayEntry"
        ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey"
        FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id")
        ON DELETE CASCADE ON UPDATE CASCADE`],
    ["GiveawayEntry -> User", `
      ALTER TABLE "GiveawayEntry"
        ADD CONSTRAINT "GiveawayEntry_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE`],
  ] as const) {
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log(`  + FK ${name}`);
    } catch (e) {
      if (/already exists/i.test(String(e))) console.log(`  = FK ${name} already present`);
      else throw e;
    }
  }

  const [g] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "Giveaway"`
  );
  const [e] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "GiveawayEntry"`
  );
  console.log(`Done. Giveaway: ${g.count} row(s), GiveawayEntry: ${e.count} row(s).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
