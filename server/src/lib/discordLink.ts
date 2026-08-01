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

import { randomInt, timingSafeEqual } from "node:crypto";
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
 * Ceiling on simultaneously-outstanding codes. Purely a memory bound against a
 * bot bug (or a compromised BOT_TOKEN) hammering /link/start: each entry is a
 * few dozen bytes, so this cap is measured in kilobytes and will never be
 * reached by real use — the Discord server would have to have thousands of
 * people mid-link at the same instant.
 *
 * At the ceiling we sweep and then refuse, rather than evicting the oldest.
 * Evicting would mean a player who did everything right gets "unknown code"
 * because someone else's spam pushed theirs out.
 */
const MAX_OUTSTANDING_CODES = 5_000;

interface PendingCode {
  discordId: string;
  /** Display label ("name#0001" or the modern @handle), carried only so the
   *  confirmation page can say WHICH Discord account is about to be bound.
   *  Never persisted — it is a display string that Discord lets people change,
   *  and the snowflake is the identity. */
  discordLabel: string;
  expiresAt: number;
}

/** code → who asked for it. */
const codes = new Map<string, PendingCode>();
/** discordId → their current code, so re-running /link REPLACES rather than
 *  accumulates. Without this, a player who runs /link five times leaves five
 *  live codes, four of which they have forgotten about and any of which still
 *  binds their account. */
const codeByDiscordId = new Map<string, string>();

function sweep(now: number): void {
  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) {
      codes.delete(code);
      if (codeByDiscordId.get(entry.discordId) === code) {
        codeByDiscordId.delete(entry.discordId);
      }
    }
  }
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
export function mintLinkCode(
  discordId: string,
  discordLabel: string,
): { code: string; expiresAt: number } | { error: "capacity" } {
  const now = Date.now();
  sweep(now);
  if (codes.size >= MAX_OUTSTANDING_CODES) return { error: "capacity" };

  // Drop the previous code for this Discord user first, so exactly one is live.
  const prev = codeByDiscordId.get(discordId);
  if (prev) codes.delete(prev);

  // Collision is astronomically unlikely but not impossible, and a collision
  // would silently rebind someone else's pending link. Re-roll rather than
  // reason about the odds.
  let code = newCode();
  let guard = 0;
  while (codes.has(code) && guard++ < 20) code = newCode();
  if (codes.has(code)) return { error: "capacity" };

  const expiresAt = now + LINK_CODE_TTL_MS;
  codes.set(code, { discordId, discordLabel: discordLabel.slice(0, 64), expiresAt });
  codeByDiscordId.set(discordId, code);
  return { code, expiresAt };
}

/**
 * Look up a code WITHOUT consuming it, in constant time with respect to the
 * code's value.
 *
 * The constant-time compare is not really about this map — a Map lookup's
 * timing does not leak a secret an attacker can steer. It is here because the
 * obvious future edit is "also let an admin peek at a pending code", and the
 * habit of comparing secrets with timingSafeEqual is cheaper to keep than to
 * re-establish.
 */
function findCode(code: string): { code: string; entry: PendingCode } | null {
  const now = Date.now();
  const wanted = Buffer.from(code);
  for (const [candidate, entry] of codes) {
    if (entry.expiresAt <= now) continue;
    const buf = Buffer.from(candidate);
    if (buf.length !== wanted.length) continue;
    if (timingSafeEqual(buf, wanted)) return { code: candidate, entry };
  }
  return null;
}

/** What a pending code is FOR, so the site can name the Discord account before
 *  the player commits. Does not consume the code. */
export function peekLinkCode(raw: string): { discordLabel: string } | null {
  const found = findCode(normalizeCode(raw));
  return found ? { discordLabel: found.entry.discordLabel } : null;
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
  const found = findCode(normalizeCode(raw));
  if (!found) return { ok: false, reason: "unknown_code" };

  // Consume first. See above.
  codes.delete(found.code);
  if (codeByDiscordId.get(found.entry.discordId) === found.code) {
    codeByDiscordId.delete(found.entry.discordId);
  }

  const { discordId, discordLabel } = found.entry;

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
 *  codes" endpoint is a list of live secrets. */
export function _resetCodesForTest(): void {
  codes.clear();
  codeByDiscordId.clear();
}
