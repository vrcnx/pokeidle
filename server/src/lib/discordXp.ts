// Community XP — levels earned by talking and taking part in the Discord.
//
// ══ IT IS A SEPARATE CURRENCY, AND THAT IS THE DESIGN ═══════════════
//
// XP buys Discord standing and nothing else. It does not convert into money,
// items, account level, or anything the game economy can observe. Nothing in
// this file calls enqueuePrizeGrant and nothing in it should.
//
// The alternative was considered and rejected: chat XP paying out in-game
// currency puts a faucet on the economy whose tap is "type in a text box".
// No cooldown makes that safe against somebody who wants it badly enough — you
// are one alt-account script away from arbitrary money, and the blast radius
// is inflation across every account in the game. Keeping the currencies
// separate means the worst case for an XP exploit is a wrong number on a
// leaderboard.
//
// If this ever changes, it must go through PendingGrant like every other
// payout, and this comment is the thing to argue with first.
//
// ══ THE COOLDOWN IS THE WHOLE ANTI-ABUSE STORY ══════════════════════
//
// Without it, XP measures typing speed. With it, XP measures showing up over
// time, which is the thing worth rewarding. It is enforced HERE, against a
// database column, rather than in the bot's memory — a bot-side cooldown
// resets on every redeploy and hands a free burst to anyone who notices.

import { prisma } from "../db.js";

// ── Defaults ────────────────────────────────────────────────────────
// Chosen to match what people expect from Discord levelling bots, because the
// curve being FAMILIAR matters more than it being clever — a community that
// has used MEE6 has intuitions about what level 10 means, and meeting those is
// free.

export const XP_DEFAULTS = {
  perMessageMin: 15,
  perMessageMax: 25,
  cooldownSec: 60,
} as const;

/** One-off bonuses for taking part rather than talking. Flat, and deliberately
 *  modest: they are a nudge toward joining in, not a route to the top of the
 *  board. Linking is the largest because it is the single action the whole
 *  integration exists to encourage. */
export const XP_EVENTS = {
  /** Linking a game account. Once per Discord account, enforced by the
   *  DiscordLink row existing — this is only ever called on a fresh link. */
  link: 250,
  /** Entering a giveaway. */
  giveawayEntry: 40,
  /** A bug report that was actually ingested (not chatter). */
  bugReport: 60,
  /** Posting a trade listing. */
  tradeListing: 25,
} as const;

export type XpEvent = keyof typeof XP_EVENTS;

// ── The curve ───────────────────────────────────────────────────────

/**
 * XP required to go FROM `level` TO `level + 1`.
 *
 * `5L² + 50L + 100` — the MEE6 curve, used because it is the one this
 * community's intuitions are already calibrated to. Level 1 costs 100, level
 * 10 costs 1,100, level 50 costs 15,100: slow enough that a high level means
 * something, shallow enough early that a new member sees progress on their
 * first evening.
 */
export function xpForNextLevel(level: number): number {
  const l = Math.max(0, Math.floor(level));
  return 5 * l * l + 50 * l + 100;
}

/** Total lifetime XP needed to REACH `level`. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < Math.max(0, Math.floor(level)); l++) total += xpForNextLevel(l);
  return total;
}

/**
 * Level, and progress through the current one, from lifetime XP.
 *
 * Iterative rather than a closed form: the loop is bounded by the level
 * reached (a few dozen at most in any realistic community), it is trivially
 * correct against `xpForNextLevel`, and a closed form here would be a cubic
 * root that has to be re-derived every time the curve is tuned.
 *
 * The hard bound is a safety net, not an expectation — it stops a corrupt or
 * absurd XP value from spinning forever.
 */
export function levelFromXp(xp: number): {
  level: number;
  intoLevel: number;
  neededForNext: number;
  progress: number;
} {
  const total = Math.max(0, Math.floor(xp || 0));
  let level = 0;
  let remaining = total;
  const MAX_LEVEL = 1000;
  while (level < MAX_LEVEL) {
    const need = xpForNextLevel(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  const neededForNext = xpForNextLevel(level);
  return {
    level,
    intoLevel: remaining,
    neededForNext,
    progress: neededForNext > 0 ? remaining / neededForNext : 0,
  };
}

// ── Settings ────────────────────────────────────────────────────────

export interface XpSettings {
  enabled: boolean;
  perMessageMin: number;
  perMessageMax: number;
  cooldownSec: number;
  ignoredChannels: string[];
  announceChannelId: string | null;
}

/** Read fresh every award. Same reasoning as the link reward: an operator who
 *  changes a rate must see it take effect, and this is one indexed row read on
 *  a path already bounded by a 60-second-per-user cooldown. */
export async function xpSettings(): Promise<XpSettings> {
  const cfg = await prisma.discordConfig
    .findUnique({ where: { id: "singleton" } })
    .catch(() => null);
  const min = Math.max(0, cfg?.xpPerMessageMin ?? XP_DEFAULTS.perMessageMin);
  const max = Math.max(min, cfg?.xpPerMessageMax ?? XP_DEFAULTS.perMessageMax);
  return {
    enabled: cfg?.xpEnabled ?? false,
    perMessageMin: min,
    // Clamped to >= min so a config with the two the wrong way round degrades
    // to a fixed rate rather than producing a negative range.
    perMessageMax: max,
    cooldownSec: Math.max(0, cfg?.xpCooldownSec ?? XP_DEFAULTS.cooldownSec),
    ignoredChannels: (cfg?.xpIgnoredChannels ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    announceChannelId: cfg?.xpAnnounceChannelId ?? null,
  };
}

// ── Awarding ────────────────────────────────────────────────────────

export interface XpAward {
  awarded: number;
  xp: number;
  level: number;
  /** The level BEFORE this award. A level-up is `level > previousLevel`, and
   *  the caller announces on that rather than on a flag, so a single award
   *  that crosses two levels still reads correctly. */
  previousLevel: number;
  leveledUp: boolean;
  /** Why nothing was given, when nothing was. */
  skipped?: "disabled" | "cooldown" | "ignored_channel";
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Award XP for a message.
 *
 * ── THE COOLDOWN IS A CONDITIONAL UPDATE, NOT A CHECK ───────────────
 * The read-then-write shape ("is the cooldown up? then pay") loses to two
 * messages arriving together — both read the old timestamp, both pay. Discord
 * delivers events fast enough for that to be reachable by anyone typing
 * quickly, never mind deliberately.
 *
 * So the gate is an `updateMany` with `lastAwardAt` in the WHERE clause. Only
 * one concurrent call can match, and the loser gets count 0 and pays nothing —
 * the same compare-and-swap shape PendingGrant uses for delivery, for the same
 * reason.
 */
export async function awardMessageXp(
  discordId: string,
  channelId: string,
  label: string,
): Promise<XpAward> {
  const settings = await xpSettings();
  const existing = await prisma.discordXp.findUnique({ where: { discordId } });
  const currentXp = existing?.xp ?? 0;
  const previousLevel = levelFromXp(currentXp).level;
  const idle: XpAward = {
    awarded: 0, xp: currentXp, level: previousLevel, previousLevel, leveledUp: false,
  };

  if (!settings.enabled) return { ...idle, skipped: "disabled" };
  if (settings.ignoredChannels.includes(channelId)) return { ...idle, skipped: "ignored_channel" };

  const now = new Date();
  const cutoff = new Date(now.getTime() - settings.cooldownSec * 1000);
  const amount = randomBetween(settings.perMessageMin, settings.perMessageMax);

  if (!existing) {
    // First message from this account. `create` races another first message
    // from the same account; the primary key refuses the loser, which then
    // simply misses one award — acceptable, and far simpler than a
    // transaction for a first-ever message.
    try {
      const row = await prisma.discordXp.create({
        data: { discordId, xp: amount, messages: 1, lastAwardAt: now, label },
      });
      const after = levelFromXp(row.xp);
      return {
        awarded: amount, xp: row.xp, level: after.level,
        previousLevel: 0, leveledUp: after.level > 0,
      };
    } catch {
      return { ...idle, skipped: "cooldown" };
    }
  }

  // The CAS. `lastAwardAt` must still be older than the cutoff (or null) for
  // this call to win.
  const claimed = await prisma.discordXp.updateMany({
    where: {
      discordId,
      OR: [{ lastAwardAt: null }, { lastAwardAt: { lt: cutoff } }],
    },
    data: {
      xp: { increment: amount },
      messages: { increment: 1 },
      lastAwardAt: now,
      label,
    },
  });
  if (claimed.count === 0) return { ...idle, skipped: "cooldown" };

  const after = currentXp + amount;
  const afterLevel = levelFromXp(after).level;
  return {
    awarded: amount,
    xp: after,
    level: afterLevel,
    previousLevel,
    leveledUp: afterLevel > previousLevel,
  };
}

/**
 * Award a flat participation bonus.
 *
 * NO cooldown, because each of these is already gated by something that cannot
 * repeat: a link happens once per Discord account, a giveaway entry is refused
 * as a duplicate by a unique constraint, a bug report is deduplicated on its
 * message id. The caller is responsible for only calling on the FIRST
 * occurrence — which is why every call site sits on the success branch of one
 * of those constraints.
 */
export async function awardEventXp(
  discordId: string,
  event: XpEvent,
  label?: string,
): Promise<XpAward> {
  const settings = await xpSettings();
  const existing = await prisma.discordXp.findUnique({ where: { discordId } });
  const currentXp = existing?.xp ?? 0;
  const previousLevel = levelFromXp(currentXp).level;
  if (!settings.enabled) {
    return { awarded: 0, xp: currentXp, level: previousLevel, previousLevel, leveledUp: false, skipped: "disabled" };
  }

  const amount = XP_EVENTS[event] ?? 0;
  const row = await prisma.discordXp.upsert({
    where: { discordId },
    create: { discordId, xp: amount, label: label ?? null },
    update: { xp: { increment: amount }, ...(label ? { label } : {}) },
  });
  const afterLevel = levelFromXp(row.xp).level;
  return {
    awarded: amount,
    xp: row.xp,
    level: afterLevel,
    previousLevel,
    leveledUp: afterLevel > previousLevel,
  };
}

// ── Reads ───────────────────────────────────────────────────────────

export interface XpStanding {
  discordId: string;
  label: string | null;
  xp: number;
  level: number;
  intoLevel: number;
  neededForNext: number;
  messages: number;
  /** Position on the board, 1-based. */
  rank: number;
}

export async function xpFor(discordId: string): Promise<XpStanding | null> {
  const row = await prisma.discordXp.findUnique({ where: { discordId } });
  if (!row) return null;
  const lv = levelFromXp(row.xp);
  // Rank as a COUNT of higher scores rather than by materialising the board —
  // stays correct as the server grows, where "fetch the top N and look for
  // yourself" returns nothing for everyone outside the window.
  const above = await prisma.discordXp.count({ where: { xp: { gt: row.xp } } });
  return {
    discordId: row.discordId,
    label: row.label,
    xp: row.xp,
    level: lv.level,
    intoLevel: lv.intoLevel,
    neededForNext: lv.neededForNext,
    messages: row.messages,
    rank: above + 1,
  };
}

export async function xpLeaderboard(limit: number): Promise<XpStanding[]> {
  const take = Math.min(25, Math.max(1, limit));
  const rows = await prisma.discordXp.findMany({ orderBy: { xp: "desc" }, take });
  return rows.map((r, i) => {
    const lv = levelFromXp(r.xp);
    return {
      discordId: r.discordId,
      label: r.label,
      xp: r.xp,
      level: lv.level,
      intoLevel: lv.intoLevel,
      neededForNext: lv.neededForNext,
      messages: r.messages,
      rank: i + 1,
    };
  });
}
