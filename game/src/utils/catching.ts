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
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  if (!settings.enabled || settings.enabledBalls.length === 0) return false;
  // Global "always catch shinies" override — wins over per-route mode so a
  // 1-in-8192 encounter never escapes because the route is configured for
  // level_threshold or shiny_only-but-disabled. The toggle is on by default.
  if (isShiny && state.alwaysCatchShinies) return true;
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
  speciesKey: string
): string | null {
  const settings = resolveCatchSettings(state, routeKey, speciesKey);
  return pickAutoBall(speciesKey, settings.enabledBalls, state.inventory);
}
