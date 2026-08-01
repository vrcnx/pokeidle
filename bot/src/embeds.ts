// Embed builders.
//
// Kept apart from the command handlers so that "what does the bot show?" and
// "what does the bot do?" are separate questions. Every builder here takes a
// DTO from the API client and returns an EmbedBuilder; none of them fetch,
// none of them know about interactions.

import { EmbedBuilder } from "discord.js";
import type { Identity, MonDetail, MonSummary, Rating } from "./api.js";

/** House colour, so every embed reads as coming from the same bot. */
const BRAND = 0xf2c94c;
const MUTED = 0x5865f2;

/** Discord renders `<t:unix:R>` as a live relative timestamp in the reader's
 *  own locale and timezone. Always preferable to a formatted date string,
 *  which would be in the SERVER's timezone and wrong for most readers. */
function relative(iso: string): string {
  return `<t:${Math.floor(new Date(iso).getTime() / 1000)}:R>`;
}

function shinyMark(m: { isShiny: boolean }): string {
  return m.isShiny ? " ✨" : "";
}

/** Species keys are lowercase ids ("nidoranf"). The blob also carries the
 *  display name the game showed at creation, which is what a player
 *  recognises, so prefer it and fall back to a tidied key. */
function displayName(m: MonSummary): string {
  const base = m.name || m.speciesKey;
  return m.nickname ? `${m.nickname} (${base})` : base;
}

export function profileEmbed(p: Identity): EmbedBuilder {
  const r = p.rating;
  const e = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${p.name ?? p.username}`)
    .setDescription(`@${p.username}`)
    .addFields(
      { name: "Account level", value: String(p.accountLevel), inline: true },
      { name: "Pokédex", value: `${p.pokedexCaughtCount} caught`, inline: true },
      {
        name: "Daily streak",
        value: p.dailyStreak > 0
          ? `${p.dailyStreak} day${p.dailyStreak === 1 ? "" : "s"} (best ${p.longestDailyStreak})`
          : "—",
        inline: true,
      },
      {
        name: "PvP",
        // "Unranked" rather than 1000, because 1000 is the starting value and
        // printing it as though it were earned makes every new account look
        // like a mid-table player.
        value: r.unranked
          ? "Unranked"
          : `${r.rating} · ${r.wins}W-${r.losses}L${r.ladderPosition ? ` · #${r.ladderPosition}` : ""}`,
        inline: true,
      },
      { name: "Playing since", value: relative(p.createdAt), inline: true },
      { name: "Last seen", value: relative(p.lastSeenAt), inline: true },
    );
  return e;
}

export function rankEmbed(username: string, r: Rating): EmbedBuilder {
  if (r.unranked) {
    return new EmbedBuilder()
      .setColor(MUTED)
      .setTitle(`${username} — Unranked`)
      .setDescription("No rated matches played yet. Win one and you're on the ladder.");
  }
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${username} — ${r.rating}`)
    .addFields(
      { name: "Ladder position", value: r.ladderPosition ? `#${r.ladderPosition}` : "—", inline: true },
      { name: "Peak", value: String(r.peakRating), inline: true },
      { name: "Matches", value: String(r.matchesPlayed), inline: true },
      { name: "Record", value: `${r.wins}W – ${r.losses}L`, inline: true },
      { name: "Forfeits", value: String(r.forfeits), inline: true },
    );
}

export function leaderboardEmbed(
  rows: Array<{ rank: number; username: string; rating: number; wins: number; losses: number }>,
): EmbedBuilder {
  if (rows.length === 0) {
    return new EmbedBuilder()
      .setColor(MUTED)
      .setTitle("PvP ladder")
      .setDescription("Nobody's on the board yet. Play a rated match and the top spot is yours.");
  }
  const medal = (n: number) => (n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : `\`${String(n).padStart(2, " ")}\``);
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle("PvP ladder — top " + rows.length)
    .setDescription(
      rows
        .map((r) => `${medal(r.rank)} **${r.username}** — ${r.rating} (${r.wins}W-${r.losses}L)`)
        .join("\n"),
    );
}

export function teamEmbed(username: string, party: MonSummary[], started: boolean): EmbedBuilder {
  if (!started) {
    return new EmbedBuilder()
      .setColor(MUTED)
      .setTitle(`${username}'s team`)
      .setDescription("This trainer hasn't started playing yet.");
  }
  if (party.length === 0) {
    return new EmbedBuilder()
      .setColor(MUTED)
      .setTitle(`${username}'s team`)
      .setDescription("No Pokémon in the party right now.");
  }
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${username}'s team`)
    .setDescription(
      party
        .map((m) => {
          const bits = [`Lv ${m.level}`];
          if (m.nature) bits.push(m.nature);
          if (m.heldItem) bits.push(`holding ${m.heldItem}`);
          const moves = m.moves.length ? `\n ↳ ${m.moves.join(", ")}` : "";
          return `**${m.slot}. ${displayName(m)}**${shinyMark(m)} — ${bits.join(" · ")}${moves}`;
        })
        .join("\n"),
    );
}

export function monEmbed(username: string, m: MonDetail): EmbedBuilder {
  const statLine = (label: string, key: string, base: number) => {
    const iv = m.ivs[key];
    const ev = m.evs[key];
    const parts = [String(base)];
    if (iv !== undefined || ev !== undefined) {
      parts.push(`(IV ${iv ?? 0}${ev ? ` · EV ${ev}` : ""})`);
    }
    return `**${label}** ${parts.join(" ")}`;
  };
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${displayName(m)}${shinyMark(m)}`)
    .setDescription(`${username}'s party slot ${m.slot} · Level ${m.level}`)
    .addFields(
      {
        name: "Stats",
        value: [
          statLine("HP", "hp", m.maxHp),
          statLine("Atk", "attack", m.attack),
          statLine("Def", "defense", m.defense),
          statLine("SpA", "spAttack", m.spAttack),
          statLine("SpD", "spDefense", m.spDefense),
          statLine("Spe", "speed", m.speed),
        ].join("\n"),
      },
      { name: "Nature", value: m.nature ?? "—", inline: true },
      { name: "Ability", value: m.ability ?? "—", inline: true },
      { name: "Held item", value: m.heldItem ?? "—", inline: true },
      { name: "Moves", value: m.moves.length ? m.moves.join("\n") : "—" },
    );
}

export function dexEmbed(d: {
  username: string;
  caughtCount: number;
  seenCount: number | null;
  shinyCaughtCount: number | null;
}): EmbedBuilder {
  const fields = [{ name: "Caught", value: String(d.caughtCount), inline: true }];
  if (d.seenCount !== null) fields.push({ name: "Seen", value: String(d.seenCount), inline: true });
  if (d.shinyCaughtCount !== null) {
    fields.push({ name: "Shiny caught", value: String(d.shinyCaughtCount), inline: true });
  }
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${d.username}'s Pokédex`)
    .addFields(fields);
}

export function prizesEmbed(
  username: string,
  grants: Array<{
    summary: string; source: string; createdAt: string;
    delivered: boolean; stuck: boolean; lastError: string | null;
  }>,
): EmbedBuilder {
  if (grants.length === 0) {
    return new EmbedBuilder()
      .setColor(MUTED)
      .setTitle(`${username}'s prizes`)
      .setDescription("Nothing owed and nothing recently delivered.");
  }
  return new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(`${username}'s prizes`)
    .setDescription(
      grants
        .map((g) => {
          if (g.delivered) return `✅ **${g.summary}** — delivered`;
          if (g.stuck) {
            // The single most common cause by far, and the one the player can
            // actually fix. Naming it beats printing the validator's string on
            // its own, which reads as an error the player caused.
            return `⚠️ **${g.summary}** — waiting. Usually a full box: make room and it'll land on your next save.`;
          }
          return `⏳ **${g.summary}** — queued, lands next time you load the game`;
        })
        .join("\n"),
    )
    .setFooter({ text: "Prizes are applied on your next save upload. Nothing is lost if you're offline." });
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
