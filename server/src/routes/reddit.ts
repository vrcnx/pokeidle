// The Reddit post reward, player side.
//
// One read and one write, and the write pays out on a link nobody has checked
// — see lib/redditReward.ts for why that is deliberate and what stands in for
// verification. This file's job is to make the claim expensive enough to spam
// and honest about what it refuses.

import { Hono } from "hono";
import type { Context } from "hono";
import { blockStream, requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { claimRedditPost, getRedditRewardStatus } from "../lib/redditReward.js";

const app = new Hono();

const readLimiter = makeRateLimiter({ tokens: 40, windowMs: 60_000 });
/**
 * Tight, because a claim is a payout on unverified input.
 *
 * An account gets ONE reward ever, so a legitimate player needs one successful
 * call in their lifetime and maybe two or three if they fumble the paste.
 * Anything beyond a handful in ten minutes is somebody trying links to see
 * which ones are still unclaimed — which is not an attack that gains them
 * anything, but it is a free way to enumerate what has been submitted, and
 * there is no reason to offer it.
 */
const claimLimiter = makeRateLimiter({ tokens: 6, windowMs: 10 * 60_000 });

async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

// ── GET /api/reddit/me ──────────────────────────────────────────────
app.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  if (!readLimiter.consume(`rdt:${user.id}`)) return c.json({ error: "rate_limited" }, 429);
  return c.json(await getRedditRewardStatus(user.id));
});

// ── POST /api/reddit/claim { url } ──────────────────────────────────
//
// blockStream, like the Discord link redeem: a stream auto-login session is a
// shared credential sitting in an unattended browser, and it must not be able
// to burn the one-per-account claim belonging to the player whose account it
// is borrowing. This is irreversible from the player's side — there is no
// un-claim — which is exactly the category blockStream exists for.
app.post("/claim", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  if (!claimLimiter.consume(`rdtclaim:${user.id}`)) {
    return c.json({ error: "rate_limited", reason: "Too many attempts. Wait a few minutes." }, 429);
  }

  const body = await jsonObject(c);
  const url = typeof body.url === "string" ? body.url : "";
  const res = await claimRedditPost(user.id, url);

  if (!res.ok) {
    // Statuses chosen so the client can behave differently without parsing
    // prose: 400 is "fix your input", 409 is "this conflicts with something
    // that already exists", 503 is "not running, and not your fault".
    const status =
      res.reason === "bad_url" ? 400
      : res.reason === "already_claimed" || res.reason === "link_used" ? 409
      : res.reason === "disabled" ? 503
      : 500;
    const reason =
      res.reason === "bad_url"
        ? "That doesn't look like a Reddit link. Paste the address of your post."
        : res.reason === "already_claimed"
          ? "You've already claimed this one — it's one per account."
          : res.reason === "link_used"
            // Said properly, because the honest version of this is two people
            // in the same house submitting the same thread. "Already claimed"
            // alone would read as an accusation.
            ? "That post has already been claimed. Use a link to your own post."
            : res.reason === "disabled"
              ? "This reward isn't running right now."
              : "Couldn't claim that. Try again in a moment.";
    return c.json({ error: res.reason, reason }, status);
  }

  return c.json({ ok: true, summary: res.summary });
});

export default app;
