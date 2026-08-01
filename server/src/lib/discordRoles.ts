// Which Discord roles each linked player SHOULD have.
//
// ── WHY THE GAME SERVER DOES NOT TALK TO DISCORD ────────────────────
// This module computes desired state and stops. It holds no Discord token,
// opens no connection to Discord, and knows no role ids — it emits role NAMES
// and the bot maps those to its guild's ids.
//
// That split is deliberate. The bot already needs a Discord token, so putting
// a second one on the game server would double the number of places a
// credential can leak while buying nothing. It also means a Discord outage is
// invisible here: the game server has no request to fail, no timeout to
// absorb, and no retry queue to grow. The renderer split works the same way —
// the game server publishes state, the external service acts on it.
//
// ── WHY RECONCILE INSTEAD OF FIRING EVENTS ──────────────────────────
// The naive design is an event: someone takes #1, we tell the bot to move the
// Champion role. Every one of those events is a message that can be lost — the
// bot was redeploying, Discord rate-limited the call, the process restarted
// mid-handler — and a lost event leaves a WRONG role in place permanently,
// with nothing that will ever notice.
//
// So there are no events. The bot asks "what should be true?" on a timer and
// makes it true. A missed pass costs one interval of staleness and then
// self-heals, which is the difference between a bug and a blip.
//
// The shape is borrowed from lib/tournamentRunner.ts, which sweeps for the
// same reason: acting only on live events assumes everyone is present at the
// moment something happens, and at this population nobody is.

import { prisma } from "../db.js";

/**
 * Role NAMES, not ids. The bot resolves these against its guild.
 *
 * Strings rather than an enum because the bot is a separate deploy on a
 * separate release cadence: an unknown role name must be something it can log
 * and skip, not a parse failure that takes the whole reconcile pass down.
 */
export const ROLE_TRAINER = "Trainer";
export const ROLE_CHAMPION = "Champion";
export const ROLE_ACE_TRAINER = "Ace Trainer";

/**
 * The Ace Trainer bar.
 *
 * ACCOUNT LEVEL, not PvP rating, and the reason is in routes/pvp.ts: the
 * leaderboard's `minMatches` default was lowered from 5 to 1 because the
 * maximum matchesPlayed across every PlayerRating row in production was 1 —
 * the stricter filter returned an empty board. A rating-gated role would have
 * the same problem in a worse place: a reward nobody can earn, awarded by a
 * job that always finds nobody, which looks identical to a broken job.
 *
 * Account level is the metric the whole population actually moves.
 *
 * Env-tunable because the right number is a product decision that wants
 * measuring against the real level distribution, not a constant someone
 * guessed while writing the reconciler. The default is deliberately reachable:
 * a role nobody has is not a role.
 */
export const ACE_TRAINER_MIN_LEVEL = Math.max(
  1,
  parseInt(process.env.DISCORD_ACE_TRAINER_LEVEL ?? "25", 10) || 25,
);

/**
 * Minimum rated matches before the Champion role is awarded at all.
 *
 * Without a floor, "#1 on the ladder" at this population is whoever most
 * recently won a single game — the ladder's own leaderboard shows provisional
 * ratings for exactly that reason. A Champion role that changes hands on one
 * match is noise, and worse, it repeatedly strips the role from someone who
 * did nothing wrong.
 */
export const CHAMPION_MIN_MATCHES = Math.max(
  1,
  parseInt(process.env.DISCORD_CHAMPION_MIN_MATCHES ?? "5", 10) || 5,
);

export interface DesiredMember {
  discordId: string;
  userId: string;
  username: string;
  accountLevel: number;
  /** Every role this member should hold. The bot adds what is missing and
   *  removes any MANAGED role not in this list — see `managedRoles`. */
  roles: string[];
}

export interface DesiredRoles {
  v: number;
  /**
   * The roles this system OWNS. Anything outside this list the bot must not
   * touch, ever.
   *
   * This is the single most important field in the payload. Without it a
   * reconciler's natural implementation — "remove every role not in the
   * desired set" — would strip Moderator, Admin, colour roles, pronoun roles
   * and everything else a member picked up in #get-roles, on its first pass,
   * across the whole server. The bot's remove step is scoped to this list.
   */
  managedRoles: string[];
  /** Who currently holds Champion, if anyone. Carried separately so the bot
   *  can log a handover rather than inferring it from a diff. */
  champion: { username: string; discordId: string } | null;
  aceTrainerMinLevel: number;
  members: DesiredMember[];
  computedAt: string;
}

const DESIRED_ROLES_VERSION = 1;

/**
 * Compute the full desired role state for every LINKED account.
 *
 * Bounded by the number of linked accounts — a Discord-server-sized number,
 * not a player-base-sized one — so this is a small query even though it looks
 * like a full scan. It runs on the bot's reconcile interval (minutes), not per
 * request.
 */
export async function desiredRoles(): Promise<DesiredRoles> {
  const now = new Date();

  const links = await prisma.discordLink.findMany({
    select: {
      discordId: true,
      userId: true,
      user: {
        select: { username: true, accountLevel: true, bannedUntil: true },
      },
    },
  });

  // Current #1, subject to the match floor. One row, ordered exactly like the
  // in-game leaderboard's primary key so the two can never disagree about who
  // is on top.
  const top = await prisma.playerRating.findFirst({
    where: { matchesPlayed: { gte: CHAMPION_MIN_MATCHES } },
    orderBy: [{ rating: "desc" }, { matchesPlayed: "desc" }],
    select: { userId: true },
  });

  let champion: DesiredRoles["champion"] = null;

  const members: DesiredMember[] = [];
  for (const link of links) {
    const u = link.user;
    // A banned account holds NO managed roles. Not "loses Champion" — loses
    // everything this system grants, including Trainer, so a banned player
    // stops appearing as a member in good standing in a public server. The row
    // is left alone: unlinking on ban would make the ban un-appealable from
    // the player's side and would silently free their Discord account to bind
    // a fresh alt.
    const banned = !!u.bannedUntil && u.bannedUntil > now;
    if (banned) {
      members.push({
        discordId: link.discordId,
        userId: link.userId,
        username: u.username,
        accountLevel: u.accountLevel,
        roles: [],
      });
      continue;
    }

    const roles: string[] = [ROLE_TRAINER];
    if (u.accountLevel >= ACE_TRAINER_MIN_LEVEL) roles.push(ROLE_ACE_TRAINER);
    if (top && top.userId === link.userId) {
      roles.push(ROLE_CHAMPION);
      champion = { username: u.username, discordId: link.discordId };
    }

    members.push({
      discordId: link.discordId,
      userId: link.userId,
      username: u.username,
      accountLevel: u.accountLevel,
      roles,
    });
  }

  return {
    v: DESIRED_ROLES_VERSION,
    // Champion is listed even when nobody holds it. That is what makes the
    // handover work: the bot removes a managed role from anyone not in the
    // desired set, so the PREVIOUS champion is stripped by the same pass that
    // grants the new one, with no event and no memory of who held it before.
    managedRoles: [ROLE_TRAINER, ROLE_CHAMPION, ROLE_ACE_TRAINER],
    champion,
    aceTrainerMinLevel: ACE_TRAINER_MIN_LEVEL,
    members,
    computedAt: now.toISOString(),
  };
}
