// "Post about us on Reddit" — a reward for a link, taken on trust.
//
// ══ NOTHING HERE VERIFIES THE POST ══════════════════════════════════
//
// Not that the link resolves, not that it is about this game, not that the
// claimant wrote it. That is an explicit product decision, and it is written
// down here rather than left to be discovered because everything below is
// shaped by it.
//
// Verifying would mean a Reddit app registration, OAuth, and a fetch per
// claim — real infrastructure to gate a promotion whose entire point is being
// frictionless. The call was to ship it open.
//
// ── SO THE DEFENCE IS NOTICING, NOT PREVENTING ──────────────────────
//
// The same argument the referral programme makes. What this file CAN do
// without verifying anything is make each claim cost something to repeat, and
// make what was actually submitted visible to an operator:
//
//   1. One claim per ACCOUNT, ever. RedditPost's primary key.
//   2. One claim per LINK. A unique index on the normalised URL, which is what
//      stops a hundred accounts pasting the same post.
//   3. The URL is stored verbatim and starts life as "pending", so an
//      unreviewed claim is honestly labelled as one and the dashboard can show
//      an operator what they are actually paying for.
//   4. The prize is items, not money — same reasoning as the Discord rank
//      ladder. A farmed consumable is a farmed consumable; farmed currency is
//      everybody's problem.
//
// None of that makes a fake claim impossible. It makes a fake claim visible,
// singular, and cheap to undo, which is the most that is available without a
// verification step nobody wants to build.

import { prisma } from "../db.js";
import { parsePrizesStrict, describePrizes, type Prize } from "./giveaway.js";
import { enqueuePrizeGrant } from "./prizeGrant.js";
import { recordError } from "./errorReporting.js";

/** Audit label on the grant. */
export const REDDIT_SOURCE = "reddit-post";

/**
 * Hosts a claim may come from.
 *
 * SHAPE CHECKING, NOT VERIFICATION, and the distinction is the whole point of
 * this list: it stops somebody pasting their own homepage or a blank string,
 * and it does not and cannot tell you whether the post exists. Anyone who
 * wants to submit `reddit.com/r/x/comments/000` still can.
 *
 * It is worth doing anyway because the alternative — accepting any text — puts
 * junk in the operator's review queue, and the queue is the actual defence.
 */
const REDDIT_HOSTS = new Set([
  "reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com",
  "np.reddit.com", "m.reddit.com", "redd.it", "www.redd.it",
]);

export interface NormalizedPost {
  /** Exactly what was submitted, for the operator to look at. */
  url: string;
  /** The comparison key. Uniqueness is enforced on this, not on `url`. */
  urlKey: string;
  /** The subreddit, when the path carries one. Analytics only — a claim with
   *  no readable subreddit is still a valid claim. */
  subreddit: string | null;
}

/**
 * Parse and normalise a submitted link, or null if it is not a Reddit URL.
 *
 * ── WHY NORMALISATION IS THE ANTI-FARM STEP ─────────────────────────
 * The unique index is only as good as the key it indexes. Without this,
 * `reddit.com/r/x/comments/abc`, the same with `?utm_source=share`, the same
 * with a trailing slash, and the same on `old.reddit.com` are four different
 * strings and therefore four claims on one post. Stripping the query, the
 * fragment, the scheme, the `www.`/`old.`/`np.` prefix and the trailing slash
 * collapses them to one.
 *
 * Share links carry a query string by default, so this is the common case
 * rather than a clever attack.
 */
export function normalizeRedditUrl(raw: string): NormalizedPost | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed.length > 500) return null;

  // Accept a bare "reddit.com/..." paste. People copy links out of address
  // bars that hide the scheme, and rejecting that is a support ticket.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!REDDIT_HOSTS.has(host)) return null;

  // Every host variant is the same site, so the key must not distinguish them.
  const canonicalHost = host.endsWith("redd.it") ? "redd.it" : "reddit.com";
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  // A bare "reddit.com" with no path is not a post.
  if (!path || path === "/") return null;

  const sub = path.match(/^\/r\/([a-z0-9_]+)/);

  return {
    url: trimmed.slice(0, 500),
    urlKey: `${canonicalHost}${path}`,
    subreddit: sub ? sub[1] : null,
  };
}

// ── Configuration ───────────────────────────────────────────────────

export interface RedditRewardConfig {
  enabled: boolean;
  prizes: Prize[];
}

/**
 * The prize, or null when the promotion is off.
 *
 * Read fresh every call and never cached, same as the Discord link reward: an
 * operator who changes a prize must see it take effect, and this is one
 * indexed row on a path a player hits at most once in their life.
 *
 * parsePrizesStrict, never the lenient reader — this row is operator input. A
 * malformed row disables the promotion and logs, rather than throwing on every
 * page load.
 */
export async function redditRewardConfig(): Promise<RedditRewardConfig> {
  const row = await prisma.redditRewardConfig
    .findUnique({ where: { id: "singleton" } })
    .catch(() => null);
  if (!row || !row.enabled) return { enabled: false, prizes: [] };

  const raw = row.prizes?.trim();
  if (!raw) return { enabled: false, prizes: [] };

  const parsed = parsePrizesStrict(raw);
  if (!parsed.ok) {
    console.error(
      `[reddit-reward] RedditRewardConfig.prizes is invalid (${parsed.reason}) — ` +
        "the promotion is DISABLED until it is fixed in the admin dashboard.",
    );
    return { enabled: false, prizes: [] };
  }
  // Enabled with no prizes is off, not "pays nothing" — a promotion that
  // advertises itself and hands over an empty grant is worse than one that is
  // not running.
  return { enabled: parsed.prizes.length > 0, prizes: parsed.prizes };
}

// ── Claiming ────────────────────────────────────────────────────────

export type ClaimResult =
  | { ok: true; summary: string }
  | { ok: false; reason: "disabled" | "bad_url" | "already_claimed" | "link_used" | "failed" };

/**
 * Take a link and pay for it, once.
 *
 * The two refusals that matter are told apart deliberately:
 *
 *   already_claimed — this ACCOUNT has had the reward. Ordinary, and the
 *                     card should say so plainly.
 *   link_used       — this LINK has been claimed by somebody else. Worth its
 *                     own message, because the honest version of it (two
 *                     housemates submitting the same thread) deserves a real
 *                     explanation rather than a shrug.
 */
export async function claimRedditPost(userId: string, rawUrl: string): Promise<ClaimResult> {
  const cfg = await redditRewardConfig();
  if (!cfg.enabled) return { ok: false, reason: "disabled" };

  const post = normalizeRedditUrl(rawUrl);
  if (!post) return { ok: false, reason: "bad_url" };

  try {
    // The row IS the claim. Written before the grant so that a duplicate loses
    // here — at a database constraint — rather than after a prize has already
    // been enqueued.
    try {
      await prisma.redditPost.create({
        data: { userId, url: post.url, urlKey: post.urlKey },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Which constraint? The account's own row answers it without a second
        // guess: if it exists, this account has claimed; if it does not, the
        // collision was on the link.
        const mine = await prisma.redditPost.findUnique({
          where: { userId },
          select: { userId: true },
        });
        return { ok: false, reason: mine ? "already_claimed" : "link_used" };
      }
      throw e;
    }

    // sourceId is the normalised link, so the (source, sourceId) index is a
    // second receipt independent of the row above — and it is the thing an
    // operator can query when asking "was this post ever paid for".
    await enqueuePrizeGrant(userId, cfg.prizes, {
      source: REDDIT_SOURCE,
      sourceId: post.urlKey,
    });

    return { ok: true, summary: describePrizes(cfg.prizes) };
  } catch (e) {
    void recordError({
      kind: "server",
      message: "reddit_reward_claim_failed",
      source: "claimRedditPost",
      userId,
      meta: { url: post.url, error: String((e as Error)?.message ?? e) },
    });
    return { ok: false, reason: "failed" };
  }
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";
}

// ── What the player sees ────────────────────────────────────────────

export interface RedditRewardStatus {
  enabled: boolean;
  claimed: boolean;
  /** The link they submitted, so the card can show it back to them. */
  url: string | null;
  prizes: Prize[];
}

export async function getRedditRewardStatus(userId: string): Promise<RedditRewardStatus> {
  const [cfg, row] = await Promise.all([
    redditRewardConfig(),
    prisma.redditPost.findUnique({ where: { userId }, select: { url: true } }),
  ]);
  return {
    enabled: cfg.enabled,
    claimed: !!row,
    url: row?.url ?? null,
    prizes: cfg.prizes,
  };
}
