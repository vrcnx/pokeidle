// Community XP — awarding it, and announcing level-ups.
//
// ── THIS DOES NOT READ MESSAGE TEXT ─────────────────────────────────
// XP is for showing up, not for what you said, so the only things sent to the
// server are the author's id, the channel id, and a display label. The message
// content is never read and never leaves Discord.
//
// That is worth stating because this listener fires on EVERY message in the
// server, which is by far the widest surface the bot has. It works fine
// without the MessageContent intent — `message.content` is simply never
// touched — so enabling XP does not require granting anything extra.
//
// ── WHY THE COOLDOWN IS NOT ENFORCED HERE ───────────────────────────
// It would be cheaper: a Map of discordId → timestamp, no network call for the
// 95% of messages inside the window. And it would reset on every redeploy,
// handing a free burst of XP to anyone who noticed the pattern.
//
// So every message costs one request and the server decides. The endpoint is a
// single indexed lookup plus a conditional update that usually matches
// nothing, which is a cheaper thing to do a lot of than it looks.

import { Events, type Client, type Message } from "discord.js";
import { api } from "./api.js";
import { config } from "./config.js";

/** Announce a level-up. Kept quiet by design: one short line, in the channel
 *  they were talking in unless an announce channel is configured. A big embed
 *  for every level-up turns a busy channel into a bot feed. */
async function announce(msg: Message, level: number): Promise<void> {
  const target = config.xpAnnounceChannelId
    ? await msg.client.channels.fetch(config.xpAnnounceChannelId).catch(() => null)
    : msg.channel;
  if (!target || !target.isTextBased() || !("send" in target)) return;
  await target
    .send(`${msg.author} reached **level ${level}**! 🎉`)
    .catch(() => undefined);
}

export function startXpListener(client: Client): void {
  client.on(Events.MessageCreate, (msg) => {
    if (msg.author.bot || msg.system) return;
    // DMs earn nothing — there is no community to participate in, and it would
    // be trivially farmable by talking to yourself in the bot's DMs.
    if (!msg.guild) return;

    void api
      .awardMessageXp({
        discordId: msg.author.id,
        channelId: msg.channelId,
        label: msg.author.username,
      })
      .then((res) => {
        if (res.leveledUp) void announce(msg, res.level);
      })
      // Silent. This runs on every message in the server, so a logged failure
      // per message during a game-server blip would bury every other log line
      // the bot produces. XP is a nicety; losing some is not an incident.
      .catch(() => undefined);
  });
}
