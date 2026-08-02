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
import { startTournamentSync } from "./tournamentSync.js";
import { startBugReportIngest } from "./bugReports.js";
import { startXpListener } from "./xp.js";
import { preflight } from "./preflight.js";

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

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  console.log(`[bot] game server: ${config.apiBase}`);

  // Before anything starts polling: check the things that are true or false
  // right now — intents, permissions, role hierarchy, channel ids, the game
  // API — and print them as one block. Every production failure this bot has
  // had was one of these, silent, and only noticed when someone tried to use
  // the feature it broke. See preflight.ts.
  //
  // Awaited so the report is not interleaved with reconcile output, and
  // deliberately never fatal: a bot that answers /profile but cannot post trade
  // listings is still worth running.
  await preflight(client).catch((e) => console.error("[preflight] check failed:", String(e)));

  startRoleSync(client);
  // Giveaways created in the admin dashboard with "Announce in Discord"
  // ticked. Polled rather than pushed — the game server holds no Discord
  // token. See giveawaySync.ts.
  startGiveawaySync(client);
  // Tournaments ticked for announcement in the admin dashboard, plus the
  // champion post when a bracket resolves. Same poll-not-push reasoning as
  // giveaways — see tournamentSync.ts.
  startTournamentSync(client);
  // Bug reports posted in the community bug channel, into the admin
  // dashboard's existing triage queue. Off unless DISCORD_BUG_CHANNEL_ID is
  // set. Listens live AND sweeps recent history on boot, so a report posted
  // during a redeploy is not lost — see bugReports.ts.
  startBugReportIngest(client);
  // Community XP. Fires on every message in the server, but reads no message
  // text — only who posted and where. Off unless an operator enables it in the
  // admin dashboard; the server decides and the bot just reports the event.
  startXpListener(client);
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

// ── Login, with a backoff that cannot eat the daily budget ──────────
//
// This used to be `void client.login(...)`, and that one word cost a day of
// downtime. The rejection escaped to the unhandledRejection handler above,
// which logs and returns; Node was then left with no open handles, exited
// CLEANLY (code 0), and railway.json's `restartPolicyType: ALWAYS` started it
// again. Roughly every four seconds.
//
// Discord allows 1000 gateway identifies per day. A four-second restart loop
// spends that in about seventy minutes, and every one of those attempts was
// itself rejected — so the budget was consumed entirely by attempts that could
// never have succeeded. The failure then outlives its own cause: the intents
// get fixed, the budget is still zero, and the next day's budget is gone
// before anyone notices, forever.
//
// So: never exit on a login failure, and never retry fast. Staying alive is
// what stops the platform restarting us, and a long backoff means even a
// permanently broken config costs a handful of identifies a day instead of all
// of them. It also self-heals — when the budget resets or an intent is
// switched on, the next attempt simply works.
const RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

function diagnose(message: string): string | null {
  if (/disallowed intent/i.test(message)) {
    return (
      "Discord rejected the intents. Enable BOTH 'Server Members Intent' and " +
      "'Message Content Intent' under Developer Portal → your app → Bot → " +
      "Privileged Gateway Intents. Nothing else will work until then."
    );
  }
  if (/sessions remaining/i.test(message)) {
    return (
      "The daily identify budget (1000/day) is spent. This is almost always a " +
      "restart loop — check whether another instance is crash-looping, and " +
      "STOP it before the budget resets or it will spend the new one too."
    );
  }
  if (/token|unauthorized|401/i.test(message)) {
    return "DISCORD_BOT_TOKEN looks wrong or was reset. Regenerate it and update the env.";
  }
  return null;
}

async function login(attempt = 0): Promise<void> {
  try {
    await client.login(config.discordToken);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    console.error(`[bot] login failed: ${message}`);
    const hint = diagnose(message);
    if (hint) console.error(`[bot] ${hint}`);
    console.error(
      `[bot] retrying in ${Math.round(wait / 60_000)} min. NOT exiting — exiting here ` +
        "would let the platform restart me straight back into this, which is what " +
        "spent the identify budget in the first place.",
    );
    setTimeout(() => void login(attempt + 1), wait);
  }
}

void login();
