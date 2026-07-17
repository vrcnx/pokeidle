import type { GameState } from "../types";
import { pokemonTable } from "../data/pokemon";
import { expForLevel } from "./stats";

// Offline training. An idle game should idle: while the player is away their
// team keeps auto-battling on their current route, so they come back to some
// progress rather than a frozen save. We model that as EXP for the lead
// Pokémon — wild wins give EXP (and catches), not money, so offline is
// EXP-only, which keeps the economy honest and can't be farmed for currency.

// Ignore short gaps — no "welcome back" for a 90-second tab switch.
const MIN_OFFLINE_MS = 5 * 60_000;
// Cap credited time. Standard idle-game ceiling: being away 3 days pays the
// same as being away 8 hours, so there's no reason to hoard offline time.
export const MAX_OFFLINE_MS = 8 * 60 * 60_000;
// Conservative average seconds per wild battle (online at max speed is far
// faster; we deliberately under-count so offline never out-earns playing).
const SECONDS_PER_BATTLE = 6;
// Offline earns a fraction of the naive estimate, so active play is always
// the better way to progress.
const OFFLINE_RATE = 0.5;
// Hard cap on how many levels a single absence can grant, so a long gap
// can't rocket a low-level lead up the curve.
const MAX_OFFLINE_LEVELS = 15;
// Representative wild base-exp yield. Kanto's early/mid species cluster
// around here; expYield = baseExpYield * level / 7, and route wild levels
// track the player's lead, so exp/battle ≈ REP_BASE_YIELD * leadLevel / 7.
const REP_BASE_YIELD = 63;

export interface OfflineComputation {
  awayMs: number;
  creditedMs: number;
  battles: number;
  exp: number;
  fromLevel: number;
}

// Pure. Returns null when there's nothing worth awarding (too short, no
// lead, lead already at cap). elapsedMs is real wall-clock time away.
export function computeOfflineProgress(state: GameState, elapsedMs: number): OfflineComputation | null {
  const lead = state.playerPokemon;
  if (!lead) return null;
  if (elapsedMs < MIN_OFFLINE_MS) return null;
  if (lead.level >= 100) return null;

  const creditedMs = Math.min(elapsedMs, MAX_OFFLINE_MS);
  const battles = Math.floor(creditedMs / 1000 / SECONDS_PER_BATTLE);
  if (battles < 1) return null;

  const expPerBattle = Math.max(1, Math.round((REP_BASE_YIELD * lead.level) / 7));
  let exp = Math.floor(battles * expPerBattle * OFFLINE_RATE);

  // Clamp to at most MAX_OFFLINE_LEVELS levels of growth (and never past
  // the L100 baseline), measured on the lead's real growth curve.
  const species = pokemonTable[lead.speciesKey];
  if (species) {
    const ceilingLevel = Math.min(100, lead.level + MAX_OFFLINE_LEVELS);
    const headroom = Math.max(0, expForLevel(ceilingLevel, species.growthRate) - lead.totalExp);
    exp = Math.min(exp, headroom);
  }
  if (exp < 1) return null;

  return { awayMs: elapsedMs, creditedMs, battles, exp, fromLevel: lead.level };
}
