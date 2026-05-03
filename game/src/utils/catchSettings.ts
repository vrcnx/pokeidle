import type { CatchSettings, GameState } from "../types";

export function resolveCatchSettings(
  state: GameState,
  routeKey: string,
  speciesKey: string
): CatchSettings {
  return (
    state.catchSettings[routeKey]?.[speciesKey] ?? state.globalCatchDefaults
  );
}
