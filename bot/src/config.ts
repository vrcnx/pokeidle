// Environment, parsed once and validated loudly.
//
// Every value the bot cannot run without is checked HERE, at boot, with a
// message naming the variable. The alternative — reading process.env at the
// point of use — produces a bot that starts fine, sits in the server looking
// healthy, and throws on the first person to run a command. A misconfigured
// deploy should fail to start.

// ── WHY NOTHING HERE CALLS process.exit ─────────────────────────────
//
// It used to. A missing variable printed one line and exited 1, which is
// correct behaviour almost everywhere and wrong on this deploy: railway.json
// sets `restartPolicyType: ALWAYS`, so exiting starts a new container, which
// exits, which starts a new container. The same shape that spent a day's worth
// of Discord identifies through client.login — see the comment at the bottom
// of index.ts.
//
// So a fatal config error now REPORTS EVERYTHING WRONG AT ONCE and then parks
// the process alive. Two reasons:
//
//   * Staying alive is what stops the platform restarting us. A parked
//     container is a readable log; a restart loop is the same line ten thousand
//     times with the useful part scrolled away.
//   * Exiting on the FIRST missing variable meant fixing one, redeploying,
//     waiting, and discovering the next. With five required variables that is
//     five deploys to learn five facts we knew at the first boot.

const missing: string[] = [];
const invalid: string[] = [];

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    missing.push(name);
    return "";
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function intOpt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The shared secret for the game server's /api/bot surface.
 *
 * Checked for length here as well as on the server. The server refuses a
 * secret under 32 characters and answers 401 — which, from this side, is
 * indistinguishable from a wrong token, and would send whoever is debugging it
 * hunting for a typo instead of a length. Better to say so at boot.
 */
function botToken(): string {
  const v = required("BOT_TOKEN");
  if (v && v.length < 32) {
    invalid.push(
      "BOT_TOKEN is shorter than 32 characters. The game server refuses to honour " +
        "a secret that short — it answers 401 for every call, which looks exactly " +
        "like a wrong token. Generate one with: openssl rand -hex 32",
    );
  }
  return v;
}

/** Report every problem at once, then hang forever. Called at the bottom of
 *  this module, after every value has been read. */
async function reportAndPark(): Promise<never> {
  console.error("");
  console.error("=== CONFIGURATION ERROR ===");
  if (missing.length) {
    console.error("Missing required environment variables:");
    for (const m of missing) console.error(`  - ${m}`);
  }
  for (const m of invalid) console.error(`  - ${m}`);
  console.error("");
  console.error("On Railway these live under the service -> Variables.");
  console.error("A local .env is NOT used by the deploy; the two are separate.");
  console.error("");
  console.error("Not exiting: exiting would let restartPolicyType:ALWAYS restart me");
  console.error("into this same error forever, and scroll this message away.");
  console.error("Fix the variables and redeploy.");
  console.error("");
  // A no-op interval is the cheapest way to hold the event loop open, and it is
  // deliberately NOT unref'd — staying alive is the entire point.
  setInterval(() => {}, 1 << 30);
  // Never resolves, so module evaluation stops here and nothing downstream
  // runs against half-built config.
  return new Promise<never>(() => {});
}

export const config = {
  /** Discord bot token, from the Developer Portal. NEVER logged. */
  discordToken: required("DISCORD_BOT_TOKEN"),
  /** Application id, used only to register slash commands. */
  clientId: required("DISCORD_CLIENT_ID"),
  /**
   * The one guild this bot serves.
   *
   * Commands are registered PER-GUILD rather than globally: guild commands
   * propagate instantly (global ones take up to an hour to appear), and this
   * bot is for one community server, so the global scope would only mean a
   * slower feedback loop and a bot that could be invited somewhere it has no
   * business being.
   */
  guildId: required("DISCORD_GUILD_ID"),

  /** Base URL of the game server, e.g. https://api.pokeidle.com */
  apiBase: required("API_BASE").replace(/\/+$/, ""),
  botToken: botToken(),

  /** #trade-chat — where trade listings are posted. */
  tradeChannelId: optional("DISCORD_TRADE_CHANNEL_ID", ""),
  /** #mod-log — where giveaway outcomes are posted for audit. */
  modLogChannelId: optional("DISCORD_MOD_LOG_CHANNEL_ID", ""),
  /**
   * The bug-report channel, whose posts are ingested into the admin
   * dashboard's triage queue. Text channel or forum, both work.
   *
   * Blank = ingest is OFF, and that default matters: this is the only feature
   * that reads message content, so leaving it unset means the bot never looks
   * at a single message. Setting it also requires the MessageContent
   * privileged intent — see src/bugReports.ts.
   */
  bugChannelId: optional("DISCORD_BUG_CHANNEL_ID", ""),
  /** Where level-ups are announced. Blank = announce in the channel the XP was
   *  earned in, which is the least surprising default. */
  xpAnnounceChannelId: optional("DISCORD_XP_ANNOUNCE_CHANNEL_ID", ""),

  /** Where tournaments are announced and champions posted. Blank = the sync
   *  logs and leaves the tournament pending rather than guessing a channel:
   *  posting a bracket into #general because the ladder channel was unset is
   *  worse than not posting it, and leaving it pending means setting the id is
   *  enough to make it appear on the next tick. */
  ladderChannelId: optional("DISCORD_LADDER_CHANNEL_ID", ""),

  /** Pinged when a tournament opens. Names, matched case-insensitively —
   *  same convention as adminRoles and the managed roles in roleSync.ts, so
   *  the game server never has to hold a guild-specific role id. */
  ladderPingRole: optional("DISCORD_LADDER_PING_ROLE", "PvP Ladder"),

  /** Kill switch, same reasoning as GIVEAWAY_SYNC_DISABLED: two instances
   *  against one guild would both try to announce. */
  tournamentSyncDisabled: optional("TOURNAMENT_SYNC_DISABLED", "") === "1",

  /**
   * Roles allowed to run /giveaway. Names, matched case-insensitively against
   * the member's roles.
   *
   * Deliberately NOT "anyone with Manage Server". A Discord permission is a
   * capability someone may hold for unrelated reasons (managing channels,
   * running another bot); the ability to hand out real in-game prizes should
   * follow a role the community explicitly assigned for it.
   */
  adminRoles: optional("DISCORD_ADMIN_ROLES", "Admin,Moderator")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /**
   * How often to reconcile roles.
   *
   * Five minutes. The reconcile is a single API call plus a member fetch, and
   * the roles it manages (Champion, Ace Trainer) change on the order of hours,
   * so anything tighter is polling for its own sake. Anything much looser and
   * a new Champion waits long enough to notice they were not given the role.
   */
  roleSyncIntervalMs: intOpt("ROLE_SYNC_INTERVAL_MS", 5 * 60_000),

  /** Set to "1" to skip role reconciliation entirely — useful when running a
   *  second instance for development against the same guild, where two
   *  reconcilers would fight over the same roles. */
  roleSyncDisabled: optional("ROLE_SYNC_DISABLED", "") === "1",

  /** Set to "1" to skip polling for admin-dashboard giveaways. Same reason as
   *  ROLE_SYNC_DISABLED: two instances against one guild would both try to
   *  announce. The server's NULL-guarded claim means the loser cleans up after
   *  itself, but not racing at all is tidier. */
  giveawaySyncDisabled: optional("GIVEAWAY_SYNC_DISABLED", "") === "1",

  /** How long a trade listing stays on the board before the bot deletes it. */
  tradeListingTtlMs: intOpt("TRADE_LISTING_TTL_MS", 48 * 60 * 60_000),
} as const;

// Every value above has now been read, so `missing` and `invalid` are complete.
// Top-level await: if this fires, module evaluation never finishes and nothing
// that imports config ever runs — which is the point. No half-configured bot
// sitting in the server looking healthy.
if (missing.length || invalid.length) await reportAndPark();
