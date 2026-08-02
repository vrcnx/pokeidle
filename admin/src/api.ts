// Thin admin API client. Re-uses the game server (cookies travel via
// `credentials: include`) so admin authentication piggybacks the same
// Better Auth session a normal user has, gated by isAdmin on the server.

export const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL ?? "http://localhost:8787";

class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let err: any = null;
    try { err = await res.json(); } catch { /* */ }
    // Prefer `reason` — the human-readable half — over `error`, which is a
    // machine code. Routes that write both were rendering only the code, so a
    // rejected save showed "invalid body" while the server was sitting on a
    // sentence explaining exactly which field was wrong.
    throw new ApiError(res.status, err?.reason ?? err?.error ?? res.statusText, err);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface LiveOpsUser {
  userId: string;
  sessionCount: number;
  user: {
    id: string;
    username: string;
    name: string | null;
    accountLevel: number;
    lastSeenAt: string;
    pokedexCaughtCount: number;
    isAdmin: boolean;
    bannedUntil: string | null;
  } | null;
}
export interface LiveOpsActivityItem {
  id: string;
  kind: "chat" | "signup" | "trade" | "pvp";
  createdAt: string;
  channelId?: string;
  content?: string;
  user?: { id: string; username: string; name: string | null };
  species?: (string | null)[];
  winnerUserId?: string | null;
}
export interface LiveOps {
  online: LiveOpsUser[];
  activity: {
    chat: LiveOpsActivityItem[];
    signups: LiveOpsActivityItem[];
    trades: LiveOpsActivityItem[];
    pvp: LiveOpsActivityItem[];
  };
  serverTime: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  createdAt: string;
  admin: { id: string; username: string };
  target: { id: string; username: string } | null;
  meta: unknown;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  // "user" (default) | "announcement" | "giveaway" | "tradeOffer".
  kind?: string;
  meta?: { offering?: string; wanting?: string } | null;
  createdAt: string;
  // isAdmin is only ever populated by the REST /chat/recent endpoint —
  // the server's live socket "chat:message" broadcast (both regular
  // sends and /announce) never selects it, so treat it as best-effort.
  user: { id: string; username: string; name: string | null; isAdmin?: boolean; accountLevel: number };
}

export interface SaveSnapshotRow {
  id: string;
  saveVersion: number;
  reason: string;
  createdAt: string;
  summary: { level: number; badges: number; caught: number; money: number; bytes: number } | null;
}

export type AnnouncementType = "info" | "event" | "giveaway" | "warning" | "maintenance";

export interface AdminAnnouncement {
  id: string;
  type: AnnouncementType;
  message: string;
  href: string | null;
  linkLabel: string | null;
  createdAt: string;
  expiresAt: string | null;
}
// The history rows carry a little more than the public shape.
export interface AdminAnnouncementRow extends AdminAnnouncement {
  active: boolean;
  startsAt: string | null;
}

/** Mirrors the server's USER_SORTS allow-list. */
export type UserSortKey =
  | "createdAt" | "lastSeenAt" | "accountLevel"
  | "pokedexCaughtCount" | "totalCaughtLevels" | "username";
export type UserFilter = "all" | "banned" | "admins";

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  name: string | null;
  accountLevel: number;
  pokedexCaughtCount: number;
  totalCaughtLevels: number;
  isAdmin: boolean;
  bannedUntil: string | null;
  banReason: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface Analytics {
  totals: {
    users: number;
    bannedUsers: number;
    admins: number;
    friendships: number;
    chatMessagesTotal: number;
    chatMessages7d: number;
    pvpMatchesTotal: number;
    pvpMatches7d: number;
    tradesTotal: number;
    trades7d: number;
    bugReportsOpen: number;
    errorsLast24h: number;
    pokemonCaughtSum: number;
    pokemonLevelsSum: number;
  };
  activity: {
    activeDay: number;
    activeWeek: number;
    activeMonth: number;
    signups7d: number;
    signups30d: number;
  };
  averages: {
    pokedexCaught: number;
    accountLevel: number;
  };
  signupSeries: Record<string, number>;
  /** Users bucketed by the day of their LAST visit — a churn/recency
   *  distribution, not daily-active. Slopes toward today by construction.
   *  Was previously misnamed `dauSeries` and charted as "Daily Active". */
  lastSeenSeries: Record<string, number>;
  /** True count of logins per day, from Session.createdAt. Undercounts
   *  engagement (a long-lived session logs in once) but every point is
   *  a real event on a real day. */
  loginSeries: Record<string, number>;
  /** REAL daily-active users, from the DailyActive event table. Only
   *  contains days since collection began — a missing day means "we
   *  weren't recording", not "nobody played". Null if the table does
   *  not exist yet. */
  dauSeries: Record<string, number> | null;
  /** ISO date collection started, or null if no rows yet. */
  dauCollectingSince: string | null;
  /** Percentages, or null where the cohort's check-day predates
   *  collection (reporting 0% for days we weren't watching would read
   *  as catastrophic churn). */
  retention: {
    d1: number | null;
    d7: number | null;
    d30: number | null;
    cohortSizes: { d1: number; d7: number; d30: number };
  } | null;
  pvpSeries: Record<string, number>;
  tradeSeries: Record<string, number>;
  levelBuckets: { label: string; count: number }[];
  leaderboards: {
    pokedex: { id: string; username: string; name: string | null; accountLevel: number; pokedexCaughtCount: number }[];
    sigmaLevels: { id: string; username: string; name: string | null; accountLevel: number; totalCaughtLevels: number }[];
  };
}

/**
 * Where signups come from.
 *
 * ── READ `signups` AND `attributed` TOGETHER ────────────────────────
 * Every breakdown below counts only the signups we could place. `signups` is
 * everyone who registered in the window; `attributed` is how many of them have
 * an origin recorded. Rendering a channel split without showing that ratio is
 * how a dashboard ends up asserting "80% direct" when the truth is "we have
 * data on 20% of signups and most of those were direct".
 */
export interface Acquisition {
  windowDays: number;
  /** All signups in the window — the denominator. */
  signups: number;
  /** How many of those carry an attribution row. */
  attributed: number;
  /** When collection started. null = the table is empty or absent. */
  collectingSince: string | null;
  channels: { channel: string; signups: number }[];
  /** Grouped with the channel so a mis-classified source is visible. */
  sources: { source: string; channel: string; signups: number }[];
  campaigns: { campaign: string; source: string; medium: string | null; signups: number }[];
  landingPages: { path: string; signups: number }[];
}

export type GiveawayPrizeInput =
  | { kind: "item"; itemId: string; quantity: number }
  | { kind: "money"; amount: number }
  /** The full mon, built client-side by createPokemon — the server has
   *  no stat formula and must not fabricate one. `label` is carried for
   *  display so listing a prize never parses the mon. */
  | { kind: "pokemon"; label: string; mon: Record<string, unknown> };

export interface AdminGiveawayEntry {
  id: string;
  userId: string;
  username: string;
  isWinner: boolean;
  /** null on a winner = the grant itself failed; they still need paying by
   *  hand. Non-null means the prize is durably OWED (a committed PendingGrant
   *  row) — NOT that it is in their save yet. Never re-grant on this alone. */
  claimedAt: string | null;
  /** The owed prize has actually been folded into their saveData. Only true
   *  once their client has uploaded at least once since the grant. */
  prizeDelivered?: boolean;
}

export interface AdminPollVote {
  userId: string;
  username: string;
  optionIndex: number;
  updatedAt?: string;
}

export interface AdminPoll {
  id: string;
  createdAt: string;
  closedAt: string | null;
  question: string;
  status: "draft" | "open" | "closed";
  options: string[];
  voteCount: number;
  votes: AdminPollVote[];
}

export interface AdminGiveaway {
  id: string;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  drawnAt: string | null;
  title: string;
  description: string;
  status: "draft" | "open" | "closed" | "drawn" | "cancelled";
  winnerCount: number;
  minAccountLevel: number | null;
  drawSeed: string | null;
  prizes: GiveawayPrizeInput[];
  prizeSummary: string;
  entryCount: number;
  entries: AdminGiveawayEntry[];
  /** Post this one in the community Discord. A flag the BOT polls for — the
   *  game server never talks to Discord itself. */
  announceToDiscord?: boolean;
  /** Channel override; null = the bot's configured default. */
  discordChannelId?: string | null;
  /** Set by the bot once it has posted the entry embed. Doubles as the
   *  "already announced" marker, so a non-null value here is how the dashboard
   *  knows the post exists. */
  discordMessageId?: string | null;
  /** Set by the bot once it has posted the RESULT. */
  discordResultsAt?: string | null;
}

export interface DiscordStats {
  bot: { lastSeenAt: string | null; status: { guildMembers?: number; linkedMembers?: number; rolesGranted?: number; rolesRemoved?: number; champion?: string | null } | null };
  links: { total: number; last24h: number; last7d: number };
  roles: {
    trainer: number; aceTrainer: number; aceTrainerMinLevel: number;
    championMinMatches: number; champion: string | null; championLinked: boolean;
  };
  reward: { enabled: boolean; summary: string | null; granted: number; delivered: number; pending: number };
  giveaways: { announced: number; entries: number };
  bugReports: { total: number; open: number };
  trade: { listings7d: number };
  xp: { members: number; totalXp: number; totalMessages: number; topLabel: string | null; topLevel: number };
}

export interface DiscordLinkRow {
  discordId: string;
  linkedAt: string;
  userId: string;
  username: string;
  accountLevel: number;
  lastSeenAt: string;
  banned: boolean;
}

export interface DiscordConfig {
  /** Master switch, separate from the prize being set, so a promotion can be
   *  paused without losing its configuration. */
  linkRewardEnabled: boolean;
  linkReward: GiveawayPrizeInput[];
  linkRewardSummary: string | null;
  aceTrainerMinLevel: number;
  championMinMatches: number;
  /** Community XP settings. A SEPARATE currency from the game economy —
   *  nothing here converts into money, items or account level. */
  xp: {
    enabled: boolean; perMessageMin: number; perMessageMax: number;
    cooldownSec: number; ignoredChannels: string;
  };
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AdminMe { id: string; username: string; isAdmin: boolean }

export const api = {
  // Auth probe — returns 401 if not signed in, 403 if signed in but
  // not admin, 200 if admin. Used by the auth gate at app boot.
  me: () => req<AdminMe>("GET", "/api/admin/me"),
  signOut: () => req<void>("POST", "/api/auth/sign-out"),

  // Users
  listUsers: (
    q: string,
    page = 0,
    pageSize = 25,
    opts?: { sort?: UserSortKey; dir?: "asc" | "desc"; filter?: UserFilter },
  ) => {
    const p = new URLSearchParams({ q, page: String(page), pageSize: String(pageSize) });
    if (opts?.sort) p.set("sort", opts.sort);
    if (opts?.dir) p.set("dir", opts.dir);
    if (opts?.filter && opts.filter !== "all") p.set("filter", opts.filter);
    return req<{ total: number; page: number; pageSize: number; users: AdminUser[] }>(
      "GET",
      `/api/admin/users?${p.toString()}`
    );
  },

  /** Bulk ban/unban. `until: null` unbans. Bans only — bulk delete is
   *  deliberately not offered, since delete is unrecoverable and a
   *  mis-selected checkbox would be unrecoverable across N accounts. */
  bulkBan: (userIds: string[], until: string | null, reason: string | null) =>
    req<{ ok: true; count: number; skippedSelf: boolean }>(
      "POST",
      "/api/admin/users/bulk-ban",
      { userIds, until, reason },
    ),
  getUser: (id: string) => req<any>("GET", `/api/admin/users/${id}`),
  setAdmin: (id: string, isAdmin: boolean) =>
    req<{ id: string; isAdmin: boolean }>("POST", `/api/admin/users/${id}/admin`, { isAdmin }),
  ban: (id: string, until: string | null, reason: string | null) =>
    req<any>("POST", `/api/admin/users/${id}/ban`, { until, reason }),
  deleteUser: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/users/${id}`),
  resetSave: (id: string) =>
    req<{ id: string; saveVersion: number }>("POST", `/api/admin/users/${id}/reset-save`),
  // Save history (append-only checkpoints).
  listSnapshots: (id: string) =>
    req<{ snapshots: SaveSnapshotRow[] }>("GET", `/api/admin/users/${id}/snapshots`),
  restoreSnapshot: (id: string, snapshotId: string) =>
    req<{ ok: true; id: string; saveVersion: number; accountLevel: number }>(
      "POST", `/api/admin/users/${id}/snapshots/${snapshotId}/restore`),
  /** announce: optional gift-card text posted to Global chat on success.
   *  base: the loaded values of the edited keys — lets the server apply
   *  currencies (money/victoryTokens) as a DELTA onto the player's LATEST
   *  save, so an actively-playing user's concurrent earn/spend isn't wiped
   *  and the edit lands reliably (no more "save changed" 409). */
  savePatch: (id: string, patch: Record<string, unknown>, announce?: string, expectedSaveVersion?: number, base?: Record<string, unknown>) =>
    req<{ ok: true; id: string; saveVersion: number; accountLevel: number; pokedexCaughtCount: number; keys: string[] }>(
      "POST",
      `/api/admin/users/${id}/save-patch`,
      { patch, announce, expectedSaveVersion, base },
    ),
  sendPasswordReset: (id: string, redirectTo?: string) =>
    req<{ ok: true; sentTo: string }>(
      "POST",
      `/api/admin/users/${id}/send-password-reset`,
      { redirectTo },
    ),
  userSessions: (id: string) =>
    req<{ sessions: UserSession[] }>("GET", `/api/admin/users/${id}/sessions`),
  userMessages: (id: string, limit = 200, before?: string) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set("before", before);
    return req<{ messages: UserMessage[] }>(
      "GET",
      `/api/admin/users/${id}/messages?${qs.toString()}`,
    );
  },
  userTrades: (id: string) =>
    req<{ trades: UserTrade[] }>("GET", `/api/admin/users/${id}/trades`),
  setUserItem: (id: string, itemId: string, quantity: number, announce?: string) =>
    req<{ ok: true; itemId: string; quantity: number }>(
      "POST",
      `/api/admin/users/${id}/items`,
      { itemId, quantity, announce },
    ),

  // Stream auto-login key (OBS / 24-7). GET reports current status; POST
  // enables / disables / regenerates. The key + full login URL are only
  // returned to the admin here — treat as a bearer secret.
  streamKeyGet: (id: string) =>
    req<StreamKeyStatus>("GET", `/api/admin/users/${id}/stream-key`),
  streamKeySet: (
    id: string,
    action: "enable" | "disable" | "regenerate" | "config",
    opts?: { label?: string; config?: StreamConfig | null },
  ) =>
    req<StreamKeyStatus>("POST", `/api/admin/users/${id}/stream-key`, { action, ...opts }),
  // What the stream client actually DID with recent commands (delivery alone
  // doesn't tell you whether the client accepted them).
  streamCommandLog: (id: string) =>
    req<{ results: { kind: string; ok: boolean; message: string; at: number }[] }>(
      "GET", `/api/admin/users/${id}/stream-command-log`),
  streamCommand: (id: string, command: StreamCommand) =>
    req<{ ok: true; delivered: boolean; command: string }>("POST", `/api/admin/users/${id}/stream-command`, { command }),

  // 24/7 Twitch broadcast control. The desired state (on/off, account, quality)
  // is set here; the standalone renderer service polls it and pushes to Twitch.
  broadcastGet: () => req<BroadcastStatus>("GET", "/api/admin/broadcast"),
  broadcastSet: (patch: BroadcastPatch) =>
    req<BroadcastStatus>("POST", "/api/admin/broadcast", patch),

  // Live browser control: latest preview frame + input relay. Fetching a
  // frame also tells the renderer someone's watching (it only captures then).
  broadcastFrame: () =>
    req<{ frame: string | null; at?: number; width?: number; height?: number; ageMs?: number }>(
      "GET", "/api/admin/broadcast/frame"),
  broadcastInput: (command: BrowserInput) =>
    req<{ ok: true; kind: string }>("POST", "/api/admin/broadcast/input", { command }),

  // Twitch channel info (title / category / tags) via Helix.
  twitchGet: () => req<TwitchInfo>("GET", "/api/admin/broadcast/twitch"),
  twitchSet: (patch: { title?: string; gameName?: string; tags?: string }) =>
    req<TwitchInfo>("POST", "/api/admin/broadcast/twitch", patch),

  // Analytics
  analytics: () => req<Analytics>("GET", "/api/admin/analytics"),
  /** Separate call from analytics() on purpose — that endpoint already fans
   *  out to ~25 queries, and the acquisition panel should be able to load,
   *  fail and reload without taking the rest of the page with it. */
  acquisition: (days = 30) => req<Acquisition>("GET", `/api/admin/acquisition?days=${days}`),

  // Map editor
  getMapPositions: () =>
    req<{ positions: Record<string, { x: number; y: number }> }>(
      "GET",
      "/api/admin/map-positions"
    ),
  saveMapPositions: (positions: Record<string, { x: number; y: number }>) =>
    req<{ ok: true; count: number }>("PUT", "/api/admin/map-positions", { positions }),
  getMapCrop: () =>
    req<{ crop: { x: number; y: number; w: number; h: number } | null }>(
      "GET",
      "/api/admin/map-crop"
    ),
  saveMapCrop: (crop: { x: number; y: number; w: number; h: number } | null) =>
    req<{ ok: true; crop: { x: number; y: number; w: number; h: number } | null }>(
      "PUT",
      "/api/admin/map-crop",
      { crop }
    ),

  // Chat moderation
  recentChat: (limit = 100, opts?: { channel?: string; q?: string; username?: string }) => {
    const p = new URLSearchParams();
    p.set("limit", String(limit));
    if (opts?.channel)  p.set("channel",  opts.channel);
    if (opts?.q)        p.set("q",        opts.q);
    if (opts?.username) p.set("username", opts.username);
    return req<{
      messages: ChatMessage[];
      channels: { id: string; count: number }[];
    }>("GET", `/api/admin/chat/recent?${p.toString()}`);
  },
  deleteChat: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/chat/${id}`),
  // Wipes every message in the public live-chat channels (global +
  // area:*). DMs are preserved. Server broadcasts chat:cleared so live
  // clients flush their cached messages immediately.
  clearAllChat: () =>
    req<{ ok: true; deleted: number }>("DELETE", `/api/admin/chat/clear`),

  // Server-wide announcement broadcast — lands as a real ChatMessage on
  // the global channel with a 📢 prefix. Returns the stored message
  // payload so the UI can append it locally without another fetch.
  announce: (content: string) =>
    req<{ ok: true; message: ChatMessage }>(
      "POST",
      `/api/admin/announce`,
      { content },
    ),

  // Pinned banner (Announcement) — persistent header banner, distinct
  // from the ephemeral chat broadcast above.
  listAnnouncements: () =>
    req<{ live: AdminAnnouncement | null; recent: AdminAnnouncementRow[] }>(
      "GET", "/api/admin/announcements",
    ),
  publishAnnouncement: (body: {
    type: AnnouncementType; message: string;
    href?: string | null; linkLabel?: string | null;
    startsAt?: string | null; expiresAt?: string | null;
  }) => req<{ announcement: AdminAnnouncement }>("POST", "/api/admin/announcements", body),
  clearAnnouncement: () =>
    req<{ ok: true; deactivated: number }>("POST", "/api/admin/announcements/clear"),

  // Discord settings. The link-reward prize lives in the database rather than
  // the environment so it can be changed here, without a redeploy.
  getDiscordConfig: () => req<DiscordConfig>("GET", "/api/admin/discord-config"),
  putDiscordConfig: (body: {
    linkRewardEnabled: boolean; linkReward?: GiveawayPrizeInput[];
    aceTrainerMinLevel?: number; championMinMatches?: number;
    xpEnabled?: boolean; xpPerMessageMin?: number; xpPerMessageMax?: number;
    xpCooldownSec?: number; xpIgnoredChannels?: string;
  }) => req<DiscordConfig>("PUT", "/api/admin/discord-config", body),
  discordStats: () => req<DiscordStats>("GET", "/api/admin/discord-stats"),
  discordLinks: (q = "", limit = 50, offset = 0) =>
    req<{ total: number; links: DiscordLinkRow[] }>(
      "GET",
      `/api/admin/discord-links?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    ),
  discordUnlink: (discordId: string) =>
    req<{ ok: true; removed: boolean }>("DELETE", `/api/admin/discord-links/${encodeURIComponent(discordId)}`),

  // Giveaways
  listGiveawaysAdmin: () => req<{ giveaways: AdminGiveaway[] }>("GET", "/api/admin/giveaways"),
  createGiveaway: (body: {
    title: string; description: string; winnerCount: number;
    prizes: GiveawayPrizeInput[]; minAccountLevel?: number | null;
    startsAt?: string | null; endsAt?: string | null;
    announceToDiscord?: boolean; discordChannelId?: string | null;
  }) => req<{ giveaway: AdminGiveaway }>("POST", "/api/admin/giveaways", body),
  patchGiveaway: (id: string, body: Record<string, unknown>) =>
    req<{ giveaway: AdminGiveaway }>("PATCH", `/api/admin/giveaways/${id}`, body),
  /** Direct mass grant (not a raffle) of prizes to a whole audience at once.
   *  Runs in the background server-side; returns the resolved recipient count. */
  massGift: (body: {
    audience: "all" | "online" | "selected";
    userIds?: string[];
    prizes: GiveawayPrizeInput[];
    announce?: string;
    minAccountLevel?: number | null;
  }) => req<{ started: true; recipientCount: number }>("POST", "/api/admin/mass-gift", body),
  deleteGiveaway: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/giveaways/${id}`),
  /** Irreversible. Picks winners from a stored seed and writes prizes
   *  into their saves. Returns per-winner grant results so a partial
   *  payout is visible rather than assumed. */
  // Polls
  listPollsAdmin: () => req<{ polls: AdminPoll[] }>("GET", "/api/admin/polls"),
  createPoll: (body: { question: string; options: string[] }) =>
    req<{ poll: AdminPoll }>("POST", "/api/admin/polls", body),
  patchPoll: (id: string, body: Record<string, unknown>) =>
    req<{ poll: AdminPoll }>("PATCH", `/api/admin/polls/${id}`, body),
  deletePoll: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/polls/${id}`),

  drawGiveaway: (id: string) =>
    req<{
      ok: true; seed: string; entryCount: number;
      winners: { username: string; ok: boolean; error?: string }[];
    }>("POST", `/api/admin/giveaways/${id}/draw`),

  // Live ops — real-time snapshot of who is connected + last 30
  // minutes of activity (chat, signups, trades, PvP). Polled by the
  // Live ops page every 5 s.
  liveOps: () => req<LiveOps>("GET", "/api/admin/live-ops"),

  // Audit log — every admin action that touches another user lands
  // here. Newest-first, capped at 200 rows server-side.
  listAudit: (limit = 100) =>
    req<{ entries: AuditEntry[] }>(
      "GET",
      `/api/admin/audit?limit=${limit}`,
    ),

  // Bug reports — list + status update
  listBugReports: (status = "", limit = 50, offset = 0) =>
    req<{ reports: BugReport[] }>(
      "GET",
      `/api/admin/bug-reports?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}`,
    ),
  updateBugReport: (id: string, body: { status?: string; adminNotes?: string }) =>
    req<{ ok: true }>("PATCH", `/api/admin/bug-reports/${id}`, body),

  // Error log — server + client errors.
  // `total` is the count across the WHOLE table, so the caller can tell
  // the operator when what they are looking at is a truncated slice.
  listErrors: (kind = "", limit = 100) =>
    req<{ total: number; limit: number; truncated: boolean; errors: ErrorEntry[] }>(
      "GET",
      `/api/admin/errors?kind=${encodeURIComponent(kind)}&limit=${limit}`,
    ),

  // True counts, grouped server-side over the whole table. The grouped
  // view must NOT be computed from the capped row list — those counts
  // are a floor and understate exactly the runaway error the operator
  // is trying to find.
  /** Delete every row for a resolved (kind, fingerprint) — fingerprint,
   *  not the raw sample message, since a group can contain rows whose
   *  message differs only in embedded variable data (an id, a version
   *  number). Once a bug is actually fixed its history buries live
   *  problems and inflates the error KPI forever. Audited server-side
   *  with the row count. */
  clearErrorGroup: (kind: "server" | "client", fingerprint: string) =>
    req<{ ok: true; deleted: number }>("POST", "/api/admin/errors/clear-group", { kind, fingerprint }),

  listErrorGroups: (kind = "", days = 14) =>
    req<{ sinceDays: number; groups: ErrorGroup[] }>(
      "GET",
      `/api/admin/errors/groups?kind=${encodeURIComponent(kind)}&days=${days}`,
    ),

  // Tournaments — bracket-style PvP events.
  //
  // Players sign themselves up (POST /api/pvp/tournaments/:id/join); the
  // endpoints here are the operator's tools. Once the bracket is
  // generated, server/src/lib/tournamentRunner.ts drives the event on a
  // timer — starting each pairing when both players happen to be online,
  // applying results, and deciding a pairing whose round window expired.
  // runTournament / resolveTournamentMatch are overrides on top of that.
  listTournaments: () =>
    req<{ tournaments: AdminTournament[] }>("GET", "/api/admin/tournaments"),
  createTournament: (input: {
    name: string;
    levelCap: number | null;
    format?: string;
    roundWindowMinutes?: number;
    autoRun?: boolean;
    prizes?: string | null;
  }) =>
    req<{ tournament: AdminTournament }>("POST", "/api/admin/tournaments", input),
  deleteTournament: (id: string) =>
    req<{ ok: true }>("DELETE", `/api/admin/tournaments/${id}`),
  patchTournament: (
    id: string,
    body: {
      name?: string;
      levelCap?: number | null;
      status?: string;
      roundWindowMinutes?: number;
      autoRun?: boolean;
      prizes?: string | null;
    },
  ) =>
    req<{ tournament: AdminTournament }>("PATCH", `/api/admin/tournaments/${id}`, body),
  addTournamentEntry: (id: string, username: string) =>
    req<{ entry: AdminTournamentEntry }>("POST", `/api/admin/tournaments/${id}/entries`, { username }),
  removeTournamentEntry: (id: string, entryId: string) =>
    req<{ ok: true }>("DELETE", `/api/admin/tournaments/${id}/entries/${entryId}`),
  startTournamentMatch: (id: string, aUserId: string, bUserId: string) =>
    req<{ ok: true; battleId: string }>(
      "POST",
      `/api/admin/tournaments/${id}/match`,
      { aUserId, bUserId },
    ),
  generateBracket: (id: string) =>
    req<{ tournament: AdminTournament }>(
      "POST",
      `/api/admin/tournaments/${id}/generate-bracket`,
    ),
  advanceBracket: (id: string) =>
    req<{ tournament: AdminTournament; championId: string | null }>(
      "POST",
      `/api/admin/tournaments/${id}/advance-bracket`,
    ),
  startBracketMatch: (id: string, matchId: string) =>
    req<{ ok: true; battleId: string }>(
      "POST",
      `/api/admin/tournaments/${id}/start-bracket-match`,
      { matchId },
    ),
  /** Force a runner tick now instead of waiting for the 15s sweep. */
  runTournament: (id: string) =>
    req<{ actions: RunnerAction[]; tournament: AdminTournament }>(
      "POST",
      `/api/admin/tournaments/${id}/run`,
    ),
  /** Operator override: decide a pairing by hand (withdrawal, dispute,
   *  agreed concession). Goes through the same advance path as a real
   *  result, so the bracket can't end up in a shape the runner doesn't
   *  understand. */
  resolveTournamentMatch: (id: string, matchId: string, winnerUserId: string, note?: string) =>
    req<{ tournament: AdminTournament; championId: string | null }>(
      "POST",
      `/api/admin/tournaments/${id}/matches/${matchId}/resolve`,
      { winnerUserId, note },
    ),
};

export interface RunnerAction {
  kind: "started" | "advanced" | "walkover" | "reaped" | "completed" | "deadline-armed";
  tournamentId: string;
  matchId?: string;
  detail?: string;
}

export interface BugReport {
  id: string;
  reporterId: string | null;
  reporterName: string;
  title: string;
  description: string;
  page: string | null;
  userAgent: string | null;
  context: string | null;
  status: "open" | "investigating" | "resolved" | "wontfix";
  adminNotes: string | null;
  /** "game" (the in-game Report Bug modal) or "discord" (ingested from the
   *  community server's bug channel by the bot). */
  source?: string;
  /** Set for Discord-sourced reports. `page` holds a jump link to the original
   *  message, so triage can read the thread and reply to the reporter. */
  discordMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserSession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  country: string | null;
}

export interface StreamConfig {
  startRoute?: string;
  autoBuyBalls?: { enabled: boolean; ballId: string; restockTo: number };
  /** Desktop layout the streamed browser boots into. */
  layout?: "classic" | "wide";
  autoProceed?: boolean;
  autoCatch?: boolean;
  speed?: number;
}

export type StreamCommand =
  | { kind: "travel"; locationId: string }
  | { kind: "speed"; value: number }
  | { kind: "autoProceed"; value: boolean }
  | { kind: "autoCatch"; value: boolean }
  | { kind: "raid"; tier?: string }
  | { kind: "gym"; gymId: string }
  | { kind: "eliteFour" }
  | { kind: "champion" };

export interface StreamKeyStatus {
  exists: boolean;
  enabled?: boolean;
  label?: string | null;
  config?: StreamConfig | null;
  createdAt?: string;
  lastUsedAt?: string | null;
  lastUsedIp?: string | null;
  key?: string;
  loginUrl?: string;
}

/** Input relayed to the streamed browser. x/y are normalised 0..1. */
export type BrowserInput =
  | { kind: "click"; x: number; y: number; button?: "left" | "right"; clicks?: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; dy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "reload" }
  | { kind: "home" }
  | { kind: "navigate"; url: string };

export interface TwitchChannel {
  title: string;
  gameName: string;
  gameId: string;
  tags: string[];
  broadcasterLogin: string;
}
export interface TwitchInfo {
  configured: boolean;
  channel?: TwitchChannel;
  error?: string;
}

export interface BroadcastPatch {
  enabled?: boolean;
  account?: string | null;
  width?: number;
  height?: number;
  fps?: number;
  bitrateKbps?: number;
}

export interface BroadcastEncoderStats {
  fps?: number;
  bitrate?: string;
  frame?: number;
  dropped?: number;
  speed?: string;
}

export interface BroadcastStatus {
  enabled: boolean;
  account: { id: string; username: string; name: string | null } | null;
  accountUserId: string | null;
  streamKeyReady: boolean;
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  live: boolean;
  statusStale: boolean;
  status: {
    live?: boolean;
    account?: string | null;
    startedAt?: number | null;
    restarts?: number;
    lastError?: string | null;
    encoder?: BroadcastEncoderStats | null;
    music?: number;
  } | null;
  lastStatusAt: string | null;
  updatedAt: string;
}

export interface UserMessage {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
}

export interface UserTrade {
  id: string;
  createdAt: string;
  userAId: string;
  userAUsername: string;
  userASentMon: string;       // JSON-serialized Pokémon
  userASentSpecies: string;
  userASentLevel: number;
  userBId: string;
  userBUsername: string;
  userBSentMon: string;
  userBSentSpecies: string;
  userBSentLevel: number;
}

export interface AdminTournamentEntry {
  id: string;
  userId: string;
  username: string;
  eliminated: boolean;
  /** 1 = top seed. Assigned from ELO when the bracket is generated. */
  seed: number | null;
  /** The rating that seed was computed from. */
  ratingAtSeed?: number | null;
}

export interface AdminTournament {
  id: string;
  createdAt: string;
  startsAt: string | null;
  finishedAt: string | null;
  name: string;
  format: string;
  levelCap: number | null;
  status: string;
  bracket: string | null;
  ownerId: string;
  /** Minutes each ROUND stays open. Default 1440 (24h). */
  roundWindowMinutes: number;
  /** Whether the server-side runner drives this event. */
  autoRun: boolean;
  championId: string | null;
  championUsername: string | null;
  prizes: string | null;
  prizeGrantedAt: string | null;
  entries: AdminTournamentEntry[];
}

export interface ErrorGroup {
  kind: "server" | "client";
  /** Variable data (ids, uuids, timestamps, digit runs) normalized to
   *  placeholders — the actual group-by key server-side. Use this, not
   *  `message`, for drill-down joins and Resolve. */
  fingerprint: string;
  /** A real sample message, for display only — not the group key. */
  message: string;
  /** True count across the whole table for this fingerprint — not
   *  a tally of however many rows the page happened to fetch. */
  count: number;
  latestAt: string;
  sample: {
    id: string;
    level: "error" | "warn";
    source: string | null;
    stack: string | null;
    userId: string | null;
    username: string | null;
    userAgent: string | null;
  } | null;
}

export interface ErrorEntry {
  id: string;
  kind: "server" | "client";
  level: "error" | "warn";
  message: string;
  /** Same normalization as ErrorGroup.fingerprint — join on this, not
   *  `message`, when matching a row to a group. */
  fingerprint: string;
  stack: string | null;
  source: string | null;
  userId: string | null;
  username: string | null;
  userAgent: string | null;
  meta: unknown;
  createdAt: string;
}

export { ApiError };
