import { pokeballs } from "../data/pokeballs";
import { evolutionStones } from "../data/evolutionStones";
import { consumables } from "../data/consumables";
import { itemsCatalog, getCatalogItem } from "../data/itemsCatalog";

export const BALL_ORDER = ["pokeball", "greatball", "ultraball", "masterball"];

export function isBall(itemId: string): boolean {
  return itemId in pokeballs;
}

export function isConsumable(itemId: string): boolean {
  return itemId in consumables;
}

export function isStone(itemId: string): boolean {
  return itemId in evolutionStones;
}

// Item info — prefer the unified catalog, fall back to the legacy
// per-category data files for items the catalog doesn't cover yet.
export function getItemInfo(itemId: string): { name: string; description: string } {
  const cat = getCatalogItem(itemId);
  if (cat) return { name: cat.name, description: cat.description };
  if (itemId in pokeballs) {
    const b = pokeballs[itemId];
    return { name: b.name, description: b.description };
  }
  if (itemId in evolutionStones) {
    const s = evolutionStones[itemId];
    return { name: s.name, description: s.description };
  }
  if (itemId in consumables) {
    const c = consumables[itemId];
    return { name: c.name, description: c.description };
  }
  return { name: itemId, description: "" };
}

// Ask the catalog for an item's sprite slug override, if any. Used by Bag /
// Mart cells so PokeAPI's kebab-case file names line up.
export function itemSpriteSlug(itemId: string): string | undefined {
  return itemsCatalog[itemId]?.spriteOverride;
}

export function itemBucket(itemId: string): "pokeballs" | "items" {
  return itemId in pokeballs ? "pokeballs" : "items";
}
