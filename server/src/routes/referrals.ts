// The player's own referral card: their code, their link, their progress.
//
// Attribution — recording that a NEW account arrived through a code — is not
// here. It rides on POST /api/attribution, because it is the same fact
// captured at the same moment under the same "this account is minutes old"
// guard, and a second endpoint would need its own copy of all of it.
//
// So this file is read-only. There is no claim endpoint and there never
// should be: every prize is enqueued by the thing that PROVES it was earned
// (a signup landing through the link), and delivery goes through the
// PendingGrant inbox like everything else. A claim endpoint would be a second
// way to pay the same reward, which is how a reward gets paid twice.

import { Hono } from "hono";
import { requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { getReferralSummary } from "../lib/referrals.js";

const app = new Hono();

/** The first call for an account MINTS a code, so this writes a row on a cold
 *  path and gets a limiter like anything else that does. */
const meLimiter = makeRateLimiter({ tokens: 30, windowMs: 60_000 });

// ── GET /api/referrals/me ───────────────────────────────────────────
// Only ever the CALLER'S own card. There is deliberately no endpoint that
// resolves a code to a player, or lists who somebody referred: a code is
// shareable, so anything that maps one to an account turns a link posted in a
// public channel into a way to name the person who posted it.
app.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  if (!meLimiter.consume(`ref:${user.id}`)) {
    return c.json({ error: "Slow down a moment." }, 429);
  }
  const summary = await getReferralSummary(user.id);
  return c.json(summary);
});

export default app;
