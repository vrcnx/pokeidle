// Bridge module — re-exports the game's source-of-truth catalogs and
// sprite-URL helpers so admin pages can use the exact same data and
// images the game itself shows. Vite is configured (vite.config.ts /
// server.fs.allow + the `@game/*` alias) to allow importing from the
// sibling game/ package.
//
// Keeping this in a single file means the admin's coupling to game/'s
// internals is one import surface — if the game refactors a path, only
// this file breaks.

export { pokemonTable } from "@game/data/pokemon";
export { itemsCatalog, CATEGORY_ORDER, CATEGORY_LABELS } from "@game/data/itemsCatalog";
export type { CatalogItem, ItemCategory } from "@game/data/itemsCatalog";
export {
  pokemonSpriteUrl,
  pokemonStaticSpriteUrl,
  itemSpriteUrl,
} from "@game/utils/sprites";
export { createPokemon } from "@game/utils/pokemon";
import { pokemonTable as _pokemonTable } from "@game/data/pokemon";
import { itemsCatalog as _itemsCatalog } from "@game/data/itemsCatalog";

// Convenience: arrays sorted for combobox / table rendering. We
// memoise at module scope (built once, freed on hot-reload) so big
// pages don't recompute these on every render.
export const POKEMON_LIST: { speciesKey: string; name: string; id: number; types: string[] }[] =
  Object.entries(_pokemonTable)
    .map(([speciesKey, sp]) => ({
      speciesKey,
      name: sp.name,
      id: sp.id,
      types: sp.types,
    }))
    .sort((a, b) => a.id - b.id);

export const ITEM_LIST: {
  id: string;
  name: string;
  category: string;
  description: string;
  spriteOverride?: string;
}[] = Object.values(_itemsCatalog)
  .map((it) => ({
    id: it.id,
    name: it.name,
    category: it.category,
    description: it.description,
    spriteOverride: it.spriteOverride,
  }))
  .sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });
