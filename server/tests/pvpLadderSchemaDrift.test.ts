// The ladder migration and schema.prisma must keep telling the same story.
//
// ── THE DEFECT THIS FILE EXISTS TO PREVENT ───────────────────────────
// The migration carries objects Prisma cannot express, and the two behave very
// differently from each other:
//
//   * CHECK CONSTRAINTS are INVISIBLE to Prisma. It has no syntax for them and
//     its introspection does not see them, so `prisma migrate dev` will neither
//     recreate nor DROP them. They are safe to keep in raw SQL — but nothing in
//     schema.prisma would tell a reader they exist, and nobody debugging a 23514
//     reads migration files first. So schema.prisma carries a RAW-SQL-ONLY block
//     listing them, and this file asserts the list and the SQL agree.
//
//   * A PARTIAL UNIQUE INDEX is NOT safe. Prisma DOES introspect indexes and
//     cannot express a WHERE clause, so `npm run db:migrate` (= prisma migrate
//     dev) can generate a DROP for one. An earlier version of this migration
//     carried `UNIQUE ("userId","day") WHERE "firstWinOfDay"` and called it a
//     "fail-closed second opinion" that "cannot be dropped by a later migration
//     under the additive-only policy". That was a convention, not a mechanism.
//     It is gone; the invariant is now held by a CHECK plus a single-row arbiter
//     table, and this file fails if a partial index ever comes back.
//
// Also enforced here: the migration stays ADDITIVE. No DROP, no ALTER of an
// existing table, no UPDATE/DELETE backfill — the rules the deploy relies on.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(here, "../prisma/migrations/20260730120000_add_pvp_ladder/migration.sql"),
  "utf8",
);
const SCHEMA = readFileSync(resolve(here, "../prisma/schema.prisma"), "utf8");

/**
 * Every migration`s SQL, concatenated.
 *
 * The RAW-SQL-ONLY block in schema.prisma is a registry of the WHOLE
 * database`s invisible constraints, not the ladder`s alone — a reader
 * debugging a 23514 looks there whatever table threw it. So the "documented
 * but never created" check below has to look at every migration, or adding a
 * CHECK in a later one would force a choice between leaving it undocumented
 * and failing a test about a different feature.
 */
const ALL_MIGRATIONS = readdirSync(resolve(here, "../prisma/migrations"))
  .filter((d) => !d.includes("."))
  .map((d) => {
    try {
      return readFileSync(resolve(here, "../prisma/migrations", d, "migration.sql"), "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

/** The migration with every `--` comment line removed. The comments deliberately
 *  discuss the objects that were REMOVED (PvpDailyFirstWin, the firstWinOfDay
 *  partial index) and why, because that history is the reason the current shape
 *  is what it is. Assertions about what the migration DOES must therefore look
 *  at the executable statements only. */
const SQL = MIGRATION
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

/** Every CHECK constraint the migration creates, and the exact text the
 *  RAW-SQL-ONLY block in schema.prisma must carry for each. */
const CHECKS: { name: string; predicate: string }[] = [
  { name: "PvpLadderEarn_not_self", predicate: `"userId" <> "opponentUserId"` },
  { name: "PvpLadderEarn_nonneg", predicate: `"bp" >= 0 AND "milestoneBp" >= 0 AND "moneyAwarded" >= 0` },
  { name: "PvpLadderEarn_money_needs_bonus", predicate: `"moneyAwarded" = 0 OR "winBonusPaid"` },
  { name: "PvpWinBonusClaim_nonneg", predicate: `"money" >= 0` },
  { name: "PvpBadgeMilestone_nonneg", predicate: `"bp" >= 0` },
  { name: "PvpBadgeMilestone_crossed", predicate: `"ratingBefore" < "threshold"` },
];

describe("the ladder migration stays additive", () => {
  it("creates only the three new tables", () => {
    const created = [...MIGRATION.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((m) => m[1]);
    expect(created.sort()).toEqual(["PvpBadgeMilestone", "PvpLadderEarn", "PvpWinBonusClaim"]);
  });

  it("uses IF NOT EXISTS on every CREATE, so a rerun is a no-op", () => {
    const creates = [...MIGRATION.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\b.*$/gim)];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c[0]).toContain("IF NOT EXISTS");
  });

  it("contains no DROP, no ALTER and no backfill", () => {
    // Comments legitimately discuss the word DROP, so strip them first.
    const sql = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(/\bDROP\b/i.test(sql)).toBe(false);
    expect(/\bALTER\s+TABLE\b/i.test(sql)).toBe(false);
    expect(/^\s*UPDATE\b/im.test(sql)).toBe(false);
    expect(/^\s*DELETE\b/im.test(sql)).toBe(false);
    expect(/^\s*INSERT\b/im.test(sql)).toBe(false);
  });

  it("touches no existing table — User is referenced only as an FK target", () => {
    const sql = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const m of sql.matchAll(/"User"/g)) {
      const line = sql.slice(0, m.index).split("\n").pop() ?? "";
      expect(line).toContain("REFERENCES");
    }
    // PlayerRating is left completely alone so there is no conflict with the
    // concurrent PvP work.
    expect(sql.includes('"PlayerRating"')).toBe(false);
  });
});

describe("no partial index — the object prisma migrate dev could DROP", () => {
  it("creates no index with a WHERE clause", () => {
    const sql = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    const indexes = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX[^;]*;/gi)].map((m) => m[0]);
    expect(indexes.length).toBeGreaterThan(0);
    for (const idx of indexes) expect(/\bWHERE\b/i.test(idx)).toBe(false);
  });

  it("does not resurrect the firstWinOfDay partial unique index", () => {
    // Executable statements only: the comments SHOULD still explain what was
    // removed and why, so that it is not re-added as an improvement.
    expect(SQL).not.toContain("firstWinOfDay");
    expect(SQL).not.toContain("PvpLadderEarn_firstwin_per_day_key");
    // …but the reasoning survives in a comment, so it is not re-added as an
    // improvement by the next person to read "fail-closed second opinion".
    expect(MIGRATION).toContain("PARTIAL unique index is NOT safe");
  });

  it("keeps every index in the migration expressible in schema.prisma", () => {
    // Each plain index in the SQL has a matching @@index / @@unique so Prisma's
    // view of the database really is accurate — which is the claim that failed
    // last time.
    const sql = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "PvpLadderEarn_matchId_userId_key"');
    expect(SCHEMA).toContain("@@unique([matchId, userId])");
    expect(sql).toContain('"PvpLadderEarn_userId_createdAt_idx"');
    expect(SCHEMA).toContain("@@index([userId, createdAt])");
    expect(sql).toContain('"PvpLadderEarn_userId_opponent_createdAt_idx"');
    expect(SCHEMA).toContain("@@index([userId, opponentUserId, createdAt])");
    expect(sql).toContain('"PvpWinBonusClaim_claimedAt_idx"');
    expect(SCHEMA).toContain("@@index([claimedAt])");
  });
});

describe("schema.prisma documents what Prisma cannot see", () => {
  it("carries the RAW-SQL-ONLY block", () => {
    expect(SCHEMA).toContain("RAW-SQL-ONLY OBJECTS");
  });

  for (const c of CHECKS) {
    it(`declares ${c.name} in BOTH the migration and the schema note`, () => {
      expect(MIGRATION).toContain(c.name);
      expect(MIGRATION).toContain(c.predicate);
      expect(SCHEMA).toContain(c.name);
      expect(SCHEMA).toContain(c.predicate);
    });
  }

  it("lists no CHECK in the schema note that no migration creates", () => {
    // The registry must not accumulate constraints that do not exist. Scanned
    // across every migration so a CHECK added by a later feature can be
    // documented here without failing a test about the ladder.
    const noteChecks = [...SCHEMA.matchAll(/^\/\/\s+CHECK\s+(\w+)/gm)].map((m) => m[1]);
    expect(noteChecks.length).toBeGreaterThanOrEqual(CHECKS.length);
    for (const name of noteChecks) {
      expect(ALL_MIGRATIONS, `${name} is documented but never created`).toContain(name);
    }
  });

  it("documents every CHECK any migration creates", () => {
    // The other direction: a constraint that exists but is not in the registry
    // is exactly the 23514 nobody can explain.
    const created = [...ALL_MIGRATIONS.matchAll(/ADD CONSTRAINT "(\w+)" CHECK/g)].map((m) => m[1]);
    const noteChecks = new Set([...SCHEMA.matchAll(/^\/\/\s+CHECK\s+(\w+)/gm)].map((m) => m[1]));
    for (const name of new Set(created)) {
      expect(noteChecks.has(name), `${name} exists but is not in the RAW-SQL-ONLY block`).toBe(true);
    }
  });

  it("explains WHY there is no partial index, so it is not re-added as an improvement", () => {
    expect(SCHEMA).toContain("There is deliberately NO partial unique index");
    expect(SCHEMA).toContain("prisma migrate dev` would generate a");
  });
});

describe("the schema models match the columns the settle actually writes", () => {
  // A column the code writes but the model lacks means Prisma's next generated
  // migration would try to remove it, which is how additive-only policies decay.
  const EARN_COLUMNS = [
    "matchId", "userId", "opponentUserId", "day", "provenance", "result", "endReason",
    "turns", "durationMs", "ratingBefore", "ratingAfter", "ratingDelta",
    "meetingIndex", "bpBeforeDecay", "tier", "bp", "milestoneBp", "moneyAwarded",
    "winBonusPaid", "grantId", "createdAt",
  ];

  it("has every PvpLadderEarn column in the migration and in the model", () => {
    const model = SCHEMA.slice(SCHEMA.indexOf("model PvpLadderEarn"));
    const body = model.slice(0, model.indexOf("\n}"));
    for (const col of EARN_COLUMNS) {
      expect(MIGRATION, col).toContain(`"${col}"`);
      expect(body, col).toContain(col);
    }
  });

  it("has the win-bonus arbiter keyed on userId ALONE, not on a calendar day", () => {
    // The straddle fix, asserted at the schema level: a (userId, day) key is
    // satisfiable twice by two different day values.
    expect(SQL).toContain('CONSTRAINT "PvpWinBonusClaim_pkey" PRIMARY KEY ("userId")');
    // No day-keyed arbiter table survives in either executable file.
    expect(SQL).not.toContain("PvpDailyFirstWin");
    expect(SCHEMA).not.toContain("model PvpDailyFirstWin");
    expect(SCHEMA).not.toContain("PvpDailyFirstWin[]");
    const model = SCHEMA.slice(SCHEMA.indexOf("model PvpWinBonusClaim"));
    expect(model.slice(0, model.indexOf("\n}"))).toContain("userId String @id");
  });

  it("keeps the milestone crossing evidence, both column and constraint", () => {
    expect(SQL).toContain('"ratingBefore"');
    expect(SQL).toContain('CONSTRAINT "PvpBadgeMilestone_crossed"');
    const model = SCHEMA.slice(SCHEMA.indexOf("model PvpBadgeMilestone"));
    expect(model.slice(0, model.indexOf("\n}"))).toContain("ratingBefore");
  });
});
