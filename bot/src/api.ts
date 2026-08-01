// Typed client for the game server's /api/bot surface.
//
// Every call goes out with the BOT_TOKEN bearer. Nothing else in the bot is
// allowed to call fetch against the game server — routing every request
// through here is what makes "which endpoints does the bot use?" a question
// with an answer, and what stops a command handler from quietly inventing a
// new one.
//
// ── ERROR SHAPE ─────────────────────────────────────────────────────
// The server answers failures as `{ error, reason? }`, where `reason` is copy
// written for a player to read. This client surfaces both and command handlers
// print `reason` verbatim. Two consequences worth stating:
//
//   * The wording of "you aren't linked yet" lives in ONE place (the server),
//     so the bot and the site cannot disagree about it.
//   * A handler that hits an unexpected error prints a generic apology rather
//     than an internal message — see toUserMessage.

import { config } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    /** Player-facing copy from the server, when it supplied any. */
    public reason: string | null,
  ) {
    super(`${status} ${code}${reason ? `: ${reason}` : ""}`);
    this.name = "ApiError";
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.botToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // A Discord interaction must be answered within 3 seconds (or deferred).
      // A game server that has gone away must not leave a command hanging
      // until Discord times it out and shows "the application did not respond".
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ApiError(0, "network", null);
  }

  if (!res.ok) {
    type ErrorBody = { error?: string; reason?: string };
    let payload: ErrorBody | null = null;
    try { payload = (await res.json()) as ErrorBody; } catch { /* non-JSON body */ }
    throw new ApiError(res.status, payload?.error ?? String(res.status), payload?.reason ?? null);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Turn any thrown error into something safe to show in a public channel.
 *
 * The server's `reason` strings are written for players and are safe by
 * construction. Anything else — a stack, a Prisma message, a 500's body — is
 * replaced with a generic line, because this text is about to be posted into a
 * channel that anyone can read.
 */
export function toUserMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.reason) return e.reason;
    if (e.status === 0) return "I can't reach the game server right now. Try again in a minute.";
    if (e.status === 401) return "I'm not authorised to talk to the game server. Someone needs to check my token.";
    if (e.status === 429) return "That's a lot of commands. Give it a minute.";
    if (e.status === 404) return "I couldn't find that.";
  }
  return "Something went wrong on my end. Try again shortly.";
}

// ── Shapes, mirroring server/src/lib/botProfile.ts ──────────────────
// `v` is the DTO version. It is carried on every payload so a bot deployed
// against a newer server can notice rather than render `undefined` into a
// public embed — see assertVersion.

export const SUPPORTED_DTO_VERSION = 1;

export interface Rating {
  rating: number;
  peakRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  forfeits: number;
  unranked: boolean;
  badge: { label?: string; tier?: string } | null;
  ladderPosition: number | null;
}

export interface Identity {
  v: number;
  userId: string;
  username: string;
  name: string | null;
  accountLevel: number;
  pokedexCaughtCount: number;
  dailyStreak: number;
  longestDailyStreak: number;
  createdAt: string;
  lastSeenAt: string;
  rating: Rating;
}

export interface MonSummary {
  slot: number;
  speciesKey: string;
  name: string;
  nickname: string | null;
  level: number;
  isShiny: boolean;
  nature: string | null;
  heldItem: string | null;
  moves: string[];
}

export interface MonDetail extends MonSummary {
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

/**
 * A prize, as stored. Mirrors the server's `Prize` union in
 * server/src/lib/giveaway.ts.
 *
 * The bot only ever RENDERS these — it never constructs one. A prize is built
 * by the admin client (which owns the real stat formula) and validated by the
 * server; anything the bot invented would be a mon with fabricated stats, which
 * is the bug that shipped a Lv50 Charizard with 24 HP.
 */
export type PrizeDescriptor =
  | { kind: "item"; itemId: string; quantity: number }
  | { kind: "money"; amount: number }
  | { kind: "pokemon"; label: string; mon?: { speciesKey?: string; isShiny?: boolean; level?: number } };

export interface DesiredMember {
  discordId: string;
  userId: string;
  username: string;
  accountLevel: number;
  roles: string[];
}

export interface DesiredRoles {
  v: number;
  managedRoles: string[];
  champion: { username: string; discordId: string } | null;
  aceTrainerMinLevel: number;
  championMinMatches: number;
  members: DesiredMember[];
  computedAt: string;
}

/** A subject query: either the caller (by their Discord id) or a named player. */
function subjectQuery(subject: { discordId?: string; username?: string }): string {
  const p = new URLSearchParams();
  if (subject.username) p.set("username", subject.username);
  else if (subject.discordId) p.set("discordId", subject.discordId);
  return p.toString() ? `?${p}` : "";
}

export const api = {
  // Linking
  linkStart: (discordId: string, discordLabel: string) =>
    call<{
      code: string; expiresAt: string; ttlMs: number; linkUrl: string;
      /** The link-reward prize, when the promotion is running. Nominal — not a
       *  guarantee for this user, since eligibility is decided at redeem. */
      rewardSummary: string | null;
    }>("POST", "/api/bot/link/start", { discordId, discordLabel }),
  linkStatus: (discordId: string) =>
    call<{ linked: boolean; userId?: string; username?: string | null }>(
      "GET", `/api/bot/link?discordId=${encodeURIComponent(discordId)}`,
    ),
  unlink: (discordId: string) =>
    call<{ ok: true; removed: boolean }>("DELETE", "/api/bot/link", { discordId }),

  // Reads
  profile: (s: { discordId?: string; username?: string }) =>
    call<Identity>("GET", `/api/bot/profile${subjectQuery(s)}`),
  rank: (s: { discordId?: string; username?: string }) =>
    call<Rating & { v: number; username: string }>("GET", `/api/bot/rank${subjectQuery(s)}`),
  leaderboard: (limit: number) =>
    call<{ v: number; leaderboard: Array<{
      rank: number; username: string; name: string | null; accountLevel: number;
      rating: number; peakRating: number; matchesPlayed: number; wins: number; losses: number;
    }> }>("GET", `/api/bot/leaderboard?limit=${limit}`),
  team: (s: { discordId?: string; username?: string }) =>
    call<{ v: number; username: string; party: MonSummary[]; started: boolean }>(
      "GET", `/api/bot/team${subjectQuery(s)}`,
    ),
  mon: (discordId: string, slot: number) =>
    call<{ v: number; username: string; mon: MonDetail }>(
      "GET", `/api/bot/mon?discordId=${encodeURIComponent(discordId)}&slot=${slot}`,
    ),
  dex: (s: { discordId?: string; username?: string }) =>
    call<{ v: number; username: string; caughtCount: number; seenCount: number | null; shinyCaughtCount: number | null }>(
      "GET", `/api/bot/dex${subjectQuery(s)}`,
    ),
  prizes: (discordId: string) =>
    call<{ v: number; username: string; grants: Array<{
      id: string; summary: string; source: string; createdAt: string;
      prizes: PrizeDescriptor[];
      delivered: boolean; deliveredAt: string | null; stuck: boolean;
      attempts: number; lastError: string | null;
    }> }>("GET", `/api/bot/prizes?discordId=${encodeURIComponent(discordId)}`),

  // Community XP. A SEPARATE currency from the game economy — it buys Discord
  // standing and nothing the game can see. Note what awardMessageXp does NOT
  // take: message content.
  awardMessageXp: (input: { discordId: string; channelId: string; label: string }) =>
    call<{ awarded: number; xp: number; level: number; previousLevel: number; leveledUp: boolean; skipped?: string }>(
      "POST", "/api/bot/xp/message", input,
    ),
  xp: (discordId: string) =>
    call<{ found: boolean; discordId?: string; label?: string | null; xp: number; level: number;
           intoLevel?: number; neededForNext?: number; messages?: number; rank?: number }>(
      "GET", `/api/bot/xp?discordId=${encodeURIComponent(discordId)}`,
    ),
  xpLeaderboard: (limit: number) =>
    call<{ leaderboard: Array<{ rank: number; discordId: string; label: string | null; xp: number; level: number }> }>(
      "GET", `/api/bot/xp/leaderboard?limit=${limit}`,
    ),

  // Liveness. Reported rather than probed: the game server cannot reach the
  // bot — no token, no address, outbound connections only.
  heartbeat: (input: Record<string, unknown>) =>
    call<{ ok: true }>("POST", "/api/bot/heartbeat", input),

  // Roles
  desiredRoles: () => call<DesiredRoles>("GET", "/api/bot/roles/desired"),

  // Giveaways
  createGiveaway: (input: {
    title: string; description: string; prizes: unknown; winnerCount: number; ownerDiscordId: string;
  }) =>
    call<{
      ok: true; giveawayId: string; title: string; description: string;
      winnerCount: number; prizeSummary: string; prizes: PrizeDescriptor[];
    }>("POST", "/api/bot/giveaways", input),
  enterGiveaway: (giveawayId: string, discordId: string) =>
    call<{ ok: true; entered: boolean; duplicate: boolean }>(
      "POST", `/api/bot/giveaways/${encodeURIComponent(giveawayId)}/entries`, { discordId },
    ),
  drawGiveaway: (giveawayId: string, actorDiscordId: string) =>
    call<{
      ok: true; giveawayId: string; seed: string; entryCount: number;
      winners: Array<{ username: string; ok: boolean; error: string | null; discordId: string | null }>;
      deliveryNote: string;
    }>("POST", `/api/bot/giveaways/${encodeURIComponent(giveawayId)}/draw`, { actorDiscordId }),
  giveawayStatus: (giveawayId: string) =>
    call<{
      v: number; id: string; title: string; status: string; drawnAt: string | null;
      seed: string | null; entryCount: number; winners: string[];
      prizes: Array<{ username: string; summary: string; delivered: boolean; deliveredAt: string | null; stuck: boolean }>;
    }>("GET", `/api/bot/giveaways/${encodeURIComponent(giveawayId)}`),

  // Admin-dashboard giveaways: the bot polls, the server never pushes.
  pendingGiveaways: () =>
    call<{
      v: number;
      toAnnounce: Array<{
        id: string; title: string; description: string; prizes: PrizeDescriptor[];
        prizeSummary: string; winnerCount: number; channelId: string | null; endsAt: string | null;
      }>;
      toReport: Array<{
        id: string; title: string; seed: string | null; channelId: string | null;
        announceMessageId: string | null;
        winners: Array<{ username: string; discordId: string | null }>;
      }>;
    }>("GET", "/api/bot/giveaways/pending"),
  markAnnounced: (id: string, messageId: string, channelId: string) =>
    call<{ ok: true; claimed: boolean }>(
      "POST", `/api/bot/giveaways/${encodeURIComponent(id)}/announced`, { messageId, channelId },
    ),
  markReported: (id: string) =>
    call<{ ok: true; claimed: boolean }>(
      "POST", `/api/bot/giveaways/${encodeURIComponent(id)}/reported`, {},
    ),

  // Bug reports ingested from the community server's bug channel. The one
  // place Discord message text enters the game database — see the endpoint's
  // comment in server/src/routes/bot.ts.
  submitBugReport: (input: {
    discordMessageId: string; discordId: string; discordName: string;
    messageUrl: string; title: string; description: string;
  }) =>
    call<{ ok: true; id?: string; duplicate: boolean; linkedTo?: string | null }>(
      "POST", "/api/bot/bug-reports", input,
    ),

  // Trade noticeboard — TEXT ONLY. There is deliberately no endpoint that
  // moves an asset; see the header of server/src/routes/bot.ts.
  postTradeOffer: (input: { discordId: string; offering: string; wanting: string }) =>
    call<{
      ok: true; username: string; offering: string; wanting: string;
      chatMessageId: string | null; deepLink: string;
    }>("POST", "/api/bot/trade/offer", input),
};

/**
 * Guard against a server that has moved ahead of this bot.
 *
 * Returns a warning string when the payload version is newer than what this
 * build understands, so a handler can say "I need an update" instead of
 * rendering blank fields. An OLDER version is fine and returns null — the DTOs
 * only ever add fields within a version.
 */
export function versionWarning(v: number | undefined): string | null {
  if (typeof v !== "number" || v <= SUPPORTED_DTO_VERSION) return null;
  return "The game server is running a newer data format than I understand. Some fields may be missing until I'm updated.";
}
