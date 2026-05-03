import { prisma } from "../db.js";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";

// Persist an error event into the ErrorLog table for admin review.
// Uses raw SQL because the running dev server can hold a lock on the
// Prisma query-engine DLL on Windows that blocks `prisma generate`
// (mirrors the workaround in lib/audit.ts). On a fresh Railway build
// the model is fully typed and we could swap to `prisma.errorLog.create`.
//
// Failure to log is non-fatal — we log to console instead so we don't
// turn a recoverable error into a 500. Bug-report submissions go
// through a separate path (lib/bugReports — direct prisma call once
// codegen is unblocked).

export type ErrorKind = "server" | "client";

interface ErrorLogInput {
  kind: ErrorKind;
  level?: "error" | "warn";
  message: string;
  stack?: string | null;
  source?: string | null;
  userId?: string | null;
  username?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function recordError(input: ErrorLogInput): Promise<void> {
  const id = "e_" + randomBytes(9).toString("hex");
  const level = input.level ?? "error";
  const metaJson = input.meta ? JSON.stringify(input.meta) : null;
  // Persist + structured log so live operators see it and the admin
  // dashboard can query the same event later.
  logger[level === "warn" ? "warn" : "error"](input.message, {
    kind: input.kind,
    source: input.source ?? null,
    userId: input.userId ?? null,
    username: input.username ?? null,
    stack: input.stack ?? null,
  });
  try {
    await prisma.$executeRaw`
      INSERT INTO "ErrorLog"
        ("id","kind","level","message","stack","source","userId","username","userAgent","meta","createdAt")
      VALUES
        (${id}, ${input.kind}, ${level}, ${input.message}, ${input.stack ?? null},
         ${input.source ?? null}, ${input.userId ?? null}, ${input.username ?? null},
         ${input.userAgent ?? null}, ${metaJson}, NOW())
    `;
  } catch (e) {
    // If the DB itself is unhappy, log + drop — never let logging
    // break the request path.
    logger.error("[errorReporting] failed to persist", { err: String(e) });
  }
}
