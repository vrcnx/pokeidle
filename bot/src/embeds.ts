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

const BRAND = 0xf2c94c;

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
