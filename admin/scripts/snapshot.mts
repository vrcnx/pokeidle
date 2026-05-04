// One-off script: read pokemon + items from game/src/data/ and emit JSON
// snapshots into admin/src/data/. The committed JSON is what the admin
// builds against (the `@game/*` cross-package imports broke deploys
// where game/ isn't part of the build context).
//
// Run: cd admin && npx tsx scripts/snapshot.mts
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pokemonTable } from "../../game/src/data/pokemon.ts";
import { itemsCatalog } from "../../game/src/data/itemsCatalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "src", "data");

const pokemon = Object.entries(pokemonTable)
  .map(([speciesKey, sp]) => ({
    speciesKey,
    name: sp.name,
    id: sp.id,
    types: sp.types,
    baseStats: sp.baseStats,
    growthRate: sp.growthRate,
  }))
  .sort((a, b) => a.id - b.id);

const items = Object.values(itemsCatalog)
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

writeFileSync(resolve(dataDir, "pokemon-snapshot.json"), JSON.stringify(pokemon, null, 2));
writeFileSync(resolve(dataDir, "items-snapshot.json"), JSON.stringify(items, null, 2));
console.log(`Wrote ${pokemon.length} Pokémon and ${items.length} items into ${dataDir}.`);
