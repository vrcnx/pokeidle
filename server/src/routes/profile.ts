import { Hono } from "hono";
import { prisma } from "../db.js";
import { audit } from "../lib/audit.js";
import { blockStream, requireUser } from "../lib/middleware.js";
import {
  DISPLAY_NAME_COOLDOWN_MS,
  USERNAME_COOLDOWN_MS,
  cooldownRemainingMs,
  cooldownUnlocksAt,
  isRejection,
  validateDisplayName,
  validateUsername,
} from "../lib/nameChange.js";
import { makeRateLimiter } from "../lib/rateLimit.js";
import { parseStreamConfig } from "../lib/streamSession.js";

const app = new Hono();

// Burst guard on top of the durable cooldowns. The cooldowns are what
// stop identity-cycling; this is what stops someone using the rename
// endpoint as a free username-availability oracle, since a rejected
// attempt never touches the cooldown.
const renameLimiter = makeRateLimiter({ tokens: 10, windowMs: 10 * 60_000 });

// GET /api/profile/directory?sort=level|dex|sigma&limit=N
// Public trainer directory — top N trainers by the chosen sort.
// Open to any signed-in user. No PII (no email) — fields mirror
// PublicProfile shape. Excludes banned + just-signed-up accounts
// (lastSeenAt within ~24h of createdAt OR account level 0 with no
// Pokémon caught) so the directory always reads as active players.
app.get("/directory", requireUser, async (c) => {
  const sortRaw = c.req.query("sort") ?? "level";
  const limit = Math.min(100, Math.max(5, parseInt(c.req.query("limit") ?? "30", 10)));
  type SortKey = "accountLevel" | "pokedexCaughtCount" | "totalCaughtLevels";
  const sortKey: SortKey =
    sortRaw === "dex" ? "pokedexCaughtCount"
    : sortRaw === "sigma" ? "totalCaughtLevels"
    : "accountLevel";
  const users = await prisma.user.findMany({
    where: {
      OR: [{ bannedUntil: null }, { bannedUntil: { lt: new Date() } }],
      pokedexCaughtCount: { gt: 0 },
    },
    orderBy: [{ [sortKey]: "desc" }, { accountLevel: "desc" }, { username: "asc" }],
    take: limit,
    select: {
      id: true,
      username: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  return c.json({ trainers: users, sort: sortKey });
});

// GET /api/profile/me/trades — caller's trade history. Up to 50 most
// recent records. Mirrors the admin /users/:id/trades shape but is
// scoped to the caller, so any signed-in player can see their own
// record. Trades record the canonical {sent, received} pair at the
// time of the trade so renames + account deletes don't rewrite
// history (a sibling user-id may be null if the partner deleted
// their account).
app.get("/me/trades", requireUser, async (c) => {
  const me = c.get("user");
  const rows = await prisma.tradeRecord.findMany({
    where: { OR: [{ userAId: me.id }, { userBId: me.id }] },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // Normalise to a "what I gave / got" shape so the client doesn't have
  // to figure out which side we're on each row.
  const trades = rows.map((r) => {
    const iAmA = r.userAId === me.id;
    return {
      id: r.id,
      at: r.createdAt,
      partnerUsername: iAmA ? r.userBUsername : r.userAUsername,
      partnerUserId: iAmA ? r.userBId : r.userAId,
      sent: {
        speciesKey: iAmA ? r.userASentSpecies : r.userBSentSpecies,
        nickname:   iAmA ? r.userASentMon     : r.userBSentMon,
        level:      iAmA ? r.userASentLevel   : r.userBSentLevel,
      },
      received: {
        speciesKey: iAmA ? r.userBSentSpecies : r.userASentSpecies,
        nickname:   iAmA ? r.userBSentMon     : r.userASentMon,
        level:      iAmA ? r.userBSentLevel   : r.userASentLevel,
      },
    };
  });
  return c.json({ trades });
});

// GET /api/profile/me — caller's profile + derived stats.
app.get("/me", requireUser, async (c) => {
  const user = c.get("user");
  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      username: true,
      email: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
      usernameChangedAt: true,
      nameChangedAt: true,
      // Sent so the client can gate admin-only affordances. Currently: the
      // 5x game speed, which is no longer offered to players. This is a
      // CONVENIENCE flag, not a security boundary — the client is not
      // trusted with anything, and nothing server-side keys off what the
      // client believes about it.
      isAdmin: true,
    },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  // isStream tells the client it's a restricted OBS/24-7 auto-login session
  // so it can auto-dismiss dialogs and hide sensitive UI (trades, auctions,
  // account settings). streamConfig carries the admin-set automation (start
  // route, auto-buy balls). Absent for normal sessions.
  const isStream = !!c.get("isStream");
  const { usernameChangedAt, nameChangedAt, ...rest } = u;
  return c.json({
    ...rest,
    // Resolved instants rather than the raw timestamps + a cooldown
    // constant the client would have to keep in sync. The settings UI
    // uses these to say "you can change this again on the 4th" instead
    // of letting someone fill in a form that is going to bounce.
    usernameChangeAllowedAt: cooldownUnlocksAt(usernameChangedAt, USERNAME_COOLDOWN_MS),
    displayNameChangeAllowedAt: cooldownUnlocksAt(nameChangedAt, DISPLAY_NAME_COOLDOWN_MS),
    isStream,
    streamConfig: isStream ? parseStreamConfig(c.get("streamConfig")) : undefined,
  });
});

// ── Renaming ─────────────────────────────────────────────────────────
// Two routes rather than one PATCH taking both fields: the handle and
// the display name have different validation, different cooldowns and
// different failure modes, and an all-or-nothing write would mean a
// handle sitting on cooldown also blocks fixing the display name — which
// is the one people actually urgently want gone.
//
// blockStream on both. The guard's own comment used to say account
// settings were unreachable to a stream session because they went
// through Better Auth; these don't, so the guard has to be explicit or a
// leaked OBS link could rename the account it was lent.

// PATCH /api/profile/me/display-name — the name chat and the trainer
// directory print. For a Google signup this is the account holder's real
// name, taken off the OAuth profile and published to 2,000+ strangers
// without anyone ever being asked. Changing it is the fix for that, so
// it gets the shorter cooldown of the two.
app.patch("/me/display-name", requireUser, blockStream, async (c) => {
  const me = c.get("user");
  if (!renameLimiter.consume(`rename:${me.id}`)) {
    return c.json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const checked = validateDisplayName(body?.name);
  if (isRejection(checked)) {
    return c.json({ error: checked.code, message: checked.message }, 400);
  }
  const { name } = checked;

  const current = await prisma.user.findUnique({
    where: { id: me.id },
    select: { name: true, nameChangedAt: true },
  });
  if (!current) return c.json({ error: "user_not_found" }, 404);
  // Re-submitting the name you already have is a no-op, not a change —
  // it must not burn the cooldown.
  if (current.name === name) return c.json({ ok: true, name });

  const waitMs = cooldownRemainingMs(current.nameChangedAt, DISPLAY_NAME_COOLDOWN_MS);
  if (waitMs > 0) {
    return c.json({
      error: "cooldown",
      retryAfterMs: waitMs,
      allowedAt: new Date(Date.now() + waitMs).toISOString(),
      message: "You've already changed your display name recently. Try again later.",
    }, 429);
  }

  // Chat renders `name ?? username`, so a display name that IS somebody
  // else's handle reads in the message list as that player talking. A
  // leading @ is stripped first because "@clebslight" is the same claim,
  // written the way the game itself prints handles. Exact match only —
  // this catches the blunt version, which is the one that actually fools
  // a reader glancing at a chat row.
  const clash = await prisma.user.findFirst({
    where: { username: name.toLowerCase().replace(/^@+/, ""), NOT: { id: me.id } },
    select: { id: true },
  });
  if (clash) {
    return c.json({
      error: "name_taken_by_handle",
      message: "That display name belongs to another trainer's username.",
    }, 409);
  }

  await prisma.user.update({
    where: { id: me.id },
    data: { name, nameChangedAt: new Date() },
  });
  // Same ledger every other account mutation lands in — the actor here is
  // the account owner rather than an admin, which is what makes the row
  // worth having: an impersonation report is unanswerable without knowing
  // who was calling themselves what, and when.
  void audit(me.id, "user.display_name_change", me.id, { from: current.name, to: name });
  return c.json({ ok: true, name });
});

// PATCH /api/profile/me/username — the public @handle.
//
// Longer cooldown than the display name because this is the identity
// everything else keys off: friend requests, trainer-card lookups, and
// the client-side mute list (game/src/utils/mute.ts stores usernames, so
// a rename does drop existing mutes — that is the price of letting people
// out of an assigned name, and the cooldown is what stops it being a
// weekly harassment tactic).
app.patch("/me/username", requireUser, blockStream, async (c) => {
  const me = c.get("user");
  if (!renameLimiter.consume(`rename:${me.id}`)) {
    return c.json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as { username?: unknown } | null;
  const checked = validateUsername(body?.username);
  if (isRejection(checked)) {
    return c.json({ error: checked.code, message: checked.message }, 400);
  }
  const { username, displayUsername } = checked;

  const current = await prisma.user.findUnique({
    where: { id: me.id },
    select: { username: true, usernameChangedAt: true },
  });
  if (!current) return c.json({ error: "user_not_found" }, 404);
  if (current.username === username) return c.json({ ok: true, username });

  const waitMs = cooldownRemainingMs(current.usernameChangedAt, USERNAME_COOLDOWN_MS);
  if (waitMs > 0) {
    return c.json({
      error: "cooldown",
      retryAfterMs: waitMs,
      allowedAt: new Date(Date.now() + waitMs).toISOString(),
      message: "You've already changed your username recently. Try again later.",
    }, 429);
  }

  const taken = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (taken) {
    return c.json({ error: "username_taken", message: "That username is already taken." }, 409);
  }

  // Which denormalised copies of the old handle get rewritten, and which
  // deliberately do not:
  //
  //   GiveawayEntry.username  REWRITTEN. Winners are published to every
  //                           player (routes/giveaways.ts), so leaving the
  //                           old handle here re-broadcasts the very name
  //                           the player just renamed away from. Its
  //                           schema comment is about surviving account
  //                           DELETION, not about preserving history.
  //   PollVote.username       REWRITTEN. Same reasoning, and a vote is
  //                           live state anyway — it can be changed until
  //                           the poll closes.
  //   TournamentEntry         REWRITTEN only for events that have not been
  //                           bracketed yet. Those rosters are public and
  //                           still just a sign-up sheet. Once a bracket
  //                           exists the handle is also baked into the
  //                           bracket JSON that lib/tournamentRunner.ts is
  //                           actively driving, and rewriting an event
  //                           mid-round to fix a label is not a trade
  //                           worth making.
  //   TradeRecord, PvpMatch,  LEFT ALONE. Every one of these carries a
  //   Tournament.champion*,   schema comment saying the snapshot exists so
  //   ErrorLog, BugReport     a later rename does not rewrite history, and
  //                           they are either forensic or visible only to
  //                           the counterparty who was already there.
  const pendingTournaments = await prisma.tournament.findMany({
    where: { status: { in: ["open", "scheduled"] } },
    select: { id: true },
  });
  const pendingIds = pendingTournaments.map((t) => t.id);

  try {
    // One transaction so a player is never half-renamed — a public
    // winners list naming an account that no longer answers to that
    // handle is worse than the rename simply failing and being retried.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: me.id },
        // displayUsername keeps the casing they typed, which is Better
        // Auth's own invariant for the username plugin: it looks sign-ins
        // up by the lowercase column.
        data: { username, displayUsername, usernameChangedAt: new Date() },
      }),
      prisma.giveawayEntry.updateMany({ where: { userId: me.id }, data: { username } }),
      prisma.pollVote.updateMany({ where: { userId: me.id }, data: { username } }),
      ...(pendingIds.length > 0
        ? [prisma.tournamentEntry.updateMany({
            where: { userId: me.id, tournamentId: { in: pendingIds } },
            data: { username },
          })]
        : []),
    ]);
  } catch (e) {
    // P2002 is losing the race on the unique index — somebody took the
    // handle between the check above and the write, which is the same
    // answer to the player either way. Anything else is a real failure
    // and belongs in the error log, not disguised as a taken name.
    if ((e as { code?: string })?.code === "P2002") {
      return c.json({ error: "username_taken", message: "That username is already taken." }, 409);
    }
    throw e;
  }

  void audit(me.id, "user.username_change", me.id, { from: current.username, to: username });
  return c.json({ ok: true, username });
});

// GET /api/profile/:username — public profile (no email).
app.get("/:username", requireUser, async (c) => {
  const username = c.req.param("username");
  const u = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      name: true,
      image: true,
      accountLevel: true,
      totalCaughtLevels: true,
      pokedexCaughtCount: true,
      createdAt: true,
      lastSeenAt: true,
    },
  });
  if (!u) return c.json({ error: "user not found" }, 404);
  return c.json(u);
});

export default app;
