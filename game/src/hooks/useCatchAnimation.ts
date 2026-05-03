import { useEffect } from "react";
import { useGame } from "../state/GameContext";

// Drives the catch animation timing. When `state.catchAnim` is set by
// TRY_CATCH, wait for the visual sequence (arc + 3 shakes) to play, then
// dispatch CATCH_RESOLVE to apply the pre-rolled result.
//
// Timing matches the CSS:
//   0–600ms  : ball arc (player → enemy)
//   600–800ms: enemy absorbed into ball
//   800–2300ms: 3 shakes (≈500ms each)
//   2300ms+  : reveal — RESOLVE fires here
const CATCH_ANIM_TOTAL_MS = 2300;

export function useCatchAnimation(): void {
  const { state, dispatch } = useGame();
  useEffect(() => {
    if (!state.catchAnim) return;
    const t = window.setTimeout(() => {
      dispatch({ type: "CATCH_RESOLVE" });
    }, CATCH_ANIM_TOTAL_MS);
    return () => clearTimeout(t);
  }, [state.catchAnim?.key, dispatch]);
}
