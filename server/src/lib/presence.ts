import { prisma } from "../db.js";
import { randomBytes } from "node:crypto";

// Daily-active tracking — the event log that makes real DAU possible.
//
// `User.lastSeenAt` is a scalar overwritten on every connect. Bucketing
// it by day answers "how many players were last seen on day X", which
// is a churn distribution that must slope upward toward today no matter
// how the game is doing. It was shipped as the hero "Daily Active"
// chart. Activity is an event; events need rows.
//
// Raw SQL rather than prisma.dailyActive.* for the same reason as
// lib/audit.ts: the Prisma client codegen locks the query-engine DLL on
// Windows while the dev server runs, so a freshly-added model is not in
// the generated types until the next clean deploy. The table itself is
// created by scripts/ensure-daily-active.ts.

// Fire-and-forget: presence must never be able to fail a socket
// connection. If the table is missing (code deployed ahead of the
// migration) we log once and degrade to no-op rather than throwing on
// every connect.
let warnedMissingTable = false;

export async function recordDailyActive(userId: string): Promise<void> {
  // UTC midnight of today. Matching the analytics bucket boundaries
  // exactly matters: mixing a rolling 24h window with calendar-day
  // buckets is what made the old hero delta meaningless.
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const id = "da_" + randomBytes(9).toString("hex");

  try {
    // ON CONFLICT DO NOTHING makes this idempotent per (user, day) —
    // a player who reconnects 40 times today still produces one row.
    await prisma.$executeRaw`
      INSERT INTO "DailyActive" ("id", "userId", "day")
      VALUES (${id}, ${userId}, ${day})
      ON CONFLICT ("userId", "day") DO NOTHING
    `;
  } catch (e) {
    const msg = String(e);
    if (/does not exist|no such table/i.test(msg)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.error(
          "[presence] DailyActive table is missing — DAU will not be recorded. " +
          "Run: npx tsx scripts/ensure-daily-active.ts"
        );
      }
      return;
    }
    console.error("[presence] failed to record daily active", { userId, err: msg });
  }
}
