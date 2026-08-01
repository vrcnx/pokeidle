// Machine API for the Discord bot (see bot/ — a separate deploy).
//
// Authenticated by a shared bearer secret, BOT_TOKEN, exactly like
// routes/internal.ts authenticates the renderer: the caller is a headless
// process, not a logged-in human, so there is no session to check. The
// 32-character minimum and the constant-time compare come from
// lib/middleware.ts's adminApiKey, which is the stricter of the two
// precedents — this surface reaches PLAYER DATA, where the renderer's only
// reached a broadcast control row.
//
// ══ WHAT THIS SURFACE MAY NEVER DO ══════════════════════════════════
//
// 1. IT MAY NEVER MOVE AN ASSET BETWEEN ACCOUNTS.
//
//    No endpoint here transfers a Pokémon, an item, or money from one account
//    to another, and none may ever be added. The live trade flow is in
//    socket.ts: both parties present, both locked in, and the swap performed
//    server-canonically in one step. That design is the entire reason duping
//    is impossible in this game.
//
//    An endpoint here that could transfer assets would be a SECOND, WEAKER
//    DOOR into the most valuable operation in the game — reachable by anyone
//    who phishes a Discord account, with none of the mutual-consent structure
//    that makes the real path safe. `/trade offer` below posts TEXT to a
//    noticeboard. It is discovery, not custody, and the distinction is the
//    whole design.
//
//    Precedent: StreamKey sessions are blocked from trades and auctions
//    outright (lib/middleware.ts blockStream). The bot gets the same treatment,
//    and gets it structurally — there is no endpoint to block.
//
// 2. IT MAY NEVER WRITE saveData.
//
//    Prizes go through PendingGrant via enqueuePrizeGrant(). Read the
//    deliveredAt doc comment in schema.prisma before touching anything in the
//    giveaway section: it documents a save-write approach that was built,
//    shipped, destroyed real prizes, and was removed.
//
// 3. IT MAY NEVER RETURN NON-PUBLIC DATA.
//
//    No email, no session data, no saveData verbatim, no ban reason, no admin
//    flag. Every player-facing payload here comes from lib/botProfile.ts,
//    which is an explicit allowlist. Assume every field ends up screenshotted
//    in a public channel.

import { Hono } from "hono";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { recordError } from "../lib/errorReporting.js";
import { getIo } from "../socket.js";
import { TRADE_CHANNEL } from "../lib/chatChannels.js";
import { sanitizeChatText, TRADE_FIELD_MAX } from "../lib/chatText.js";
import {
  botDex,
  botIdentity,
  botLeaderboard,
  botMon,
  botParty,
  resolveAccount,
  BOT_DTO_VERSION,
} from "../lib/botProfile.js";
import {
  discordIdForUser,
  mintLinkCode,
  unlinkDiscord,
  userIdForDiscord,
  LINK_CODE_TTL_MS,
} from "../lib/discordLink.js";
import { desiredRoles, type DesiredRoles } from "../lib/discordRoles.js";
import { linkRewardPrizes } from "../lib/discordLinkReward.js";
import { drawGiveaway } from "../lib/giveawayDraw.js";
import { parsePrizes, parsePrizesStrict, describePrizes } from "../lib/giveaway.js";
import { checkPrizesDeliverable } from "../lib/prizeGrant.js";

const app = new Hono();

// ── Auth ────────────────────────────────────────────────────────────

function tokenOk(c: Context): boolean {
  const expected = process.env.BOT_TOKEN?.trim();
  // Fail closed. No token configured → the bot API does not exist. No default,
  // no dev fallback, no "allow in NODE_ENV=development" escape hatch: this
  // endpoint reads player data, and a development convenience that authorises
  // an unauthenticated caller is a production hole one env-var typo away.
  if (!expected) return false;
  // A short secret is treated as misconfiguration and refused outright rather
  // than honoured, same as ADMIN_API_KEY. Logged (never the value) so an
  // operator staring at 401s finds out why.
  if (expected.length < 32) {
    console.error("[bot-api] BOT_TOKEN is set but shorter than 32 chars — refusing to honour it.");
    return false;
  }
  const hdr = c.req.header("authorization") ?? "";
  const provided = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so gate on length first.
  // Length is not itself a secret worth protecting.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.use("*", async (c, next) => {
  if (!tokenOk(c)) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// ── Rate limiting ───────────────────────────────────────────────────
// The bot is a single trusted caller, so this is not an anti-abuse wall in the
// usual sense — it is a blast radius limit for a bot bug (a command handler in
// a retry loop) and for a LEAKED TOKEN. Keyed per Discord user where we have
// one, so one person spamming /team cannot starve the whole server's commands.
const readLimiter = makeRateLimiter({ tokens: 30, windowMs: 60_000 });
const linkLimiter = makeRateLimiter({ tokens: 5, windowMs: 10 * 60_000 });
const writeLimiter = makeRateLimiter({ tokens: 20, windowMs: 60_000 });

function limitKey(c: Context, prefix: string): string {
  const who = c.req.query("discordId") ?? c.req.header("x-discord-user") ?? "anon";
  return `${prefix}:${who}`;
}

async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Resolve the account a command is about.
 *
 * Two ways in, and the difference matters for privacy:
 *   * `username` — an explicit lookup of a named player. Public data only, and
 *     it never consults DiscordLink, so it cannot be used to ask "does this
 *     player have a Discord account".
 *   * `discordId` — the CALLER, resolved through their own link.
 *
 * Returns a discriminated result rather than throwing so each route can render
 * "run /link first" as helpful copy rather than an error.
 */
async function subject(
  c: Context,
): Promise<
  | { ok: true; userId: string; username: string; self: boolean }
  | { ok: false; reason: "unlinked" | "not_found" }
> {
  const username = c.req.query("username")?.trim();
  if (username) {
    const acct = await resolveAccount({ username });
    return acct
      ? { ok: true, userId: acct.id, username: acct.username, self: false }
      : { ok: false, reason: "not_found" };
  }
  const discordId = c.req.query("discordId")?.trim();
  if (!discordId) return { ok: false, reason: "unlinked" };
  const userId = await userIdForDiscord(discordId);
  if (!userId) return { ok: false, reason: "unlinked" };
  const acct = await resolveAccount({ userId });
  return acct
    ? { ok: true, userId: acct.id, username: acct.username, self: true }
    : { ok: false, reason: "not_found" };
}

/** The two "no account" outcomes, rendered as copy the bot can print verbatim.
 *  An unlinked user gets an instruction, never a bare error — that is the
 *  single most common state a new community member will be in. */
function subjectError(c: Context, reason: "unlinked" | "not_found") {
  if (reason === "unlinked") {
    return c.json(
      {
        error: "unlinked",
        reason: "You haven't linked a game account yet. Run `/link` and I'll DM you a code.",
      },
      404,
    );
  }
  return c.json(
    { error: "not_found", reason: "I couldn't find a trainer with that name." },
    404,
  );
}

// ══ Linking ═════════════════════════════════════════════════════════

// POST /api/bot/link/start { discordId, discordLabel }
// Mint a code for a Discord user. The bot DMs it; the player redeems it on the
// site while signed in. See lib/discordLink.ts for why the code travels in
// that direction and not the other.
app.post("/link/start", async (c) => {
  const body = await jsonObject(c);
  const discordId = typeof body.discordId === "string" ? body.discordId.trim() : "";
  const discordLabel = typeof body.discordLabel === "string" ? body.discordLabel : "";
  if (!/^\d{5,32}$/.test(discordId)) {
    return c.json({ error: "bad_discord_id" }, 400);
  }
  if (!linkLimiter.consume(`link:${discordId}`)) {
    return c.json({ error: "rate_limited", reason: "You've asked for a lot of codes. Try again in a few minutes." }, 429);
  }

  // Already linked → say so rather than minting a code that can only fail.
  const existing = await userIdForDiscord(discordId);
  if (existing) {
    const acct = await resolveAccount({ userId: existing });
    return c.json(
      {
        error: "already_linked",
        reason: `That Discord account is already linked to **${acct?.username ?? "a game account"}**. Run \`/unlink\` first if you want to change it.`,
      },
      409,
    );
  }

  const minted = mintLinkCode(discordId, discordLabel);
  if ("error" in minted) {
    return c.json({ error: "capacity", reason: "Too many links in flight right now. Try again in a minute." }, 503);
  }
  // Advertise the reward in the DM the bot is about to send. Naming the prize
  // at the moment someone is deciding whether to finish the flow is the whole
  // point of the promotion; a reward they only learn about afterwards
  // persuades nobody to link.
  //
  // Nominal, NOT a promise for this specific user: whether they are actually
  // eligible is decided at redeem time, and saying "you'll get X" here to
  // somebody relinking a second account would be a lie. The bot's copy hedges
  // accordingly.
  const reward = await linkRewardPrizes();

  return c.json({
    code: minted.code,
    expiresAt: new Date(minted.expiresAt).toISOString(),
    ttlMs: LINK_CODE_TTL_MS,
    linkUrl: `${(process.env.FRONTEND_ORIGIN ?? "http://localhost:5173").split(",")[0].trim()}/link-discord`,
    rewardSummary: reward && reward.length > 0 ? describePrizes(reward) : null,
  });
});

// GET /api/bot/link?discordId=…
app.get("/link", async (c) => {
  const discordId = c.req.query("discordId")?.trim() ?? "";
  if (!discordId) return c.json({ error: "discordId required" }, 400);
  const userId = await userIdForDiscord(discordId);
  if (!userId) return c.json({ linked: false });
  const acct = await resolveAccount({ userId });
  return c.json({ linked: true, userId, username: acct?.username ?? null });
});

// DELETE /api/bot/link { discordId }
// `/unlink` must be usable from Discord ALONE — a player who has lost access
// to their game account still needs to free their Discord account, and
// requiring a signed-in session would strand exactly the people who need it.
app.delete("/link", async (c) => {
  const body = await jsonObject(c);
  const discordId = typeof body.discordId === "string" ? body.discordId.trim() : "";
  if (!discordId) return c.json({ error: "discordId required" }, 400);
  const { removed } = await unlinkDiscord(discordId);
  return c.json({ ok: true, removed });
});

// ══ Read-only commands ══════════════════════════════════════════════

app.get("/profile", async (c) => {
  if (!readLimiter.consume(limitKey(c, "profile"))) return c.json({ error: "rate_limited" }, 429);
  const s = await subject(c);
  if (!s.ok) return subjectError(c, s.reason);
  const dto = await botIdentity(s.userId);
  if (!dto) return subjectError(c, "not_found");
  return c.json(dto);
});

// /rank is the same underlying read as /profile — one query for columns, one
// for PlayerRating, one COUNT for position. Kept as its own route so the bot
// does not have to know that, and so the two can diverge later without a
// breaking change to either.
app.get("/rank", async (c) => {
  if (!readLimiter.consume(limitKey(c, "rank"))) return c.json({ error: "rate_limited" }, 429);
  const s = await subject(c);
  if (!s.ok) return subjectError(c, s.reason);
  const dto = await botIdentity(s.userId);
  if (!dto) return subjectError(c, "not_found");
  return c.json({ v: BOT_DTO_VERSION, username: dto.username, ...dto.rating });
});

app.get("/leaderboard", async (c) => {
  if (!readLimiter.consume(limitKey(c, "lb"))) return c.json({ error: "rate_limited" }, 429);
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  const rows = await botLeaderboard(Number.isFinite(limit) ? limit : 10);
  return c.json({ v: BOT_DTO_VERSION, leaderboard: rows });
});

// /team works on ANY player. It is the same information as the in-game trainer
// card and the public directory, and a showcase command that only worked on
// yourself would have no reason to exist in #showcase.
app.get("/team", async (c) => {
  if (!readLimiter.consume(limitKey(c, "team"))) return c.json({ error: "rate_limited" }, 429);
  const s = await subject(c);
  if (!s.ok) return subjectError(c, s.reason);
  const party = await botParty(s.userId);
  if (party === null) {
    return c.json({
      v: BOT_DTO_VERSION,
      username: s.username,
      party: [],
      // Distinguishes "no save at all" from "a save with an empty party" so
      // the bot can say "hasn't started playing yet" rather than "no team set".
      started: false,
    });
  }
  return c.json({ v: BOT_DTO_VERSION, username: s.username, party, started: true });
});

// /mon is SELF-ONLY, and that is a deliberate asymmetry with /team.
//
// A team embed is a showcase — species, level, shiny — and is already public.
// IVs and EVs are BUILD information: they are what an opponent needs to counter
// you on the ladder, and the game's own UI does not publish them for other
// players. A Discord command that does would be handing out an advantage the
// game withholds, to whoever thought to ask.
app.get("/mon", async (c) => {
  if (!readLimiter.consume(limitKey(c, "mon"))) return c.json({ error: "rate_limited" }, 429);
  const s = await subject(c);
  if (!s.ok) return subjectError(c, s.reason);
  if (!s.self) {
    return c.json(
      {
        error: "self_only",
        reason: "`/mon` shows IVs and EVs, so it only works on your own Pokémon. Try `/team` for someone else's line-up.",
      },
      403,
    );
  }
  const slot = parseInt(c.req.query("slot") ?? "", 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > 6) {
    return c.json({ error: "bad_slot", reason: "Pick a party slot from 1 to 6." }, 400);
  }
  const mon = await botMon(s.userId, slot);
  if (!mon) {
    return c.json({ error: "empty_slot", reason: `You don't have a Pokémon in slot ${slot}.` }, 404);
  }
  return c.json({ v: BOT_DTO_VERSION, username: s.username, mon });
});

app.get("/dex", async (c) => {
  if (!readLimiter.consume(limitKey(c, "dex"))) return c.json({ error: "rate_limited" }, 429);
  const s = await subject(c);
  if (!s.ok) return subjectError(c, s.reason);
  const dto = await botDex(s.userId);
  if (!dto) return subjectError(c, "not_found");
  return c.json(dto);
});

// GET /api/bot/prizes?discordId=…
//
// What this account is still owed, and what has landed. This is the answer to
// "the giveaway said I won, where is it" — delivery is deferred to the
// winner's next save upload by design (see lib/prizeGrant.ts), so a player who
// is not currently playing has a real, correct, invisible pending prize.
//
// Self-only: what someone is owed is not public.
app.get("/prizes", async (c) => {
  if (!readLimiter.consume(limitKey(c, "prizes"))) return c.json({ error: "rate_limited" }, 429);
  const s = await subject(c);
  if (!s.ok) return subjectError(c, s.reason);
  if (!s.self) return c.json({ error: "self_only", reason: "You can only check your own prizes." }, 403);

  const rows = await prisma.pendingGrant.findMany({
    where: { userId: s.userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true, summary: true, source: true, createdAt: true, prizes: true,
      deliveredAt: true, attempts: true, lastError: true,
    },
  });
  return c.json({
    v: BOT_DTO_VERSION,
    username: s.username,
    grants: rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      source: r.source,
      // The descriptors, not just the summary string, so the bot can draw the
      // item/Pokémon sprite next to each line. parsePrizes (lenient) is
      // correct here and parsePrizesStrict would be wrong: this is a STORED
      // row that was validated on the way in, which is exactly the case the
      // lenient reader documents itself as being for.
      prizes: parsePrizes(r.prizes),
      createdAt: r.createdAt.toISOString(),
      delivered: !!r.deliveredAt,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      // A grant the fold keeps refusing — almost always a Pokémon prize into a
      // full box. checkPrizesDeliverable CANNOT detect this at grant time (it
      // is prize-intrinsic by design and never consults the recipient's save),
      // so surfacing `attempts` here IS the mechanism by which a player finds
      // out their box is full. `lastError` is the validator's own reason
      // string; it is not player-written and contains no other account's data.
      stuck: !r.deliveredAt && r.attempts > 0,
      attempts: r.attempts,
      lastError: r.deliveredAt ? null : r.lastError,
    })),
  });
});

// ══ Role sync ═══════════════════════════════════════════════════════

// GET /api/bot/roles/desired
//
// The server computes WHO SHOULD HAVE WHAT; the bot diffs that against the
// guild and applies the difference. Reconciliation rather than fire-and-forget
// events, so a webhook the bot missed (deploy, restart, Discord outage) heals
// on the next pass instead of leaving a stale Champion forever.
app.get("/roles/desired", async (c) => {
  const roles: DesiredRoles = await desiredRoles();
  return c.json(roles);
});

// ══ Giveaways ═══════════════════════════════════════════════════════
//
// A Discord giveaway creates a REAL Giveaway row and draws with the REAL
// drawGiveaway(). It does not reimplement any of it.
//
// That is worth being explicit about, because a bot-local giveaway would have
// been less code to write and would have quietly lost: the atomic
// `drawnAt: null` compare-and-swap that makes a double-draw impossible, the
// deterministic seeded draw that makes the result verifiable after the fact,
// the paid-but-unrecorded handling that keeps an operator from re-granting a
// prize that already landed, and the admin dashboard's owed-vs-delivered view.
// All of that exists; a second implementation would have none of it.

// POST /api/bot/giveaways { title, description, prizes, winnerCount, ownerDiscordId }
app.post("/giveaways", async (c) => {
  const body = await jsonObject(c);
  const ownerDiscordId = typeof body.ownerDiscordId === "string" ? body.ownerDiscordId.trim() : "";
  if (!writeLimiter.consume(`gwcreate:${ownerDiscordId || "anon"}`)) {
    return c.json({ error: "rate_limited" }, 429);
  }

  // The giveaway is OWNED by the game account of the moderator who ran the
  // command. Giveaway.ownerId is a real FK and it is who the audit trail and
  // the in-game announcement are attributed to — "the bot" is not an
  // accountable party, and a prize that appears from nowhere with no operator
  // attached is exactly the sort of thing an audit ledger exists to prevent.
  //
  // Discord-side role gating (Admin/Moderator) happens in the bot. This is the
  // server-side half of the same requirement: an unlinked moderator cannot run
  // a giveaway, because there would be nobody to attribute it to.
  const ownerId = ownerDiscordId ? await userIdForDiscord(ownerDiscordId) : null;
  if (!ownerId) {
    return c.json(
      {
        error: "owner_unlinked",
        reason: "Link your own game account with `/link` before running a giveaway — the giveaway is recorded under it.",
      },
      403,
    );
  }

  const title = sanitizeChatText(String(body.title ?? "")).slice(0, 120);
  const description = sanitizeChatText(String(body.description ?? "")).slice(0, 500);
  if (!title) return c.json({ error: "title_required" }, 400);

  const winnerCount = Math.min(20, Math.max(1, parseInt(String(body.winnerCount ?? "1"), 10) || 1));

  // parsePrizesStrict, never parsePrizes: this is an INBOUND body. The lenient
  // reader is for rows we already validated on the way in, and routing a
  // request through it is the exact hole its doc comment warns about.
  const prizesJson = typeof body.prizes === "string" ? body.prizes : JSON.stringify(body.prizes ?? []);
  const parsed = parsePrizesStrict(prizesJson);
  if (!parsed.ok) return c.json({ error: "bad_prizes", reason: parsed.reason }, 400);

  // Pre-flight the prize itself. This catches a PERMANENTLY undeliverable
  // prize (a level-105 mon, a malformed moves array) now, while a human is
  // looking at the command output, rather than as a grant that is silently
  // refused on every save upload for the rest of the winner's life.
  //
  // It CANNOT detect a full box, and nothing here should be read as claiming
  // otherwise — checkPrizesDeliverable folds onto an empty skeleton and never
  // consults a recipient's save, deliberately, because a transient condition
  // reported as failure leads an operator to re-grant and double-pay. Full
  // boxes surface through GET /api/bot/prizes above.
  const bad = checkPrizesDeliverable(parsed.prizes);
  if (bad) return c.json({ error: "undeliverable_prize", reason: bad }, 400);

  const row = await prisma.giveaway.create({
    data: {
      title,
      description,
      prizes: JSON.stringify(parsed.prizes),
      winnerCount,
      ownerId,
      status: "open",
    },
    select: { id: true, title: true, winnerCount: true },
  });

  return c.json({
    ok: true,
    giveawayId: row.id,
    title: row.title,
    description,
    winnerCount: row.winnerCount,
    prizeSummary: describePrizes(parsed.prizes),
    // Descriptors so the bot can render the item/Pokémon sprites on the
    // giveaway card. Echoed from what we just validated and stored.
    prizes: parsed.prizes,
  });
});

// POST /api/bot/giveaways/:id/entries { discordId }
//
// Entrants must be LINKED, because an unlinked winner cannot be paid — there
// is no game account to enqueue a PendingGrant against. Enforcing it at ENTRY
// rather than at draw time is the whole point: discovering it at draw time
// means re-rolling a winner, in public, which is indistinguishable from
// rigging it.
app.post("/giveaways/:id/entries", async (c) => {
  const id = c.req.param("id");
  const body = await jsonObject(c);
  const discordId = typeof body.discordId === "string" ? body.discordId.trim() : "";
  if (!discordId) return c.json({ error: "discordId required" }, 400);
  if (!writeLimiter.consume(`gwenter:${discordId}`)) return c.json({ error: "rate_limited" }, 429);

  const userId = await userIdForDiscord(discordId);
  if (!userId) {
    return c.json(
      {
        error: "unlinked",
        reason: "You need a linked game account to enter — otherwise there's nowhere to send the prize. Run `/link` and try again.",
      },
      403,
    );
  }

  const g = await prisma.giveaway.findUnique({
    where: { id },
    select: { id: true, status: true, drawnAt: true, minAccountLevel: true },
  });
  if (!g) return c.json({ error: "not_found" }, 404);
  if (g.drawnAt || g.status !== "open") {
    return c.json({ error: "closed", reason: "That giveaway isn't taking entries any more." }, 409);
  }

  const acct = await resolveAccount({ userId });
  if (!acct) return c.json({ error: "not_found" }, 404);

  if (g.minAccountLevel != null) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { accountLevel: true } });
    if ((u?.accountLevel ?? 0) < g.minAccountLevel) {
      return c.json(
        { error: "below_min_level", reason: `You need account level ${g.minAccountLevel} to enter this one.` },
        403,
      );
    }
  }

  try {
    await prisma.giveawayEntry.create({
      data: { giveawayId: id, userId, username: acct.username },
    });
  } catch {
    // The @@unique([giveawayId, userId]) is what makes this a fair draw rather
    // than a spam contest, and it is the guard — not a pre-check. A duplicate
    // is reported as success-shaped ("you're in") because the state the player
    // wanted is true; telling them it failed would just make them click again.
    return c.json({ ok: true, entered: true, duplicate: true });
  }
  return c.json({ ok: true, entered: true, duplicate: false });
});

// POST /api/bot/giveaways/:id/draw { actorDiscordId }
app.post("/giveaways/:id/draw", async (c) => {
  const id = c.req.param("id");
  const body = await jsonObject(c);
  const actorDiscordId = typeof body.actorDiscordId === "string" ? body.actorDiscordId.trim() : "";
  if (!writeLimiter.consume(`gwdraw:${actorDiscordId || "anon"}`)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  const actorId = actorDiscordId ? await userIdForDiscord(actorDiscordId) : null;

  // grantSource "discord" so PendingGrant rows created from here are
  // distinguishable in the ops sweep from ones an in-game giveaway created.
  // The @@index([source, sourceId]) on PendingGrant is what makes that a
  // lookup rather than a scan.
  const result = await drawGiveaway(id, actorId ? { id: actorId } : null, { grantSource: "discord" });
  if (!result.ok) {
    return c.json({ error: result.error, reason: result.reason }, result.status ?? 400);
  }

  // Decorate winners with their Discord ids so the bot can @mention them and
  // DM the "your prize is queued" note. Best-effort per winner: a winner who
  // has since unlinked is still a winner, and still gets paid — they just do
  // not get a mention.
  const winners = await Promise.all(
    (result.granted ?? []).map(async (g) => {
      const acct = await prisma.user.findUnique({
        where: { username: g.username },
        select: { id: true },
      });
      const discordId = acct ? await discordIdForUser(acct.id) : null;
      return { username: g.username, ok: g.ok, error: g.error ?? null, discordId };
    }),
  );

  return c.json({
    ok: true,
    giveawayId: id,
    seed: result.seed,
    entryCount: result.entryCount,
    winners,
    // Delivery is DEFERRED — the prize lands on the winner's next save upload,
    // not now. The bot must say so, or a winner who is not currently playing
    // reads an empty bag as a broken giveaway.
    deliveryNote:
      "Prizes are queued and will appear the next time the winner loads the game. Nothing is lost if they're offline.",
  });
});

// ── Admin-dashboard giveaways ───────────────────────────────────────
//
// GET /api/bot/giveaways/pending
//
// The bot polls this so a giveaway created in the ADMIN DASHBOARD can be
// announced in Discord. The game server does not push, because it holds no
// Discord token and knows no channel semantics — see lib/discordRoles.ts for
// the same split applied to roles. A Discord outage therefore has nothing to
// fail on this side.
//
// Two independent lists, because they are two different posts at two different
// times: a giveaway is announced when it opens, and its result is posted when
// it is drawn, which may be days later and may be triggered from either the
// dashboard or the bot.
//
// `discordMessageId IS NULL` / `discordResultsAt IS NULL` are the idempotency
// markers. Without them a timer-driven poll re-posts the same giveaway on
// every tick.
app.get("/giveaways/pending", async (c) => {
  const [toAnnounce, toReport] = await Promise.all([
    prisma.giveaway.findMany({
      where: { announceToDiscord: true, status: "open", discordMessageId: null },
      select: {
        id: true, title: true, description: true, prizes: true,
        winnerCount: true, discordChannelId: true, endsAt: true,
      },
      take: 10,
    }),
    prisma.giveaway.findMany({
      where: { announceToDiscord: true, drawnAt: { not: null }, discordResultsAt: null },
      select: {
        id: true, title: true, drawSeed: true, discordChannelId: true, discordMessageId: true,
        entries: { where: { isWinner: true }, select: { username: true, userId: true } },
      },
      take: 10,
    }),
  ]);

  // Winners are decorated with their Discord ids so the bot can @mention them.
  // Best-effort per winner — someone who has since unlinked is still a winner
  // and is still paid, they just do not get a mention.
  const reportRows = await Promise.all(
    toReport.map(async (g) => ({
      id: g.id,
      title: g.title,
      seed: g.drawSeed,
      channelId: g.discordChannelId,
      announceMessageId: g.discordMessageId,
      winners: await Promise.all(
        g.entries.map(async (e) => ({
          username: e.username,
          discordId: await discordIdForUser(e.userId),
        })),
      ),
    })),
  );

  return c.json({
    v: BOT_DTO_VERSION,
    toAnnounce: toAnnounce.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      prizes: parsePrizes(g.prizes),
      prizeSummary: describePrizes(parsePrizes(g.prizes)),
      winnerCount: g.winnerCount,
      channelId: g.discordChannelId,
      endsAt: g.endsAt?.toISOString() ?? null,
    })),
    toReport: reportRows,
  });
});

// POST /api/bot/giveaways/:id/announced { messageId, channelId }
//
// The bot calls this immediately after posting. Written AFTER the post, not
// before, and that ordering is deliberate: a crash in between costs one
// duplicate message, which a human can delete. The other order costs a
// giveaway that is never announced at all, which nobody notices until entries
// are zero.
app.post("/giveaways/:id/announced", async (c) => {
  const id = c.req.param("id");
  const body = await jsonObject(c);
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  if (!messageId) return c.json({ error: "messageId required" }, 400);
  const channelId = typeof body.channelId === "string" ? body.channelId.trim() : null;

  // updateMany with the NULL guard, not update: two bot instances (or a
  // restarted one mid-poll) must not both claim the announcement. The loser
  // gets count 0 and can delete its duplicate.
  const res = await prisma.giveaway.updateMany({
    where: { id, discordMessageId: null },
    data: { discordMessageId: messageId, ...(channelId ? { discordChannelId: channelId } : {}) },
  });
  return c.json({ ok: true, claimed: res.count > 0 });
});

// POST /api/bot/giveaways/:id/reported — same, for the result post.
app.post("/giveaways/:id/reported", async (c) => {
  const id = c.req.param("id");
  const res = await prisma.giveaway.updateMany({
    where: { id, discordResultsAt: null },
    data: { discordResultsAt: new Date() },
  });
  return c.json({ ok: true, claimed: res.count > 0 });
});

// GET /api/bot/giveaways/:id — owed vs delivered, for the audit post and for
// a follow-up edit once prizes actually land.
app.get("/giveaways/:id", async (c) => {
  const id = c.req.param("id");
  const g = await prisma.giveaway.findUnique({
    where: { id },
    select: {
      id: true, title: true, status: true, drawnAt: true, drawSeed: true, winnerCount: true,
      entries: { select: { username: true, isWinner: true, claimedAt: true } },
    },
  });
  if (!g) return c.json({ error: "not_found" }, 404);

  // BOTH sources, because the same giveaway can be drawn from either side: the
  // bot stamps "discord", the admin dashboard stamps "giveaway", and a
  // giveaway created in the dashboard and drawn there still needs its delivery
  // state visible here. Filtering on "discord" alone silently reported every
  // dashboard-drawn giveaway as having no prizes.
  //
  // Kept as an `in` on the leading column rather than a bare sourceId filter so
  // it still uses @@index([source, sourceId]).
  const grants = await prisma.pendingGrant.findMany({
    where: { source: { in: ["discord", "giveaway"] }, sourceId: id },
    select: { summary: true, deliveredAt: true, attempts: true, userId: true },
  });
  const users = grants.length
    ? await prisma.user.findMany({
        where: { id: { in: grants.map((x) => x.userId) } },
        select: { id: true, username: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.username]));

  return c.json({
    v: BOT_DTO_VERSION,
    id: g.id,
    title: g.title,
    status: g.status,
    drawnAt: g.drawnAt?.toISOString() ?? null,
    seed: g.drawSeed,
    entryCount: g.entries.length,
    winners: g.entries.filter((e) => e.isWinner).map((e) => e.username),
    prizes: grants.map((x) => ({
      username: nameById.get(x.userId) ?? "(deleted)",
      summary: x.summary,
      delivered: !!x.deliveredAt,
      deliveredAt: x.deliveredAt?.toISOString() ?? null,
      stuck: !x.deliveredAt && x.attempts > 0,
    })),
  });
});

// ══ Bug reports from Discord ════════════════════════════════════════
//
// POST /api/bot/bug-reports
//
// A post in the community server's bug channel becomes a row in the SAME
// BugReport table the in-game Report Bug modal writes to, so it lands in the
// existing admin triage queue rather than in a second place nobody checks.
//
// ── THIS IS THE ONE PLACE DISCORD TEXT ENTERS THE DATABASE ───────────
// Everything else the bot does treats Discord as a rendering surface: commands
// in, embeds out, no message content stored. Bug reports are a deliberate
// exception, because the whole value of a bug report IS its text and copying
// it by hand is what stops it happening at all.
//
// What that costs, stated plainly: the bot needs the MessageContent privileged
// intent to read the channel, and player-written text from Discord now lives
// in the game database. Both are bounded to the ONE configured channel — the
// bot ignores every other channel, every DM, and every bot message.
//
// Idempotency is `discordMessageId UNIQUE`, not a check: the bot listens live
// AND sweeps history on boot, so the same message arrives more than once by
// construction. See the migration.
app.post("/bug-reports", async (c) => {
  const body = await jsonObject(c);
  const discordMessageId = typeof body.discordMessageId === "string" ? body.discordMessageId.trim() : "";
  if (!discordMessageId) return c.json({ error: "discordMessageId required" }, 400);
  if (!writeLimiter.consume(`bug:${discordMessageId.slice(0, 8)}`)) {
    return c.json({ error: "rate_limited" }, 429);
  }

  // Bounds mirror the in-game ReportBody (routes/bugReports.ts) so a Discord
  // report cannot be a shape the triage UI has never had to render.
  const title = sanitizeChatText(String(body.title ?? "")).slice(0, 120);
  const description = sanitizeChatText(String(body.description ?? "")).slice(0, 4000);
  if (!title || description.length < 10) {
    return c.json(
      { error: "too_short", reason: "A report needs a title and at least a sentence of detail." },
      400,
    );
  }

  // Attribute to a game account when the reporter has linked one. This is the
  // reason to route bug ingest through the bot API at all rather than a plain
  // webhook: a report that names a real account is one an operator can act on
  // — check their save, look at their level — where "some Discord handle" is a
  // dead end.
  const discordId = typeof body.discordId === "string" ? body.discordId.trim() : "";
  const discordName = sanitizeChatText(String(body.discordName ?? "")).slice(0, 60) || "Discord user";
  const userId = discordId ? await userIdForDiscord(discordId) : null;
  const acct = userId ? await resolveAccount({ userId }) : null;

  // A link back to the original message, so triage can read the thread, see
  // the screenshots, and reply to the reporter. Stored in `page`, which the
  // admin UI already renders for in-game reports as "where it happened".
  const messageUrl = typeof body.messageUrl === "string" ? body.messageUrl.slice(0, 500) : null;

  try {
    const row = await prisma.bugReport.create({
      data: {
        reporterId: acct?.id ?? null,
        // Both identities when we have them: the operator needs the game
        // account to investigate and the Discord handle to reply.
        reporterName: acct ? `${acct.username} (@${discordName})` : `@${discordName}`,
        title,
        description,
        page: messageUrl,
        source: "discord",
        discordMessageId,
      },
      select: { id: true },
    });
    return c.json({ ok: true, id: row.id, duplicate: false, linkedTo: acct?.username ?? null });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Already ingested. Success-shaped: the state the caller wanted is true,
      // and the bot's boot sweep hits this on every restart by design.
      return c.json({ ok: true, duplicate: true });
    }
    throw e;
  }
});

// ══ Trade noticeboard ═══════════════════════════════════════════════
//
// TEXT ONLY. This posts a listing and returns a deep link. It does not, and
// must not ever, move a Pokémon — see the header of this file.
//
// The listing is written into the SAME in-game trade channel the game's own
// composer writes to, with the same sanitiser and the same field bounds, so
// #trade-chat and the in-game board are one noticeboard rather than two that
// disagree. A Discord-only listing would be invisible to the ~2,300 accounts
// who never join the server, which is most of the audience for it.
app.post("/trade/offer", async (c) => {
  const body = await jsonObject(c);
  const discordId = typeof body.discordId === "string" ? body.discordId.trim() : "";
  if (!discordId) return c.json({ error: "discordId required" }, 400);
  if (!writeLimiter.consume(`trade:${discordId}`)) {
    return c.json({ error: "rate_limited", reason: "You're posting a lot of listings. Give it a minute." }, 429);
  }

  const userId = await userIdForDiscord(discordId);
  if (!userId) return subjectError(c, "unlinked");
  const acct = await resolveAccount({ userId });
  if (!acct) return subjectError(c, "not_found");

  const offering = sanitizeChatText(String(body.offering ?? "")).slice(0, TRADE_FIELD_MAX);
  const wanting = sanitizeChatText(String(body.wanting ?? "")).slice(0, TRADE_FIELD_MAX);
  if (!offering || !wanting) {
    return c.json({ error: "fields_required", reason: "Tell me what you're offering and what you want for it." }, 400);
  }

  // Mirror into the in-game trade channel, as the posting player, with
  // kind:"tradeOffer" — byte-for-byte the shape socket.ts produces, so the
  // existing TradeOfferCard renders it with a working Open Trade button and no
  // client change is needed.
  let chatMessageId: string | null = null;
  try {
    const stored = await prisma.chatMessage.create({
      data: {
        channelId: TRADE_CHANNEL,
        userId,
        content: `Offering ${offering} — looking for ${wanting}`,
        kind: "tradeOffer",
        meta: JSON.stringify({ offering, wanting }),
      },
      include: { user: { select: { id: true, username: true, name: true, accountLevel: true } } },
    });
    chatMessageId = stored.id;
    const io = getIo();
    if (io) {
      io.to(TRADE_CHANNEL).emit("chat:message", {
        id: stored.id,
        channelId: stored.channelId,
        content: stored.content,
        kind: stored.kind,
        meta: stored.meta,
        createdAt: stored.createdAt,
        user: stored.user,
      });
    }
  } catch (e) {
    // The Discord embed is still worth posting if the in-game mirror failed,
    // so this is recorded rather than fatal.
    void recordError({
      kind: "server",
      message: "bot_trade_mirror_failed",
      source: "POST /api/bot/trade/offer",
      userId,
      meta: { error: String((e as Error)?.message ?? e) },
    });
  }

  const origin = (process.env.FRONTEND_ORIGIN ?? "http://localhost:5173").split(",")[0].trim();
  return c.json({
    ok: true,
    username: acct.username,
    offering,
    wanting,
    chatMessageId,
    // The deep link opens the game and pre-targets this player. It CANNOT
    // complete a trade on its own and does not try to: trade:invite is a live
    // socket handshake that needs both parties connected, so if the poster is
    // offline the client says so and shows their trainer card instead. See
    // game/src/hooks/useTradeDeepLink.ts.
    deepLink: `${origin}/?trade=${encodeURIComponent(acct.username)}`,
  });
});

export default app;
