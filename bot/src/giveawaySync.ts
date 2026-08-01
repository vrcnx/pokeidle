// Posting admin-dashboard giveaways to Discord.
//
// A moderator ticks "Announce in Discord" in the admin dashboard; the game
// server sets a flag; this loop notices and posts. The server never calls
// Discord — it holds no token and knows no channel semantics — so the flow is
// a poll, exactly like roleSync.ts.
//
// ── WHY POLLING RATHER THAN A WEBHOOK ───────────────────────────────
// The same argument as role sync. A webhook is a message that can be lost
// while the bot is redeploying, and a lost "announce this" leaves a giveaway
// that silently never appears — which nobody notices until entries are zero
// and the draw has already happened. A poll that misses a tick is thirty
// seconds late.
//
// ── THE ORDERING THAT MATTERS ───────────────────────────────────────
// Post FIRST, then mark. A crash in between costs one duplicate message that a
// human can delete. Marking first and crashing costs a giveaway that is never
// announced at all — and the server's marker is written under a
// `discordMessageId IS NULL` guard, so two bot instances racing produce one
// winner and one loser that knows it lost.

import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import { api } from "./api.js";
import { config } from "./config.js";
import { GIVEAWAY_ENTER_PREFIX } from "./commands.js";
import { giveawayCard } from "./cards/index.js";

/** How often to check. Much tighter than role sync (5 min) because an operator
 *  who ticks the box is watching Discord for the post, and a minute of nothing
 *  reads as broken. */
const TICK_MS = 30_000;

async function sendable(client: Client, channelId: string | null) {
  const id = channelId || config.tradeChannelId;
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (!ch || !ch.isTextBased() || !("send" in ch)) return null;
  return ch;
}

async function announce(client: Client): Promise<void> {
  const pending = await api.pendingGiveaways();

  for (const g of pending.toAnnounce) {
    const channel = await sendable(client, g.channelId);
    if (!channel) {
      // Deliberately NOT marked as announced: leaving it pending means fixing
      // the channel id in the dashboard is enough to make it post on the next
      // tick, with no need to recreate the giveaway.
      console.error(
        `[giveaways] no postable channel for ${g.id} ` +
          `(channelId=${g.channelId ?? "default"}) — leaving it pending.`,
      );
      continue;
    }

    try {
      const png = await giveawayCard({
        title: g.title,
        description: g.description,
        prizes: g.prizes,
        winnerCount: g.winnerCount,
      });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${GIVEAWAY_ENTER_PREFIX}${g.id}`)
          .setLabel("Enter")
          .setStyle(ButtonStyle.Primary)
          .setEmoji("🎟️"),
      );
      const msg = await channel.send({
        // Key facts in the body as well as on the card: a card is an image, so
        // it is not selectable, not translatable and invisible to a screen
        // reader.
        content:
          `🎁 **${g.title}** — ${g.prizeSummary} · ` +
          `${g.winnerCount} winner${g.winnerCount === 1 ? "" : "s"}` +
          (g.endsAt ? `\nCloses <t:${Math.floor(new Date(g.endsAt).getTime() / 1000)}:R>.` : "") +
          `\nPress **Enter** below — you'll need a linked game account, so run \`/link\` first if you haven't.`,
        files: [new AttachmentBuilder(png, { name: `giveaway-${g.id}.png` })],
        components: [row],
      });

      // Post first, then mark. See the header.
      const res = await api.markAnnounced(g.id, msg.id, channel.id);
      if (!res.claimed) {
        // Another instance won the race. Delete ours so the channel does not
        // carry two live Enter buttons for one giveaway.
        await msg.delete().catch(() => undefined);
        console.warn(`[giveaways] lost the announce race for ${g.id} — removed the duplicate.`);
      } else {
        console.log(`[giveaways] announced ${g.id} in #${channel.id}`);
      }
    } catch (e) {
      console.error(`[giveaways] failed to announce ${g.id}:`, String(e));
    }
  }

  for (const g of pending.toReport) {
    const channel = await sendable(client, g.channelId);
    if (!channel) {
      console.error(`[giveaways] no postable channel for results of ${g.id} — leaving it pending.`);
      continue;
    }
    try {
      const mentions = g.winners
        .map((w) => (w.discordId ? `<@${w.discordId}>` : `**${w.username}**`))
        .join(", ");
      await channel.send({
        content:
          `🎉 **${g.title}** has been drawn!\n` +
          (g.winners.length ? `Congratulations ${mentions}!` : "No eligible entries — nobody was drawn.") +
          `\n\nPrizes are queued and land the next time each winner loads the game. ` +
          `Nothing is lost if they're offline — run \`/prizes\` to check.` +
          (g.seed ? `\n-# draw seed: ${g.seed}` : ""),
        // Reply to the original announcement so the result threads onto it
        // rather than floating loose in the channel. Best-effort: an
        // announcement someone deleted must not stop the result being posted.
        ...(g.announceMessageId
          ? { reply: { messageReference: g.announceMessageId, failIfNotExists: false } }
          : {}),
      });
      await api.markReported(g.id);
      console.log(`[giveaways] posted results for ${g.id}`);
    } catch (e) {
      console.error(`[giveaways] failed to post results for ${g.id}:`, String(e));
    }
  }
}

export function startGiveawaySync(client: Client): void {
  if (config.giveawaySyncDisabled) {
    console.log("[giveaways] GIVEAWAY_SYNC_DISABLED=1 — not polling.");
    return;
  }
  const tick = () => {
    announce(client).catch((e) => console.error("[giveaways] poll failed:", String(e)));
  };
  tick();
  setInterval(tick, TICK_MS).unref?.();
}
