#!/usr/bin/env tsx
// Creates the DailyActive table, additively and idempotently.
//
// Why not `prisma db push`: this repo has no migrations directory, so
// db push is the normal workflow — but it diffs the WHOLE schema against
// the database and will happily drop columns/tables it thinks are drift.
// Running that against production to add one table is a bad trade. This
// script issues exactly the DDL required, with IF NOT EXISTS, so it is
// safe to run repeatedly and cannot touch anything else.
//
//   npx tsx scripts/ensure-daily-active.ts
//
// Safe to run before or after deploying the code: lib/presence.ts
// degrades to a no-op (with one warning) while the table is absent.

import { prisma } from "../src/db.js";

async function main() {
  console.log("Ensuring DailyActive table…");

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DailyActive" (
      "id"     TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "day"    TIMESTAMP(3) NOT NULL,
      CONSTRAINT "DailyActive_pkey" PRIMARY KEY ("id")
    )
  `);

  // Idempotency of the per-day write depends on this unique index.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DailyActive_userId_day_key"
      ON "DailyActive" ("userId", "day")
  `);

  // The analytics group-by is always over a day range.
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DailyActive_day_idx"
      ON "DailyActive" ("day")
  `);

  // Cascade so deleting a user cleans up their activity rows. Added
  // separately and tolerantly: if the constraint already exists,
  // Postgres errors, and that is a success case for this script.
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "DailyActive"
        ADD CONSTRAINT "DailyActive_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    `);
    console.log("  + added FK constraint");
  } catch (e) {
    if (/already exists/i.test(String(e))) {
      console.log("  = FK constraint already present");
    } else {
      throw e;
    }
  }

  const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "DailyActive"`
  );
  console.log(`Done. DailyActive has ${count} row(s).`);
  console.log(
    "\nNote: this table only records activity from the moment it exists.\n" +
    "Historical DAU cannot be reconstructed — User.lastSeenAt only ever\n" +
    "held each player's most recent visit. The dashboard reports the\n" +
    "collection start date rather than implying it has 30 days of history."
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
