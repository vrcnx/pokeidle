import { prisma } from "../db.js";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";
import { notifyErrorEvent } from "./alerting.js";

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
  // dashboard can query the same event later. `meta` is included here on
  // purpose: it used to be dropped from this line, so when the DB insert
  // below failed (or the event never reached the DB at all in dev) the
  // context — the battle id, the user, the simulator's own message — was
  // gone everywhere. The log line is the fallback store; it must carry
  // everything the row would have.
  logger[level === "warn" ? "warn" : "error"](input.message, {
    kind: input.kind,
    source: input.source ?? null,
    userId: input.userId ?? null,
    username: input.username ?? null,
    stack: input.stack ?? null,
    ...(input.meta ? { meta: input.meta } : {}),
  });
  // Threshold alerting (lib/alerting.ts). No-op unless ALERT_WEBHOOK_URL is
  // set. Deliberately BEFORE the NODE_ENV gate below — whether alerts fire
  // is decided by the webhook env var, not by which environment we're in —
  // and wrapped so alerting can never break error recording.
  try {
    notifyErrorEvent({
      message: input.message,
      kind: input.kind,
      level,
      source: input.source ?? null,
      meta: input.meta ?? null,
    });
  } catch { /* alerting is best-effort by contract */ }
  // server/.env's DATABASE_URL points at the live production database even
  // for local dev (so admin scripts/dev servers can read real data), which
  // means a local `tsx watch` crash (e.g. EADDRINUSE from restarting while
  // an old instance still holds the port) used to get written straight into
  // the PRODUCTION ErrorLog table right alongside real player errors.
  // Console logging above already gives the local operator full visibility;
  // only persist to the shared table when actually running on Railway.
  if (process.env.NODE_ENV !== "production") return;
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
    // If the DB itself is unhappy, log + drop — never let logging break the
    // request path. But drop the ROW, not the CONTEXT: this line used to
    // carry only the insert error, so a failed insert silently destroyed the
    // event it was trying to record. Echo the full event so the structured
    // log remains a complete fallback store.
    logger.error("[errorReporting] failed to persist", {
      err: String(e),
      event: {
        id,
        kind: input.kind,
        level,
        message: input.message,
        source: input.source ?? null,
        userId: input.userId ?? null,
        username: input.username ?? null,
        stack: input.stack ?? null,
        meta: input.meta ?? null,
      },
    });
  }
}
