// Signup attribution capture.
//
// One endpoint. The game client remembers where the visitor first landed and
// posts it once, after the account exists.
//
// ── WHY THE CLIENT SENDS THIS AND NOT THE SERVER READING HEADERS ────
// The Referer header on the signup POST is our own site — by then the visitor
// has been through the landing page and the auth screen, and the header says
// "pokeidle.com". The only place the ORIGINAL referrer is knowable is the
// browser, at the moment of the first page load, which is why the client
// stashes it and hands it back.
//
// That makes the value player-supplied, so nothing here trusts it: it is
// normalised, length-capped, rate-limited, accepted only for an account
// minutes old, and accepted only once. The worst a determined player can do is
// mislabel their own signup in a dashboard.

import { Hono } from "hono";
import type { Context } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { ATTRIBUTION_WINDOW_MS, normalizeAttribution } from "../lib/acquisition.js";

const app = new Hono();

/** Generous — this fires once per account — but not unbounded, because the
 *  handler writes a row and anything that writes a row gets a limiter. */
const captureLimiter = makeRateLimiter({ tokens: 5, windowMs: 10 * 60_000 });

async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

// ── POST /api/attribution ───────────────────────────────────────────
// Fire-and-forget from the client. Always 200 with a flag rather than 4xx on
// the no-op paths: "you already have attribution" and "this account is too old"
// are both the system working correctly, and a client that retries on error
// would hammer the endpoint for a decision that will never change.
app.post("/", requireUser, async (c) => {
  const user = c.get("user");
  if (!captureLimiter.consume(`attr:${user.id}`)) {
    return c.json({ recorded: false, reason: "rate_limited" });
  }

  const body = await jsonObject(c);

  // The account must be new. Without this, a returning player who cleared
  // their storage would rewrite their own origin on the next visit, and the
  // acquisition numbers would slowly become a record of where existing
  // players re-enter from — a real metric, but not the one on the label.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { createdAt: true },
  });
  if (!row) return c.json({ recorded: false, reason: "no_user" });
  if (Date.now() - row.createdAt.getTime() > ATTRIBUTION_WINDOW_MS) {
    return c.json({ recorded: false, reason: "too_late" });
  }

  // Our own host, so a referrer from inside the site is not counted as a
  // referral. Derived from the request rather than configured: this server
  // answers on more than one hostname (apex, www, the Railway domain) and a
  // single env var would only ever match one of them.
  const selfHost = (() => {
    try { return new URL(c.req.url).hostname.replace(/^www\./, "").toLowerCase(); }
    catch { return null; }
  })();

  const norm = normalizeAttribution({
    referrer: str(body.referrer),
    landingPath: str(body.landingPath),
    utmSource: str(body.utmSource),
    utmMedium: str(body.utmMedium),
    utmCampaign: str(body.utmCampaign),
    utmTerm: str(body.utmTerm),
    utmContent: str(body.utmContent),
  }, selfHost);

  // Straight INSERT, no read-then-write. userId is the primary key, so the
  // database decides who wins a race and a duplicate is a normal outcome
  // rather than an error worth logging.
  try {
    await prisma.signupAttribution.create({ data: { userId: user.id, ...norm } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return c.json({ recorded: false, reason: "already_attributed" });
    }
    // A missing table (deploy ordering) must not break signup for anyone.
    // Attribution is a reporting nicety; the account is what matters.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2021") {
      return c.json({ recorded: false, reason: "not_ready" });
    }
    throw e;
  }

  return c.json({ recorded: true, channel: norm.channel });
});

export default app;
