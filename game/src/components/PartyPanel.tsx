import { useGame } from "../state/GameContext";
import { PokemonCard } from "./PokemonCard";
import { useT } from "../i18n/useT";

export function PartyPanel() {
  const { state, dispatch } = useGame();
  const t = useT();
  return (
    <div className="party-panel">
      <h2>{t("Party (")}{state.party.length}/6)</h2>
      <div className="party-grid">
        {state.party.map((p, idx) => (
          <div
            key={p.id}
            className={`party-slot ${idx === state.activePlayerPokemonIndex ? "active" : ""}`}
          >
            <PokemonCard pokemon={p} small />
            <div className="party-actions">
              <button
                disabled={idx === state.activePlayerPokemonIndex || p.currentHp <= 0}
                onClick={() =>
                  dispatch({ type: "SWITCH_PLAYER_POKEMON", payload: { partyIndex: idx } })
                }
              >
                {t("Switch in")}
              </button>
              <button
                disabled={state.party.length <= 1}
                onClick={() => dispatch({ type: "PARTY_TO_BOX", payload: { partyIndex: idx } })}
              >
                {t("→ Box")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
