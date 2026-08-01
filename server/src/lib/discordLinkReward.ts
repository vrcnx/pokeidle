// The "link your Discord, get a prize" promotion.
//
// Kept out of lib/discordLink.ts on purpose. That module binds an identity and
// says so in its header — that binding an identity and ACTING on it are
// separate concerns, and keeping them apart is what lets us state plainly that
// /link cannot move a Pokémon. This module is the acting half, and it acts the
// only way anything in this codebase is allowed to: by enqueuing a
// PendingGrant.
//
// ══ IDEMPOTENCY WITHOUT A NEW TABLE ═════════════════════════════════
//
// The obvious design is a `rewardedAt` column on DiscordLink. It does not
// work: that row is DELETED on /unlink, so unlink-then-relink would pay again,
// forever, from one Discord account.
//
// The next design is a separate table that survives unlink. That works and is
// a migration plus a model plus a cleanup story.
//
// Neither is needed, because the ledger already exists. PendingGrant is
// append-only — nothing deletes a row, delivered or not — and it carries both
// `userId` and an indexed `(source, sourceId)`. So a grant stamped
// `source: "discord-link", sourceId: <discordId>` IS the record that this
// Discord account has claimed, and the same row's `userId` IS the record that
// this game account has. Two counts, both index-backed, no new state:
//
//     userId  matched → this GAME account already claimed
//     sourceId matched → this DISCORD account already claimed
//
// Both survive unlink, relink, rebinding to a different account, and a server
// restart, because the grant is the receipt. The only thing that clears it is
// deleting the game account, which cascades the grants away — and at that
// point there is nothing left to double-pay.
//
// ── ON ALT FARMING ──────────────────────────────────────────────────
// The two checks above block one Discord account claiming twice and one game
// account being claimed for twice. They do NOT stop somebody making N throwaway
// Discord accounts and N throwaway game accounts for N rewards; nothing short
// of an eligibility gate does, and the product decision was to ship without
// one to make the promotion as frictionless as possible.
//
// MIN_ACCOUNT_LEVEL exists and defaults to 0 (off) so that decision can be
// revisited with an env var rather than a deploy, if farming shows up in the
// grant ledger. `SELECT count(*) FROM "PendingGrant" WHERE source =
// 'discord-link'` grouped by day is how you would see it.

import { prisma } from "../db.js";
import { parsePrizesStrict, describePrizes, type Prize } from "./giveaway.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import { recordError } from "./errorReporting.js";

export const LINK_REWARD_SOURCE = "discord-link";

/**
 * Optional eligibility gate, in account levels. 0 disables it, which is the
 * default and the shipped behaviour. See the note above.
 */
const MIN_ACCOUNT_LEVEL = Math.max(
  0,
  parseInt(process.env.DISCORD_LINK_REWARD_MIN_LEVEL ?? "0", 10) || 0,
);

/**
 * The prize, as a JSON Prize[] in the env.
 *
 * Parsed once, lazily, with parsePrizesStrict — the STRICT reader, because
 * this is operator input that has never been validated, and the lenient one is
 * only for rows we validated on the way in. A malformed value disables the
 * promotion and logs, rather than throwing on every link attempt.
 *
 * Unset or empty → the promotion is off and linkReward() is a no-op. That is
 * the default, so a deploy that has never heard of this feature does nothing.
 */
let cached: { prizes: Prize[] | null } | null = null;

export function linkRewardPrizes(): Prize[] | null {
  if (cached) return cached.prizes;
  const raw = process.env.DISCORD_LINK_REWARD?.trim();
  if (!raw) {
    cached = { prizes: null };
    return null;
  }
  const parsed = parsePrizesStrict(raw);
  if (!parsed.ok) {
    console.error(
      `[discord-link-reward] DISCORD_LINK_REWARD is set but invalid (${parsed.reason}) — ` +
        "the link reward is DISABLED. Expected a JSON Prize array, e.g. " +
        '[{"kind":"item","itemId":"masterball","quantity":1}]',
    );
    cached = { prizes: null };
    return null;
  }
  cached = { prizes: parsed.prizes };
  return parsed.prizes;
}

/** Test seam — the env is read once and cached, so a test that changes it
 *  needs a way to invalidate. */
export function _resetLinkRewardCache(): void {
  cached = null;
}

export type LinkRewardResult =
  | { granted: true; summary: string }
  | { granted: false; reason: "disabled" | "already_claimed" | "below_min_level" | "failed" };

/**
 * Pay the link reward, once, if it is owed.
 *
 * Best-effort by contract: the CALLER has already written the DiscordLink row
 * and must report success regardless of what happens here. A promotion that
 * fails is a missing Master Ball; a link that fails because a promotion threw
 * is a player who cannot use any of the bot. Those are not the same size of
 * problem, so this never throws.
 */
export async function grantLinkReward(
  userId: string,
  discordId: string,
): Promise<LinkRewardResult> {
  const prizes = linkRewardPrizes();
  if (!prizes || prizes.length === 0) return { granted: false, reason: "disabled" };

  try {
    if (MIN_ACCOUNT_LEVEL > 0) {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { accountLevel: true },
      });
      if ((u?.accountLevel ?? 0) < MIN_ACCOUNT_LEVEL) {
        return { granted: false, reason: "below_min_level" };
      }
    }

    // Has this GAME account already been paid? Uses the [userId, deliveredAt]
    // index's leading column.
    const byAccount = await prisma.pendingGrant.count({
      where: { userId, source: LINK_REWARD_SOURCE },
    });
    if (byAccount > 0) return { granted: false, reason: "already_claimed" };

    // Has this DISCORD account already been paid, possibly for a different
    // game account? Exactly the [source, sourceId] index.
    const byDiscord = await prisma.pendingGrant.count({
      where: { source: LINK_REWARD_SOURCE, sourceId: discordId },
    });
    if (byDiscord > 0) return { granted: false, reason: "already_claimed" };

    await enqueuePrizeGrant(userId, prizes, {
      source: LINK_REWARD_SOURCE,
      sourceId: discordId,
    });
    return { granted: true, summary: describePrizes(prizes) };
  } catch (e) {
    // Never fatal to the link. Recorded so a promotion that is silently paying
    // nobody is visible in the error dashboard rather than only in complaints.
    void recordError({
      kind: "server",
      message: "discord_link_reward_failed",
      source: "grantLinkReward",
      userId,
      meta: { error: String((e as Error)?.message ?? e) },
    });
    return { granted: false, reason: "failed" };
  }
}
