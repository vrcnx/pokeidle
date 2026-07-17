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
// per unique (kind, message) with count, latestAt, sample source/stack.

import { prisma } from "../src/db.js";

function arg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "--help") { printUsage(); return; }

  if (cmd === "groups") {
    const kind  = arg("--kind"); // "server" | "client" | undefined = both
    const days  = parseInt(arg("--days", "14") ?? "14", 10);
    const limit = parseInt(arg("--limit", "50") ?? "50", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.errorLog.groupBy({
      by: ["kind", "message"],
      where: {
        createdAt: { gte: since },
        ...(kind ? { kind } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { message: "desc" } },
      take: limit,
    });

    // Enrich each group with one sample row so downstream triage has
    // a stack + source + userId to work from.
    const enriched = await Promise.all(rows.map(async (g) => {
      const sample = await prisma.errorLog.findFirst({
        where: { kind: g.kind, message: g.message },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, source: true, stack: true, userAgent: true,
          userId: true, username: true, meta: true, level: true,
        },
      });
      return {
        kind:       g.kind,
        message:    g.message,
        count:      g._count._all,
        latestAt:   g._max.createdAt,
        sample,
      };
    }));

    console.log(JSON.stringify({ sinceDays: days, kind: kind ?? "all", count: enriched.length, groups: enriched }, null, 2));
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

  // Clear every row for an exact (kind, message). Once a bug is really
  // fixed its history is noise: it buries live problems and inflates the
  // dashboard error KPI forever. --dry-run first, always.
  if (cmd === "clear") {
    const kind = arg("--kind");
    const contains = arg("--message");
    const dry = process.argv.includes("--dry-run");
    if (!kind || !contains) {
      throw new Error(`Usage: errors.ts clear --kind client|server --message "<substring>" [--dry-run]`);
    }
    if (kind !== "client" && kind !== "server") throw new Error("--kind must be client or server");

    // Resolve the substring to the exact messages it matches, and report
    // them, so a careless substring cannot silently nuke unrelated groups.
    const groups = await prisma.errorLog.groupBy({
      by: ["message"],
      where: { kind, message: { contains } },
      _count: { _all: true },
    });
    if (groups.length === 0) {
      console.log(JSON.stringify({ matched: 0, deleted: 0 }, null, 2));
      return;
    }
    const total = groups.reduce((n, g) => n + g._count._all, 0);
    console.log(`Matched ${groups.length} group(s), ${total} row(s):`);
    for (const g of groups) console.log(`  ${g._count._all.toString().padStart(5)} x ${g.message.slice(0, 78)}`);
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
      Group by (kind, message) with count + latest timestamp + one
      sample row. Default: both kinds, 14 days, top 50.

  tsx scripts/errors.ts show <messageContains>
      Sample up to 20 matching rows in full (stack, meta, source).

  tsx scripts/errors.ts recent [limit]
      Most-recent N rows (default 100), summary fields only.

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
