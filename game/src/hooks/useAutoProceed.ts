import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { routes } from "../data/routes";

// When `autoProceed` is on, we follow new unlocks. Whenever the unlocked-
// locations set grows (via win progression), we wait for `idle` and then
// travel to the newest-unlocked location by `unlockOrder` — the actual
// progression frontier, whether that's a route (grind wild battles) or a
// town (fight the gym / town trainers, which is what unlocks the NEXT
// route). Raid islands are the only type skipped; they have their own
// entry flow.
//
// The previous version preferred routes unconditionally, so when the
// newest unlock was a TOWN (and no new route had opened yet) it fell
// through to the newest OTHER route — and since the current route is
// excluded, that "other" route was the PREVIOUS one. The result was
// auto-proceed walking the player backwards every time they reached a
// town (reported by a player: "right before towns it goes to the previous
// route instead of the town").
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
    // Newest-unlocked location by unlockOrder = the frontier. Take it
    // directly (route OR town); only raid islands are skipped. Sorting
    // descending means candidates[0] after the raid filter is the newest.
    const candidates = state.unlockedLocations
      .map((id) => routes[id])
      .filter((r) => r && r.id !== state.currentLocation && r.type !== "raid")
      .sort((a, b) => (b!.unlockOrder ?? 0) - (a!.unlockOrder ?? 0));
    const target = candidates[0];
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
