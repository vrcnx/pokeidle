// Command handlers.
//
// ── TWO RULES EVERY HANDLER FOLLOWS ─────────────────────────────────
//
// 1. Defer first, then work.
//    Discord kills an interaction that is not acknowledged within 3 seconds
//    and shows the user "the application did not respond". Every handler here
//    talks to the game server over the network, so every one defers before it
//    does anything else. The reply is edited in afterwards.
//
// 2. Never print a raw error.
//    Anything that goes wrong becomes toUserMessage(e), which returns either
//    the server's own player-facing copy or a generic apology. These strings
//    land in public channels; an internal message in one is a small leak and a
//    confusing read.
//
// ── EPHEMERAL vs PUBLIC ─────────────────────────────────────────────
// Anything that identifies the CALLER personally — their link code, their
// prizes, their Pokémon's IVs — is ephemeral. Anything about a trainer as a
// public figure — profile, team, ladder — is public, because the point of
// those commands is showing off in #showcase.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
} from "discord.js";
import { api, toUserMessage, versionWarning } from "./api.js";
import { config } from "./config.js";
import { GIVEAWAY_ENTER_PREFIX } from "./commands.js";
import { tournamentDetailEmbed, tournamentListEmbed, tradeListingEmbed } from "./embeds.js";
import {
  dexCard,
  giveawayCard,
  leaderboardCard,
  monCard,
  prizesCard,
  profileCard,
  rankCard,
  teamCard,
  xpCard,
  xpLeaderboardCard,
} from "./cards/index.js";

/**
 * Attach a rendered card as the reply's image.
 *
 * Discord shows an attachment inline, so a card is not a download — it is the
 * message. `name` matters: it becomes the filename in the client and is what a
 * screenshot-and-share ends up called.
 */
function cardFile(png: Buffer, name: string): AttachmentBuilder {
  return new AttachmentBuilder(png, { name: `${name}.png` });
}

/**
 * Post a card as an ORDINARY CHANNEL MESSAGE rather than as the reply to the
 * interaction, and acknowledge the command privately.
 *
 * ── WHY ─────────────────────────────────────────────────────────────
 * Discord renders a public interaction reply under a "someone used /team"
 * header, and there is no flag to turn that off — it is how Discord attributes
 * a reply to the command that caused it. In a showcase channel that header is
 * the noisy half of the message: what people want to see is the team, not a
 * log of who typed what.
 *
 * Replying ephemerally moves the header (and the acknowledgement) to the caller
 * alone, and sending the card separately leaves the channel holding just the
 * card. Nothing is lost by dropping the attribution, because every card already
 * names the trainer it belongs to.
 *
 * ── WHY IT FALLS BACK ───────────────────────────────────────────────
 * A DM, a thread the bot cannot post in, or a missing Send Messages override
 * would otherwise turn a working command into silence. In any of those cases
 * this reverts to a normal public reply, which always works — a slightly
 * noisier message beats no message.
 */
async function postCard(
  i: ChatInputCommandInteraction,
  file: AttachmentBuilder,
  content?: string,
): Promise<void> {
  const channel = i.channel;
  const fallback = async () => {
    await i.editReply({ content, files: [file] });
  };

  if (!channel || !channel.isTextBased() || !("send" in channel)) return fallback();

  // In a guild, verify Send Messages HERE rather than discovering it from a
  // rejected send after the ephemeral ack has already told the caller it
  // worked. DMs have no permission model, so the check only applies in a guild.
  if (i.inGuild()) {
    const me = i.guild?.members.me;
    const perms = me && "permissionsFor" in channel ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.SendMessages)) return fallback();
  }

  try {
    await (channel as GuildTextBasedChannel).send({ content, files: [file] });
    // Deliberately terse and ephemeral: the card is the answer, this is just
    // the interaction being closed out so Discord does not show "thinking…".
    await i.editReply({ content: "Posted. 👇" });
  } catch {
    // The send failed after the permission check passed — a rate limit, a
    // slowmode we are not exempt from, a channel deleted mid-command. Put the
    // card in the reply so the caller still gets it.
    await fallback();
  }
}

/** The subject of a lookup command: an explicit trainer name, or the caller. */
function subjectOf(i: ChatInputCommandInteraction): { discordId?: string; username?: string } {
  const named = i.options.getString("trainer")?.trim();
  return named ? { username: named } : { discordId: i.user.id };
}

/** Does this member hold one of the configured staff roles? Names, matched
 *  case-insensitively — see config.adminRoles for why this is a role check and
 *  not a Discord permission check. */
function isStaff(member: unknown): boolean {
  const m = member as GuildMember | null;
  if (!m || !m.roles || !("cache" in m.roles)) return false;
  return m.roles.cache.some((r) => config.adminRoles.includes(r.name.toLowerCase()));
}

/** Typed to the union rather than to ChatInputCommandInteraction so the button
 *  handler can use it without a cast — it needs exactly the same behaviour. */
async function fail(
  i: ChatInputCommandInteraction | ButtonInteraction,
  e: unknown,
): Promise<void> {
  const content = toUserMessage(e);
  if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [] });
  else await i.reply({ content, flags: MessageFlags.Ephemeral });
}

// ── /link ───────────────────────────────────────────────────────────

async function handleLink(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await api.linkStart(i.user.id, i.user.tag ?? i.user.username);

    // The code goes by DM, never into the channel — even an ephemeral reply is
    // rendered on a screen that might be shared, and a DM is the narrower
    // pipe. The ephemeral reply just says to go and look.
    let dmOk = true;
    try {
      await i.user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf2c94c)
            .setTitle("Your Pokémon Idle link code")
            .setDescription(
              `**\`${res.code}\`**\n\nOpen ${res.linkUrl}, sign in, and enter that code.\n` +
                `It expires <t:${Math.floor(new Date(res.expiresAt).getTime() / 1000)}:R>.` +
                // "First-time" and "usually", because eligibility is decided at
                // redeem: somebody relinking, or linking a second account, gets
                // nothing, and promising them a prize here would be a lie the
                // redeem screen then has to walk back.
                (res.rewardSummary
                  ? `\n\n🎁 First-time linkers usually get **${res.rewardSummary}** — it lands the next time your game saves.`
                  : ""),
            )
            .setFooter({ text: "If you didn't run /link, ignore this — the code does nothing on its own." }),
        ],
      });
    } catch {
      dmOk = false;
    }

    await i.editReply(
      dmOk
        ? "Sent you a DM with your link code. 📬"
        : // Falling back to the ephemeral reply rather than failing: closed DMs
          // are common and the alternative is a dead end. Ephemeral is only
          // visible to this user, so the code is not exposed to the channel.
          `I couldn't DM you — your DMs are closed. Here's your code instead:\n\n**\`${res.code}\`**\n\nEnter it at ${res.linkUrl}. It expires in 10 minutes.`,
    );
  } catch (e) {
    await fail(i, e);
  }
}

async function handleUnlink(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await api.unlink(i.user.id);
    await i.editReply(
      res.removed
        ? "Unlinked. Your game account is free to link somewhere else, and I've dropped your roles on the next sync."
        : "You didn't have a linked account.",
    );
  } catch (e) {
    await fail(i, e);
  }
}

// ── Read-only ───────────────────────────────────────────────────────

async function handleProfile(i: ChatInputCommandInteraction): Promise<void> {
  // Ephemeral: the card goes to the channel on its own, so the "used /profile"
  // header goes only to the caller. See postCard.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const subject = subjectOf(i);
    // The trainer card shows the party, so both reads are needed — issued
    // together rather than in sequence, because two round trips to the game
    // server inside one interaction is the difference between a card that
    // appears instantly and one that appears late.
    const [p, team] = await Promise.all([api.profile(subject), api.team(subject)]);
    await postCard(
      i,
      cardFile(await profileCard(p, team.party), `profile-${p.username}`),
      versionWarning(p.v) ?? undefined,
    );
  } catch (e) {
    await fail(i, e);
  }
}

async function handleRank(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const r = await api.rank(subjectOf(i));
    await i.editReply({ files: [cardFile(await rankCard(r.username, r), `rank-${r.username}`)] });
  } catch (e) {
    await fail(i, e);
  }
}

async function handleLeaderboard(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const res = await api.leaderboard(i.options.getInteger("limit") ?? 10);
    await i.editReply({ files: [cardFile(await leaderboardCard(res.leaderboard), "ladder")] });
  } catch (e) {
    await fail(i, e);
  }
}

async function handleTeam(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await api.team(subjectOf(i));
    if (!res.started) {
      // A card whose only content is "hasn't started playing" is a lot of
      // pixels to say nothing. Plain text is the better answer — and it stays
      // ephemeral, because "this person has not played" is not worth a public
      // message in a showcase channel.
      await i.editReply(`**${res.username}** hasn't started playing yet.`);
      return;
    }
    await postCard(i, cardFile(await teamCard(res.username, res.party), `team-${res.username}`));
  } catch (e) {
    await fail(i, e);
  }
}

// Ephemeral, and self-only on the server side too. IVs/EVs are build
// information the game does not publish for other players; see the /mon route
// in server/src/routes/bot.ts.
async function handleMon(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await api.mon(i.user.id, i.options.getInteger("slot", true));
    await i.editReply({
      files: [cardFile(await monCard(res.username, res.mon), `mon-${res.mon.speciesKey}`)],
    });
  } catch (e) {
    await fail(i, e);
  }
}

async function handleDex(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const d = await api.dex(subjectOf(i));
    await i.editReply({ files: [cardFile(await dexCard(d), `dex-${d.username}`)] });
  } catch (e) {
    await fail(i, e);
  }
}

async function handlePrizes(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await api.prizes(i.user.id);
    await i.editReply({
      files: [cardFile(await prizesCard(res.username, res.grants), "prizes")],
    });
  } catch (e) {
    await fail(i, e);
  }
}

// ── /xp and /levels ─────────────────────────────────────────────────
//
// Community XP is a SEPARATE currency from the game economy — it buys Discord
// standing and nothing the game can see. The copy here says "Discord level"
// rather than anything that might read as a game reward.

async function handleXp(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const member = i.options.getUser("member") ?? i.user;
    const res = await api.xp(member.id);
    if (!res.found) {
      await i.editReply(
        member.id === i.user.id
          ? "You haven't earned any XP yet — say something and you're on the board."
          : `**${member.username}** hasn't earned any XP yet.`,
      );
      return;
    }
    const png = await xpCard(member.username, {
      label: res.label ?? member.username,
      xp: res.xp,
      level: res.level,
      intoLevel: res.intoLevel ?? 0,
      neededForNext: res.neededForNext ?? 0,
      messages: res.messages ?? 0,
      rank: res.rank ?? 0,
    });
    await i.editReply({ files: [cardFile(png, `xp-${member.username}`)] });
  } catch (e) {
    await fail(i, e);
  }
}

async function handleLevels(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const res = await api.xpLeaderboard(i.options.getInteger("limit") ?? 10);
    await i.editReply({ files: [cardFile(await xpLeaderboardCard(res.leaderboard), "levels")] });
  } catch (e) {
    await fail(i, e);
  }
}

// ── /trade offer ────────────────────────────────────────────────────
//
// Posts a LISTING. Nothing moves. The embed carries a deep link that opens the
// game and starts a trade there, where both parties are present and the swap
// is server-canonical — see the header of server/src/routes/bot.ts for why
// that is the only place a trade may happen.

async function handleTrade(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const offering = i.options.getString("offering", true);
    const wanting = i.options.getString("wanting", true);
    const res = await api.postTradeOffer({ discordId: i.user.id, offering, wanting });

    const expiresAt = new Date(Date.now() + config.tradeListingTtlMs);
    const embed = tradeListingEmbed({
      username: res.username,
      offering: res.offering,
      wanting: res.wanting,
      deepLink: res.deepLink,
      authorTag: i.user.tag ?? i.user.username,
      expiresAt,
    });

    // Post into #trade-chat when configured, otherwise into the channel the
    // command was run in. Falling back rather than erroring: a missing channel
    // id should not make the feature unavailable.
    const channelId = config.tradeChannelId || i.channelId;
    const channel = await i.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      await i.editReply("I couldn't find the trade channel to post in. Someone should check my config.");
      return;
    }
    const posted = await channel.send({ embeds: [embed] });

    // Expiry. A setTimeout is honest about what it is: listings do not survive
    // a bot restart, and that is an acceptable trade for not keeping a
    // database on this side. The listing is ALSO mirrored into the in-game
    // trade channel, which is the durable copy — this timer only tidies
    // Discord.
    //
    // Node caps setTimeout at ~24.8 days; 48h is well inside that.
    setTimeout(() => {
      posted.delete().catch(() => undefined);
    }, config.tradeListingTtlMs).unref?.();

    await i.editReply(
      `Posted${config.tradeChannelId ? ` in <#${config.tradeChannelId}>` : ""}. ` +
        `It's also on the in-game trade board, and it'll expire in 48 hours.`,
    );
  } catch (e) {
    await fail(i, e);
  }
}

// ── /giveaway ───────────────────────────────────────────────────────

async function handleGiveaway(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();

  if (!isStaff(i.member)) {
    await i.reply({
      content: `That's a staff command — you need one of: ${config.adminRoles.join(", ")}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "start") {
    await i.deferReply();
    try {
      const res = await api.createGiveaway({
        title: i.options.getString("title", true),
        description: i.options.getString("description") ?? "",
        // Passed through as a STRING. The server validates it with
        // parsePrizesStrict against the same schema the admin dashboard uses,
        // so a malformed prize is rejected there rather than being half-parsed
        // here by a second, weaker validator.
        prizes: i.options.getString("prizes", true),
        winnerCount: i.options.getInteger("winners") ?? 1,
        ownerDiscordId: i.user.id,
      });

      const png = await giveawayCard({
        title: res.title,
        description: res.description,
        prizes: res.prizes,
        winnerCount: res.winnerCount,
      });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          // The giveaway id rides in the customId, so a click needs no
          // bot-side state and survives a restart. Discord caps customId at
          // 100 chars; a cuid plus this prefix is ~34.
          .setCustomId(`${GIVEAWAY_ENTER_PREFIX}${res.giveawayId}`)
          .setLabel("Enter")
          .setStyle(ButtonStyle.Primary)
          .setEmoji("🎟️"),
      );

      await i.editReply({
        // The key facts stay in the message body as well as on the card.
        // A card is an image: not selectable, not translatable, and invisible
        // to anyone using a screen reader. The prize and the id must be
        // readable without it.
        content:
          `🎁 **${res.title}** — ${res.prizeSummary} · ` +
          `${res.winnerCount} winner${res.winnerCount === 1 ? "" : "s"}\n` +
          `Press **Enter** below. You'll need a linked game account — run \`/link\` first if you haven't.\n` +
          `-# Giveaway id: ${res.giveawayId}`,
        files: [cardFile(png, `giveaway-${res.giveawayId}`)],
        components: [row],
      });
    } catch (e) {
      await fail(i, e);
    }
    return;
  }

  if (sub === "draw") {
    await i.deferReply();
    try {
      const id = i.options.getString("id", true);
      const res = await api.drawGiveaway(id, i.user.id);
      const paid = res.winners.filter((w) => w.ok);
      const failed = res.winners.filter((w) => !w.ok);

      const mentions = paid
        .map((w) => (w.discordId ? `<@${w.discordId}>` : `**${w.username}**`))
        .join(", ");

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("🎉 Winners drawn")
        .setDescription(
          paid.length
            ? `Congratulations ${mentions}!\n\n${res.deliveryNote}`
            : "Nobody could be paid — see the mod log.",
        )
        .addFields({ name: "Entries", value: String(res.entryCount), inline: true })
        .setFooter({ text: `Giveaway ${id} · seed ${res.seed}` });

      await i.editReply({ embeds: [embed] });

      // Audit post. Carries the seed, which is what makes the draw verifiable
      // after the fact — pickWinners is deterministic from it, so anyone with
      // the seed and the entry list can re-derive the same winners.
      await postModLog(i, {
        title: "Giveaway drawn",
        lines: [
          `**Giveaway:** ${id}`,
          `**Drawn by:** ${i.user.tag ?? i.user.username}`,
          `**Entries:** ${res.entryCount}`,
          `**Seed:** \`${res.seed}\``,
          `**Winners:** ${paid.map((w) => w.username).join(", ") || "(none)"}`,
          ...(failed.length
            ? [`**Failed grants:** ${failed.map((w) => `${w.username} (${w.error ?? "unknown"})`).join(", ")}`]
            : []),
        ],
        colour: failed.length ? 0xe74c3c : 0x2ecc71,
      });

      // Tell each winner directly. A prize you find out about days later is a
      // much smaller moment, and delivery being deferred to their next save
      // upload is exactly the thing they need told to them.
      for (const w of paid) {
        if (!w.discordId) continue;
        try {
          const user = await i.client.users.fetch(w.discordId);
          await user.send(
            `You won **${id}** in Pokémon Idle! 🎉\n\n${res.deliveryNote}\n\nRun \`/prizes\` any time to check.`,
          );
        } catch { /* closed DMs — the public announcement already named them */ }
      }
    } catch (e) {
      await fail(i, e);
    }
    return;
  }

  if (sub === "status") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const s = await api.giveawayStatus(i.options.getString("id", true));
      const embed = new EmbedBuilder()
        .setColor(0xf2c94c)
        .setTitle(`${s.title}`)
        .addFields(
          { name: "Status", value: s.status, inline: true },
          { name: "Entries", value: String(s.entryCount), inline: true },
          { name: "Winners", value: s.winners.join(", ") || "—" },
        );
      if (s.prizes.length) {
        embed.addFields({
          name: "Prize delivery",
          value: s.prizes
            .map((p) =>
              p.delivered
                ? `✅ ${p.username} — delivered`
                : p.stuck
                  ? `⚠️ ${p.username} — stuck (likely a full box)`
                  : `⏳ ${p.username} — queued`,
            )
            .join("\n"),
        });
      }
      if (s.seed) embed.setFooter({ text: `seed ${s.seed}` });
      await i.editReply({ embeds: [embed] });
    } catch (e) {
      await fail(i, e);
    }
  }
}

async function postModLog(
  i: ChatInputCommandInteraction,
  input: { title: string; lines: string[]; colour: number },
): Promise<void> {
  if (!config.modLogChannelId) return;
  try {
    const ch = await i.client.channels.fetch(config.modLogChannelId);
    if (!ch || !ch.isTextBased() || !("send" in ch)) return;
    await ch.send({
      embeds: [
        new EmbedBuilder()
          .setColor(input.colour)
          .setTitle(input.title)
          .setDescription(input.lines.join("\n"))
          .setTimestamp(new Date()),
      ],
    });
  } catch {
    // The mod log is an audit convenience; the durable audit is AdminAudit on
    // the game server, written by drawGiveaway. Never fail a draw over this.
  }
}

// ── Tournaments ─────────────────────────────────────────────────────
//
// Not ephemeral. A bracket is shared context — the point of posting it in
// #ladder-talk is that everyone sees who is left. The one personal part
// (`yourMatch`) is only populated for the caller, so a public reply leaks
// nothing another entrant could not already see in the in-game bracket.

async function handleTournament(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  await i.deferReply();
  try {
    if (sub === "list") {
      const res = await api.tournaments(i.user.id, 10);
      await i.editReply({
        content: versionWarning(res.v),
        embeds: [tournamentListEmbed(res.tournaments, res.linked)],
      });
      return;
    }

    const id = i.options.getString("id", true).trim();
    const res = await api.tournament(id, i.user.id);
    await i.editReply({
      content: versionWarning(res.v),
      embeds: [tournamentDetailEmbed(res.tournament, res.linked)],
    });
  } catch (e) {
    await fail(i, e);
  }
}

// ── Giveaway entry button ───────────────────────────────────────────

export async function handleButton(i: ButtonInteraction): Promise<void> {
  if (!i.customId.startsWith(GIVEAWAY_ENTER_PREFIX)) return;
  const giveawayId = i.customId.slice(GIVEAWAY_ENTER_PREFIX.length);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const res = await api.enterGiveaway(giveawayId, i.user.id);
    await i.editReply(
      res.duplicate ? "You're already entered. 🎟️" : "You're in. Good luck! 🎟️",
    );
  } catch (e) {
    await fail(i, e);
  }
}

// ── Dispatch ────────────────────────────────────────────────────────

const HANDLERS: Record<string, (i: ChatInputCommandInteraction) => Promise<void>> = {
  link: handleLink,
  unlink: handleUnlink,
  profile: handleProfile,
  rank: handleRank,
  leaderboard: handleLeaderboard,
  team: handleTeam,
  mon: handleMon,
  dex: handleDex,
  prizes: handlePrizes,
  xp: handleXp,
  levels: handleLevels,
  trade: handleTrade,
  tournament: handleTournament,
  giveaway: handleGiveaway,
};

export async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  const fn = HANDLERS[i.commandName];
  if (!fn) {
    // A command Discord knows about but this build does not — almost always a
    // deploy that registered commands from a newer branch. Say so rather than
    // timing out silently.
    await i.reply({
      content: "I don't know that command yet — I might be mid-update. Try again shortly.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await fn(i);
}
