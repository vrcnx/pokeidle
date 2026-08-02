// Binding a Discord account to a game account.
//
// ── THE SHAPE OF THE FLOW, AND WHY IT IS THIS WAY ───────────────────
// A player runs /link in Discord. The bot asks us for a short-lived code and
// DMs it to them. The player, ALREADY SIGNED IN ON THE SITE, submits that code
// at pokeidle.com/link-discord. We resolve the code to the Discord id that
// requested it and write the row.
//
// The direction matters. The code travels Discord → player → site, so the
// thing being proven is "the human holding this game session also controls
// that Discord account". The game session is the strong credential (Better
// Auth, first-party cookie, single-active-session enforced); the Discord side
// only has to demonstrate possession of a secret we handed to exactly one
// Discord user over a private channel.
//
// Running it the other way — mint the code on the site, type it into Discord —
// would look symmetrical and is worse: the bot would then be the thing
// accepting a secret in a channel where a message can be read by a server
// admin, a bot with message intent, or anyone in the channel if the player
// mistypes the command into public chat. A DM from us is the narrower pipe.
//
// ── WHY THE CODE STORE IS IN MEMORY ─────────────────────────────────
// A lost code costs one re-run of /link. That is the entire failure mode: no
// data is lost, nothing is half-written, and the player is not blocked from
// anything they could do a minute earlier. Persisting these would mean a table
// whose rows are garbage within ten minutes, a sweeper to delete them, and a
// migration — to protect against an outcome whose remedy is typing /link
// again.
//
// This is the same single-instance assumption lib/rateLimit.ts documents. If
// the server ever runs multiple replicas, a code minted on replica A will not
// redeem on replica B and the flow degrades to "sometimes you have to run
// /link twice", which is annoying rather than dangerous. Move it to the
// database at that point, not before.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────
// It does not touch saveData, it does not grant anything, and it has no
// concept of a Discord role. Binding an identity and acting on that identity
// are separate concerns, and keeping them separate is what makes it possible
// to say that /link cannot move a Pokémon.

import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/** How long a minted code stays redeemable. Long enough to alt-tab, find the
 *  DM, open the site and sign in if you weren't already; short enough that a
 *  code shoulder-surfed off a stream is dead before it is useful. */
export const LINK_CODE_TTL_MS = 10 * 60_000;

/**
 * Code alphabet, chosen for TRANSCRIPTION rather than entropy. The player is
 * reading this off a Discord DM and typing it into a different application, so
 * every character that has a lookalike is removed: no O/0, no I/1/L, no U/V.
 * What is left is 26 symbols, and 6 of them is ~3.1e8 possibilities.
 *
 * That is not a lot by cryptographic standards and it does not need to be. A
 * code is single-use, expires in ten minutes, is bound to one Discord id, and
 * redemption is rate-limited per session (see routes/discord.ts). An attacker
 * guessing at the limiter's ceiling gets through a rounding error of the
 * keyspace before every outstanding code has expired — and the prize for
 * winning is binding THEIR OWN Discord account to a game account they are
 * already signed into, which is what /link does anyway.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZ23456789";
const CODE_LENGTH = 6;

/**
 * Delete every expired code. Called on mint, so there is no sweeper job.
 *
 * Best-effort by contract: a failed sweep leaves inert rows behind, because
 * every read filters on `expiresAt` anyway. It must never stop a code being
 * issued — housekeeping that can break the feature it tidies up after is worse
 * than the untidiness.
 */
async function sweep(): Promise<void> {
  await prisma.discordLinkCode.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}

function newCode(): string {
  let out = "";
  // randomInt, not Math.random: this is a secret, and the cost of a CSPRNG for
  // six characters is nothing.
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Normalise player-typed input before it is looked up: uppercase, and remove
 * whitespace and the separators people insert into a grouped code. "abc-234",
 * "ABC 234" and "abc234" all resolve to the same six characters.
 *
 * ── WHY IT ONLY STRIPS SEPARATORS, NOT "ANYTHING INVALID" ───────────
 * The obvious version drops every character outside the alphabet. It looks
 * more forgiving and it is actively dangerous: "Code: ABC234" normalises to
 * "CDEABC" under that rule, because C, D and E are themselves perfectly valid
 * code characters. That is not a failed lookup — it is a CONFIDENT lookup of a
 * DIFFERENT code, and against a large enough set of outstanding codes it
 * eventually hits one belonging to somebody else. Prose must never be
 * silently reinterpreted as a secret.
 *
 * So anything that is not a separator is left exactly as typed, and a code
 * with a stray character in it simply fails to match. "That code doesn't look
 * right" is the correct outcome for input that is not a code.
 *
 * There is deliberately no lookalike substitution either, and the alphabet is
 * why it is unnecessary: 0, O, 1, I and L are ALL excluded, so a minted code
 * can never contain either member of a confusable pair.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s\-_]+/g, "").slice(0, CODE_LENGTH);
}

/**
 * Mint a code for a Discord user. Replaces any code they already hold.
 *
 * Returns the code itself — the caller (routes/bot.ts) hands it to the bot,
 * which DMs it. It is never logged: a code in a log line is a code in whatever
 * ships those logs.
 */
export async function mintLinkCode(
  discordId: string,
  discordLabel: string,
): Promise<{ code: string; expiresAt: number } | { error: "capacity" }> {
  // Housekeeping, never fatal. See sweep().
  await sweep().catch(() => undefined);

  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  const label = discordLabel.slice(0, 64);

  // The upsert is keyed on discordId, so minting REPLACES this user's previous
  // code rather than leaving a second one live. That used to need a lookaside
  // map; it is now a unique constraint, which cannot drift out of sync.
  //
  // The loop is for the OTHER collision: a freshly generated code that happens
  // to equal a different user's live code. Astronomically unlikely, and the
  // consequence if unhandled is severe — one player's code silently rebinding
  // another's pending link — so it is retried rather than reasoned about. The
  // database is what detects it now, instead of a `has()` check that raced.
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = newCode();
    try {
      await prisma.discordLinkCode.upsert({
        where: { discordId },
        create: { code, discordId, discordLabel: label, expiresAt },
        update: { code, discordLabel: label, expiresAt },
      });
      return { code, expiresAt: expiresAt.getTime() };
    } catch (e) {
      const collided =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        String((e.meta as { target?: unknown } | undefined)?.target ?? "").includes("code");
      if (!collided) throw e;
    }
  }
  return { error: "capacity" };
}

/**
 * Look up a live code WITHOUT consuming it.
 *
 * The expiry is part of the WHERE rather than checked afterwards, so an expired
 * row is invisible to every caller even if the sweep has not run — the sweep
 * reclaims space, it is not what enforces the TTL.
 *
 * The old in-memory version compared with timingSafeEqual. That is gone with
 * the Map, and its absence is not a regression: this is now a primary-key
 * lookup, so the database is matching an exact value rather than walking
 * candidates, and there is no per-candidate timing for an attacker to steer.
 */
async function findCode(raw: string): Promise<{ discordId: string; discordLabel: string } | null> {
  const code = normalizeCode(raw);
  // A short or malformed input can never be a real code, and refusing it here
  // saves a query per keystroke from the peek-as-you-type field.
  if (code.length !== CODE_LENGTH) return null;
  const row = await prisma.discordLinkCode.findFirst({
    where: { code, expiresAt: { gt: new Date() } },
    select: { discordId: true, discordLabel: true },
  });
  return row ?? null;
}

/** What a pending code is FOR, so the site can name the Discord account before
 *  the player commits. Does not consume the code.
 *
 *  This is the guard against the accident nobody plans for: a mistyped code
 *  that happens to match a stranger's live one shows the STRANGER'S handle on
 *  the confirm screen, and a human notices that before pressing the button. */
export async function peekLinkCode(raw: string): Promise<{ discordLabel: string } | null> {
  const found = await findCode(raw);
  return found ? { discordLabel: found.discordLabel } : null;
}

export type RedeemResult =
  | { ok: true; discordId: string; discordLabel: string }
  | { ok: false; reason: "unknown_code" | "account_already_linked" | "discord_already_linked" };

/**
 * Consume a code and write the binding.
 *
 * ── WHY THE CODE IS CONSUMED BEFORE THE WRITE, NOT AFTER ────────────
 * The code is deleted from the map the moment it resolves, and it is not put
 * back if the database write then fails. That is deliberate: a code that
 * survives a failed redeem is a code an attacker can retry, and the failure
 * modes below are all PERMANENT for that (code, account) pair anyway —
 * "already linked" does not become false by trying again. The player's remedy
 * is /unlink or a fresh /link, both of which are one command.
 *
 * ── WHY THE UNIQUE VIOLATIONS ARE CAUGHT RATHER THAN PRE-CHECKED ────
 * There is a pre-check below, and it exists only to produce a good error
 * message. It is not the guard. Two browser tabs submitting two codes for the
 * same account, or one Discord account racing itself, both pass a check-then-
 * insert and are stopped by the constraints instead — see the migration for
 * why one-to-one is enforced by the database. P2002 here means "the check
 * missed a race", and it maps to the same message the check would have given.
 */
export async function redeemLinkCode(raw: string, userId: string): Promise<RedeemResult> {
  const found = await findCode(raw);
  if (!found) return { ok: false, reason: "unknown_code" };

  // Consume first, and let the DELETE be what decides. Two requests carrying
  // the same code both find the row; only one deleteMany reports a count of 1,
  // and the loser is told the code is unknown — which by then it is. This is
  // the single-use guarantee, and it is now enforced by the database rather
  // than by the gap between a Map read and a Map delete.
  const consumed = await prisma.discordLinkCode.deleteMany({
    where: { code: normalizeCode(raw) },
  });
  if (consumed.count === 0) return { ok: false, reason: "unknown_code" };

  const { discordId, discordLabel } = found;

  // Idempotence: this exact binding already exists. Report success rather than
  // a conflict — the player asked for a state that is already true, and
  // telling them it failed would send them to /unlink for no reason.
  const existing = await prisma.discordLink.findUnique({ where: { discordId } });
  if (existing) {
    if (existing.userId === userId) return { ok: true, discordId, discordLabel };
    return { ok: false, reason: "discord_already_linked" };
  }
  const mine = await prisma.discordLink.findUnique({ where: { userId } });
  if (mine) return { ok: false, reason: "account_already_linked" };

  try {
    await prisma.discordLink.create({ data: { discordId, userId } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Which constraint lost tells the player which side to unlink from.
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "");
      return {
        ok: false,
        reason: target.includes("userId") ? "account_already_linked" : "discord_already_linked",
      };
    }
    throw e;
  }

  return { ok: true, discordId, discordLabel };
}

/** The game account behind a Discord id, or null. The bot's every read starts
 *  here. */
export async function userIdForDiscord(discordId: string): Promise<string | null> {
  const row = await prisma.discordLink.findUnique({
    where: { discordId },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/** The Discord id bound to a game account, or null. Used by the role
 *  reconciler and by the giveaway announcer. */
export async function discordIdForUser(userId: string): Promise<string | null> {
  const row = await prisma.discordLink.findUnique({
    where: { userId },
    select: { discordId: true },
  });
  return row?.discordId ?? null;
}

/**
 * Sever a binding from the Discord side. `/unlink` must work from Discord
 * alone — a player who has lost access to their game account still needs to be
 * able to free their Discord account for a new one, and requiring a signed-in
 * session to unlink would strand exactly the people who most need it.
 *
 * Safe to call for an unlinked user: deleteMany reports 0 rather than throwing,
 * so the bot can answer "you weren't linked" without a pre-check round trip.
 */
export async function unlinkDiscord(discordId: string): Promise<{ removed: boolean }> {
  const res = await prisma.discordLink.deleteMany({ where: { discordId } });
  return { removed: res.count > 0 };
}

/** Sever from the game side, for the site's account settings and for admin
 *  tooling. Same idempotent shape. */
export async function unlinkUser(userId: string): Promise<{ removed: boolean }> {
  const res = await prisma.discordLink.deleteMany({ where: { userId } });
  return { removed: res.count > 0 };
}

/** Test seam: drop every outstanding code. Not exported to any route — the
 *  code store has no admin surface, deliberately, because a "list pending
 *  codes" endpoint is a list of live secrets, and an admin who can read a
 *  pending code can bind any player's Discord account to their own. */
export async function _resetCodesForTest(): Promise<void> {
  await prisma.discordLinkCode.deleteMany({});
}
