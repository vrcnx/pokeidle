// Player-facing half of Discord account linking.
//
// This file is the SITE side of the flow: a signed-in human submits the code
// the bot DM'd them. The bot side — minting the code, unlinking from Discord —
// lives in routes/bot.ts behind BOT_TOKEN, because it is a machine caller.
//
// ── WHY THE TWO HALVES ARE NOT IN ONE FILE ──────────────────────────
// They authenticate differently, and conflating them is how a machine token
// ends up able to do a human's job. Everything here requires a real Better
// Auth session, because the whole point of this half is to prove that the
// person holding the Discord code also holds the game account. A shared secret
// held by the bot proves nothing about which player is at the keyboard, so no
// endpoint in this file may ever be reachable with one.

import { Hono } from "hono";
import type { Context } from "hono";
import { blockStream, requireUser } from "../lib/middleware.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import {
  discordIdForUser,
  peekLinkCode,
  redeemLinkCode,
  unlinkUser,
} from "../lib/discordLink.js";
import { grantLinkReward } from "../lib/discordLinkReward.js";
import { awardEventXp } from "../lib/discordXp.js";

const app = new Hono();

/**
 * The brute-force wall on the code keyspace.
 *
 * ~3.1e8 possible codes, 10 attempts per 10 minutes per account: an attacker
 * with a valid game session gets ~1,440 guesses a day against a population of
 * codes that is empty most of the time and never larger than the number of
 * people mid-link. They will not find one, and if they did the prize is
 * binding their own Discord account to the account they are already signed
 * into.
 *
 * Keyed on the SESSION USER, not the IP: the endpoint requires auth, so the
 * user id is the identity that actually costs something to obtain, and IP
 * keying would punish everyone behind one campus NAT for one bad actor.
 */
const redeemLimiter = makeRateLimiter({ tokens: 10, windowMs: 10 * 60_000 });
/** Looser, because a peek is what the UI does as you type — it is a preview,
 *  not an attempt. Still bounded so it cannot become a free oracle that tells
 *  you when you have guessed a code without spending a redeem token. */
const peekLimiter = makeRateLimiter({ tokens: 30, windowMs: 10 * 60_000 });

// A JSON body of literal `null` (or an array/scalar) survives
// `.catch(() => ({}))` and then throws on property access — a 500 plus a bogus
// ErrorLog row. Normalise to a plain object first. Same helper, same reason, as
// routes/internal.ts.
async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

// ── GET /api/discord/link/me ────────────────────────────────────────
// Is this account linked, and to what. Only ever answers about the CALLER'S
// OWN binding — there is no endpoint anywhere that maps someone else's game
// account to their Discord account, because that mapping is the one piece of
// this graph a player has not chosen to publish.
app.get("/link/me", requireUser, async (c) => {
  const user = c.get("user");
  const discordId = await discordIdForUser(user.id);
  return c.json({ linked: !!discordId, discordId: discordId ?? null });
});

// ── GET /api/discord/link/peek?code=ABC234 ──────────────────────────
// Which Discord account a code belongs to, without consuming it. This exists
// so the confirm button can say "Link @someone to this account?" rather than
// asking the player to trust that the six characters they pasted came from
// their own DM.
//
// Returns 200 with `found:false` rather than 404 for an unknown code: this is
// a preview of a field the user is still typing, and a stream of 404s in the
// browser console reads like something is broken.
app.get("/link/peek", requireUser, async (c) => {
  const user = c.get("user");
  if (!peekLimiter.consume(`dlpeek:${user.id}`)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const code = c.req.query("code") ?? "";
  const found = peekLinkCode(code);
  return c.json(found ? { found: true, discordLabel: found.discordLabel } : { found: false });
});

// ── POST /api/discord/link/redeem { code } ──────────────────────────
// The actual binding.
//
// blockStream: a stream auto-login session must never be able to bind a
// Discord identity to the account it is borrowing. That session is a shared
// credential living in an unattended browser on a stream box — exactly the
// thing lib/middleware.ts's blockStream exists to keep away from irreversible,
// account-scoped decisions. Binding an outside identity to the account belongs
// in the same category as trading and renaming.
app.post("/link/redeem", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  if (!redeemLimiter.consume(`dlredeem:${user.id}`)) {
    return c.json({ error: "rate_limited", reason: "Too many attempts. Wait a few minutes." }, 429);
  }
  const body = await jsonObject(c);
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) return c.json({ error: "code_required" }, 400);

  const result = await redeemLinkCode(code, user.id);
  if (!result.ok) {
    // 409 for both "already linked" cases: the request was well-formed and
    // understood, and it conflicts with state that already exists. 404 for an
    // unknown code, which includes the expired case — we do not distinguish
    // them, because "that code expired" tells a guesser that they guessed a
    // real code.
    const status = result.reason === "unknown_code" ? 404 : 409;
    const reason =
      result.reason === "unknown_code"
        ? "That code is wrong or has expired. Run /link in Discord for a new one."
        : result.reason === "account_already_linked"
          ? "This game account is already linked to a Discord account. Run /unlink in Discord first."
          : "That Discord account is already linked to a different game account. Run /unlink in Discord first.";
    return c.json({ error: result.reason, reason }, status);
  }

  // The link is committed at this point. The reward is a bonus on top and is
  // explicitly best-effort — grantLinkReward never throws — so a promotion
  // problem can never turn a successful link into a failed one.
  const reward = await grantLinkReward(user.id, result.discordId);

  // Community XP for linking. Reached only on a successful redeem, and a
  // second redeem for an account that is already linked returns earlier — so
  // this pays once per Discord account without needing its own guard.
  // Best-effort: XP is a nicety and must never fail a link.
  void awardEventXp(result.discordId, "link", result.discordLabel).catch(() => undefined);

  return c.json({
    ok: true,
    discordLabel: result.discordLabel,
    // Only ever `granted: true` with a summary, or absent. The internal
    // "why not" reasons (disabled / already_claimed / below_min_level) are
    // deliberately NOT sent: a player who links a second account does not need
    // to be told there was a prize they didn't get.
    reward: reward.granted ? { summary: reward.summary } : null,
  });
});

// ── DELETE /api/discord/link/me ─────────────────────────────────────
// Unlink from the site. The Discord-side /unlink is the one the brief
// requires (it must work when you have lost the game account); this is the
// mirror for when you have lost the DISCORD account, which is the same problem
// pointing the other way.
//
// Idempotent: unlinking when not linked is a 200 with removed:false, not an
// error. There is no state the caller wanted that they do not now have.
app.delete("/link/me", requireUser, blockStream, async (c) => {
  const user = c.get("user");
  const { removed } = await unlinkUser(user.id);
  return c.json({ ok: true, removed });
});

export default app;
