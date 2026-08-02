// Announcing tournaments, and posting the champion when one resolves.
//
// Structurally identical to giveawaySync.ts — a poll, because the game server
// holds no Discord token; post first and mark second, because a duplicate a
// human can delete beats an announcement that never happens. Read that file's
// header for the full argument; it is not repeated here.
//
// ── WHY A TOURNAMENT ANNOUNCEMENT EARNS A PING ──────────────────────
// Almost nothing should ping a whole role. This does, and the reason is
// structural rather than promotional: sign-ups CLOSE. A bracket generates from
// whoever entered by the time the operator starts it, and someone who scrolled
// past the message has not "missed a post", they have missed the event
// entirely. That is the same test the giveaway announcement passes.
//
// It pings an OPT-IN role (PvP Ladder), never @everyone — the role exists
// precisely so this ping reaches people who asked for it.
//
// The champion post deliberately does NOT ping the role. It is a result, not
// an invitation: there is nothing to act on and nothing to miss.

import { AttachmentBuilder, type Client, type Guild } from "discord.js";
import { api } from "./api.js";
import { config } from "./config.js";

/** Matches giveawaySync. An operator who ticks the box is watching Discord for
 *  the post, and a minute of nothing reads as broken. */
const TICK_MS = 30_000;

async function sendable(client: Client, channelId: string | null) {
  const id = channelId || config.ladderChannelId;
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  if (!ch || !ch.isTextBased() || !("send" in ch)) return null;
  return ch;
}

/** The ping role's mention, or "" when it does not exist in this guild. Resolved
 *  by NAME for the same reason roleSync.ts does: the game server never holds a
 *  guild-specific role id. */
function pingMention(guild: Guild | null): string {
  if (!guild || !config.ladderPingRole) return "";
  const role = guild.roles.cache.find(
    (r) => r.name.toLowerCase() === config.ladderPingRole.toLowerCase(),
  );
  return role ? `${role} ` : "";
}

function hours(minutes: number): string {
  if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const h = Math.round(minutes / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

async function tick(client: Client): Promise<void> {
  const pending = await api.pendingTournaments();
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (guild) await guild.roles.fetch().catch(() => undefined);

  for (const t of pending.toAnnounce) {
    const channel = await sendable(client, t.channelId);
    if (!channel) {
      // NOT marked. Setting DISCORD_LADDER_CHANNEL_ID and restarting is then
      // enough to make it post on the next tick, with no need to recreate the
      // tournament in the dashboard.
      console.error(
        `[tournaments] no postable channel for ${t.id} ` +
          `(channelId=${t.channelId ?? "default"}, DISCORD_LADDER_CHANNEL_ID=` +
          `${config.ladderChannelId || "unset"}) — leaving it pending.`,
      );
      continue;
    }

    try {
      const bits = [`**${t.name}** — sign-ups are open`];
      if (t.levelCap) bits.push(`Level ${t.levelCap} cap`);
      if (t.prizeSummary) bits.push(`🎁 ${t.prizeSummary}`);

      const msg = await channel.send({
        content:
          `${pingMention(guild)}🏆 ${bits.join(" · ")}\n` +
          `Currently **${t.entrantCount}** entered. ` +
          (t.startsAt
            ? `Starts <t:${Math.floor(new Date(t.startsAt).getTime() / 1000)}:R>. `
            : "") +
          `\n\n**Enter from the PvP screen in game** — sign-ups don't happen here.\n` +
          // The single most useful sentence in the message. Rounds are
          // asynchronous, so people expect a scheduled match time and there
          // isn't one; saying so up front prevents the "when is my match?"
          // question that the format cannot answer.
          `Each round stays open for **${hours(t.roundWindowMinutes)}** — you and your ` +
          `opponent just need to be online at the same time inside that window, and ` +
          `whoever shows up alone at the deadline takes the walkover.\n` +
          `-# Track it with \`/tournament info id:${t.id}\``,
        allowedMentions: { parse: ["roles"] },
      });

      const res = await api.markTournamentAnnounced(t.id, msg.id, channel.id);
      if (!res.claimed) {
        await msg.delete().catch(() => undefined);
        console.warn(`[tournaments] lost the announce race for ${t.id} — removed the duplicate.`);
      } else {
        console.log(`[tournaments] announced ${t.id} in ${channel.id}`);
      }
    } catch (e) {
      console.error(`[tournaments] failed to announce ${t.id}:`, String(e));
    }
  }

  for (const t of pending.toReport) {
    const channel = await sendable(client, t.channelId);
    if (!channel) {
      console.error(`[tournaments] no postable channel for the result of ${t.id} — leaving it pending.`);
      continue;
    }
    try {
      const who = t.championDiscordId
        ? `<@${t.championDiscordId}>`
        : t.championUsername
          ? `**${t.championUsername}**`
          : null;
      await channel.send({
        content: who
          ? `🏆 **${t.name}** is done — ${who} takes it, beating ${t.entrantCount - 1} other ` +
            `trainer${t.entrantCount === 2 ? "" : "s"}.` +
            (t.prizeSummary
              ? `\nPrize: ${t.prizeSummary} — queued now, lands the next time they load the game. ` +
                `\`/prizes\` shows it.`
              : "")
          : `**${t.name}** has finished without a champion — the bracket was cancelled or ` +
            `nobody completed a match.`,
        // Thread onto the announcement so the result sits with the sign-up
        // post. Best-effort: an announcement someone deleted must not stop the
        // result being posted.
        ...(t.announceMessageId
          ? { reply: { messageReference: t.announceMessageId, failIfNotExists: false } }
          : {}),
        // A champion post is a result, not an invitation — no role ping.
        allowedMentions: { users: t.championDiscordId ? [t.championDiscordId] : [] },
      });
      await api.markTournamentReported(t.id);
      console.log(`[tournaments] posted the result for ${t.id}`);
    } catch (e) {
      console.error(`[tournaments] failed to post the result for ${t.id}:`, String(e));
    }
  }
}

export function startTournamentSync(client: Client): void {
  if (config.tournamentSyncDisabled) {
    console.log("[tournaments] TOURNAMENT_SYNC_DISABLED=1 — not polling.");
    return;
  }
  if (!config.ladderChannelId) {
    // Loud, once, at boot. The failure mode this prevents is a tournament that
    // is ticked for announcement in the dashboard and silently never appears.
    console.warn(
      "[tournaments] DISCORD_LADDER_CHANNEL_ID is unset — tournaments ticked for " +
        "announcement will stay pending until it is set.",
    );
  }
  // Overlap guard — same reasoning as giveawaySync.ts and roleSync.ts. Two
  // concurrent polls would both read the same pending brackets and both post
  // them; the NULL-guarded claim picks a winner, but only after the loser has
  // already pinged a role.
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(client);
    } catch (e) {
      console.error("[tournaments] poll failed:", String(e));
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), TICK_MS).unref?.();
}
