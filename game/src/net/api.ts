// Thin API client. All requests are credentialed (sends cookies) so the
// Better Auth session travels with every call.

const SERVER_URL = (import.meta as any).env?.VITE_SERVER_URL ?? "http://localhost:8787";

export const SERVER_BASE = SERVER_URL;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`${SERVER_URL}${path}`, init);
  if (!res.ok) {
    // Servers in this stack return errors in two shapes:
    //   - Custom routes (saves, friends, admin):  { error: "..." }
    //   - Better Auth:                            { message: "...", code: "..." }
    // Capture both so callers can map by code where available, and fall
    // back to the human-readable message otherwise.
    let body: any = null;
    try { body = await res.json(); } catch { /* */ }
    const message = body?.message ?? body?.error ?? res.statusText;
    const code = typeof body?.code === "string" ? body.code : null;
    throw new ApiError(res.status, message, code, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
    public details?: any,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const api = {
  // Auth (Better Auth endpoints — JSON-bodied)
  signUp: (input: { email: string; password: string; name: string; username: string }) =>
    request<{ user: ProfileUser }>("POST", "/api/auth/sign-up/email", input),
  signInEmail: (input: { email: string; password: string }) =>
    request<{ user: ProfileUser }>("POST", "/api/auth/sign-in/email", input),
  signInUsername: (input: { username: string; password: string }) =>
    request<{ user: ProfileUser }>("POST", "/api/auth/sign-in/username", input),
  signOut: () => request<void>("POST", "/api/auth/sign-out"),
  // Sledgehammer fallback — also deletes every session row server-side
  // and clears all auth cookies. Belt-and-braces alongside Better
  // Auth's signOut for cases where the cross-origin Set-Cookie clear
  // gets dropped by the browser.
  signOutAll: () => request<{ ok: true }>("POST", "/api/auth/sign-out-all"),
  getSession: () => request<{ user: ProfileUser } | null>("GET", "/api/auth/get-session"),
  // Better Auth expects a POST to /sign-in/social with the provider id +
  // callbackURL. It responds with the OAuth provider's auth URL, which
  // the client then navigates to. (There's no GET-able social sign-in
  // route — that path 404s.)
  signInSocial: (input: { provider: "google"; callbackURL: string }) =>
    request<{ url: string; redirect: boolean }>(
      "POST",
      "/api/auth/sign-in/social",
      input,
    ),
  authProviders: () => request<{ google: boolean }>("GET", "/api/auth/providers"),

  // Password reset — request sends an email, reset takes the token from
  // that email + a new password. The server's `redirectTo` is checked
  // against trustedOrigins so we always pass our own origin's reset
  // page; the token is appended by Better Auth on its 302 to that URL.
  requestPasswordReset: (input: { email: string; redirectTo: string }) =>
    request<{ status: boolean; message?: string }>(
      "POST",
      "/api/auth/request-password-reset",
      input,
    ),
  resetPassword: (input: { token: string; newPassword: string }) =>
    request<{ status: boolean }>(
      "POST",
      "/api/auth/reset-password",
      input,
    ),

  // Profile
  meProfile: () => request<MeProfile>("GET", "/api/profile/me"),
  publicProfile: (username: string) =>
    request<PublicProfile>("GET", `/api/profile/${encodeURIComponent(username)}`),
  // Trade history — caller-scoped, returns the last 50 trades with a
  // normalised {sent, received, partner} shape.
  myTradeHistory: () => request<{ trades: TradeHistoryRow[] }>("GET", "/api/profile/me/trades"),
  // Public trainer directory — top trainers by level / dex / Σ-levels.
  trainerDirectory: (sort: "level" | "dex" | "sigma" = "level", limit = 30) =>
    request<{ trainers: PublicProfile[]; sort: string }>(
      "GET",
      `/api/profile/directory?sort=${sort}&limit=${limit}`,
    ),

  // PvP — rating, history, leaderboard, tournaments
  myRating: () => request<RatingRow>("GET", "/api/pvp/me/rating"),
  ratingFor: (userId: string) => request<RatingRow>("GET", `/api/pvp/rating/${encodeURIComponent(userId)}`),
  pvpLeaderboard: (limit = 50, minMatches = 5) =>
    request<{ leaderboard: LeaderboardRow[] }>(
      "GET",
      `/api/pvp/leaderboard?limit=${limit}&minMatches=${minMatches}`,
    ),
  myPvpHistory: (limit = 20) =>
    request<{ matches: PvpHistoryRow[] }>("GET", `/api/pvp/me/history?limit=${limit}`),
  matchReplay: (id: string) =>
    request<{ match: PvpReplayMatch }>("GET", `/api/pvp/match/${id}/replay`),
  listTournaments: () =>
    request<{ tournaments: PublicTournament[] }>("GET", "/api/pvp/tournaments"),
  tournamentDetail: (id: string) =>
    request<{ tournament: PublicTournament }>("GET", `/api/pvp/tournaments/${id}`),
  joinTournament: (id: string) =>
    request<{ entry: PublicTournamentEntry }>("POST", `/api/pvp/tournaments/${id}/join`),
  leaveTournament: (id: string) =>
    request<{ ok: true }>("DELETE", `/api/pvp/tournaments/${id}/leave`),

  // Public — no auth required. Used by the pre-sign-in landing screen.
  publicOnlineCount: () => request<{ count: number }>("GET", "/api/public/online"),

  // Giveaways
  listGiveaways: () => request<{ giveaways: PublicGiveaway[] }>("GET", "/api/giveaways"),
  enterGiveaway: (id: string) =>
    request<{ ok: true; alreadyEntered: boolean; entryCount?: number }>(
      "POST",
      `/api/giveaways/${id}/enter`,
    ),

  // Saves
  getSave: () => request<{ saveData: any | null; saveVersion: number; saveUpdatedAt: string }>(
    "GET",
    "/api/saves"
  ),
  // putSave optionally accepts `expectedSaveVersion` — when set, the
  // server gates the write on the cloud copy still being at that
  // version (compare-and-swap). A 409 means a different device wrote
  // in between this client's last pull and now, OR this client is
  // trying to push state older than the cloud. Caller should handle
  // 409 by re-pulling and either re-applying its diff or surfacing a
  // conflict prompt — never silently overwrite.
  putSave: (saveData: any, expectedSaveVersion?: number) =>
    request<{ ok: true; saveVersion: number; saveUpdatedAt: string; accountLevel: number; totalCaughtLevels: number; pokedexCaughtCount: number }>(
      "POST",
      "/api/saves",
      expectedSaveVersion !== undefined ? { saveData, expectedSaveVersion } : { saveData }
    ),

  // Last-gasp save for pagehide / visibilitychange:hidden. A normal fetch
  // is cancelled when the page goes away, which is precisely the moment we
  // most need the write to land, so this uses keepalive — the browser
  // completes the request after the document is gone.
  //
  // Deliberately fire-and-forget: there is no page left to handle a
  // response, so this cannot participate in the compare-and-swap retry
  // logic. It is strictly a best-effort bonus on top of the localStorage
  // write, which is synchronous and always runs.
  //
  // keepalive caps the request body at 64KB across all in-flight keepalive
  // requests. Our p99 save is ~70KB and the largest real one is 129KB, so
  // for the biggest accounts this silently does nothing — hence "best
  // effort", and hence why localStorage carries the guarantee.
  putSaveBeacon: (saveData: any, expectedSaveVersion?: number): void => {
    try {
      const body = JSON.stringify(
        expectedSaveVersion !== undefined ? { saveData, expectedSaveVersion } : { saveData }
      );
      if (body.length > 60_000) return;   // over the keepalive budget; localStorage has it
      void fetch(`${SERVER_URL}/api/saves`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => { /* the page is going away; nothing to report to */ });
    } catch { /* never let the unload path throw */ }
  },

  // Announcements — the current pinned banner, or null.
  getActiveAnnouncement: () =>
    request<{ announcement: Announcement | null }>("GET", "/api/announcements/active"),

  // Daily rewards / login streak.
  dailyStatus: () => request<DailyStatus>("GET", "/api/dailies/status"),
  claimDaily: () =>
    request<{ ok: true; reward: DailyReward; streak: number; longestStreak: number; status: DailyStatus }>(
      "POST", "/api/dailies/claim"),

  // Friends
  listFriends: () => request<FriendList>("GET", "/api/friends"),
  requestFriend: (username: string) =>
    request<{ ok: true; status: "pending" | "accepted"; friendshipId: string }>(
      "POST",
      "/api/friends/request",
      { username }
    ),
  acceptFriend: (id: string) => request<{ ok: true }>("POST", `/api/friends/${id}/accept`),
  removeFriend: (id: string) => request<{ ok: true }>("DELETE", `/api/friends/${id}`),

  // Chat history
  chatHistory: (channelId: string, limit = 50) =>
    request<{ channelId: string; messages: ChatMessage[] }>(
      "GET",
      `/api/chat/${encodeURIComponent(channelId)}/history?limit=${limit}`
    ),

  // Public map positions — overrides the hard-coded values in routes.ts
  // when an admin has saved bespoke positions via the dashboard.
  mapPositions: () =>
    request<{ positions: Record<string, { x: number; y: number }> }>(
      "GET",
      "/api/map/positions"
    ),

  // Public map crop — lets the game zoom into the playable region of
  // the source town map image, hiding decorative borders.
  mapCrop: () =>
    request<{ crop: { x: number; y: number; w: number; h: number } | null }>(
      "GET",
      "/api/map/crop"
    ),

  // Bug reports + auto client-error capture. Both go through the same
  // server route file but get their own rate limits.
  submitBugReport: (input: {
    title: string;
    description: string;
    page?: string;
    userAgent?: string;
    context?: string;
  }) => request<{ ok: true; id: string }>("POST", "/api/bug-reports", input),

  reportClientError: (input: {
    message: string;
    stack?: string;
    source?: string;
    userAgent?: string;
    meta?: Record<string, unknown>;
  }) => request<{ ok: true }>("POST", "/api/bug-reports/client-error", input),
};

export interface RatingRow {
  userId: string;
  rating: number;
  peakRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  forfeits: number;
  unranked: boolean;
  lastMatchAt?: string | null;
  updatedAt?: string;
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  username: string;
  name: string | null;
  accountLevel: number;
  rating: number;
  peakRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  forfeits: number;
}

export interface PvpReplayMatch {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  format: string;
  status: string;
  userAId: string;
  userAUsername: string;
  userATeam: unknown;        // JSON array of Pokémon (the snapshot at trade time)
  userBId: string;
  userBUsername: string;
  userBTeam: unknown;
  winnerId: string | null;
  loserId: string | null;
  endReason: string | null;
  log: string[];             // Showdown protocol lines
}

export interface GiveawayPrize {
  kind: "item" | "money" | "pokemon";
  itemId?: string;
  quantity?: number;
  amount?: number;
  label?: string;
}

export interface PublicGiveaway {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "drawn";
  startsAt: string | null;
  endsAt: string | null;
  drawnAt: string | null;
  winnerCount: number;
  minAccountLevel: number | null;
  prizes: GiveawayPrize[];
  prizeSummary: string;
  entryCount: number;
  hasEntered: boolean;
  youWon: boolean;
  /** Public once drawn. Losers are never listed. */
  winners: string[];
  /** Published after the draw so the result can be independently
   *  recomputed and checked. Null until drawn. */
  drawSeed: string | null;
}

export interface PvpHistoryRow {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  format: string;
  opponent: { id: string; username: string };
  result: "win" | "loss" | "forfeit" | "draw";
  endReason: string | null;
}

export interface TradeHistoryMon {
  speciesKey: string;
  nickname: string;
  level: number;
}

export interface TradeHistoryRow {
  id: string;
  at: string;
  partnerUsername: string;
  partnerUserId: string | null;
  sent: TradeHistoryMon;
  received: TradeHistoryMon;
}

export interface PublicTournamentEntry {
  userId: string;
  username: string;
  eliminated: boolean;
  seed: number | null;
}

export interface PublicTournament {
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
  entries: PublicTournamentEntry[];
}

export interface ProfileUser {
  id: string;
  email: string;
  name: string | null;
  username: string;
  image: string | null;
}

export interface DailyReward {
  money: number;
  items: { itemId: string; quantity: number }[];
  label: string;
}
export interface DailyStatus {
  claimedToday: boolean;
  streak: number;
  longestStreak: number;
  streakIfClaimed: number;
  todayReward: DailyReward;
  nextClaimInMs: number;
}

export type AnnouncementType = "info" | "event" | "giveaway" | "warning" | "maintenance";

export interface Announcement {
  id: string;
  type: AnnouncementType;
  message: string;
  href: string | null;
  linkLabel: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface MeProfile {
  id: string;
  username: string;
  email: string;
  name: string | null;
  image: string | null;
  accountLevel: number;
  totalCaughtLevels: number;
  pokedexCaughtCount: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface PublicProfile {
  id: string;
  username: string;
  name: string | null;
  image: string | null;
  accountLevel: number;
  totalCaughtLevels: number;
  pokedexCaughtCount: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface FriendEntry {
  friendshipId: string;
  status: "pending" | "accepted";
  id: string;
  username: string;
  name: string | null;
  image: string | null;
  accountLevel: number;
  pokedexCaughtCount: number;
  lastSeenAt: string;
}
export interface FriendList {
  accepted: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  content: string;
  // "user" (default) | "announcement" | "giveaway" | "tradeOffer" — a
  // system/giveaway/trade card renders distinctly from ordinary chat.
  kind?: string;
  meta?: { offering?: string; wanting?: string } | null;
  createdAt: string;
  user: { id: string; username: string; name: string | null; accountLevel: number };
}
