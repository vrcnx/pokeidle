import type { GameState } from "../types";
import { caughtObtainableCount, isDexComplete, obtainableCount } from "../utils/obtainable";
import { hasShinyCharm } from "../utils/shinyCharm";

// Achievement definitions. Each one is a pure predicate over GameState
// (and optionally PvP rating) so we can compute "unlocked yet?" on every
// render without touching the reducer or polluting persistent save data.
// New unlocks are detected by diffing against localStorage-cached IDs.
//
// Tiering: bronze < silver < gold < platinum < diamond. Used for the
// trophy gallery sorting + the unlock-toast accent colour.

export type AchievementTier = "bronze" | "silver" | "gold" | "platinum" | "diamond";
export type AchievementCategory =
  | "catches" | "battles" | "pvp" | "trading"
  | "economy" | "exploration" | "collection" | "story";

export interface Achievement {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  tier: AchievementTier;
  icon: string;        // emoji or single glyph
  isUnlocked: (s: GameState, extras: AchievementExtras) => boolean;
  // Optional progress fn for UIs that show partial progress. Returns
  // [current, target] — only used when isUnlocked returns false.
  progress?: (s: GameState, extras: AchievementExtras) => [number, number];
}

export interface AchievementExtras {
  pvpRating?: number;     // current PvP ELO if known
  pvpWins?: number;
  pvpLosses?: number;
  tradeCount?: number;
}

// "Complete the Pokédex" is derived from the data (utils/obtainable), not a
// hardcoded total. The old TOTAL_DEX = 245 sat 43 species below the Dex tab's
// own denominator, so this trophy fired well before the completion ring
// reached 100% — and disagreed with the Shiny Charm it was supposed to mirror.

export const ACHIEVEMENTS: Achievement[] = [
  // ── Catches ─────────────────────────────────────────────────────
  { id: "first-catch",    name: "Your First Friend",   description: "Catch your first Pokémon.",            category: "catches", tier: "bronze",   icon: "🎯", isUnlocked: (s) => s.pokedexCaught.length >= 1 },
  { id: "ten-caught",     name: "Squad Builder",        description: "Catch 10 unique species.",             category: "catches", tier: "bronze",   icon: "🧩", isUnlocked: (s) => s.pokedexCaught.length >= 10, progress: (s) => [s.pokedexCaught.length, 10] },
  { id: "twentyfive-cap", name: "Roster Roller",        description: "Catch 25 unique species.",             category: "catches", tier: "silver",   icon: "📘", isUnlocked: (s) => s.pokedexCaught.length >= 25, progress: (s) => [s.pokedexCaught.length, 25] },
  { id: "fifty-caught",   name: "Halfway to Half",      description: "Catch 50 unique species.",             category: "catches", tier: "silver",   icon: "📚", isUnlocked: (s) => s.pokedexCaught.length >= 50, progress: (s) => [s.pokedexCaught.length, 50] },
  { id: "hundred-caught", name: "Centurion",            description: "Catch 100 unique species.",            category: "catches", tier: "gold",     icon: "💯", isUnlocked: (s) => s.pokedexCaught.length >= 100, progress: (s) => [s.pokedexCaught.length, 100] },
  // `hasShinyCharm` is an OR here, not decoration: raising the bar from 245 to
  // full completion must not confiscate a trophy someone already displays.
  // Holding the charm is proof they met the rule that was live when they
  // earned it (saves at or above the old threshold are granted it on load).
  { id: "full-dex",       name: "Gotta Catch 'Em All",  description: "Complete the Pokédex — catch every obtainable species.", category: "catches", tier: "diamond", icon: "🏆", isUnlocked: (s) => hasShinyCharm(s) || isDexComplete(s.pokedexCaught), progress: (s) => [caughtObtainableCount(s.pokedexCaught), obtainableCount()] },
  { id: "first-shiny",    name: "Shiny Hunter",         description: "Catch your first shiny.",               category: "catches", tier: "silver",   icon: "✨", isUnlocked: (s) => s.shinyCaught.length >= 1 },
  { id: "five-shinies",   name: "Shimmer Squad",        description: "Catch 5 shinies.",                      category: "catches", tier: "gold",     icon: "🌟", isUnlocked: (s) => s.shinyCaught.length >= 5, progress: (s) => [s.shinyCaught.length, 5] },
  { id: "twenty-shinies", name: "Sparkleologist",       description: "Catch 20 shinies.",                     category: "catches", tier: "platinum", icon: "💎", isUnlocked: (s) => s.shinyCaught.length >= 20, progress: (s) => [s.shinyCaught.length, 20] },

  // ── Battles ─────────────────────────────────────────────────────
  { id: "first-win",      name: "First Blood",          description: "Win your first wild battle.",          category: "battles", tier: "bronze", icon: "⚔️", isUnlocked: (s) => s.wildBattlesWon >= 1 },
  { id: "fifty-wild",     name: "Veteran",              description: "Win 50 wild battles.",                 category: "battles", tier: "silver", icon: "🛡️", isUnlocked: (s) => s.wildBattlesWon >= 50, progress: (s) => [s.wildBattlesWon, 50] },
  { id: "five-hundred-wild",name: "Battle Hardened",    description: "Win 500 wild battles.",                category: "battles", tier: "gold",   icon: "🗡️", isUnlocked: (s) => s.wildBattlesWon >= 500, progress: (s) => [s.wildBattlesWon, 500] },
  { id: "trainer-win",    name: "Trainer Slayer",       description: "Beat your first trainer.",             category: "battles", tier: "bronze", icon: "🥊", isUnlocked: (s) => s.trainerBattlesWon >= 1 },
  { id: "trainer-50",     name: "Rival Crusher",        description: "Beat 50 trainers.",                    category: "battles", tier: "silver", icon: "💪", isUnlocked: (s) => s.trainerBattlesWon >= 50, progress: (s) => [s.trainerBattlesWon, 50] },

  // ── Story ───────────────────────────────────────────────────────
  { id: "first-badge",    name: "First Badge",          description: "Earn your first gym badge.",           category: "story", tier: "bronze",   icon: "🥉", isUnlocked: (s) => s.defeatedGyms.length >= 1, progress: (s) => [s.defeatedGyms.length, 1] },
  { id: "four-badges",    name: "Halfway Hero",         description: "Earn 4 gym badges.",                   category: "story", tier: "silver",   icon: "🥈", isUnlocked: (s) => s.defeatedGyms.length >= 4, progress: (s) => [s.defeatedGyms.length, 4] },
  { id: "eight-badges",   name: "Badge Master",         description: "Earn all 8 gym badges.",               category: "story", tier: "gold",     icon: "🥇", isUnlocked: (s) => s.defeatedGyms.length >= 8, progress: (s) => [s.defeatedGyms.length, 8] },
  { id: "elite-four",     name: "Elite Conqueror",      description: "Defeat all four Elite Four members.",  category: "story", tier: "platinum", icon: "👑", isUnlocked: (s) => s.defeatedEliteFour.length >= 4, progress: (s) => [s.defeatedEliteFour.length, 4] },
  { id: "champion",       name: "Champion",             description: "Defeat the Champion.",                 category: "story", tier: "diamond",  icon: "🏆", isUnlocked: (s) => !!s.championDefeated },

  // ── PvP ─────────────────────────────────────────────────────────
  { id: "pvp-first-match", name: "Stepping Into the Ring", description: "Play your first PvP match.",       category: "pvp", tier: "bronze",   icon: "⚔️", isUnlocked: (_s, e) => (e.pvpWins ?? 0) + (e.pvpLosses ?? 0) >= 1 },
  { id: "pvp-ten-wins",   name: "Ten Trophies",         description: "Win 10 PvP matches.",                 category: "pvp", tier: "silver",   icon: "🏅", isUnlocked: (_s, e) => (e.pvpWins ?? 0) >= 10, progress: (_s, e) => [e.pvpWins ?? 0, 10] },
  { id: "pvp-silver-tier",name: "Silver Tier",          description: "Reach 1100 PvP rating (Silver).",     category: "pvp", tier: "silver",   icon: "🥈", isUnlocked: (_s, e) => (e.pvpRating ?? 0) >= 1100 },
  { id: "pvp-gold-tier",  name: "Gold Tier",            description: "Reach 1300 PvP rating (Gold).",       category: "pvp", tier: "gold",     icon: "🥇", isUnlocked: (_s, e) => (e.pvpRating ?? 0) >= 1300 },
  { id: "pvp-plat-tier",  name: "Platinum Tier",        description: "Reach 1500 PvP rating (Platinum).",   category: "pvp", tier: "platinum", icon: "💠", isUnlocked: (_s, e) => (e.pvpRating ?? 0) >= 1500 },
  { id: "pvp-diamond-tier",name:"Diamond Tier",         description: "Reach 1700 PvP rating (Diamond).",    category: "pvp", tier: "diamond",  icon: "💎", isUnlocked: (_s, e) => (e.pvpRating ?? 0) >= 1700 },

  // ── Trading ─────────────────────────────────────────────────────
  { id: "first-trade",    name: "Handshake",            description: "Complete your first trade.",           category: "trading", tier: "bronze", icon: "🤝", isUnlocked: (_s, e) => (e.tradeCount ?? 0) >= 1 },
  { id: "ten-trades",     name: "Trade Network",        description: "Complete 10 trades.",                  category: "trading", tier: "silver", icon: "🔁", isUnlocked: (_s, e) => (e.tradeCount ?? 0) >= 10, progress: (_s, e) => [e.tradeCount ?? 0, 10] },

  // ── Economy ─────────────────────────────────────────────────────
  { id: "money-1k",       name: "Pocket Change",        description: "Hold $1,000 at once.",                 category: "economy", tier: "bronze", icon: "💰", isUnlocked: (s) => s.money >= 1000 },
  { id: "money-100k",     name: "Big Spender",          description: "Hold $100,000 at once.",               category: "economy", tier: "gold",   icon: "💸", isUnlocked: (s) => s.money >= 100000, progress: (s) => [s.money, 100000] },

  // ── Exploration ─────────────────────────────────────────────────
  { id: "five-locations", name: "Wanderer",             description: "Visit 5 different locations.",         category: "exploration", tier: "bronze", icon: "🗺️", isUnlocked: (s) => s.unlockedLocations.length >= 5, progress: (s) => [s.unlockedLocations.length, 5] },
  { id: "all-locations",  name: "Trailblazer",          description: "Unlock every location.",               category: "exploration", tier: "platinum", icon: "🧭", isUnlocked: (s) => {
    // Conservative target — 48 Kanto + 44 Johto locations including routes.
    // Treat 92 as the "trailblazer" threshold.
    return s.unlockedLocations.length >= 92;
  }, progress: (s) => [s.unlockedLocations.length, 92] },

  // ── Collection ──────────────────────────────────────────────────
  { id: "boxed-100",      name: "Storage Wars",         description: "Store 100 Pokémon in your PC.",        category: "collection", tier: "silver", icon: "📦", isUnlocked: (s) => s.box.length >= 100, progress: (s) => [s.box.length, 100] },
  { id: "champion-mon",   name: "Champion Mon",         description: "Train a single Pokémon to Lv 100.",    category: "collection", tier: "gold",   icon: "💯", isUnlocked: (s) => s.party.concat(s.box).some((p) => p.level >= 100) },
];

// Convenience lookups
export const ACHIEVEMENTS_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export const ACHIEVEMENTS_BY_CATEGORY: Record<AchievementCategory, Achievement[]> =
  ACHIEVEMENTS.reduce((acc, a) => {
    (acc[a.category] ||= []).push(a);
    return acc;
  }, {} as Record<AchievementCategory, Achievement[]>);

export function tierOrder(t: AchievementTier): number {
  return ({ bronze: 0, silver: 1, gold: 2, platinum: 3, diamond: 4 })[t];
}

export const CATEGORY_LABEL: Record<AchievementCategory, string> = {
  catches:     "Catches",
  battles:     "Battles",
  pvp:         "PvP",
  trading:     "Trading",
  economy:     "Economy",
  exploration: "Exploration",
  collection:  "Collection",
  story:       "Story",
};

export const TIER_COLOR: Record<AchievementTier, string> = {
  bronze:   "#b07a48",
  silver:   "#cfd2d8",
  gold:     "#fbbf24",
  platinum: "#7fd1c4",
  diamond:  "#a78bff",
};
