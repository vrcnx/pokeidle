// Boot-time self-check.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────
//
// Every failure this bot has had in production was silent, individually small,
// and only visible at the moment someone tried to use the feature it broke:
//
//   * The privileged intents were never switched on, so the gateway refused
//     every identify. The symptom was a slash command replying "the application
//     did not respond" — which names neither intents nor the portal.
//   * Four channel ids were blank, so the trade board, the mod log, bug ingest
//     and tournament announcements were all off. Nothing said so.
//   * BOT_TOKEN was absent from the game server, so every API call 401'd. From
//     the bot's side that is indistinguishable from a wrong token.
//   * The bot role sat where it could not grant the roles it manages. Role sync
//     logged one warning per member, per pass, forever.
//
// Each was a five-second fix that cost hours because nothing checked. So this
// runs once at boot, checks the things that are true or false right now, and
// prints ONE block naming every problem at once.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────
//
// It never exits, and it never refuses to start. A bot that answers /profile
// but cannot post trade listings is worth running; killing it because one
// optional channel id is blank would take a working feature away to punish a
// missing one. FAIL means "this feature is broken and here is why", not "stop".
//
// It also runs BEFORE the sync loops start, so the report is not interleaved
// with reconcile output.

import { PermissionFlagsBits, Routes, type Client, type Guild } from "discord.js";
import { api } from "./api.js";
import { config } from "./config.js";

type Level = "OK" | "WARN" | "FAIL";

interface Line {
  level: Level;
  what: string;
  detail: string;
  /** What to actually do. Omitted when there is nothing to do. */
  fix?: string;
}

const lines: Line[] = [];
const ok = (what: string, detail: string) => lines.push({ level: "OK", what, detail });
const warn = (what: string, detail: string, fix?: string) =>
  lines.push({ level: "WARN", what, detail, fix });
const fail = (what: string, detail: string, fix?: string) =>
  lines.push({ level: "FAIL", what, detail, fix });

/** Permissions the bot needs, and the feature that breaks without each. Stated
 *  as a pair so the report can say WHAT stops working rather than just naming a
 *  permission bit the reader then has to map to a symptom themselves. */
const NEEDED: Array<[bigint, string, string, Level]> = [
  [PermissionFlagsBits.ViewChannel, "View Channels", "everything", "FAIL"],
  [PermissionFlagsBits.SendMessages, "Send Messages", "every command reply", "FAIL"],
  [PermissionFlagsBits.EmbedLinks, "Embed Links", "trade listings, /tournament", "FAIL"],
  [PermissionFlagsBits.AttachFiles, "Attach Files", "every rendered card", "FAIL"],
  [PermissionFlagsBits.ReadMessageHistory, "Read Message History", "bug-report backfill", "WARN"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles", "role sync", "FAIL"],
  [
    PermissionFlagsBits.MentionEveryone,
    "Mention Everyone",
    "the tournament ping",
    "WARN",
  ],
];

async function checkPermissions(guild: Guild): Promise<void> {
  const me = guild.members.me;
  if (!me) {
    fail("bot member", "I could not resolve my own member object in this guild.");
    return;
  }
  const missing = NEEDED.filter(([bit]) => !me.permissions.has(bit));
  if (!missing.length) {
    ok("permissions", "all required permissions granted");
    return;
  }
  for (const [, name, breaks, level] of missing) {
    const line = `missing "${name}" — breaks ${breaks}`;
    const fixText = `Server Settings → Roles → ${me.roles.highest.name} → Permissions`;
    if (level === "FAIL") fail("permissions", line, fixText);
    else warn("permissions", line, fixText);
  }
}

/**
 * Can the bot actually assign the roles the game server asks it to?
 *
 * Checked against the SERVER'S list rather than a hardcoded one, so renaming a
 * managed role on the server surfaces here rather than as a silent no-op inside
 * the reconcile loop.
 */
async function checkRoleHierarchy(guild: Guild): Promise<void> {
  let managed: string[];
  try {
    managed = (await api.desiredRoles()).managedRoles;
  } catch {
    // The API check below reports the real problem; no need to say it twice.
    return;
  }

  const me = guild.members.me;
  if (!me) return;
  const mine = me.roles.highest;

  const problems: string[] = [];
  for (const name of managed) {
    const role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!role) {
      problems.push(`"${name}" does not exist in this guild`);
      continue;
    }
    if (role.position >= mine.position) {
      problems.push(`"${name}" (position ${role.position}) is at or above mine (${mine.position})`);
    }
  }

  if (!problems.length) {
    ok("role hierarchy", `can assign all ${managed.length} managed roles`);
    return;
  }
  for (const p of problems) {
    fail(
      "role hierarchy",
      p,
      "Server Settings → Roles → drag my role above the roles it manages",
    );
  }
}

/**
 * Is the GuildMembers intent actually working?
 *
 * The portal toggle and the gateway are separate things: a bot can connect and
 * still see only cached members. Fetching and comparing against the cached
 * count is the only way to know from in here.
 */
async function checkMemberIntent(guild: Guild): Promise<void> {
  try {
    const members = await guild.members.fetch();
    ok("members intent", `fetched ${members.size} members`);
  } catch (e) {
    fail(
      "members intent",
      `guild.members.fetch() failed — ${String((e as Error)?.message ?? e)}`,
      "Developer Portal → Bot → Privileged Gateway Intents → Server Members Intent",
    );
  }
}

/** Every configured channel id: does it exist, and can I post in it? */
async function checkChannels(client: Client): Promise<void> {
  const wanted: Array<[string, string, string]> = [
    [config.tradeChannelId, "DISCORD_TRADE_CHANNEL_ID", "/trade offer has nowhere to post"],
    [config.modLogChannelId, "DISCORD_MOD_LOG_CHANNEL_ID", "giveaway outcomes are not logged"],
    [config.bugChannelId, "DISCORD_BUG_CHANNEL_ID", "bug-report ingest is off"],
    [config.ladderChannelId, "DISCORD_LADDER_CHANNEL_ID", "tournaments are never announced"],
  ];

  for (const [id, envName, consequence] of wanted) {
    if (!id) {
      // Blank is a legitimate "feature off" choice everywhere it appears, so
      // this is a WARN naming the consequence, never a FAIL.
      warn("channels", `${envName} is blank — ${consequence}`, `set ${envName}`);
      continue;
    }
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch) {
      fail("channels", `${envName}=${id} — no such channel, or I cannot see it`, `check ${envName}`);
      continue;
    }
    if (!ch.isTextBased() || !("send" in ch)) {
      fail("channels", `${envName} points at a channel I cannot post in`, `check ${envName}`);
      continue;
    }
    const name = "name" in ch && ch.name ? `#${ch.name}` : id;
    ok("channels", `${envName} → ${name}`);
  }
}

/** Can we reach the game server, and does BOT_TOKEN work? */
async function checkGameApi(): Promise<void> {
  try {
    const res = await api.leaderboard(1);
    ok("game api", `${config.apiBase} reachable, token accepted (${res.leaderboard.length} row)`);
  } catch (e) {
    const msg = String((e as { status?: number; message?: string })?.message ?? e);
    const status = (e as { status?: number })?.status;
    if (status === 401) {
      fail(
        "game api",
        "401 — BOT_TOKEN here does not match the one on the game server",
        "set the SAME BOT_TOKEN on both, minimum 32 chars",
      );
    } else {
      fail("game api", `${config.apiBase} — ${msg}`, "check API_BASE and that the server is up");
    }
  }
}

/**
 * Today's remaining gateway identifies.
 *
 * Reported on every boot, not just when it is already a problem. A budget
 * quietly draining is the earliest visible symptom of a second instance
 * crash-looping somewhere, and by the time it hits zero the bot is offline for
 * up to a day. Seeing "998/1000" in the log is how you notice at 2 instead
 * of at 1000.
 */
async function checkIdentifyBudget(client: Client): Promise<void> {
  try {
    const g = (await client.rest.get(Routes.gatewayBot())) as {
      session_start_limit: { remaining: number; total: number; reset_after: number };
    };
    const l = g.session_start_limit;
    const used = l.total - l.remaining;
    const detail = `${l.remaining}/${l.total} identifies left today (used ${used})`;
    if (l.remaining <= 10) {
      fail("identify budget", detail, "something is crash-looping — find it before the reset");
    } else if (used > 100) {
      warn(
        "identify budget",
        detail,
        "a healthy bot uses a handful a day; this many means repeated reconnects",
      );
    } else {
      ok("identify budget", detail);
    }
  } catch {
    warn("identify budget", "could not read it — REST call failed");
  }
}

export async function preflight(client: Client): Promise<void> {
  lines.length = 0;
  await checkIdentifyBudget(client);

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    fail(
      "guild",
      `cannot reach guild ${config.guildId}`,
      "check DISCORD_GUILD_ID, and that I am actually in that server",
    );
  } else {
    ok("guild", `${guild.name} (${guild.memberCount} members)`);
    await checkMemberIntent(guild);
    await checkPermissions(guild);
    await checkRoleHierarchy(guild);
  }

  await checkGameApi();
  await checkChannels(client);

  const fails = lines.filter((l) => l.level === "FAIL");
  const warns = lines.filter((l) => l.level === "WARN");

  console.log("");
  console.log("=== PREFLIGHT ===");
  for (const l of lines) {
    console.log(`  ${l.level.padEnd(4)} ${l.what.padEnd(15)} ${l.detail}`);
    if (l.fix) console.log(`       ${" ".repeat(15)} ↳ ${l.fix}`);
  }
  console.log("");
  if (!fails.length && !warns.length) {
    console.log("  Everything checks out.");
  } else {
    console.log(`  ${fails.length} broken, ${warns.length} degraded.`);
    if (fails.length) {
      console.log("  The bot is still running — the FAIL lines say which features are not.");
    }
  }
  console.log("=================");
  console.log("");
}
