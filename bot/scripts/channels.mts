// List the guild's channels and fill the channel ids into .env.
//
//     npm run channels          # list only
//     npm run channels -- --write   # list, then upsert the ids into .env
//
// WHY THIS EXISTS
// The alternative is turning on Developer Mode, right-clicking four channels
// and pasting four snowflakes by hand — four chances to put the mod log id in
// the bug channel slot and not find out until a bug report lands in the wrong
// place. The bot already holds a token that can read the channel list, so this
// is the same information with the transcription step removed.
//
// It reads DISCORD_BOT_TOKEN from the environment like every other script here
// and never prints it.

import { REST, Routes } from "discord.js";
import { readFileSync, writeFileSync } from "node:fs";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!token || !guildId) {
  console.error(
    "[channels] need DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.\n" +
      "  A blank value counts as missing — check the VALUES, not just the keys:\n" +
      "  node --env-file-if-exists=.env -e \"console.log(!!process.env.DISCORD_BOT_TOKEN)\"",
  );
  process.exit(1);
}

/** Channel name → the env var that should hold its id. Names are the ones the
 *  community server actually uses; a rename here is cheaper than a rename in
 *  Discord, so match on what is there rather than insisting on these. */
const WANTED: Record<string, string> = {
  "ladder-talk": "DISCORD_LADDER_CHANNEL_ID",
  "trade-chat": "DISCORD_TRADE_CHANNEL_ID",
  "mod-log": "DISCORD_MOD_LOG_CHANNEL_ID",
  "bug-reports": "DISCORD_BUG_CHANNEL_ID",
};

// 0 = text, 5 = announcement, 15 = forum. The three a bot can post in or read.
const POSTABLE = new Set([0, 5, 15]);

interface Channel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
}

const rest = new REST({ version: "10" }).setToken(token);

let channels: Channel[];
try {
  channels = (await rest.get(Routes.guildChannels(guildId))) as Channel[];
} catch (e) {
  console.error(
    "[channels] couldn't read the guild.\n" +
      "  * 401 → the token is wrong or was reset.\n" +
      "  * 403/404 → the bot isn't in this guild, or DISCORD_GUILD_ID is wrong.\n",
    String(e),
  );
  process.exit(1);
}

const categories = new Map(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));

console.log(`\n${channels.length} channels in guild ${guildId}:\n`);
for (const c of channels.filter((c) => POSTABLE.has(c.type)).sort((a, b) => a.name.localeCompare(b.name))) {
  const where = c.parent_id ? categories.get(c.parent_id) ?? "?" : "—";
  const target = WANTED[c.name];
  console.log(
    `  ${c.id}  ${c.name.padEnd(22)} ${String(where).padEnd(18)} ${target ? `→ ${target}` : ""}`,
  );
}

const resolved: Record<string, string> = {};
for (const [name, key] of Object.entries(WANTED)) {
  const hit = channels.find((c) => c.name === name && POSTABLE.has(c.type));
  if (hit) resolved[key] = hit.id;
  else console.warn(`\n[channels] no channel named "${name}" — ${key} left alone.`);
}

// NOT process.exit(). discord.js's REST client keeps a keep-alive agent open,
// and tearing the process down under it trips a libuv assertion on Windows
// ("!(handle->flags & UV_HANDLE_CLOSING)") AFTER the output — which reads like
// the script crashed when it had already done its job. Falling off the end
// lets the handles close on their own.
if (!process.argv.includes("--write")) {
  console.log("\nRe-run with `-- --write` to put these into .env.\n");
} else {
  // Upsert, preserving every other line. Deliberately a line-level rewrite
  // rather than a parse-and-serialise: .env holds secrets and comments, and the
  // safest edit is the one that touches only the keys named here.
  let text = readFileSync(".env", "utf8");
  for (const [key, id] of Object.entries(resolved)) {
    const line = `${key}="${id}"`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(".env", text);

  console.log(`\n[channels] wrote ${Object.keys(resolved).length} ids into .env:`);
  for (const k of Object.keys(resolved)) console.log(`  ${k}`);
  console.log();
}
