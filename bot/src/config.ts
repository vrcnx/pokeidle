// Environment, parsed once and validated loudly.
//
// Every value the bot cannot run without is checked HERE, at boot, with a
// message naming the variable. The alternative — reading process.env at the
// point of use — produces a bot that starts fine, sits in the server looking
// healthy, and throws on the first person to run a command. A misconfigured
// deploy should fail to start.

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[config] ${name} is not set. The bot cannot start without it.`);
    process.exit(1);
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
  if (v.length < 32) {
    console.error(
      "[config] BOT_TOKEN is shorter than 32 characters. The game server refuses " +
        "to honour a secret that short (it answers 401 for every call), so this " +
        "would look like an authentication bug. Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
  }
  return v;
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
