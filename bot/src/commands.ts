// Slash command definitions.
//
// Definitions only — the handlers live in handlers.ts. Keeping them apart
// means deployCommands.ts can import this file without pulling in the API
// client, so registering commands never needs BOT_TOKEN or a reachable game
// server.

import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Connect your Pokémon Idle account to Discord")
    // The code arrives by DM, so this is only useful in a server where the bot
    // can see you. Not DM-enabled: a /link run in the bot's own DMs would work
    // but gives the member-role grant nothing to act on.
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Disconnect your Pokémon Idle account from Discord")
    // DM-enabled ON PURPOSE. Unlinking has to work when you have lost access
    // to the game account, and requiring you to be in the server to do it
    // would strand exactly the people who need it most.
    .setDMPermission(true),

  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Show a trainer card")
    .addStringOption((o) =>
      o.setName("trainer").setDescription("Username (defaults to you)").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Show PvP rating and ladder position")
    .addStringOption((o) =>
      o.setName("trainer").setDescription("Username (defaults to you)").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Top of the PvP ladder")
    .addIntegerOption((o) =>
      o.setName("limit").setDescription("How many (1-25, default 10)").setMinValue(1).setMaxValue(25),
    ),

  new SlashCommandBuilder()
    .setName("team")
    .setDescription("Show a trainer's party")
    .addStringOption((o) =>
      o.setName("trainer").setDescription("Username (defaults to you)").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("mon")
    .setDescription("Show one of YOUR Pokémon in detail, including IVs and EVs")
    .addIntegerOption((o) =>
      o.setName("slot").setDescription("Party slot 1-6").setMinValue(1).setMaxValue(6).setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("dex")
    .setDescription("Pokédex progress")
    .addStringOption((o) =>
      o.setName("trainer").setDescription("Username (defaults to you)").setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName("prizes")
    .setDescription("Check prizes you're owed and whether they've landed")
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("trade")
    .setDescription("Trade noticeboard")
    .addSubcommand((s) =>
      s
        .setName("offer")
        .setDescription("Post what you're offering and what you want")
        .addStringOption((o) =>
          o.setName("offering").setDescription("What you're giving").setMaxLength(120).setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("wanting").setDescription("What you want for it").setMaxLength(120).setRequired(true),
        ),
    ),

  new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Run a giveaway (staff only)")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("Open a giveaway for entries")
        .addStringOption((o) => o.setName("title").setDescription("What it's called").setRequired(true).setMaxLength(120))
        .addStringOption((o) =>
          o
            .setName("prizes")
            .setDescription('JSON prize list, e.g. [{"kind":"item","itemId":"masterball","quantity":1}]')
            .setRequired(true),
        )
        .addIntegerOption((o) =>
          o.setName("winners").setDescription("How many winners (default 1)").setMinValue(1).setMaxValue(20),
        )
        .addStringOption((o) => o.setName("description").setDescription("Extra detail").setMaxLength(500)),
    )
    .addSubcommand((s) =>
      s
        .setName("draw")
        .setDescription("Draw the winners")
        .addStringOption((o) => o.setName("id").setDescription("Giveaway id").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("status")
        .setDescription("Check entries and whether prizes have been delivered")
        .addStringOption((o) => o.setName("id").setDescription("Giveaway id").setRequired(true)),
    ),
].map((c) => c.toJSON());

/** Prefix for the giveaway entry button's customId. The giveaway id is
 *  appended, which is what lets a click be handled with no bot-side state —
 *  see handlers.ts. */
export const GIVEAWAY_ENTER_PREFIX = "gw:enter:";
