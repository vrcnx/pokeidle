// Pokémon Idle community Discord bot.
//
// Runs as its OWN deploy, never inside the game server process. Two reasons,
// and the second is the one that matters:
//
//   * A Discord gateway connection is long-lived, reconnects on its own
//     schedule, and drags in a dependency tree the game server has no other
//     use for. Restarting the bot to ship a command change should not restart
//     the thing holding 2,300 players' save uploads.
//   * The bot's blast radius is bounded by the API surface it can reach. In
//     the same process it would hold a Prisma client and could do anything;
//     out here it holds a bearer token for /api/bot and can do exactly what
//     that surface allows. The renderer is separated for the same reason.

import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { config } from "./config.js";
import { handleButton, handleCommand } from "./handlers.js";
import { startRoleSync } from "./roleSync.js";

const client = new Client({
  intents: [
    // Guilds: role and channel caches, which the reconciler reads.
    GatewayIntentBits.Guilds,
    // GuildMembers is PRIVILEGED and must be enabled in the Developer Portal
    // (Bot → Privileged Gateway Intents → Server Members Intent). Without it
    // guild.members.fetch() returns only cached members and role sync silently
    // covers a fraction of the server. roleSync.ts detects the failure and
    // says so rather than reconciling a partial list.
    GatewayIntentBits.GuildMembers,
  ],
  // No MessageContent intent, deliberately. The bot never reads message text —
  // everything arrives as a slash command or a button — so requesting it would
  // be asking for a privileged capability with no use, and constraint 5 of the
  // brief (no Discord message content in the game database) is easier to keep
  // when the content never enters the process at all.
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  console.log(`[bot] game server: ${config.apiBase}`);
  startRoleSync(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (e) {
    // Last-resort net. A handler that throws past its own try/catch would
    // otherwise leave the interaction hanging until Discord shows "the
    // application did not respond", which tells the user nothing.
    console.error("[bot] unhandled interaction error:", e);
    try {
      if (interaction.isRepliable()) {
        const content = "Something went wrong on my end. Try again shortly.";
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch { /* the interaction is already gone — nothing left to say */ }
  }
});

// discord.js emits these rather than throwing; without a listener a gateway
// hiccup is invisible and the bot looks like it silently stopped working.
client.on(Events.Error, (e) => console.error("[bot] client error:", e));
client.on(Events.Warn, (w) => console.warn("[bot] warn:", w));

process.on("unhandledRejection", (reason) => {
  console.error("[bot] unhandled rejection:", reason);
});

// SIGTERM is what Railway sends on redeploy. Closing the gateway cleanly means
// Discord marks the bot offline immediately instead of waiting for the
// heartbeat to lapse, so a redeploy does not show ~40s of a bot that appears
// online and answers nothing.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[bot] ${sig} — shutting down.`);
    client.destroy().finally(() => process.exit(0));
  });
}

void client.login(config.discordToken);
