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

export interface ReferralSummary {
  code: string;
  /** Friends recorded, whether or not they paid — these differ past the cap. */
  total: number;
  paid: number;
  cap: number;
  enabled: boolean;
  milestoneReached: boolean;
  /** Described by the server from its own config, so the card cannot
   *  advertise a prize the grant path would not actually pay. */
  perReferralSummary: string;
  milestoneSummary: string;
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

  // Discord account linking. The code is minted by the bot and DM'd to the
  // player; this half of the flow is the player proving, from a signed-in
  // session, that the game account is theirs. See server/src/lib/discordLink.ts
  // for why the code travels Discord → player → site and not the other way.
  // `inviteUrl` rides along so the link screen can offer a way INTO the
  // server it tells you to run /link in. Optional in the type because a
  // server older than that change answers without it, and a missing invite
  // must degrade to "no join button" rather than to a broken page.
  discordLinkStatus: () =>
    request<{ linked: boolean; discordId: string | null; inviteUrl?: string }>(
      "GET", "/api/discord/link/me",
    ),
  // Preview only — does NOT consume the code. Lets the confirm button name the
  // Discord account before the player commits to binding it.
  discordLinkPeek: (code: string) =>
    request<{ found: boolean; discordLabel?: string }>(
      "GET",
      `/api/discord/link/peek?code=${encodeURIComponent(code)}`,
    ),
  discordLinkRedeem: (input: { code: string }) =>
    request<{
      ok: true;
      discordLabel: string;
      /** The link-reward prize, when the promotion is running and this is the
       *  first time this account (and this Discord account) has linked.
       *  Null otherwise — the server deliberately does not say WHY it is null,
       *  so a player linking a second account isn't told about a prize they
       *  are not getting. */
      reward: { summary: string } | null;
    }>("POST", "/api/discord/link/redeem", input),
  discordUnlink: () =>
    request<{ ok: true; removed: boolean }>("DELETE", "/api/discord/link/me"),

  // The player's own referral card, and the only referral endpoint there is.
  // Nothing resolves a code back to a player or lists who somebody referred:
  // a referral link gets posted in public channels, and either of those would
  // turn that into a way to name whoever posted it. Attribution — crediting a
  // NEW account to a code — rides on POST /api/attribution instead, because it
  // is the same fact at the same moment under the same account-age guard.
  referralSummary: () => request<ReferralSummary>("GET", "/api/referrals/me"),

  // Profile
  meProfile: () => request<MeProfile>("GET", "/api/profile/me"),
  publicProfile: (username: string) =>
    request<PublicProfile>("GET", `/api/profile/${encodeURIComponent(username)}`),
  // Trade history — caller-scoped, returns the last 50 trades with a
  // normalised {sent, received, partner} shape.
  myTradeHistory: () => request<{ trades: TradeHistoryRow[] }>("GET", "/api/profile/me/trades"),
  // Renaming. Two calls rather than one PATCH of both fields: the server
  // gives them separate validation and separate cooldowns, so a handle
  // sitting on cooldown must not block fixing the display name — which
  // is the one an OAuth signup urgently wants changed.
  updateDisplayName: (name: string) =>
    request<{ ok: true; name: string }>("PATCH", "/api/profile/me/display-name", { name }),
  updateUsername: (username: string) =>
    request<{ ok: true; username: string }>("PATCH", "/api/profile/me/username", { username }),
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
  listGiveaways: () =>
    request<{ giveaways: PublicGiveaway[]; stats: GiveawayStats; hasMoreHistory: boolean }>(
      "GET",
      "/api/giveaways",
    ),
  // Read-only, cursor-paged archive. Exists because the list above is capped,
  // and the entire premise of showing history is that it keeps accumulating.
  giveawayHistory: (before?: string | null, limit = 20) =>
    request<{ giveaways: PublicGiveaway[]; hasMore: boolean; nextBefore: string | null }>(
      "GET",
      `/api/giveaways/history?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  enterGiveaway: (id: string) =>
    request<{ ok: true; alreadyEntered: boolean; entryCount?: number }>(
      "POST",
      `/api/giveaways/${id}/enter`,
    ),
  /** Free rewards for doing something outside the game. Read-only — there is
   *  deliberately no claim endpoint; see server/src/lib/promos.ts. */
  listPromos: () => request<{ promos: Promo[] }>("GET", "/api/giveaways/promos"),

  // Polls
  listPolls: () => request<{ polls: PublicPoll[] }>("GET", "/api/polls"),
  getPoll: (id: string) => request<{ poll: PublicPoll }>("GET", `/api/polls/${id}`),
  votePoll: (id: string, optionIndex: number) =>
    request<{ ok: true; tallies: number[]; totalVotes: number; myVote: number }>(
      "POST",
      `/api/polls/${id}/vote`,
      { optionIndex },
    ),

  // Auctions
  listAuctions: () => request<{ auctions: PublicAuction[] }>("GET", "/api/auctions"),
  getAuction: (id: string) =>
    request<{ auction: PublicAuction; bids: AuctionBid[] }>("GET", `/api/auctions/${id}`),
  myAuctions: () => request<{ selling: PublicAuction[]; bidding: PublicAuction[] }>("GET", "/api/auctions/mine"),
  createAuction: (
    input:
      | { pokemonId: string; startingBid: number; durationMinutes: number }
      | { itemId: string; startingBid: number; durationMinutes: number },
  ) =>
    request<{ auction: PublicAuction }>("POST", "/api/auctions", input),
  /**
   * `amount` is the bidder's MAXIMUM, not the price they pay. The server
   * raises on their behalf by the minimum increment only as far as it must.
   */
  placeBid: (id: string, amount: number) =>
    request<PlaceBidResult>("POST", `/api/auctions/${id}/bids`, { amount }),
  cancelAuction: (id: string) => request<{ ok: true }>("POST", `/api/auctions/${id}/cancel`),

  // Saves
  // `pendingGrants` is how many server-owed prizes (giveaway win, admin gift)
  // this account has not received yet. Informational — reading never delivers
  // them; see the comment on putSave below.
  getSave: () => request<{ saveData: any | null; saveVersion: number; saveUpdatedAt: string; saveAdoptSeq?: number; pendingGrants?: number }>(
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
  //
  // `grantAck: 1` is a CONTRACT, not a feature flag. It tells the server
  // "fold anything I am owed into this upload; I apply `grantsApplied` to my
  // own state, and I honour `saveAdoptSeq`". The server delivers only to a
  // client that sends it, because delivering to a client that does neither
  // means that client's next autosave overwrites the prize — precisely how
  // giveaway Master Balls were destroyed — and delivery happens exactly once,
  // so there is no second chance to lose.
  //
  // The `saveAdoptSeq` half is the load-bearing one. A fold bumps it, which
  // means "the server authoritatively rewrote this save; adopt the cloud copy
  // wholesale" — so any OTHER session of this account takes the copy holding
  // the prize instead of pushing its own stale bytes over it. `grantsApplied`
  // only spares the uploading tab that round trip. See absorbGrants and the
  // adopt paths in state/GameContext.tsx.
  //
  // It is sent ONLY alongside `expectedSaveVersion`, and the server refuses
  // the other combination outright: without a version the compare-and-swap
  // degrades to an unconditional write, so an upload built before this client
  // knew what the cloud held could overwrite a save it has never seen while
  // collecting a prize into it. An upload made before the boot reconcile knows
  // a real version (a bid placed on first paint, say) therefore collects
  // nothing; the grants stay owed and land on the next upload.
  putSave: (saveData: any, expectedSaveVersion?: number) =>
    request<{
      ok: true; saveVersion: number; saveUpdatedAt: string; accountLevel: number;
      totalCaughtLevels: number; pokedexCaughtCount: number;
      /** The account's adopt counter AFTER this write. If it is higher than
       *  the value this client last adopted, the cloud copy holds a
       *  server-authoritative rewrite and must be adopted WHOLESALE. When the
       *  bump is this request's own fold it arrives together with
       *  `grantsApplied`, which the client has already applied — see
       *  commitUploadResult for how it tells the two apart. */
      saveAdoptSeq?: number;
      /** Prizes the server folded into THIS upload, AS STORED: `quantity` /
       *  `amount` are the delta that actually landed (a recipient at the
       *  ceiling absorbs less than the grant promised) and `assignedId` is the
       *  id it gave a prize mon. Apply exactly these — reproducing the
       *  server's bytes is the point, and a mon under a different id is a
       *  duplicated prize. */
      grantsApplied?: GrantPrize[];
      /** Human summary of `grantsApplied`, e.g. "1x masterball". */
      grantsSummary?: string;
    }>(
      "POST",
      "/api/saves",
      expectedSaveVersion !== undefined
        ? { saveData, expectedSaveVersion, grantAck: 1 }
        : { saveData }
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
  // For the same reason it deliberately does NOT send `grantAck`: there is
  // nobody left to read `grantsApplied` off the response, so asking the server
  // to deliver owed prizes here would mark them delivered into a page that can
  // never absorb them. Owed prizes wait for the next real upload instead.
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

  // Away-time catch-up progress. The server measures the away period from its
  // OWN record of when this account last uploaded a save — the client sends no
  // time, no duration and no amount, so the system clock is irrelevant.
  //
  // MUST be called before this session's first putSave: that upload is what
  // moves the mark the away period is measured from. See the boot sequence in
  // state/GameContext.tsx.
  //
  // The money does not arrive in this response. `claimAway` makes the reward
  // OWED (one PendingGrant row) and the next putSave folds it in and echoes it
  // as `grantsApplied` — the same two-step every giveaway prize takes, and the
  // reason this feature needs no save-write path of its own.
  awayStatus: () => request<AwayProgress>("GET", "/api/away/status"),
  claimAway: () =>
    request<AwayProgress & { ok: true; claimed: boolean; grantId?: string }>(
      "POST", "/api/away/claim"),

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

export interface PublicPoll {
  id: string;
  question: string;
  options: string[];
  status: "draft" | "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  tallies: number[];
  totalVotes: number;
  myVote: number | null;
}

export interface PublicAuction {
  id: string;
  sellerUsername: string | null;
  /**
   * True when this is the VIEWER'S OWN listing. The server refuses a bid on
   * your own lot, so the card renders a "this is yours" panel instead of a
   * bid box that can never succeed.
   */
  youAreSeller: boolean;
  /**
   * Which kind of lot this is. Exactly one of `pokemon` / `item` is non-null,
   * and this says which without the caller having to probe them.
   */
  lotKind: "pokemon" | "item";
  pokemon: unknown; // Pokemon snapshot at listing time — cast at the call site
  /** For `lotKind: "item"` — a TM or HM. Machines are the only items sold. */
  item: { itemId: string; quantity: number } | null;
  startingBid: number;
  currentBid: number;
  currentBidderUsername: string | null;
  bidCount: number;
  /** Distinct bidders — the signal the minimum increment escalates on. */
  distinctBidders: number;
  /**
   * What THIS viewer must bid at least, computed server-side for this
   * viewer specifically (a returning repeat-bidder faces a higher minimum
   * than a newcomer). Display and prefill only — the server recomputes it
   * on submit and is the sole authority.
   */
  minNextBid: number;
  /** The raise component of minNextBid, for explaining the rule. 0 if unbid. */
  minIncrement: number;
  youAreHighBidder: boolean;
  /**
   * The viewer's OWN secret maximum on this lot, or null. The server only
   * ever populates this for its owner — no response contains anyone else's.
   */
  yourMax: number | null;
  status: "active" | "sold" | "cancelled" | "expired";
  endsAt: string;
  createdAt: string;
  settledAt: string | null;
}

/** Response to POST /api/auctions/:id/bids. */
export interface PlaceBidResult {
  ok: true;
  currentBid: number;
  endsAt: string;
  youAreHighBidder: boolean;
  /** Your own maximum, echoed back. Never another player's. */
  yourMax: number | null;
  /** True when a hidden maximum beat you the instant you submitted. */
  outbidImmediately?: boolean;
  /** False when you only raised your own maximum — the price did not move. */
  priceMoved: boolean;
}

export interface AuctionBid {
  id: string;
  amount: number;
  username: string;
  createdAt: string;
}

export interface GiveawayPrize {
  kind: "item" | "money" | "pokemon";
  itemId?: string;
  quantity?: number;
  amount?: number;
  label?: string;
  /**
   * The full serialised mon on a `pokemon` prize. The server has ALWAYS sent
   * this (it is stored whole so nobody has to re-derive stats — see
   * lib/giveaway.ts) and this type simply never admitted it, which is the only
   * reason a Pokémon prize could not be drawn as a Pokémon. `speciesKey`,
   * `isShiny` and `level` are the three fields the sprite path needs.
   */
  mon?: Record<string, unknown>;
}

/**
 * A prize as the server ACTUALLY APPLIED it, echoed by POST /api/saves.
 *
 * Distinct from GiveawayPrize (which describes an advertised prize) because
 * these fields are a record of a write that already happened: `mon` is the
 * full serialised Pokémon and `assignedId` is the id it was stored under. The
 * client must adopt that id rather than mint its own — the box reconcile
 * dedupes by id, so two ids for one mon means the merge sees two Pokémon and
 * a one-off prize is duplicated.
 */
export interface GrantPrize extends GiveawayPrize {
  mon?: Record<string, unknown>;
  assignedId?: string;
}

export interface PublicGiveaway {
  id: string;
  title: string;
  description: string;
  status: "open" | "closed" | "drawn";
  /** When it was published. The only date every row is guaranteed to have —
   *  endsAt and drawnAt are both nullable, so history sorts and labels on
   *  this when the others are missing. */
  createdAt: string;
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
  /**
   * Whether the viewer's own prize has physically landed in their save.
   * `null` = they did not win, or the win predates the PendingGrant queue and
   * delivery is simply not knowable — say nothing rather than guess.
   */
  youWonDelivered: boolean | null;
  /** Public once drawn. Losers are never listed. */
  winners: string[];
  /** Published after the draw so the result can be independently
   *  recomputed and checked. Null until drawn. */
  drawSeed: string | null;
}

/**
 * Lifetime, aggregate-only giveaway numbers, plus the viewer's own record.
 * One line of these ("13 giveaways · 68 prizes to 39 trainers · since 17 Jul")
 * is what makes the feature read as real and recurring to somebody who was
 * offline for the last three.
 */
export interface GiveawayStats {
  total: number;
  prizesAwarded: number;
  distinctWinners: number;
  firstAt: string | null;
  you: { entered: number; won: number };
}

/**
 * A free reward for doing something outside the game — joining the Discord,
 * and whatever comes after it.
 *
 * Not a giveaway: there is no draw, no entry and no competition. The prize is
 * granted by the thing that proves you did it, so this type describes an offer
 * rather than something the client can act on beyond following the link.
 */
export interface Promo {
  id: string;
  title: string;
  blurb: string;
  /** A key the client maps to artwork, not a URL or an emoji. */
  icon: string;
  prizes: GiveawayPrize[];
  state: "available" | "claimed" | "locked";
  cta: { label: string; href: string } | null;
  note: string | null;
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

/**
 * Away-time catch-up progress, as the server computed it.
 *
 * Every field is server-derived. `minMs` / `capMs` are echoed rather than
 * duplicated client-side so the UI explains the actual rules in force instead
 * of a second copy of them that drifts after a balance change.
 */
export interface AwayProgress {
  /** Away time below this earns nothing. */
  minMs: number;
  /** Away time stops accruing past this. */
  capMs: number;
  /** When the away period started, per the server. Null = this account has
   *  never uploaded a save, so there is no anchor to measure from. */
  awaySince: string | null;
  /** Real elapsed time since `awaySince`. */
  elapsedMs: number;
  /** Elapsed time after the cap — what was actually paid for. */
  creditedMs: number;
  /** True when the player was away longer than `capMs`. Surfaced so the UI can
   *  say "capped at 8h" rather than quietly paying for less than the gap. */
  capped: boolean;
  /** Badge-scaled hourly rate this account earns while away. */
  moneyPerHour: number;
  money: number;
  claimable: boolean;
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
  /** ISO instant the next username / display-name change unlocks, or null
   *  when it can be changed right now. Resolved server-side so the client
   *  never carries its own copy of the cooldown length. */
  usernameChangeAllowedAt?: string | null;
  displayNameChangeAllowedAt?: string | null;
  /** True when this is a restricted OBS/24-7 stream auto-login session.
   *  The client uses it to auto-dismiss popups (update / daily / etc.) and
   *  hide sensitive UI (trades, auctions, account settings). */
  isStream?: boolean;
  /** Admin-set stream automation for this session (start route, auto-buy
   *  balls). Present only for stream sessions. */
  streamConfig?: {
    startRoute?: string;
    autoBuyBalls?: { enabled: boolean; ballId: string; restockTo: number };
  } | null;
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
  // "user" (default) | "announcement" | "giveaway" | "giveawayOpen" |
  // "tradeOffer" | "gift" | "pollOpen" — a system/giveaway/trade/gift/
  // poll card renders distinctly from ordinary chat.
  kind?: string;
  meta?: { offering?: string; wanting?: string; giveawayId?: string; username?: string; pollId?: string } | null;
  createdAt: string;
  user: { id: string; username: string; name: string | null; accountLevel: number; isAdmin?: boolean };
}
