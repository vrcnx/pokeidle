// Register slash commands with Discord.
//
// Run manually after changing commands.ts:
//
//     npm run deploy-commands
//
// NOT run automatically at boot. Command registration is a write to Discord's
// API with its own rate limit, and doing it on every process start means every
// crash-restart loop hammers it. It also makes the deploy the thing that
// decides what commands exist, which is exactly the coupling that produces
// "the command vanished because a rollback re-registered an older set".
//
// Registers PER-GUILD: guild commands appear instantly, global ones take up to
// an hour to propagate. This bot serves one community server, so the global
// scope would buy nothing and cost a slow feedback loop.

import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const clientId = process.env.DISCORD_CLIENT_ID?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!token || !clientId || !guildId) {
  console.error(
    "[deploy-commands] need DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID.",
  );
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

try {
  const data = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  })) as unknown[];
  console.log(`[deploy-commands] registered ${data.length} commands to guild ${guildId}.`);
  for (const c of commands) console.log(`  /${(c as { name: string }).name}`);
} catch (e) {
  console.error("[deploy-commands] failed:", e);
  process.exit(1);
}
