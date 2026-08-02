import { prisma } from "../db.js";
import { parsePrizesStrict, type Prize } from "./giveaway.js";
import { LINK_REWARD_SOURCE } from "./discordLinkReward.js";

// Free rewards a player can pick up once, for doing something outside the
// game — joining the community, and whatever comes after it.
//
// ── WHY THIS EXISTS AS A LIST ───────────────────────────────────────
// The Discord link reward already worked end to end: an admin sets a prize,
// the bot DMs a code, redeeming it enqueues a PendingGrant. What was missing
// was any way for the GAME to know about it. Nothing player-facing could
// answer "is this promo running", "what is it" or "have I already had it" —
// the prize was revealed only AFTER a successful redeem, so the offer was
// invisible to exactly the players it was meant to attract.
//
// It is a list rather than a Discord endpoint because the ask was "some other
// free promotional rewards in there too". Each promo brings its own
// eligibility question — did you link Discord, did you reach a level, were
// you here for the anniversary — so each is a small resolver below, and the
// route just gathers them. Adding one is one function and one entry.
//
// ── WHAT A PROMO IS NOT ─────────────────────────────────────────────
// There is no claim button here and no claim endpoint. Every promo is
// GRANTED by the thing that proves you did it (the Discord redeem grants the
// link reward), and delivery goes through the PendingGrant inbox like every
// other prize. This surface only DESCRIBES them. A claim endpoint would be a
// second way to pay the same reward, which is how a promo gets paid twice.

export type PromoState =
  /** Not done yet, and the player can go and do it. */
  | "available"
  /** Already granted to this account. */
  | "claimed"
  /** Running, but this player cannot take it right now (level gate, etc). */
  | "locked"
  /** Switched off, or never configured. Not returned to the client at all. */
  | "off";

export interface Promo {
  id: string;
  title: string;
  /** One line explaining what to do. */
  blurb: string;
  icon: string;
  prizes: Prize[];
  state: Exclude<PromoState, "off">;
  /** Where the action lives. Null when there is nothing to press. */
  cta: { label: string; href: string } | null;
  /** Shown under a locked or claimed promo to say why. */
  note: string | null;
}

/**
 * The Discord link reward.
 *
 * Reads the same DiscordConfig row and the same PendingGrant receipt that
 * grantLinkReward does — deliberately, so the offer shown here and the grant
 * that actually happens cannot disagree. If the config says the promo is off,
 * this returns null and the card does not exist; there is no way for the
 * dialog to advertise something the grant path would refuse.
 */
async function discordLinkPromo(userId: string): Promise<Promo | null> {
  const cfg = await prisma.discordConfig.findUnique({ where: { id: "singleton" } });
  if (!cfg?.linkRewardEnabled || !cfg.linkReward?.trim()) return null;

  const parsed = parsePrizesStrict(cfg.linkReward);
  // A malformed prize list disables the promo rather than showing an empty
  // card — same call grantLinkReward makes, for the same reason.
  if (!parsed.ok || parsed.prizes.length === 0) return null;

  // The PendingGrant ledger IS the receipt. Counting it here means "claimed"
  // on this card and "already_claimed" in the grant path are the same fact
  // read the same way, rather than two guesses that drift.
  const claimed = await prisma.pendingGrant.count({
    where: { userId, source: LINK_REWARD_SOURCE },
  });

  const linked = await prisma.discordLink.findUnique({ where: { userId } });

  const state: Promo["state"] = claimed > 0 ? "claimed" : "available";

  return {
    id: "discord-link",
    title: "Join the Discord",
    blurb: "Link your account to the community server and the reward is yours.",
    icon: "discord",
    prizes: parsed.prizes,
    state,
    cta: state === "claimed" ? null : { label: "Get the code", href: "/link-discord" },
    note:
      state === "claimed"
        ? "Already collected — thanks for joining."
        // Linked but not claimed happens on accounts that linked before the
        // promo existed. Say so, rather than showing a live offer that will
        // never pay: the grant only runs on a FIRST link.
        : linked
          ? "Your Discord is already linked, so this one has passed you by."
          : null,
  };
}

/**
 * Every promo this player can see, in display order.
 *
 * Resolvers that return null are simply absent — "off" never reaches the
 * client, because a greyed-out card for a promotion that does not exist is
 * worse than no card.
 */
export async function listPromos(userId: string): Promise<Promo[]> {
  const resolved = await Promise.all([
    discordLinkPromo(userId),
  ]);
  return resolved.filter((p): p is Promo => p !== null);
}
