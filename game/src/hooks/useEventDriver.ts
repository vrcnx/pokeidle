import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { eventDurationMs, remainingMs } from "../utils/battleTiming";
import { sfxManager } from "../utils/sfx";
import type { BattleEvent } from "../types";

// Drains state.pendingEvents one at a time, with timing that matches the
// typewriter status bar. The durations live in utils/battleTiming.ts —
// `eventDurationMs` is the same ladder the typewriter itself types at, because
// what the player is waiting for IS the line finishing.
//
// ── WHY THIS SCHEDULES AGAINST ELAPSED TIME ───────────────────────────
// The timeout used to be armed for the event's FULL duration every time the
// effect ran, and `state.speed` is in the dep list. So each speed change
// cancelled the pending timer and started the whole event over — and because
// nothing drains while `pendingEvents` is non-empty, the battle loop is
// blocked the entire time. Clicking between speeds froze the game for as long
// as you kept clicking, which is pani's "switching speed can stall the game".
//
// Stamping when the event started and scheduling the REMAINDER means a speed
// change retimes the event instead of restarting it: switching to ×5 mid-line
// makes the current line finish sooner, and no amount of clicking can push the
// finish past the event's own duration.
export function useEventDriver(): void {
  const { state, dispatch } = useGame();

  // The event we are currently timing, and when it went up.
  const runRef = useRef<{ event: BattleEvent; at: number } | null>(null);
  // Pausing must not count against the event's window — see below.
  const pausedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (state.paused) {
      if (pausedAtRef.current == null) pausedAtRef.current = Date.now();
      return;
    }
    // Push the start stamp forward by however long we were paused, so an
    // event paused halfway resumes halfway. Clearing the stamp instead would
    // replay the line from the top; ignoring the pause would consume the
    // event the instant the game came back.
    if (pausedAtRef.current != null) {
      if (runRef.current) runRef.current.at += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }

    const event = state.pendingEvents[0];
    if (!event) return;

    if (runRef.current?.event !== event) {
      runRef.current = { event, at: Date.now() };
      // Fire the attack-hit SFX on the DAMAGE event so it lands in sync with
      // the defender's sprite flash (the same moment HP ticks down and the
      // damage shake plays). Firing on the "attack" event would play the
      // sound at the START of the swing, ahead of the visible impact.
      //
      // Inside the first-sight branch so it plays once per event: it used to
      // be at the top of the effect, so every re-render that re-ran this —
      // including every speed change — re-triggered the hit sound.
      if (event.type === "damage") sfxManager.play("attack");
    }

    const dur = eventDurationMs(event.type, (event.message ?? "").length, state.speed);
    const t = window.setTimeout(() => {
      dispatch({ type: "CONSUME_EVENT" });
    }, remainingMs(runRef.current.at, dur, Date.now()));
    return () => clearTimeout(t);
  }, [state.pendingEvents, state.paused, state.speed, dispatch]);
}
