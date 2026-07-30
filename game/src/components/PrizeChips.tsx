import type { GiveawayPrize } from "../net/api";
import { prizeChips, describeChips } from "../utils/prizeDisplay";
import { Sprite } from "./Sprite";
import "./giveaways.css";

// A prize, drawn the way the game draws things.
//
// The dialog used to print the server's `describePrizes()` string — the raw
// stored ids, so a player was told they had won "1x goldbottlecap +
// 2x silverbottlecap". Everything needed to do better was already on the
// wire; this renders it through the SAME helpers the Bag and party use
// (itemSpriteUrl / pokemonSpriteUrl, and <Sprite> for the failure chain), so
// a prize chip is the existing visual language rather than a second one.

export function PrizeChips({
  prizes,
  size = "md",
}: {
  prizes: GiveawayPrize[];
  size?: "sm" | "md";
}) {
  const chips = prizeChips(prizes);
  if (chips.length === 0) return null;
  return (
    <span
      className={`gw-chips${size === "sm" ? " gw-chips--sm" : ""}`}
      // The text form is the accessible one; the sprites are decoration on
      // top of a name that is already written out.
      title={describeChips(chips)}
    >
      {chips.map((c) => (
        <span
          key={c.key}
          className={`gw-chip${c.isShiny ? " gw-chip--shiny" : ""}${c.known ? "" : " gw-chip--unknown"}`}
        >
          {c.spriteUrl ? (
            <Sprite
              className="gw-chip-img"
              src={c.spriteUrl}
              fallbackSrc={c.fallbackSpriteUrl || undefined}
              alt=""
              // The name is right there next to it, so a failed sprite is
              // genuinely redundant rather than lost information.
              missing="hidden"
            />
          ) : (
            <span className="gw-chip-glyph" aria-hidden>{c.glyph}</span>
          )}
          <span className="gw-chip-name">{c.name}</span>
          {c.qty > 1 && <span className="gw-chip-qty">×{c.qty}</span>}
        </span>
      ))}
    </span>
  );
}
