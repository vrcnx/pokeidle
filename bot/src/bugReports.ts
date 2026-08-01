// Ingesting bug reports posted in the community server's bug channel.
//
// ── THIS IS THE ONE FEATURE THAT READS MESSAGE TEXT ─────────────────
// Everything else the bot does treats Discord as a rendering surface: slash
// commands in, cards out, no message content touched. This does not, and it
// costs two things worth being explicit about:
//
//   * The MessageContent PRIVILEGED INTENT must be enabled in the Developer
//     Portal. Without it `message.content` is an empty string for every
//     message that does not mention the bot — and it fails SILENTLY, as
//     reports that ingest with a blank description. `looksEmpty` below turns
//     that into a loud log instead.
//   * Player-written Discord text now lives in the game database.
//
// Both are bounded to the ONE configured channel. Every other channel, every
// DM, every bot message and every thread reply is ignored — see `relevant`.
//
// ── TWO SHAPES OF BUG CHANNEL ───────────────────────────────────────
// Discord communities run these as either a plain text channel or a FORUM.
// Both are supported because both are common and the difference is real:
//
//   text channel → one message is one report. Title is derived from the first
//                  line, which is what people naturally write anyway.
//   forum        → one THREAD is one report, and the thread already HAS a
//                  title the reporter chose. That is strictly better data, so
//                  it is used as-is.
//
// ── WHY THERE IS A BOOT SWEEP AS WELL AS A LIVE LISTENER ────────────
// A listener only sees messages posted while the process is connected.
// Anything posted during a redeploy is lost forever, which for a bug report
// means it is never triaged and the reporter concludes nobody is listening.
// The sweep re-reads recent history on boot and re-submits everything; the
// server's `discordMessageId UNIQUE` makes the duplicates free.

import {
  ChannelType,
  Events,
  type AnyThreadChannel,
  type Client,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { api, ApiError } from "./api.js";
import { config } from "./config.js";

/** How far back the boot sweep looks. 50 is Discord's cheapest page size and
 *  covers any realistic redeploy window for a bug channel — if a channel moves
 *  faster than 50 reports per deploy, the backlog is the smaller problem. */
const SWEEP_LIMIT = 50;

/** Minimum body length. Discord bug channels collect a lot of "same here" and
 *  "+1", and every one of those would otherwise become a row in the triage
 *  queue. The server enforces the same floor; this just avoids the round trip.
 */
const MIN_DESCRIPTION = 10;

/**
 * Derive a title and body from a free-text post.
 *
 * The first line is the title when it reads like one — short, and with a body
 * after it, which is how people naturally write a report. Otherwise the whole
 * message is the body and the title is a truncation of it, because a report
 * with no title at all is worse in the triage list than a slightly clumsy one.
 */
function splitReport(content: string): { title: string; description: string } {
  const trimmed = content.trim();
  const lines = trimmed.split("\n");
  const first = lines[0]?.trim() ?? "";
  const rest = lines.slice(1).join("\n").trim();

  if (first && first.length <= 120 && rest.length >= MIN_DESCRIPTION) {
    return { title: first, description: rest };
  }
  return {
    title: trimmed.slice(0, 117) + (trimmed.length > 117 ? "…" : ""),
    description: trimmed,
  };
}

/** Is this message one we should ingest at all? */
function relevant(msg: Message): boolean {
  if (msg.author.bot) return false;
  if (msg.system) return false;
  // Replies are follow-up discussion on someone else's report, not new
  // reports. Ingesting them fills the queue with "have you tried reloading".
  if (msg.reference?.messageId) return false;
  return true;
}

/**
 * A blank body when the intent is missing is the failure this catches.
 *
 * Discord returns `content: ""` rather than erroring when MessageContent is
 * not granted, so without this the symptom is "every report ingests with an
 * empty description" and the cause is three settings pages away.
 */
function looksEmpty(msg: Message): boolean {
  return msg.content.trim().length === 0 && msg.attachments.size === 0;
}

let warnedAboutIntent = false;

async function submit(input: {
  messageId: string;
  discordId: string;
  discordName: string;
  url: string;
  title: string;
  description: string;
}): Promise<"created" | "duplicate" | "skipped"> {
  try {
    const res = await api.submitBugReport({
      discordMessageId: input.messageId,
      discordId: input.discordId,
      discordName: input.discordName,
      messageUrl: input.url,
      title: input.title,
      description: input.description,
    });
    return res.duplicate ? "duplicate" : "created";
  } catch (e) {
    // A too-short post is not an error worth logging on every sweep — it is
    // chatter in a chat channel, which is the expected case.
    if (e instanceof ApiError && e.code === "too_short") return "skipped";
    throw e;
  }
}

/** Ingest one plain-text-channel message. */
async function ingestMessage(msg: Message): Promise<"created" | "duplicate" | "skipped"> {
  if (!relevant(msg)) return "skipped";
  if (looksEmpty(msg)) {
    if (!warnedAboutIntent) {
      warnedAboutIntent = true;
      console.error(
        "[bugs] a message arrived with EMPTY content. This almost always means the " +
          "MESSAGE CONTENT INTENT is off in the Discord Developer Portal → Bot → " +
          "Privileged Gateway Intents. Bug ingest cannot work without it.",
      );
    }
    return "skipped";
  }
  const { title, description } = splitReport(msg.content);
  if (description.length < MIN_DESCRIPTION) return "skipped";

  return submit({
    messageId: msg.id,
    discordId: msg.author.id,
    discordName: msg.author.username,
    url: msg.url,
    title,
    description,
  });
}

/**
 * Ingest a forum thread. The thread NAME is the title the reporter chose,
 * which is better than anything derived from the body, and the starter message
 * is the body.
 *
 * Keyed on the STARTER MESSAGE's id rather than the thread's. In Discord a
 * forum thread and its starter message share an id today, but that is an
 * implementation detail rather than a guarantee, and using the message id
 * keeps the idempotency key meaning the same thing on both paths.
 */
async function ingestThread(thread: AnyThreadChannel): Promise<"created" | "duplicate" | "skipped"> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (!starter || !relevant(starter)) return "skipped";
  const description = starter.content.trim();
  if (description.length < MIN_DESCRIPTION) return "skipped";

  return submit({
    messageId: starter.id,
    discordId: starter.author.id,
    discordName: starter.author.username,
    url: starter.url,
    title: thread.name.slice(0, 120),
    description,
  });
}

/**
 * Re-read recent history so anything posted while the bot was down is picked
 * up. Safe to run on every boot: the server's unique constraint makes a
 * re-submission a no-op.
 */
async function sweep(client: Client): Promise<void> {
  const channel = await client.channels.fetch(config.bugChannelId).catch(() => null);
  if (!channel) {
    console.error(`[bugs] channel ${config.bugChannelId} not reachable — ingest is off.`);
    return;
  }

  let created = 0;
  let seen = 0;

  try {
    if (channel.type === ChannelType.GuildForum) {
      // Active threads only. An archived thread is an old report, and if it
      // was never ingested it is also one nobody is waiting on.
      const active = await channel.threads.fetchActive();
      for (const [, thread] of active.threads) {
        seen++;
        if ((await ingestThread(thread)) === "created") created++;
      }
    } else if (channel.isTextBased() && "messages" in channel) {
      const recent = await (channel as TextBasedChannel & { messages: any }).messages.fetch({
        limit: SWEEP_LIMIT,
      });
      for (const [, msg] of recent) {
        seen++;
        if ((await ingestMessage(msg as Message)) === "created") created++;
      }
    } else {
      console.error(`[bugs] channel ${config.bugChannelId} is not a text or forum channel.`);
      return;
    }
  } catch (e) {
    console.error("[bugs] sweep failed:", String(e));
    return;
  }

  console.log(`[bugs] sweep: ${seen} checked, ${created} newly ingested.`);
}

export function startBugReportIngest(client: Client): void {
  if (!config.bugChannelId) {
    console.log("[bugs] DISCORD_BUG_CHANNEL_ID not set — bug ingest is off.");
    return;
  }

  client.on(Events.MessageCreate, (msg) => {
    if (msg.channelId !== config.bugChannelId) return;
    void ingestMessage(msg)
      .then((r) => { if (r === "created") console.log(`[bugs] ingested ${msg.id} from @${msg.author.username}`); })
      .catch((e) => console.error("[bugs] ingest failed:", String(e)));
  });

  client.on(Events.ThreadCreate, (thread) => {
    // Forum posts arrive as threads whose PARENT is the configured channel.
    if (thread.parentId !== config.bugChannelId) return;
    void ingestThread(thread)
      .then((r) => { if (r === "created") console.log(`[bugs] ingested thread "${thread.name}"`); })
      .catch((e) => console.error("[bugs] thread ingest failed:", String(e)));
  });

  // Catch up on anything missed while the process was down.
  void sweep(client);
}
