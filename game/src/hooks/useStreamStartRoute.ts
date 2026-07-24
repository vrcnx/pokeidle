import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { useStreamConfig } from "../state/streamMode";

// Stream automation applied ONCE on a stream-session boot, so a 24/7 OBS
// account self-plays the way the operator configured it:
//   * startRoute   — travel there (if unlocked) instead of resuming where saved
//   * autoProceed  — auto-travel to newly-unlocked routes (keeps advancing)
//   * autoCatch    — auto-throw balls at wild encounters
//   * speed        — battle speed 1..5
// No-op for normal sessions or when nothing is configured. Auto-buy balls is
// handled live in the battle loop; remote commands (fight E4, raid, …) come in
// over the stream:command socket event.
export function useStreamStartRoute(): void {
  const { state, dispatch } = useGame();
  const cfg = useStreamConfig();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    if (!cfg) return;
    // Wait for the save to load (a party mon present) so unlockedLocations and
    // the toggle states are real before we act.
    if (!state.playerPokemon) return;
    done.current = true; // one-shot regardless of outcome

    if (cfg.startRoute && state.unlockedLocations.includes(cfg.startRoute) && state.currentLocation !== cfg.startRoute) {
      dispatch({ type: "TRAVEL", payload: { locationId: cfg.startRoute } });
    }
    if (typeof cfg.autoProceed === "boolean" && state.autoProceed !== cfg.autoProceed) {
      dispatch({ type: "TOGGLE_AUTO_PROCEED" });
    }
    if (typeof cfg.autoCatch === "boolean" && state.autoCatch !== cfg.autoCatch) {
      dispatch({ type: "TOGGLE_AUTO_CATCH" });
    }
    if (typeof cfg.speed === "number") {
      const s = Math.max(1, Math.min(5, Math.floor(cfg.speed)));
      if (state.speed !== s) dispatch({ type: "SET_SPEED", payload: { speed: s } });
    }
  }, [cfg, state.playerPokemon, state.unlockedLocations, state.currentLocation, state.autoProceed, state.autoCatch, state.speed, dispatch]);
}
