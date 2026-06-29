import { catchRates } from "../data/catchRates";
import { pokeballs } from "../data/pokeballs";
import { BALL_ORDER } from "./items";
import { resolveCatchSettings } from "./catchSettings";
import type { GameState } from "../types";

export function speciesCatchRate(speciesKey: string): number {
  return catchRates[speciesKey] ?? 255;
}

export function catchProbability(speciesKey: string, ballId: string): number {
  const rate = speciesCatchRate(speciesKey);
  const ball = pokeballs[ballId];
  if (!ball) return 0;
  return Math.min(1, (rate * ball.ballModifier) / 255);
}

export function rollCatch(speciesKey: string, ballId: string): boolean {
  return Math.random() < catchProbability(speciesKey, ballId);
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
    case "pokedex_new":     return !state.pokedexCaught.includes(speciesKey);
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
