#!/usr/bin/env tsx
// Error-log triage CLI. Mirrors scripts/bugs.ts but pulls from
// ErrorLog. Not-writable via CLI intentionally — errors are captured
// automatically, so there's no manual status field to bump.
//
//   tsx scripts/errors.ts groups           # top messages by count (default: server+client, 14d)
//   tsx scripts/errors.ts groups --kind client --days 7
//   tsx scripts/errors.ts show <messageContains>  # sample of matching rows
//   tsx scripts/errors.ts recent [limit]   # most-recent N rows (default 100)
//
// The `groups` output is what a triage workflow consumes — one entry
// per FINGERPRINT (not raw message) with count, latestAt, sample
// source/stack. Grouping by the raw message would fragment one real
// error type into many groups whenever a message embeds instance data
// (a save version, a raw exception's dynamic text, an id) — see
// error_message_fingerprint() (migration 20260717050000), a Postgres
// function that collapses the obviously-variable parts of a message to
// stable placeholders before anything groups on it. Prisma's groupBy()
// can't group on a computed expression, so this is raw SQL.

import { prisma } from "../src/db.js";

function arg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}

interface GroupRow {
  kind: string;
  fingerprint: string;
  sampleMessage: string;
  count: bigint;
  latestAt: Date;
  sampleId: string;
  sampleLevel: string;
  sampleSource: string | null;
  sampleStack: string | null;
  sampleUserId: string | null;
  sampleUsername: string | null;
  sampleUserAgent: string | null;
}

// One query: fingerprint-normalize, count + pick the newest row per
// group via a window function, no per-group round trip. The old
// version did groupBy() then Promise.all(rows.map(findFirst)) — up to
// `limit`+1 concurrent connections for a single CLI invocation, which
// is a real way to help exhaust a Postgres instance near its
// max_connections ceiling.
async function fetchGroups(since: Date, kind: string | undefined, limit: number): Promise<GroupRow[]> {
  return prisma.$queryRaw<GroupRow[]>`
    WITH scored AS (
      SELECT
        "id", "kind", "level", "message", "stack", "source",
        "userId", "username", "userAgent", "createdAt",
        error_message_fingerprint("message") AS fingerprint,
        COUNT(*) OVER (PARTITION BY "kind", error_message_fingerprint("message")) AS "groupCount",
        MAX("createdAt") OVER (PARTITION BY "kind", error_message_fingerprint("message")) AS "groupLatestAt",
        ROW_NUMBER() OVER (
          PARTITION BY "kind", error_message_fingerprint("message")
          ORDER BY "createdAt" DESC
        ) AS rn
      FROM "ErrorLog"
      WHERE "createdAt" >= ${since}
        AND (${kind ?? null}::text IS NULL OR "kind" = ${kind ?? null})
    )
    SELECT
      "kind", fingerprint,
      "message"       AS "sampleMessage",
      "groupCount"    AS count,
      "groupLatestAt" AS "latestAt",
      "id"            AS "sampleId",
      "level"         AS "sampleLevel",
      "source"        AS "sampleSource",
      "stack"         AS "sampleStack",
      "userId"        AS "sampleUserId",
      "username"      AS "sampleUsername",
      "userAgent"     AS "sampleUserAgent"
    FROM scored
    WHERE rn = 1
    ORDER BY "groupCount" DESC
    LIMIT ${limit};
  `;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "--help") { printUsage(); return; }

  if (cmd === "groups") {
    const kind  = arg("--kind"); // "server" | "client" | undefined = both
    const days  = parseInt(arg("--days", "14") ?? "14", 10);
    const limit = parseInt(arg("--limit", "50") ?? "50", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await fetchGroups(since, kind, limit);
    const groups = rows.map((g) => ({
      kind: g.kind,
      fingerprint: g.fingerprint,
      message: g.sampleMessage,
      count: Number(g.count),
      latestAt: g.latestAt,
      sample: {
        id: g.sampleId, source: g.sampleSource, stack: g.sampleStack,
        userAgent: g.sampleUserAgent, userId: g.sampleUserId,
        username: g.sampleUsername, level: g.sampleLevel,
      },
    }));

    console.log(JSON.stringify({ sinceDays: days, kind: kind ?? "all", count: groups.length, groups }, null, 2));
    return;
  }

  if (cmd === "show") {
    const contains = process.argv[3];
    if (!contains) throw new Error("Usage: errors.ts show <messageContains>");
    const rows = await prisma.errorLog.findMany({
      where: { message: { contains } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
    return;
  }

  if (cmd === "recent") {
    const limit = Math.min(500, Math.max(1, parseInt(process.argv[3] ?? "100", 10)));
    const rows = await prisma.errorLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true, kind: true, level: true, message: true,
        source: true, userId: true, username: true, createdAt: true,
      },
    });
    console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
    return;
  }

  // Clear every row matching a (kind, message-substring). Once a bug is
  // really fixed its history is noise: it buries live problems and
  // inflates the dashboard error KPI forever. --dry-run first, always.
  //
  // This still matches by substring, not fingerprint — an operator
  // typing "MetaMask" wants to sweep every variant of that noise in one
  // go, which is a broader (and already fragmentation-proof) match mode
  // than the dashboard's per-group Resolve button. The preview below
  // rolls matches up by fingerprint purely so a fragmented group (like
  // the old "putSave 409 (localVersion=N)") shows as one summary line
  // instead of dozens, matching what deleteMany actually removes as a
  // unit.
  if (cmd === "clear") {
    const kind = arg("--kind");
    const contains = arg("--message");
    const dry = process.argv.includes("--dry-run");
    if (!kind || !contains) {
      throw new Error(`Usage: errors.ts clear --kind client|server --message "<substring>" [--dry-run]`);
    }
    if (kind !== "client" && kind !== "server") throw new Error("--kind must be client or server");

    const preview = await prisma.$queryRaw<{ fingerprint: string; sampleMessage: string; count: bigint }[]>`
      SELECT
        error_message_fingerprint("message") AS fingerprint,
        (array_agg("message" ORDER BY "createdAt" DESC))[1] AS "sampleMessage",
        COUNT(*) AS count
      FROM "ErrorLog"
      WHERE "kind" = ${kind} AND "message" ILIKE ${"%" + contains + "%"}
      GROUP BY fingerprint
      ORDER BY count DESC
    `;
    if (preview.length === 0) {
      console.log(JSON.stringify({ matched: 0, deleted: 0 }, null, 2));
      return;
    }
    const total = preview.reduce((n, g) => n + Number(g.count), 0);
    console.log(`Matched ${preview.length} group(s), ${total} row(s):`);
    for (const g of preview) console.log(`  ${Number(g.count).toString().padStart(5)} x ${g.sampleMessage.slice(0, 78)}`);
    if (dry) { console.log("\n--dry-run: nothing deleted."); return; }
    const res = await prisma.errorLog.deleteMany({ where: { kind, message: { contains } } });
    console.log(`\nDeleted ${res.count} row(s).`);
    return;
  }

  if (cmd === "counts") {
    const days = parseInt(arg("--days", "14") ?? "14", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const grouped = await prisma.errorLog.groupBy({
      by: ["kind"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    const out = Object.fromEntries(grouped.map((g) => [g.kind, g._count._all]));
    console.log(JSON.stringify({ sinceDays: days, ...out }, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.error(`Error-log triage CLI

  tsx scripts/errors.ts groups [--kind server|client] [--days N] [--limit N]
      Group by fingerprint (message with variable data normalized —
      ids, uuids, timestamps, digit runs — collapsed to placeholders)
      with count + latest timestamp + one real sample row. Default:
      both kinds, 14 days, top 50.

  tsx scripts/errors.ts show <messageContains>
      Sample up to 20 matching rows in full (stack, meta, source).

  tsx scripts/errors.ts recent [limit]
      Most-recent N rows (default 100), summary fields only.

  tsx scripts/errors.ts clear --kind client|server --message "<substring>" [--dry-run]
      Delete every row whose message contains the substring. Preview
      rolls matches up by fingerprint; --dry-run first, always.

  tsx scripts/errors.ts counts [--days N]
      Group-by kind totals over the last N days.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
