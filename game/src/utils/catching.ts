import { catchRates } from "../data/catchRates";
import { pokeballs } from "../data/pokeballs";
import { BALL_ORDER } from "./items";
import { resolveCatchSettings } from "./catchSettings";
import { ownsSpecies } from "./pokemon";
import type { GameState } from "../types";

export function speciesCatchRate(speciesKey: string): number {
  return catchRates[speciesKey] ?? 255;
}

// HP-dependent catch bonus. `hpFraction` is the target's currentHp/maxHp
// (1 = full). Canonical catch math weights LOW hp far higher, but applying
// it directly would NERF the long-standing full-HP odds every player is used
// to. So we treat full HP as the baseline (factor 1, unchanged) and only ADD
// a bonus as HP drops — pure upside, up to ~2.5x at a sliver of HP. This is
// what makes the opt-in "weaken before catching" setting actually pay off.
export function hpCatchFactor(hpFraction: number): number {
  const f = Math.max(0, Math.min(1, Number.isFinite(hpFraction) ? hpFraction : 1));
  return 1 + (1 - f) * 1.5; // 1.0 at full HP → 2.5 at ~0 HP
}

export function catchProbability(speciesKey: string, ballId: string, hpFraction = 1): number {
  const rate = speciesCatchRate(speciesKey);
  const ball = pokeballs[ballId];
  if (!ball) return 0;
  const base = (rate * ball.ballModifier) / 255;
  return Math.min(1, base * hpCatchFactor(hpFraction));
}

export function rollCatch(speciesKey: string, ballId: string, hpFraction = 1): boolean {
  return Math.random() < catchProbability(speciesKey, ballId, hpFraction);
}

// Cheapest enabled ball that has a guaranteed catch (rate * mod / 255 >= 1).
// Falls back to the highest enabled ball if no guarantee exists.
export function pickAutoBall(
  speciesKey: string,
  enabledBalls: string[],
  inventory: Record<string, number>
): string | null {
  const owned = BALL_ORDER.filter(
    (b) => enabledBalls.includes(b) && (inventory[b] ?? 0) > 0
  );
  if (owned.length === 0) return null;
  const rate = speciesCatchRate(speciesKey);
  for (const b of owned) {
    if ((rate * pokeballs[b].ballModifier) / 255 >= 1) return b;
  }
  return owned[owned.length - 1];
}

export function shouldAutoCatch(
  state: GameState,
  routeKey: string,
  speciesKey: string,
  level: number,
  isShiny: boolean
): boolean {
  // ULTIMATE override — a shiny encounter is 1/8192 (or 1/4096 with
  // Shiny Charm). Player report from global chat: "5 shinies today,
  // didn't throw a ball at any of them" — caused by the v1 ordering
  // of this function which short-circuited on
  // `!settings.enabled || settings.enabledBalls.length === 0` BEFORE
  // checking alwaysCatchShinies. A per-route disable or an empty
  // ball list silently ate every shiny. Now the shiny gate fires
  // first; ballForAutoCatch will fall back to ANY owned ball.
  if (isShiny && state.alwaysCatchShinies) return true;
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  if (!settings.enabled || settings.enabledBalls.length === 0) return false;
  switch (settings.mode) {
    case "always":          return true;
    case "shiny_only":      return isShiny;
    case "level_threshold": return level >= settings.levelThreshold;
    // "Not registered". `pokedexCaught` is append-only — releasing, trading
    // away or evolving a species never un-registers it — so this stops for
    // good once the entry exists. Unchanged from the day it shipped; the split
    // below is what gives players the other reading they kept asking for.
    case "pokedex_new":     return !state.pokedexCaught.includes(speciesKey);
    // "Not owned". Asks what the player is HOLDING, which is a different
    // question and the one that lets a released / traded / evolved-away
    // species come back into scope. ownsSpecies short-circuits on the first
    // match instead of building a set of every species in a 9,999-slot PC —
    // this runs on every single wild encounter.
    case "not_owned":       return !ownsSpecies(state.party, state.box, speciesKey);
    default:                return true;
  }
}

export function ballForAutoCatch(
  state: GameState,
  routeKey: string,
  speciesKey: string,
  isShiny = false,
): string | null {
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  // Shiny override extends to ball selection: if the user has
  // alwaysCatchShinies on and we're picking a ball for a shiny, fall
  // back to ANY owned ball when the configured enabledBalls list is
  // empty or out of stock. Better to use the wrong ball than to let
  // the encounter walk away.
  if (isShiny && state.alwaysCatchShinies) {
    const fromEnabled = pickAutoBall(speciesKey, settings.enabledBalls, state.inventory);
    if (fromEnabled) return fromEnabled;
    const anyOwned = BALL_ORDER.find((b) => (state.inventory[b] ?? 0) > 0);
    if (anyOwned) return anyOwned;
    return null;
  }
  return pickAutoBall(speciesKey, settings.enabledBalls, state.inventory);
}
