import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";

// When `autoProceed` is on, we follow new unlocks. Whenever the unlocked-
// locations set grows (via win progression), we wait for `idle` and then
// travel to the latest-unlocked route in `unlockOrder` order.
//
// Skips towns when there are routes available — towns are usually visited
// for shop/heal, not for grinding battles.
export function useAutoProceed(): void {
  const { state, dispatch } = useGame();
  const prevUnlockedRef = useRef<number>(state.unlockedLocations.length);

  useEffect(() => {
    if (!state.autoProceed) {
      prevUnlockedRef.current = state.unlockedLocations.length;
      return;
    }
    if (state.phase !== "idle") return;
    if (state.unlockedLocations.length <= prevUnlockedRef.current) {
      prevUnlockedRef.current = state.unlockedLocations.length;
      return;
    }
    // Find the newest-unlocked location with encounters or a gym, by
    // unlockOrder. Prefer routes (where the grinding happens).
    const candidates = state.unlockedLocations
      .map((id) => routes[id])
      .filter((r) => r && r.id !== state.currentLocation)
      .sort((a, b) => (b!.unlockOrder ?? 0) - (a!.unlockOrder ?? 0));
    const target =
      candidates.find((r) => r!.type === "route") ??
      candidates.find((r) => r!.type !== "raid") ??
      candidates[0];
    if (target) {
      dispatch({ type: "TRAVEL", payload: { locationId: target.id } });
    }
    prevUnlockedRef.current = state.unlockedLocations.length;
  }, [
    state.autoProceed,
    state.phase,
    state.unlockedLocations,
    state.currentLocation,
    dispatch,
  ]);
}
