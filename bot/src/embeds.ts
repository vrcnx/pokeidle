// Embeds.
//
// Almost everything the bot shows is now a RENDERED CARD (see cards/), because
// an embed's field layout reflows differently on desktop, mobile and compact
// mode and cannot be controlled. What is left here is the trade listing, which
// stays an embed on purpose: it is the one surface whose content is a LINK the
// reader is meant to click, and a link inside a PNG is not a link.
//
// It also carries player-written text (offering / wanting). Keeping that as
// real text means it stays selectable, searchable in Discord, and readable by
// a screen reader — none of which is true of an image.

import { EmbedBuilder } from "discord.js";
import type { TournamentDetail, TournamentSummary } from "./api.js";

const BRAND = 0xf2c94c;

/** Discord's own relative timestamp. Renders in the reader's timezone and
 *  counts down live, which is the entire reason the tournament surfaces are
 *  embeds rather than rendered cards: "in 4 hours" baked into a PNG is wrong
 *  by the time anyone scrolls past it. */
function relative(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:R>` : null;
}

const STATUS_LABEL: Record<string, string> = {
  open: "🟢 Open — you can still enter",
  live: "⚔️ Running",
  scheduled: "🗓️ Scheduled",
  completed: "🏆 Finished",
  cancelled: "⚫ Cancelled",
};

function statusLine(t: TournamentSummary): string {
  const bits = [STATUS_LABEL[t.status] ?? t.status, `${t.entrantCount} entered`];
  if (t.levelCap) bits.push(`Lv ${t.levelCap} cap`);
  if (t.prizeSummary) bits.push(`🎁 ${t.prizeSummary}`);
  return bits.join(" · ");
}

export function tournamentListEmbed(
  tournaments: TournamentSummary[],
  linked: boolean,
): EmbedBuilder {
  const e = new EmbedBuilder().setColor(BRAND).setTitle("PvP tournaments");

  if (tournaments.length === 0) {
    return e.setDescription(
      "No tournaments running right now. They're announced in the ladder channel when they open.",
    );
  }

  for (const t of tournaments.slice(0, 10)) {
    const lines = [statusLine(t)];
    if (t.championUsername) lines.push(`Champion: **${t.championUsername}**`);
    if (t.you?.entered) lines.push(t.you.eliminated ? "You: knocked out" : "**You're in this one.**");
    lines.push(`\`/tournament info id:${t.id}\``);
    e.addFields({ name: t.name, value: lines.join("\n") });
  }

  if (!linked) {
    e.setFooter({ text: "Run /link to see which of these you're entered in." });
  }
  return e;
}

export function tournamentDetailEmbed(t: TournamentDetail, linked: boolean): EmbedBuilder {
  const e = new EmbedBuilder().setColor(BRAND).setTitle(t.name).setDescription(statusLine(t));

  if (t.currentRound && t.totalRounds) {
    e.addFields({ name: "Progress", value: `Round ${t.currentRound} of ${t.totalRounds}` });
  }

  // YOUR MATCH FIRST after progress — it is the only actionable thing here and
  // the reason this command exists. Rounds run asynchronously for up to
  // roundWindowMinutes, so "who and by when" is the whole message.
  if (t.yourMatch) {
    const m = t.yourMatch;
    const lines: string[] = [];
    if (m.isBye) {
      lines.push("You have a **bye** this round — you advance automatically.");
    } else if (!m.decided) {
      lines.push(`You're up against **${m.opponent ?? "an opponent still to be decided"}**.`);
      const due = relative(m.deadlineAt);
      if (due) {
        lines.push(
          `Deadline: ${due}. **Both of you must be online at the same time** for the match ` +
            `to start — whoever shows up alone at the deadline takes the walkover.`,
        );
      } else {
        lines.push("The round hasn't been armed yet — no deadline is running.");
      }
    } else {
      lines.push(
        m.youWon
          ? `You beat **${m.opponent ?? "your opponent"}**.`
          : `You lost to **${m.opponent ?? "your opponent"}**.`,
      );
    }
    if (m.note) lines.push(`_${m.note}_`);
    e.addFields({ name: `⚔️ Your round ${m.roundNumber} match`, value: lines.join("\n") });
  } else if (linked && t.you && !t.you.entered) {
    e.addFields({
      name: "You're not entered",
      value: "Sign-ups happen in the game — open Pokémon Idle and join from the PvP screen.",
    });
  }

  if (t.entrants.length) {
    const shown = t.entrants
      .slice(0, 16)
      .map((p) => {
        const seed = p.seed ? `\`${String(p.seed).padStart(2)}\` ` : "";
        return p.eliminated ? `${seed}~~${p.username}~~` : `${seed}**${p.username}**`;
      })
      .join("\n");
    const more = t.entrants.length > 16 ? `\n…and ${t.entrants.length - 16} more` : "";
    e.addFields({ name: `Entrants (${t.entrants.length})`, value: shown + more });
  }

  if (!linked) e.setFooter({ text: "Run /link to see your own pairing and deadline." });
  return e;
}

export function tradeListingEmbed(input: {
  username: string;
  offering: string;
  wanting: string;
  deepLink: string;
  authorTag: string;
  expiresAt: Date;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${input.username} is trading`)
    .addFields(
      { name: "Offering", value: input.offering },
      { name: "Looking for", value: input.wanting },
    )
    .setDescription(
      `[Open in game](${input.deepLink}) — this opens Pokémon Idle and starts a trade with ` +
        `${input.username} **if they're online**. Trades happen in the game, never here.`,
    )
    .setFooter({ text: `Posted by ${input.authorTag} · expires` })
    .setTimestamp(input.expiresAt);
}
