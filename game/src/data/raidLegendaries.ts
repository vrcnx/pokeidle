import type { CatchSettings } from "../types";

// Raid configuration. Raids drop the player onto a special arena
// (currentLocation = "raidIsland"), spawning a randomly-picked
// legendary from the chosen tier. Clearing a wave — by defeating the
// legendary OR by catching it — summons the next at +5 levels until the
// player wipes, at which point a cooldown begins.
//
// Tiers gate which legendaries can spawn AND set the starting level.
// The player picks a tier when starting a raid; lower tiers are
// available from the start, higher tiers unlock as the player clears
// content (gym badges → Cover Legends, post-game → Mythical).

export const RAID_COOLDOWN_MS = 5 * 60 * 1000;
// Default starting level (used when no tier is supplied — keeps the
// previous behaviour for any callers that haven't been migrated).
export const RAID_START_LEVEL = 70;
// Mythical-tier raids only spawn at this level or higher; below that,
// Mythical-tier picks fall through to the Birds & Beasts pool.
export const MYTHICAL_MIN_LEVEL = 90;

export type RaidTierId =
  | "johtoNursery"
  | "birdsBeasts"
  | "titans"
  | "guardians"
  | "coverLegends"
  | "mythical";

export interface RaidTier {
  id: RaidTierId;
  name: string;          // Display name
  blurb: string;         // 1-line description for the tier picker card
  startLevel: number;    // Starting level when picked
  // Required to unlock — measured against game state. `gymsCleared`
  // is the simplest gate; finer locks (e.g. championDefeated) are
  // checked in the unlock predicate inline. Tiers with `unlockBadges = 0`
  // are available from the start.
  unlockBadges: number;
  unlockChampionDefeated?: boolean;
  // Per-species weights (higher = more common). Species missing from
  // the table get weight 1.
  pool: Record<string, number>;
  // Tag rendered on the species chips in the lineup.
  rarityTag?: "Mythical" | "Ultra Beast" | "Box Legend";
}

// ---------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------

const TIERS_LIST: RaidTier[] = [
  {
    // Not legendaries — the Johto species that had no obtainable source at
    // all. The babies (Pichu, Cleffa, Igglybuff, Togepi, Tyrogue, Smoochum,
    // Elekid, Magby) are breeding-only in the mainline games and there is no
    // breeding here, so a raid is their route in. Larvitar rides along as the
    // chase: a pseudo-legendary deserves to be hunted rather than found in
    // the grass. Everything they evolve into comes free through levelling.
    id: "johtoNursery",
    name: "Johto Nursery",
    // The blurb names what the babies become. Without it the pool reads as a
    // curiosity rather than the only route to Hitmontop, Togetic, Ampharos'
    // cousins and the rest — a player filed "Hitmontop is impossible to get"
    // while Tyrogue was sitting in this pool at weight 12 from badge zero.
    blurb: "Rare young Pokémon found nowhere in the wild — Tyrogue (→ Hitmonlee / Hitmonchan / Hitmontop), Togepi, Pichu, Cleffa, Igglybuff, Smoochum, Elekid, Magby — and the Larvitar line, if you're lucky.",
    startLevel: 15,
    unlockBadges: 0,
    pool: {
      pichu: 14, cleffa: 14, igglybuff: 14,
      togepi: 12, tyrogue: 12, smoochum: 11, elekid: 11, magby: 11,
      // Hitmontop is otherwise reachable ONLY through Tyrogue's
      // attack == defense branch, and that tie decays hard with level —
      // 11.5% at Lv20 down to 2.6% at Lv100, and a nature that splits
      // Atk/Def locks an individual out for good. That made one species
      // the single point of failure for the whole Pokedex (and the Shiny
      // Charm behind it), at roughly 1.3% per raid spawn with nothing
      // in-game telling you to evolve at exactly 20. It stays the
      // canonical way to get one; this is the floor so the dex is never
      // gated on a coin flip a player cannot see.
      hitmontop: 4,
      larvitar: 5,
    },
  },
  {
    id: "birdsBeasts",
    name: "Birds & Beasts",
    blurb: "Avian and quadrupedal legendaries. Mid-tier stats; the introductory raid pool.",
    startLevel: 65,
    unlockBadges: 0,
    pool: {
      // Kanto birds (existing)
      articuno: 12, zapdos: 12, moltres: 12,
      // Johto beasts + tower duo
      raikou: 10, entei: 10, suicune: 10,
      lugia: 6, hoOh: 6,
      // Eon duo
      latias: 6, latios: 6,
      // Forces of Nature
      tornadus: 5, thundurus: 5, landorus: 4,
    },
  },
  {
    id: "titans",
    name: "Titans",
    blurb: "Defensive walls and dormant golems. Heavy hitters with mountain-thick HP.",
    startLevel: 75,
    unlockBadges: 4,
    pool: {
      regirock: 10, regice: 10, registeel: 10,
      regigigas: 6,
      heatran: 8,
      uxie: 8, mesprit: 8, azelf: 8,
      cresselia: 7,
    },
  },
  {
    id: "guardians",
    name: "Guardians",
    blurb: "Swordsmen and elemental guardians from across Unova.",
    startLevel: 75,
    unlockBadges: 4,
    pool: {
      // Swords of Justice (Unova)
      cobalion: 12, terrakion: 12, virizion: 12, keldeo: 8,
      // Guardian-flavoured mythicals (Genesect / Meloetta)
      meloetta: 7, genesect: 7,
    },
  },
  {
    id: "coverLegends",
    name: "Cover Legends",
    blurb: "The cover stars of the classic mainline games. Top-tier base-stat totals.",
    startLevel: 80,
    unlockBadges: 8,
    pool: {
      mewtwo: 10,
      kyogre: 8, groudon: 8, rayquaza: 6,
      dialga: 8, palkia: 8, giratina: 6,
      reshiram: 8, zekrom: 8, kyurem: 6,
    },
    rarityTag: "Box Legend",
  },
  {
    id: "mythical",
    name: "Mythical",
    blurb: "Whispered-of Pokémon that only appear to the strongest trainers. Extremely rare.",
    startLevel: 90,
    unlockBadges: 8,
    unlockChampionDefeated: true,
    pool: {
      mew: 12, celebi: 12, jirachi: 12, deoxys: 10,
      manaphy: 10, phione: 8, darkrai: 10, shaymin: 10, arceus: 4,
      victini: 10,
    },
    rarityTag: "Mythical",
  },
];

// Indexed lookup. Keep the array form so the picker UI can render in a
// stable order; export both shapes.
export const raidTiers: Record<RaidTierId, RaidTier> = TIERS_LIST.reduce(
  (acc, t) => ((acc[t.id] = t), acc),
  {} as Record<RaidTierId, RaidTier>
);
export const raidTiersOrdered: RaidTier[] = TIERS_LIST;
export const DEFAULT_RAID_TIER: RaidTierId = "birdsBeasts";

// Backwards-compat: the original code referenced a flat `raidLegendaries`
// list. Keep that exported as the union of every tier's pool so anything
// reading it (Pokédex, dex modal, etc.) still sees the full set. Levels
// here are the tier's starting level; mythical flag matches the tier id.
export const raidLegendaries: { speciesKey: string; level: number; mythical?: boolean }[] =
  TIERS_LIST.flatMap((tier) =>
    Object.keys(tier.pool).map((speciesKey) => ({
      speciesKey,
      level: tier.startLevel,
      mythical: tier.id === "mythical",
    }))
  ).filter(
    // Dedup by speciesKey — tiers can overlap in fringe cases (none
    // currently, but future-proof).
    (entry, i, arr) => arr.findIndex((e) => e.speciesKey === entry.speciesKey) === i
  );

// Pick a random legendary from a given tier at the given level. Below
// the mythical-min level, mythical-tier picks fall through to the
// birds-and-beasts pool so the player isn't stuck if they request a
// tier they can't actually populate.
export function pickRandomLegendaryForTier(tierId: RaidTierId, level: number): string {
  const tier = raidTiers[tierId] ?? raidTiers[DEFAULT_RAID_TIER];
  if (tier.id === "mythical" && level < MYTHICAL_MIN_LEVEL) {
    return pickFromPool(raidTiers.birdsBeasts.pool);
  }
  return pickFromPool(tier.pool);
}

// Backwards-compat helper for the old level-based picker. The original
// behaviour: below MYTHICAL_MIN_LEVEL pick from a small bird pool,
// otherwise pick from all five Kanto legendaries. We map that onto
// the new tier system by routing through Birds & Beasts vs Cover.
export function pickRandomLegendary(level: number): string {
  if (level < MYTHICAL_MIN_LEVEL) {
    return pickFromPool({
      articuno: 30, zapdos: 30, moltres: 30,
    });
  }
  return pickFromPool({
    articuno: 30, zapdos: 30, moltres: 30,
    mewtwo: 5, mew: 5,
  });
}

function pickFromPool(pool: Record<string, number>): string {
  const entries = Object.entries(pool);
  if (entries.length === 0) return "articuno";
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

// Lock predicate — true if the player has unlocked the tier.
export function isTierUnlocked(
  tier: RaidTier,
  state: { defeatedGyms: string[]; championDefeated: boolean }
): boolean {
  if (state.defeatedGyms.length < tier.unlockBadges) return false;
  if (tier.unlockChampionDefeated && !state.championDefeated) return false;
  return true;
}

// Default is "always" — players reasonably expect the game to keep
// throwing balls at every wild encounter unless they explicitly opt
// into a stricter rule. The old default ("pokedex_new") silently
// stopped catching once a species was registered, which read as
// "the game won't throw a ball at this Magikarp" and generated
// repeat bug reports. "pokedex_new" is now opt-in via the catch
// settings modal.
export const DEFAULT_CATCH_SETTINGS: CatchSettings = {
  enabled: true,
  mode: "always",
  levelThreshold: 1,
  enabledBalls: ["pokeball"],
};

export const SAVE_KEY = "pokemon-idle-save";
