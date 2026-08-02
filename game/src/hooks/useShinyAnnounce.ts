import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { getSocket } from "../net/socket";

// Tell global chat when you catch a shiny.
//
// ── WHY A HOOK AND NOT THE REDUCER ──────────────────────────────────
// The reducer is pure and stays that way. It records THAT a catch
// happened (GameState.lastCatch); this decides whether anyone should hear
// about it and does the talking.
//
// ── WHY IT WATCHES A COUNTER ────────────────────────────────────────
// `lastCatch.key` increments on every catch. Watching `shinyCaught`
// instead would have been the obvious move and would have been wrong: it
// is an append-only SET of species, so a second shiny Gyarados adds
// nothing to it and would announce nothing.
//
// ── WHY THE FIRST VALUE IS SWALLOWED ────────────────────────────────
// `lastCatch` is not persisted, so a reload starts it at null and there is
// nothing to replay. The ref still primes from whatever is in state at
// mount, because a remount inside a session (a route change, a hot reload,
// a save reconcile that rebuilds the provider) would otherwise re-announce
// the last catch of the session every time.
export function useShinyAnnounce() {
  const { state } = useGame();
  const seen = useRef<number | null>(state.lastCatch?.key ?? null);

  useEffect(() => {
    const c = state.lastCatch;
    if (!c) return;
    if (seen.current === c.key) return;
    seen.current = c.key;
    if (!c.isShiny) return;
    // Fire and forget. The server composes the sentence from the
    // authenticated username and may silently decline it (rate limit), so
    // there is nothing here worth reporting to the player either way — a
    // failed announcement must never look like a failed catch.
    try {
      getSocket().emit("shiny:announce", {
        speciesKey: c.speciesKey,
        name: c.name,
        level: c.level,
      });
    } catch {
      /* offline, or no socket yet — the catch itself is unaffected */
    }
  }, [state.lastCatch]);
}
