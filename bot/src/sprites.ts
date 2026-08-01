// Sprite URLs and the catalog lookups behind them.
//
// A port of game/src/utils/sprites.ts. The URL rules are copied rather than
// shared because there is nothing to share them through — the bot's build
// context does not include game/ — and the comments there record hard-won
// facts about the CDN that must not be re-discovered:
//
//   * raw.githubusercontent.com serves .gif as text/plain, which browsers
//     refuse to render. jsDelivr proxies the same repo with correct headers.
//   * jsDelivr 403s the NAMED filenames (bulbasaur.gif); only numeric-id
//     filenames are reliably served. Hence the snapshot — see scripts/.
//
// One difference from the game, and it is deliberate: the game prefers the
// ANIMATED Gen-V set and falls back to static PNGs when an ad-blocker eats the
// `/animated/` path. Card rendering here uses the STATIC set as its primary,
// because @napi-rs/canvas decodes only the first frame of a GIF and an
// animated source would give us one arbitrary frame of an animation — often a
// mid-blink or a mid-step pose. Embeds that carry a sprite as a plain URL
// (where Discord does the rendering, and animates it properly) use the
// animated one.

import pokemonSnapshot from "./data/pokemon-snapshot.json" with { type: "json" };
import itemsSnapshot from "./data/items-snapshot.json" with { type: "json" };
import movesSnapshot from "./data/moves-snapshot.json" with { type: "json" };

const PKMN_ANIMATED =
  "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-v/black-white/animated";
const PKMN_STATIC = "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon";
const ITEM_BASE = "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/items";

export interface SpeciesEntry {
  speciesKey: string;
  name: string;
  id: number;
  types: string[];
}

const SPECIES: Map<string, SpeciesEntry> = new Map(
  (pokemonSnapshot as SpeciesEntry[]).map((s) => [s.speciesKey, s]),
);

const ITEMS: Map<string, { id: string; name: string; spriteOverride?: string }> = new Map(
  (itemsSnapshot as Array<{ id: string; name: string; spriteOverride?: string }>).map((i) => [i.id, i]),
);

export function species(speciesKey: string): SpeciesEntry | null {
  return SPECIES.get(speciesKey) ?? null;
}

const MOVES: Map<string, { id: string; name: string; type: string }> = new Map(
  (movesSnapshot as Array<{ id: string; name: string; type: string }>).map((m) => [m.id, m]),
);

/**
 * Last-resort display name for an id the snapshot does not know.
 *
 * Splits camelCase and title-cases: "dragonClaw" → "Dragon Claw",
 * "blaze" → "Blaze". It will not produce the right answer for a compound
 * lowercase id ("lifeorb" → "Lifeorb"), and that is fine — it is the fallback
 * for content added to the game SINCE the last snapshot, where the honest
 * options are a slightly-wrong label or a raw id, and a raw id is what makes a
 * card look broken. Re-running `npm run snapshot` is the real fix.
 */
function prettify(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name for an item id, e.g. "masterball" → "Master Ball". */
export function itemName(itemId: string): string {
  return ITEMS.get(itemId)?.name ?? prettify(itemId);
}

/** Display name for a move id, e.g. "dragonClaw" → "Dragon Claw". */
export function moveName(moveId: string): string {
  return MOVES.get(moveId)?.name ?? prettify(moveId);
}

/** Abilities have no catalog of their own in the game data — they are ids on
 *  the mon — so this is prettify with a name that says what it is for. */
export function abilityName(abilityId: string): string {
  return prettify(abilityId);
}

/** Animated GIF. For embed thumbnails, where Discord renders it and the
 *  animation actually plays. Empty string when the species is unknown. */
export function pokemonAnimatedUrl(speciesKey: string, isShiny = false): string {
  const s = SPECIES.get(speciesKey);
  if (!s) return "";
  return isShiny ? `${PKMN_ANIMATED}/shiny/${s.id}.gif` : `${PKMN_ANIMATED}/${s.id}.gif`;
}

/** Static PNG. For canvas composition — see the header for why this is the
 *  primary here and the fallback in the game. */
export function pokemonStaticUrl(speciesKey: string, isShiny = false): string {
  const s = SPECIES.get(speciesKey);
  if (!s) return "";
  return isShiny ? `${PKMN_STATIC}/shiny/${s.id}.png` : `${PKMN_STATIC}/${s.id}.png`;
}

// Our item ids are camelCase/lowercase; PokeAPI's are kebab-case. The snapshot
// carries `spriteOverride` for the ones the game already had to correct, and
// the fallback inserts a hyphen before a capital so "ultraBall" → "ultra-ball".
//
// The explicit map below covers the compound lowercase ids that neither
// mechanism catches ("masterball" has no capital to split on). Copied from the
// game's ITEM_ID_OVERRIDES for exactly that reason.
const ITEM_ID_OVERRIDES: Record<string, string> = {
  pokeball: "poke-ball",
  greatball: "great-ball",
  ultraball: "ultra-ball",
  masterball: "master-ball",
  superpotion: "super-potion",
  hyperpotion: "hyper-potion",
  maxpotion: "max-potion",
  fullrestore: "full-restore",
  maxrevive: "max-revive",
  fullheal: "full-heal",
  paralyzeheal: "paralyze-heal",
  burnheal: "burn-heal",
  iceheal: "ice-heal",
  maxether: "max-ether",
  maxelixir: "max-elixir",
  rarecandy: "rare-candy",
  superrepel: "super-repel",
  maxrepel: "max-repel",
  firestone: "fire-stone",
  waterstone: "water-stone",
  thunderstone: "thunder-stone",
  leafstone: "leaf-stone",
  moonstone: "moon-stone",
  sunstone: "sun-stone",
  shinycharm: "shiny-charm",
  luckyegg: "lucky-egg",
  amuletcoin: "amulet-coin",
  expshare: "exp-share",
};

export function itemSpriteUrl(itemId: string): string {
  const slug =
    ITEMS.get(itemId)?.spriteOverride ??
    ITEM_ID_OVERRIDES[itemId] ??
    itemId.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `${ITEM_BASE}/${slug}.png`;
}

/** The game's own type palette, copied from MovesPanel.tsx so a card and the
 *  game agree about what colour Fire is. */
export const TYPE_COLOR: Record<string, string> = {
  Normal: "#a8a878",
  Fire: "#f08030",
  Water: "#6890f0",
  Electric: "#f8d030",
  Grass: "#78c850",
  Ice: "#98d8d8",
  Fighting: "#c03028",
  Poison: "#a040a0",
  Ground: "#e0c068",
  Flying: "#a890f0",
  Psychic: "#f85888",
  Bug: "#a8b820",
  Rock: "#b8a038",
  Ghost: "#705898",
  Dragon: "#7038f8",
  Dark: "#705848",
  Steel: "#b8b8d0",
  Fairy: "#ee99ac",
};

/** Primary type colour for a species, or a neutral grey when unknown. */
export function typeColorFor(speciesKey: string): string {
  const t = SPECIES.get(speciesKey)?.types?.[0];
  return (t && TYPE_COLOR[t]) || "#7c8598";
}
