// The ONLY place that knows what a save blob looks like on behalf of the bot.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────
// `User.saveData` is a JSON-encoded GameState whose shape changes with most
// patches — fields appear, become optional, get renamed, change from a scalar
// to an object. The game client owns that shape and moves it freely, which is
// fine, because the client and the shape ship together.
//
// A Discord bot does not ship together with anything. It is a separate deploy
// on a separate release cadence, and if it parsed the blob directly then every
// save-shape change would silently break an embed in a public channel, at a
// time nobody was looking. So the bot never sees a save. It sees the DTOs
// below, which are versioned, defensively parsed, and small.
//
// The rule this enforces: save-shape knowledge lives in exactly one place per
// consumer. When a patch changes the blob, this file is the only thing to fix.
//
// ── WHY MOST OF IT DOES NOT TOUCH THE BLOB AT ALL ───────────────────
// Four of the six read commands never need it. `accountLevel`,
// `pokedexCaughtCount` and `dailyStreak` are real columns on User, and PvP
// numbers live in PlayerRating. Only /team and /mon genuinely require
// deserialising a multi-hundred-kilobyte string, so those are a separate
// function and the cheap path stays cheap — see botIdentity vs botParty.
//
// ── WHAT MAY NEVER APPEAR IN A RETURN VALUE HERE ────────────────────
// email, session data, the save blob verbatim, ban reasons, admin flags, the
// linked Discord id of anyone but the caller. Assume every field returned by
// this file ends up screenshotted in a public channel, because that is the
// entire purpose of the surface it feeds. Every DTO below is an explicit
// allowlist and none of them spreads a Prisma row.

import { prisma } from "../db.js";
import { pvpBadgeForRating } from "./pvpBadge.js";

/**
 * Bumped whenever a DTO below changes shape in a way a rendering bot would
 * notice. Carried on every response so a bot deployed against an older server
 * (or vice versa) can say "I don't understand this" instead of rendering
 * `undefined` into a public channel.
 *
 * 1 — initial: identity, rank, party, mon, dex.
 */
export const BOT_DTO_VERSION = 1;

// ── Reading the blob without trusting it ────────────────────────────
// Every accessor below treats the save as hostile-shaped rather than merely
// unfamiliar. It is not attacker-controlled in any meaningful sense (it went
// through validateSave on the way in), but it IS version-controlled by a
// different release train, and the failure we are avoiding is a TypeError
// thrown inside a bot command rather than a security breach.

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

function asStringArray(v: unknown): string[] {
  return asArray(v).filter((x): x is string => typeof x === "string");
}

/**
 * Parse a save blob, returning null rather than throwing on anything
 * unexpected — a corrupt or absent save must degrade to "no team to show",
 * never to a 500 that the bot renders as a red error box.
 */
function parseSave(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

// ── DTOs ────────────────────────────────────────────────────────────

export interface BotIdentity {
  v: number;
  userId: string;
  username: string;
  /** Display name. Distinct from username, and both are already public on the
   *  trainer directory. */
  name: string | null;
  accountLevel: number;
  pokedexCaughtCount: number;
  dailyStreak: number;
  longestDailyStreak: number;
  createdAt: string;
  lastSeenAt: string;
  rating: BotRating;
}

export interface BotRating {
  rating: number;
  peakRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  forfeits: number;
  /** True when this account has never played a rated match, so the numbers
   *  above are defaults rather than results. The embed must say "unranked"
   *  rather than print 1000 as though it were earned. */
  unranked: boolean;
  badge: ReturnType<typeof pvpBadgeForRating>;
  /** Position on the ladder, or null when unranked. Computed with a COUNT of
   *  higher-rated players rather than by materialising the board — see
   *  botRank. */
  ladderPosition: number | null;
}

export interface BotMonSummary {
  slot: number;
  speciesKey: string;
  /** Species display name. The client owns the species table; this is whatever
   *  the blob recorded at creation, which is what the player sees in-game. */
  name: string;
  nickname: string | null;
  level: number;
  isShiny: boolean;
  nature: string | null;
  heldItem: string | null;
  moves: string[];
}

export interface BotMonDetail extends BotMonSummary {
  totalExp: number;
  currentHp: number;
  maxHp: number;
  attack: number;
  defense: number;
  spAttack: number;
  spDefense: number;
  speed: number;
  ivs: Record<string, number>;
  evs: Record<string, number>;
  ability: string | null;
}

export interface BotDex {
  v: number;
  username: string;
  /** The denormalised column — authoritative, server-maintained, and cheap. */
  caughtCount: number;
  /** Blob-derived. Null when the save is absent or unparseable, which is the
   *  honest answer; zero would read as "has caught nothing". */
  seenCount: number | null;
  shinyCaughtCount: number | null;
  /**
   * Deliberately NOT a percentage.
   *
   * The server has no species table — see the comment on the `pokemon` Prize
   * variant in lib/giveaway.ts for why that is intentional and not an
   * oversight. It therefore cannot know the denominator, and inventing one
   * (or letting the bot hard-code it) produces a completion figure that
   * silently goes wrong the next time a region is added. The bot prints
   * counts.
   */
  totalSpecies: null;
}

// ── Lookups ─────────────────────────────────────────────────────────

/**
 * Every bot read starts by resolving a name to an account, and every one of
 * them must apply the same visibility rule, so it lives here.
 *
 * Banned accounts are invisible to the bot. Not "shown with a banned flag" —
 * the flag itself is moderation state and constraint 4 puts it off limits —
 * but genuinely not found, which is also what a player in Discord should see
 * when they look up an account that is not currently part of the community.
 * Mirrors the filter the public trainer directory already uses
 * (routes/profile.ts).
 */
// A FUNCTION, not a constant, and that is not a style choice. `new Date()`
// evaluated once at module load freezes the ban cutoff at the moment the
// process booted, so a ban that expires while the server is running would keep
// the account hidden until the next deploy. Every call needs `now`.
function visible() {
  return {
    OR: [{ bannedUntil: null }, { bannedUntil: { lt: new Date() } }],
  };
}

const IDENTITY_COLUMNS = {
  id: true,
  username: true,
  name: true,
  accountLevel: true,
  pokedexCaughtCount: true,
  dailyStreak: true,
  longestDailyStreak: true,
  createdAt: true,
  lastSeenAt: true,
} as const;

/** Resolve a game account by id or by username (case-insensitive), or null.
 *  The bot passes whichever it has: a linked user's id, or the name someone
 *  typed after /profile. */
export async function resolveAccount(
  ref: { userId?: string | null; username?: string | null },
): Promise<{ id: string; username: string } | null> {
  if (ref.userId) {
    const byId = await prisma.user.findFirst({
      where: { id: ref.userId, ...visible() },
      select: { id: true, username: true },
    });
    if (byId) return byId;
    return null;
  }
  const name = ref.username?.trim();
  if (!name) return null;
  const byName = await prisma.user.findFirst({
    // `mode: "insensitive"` because nobody types capitalisation correctly off
    // a Discord message, and the username column is unique case-sensitively —
    // so this can still only ever match one row in practice.
    where: { username: { equals: name, mode: "insensitive" }, ...visible() },
    select: { id: true, username: true },
  });
  return byName ?? null;
}

/**
 * Ladder position without materialising the ladder.
 *
 * COUNT of strictly-higher ratings + 1. This is the same ordering the
 * leaderboard endpoint uses on its first key, and it stays correct as the
 * board grows — the alternative (fetch the top N and look for yourself) gives
 * a null for everyone outside the window, which is almost everyone.
 *
 * Ties share a position, which is the honest rendering of a tie.
 */
async function ladderPositionFor(rating: number): Promise<number> {
  const above = await prisma.playerRating.count({
    where: { rating: { gt: rating }, matchesPlayed: { gte: 1 } },
  });
  return above + 1;
}

async function ratingFor(userId: string): Promise<BotRating> {
  const row = await prisma.playerRating.findUnique({ where: { userId } });
  if (!row || row.matchesPlayed === 0) {
    return {
      rating: row?.rating ?? 1000,
      peakRating: row?.peakRating ?? 1000,
      matchesPlayed: 0,
      wins: 0,
      losses: 0,
      forfeits: 0,
      unranked: true,
      badge: pvpBadgeForRating(row?.rating ?? 1000, row?.peakRating ?? 1000, 0),
      ladderPosition: null,
    };
  }
  return {
    rating: row.rating,
    peakRating: row.peakRating,
    matchesPlayed: row.matchesPlayed,
    wins: row.wins,
    losses: row.losses,
    forfeits: row.forfeits,
    unranked: false,
    badge: pvpBadgeForRating(row.rating, row.peakRating, row.matchesPlayed),
    ladderPosition: await ladderPositionFor(row.rating),
  };
}

/**
 * /profile and /rank. Touches columns and PlayerRating only — NO save parse,
 * which is why it is safe to call on the hot path of a chatty Discord server.
 */
export async function botIdentity(userId: string): Promise<BotIdentity | null> {
  const u = await prisma.user.findFirst({
    where: { id: userId, ...visible() },
    select: IDENTITY_COLUMNS,
  });
  if (!u) return null;
  return {
    v: BOT_DTO_VERSION,
    userId: u.id,
    username: u.username,
    name: u.name,
    accountLevel: u.accountLevel,
    pokedexCaughtCount: u.pokedexCaughtCount,
    dailyStreak: u.dailyStreak,
    longestDailyStreak: u.longestDailyStreak,
    createdAt: u.createdAt.toISOString(),
    lastSeenAt: u.lastSeenAt.toISOString(),
    rating: await ratingFor(u.id),
  };
}

/** Shared mon projection. `slot` is 1-based because it is a number a human
 *  types after /mon, and party slots are 1-6 everywhere in the UI. */
function monSummary(raw: unknown, slot: number): BotMonSummary | null {
  const m = asObject(raw);
  if (!m) return null;
  const speciesKey = asString(m.speciesKey);
  if (!speciesKey) return null;
  return {
    slot,
    speciesKey,
    name: asString(m.name) ?? speciesKey,
    nickname: asString(m.nickname),
    level: asInt(m.level) ?? 1,
    isShiny: m.isShiny === true,
    nature: asString(m.nature),
    heldItem: asString(m.heldItem),
    // Move ids, not display names: the server has no move table either, and
    // the bot renders whatever the blob recorded. Bounded at 4 because that is
    // the game's own limit and a longer array means the blob is wrong.
    moves: asArray(m.moves)
      .slice(0, 4)
      .map((mv) => asString(asObject(mv)?.id))
      .filter((x): x is string => !!x),
  };
}

/**
 * /team — the party, in order.
 *
 * Returns an empty array for a player who has a save but no party, and null
 * for a player with no readable save at all. The bot renders those
 * differently: "hasn't started playing yet" vs "no team set".
 */
export async function botParty(userId: string): Promise<BotMonSummary[] | null> {
  const u = await prisma.user.findFirst({
    where: { id: userId, ...visible() },
    select: { saveData: true },
  });
  if (!u) return null;
  const save = parseSave(u.saveData);
  if (!save) return null;
  return asArray(save.party)
    .slice(0, 6)
    .map((m, i) => monSummary(m, i + 1))
    .filter((x): x is BotMonSummary => !!x);
}

/**
 * /mon <slot> — one party member in full, including IVs and EVs.
 *
 * Party only, never the box. The box is hundreds of entries and indexing into
 * it from Discord is a worse experience than opening the game; more to the
 * point, a command that can page an arbitrary player's entire collection is a
 * scraping tool, and the noticeboard is supposed to make people talk to each
 * other rather than replace the game's own UI.
 */
export async function botMon(userId: string, slot: number): Promise<BotMonDetail | null> {
  const u = await prisma.user.findFirst({
    where: { id: userId, ...visible() },
    select: { saveData: true },
  });
  if (!u) return null;
  const save = parseSave(u.saveData);
  if (!save) return null;
  const party = asArray(save.party);
  if (slot < 1 || slot > party.length) return null;
  const base = monSummary(party[slot - 1], slot);
  if (!base) return null;
  const m = asObject(party[slot - 1]) ?? {};

  const numberMap = (v: unknown): Record<string, number> => {
    const o = asObject(v);
    if (!o) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(o)) {
      const n = asInt(val);
      if (n !== null) out[k] = n;
    }
    return out;
  };

  return {
    ...base,
    totalExp: asInt(m.totalExp) ?? 0,
    currentHp: asInt(m.currentHp) ?? 0,
    maxHp: asInt(m.maxHp) ?? 0,
    attack: asInt(m.attack) ?? 0,
    defense: asInt(m.defense) ?? 0,
    spAttack: asInt(m.spAttack) ?? 0,
    spDefense: asInt(m.spDefense) ?? 0,
    speed: asInt(m.speed) ?? 0,
    ivs: numberMap(m.ivs),
    evs: numberMap(m.evs),
    ability: asString(m.ability),
  };
}

/** /dex — completion counts. See BotDex.totalSpecies for why there is no
 *  percentage. */
export async function botDex(userId: string): Promise<BotDex | null> {
  const u = await prisma.user.findFirst({
    where: { id: userId, ...visible() },
    select: { username: true, pokedexCaughtCount: true, saveData: true },
  });
  if (!u) return null;
  const save = parseSave(u.saveData);
  return {
    v: BOT_DTO_VERSION,
    username: u.username,
    caughtCount: u.pokedexCaughtCount,
    seenCount: save ? asStringArray(save.pokedexSeen).length : null,
    shinyCaughtCount: save ? asStringArray(save.shinyCaught).length : null,
    totalSpecies: null,
  };
}

export interface BotLeaderboardRow {
  rank: number;
  username: string;
  name: string | null;
  accountLevel: number;
  rating: number;
  peakRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
}

/**
 * /leaderboard — top N by rating.
 *
 * Two queries rather than a join because PlayerRating has no Prisma relation
 * to User (it is a bare `userId @id` — see the model), which is the same
 * reason routes/pvp.ts decorates its leaderboard the same way. Reusing that
 * shape deliberately: two boards that disagree about who is #1 would be worse
 * than either.
 *
 * `minMatches: 1` matches the game's own leaderboard default, and for the
 * documented reason — a stricter floor produced an empty board against the
 * real population.
 */
export async function botLeaderboard(limit: number): Promise<BotLeaderboardRow[]> {
  const take = Math.min(25, Math.max(1, limit));
  const rows = await prisma.playerRating.findMany({
    where: { matchesPlayed: { gte: 1 } },
    orderBy: [{ rating: "desc" }, { matchesPlayed: "desc" }],
    take,
  });
  if (rows.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) }, ...visible() },
    select: { id: true, username: true, name: true, accountLevel: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows
    // A banned or deleted account drops OUT of the board rather than
    // rendering as "(deleted)". The in-game leaderboard shows the placeholder
    // because the position still exists in the game's own history; a Discord
    // embed showing a banned account by name is a different thing, and the
    // rank numbers below are re-derived after the filter so the list still
    // reads 1..N.
    .filter((r) => byId.has(r.userId))
    .map((r, i) => {
      const u = byId.get(r.userId)!;
      return {
        rank: i + 1,
        username: u.username,
        name: u.name,
        accountLevel: u.accountLevel,
        rating: r.rating,
        peakRating: r.peakRating,
        matchesPlayed: r.matchesPlayed,
        wins: r.wins,
        losses: r.losses,
      };
    });
}
