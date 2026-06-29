// Derive the player's account-level metrics from a serialized save blob.
// Account level = floor(sum of every-caught-Pokemon level / 10), clamped
// at a sane ceiling. Counts party + box (so released Pokémon don't count;
// the player keeps levels they actually retained).
//
// Caps applied here are leaderboard-defence: even if a save passed
// validation, we don't let derived public metrics exceed reasonable
// bounds. The Kanto dex is 151 species, party+box has hard size limits,
// and account level is capped well above what any honest player will
// hit through normal play.

const MAX_PARTY = 6;
// MUST match saveValidation.ts MAX_BOX. Out of sync the computeAccountLevel
// silently truncates: veteran players' totalCaughtLevels capped at
// (MAX_PARTY + 600) * 100 = 60_600 (and in practice at the sum of the
// first 606 mons' levels, which stalls at whatever number the cap
// happened to land on — DrWhy was "stuck at 5838" because of exactly
// this).
const MAX_BOX = 9999;
const MAX_LEVEL = 100;
const MAX_TOTAL_DEX = 151; // Kanto only (extend with later regions)
const MAX_TOTAL_CAUGHT_LEVELS = (MAX_PARTY + MAX_BOX) * MAX_LEVEL;
const MAX_ACCOUNT_LEVEL = Math.floor(MAX_TOTAL_CAUGHT_LEVELS / 10);

interface PokemonLike {
  level?: number;
}

export interface DerivedLevel {
  accountLevel: number;
  totalCaughtLevels: number;
  pokedexCaughtCount: number;
}

export function computeAccountLevel(save: Record<string, unknown>): DerivedLevel {
  const party = (save.party as PokemonLike[] | undefined) ?? [];
  const box = (save.box as PokemonLike[] | undefined) ?? [];
  const all = [...party, ...box].slice(0, MAX_PARTY + MAX_BOX);
  const totalRaw = all.reduce(
    (sum, p) => sum + Math.min(MAX_LEVEL, Math.max(0, p.level ?? 0)),
    0
  );
  const totalCaughtLevels = Math.min(MAX_TOTAL_CAUGHT_LEVELS, totalRaw);
  const accountLevel = Math.min(MAX_ACCOUNT_LEVEL, Math.floor(totalCaughtLevels / 10));
  const pokedexCaught = (save.pokedexCaught as string[] | undefined) ?? [];
  // Dedup + cap; the actual species whitelist is enforced at validation
  // time, but the cap also defends if a future region rolls out and the
  // legacy dex count gets stale.
  const dedupSize = new Set(pokedexCaught.filter((s) => typeof s === "string")).size;
  const pokedexCaughtCount = Math.min(MAX_TOTAL_DEX, dedupSize);
  return {
    accountLevel,
    totalCaughtLevels,
    pokedexCaughtCount,
  };
}
