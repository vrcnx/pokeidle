// Where the player stands on the level ladder.
//
// Read-only, and there is deliberately no claim endpoint. Tiers are paid by
// the save upload that observes the level (see lib/progression.ts), through
// the same PendingGrant inbox as every other reward. A claim endpoint would
// be a second way to pay the same tier, which is how a reward gets paid twice
// — the concern is not theoretical here, because the ladder is the one reward
// in the game whose trigger the player controls directly.

import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { getProgressionStatus } from "../lib/progression.js";

const app = new Hono();

/** Read-only and cheap, but it is one row plus a lookup, so it gets a
 *  limiter like everything else that touches the database. */
const limiter = makeRateLimiter({ tokens: 40, windowMs: 60_000 });

// ── GET /api/progression/me ─────────────────────────────────────────
app.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  if (!limiter.consume(`prog:${user.id}`)) {
    return c.json({ error: "Slow down a moment." }, 429);
  }
  // The level comes from the User row rather than the request, for the
  // obvious reason: it is the number the payouts are computed from, and a
  // client-supplied one would be a client-supplied reward.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { accountLevel: true },
  });
  return c.json(await getProgressionStatus(user.id, row?.accountLevel ?? 0));
});

export default app;
