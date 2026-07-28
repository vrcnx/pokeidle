import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { levelEvolutionFor } from "../utils/evolution";

// Watches the party for any Pokemon that should evolve by level. The original
// pauses the simulation and shows the evolution modal; we mirror that.
// Stone-based evolutions are triggered explicitly from the Bag UI or the
// Pokémon detail modal (both dispatch USE_STONE).
export function useEvolutionTrigger() {
  const { state, dispatch } = useGame();
  const checkedRef = useRef<string>("");

  useEffect(() => {
    if (state.phase !== "idle") return;
    if (state.evolutionState) return;
    // Find the first party member whose level meets a level-evo threshold.
    // levelEvolutionFor picks the branch this individual actually qualifies
    // for — scanning the trigger list here directly would always take the
    // first entry and make every branching line a single hardcoded target.
    for (let i = 0; i < state.party.length; i++) {
      const p = state.party[i];
      const t = levelEvolutionFor(p);
      if (!t) continue;
      const key = `${p.id}:${t.into}`;
      if (checkedRef.current === key) continue;
      checkedRef.current = key;
      dispatch({
        type: "START_EVOLUTION",
        payload: { partyIndex: i, toSpeciesKey: t.into },
      });
      return;
    }
  }, [state.phase, state.party, state.evolutionState, dispatch]);
}
