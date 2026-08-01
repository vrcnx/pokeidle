// One-off script: read pokemon + items from game/src/data/ and emit JSON
// snapshots into bot/src/data/.
//
// Same problem and same solution as admin/scripts/snapshot.mts, which this is
// modelled on: the bot is a separate deploy whose build context does not
// include game/, so a `../../game/src/data/...` import works here (tsx, run by
// hand) but would break the Docker build. The committed JSON is what the bot
// actually builds against.
//
// ── WHY THE BOT NEEDS THIS AT ALL ───────────────────────────────────
// Exactly one field: `id`, the national dex number. Sprite URLs are keyed on
// the numeric id — jsDelivr 403s the named filenames — and the save blob
// carries only `speciesKey`. The game server cannot supply it either: it has
// no species table, deliberately (see the `pokemon` Prize variant in
// server/src/lib/giveaway.ts for why that is a feature, not an oversight).
//
// So the mapping has to live somewhere, and a generated snapshot is the least
// bad place: it is derived rather than hand-maintained, and re-running this
// after a species is added is a one-line chore that shows up as a diff.
//
// Items are here for the same reason — `spriteOverride` is the only way some
// item ids resolve to a PokeAPI slug — plus `name`, so cards can print
// "Master Ball" instead of "masterball".
//
// Run: cd bot && npm run snapshot
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pokemonTable } from "../../game/src/data/pokemon.ts";
import { itemsCatalog } from "../../game/src/data/itemsCatalog.ts";
import { moves as movesTable } from "../../game/src/data/moves.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "..", "src", "data");
mkdirSync(dataDir, { recursive: true });

// Narrower than the admin's snapshot on purpose. The admin builds Pokémon for
// prizes and needs base stats and growth rates to run the real stat formula;
// the bot only ever RENDERS what already exists, so it needs the sprite key,
// the display name and the types (for card colours) and nothing else. Shipping
// less means less to keep in sync.
const pokemon = Object.entries(pokemonTable)
  .map(([speciesKey, sp]) => ({
    speciesKey,
    name: sp.name,
    id: sp.id,
    types: sp.types,
  }))
  .sort((a, b) => a.id - b.id);

const items = Object.values(itemsCatalog)
  .map((it) => ({
    id: it.id,
    name: it.name,
    spriteOverride: it.spriteOverride,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Moves are id → display name and nothing else. A party card printing
// "dragonClaw" instead of "Dragon Claw" is the single most obvious way these
// cards read as machine output rather than as part of the game, and the id is
// all the save blob carries.
const moves = Object.entries(movesTable)
  .map(([id, m]) => ({ id, name: m.name, type: m.type }))
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(resolve(dataDir, "pokemon-snapshot.json"), JSON.stringify(pokemon, null, 2));
writeFileSync(resolve(dataDir, "items-snapshot.json"), JSON.stringify(items, null, 2));
writeFileSync(resolve(dataDir, "moves-snapshot.json"), JSON.stringify(moves, null, 2));
console.log(
  `Wrote ${pokemon.length} Pokémon, ${items.length} items and ${moves.length} moves into ${dataDir}.`,
);
