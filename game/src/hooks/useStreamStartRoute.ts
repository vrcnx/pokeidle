import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { useStreamConfig } from "../state/streamMode";

// Stream automation: on a stream-session boot, travel to the admin-configured
// start route exactly once, so a 24/7 OBS stream always resumes on the route
// the operator intends rather than wherever the save happened to leave off.
// No-op for normal sessions, when no start route is configured, or if that
// route isn't unlocked on the account yet.
export function useStreamStartRoute(): void {
  const { state, dispatch } = useGame();
  const cfg = useStreamConfig();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    const route = cfg?.startRoute;
    if (!route) return;
    // Wait for the save to actually load (a party mon present) so
    // unlockedLocations is populated before we decide anything.
    if (!state.playerPokemon) return;
    done.current = true; // one-shot regardless of the outcome below
    if (!state.unlockedLocations.includes(route)) return; // not unlocked — leave as-is
    if (state.currentLocation !== route) {
      dispatch({ type: "TRAVEL", payload: { locationId: route } });
    }
  }, [cfg, state.playerPokemon, state.unlockedLocations, state.currentLocation, dispatch]);
}
