import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { evolutionLocked, levelEvolutionFor } from "../utils/evolution";

// The one and only automatic evolution path. Mounted in App.tsx.
//
// It replaces `useEvolutionTrigger`, which was written, never imported, and
// therefore tree-shaken out of the bundle entirely — so for its whole life
// NOTHING evolved on its own. Three separate comments elsewhere in the tree
// described the game's behaviour in terms of that hook while it was not in the
// build, and a player (wujek_bartek) sat at level 45 with an unevolved
// Charmander before filing it as a bug. There is no orphan left: that file is
// gone, this one is imported, and if you are looking for "what evolves things
// by level", it is here and nowhere else.
//
// LEVEL EVOLUTIONS ONLY. A stone or a Link Cable consumes an item, which makes
// it a genuine decision with a cost, so those stay manual and are dispatched
// from the Bag / detail modal / party menu as before.

/**
 * Watches the party and starts the level evolution any member has earned.
 *
 * Gated on `state.autoEvolve` (global, default on) and on each Pokémon's own
 * `noEvolve` lock (per-mon opt-out — the Everstone).
 */
export function useAutoEvolve(suspended = false): void {
  const { state, dispatch } = useGame();
  // Every `${pokemonId}:${targetSpecies}` this hook has already asked for.
  //
  // THIS IS THE ANTI-LOOP GUARD, and it is deliberately never cleared. A key
  // is recorded BEFORE the dispatch, so a request that the reducer declines —
  // for any reason, present or future — is asked exactly once and then dropped
  // forever instead of being retried on every commit. That is the failure mode
  // that matters here: the effect re-runs on every party change, so a refusal
  // without this would be an infinite dispatch loop, and a past incident of
  // exactly that shape crashed the game and consumed the item on the way out.
  //
  // It cannot block a legitimate evolution either. A successful one changes
  // `speciesKey`, so the next target is a different key; even a data cycle
  // (a→b→a) terminates, because the second lap re-asks a key already in here.
  const attemptedRef = useRef<Set<string>>(new Set());
  // attemptedRef is keyed by Pokemon id, and ids are reused: they come from a
  // per-save counter that restarts at 1, so a LOAD_SAVE (admin reset, cloud
  // adopt, "local blob not provably ours") can hand a NEW Pokemon an id this
  // set has already written off — silently blocking it forever, which is the
  // exact bug this hook exists to fix. Forget everything when the save
  // underneath us is replaced.
  const seenGenRef = useRef<number | undefined>(undefined);
  if (seenGenRef.current !== state.saveGen) {
    seenGenRef.current = state.saveGen;
    attemptedRef.current = new Set();
  }

  useEffect(() => {
    if (!state.autoEvolve) return;
    // ── Not mid-battle, not mid-animation, not over another modal ──
    // `phase` covers battle / trainerBattle / bossBattle / raid / evolution /
    // healing / starter select on its own; the rest are things that can be
    // playing WHILE the phase is already back to "idle", each of which owns
    // the screen or the simulation for as long as it lasts.
    // A PvP battle is a competitive match the player is actively playing.
    // An evolution popping up mid-turn steals focus, and it sets
    // phase:"evolution", which useBattleLoop early-returns on permanently —
    // so an unresolved one would also leave the idle game dead once PvP ends.
    // Checked FIRST, and before attemptedRef is touched, because that set is
    // deliberately never cleared: a return placed after the add would kill
    // that Pokemon's evolution forever.
    if (suspended) return;
    if (state.phase !== "idle") return;
    if (state.paused) return;              // player stopped the sim; respect it
    if (state.evolutionState) return;      // one evolution at a time, always
    if (state.healingState) return;        // Pokémon Center animation
    if (state.catchAnim) return;           // ball is mid-flight
    if (state.whiteoutAnim) return;        // "You fainted!" overlay
    if (state.levelUpNotification) return; // level-up modal is open over the UI
    if (state.awaitingSwitch) return;      // player owes us a switch choice
    if (state.pendingEvents.length > 0) return; // battle text still typing out

    for (let i = 0; i < state.party.length; i++) {
      const p = state.party[i];
      // The per-Pokémon opt-out. Checked here rather than in the reducer
      // because the reducer cannot tell an automatic START_EVOLUTION from the
      // player clicking Evolve, and the lock is only meant to stop the former.
      if (evolutionLocked(p)) continue;
      // levelEvolutionFor is the SAME resolver the manual path uses: it picks
      // the branch this individual qualifies for (so a Tyrogue becomes the
      // Hitmon- its own Attack/Defense earns, not whichever trigger is listed
      // first) and refuses any target missing from `pokemonTable`. That last
      // guard is why this loop cannot hand COMPLETE_EVOLUTION a species it
      // would have to bail out of, and it lives in one place on purpose —
      // do not re-test it here.
      const t = levelEvolutionFor(p);
      if (!t) continue;
      const key = `${p.id}:${t.into}`;
      if (attemptedRef.current.has(key)) continue;
      attemptedRef.current.add(key);
      dispatch({
        type: "START_EVOLUTION",
        // `pokemonId` makes the index advisory: this effect ran against a
        // committed render, and the reducer re-finds the slot by id so a
        // reorder landing in between cannot evolve the wrong Pokémon.
        payload: { partyIndex: i, toSpeciesKey: t.into, pokemonId: p.id },
      });
      // Exactly one per pass. `phase` is "evolution" by the next commit, so
      // the gate above holds the queue until the cinematic finishes.
      return;
    }
  }, [
    state.autoEvolve,
    state.phase,
    suspended,
    state.paused,
    state.party,
    state.evolutionState,
    state.healingState,
    state.catchAnim,
    state.whiteoutAnim,
    state.levelUpNotification,
    state.awaitingSwitch,
    state.pendingEvents,
    dispatch,
  ]);
}
