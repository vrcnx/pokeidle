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
  createdAt: string;
  user: { id: string; username: string; name: string | null; isAdmin: boolean };
}

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
  dauSeries: Record<string, number>;
  pvpSeries: Record<string, number>;
  tradeSeries: Record<string, number>;
  levelBuckets: { label: string; count: number }[];
  leaderboards: {
    pokedex: { id: string; username: string; name: string | null; accountLevel: number; pokedexCaughtCount: number }[];
    sigmaLevels: { id: string; username: string; name: string | null; accountLevel: number; totalCaughtLevels: number }[];
  };
}

export interface AdminMe { id: string; username: string; isAdmin: boolean }

export const api = {
  // Auth probe — returns 401 if not signed in, 403 if signed in but
  // not admin, 200 if admin. Used by the auth gate at app boot.
  me: () => req<AdminMe>("GET", "/api/admin/me"),
  signOut: () => req<void>("POST", "/api/auth/sign-out"),

  // Users
  listUsers: (q: string, page = 0, pageSize = 25) =>
    req<{ total: number; page: number; pageSize: number; users: AdminUser[] }>(
      "GET",
      `/api/admin/users?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`
    ),
  getUser: (id: string) => req<any>("GET", `/api/admin/users/${id}`),
  setAdmin: (id: string, isAdmin: boolean) =>
    req<{ id: string; isAdmin: boolean }>("POST", `/api/admin/users/${id}/admin`, { isAdmin }),
  ban: (id: string, until: string | null, reason: string | null) =>
    req<any>("POST", `/api/admin/users/${id}/ban`, { until, reason }),
  deleteUser: (id: string) => req<{ ok: true }>("DELETE", `/api/admin/users/${id}`),
  resetSave: (id: string) =>
    req<{ id: string; saveVersion: number }>("POST", `/api/admin/users/${id}/reset-save`),
  savePatch: (id: string, patch: Record<string, unknown>) =>
    req<{ ok: true; id: string; saveVersion: number; accountLevel: number; pokedexCaughtCount: number; keys: string[] }>(
      "POST",
      `/api/admin/users/${id}/save-patch`,
      { patch },
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
  setUserItem: (id: string, itemId: string, quantity: number) =>
    req<{ ok: true; itemId: string; quantity: number }>(
      "POST",
      `/api/admin/users/${id}/items`,
      { itemId, quantity },
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

  // Error log — server + client errors
  listErrors: (kind = "", limit = 100) =>
    req<{ errors: ErrorEntry[] }>(
      "GET",
      `/api/admin/errors?kind=${encodeURIComponent(kind)}&limit=${limit}`,
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

export interface ErrorEntry {
  id: string;
  kind: "server" | "client";
  level: "error" | "warn";
  message: string;
  stack: string | null;
  source: string | null;
  userId: string | null;
  username: string | null;
  userAgent: string | null;
  meta: unknown;
  createdAt: string;
}

export { ApiError };
