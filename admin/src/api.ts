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
    throw new ApiError(res.status, err?.error ?? res.statusText, err);
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
  /** null on a winner = prize grant failed; they still need paying. */
  claimedAt: string | null;
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
  /** announce: optional gift-card text posted to Global chat on success
   *  (e.g. "gave @user a Shiny Charizard!") — omit for a silent edit. */
  savePatch: (id: string, patch: Record<string, unknown>, announce?: string) =>
    req<{ ok: true; id: string; saveVersion: number; accountLevel: number; pokedexCaughtCount: number; keys: string[] }>(
      "POST",
      `/api/admin/users/${id}/save-patch`,
      { patch, announce },
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

  // Analytics
  analytics: () => req<Analytics>("GET", "/api/admin/analytics"),

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

  // Giveaways
  listGiveawaysAdmin: () => req<{ giveaways: AdminGiveaway[] }>("GET", "/api/admin/giveaways"),
  createGiveaway: (body: {
    title: string; description: string; winnerCount: number;
    prizes: GiveawayPrizeInput[]; minAccountLevel?: number | null;
    startsAt?: string | null; endsAt?: string | null;
  }) => req<{ giveaway: AdminGiveaway }>("POST", "/api/admin/giveaways", body),
  patchGiveaway: (id: string, body: Record<string, unknown>) =>
    req<{ giveaway: AdminGiveaway }>("PATCH", `/api/admin/giveaways/${id}`, body),
  deleteGiveaway: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/giveaways/${id}`),
  /** Irreversible. Picks winners from a stored seed and writes prizes
   *  into their saves. Returns per-winner grant results so a partial
   *  payout is visible rather than assumed. */
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

  // Tournaments — bracket-style PvP events. v1 admin tools only:
  // create / list / delete / register / schedule a one-off match.
  // Player-facing browse UI is a follow-up.
  listTournaments: () =>
    req<{ tournaments: AdminTournament[] }>("GET", "/api/admin/tournaments"),
  createTournament: (input: { name: string; levelCap: number | null; format?: string }) =>
    req<{ tournament: AdminTournament }>("POST", "/api/admin/tournaments", input),
  deleteTournament: (id: string) =>
    req<{ ok: true }>("DELETE", `/api/admin/tournaments/${id}`),
  patchTournament: (id: string, body: { name?: string; levelCap?: number | null; status?: string }) =>
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
};

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
  seed: number | null;
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
