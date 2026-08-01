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
import { startGiveawaySync } from "./giveawaySync.js";
import { startBugReportIngest } from "./bugReports.js";

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
    // GuildMessages + MessageContent are needed for ONE feature: ingesting bug
    // reports from the configured bug channel into the admin dashboard's
    // triage queue (src/bugReports.ts).
    //
    // MessageContent is PRIVILEGED and must also be enabled in the Developer
    // Portal. It is requested unconditionally here rather than conditionally
    // on DISCORD_BUG_CHANNEL_ID, because a gateway identify with a different
    // intent set than the portal grants is a connection error rather than a
    // degraded mode — and a bot that will not connect at all is a much worse
    // failure than one that reads a channel it has been told to ignore.
    //
    // The bot still looks at exactly one channel: the MessageCreate handler
    // returns immediately for any other channelId, and with the id unset it is
    // never registered at all.
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  console.log(`[bot] game server: ${config.apiBase}`);
  startRoleSync(client);
  // Giveaways created in the admin dashboard with "Announce in Discord"
  // ticked. Polled rather than pushed — the game server holds no Discord
  // token. See giveawaySync.ts.
  startGiveawaySync(client);
  // Bug reports posted in the community bug channel, into the admin
  // dashboard's existing triage queue. Off unless DISCORD_BUG_CHANNEL_ID is
  // set. Listens live AND sweeps recent history on boot, so a report posted
  // during a redeploy is not lost — see bugReports.ts.
  startBugReportIngest(client);
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
