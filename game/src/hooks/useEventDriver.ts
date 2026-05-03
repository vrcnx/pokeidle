import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";

// Drains state.pendingEvents one at a time, with timing that matches the
// typewriter status bar. Speed multiplier scales the delay.
//   ×1: 30 ms/char + 200ms tail
//   ×2: 16 ms/char + 120ms tail
//   ×5: 7 ms/char + 60ms tail
// Damage events get an extra HP-bar settle delay; faint events wait for
// the fade-out animation. Other events (attack/miss/etc.) only wait for
// the typewriter.
export function useEventDriver(): void {
  const { state, dispatch } = useGame();
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.paused) return;
    if (state.pendingEvents.length === 0) return;

    const event = state.pendingEvents[0];
    const speed = state.speed;
    const charMs = speed >= 5 ? 7 : speed >= 2 ? 16 : 30;
    const tailMs = speed >= 5 ? 60 : speed >= 2 ? 120 : 200;
    const text = event.message ?? "";
    let dur = text.length * charMs + tailMs;
    if (event.type === "damage" || event.type === "recoil") {
      // Allow the HP bar transition to settle before the next event lands.
      dur += speed >= 5 ? 200 : speed >= 2 ? 320 : 480;
    } else if (event.type === "faint") {
      dur += 600; // sprite fade-out animation
    }

    const t = window.setTimeout(() => {
      dispatch({ type: "CONSUME_EVENT" });
    }, Math.max(80, dur));
    return () => clearTimeout(t);
  }, [state.pendingEvents, state.paused, state.speed, dispatch]);
}
