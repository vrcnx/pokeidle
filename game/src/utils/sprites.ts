// Sprite URL builders.
//
// Source of truth: the PokeAPI sprites repository, specifically the Gen V
// Black/White animated set:
//   github.com/PokeAPI/sprites/tree/master/sprites/pokemon/versions/generation-v/black-white/animated
//
// We can't load directly from `raw.githubusercontent.com` — GitHub returns
// `Content-Type: text/plain` on the .gif files, which Chrome's Opaque
// Response Blocking refuses to render as images. jsDelivr proxies the same
// repo with proper `image/gif` headers, and only the **numeric-ID** filenames
// (e.g. `1.gif` for Bulbasaur) are reliably served — named filenames
// (`bulbasaur.gif`) are 403'd by their CDN.
//
// So: look up the species ID from the data table, build the URL with that.

import { pokemonTable } from "../data/pokemon";

const PKMN_BASE =
  "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-v/black-white/animated";

const SHOWDOWN_TRAINERS = "https://play.pokemonshowdown.com/sprites/trainers";

function speciesIdFromKey(speciesKey: string): number | null {
  return pokemonTable[speciesKey]?.id ?? null;
}

export function pokemonSpriteUrl(
  speciesKey: string,
  isBack = false,
  isShiny = false
): string {
  const id = speciesIdFromKey(speciesKey);
  if (id == null) return "";
  const folder =
    isBack && isShiny ? "back/shiny" :
    isShiny           ? "shiny" :
    isBack            ? "back" :
                        "";
  return folder
    ? `${PKMN_BASE}/${folder}/${id}.gif`
    : `${PKMN_BASE}/${id}.gif`;
}

// Static fallback: same source repo, base sprites/pokemon/{id}.png
export function pokemonStaticSpriteUrl(speciesId: number, isShiny = false): string {
  const folder = isShiny ? "shiny/" : "";
  return `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/${folder}${speciesId}.png`;
}

export function trainerSpriteUrl(spriteKey: string): string {
  return `${SHOWDOWN_TRAINERS}/${spriteKey}.png`;
}

// PokeAPI items repo — all of them at /sprites/items/{kebab-case}.png.
// Our internal item ids are camelCase / lowercase; map the ones whose names
// don't trivially match. Fallback inserts a hyphen between the prefix and
// "ball" / "stone" / "potion" so most of our ids work without explicit
// mapping (e.g. "ultraball" → "ultra-ball").
const ITEM_BASE =
  "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/items";

const ITEM_ID_OVERRIDES: Record<string, string> = {
  pokeball: "poke-ball",
  greatball: "great-ball",
  ultraball: "ultra-ball",
  masterball: "master-ball",
  potion: "potion",
  superpotion: "super-potion",
  hyperpotion: "hyper-potion",
  maxpotion: "max-potion",
  fullrestore: "full-restore",
  revive: "revive",
  maxrevive: "max-revive",
  fullheal: "full-heal",
  antidote: "antidote",
  awakening: "awakening",
  paralyzeheal: "paralyze-heal",
  burnheal: "burn-heal",
  iceheal: "ice-heal",
  ether: "ether",
  maxether: "max-ether",
  elixir: "elixir",
  maxelixir: "max-elixir",
  rarecandy: "rare-candy",
  // Repels
  repel: "repel",
  superrepel: "super-repel",
  maxrepel: "max-repel",
  honey: "honey",
  // Stones
  firestone: "fire-stone",
  waterstone: "water-stone",
  thunderstone: "thunder-stone",
  leafstone: "leaf-stone",
  moonstone: "moon-stone",
  sunstone: "sun-stone",
  // Held items
  shinycharm: "shiny-charm",
  luckyegg: "lucky-egg",
  amuletcoin: "amulet-coin",
  expshare: "exp-share",
};

export function itemSpriteUrl(itemId: string, slugOverride?: string): string {
  const slug =
    slugOverride ??
    ITEM_ID_OVERRIDES[itemId] ??
    itemId.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `${ITEM_BASE}/${slug}.png`;
}
