#!/usr/bin/env tsx
// Bug-report triage CLI.
//
//   pnpm tsx scripts/bugs.ts list [statuses]      # default: open,investigating
//   pnpm tsx scripts/bugs.ts show <id>            # full report incl. context blob
//   pnpm tsx scripts/bugs.ts set <id> <status> [adminNotes]
//
// Lives outside the HTTP API so the maintainer can pull + triage
// without needing a logged-in admin session — useful for batched
// fix-up passes from the dev box, and for letting an automated
// agent enumerate work without going through Better Auth.

import { prisma } from "../src/db.js";

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "--help") {
    printUsage();
    return;
  }

  if (cmd === "list") {
    const arg = process.argv[3] ?? "open,investigating";
    const statuses = arg.split(",").map((s) => s.trim()).filter(Boolean);
    const rows = await prisma.bugReport.findMany({
      where: { status: { in: statuses } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        reporterName: true,
        title: true,
        description: true,
        page: true,
        status: true,
        adminNotes: true,
        createdAt: true,
      },
    });
    // JSON output keeps this script consumable by a workflow / jq.
    console.log(JSON.stringify({ count: rows.length, statuses, bugs: rows }, null, 2));
    return;
  }

  if (cmd === "show") {
    const id = process.argv[3];
    if (!id) throw new Error("Usage: bugs.ts show <id>");
    const row = await prisma.bugReport.findUnique({ where: { id } });
    if (!row) {
      console.error(`No bug report with id ${id}`);
      process.exit(2);
    }
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  if (cmd === "set") {
    const id = process.argv[3];
    const status = process.argv[4];
    const adminNotes = process.argv.slice(5).join(" ") || undefined;
    if (!id || !status) throw new Error("Usage: bugs.ts set <id> <status> [adminNotes]");
    const allowed = ["open", "investigating", "resolved", "wontfix"];
    if (!allowed.includes(status)) {
      throw new Error(`status must be one of: ${allowed.join(", ")}`);
    }
    const next = await prisma.bugReport.update({
      where: { id },
      data: {
        status,
        ...(adminNotes ? { adminNotes } : {}),
      },
      select: { id: true, status: true, adminNotes: true, updatedAt: true },
    });
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (cmd === "counts") {
    const grouped = await prisma.bugReport.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const out = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.error(`Bug-report triage CLI

  tsx scripts/bugs.ts list [statuses]
      Default statuses: open,investigating. Comma-separated.

  tsx scripts/bugs.ts show <id>
      Full report including context JSON blob (party snapshot, page,
      userAgent, last battle-log lines if attached).

  tsx scripts/bugs.ts set <id> <status> [adminNotes]
      Status must be: open | investigating | resolved | wontfix.

  tsx scripts/bugs.ts counts
      Group-by status with totals.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
