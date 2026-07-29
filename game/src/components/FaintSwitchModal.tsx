import { useGame } from "../state/GameContext";
import { PokemonSprite } from "./Sprite";
import { useT } from "../i18n/useT";
import { displayName } from "../utils/pokemon";

// No ESC handler / close button on this modal — the player MUST pick a
// new active Pokémon to continue the battle. Closing without a pick
// would leave the game in a broken `awaitingSwitch` state with no UI
// path to fix it.
export function FaintSwitchModal() {
  const { state, dispatch } = useGame();
  const t = useT();
  if (!state.awaitingSwitch) return null;

  const choices = state.party
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => p.currentHp > 0);

  return (
    <div className="modal-overlay">
      <div
        className="g-modal faint-switch-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("Choose next Pokémon")}
      >
        <header className="g-modal-head">
          <h2>{state.playerPokemon ? displayName(state.playerPokemon) : ""} {t("fainted!")}</h2>
        </header>
        <div className="g-modal-body">
          <p className="dim small" style={{ margin: "0 0 8px" }}>
            {t("Choose your next Pokémon:")}
          </p>
          <div className="faint-switch-grid">
            {choices.map(({ p, idx }) => (
              <button
                key={p.id}
                className="faint-switch-choice"
                onClick={() =>
                  dispatch({
                    type: "SWITCH_PLAYER_POKEMON",
                    payload: { partyIndex: idx },
                  })
                }
              >
                <PokemonSprite
                  speciesKey={p.speciesKey}
                  isShiny={p.isShiny}
                  alt={displayName(p)}
                  width={48}
                  height={48}
                  style={{ imageRendering: "pixelated" }}
                />
                <span><strong>{displayName(p)}</strong> <small className="dim">{t("Lv")} {p.level}</small></span>
                <small className="dim">
                  {t("HP")} {p.currentHp} / {p.maxHp}
                </small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
