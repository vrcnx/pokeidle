// Self-contained admin catalog — JSON snapshots of the game's Pokémon
// table and items catalog, plus inlined sprite-URL helpers and a
// minimal createPokemon factory. The admin used to import these
// directly from `@game/*` paths via Vite's `server.fs.allow`, but
// that broke deploy contexts that build admin/ standalone (they
// don't see ../game/). Snapshotting keeps the admin self-sufficient.
//
// To refresh after the game changes its catalogs, run from admin/:
//
//   npx tsx scripts/snapshot.mts
//
// then commit the regenerated JSON.

import pokemonRaw from "./pokemon-snapshot.json";
import itemsRaw from "./items-snapshot.json";

export type Stats = { hp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number };
export type IVs = Stats;
type GrowthRate = "fast" | "mediumFast" | "mediumSlow" | "slow" | "erratic" | "fluctuating";

export interface PokemonEntry {
  speciesKey: string;
  name: string;
  id: number;
  types: string[];
  baseStats: Stats;
  growthRate: GrowthRate;
}

export interface ItemEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  spriteOverride?: string;
}

export const POKEMON_LIST: PokemonEntry[] = pokemonRaw as PokemonEntry[];
export const ITEM_LIST: ItemEntry[] = itemsRaw as ItemEntry[];

// Fast lookup for slug → entry. Built once at module load.
const _pokemonBySlug = new Map<string, PokemonEntry>(POKEMON_LIST.map((p) => [p.speciesKey, p]));

// ─── Sprite URL builders ─────────────────────────────────────────────
// jsDelivr-proxied PokeAPI sprite repo. Numeric-id filenames only;
// named filenames hit a 403 from their CDN.
const PKMN_BASE =
  "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-v/black-white/animated";
const PKMN_STATIC_BASE =
  "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon";
const ITEM_BASE =
  "https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/items";

export function pokemonSpriteUrl(speciesKey: string, isBack = false, isShiny = false): string {
  const entry = _pokemonBySlug.get(speciesKey);
  if (!entry) return "";
  const folder =
    isBack && isShiny ? "back/shiny" :
    isShiny           ? "shiny" :
    isBack            ? "back" :
                        "";
  return folder
    ? `${PKMN_BASE}/${folder}/${entry.id}.gif`
    : `${PKMN_BASE}/${entry.id}.gif`;
}

export function pokemonStaticSpriteUrl(idOrKey: number | string): string {
  const id = typeof idOrKey === "number"
    ? idOrKey
    : (_pokemonBySlug.get(idOrKey)?.id ?? null);
  if (id == null) return "";
  return `${PKMN_STATIC_BASE}/${id}.png`;
}

// Item id → kebab-case slug. Mirrors the game's mapping table —
// our internal ids are camelCase / lowercase but PokeAPI uses
// kebab-case, so the most common ones need explicit overrides.
const ITEM_ID_OVERRIDES: Record<string, string> = {
  pokeball: "poke-ball", greatball: "great-ball", ultraball: "ultra-ball", masterball: "master-ball",
  superpotion: "super-potion", hyperpotion: "hyper-potion", maxpotion: "max-potion",
  fullrestore: "full-restore", maxrevive: "max-revive", fullheal: "full-heal",
  paralyzeheal: "paralyze-heal", burnheal: "burn-heal", iceheal: "ice-heal",
  maxether: "max-ether", maxelixir: "max-elixir", rarecandy: "rare-candy",
  superrepel: "super-repel", maxrepel: "max-repel",
  firestone: "fire-stone", waterstone: "water-stone", thunderstone: "thunder-stone",
  leafstone: "leaf-stone", moonstone: "moon-stone", sunstone: "sun-stone",
  shinycharm: "shiny-charm", luckyegg: "lucky-egg", amuletcoin: "amulet-coin", expshare: "exp-share",
};

export function itemSpriteUrl(itemId: string, slugOverride?: string): string {
  const slug =
    slugOverride ??
    ITEM_ID_OVERRIDES[itemId] ??
    itemId.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `${ITEM_BASE}/${slug}.png`;
}

// ─── Minimal createPokemon ───────────────────────────────────────────
// Builds a fresh Pokémon for the admin "give Pokémon" flow with
// correctly derived stats / max HP / totalExp at the chosen level.
// IVs are perfect (admins are gifting; perfect is the obvious default);
// nature is Hardy (neutral); moves are empty (the game's reducer fills
// in defaults on next save load). We DO NOT carry the game's full
// movepool / ability data here — the snapshot is intentionally lean.

interface CreatedPokemon {
  id: string;
  speciesKey: string;
  name: string;
  nature: string;
  level: number;
  totalExp: number;
  moves: { id: string; pp: number; maxPp: number }[];
  currentHp: number;
  maxHp: number;
  attack: number;
  defense: number;
  spAttack: number;
  spDefense: number;
  speed: number;
  ivs: IVs;
  evs: Stats;
  isShiny: boolean;
}

export function createPokemon(
  speciesKey: string,
  level: number,
  nextId: number,
  isShiny = false,
): CreatedPokemon {
  const sp = _pokemonBySlug.get(speciesKey);
  if (!sp) throw new Error(`unknown species: ${speciesKey}`);
  const ivs: IVs = { hp: 31, attack: 31, defense: 31, spAttack: 31, spDefense: 31, speed: 31 };
  const evs: Stats = { hp: 0, attack: 0, defense: 0, spAttack: 0, spDefense: 0, speed: 0 };
  const stats = calcAllStats(sp.baseStats, level, ivs, evs);
  return {
    id: String(nextId),
    speciesKey,
    name: sp.name,
    nature: "Hardy",
    level,
    totalExp: expForLevel(level, sp.growthRate),
    moves: [],
    currentHp: stats.hp,
    maxHp: stats.hp,
    attack: stats.attack,
    defense: stats.defense,
    spAttack: stats.spAttack,
    spDefense: stats.spDefense,
    speed: stats.speed,
    ivs,
    evs,
    isShiny,
  };
}

// Re-derive a mon's stats + exp baseline for a new level, preserving
// its existing IVs/EVs.
//
// The save editor previously patched ONLY `level` when an operator
// changed it, on the documented assumption that "stats re-derive from
// the species catalog on the user's next save load". That is false:
// the game's normalizePokemon only raises totalExp to the level
// baseline and backfills missing ivs/evs/nature — it never recomputes
// stats. validateSave only bounds-checks, so a Lv100 mon carrying Lv5
// stats passes cleanly. The net effect: compensating a player handed
// them a Lv50 Charizard with ~20 HP that lost every battle, which then
// read to them as a fresh bug. Stats must be derived HERE, at the edit.
//
// Returns null for an unknown species so the caller can leave the mon
// untouched rather than writing garbage.
export function deriveStatsForLevel(
  speciesKey: string,
  level: number,
  ivs?: Partial<IVs>,
  evs?: Partial<Stats>,
): { totalExp: number; maxHp: number; attack: number; defense: number; spAttack: number; spDefense: number; speed: number } | null {
  const sp = _pokemonBySlug.get(speciesKey);
  if (!sp) return null;
  const fullIvs: IVs = {
    hp: ivs?.hp ?? 31, attack: ivs?.attack ?? 31, defense: ivs?.defense ?? 31,
    spAttack: ivs?.spAttack ?? 31, spDefense: ivs?.spDefense ?? 31, speed: ivs?.speed ?? 31,
  };
  const fullEvs: Stats = {
    hp: evs?.hp ?? 0, attack: evs?.attack ?? 0, defense: evs?.defense ?? 0,
    spAttack: evs?.spAttack ?? 0, spDefense: evs?.spDefense ?? 0, speed: evs?.speed ?? 0,
  };
  const s = calcAllStats(sp.baseStats, level, fullIvs, fullEvs);
  return {
    totalExp: expForLevel(level, sp.growthRate),
    maxHp: s.hp,
    attack: s.attack,
    defense: s.defense,
    spAttack: s.spAttack,
    spDefense: s.spDefense,
    speed: s.speed,
  };
}

// Gen-3+ stat formula (HP has a +level+10 bias; non-HP add +5 then
// nature-multiply). Hardy is neutral so multiplier is always 1.
function calcAllStats(base: Stats, level: number, ivs: IVs, evs: Stats): Stats {
  return {
    hp:
      Math.floor(((2 * base.hp + ivs.hp + Math.floor(evs.hp / 4)) * level) / 100) +
      level + 10,
    attack:    statNonHp(base.attack,    level, ivs.attack,    evs.attack),
    defense:   statNonHp(base.defense,   level, ivs.defense,   evs.defense),
    spAttack:  statNonHp(base.spAttack,  level, ivs.spAttack,  evs.spAttack),
    spDefense: statNonHp(base.spDefense, level, ivs.spDefense, evs.spDefense),
    speed:     statNonHp(base.speed,     level, ivs.speed,     evs.speed),
  };
}
function statNonHp(base: number, level: number, iv: number, ev: number): number {
  return Math.floor(
    Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5,
  );
}

// Total EXP required to reach a given level. Standard piecewise
// formulas (Bulbapedia). The erratic / fluctuating curves are
// reproduced verbatim so legendary-line mons get the right
// progression bar in-game.
function expForLevel(level: number, growthRate: GrowthRate): number {
  if (level <= 1) return 0;
  const n = level;
  const cube = n * n * n;
  switch (growthRate) {
    case "fast":       return Math.floor((4 * cube) / 5);
    case "mediumFast": return cube;
    case "mediumSlow": return Math.max(0, Math.floor((6 * cube) / 5 - 15 * n * n + 100 * n - 140));
    case "slow":       return Math.floor((5 * cube) / 4);
    case "erratic":
      if (n <= 50)  return Math.floor((cube * (100 - n)) / 50);
      if (n <= 68)  return Math.floor((cube * (150 - n)) / 100);
      if (n <= 98)  return Math.floor((cube * Math.floor((1911 - 10 * n) / 3)) / 500);
      return Math.floor((cube * (160 - n)) / 100);
    case "fluctuating":
      if (n <= 15) return Math.floor((cube * (Math.floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return Math.floor((cube * (n + 14)) / 50);
      return Math.floor((cube * (Math.floor(n / 2) + 32)) / 50);
    default: return cube;
  }
}
