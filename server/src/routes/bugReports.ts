import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { recordError } from "../lib/errorReporting.js";
import { randomBytes } from "node:crypto";

const app = new Hono();

// 5 reports per user per hour — generous for a real bug-finder, low
// enough that a spammer can't fill the table.
const bugReportLimiter = makeRateLimiter({ tokens: 5, windowMs: 60 * 60_000 });
// Client errors can come in bursts (one render → many cascading
// errors), so allow more headroom than bug reports. Keyed by user.
const clientErrorLimiter = makeRateLimiter({ tokens: 30, windowMs: 60_000 });

// ── User-submitted bug report ────────────────────────────────────────────
const ReportBody = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(4000),
  page: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  context: z.string().max(20_000).optional(), // JSON-encoded snapshot, capped
});

app.post("/", requireUser, async (c) => {
  const user = c.get("user");
  if (!bugReportLimiter.consume(user.id)) {
    return c.json({ error: "rate_limited", retryAfter: 3600 }, 429);
  }
  const parsed = ReportBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
  }
  const id = "br_" + randomBytes(9).toString("hex");
  const { title, description, page, userAgent, context } = parsed.data;
  // Raw SQL because Prisma codegen for new models can lag locally; the
  // table itself is in sync via `prisma db push` on Railway boot.
  await prisma.$executeRaw`
    INSERT INTO "BugReport"
      ("id","reporterId","reporterName","title","description","page","userAgent","context","status","createdAt","updatedAt")
    VALUES
      (${id}, ${user.id}, ${user.username}, ${title}, ${description},
       ${page ?? null}, ${userAgent ?? null}, ${context ?? null},
       'open', NOW(), NOW())
  `;
  return c.json({ ok: true, id });
});

// ── Client-side error stream ─────────────────────────────────────────────
// Browser ErrorBoundary / window error handlers POST here. Capped /
// rate-limited because a runaway error loop on a buggy page could fire
// thousands per minute.
const ClientErrorBody = z.object({
  message: z.string().trim().min(1).max(2000),
  stack: z.string().max(20_000).optional(),
  source: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

app.post("/client-error", requireUser, async (c) => {
  const user = c.get("user");
  if (!clientErrorLimiter.consume(user.id)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const parsed = ClientErrorBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid body" }, 400);
  }
  await recordError({
    kind: "client",
    message: parsed.data.message,
    stack: parsed.data.stack ?? null,
    source: parsed.data.source ?? null,
    userId: user.id,
    username: user.username,
    userAgent: parsed.data.userAgent ?? null,
    meta: parsed.data.meta ?? null,
  });
  return c.json({ ok: true });
});

export default app;
