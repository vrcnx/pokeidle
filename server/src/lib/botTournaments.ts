// Tournament DTOs for the Discord bot surface (routes/bot.ts).
//
// Same contract as lib/botProfile.ts, and for the same reason: rule 3 of
// bot.ts says every player-facing payload comes from an explicit allowlist,
// so the shape is built field by field here rather than by handing a Prisma
// row to the bot and hoping nothing sensitive rides along.
//
// WHY THIS EXISTS AT ALL — the interesting part:
//
// lib/tournamentRunner.ts runs brackets ASYNCHRONOUSLY. A round stays open
// for `roundWindowMinutes` (default 1440 = 24h) and the runner starts each
// pairing the moment both players happen to be online together, because a
// synchronous 16-player draw needs 16 people in the same 20 minutes and this
// game has ~34 accounts online in a given hour.
//
// That design has one hole, and it is not in the runner: a player cannot act
// on a pairing they do not know about. The game can only tell them once they
// are already online, which is precisely the state the async window exists to
// work around. Discord is where that gap closes — hence `yourMatch`, which is
// the whole point of this file. Everything else here is context around it.
//
// NO USER IDS LEAVE THIS FILE. The in-game bracket shows userIds to a
// logged-in player; a Discord embed can be screenshotted into a public
// channel, so usernames only. `resolveFor` takes a userId to find the
// caller's own match and never echoes it back.

import { prisma } from "../db.js";
import { currentRoundIndex, type Bracket, type BracketMatch, type BracketSlot } from "./bracket.js";
import { parsePrizes, describePrizes } from "./giveaway.js";

/** Statuses a player has any reason to see. "cancelled" is deliberately
 *  absent from the LIST (nobody needs a feed of abandoned events) but is
 *  still resolvable by id, so a stale Discord link explains itself rather
 *  than 404ing. */
const LISTABLE = ["open", "live", "scheduled", "completed"] as const;

export interface BotTournamentSummary {
  id: string;
  name: string;
  format: string;
  status: string;
  levelCap: number | null;
  startsAt: string | null;
  finishedAt: string | null;
  entrantCount: number;
  championUsername: string | null;
  /** Human-readable, e.g. "1× Master Ball, 5,000 coins". Null when unset. */
  prizeSummary: string | null;
  roundWindowMinutes: number;
  /** Null when the caller is unlinked — the bot renders a "run /link" hint
   *  instead of silently implying they are not entered. */
  you: { entered: boolean; eliminated: boolean; seed: number | null } | null;
}

export interface BotTournamentMatch {
  /** 1-based, because "Round 0" reads like a bug to a player. */
  roundNumber: number;
  /** Null when the opposing slot is still `winnerOf` / `tbd`. */
  opponent: string | null;
  isBye: boolean;
  /** ISO. Null until the runner arms the round. */
  deadlineAt: string | null;
  decided: boolean;
  /** Null while undecided. */
  youWon: boolean | null;
  /** The runner's own note, e.g. "no-show: neither player online at the
   *  deadline — advanced higher seed". Worth surfacing verbatim: it is the
   *  difference between "the bot is broken" and "I missed my window". */
  note: string | null;
}

export interface BotTournamentDetail extends BotTournamentSummary {
  /** 1-based. Null once the bracket is finished or before it is generated. */
  currentRound: number | null;
  totalRounds: number | null;
  entrants: { username: string; seed: number | null; eliminated: boolean }[];
  yourMatch: BotTournamentMatch | null;
}

function parseBracket(json: string | null): Bracket | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Bracket;
    return Array.isArray(v?.rounds) ? v : null;
  } catch {
    return null;
  }
}

/** A slot's display name, or null for anything not yet a person. */
function slotName(s: BracketSlot | undefined): string | null {
  return s && s.kind === "player" ? s.username : null;
}

function slotIsUser(s: BracketSlot | undefined, userId: string): boolean {
  return !!s && s.kind === "player" && s.userId === userId;
}

/**
 * The caller's most relevant match: their live pairing if they have one,
 * otherwise their most recent decided one.
 *
 * "Most recent decided" matters more than it looks. A player who was knocked
 * out yesterday and opens `/tournament info` should see WHY — a walkover note
 * explains an elimination that otherwise looks arbitrary.
 */
function findYourMatch(bracket: Bracket, userId: string): BotTournamentMatch | null {
  let fallback: BotTournamentMatch | null = null;

  for (const round of bracket.rounds) {
    for (const m of round.matches) {
      const isA = slotIsUser(m.a, userId);
      const isB = slotIsUser(m.b, userId);
      if (!isA && !isB) continue;

      const other = isA ? m.b : m.a;
      const dto: BotTournamentMatch = {
        roundNumber: round.index + 1,
        opponent: slotName(other),
        isBye: other?.kind === "bye",
        deadlineAt: m.deadlineAt ? new Date(m.deadlineAt).toISOString() : null,
        decided: !!m.winnerId,
        youWon: m.winnerId ? m.winnerId === userId : null,
        note: m.note ?? null,
      };

      // An undecided match is always the answer — return immediately.
      if (!m.winnerId) return dto;
      // Otherwise keep the latest decided one and keep looking for a live one.
      fallback = dto;
    }
  }
  return fallback;
}

function summarise(
  t: {
    id: string;
    name: string;
    format: string;
    status: string;
    levelCap: number | null;
    startsAt: Date | null;
    finishedAt: Date | null;
    championUsername: string | null;
    prizes: string | null;
    roundWindowMinutes: number;
    entries: { userId: string; username: string; eliminated: boolean; seed: number | null }[];
  },
  viewerId: string | null,
): BotTournamentSummary {
  const mine = viewerId ? t.entries.find((e) => e.userId === viewerId) : undefined;
  const prizes = parsePrizes(t.prizes ?? "[]");
  return {
    id: t.id,
    name: t.name,
    format: t.format,
    status: t.status,
    levelCap: t.levelCap,
    startsAt: t.startsAt?.toISOString() ?? null,
    finishedAt: t.finishedAt?.toISOString() ?? null,
    entrantCount: t.entries.length,
    championUsername: t.championUsername,
    prizeSummary: prizes.length ? describePrizes(prizes) : null,
    roundWindowMinutes: t.roundWindowMinutes,
    you: viewerId
      ? { entered: !!mine, eliminated: mine?.eliminated ?? false, seed: mine?.seed ?? null }
      : null,
  };
}

const ENTRY_SELECT = {
  select: { userId: true, username: true, eliminated: true, seed: true },
} as const;

/**
 * Tournaments worth showing, newest first.
 *
 * Ordered by status rather than date: an OPEN event you can still join is the
 * only actionable row on the list, so it leads regardless of age. A completed
 * event from this morning is history.
 */
export async function botTournamentList(
  viewerId: string | null,
  limit = 10,
): Promise<BotTournamentSummary[]> {
  const rows = await prisma.tournament.findMany({
    where: { status: { in: [...LISTABLE] } },
    orderBy: { createdAt: "desc" },
    take: Math.min(25, Math.max(1, limit)),
    include: { entries: ENTRY_SELECT },
  });

  const rank: Record<string, number> = { open: 0, live: 1, scheduled: 2, completed: 3 };
  return rows
    .map((t) => summarise(t, viewerId))
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
}

/** Null when no such tournament. Resolves ANY status, including cancelled —
 *  see the note on LISTABLE. */
export async function botTournamentDetail(
  id: string,
  viewerId: string | null,
): Promise<BotTournamentDetail | null> {
  const t = await prisma.tournament.findUnique({
    where: { id },
    include: { entries: ENTRY_SELECT },
  });
  if (!t) return null;

  const bracket = parseBracket(t.bracket);
  const idx = bracket ? currentRoundIndex(bracket) : -1;

  return {
    ...summarise(t, viewerId),
    currentRound: idx >= 0 ? idx + 1 : null,
    totalRounds: bracket?.rounds.length ?? null,
    entrants: [...t.entries]
      .sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999))
      .map((e) => ({ username: e.username, seed: e.seed, eliminated: e.eliminated })),
    yourMatch: bracket && viewerId ? findYourMatch(bracket, viewerId) : null,
  };
}

// ══ Announce poll ═══════════════════════════════════════════════════
//
// The game server holds no Discord token and knows no channel semantics, so
// the bot polls these rather than being pushed to. Same flow as giveaways —
// see migrations/20260801120000_giveaway_discord_announce for the full
// argument about ordering and idempotency.

export interface TournamentAnnouncement {
  id: string;
  name: string;
  format: string;
  levelCap: number | null;
  entrantCount: number;
  prizeSummary: string | null;
  roundWindowMinutes: number;
  startsAt: string | null;
  channelId: string | null;
}

export interface TournamentResult {
  id: string;
  name: string;
  championUsername: string | null;
  /** Null when the champion never linked a Discord account — the bot falls
   *  back to bolding the username rather than pinging nobody. */
  championDiscordId: string | null;
  entrantCount: number;
  prizeSummary: string | null;
  channelId: string | null;
  announceMessageId: string | null;
}

export async function botTournamentsPending(): Promise<{
  toAnnounce: TournamentAnnouncement[];
  toReport: TournamentResult[];
}> {
  const [open, done] = await Promise.all([
    prisma.tournament.findMany({
      where: { announceToDiscord: true, status: "open", discordMessageId: null },
      orderBy: { createdAt: "asc" },
      take: 5,
      include: { entries: ENTRY_SELECT },
    }),
    // Only report a tournament we actually announced. A bracket run entirely
    // outside Discord should not suddenly produce a champion post for an event
    // nobody in the server saw open.
    prisma.tournament.findMany({
      where: {
        announceToDiscord: true,
        status: "completed",
        discordMessageId: { not: null },
        discordResultsAt: null,
      },
      orderBy: { finishedAt: "asc" },
      take: 5,
      include: { entries: ENTRY_SELECT },
    }),
  ]);

  const championIds = done.map((t) => t.championId).filter((v): v is string => !!v);
  const links = championIds.length
    ? await prisma.discordLink.findMany({
        where: { userId: { in: championIds } },
        select: { userId: true, discordId: true },
      })
    : [];
  const discordFor = new Map(links.map((l) => [l.userId, l.discordId]));

  return {
    toAnnounce: open.map((t) => {
      const prizes = parsePrizes(t.prizes ?? "[]");
      return {
        id: t.id,
        name: t.name,
        format: t.format,
        levelCap: t.levelCap,
        entrantCount: t.entries.length,
        prizeSummary: prizes.length ? describePrizes(prizes) : null,
        roundWindowMinutes: t.roundWindowMinutes,
        startsAt: t.startsAt?.toISOString() ?? null,
        channelId: t.discordChannelId,
      };
    }),
    toReport: done.map((t) => {
      const prizes = parsePrizes(t.prizes ?? "[]");
      return {
        id: t.id,
        name: t.name,
        championUsername: t.championUsername,
        championDiscordId: t.championId ? discordFor.get(t.championId) ?? null : null,
        entrantCount: t.entries.length,
        prizeSummary: prizes.length ? describePrizes(prizes) : null,
        channelId: t.discordChannelId,
        announceMessageId: t.discordMessageId,
      };
    }),
  };
}

/** Claim the announcement. False means another bot instance won the race and
 *  this one should delete the duplicate it just posted. */
export async function markTournamentAnnounced(
  id: string,
  messageId: string,
  channelId: string,
): Promise<boolean> {
  const r = await prisma.tournament.updateMany({
    where: { id, discordMessageId: null },
    data: { discordMessageId: messageId, discordChannelId: channelId },
  });
  return r.count > 0;
}

export async function markTournamentReported(id: string): Promise<boolean> {
  const r = await prisma.tournament.updateMany({
    where: { id, discordResultsAt: null },
    data: { discordResultsAt: new Date() },
  });
  return r.count > 0;
}

export type { BracketMatch };
