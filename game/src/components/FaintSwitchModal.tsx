import { useGame } from "../state/GameContext";
import { pokemonSpriteUrl } from "../utils/sprites";

export function FaintSwitchModal() {
  const { state, dispatch } = useGame();
  if (!state.awaitingSwitch) return null;

  const choices = state.party
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => p.currentHp > 0);

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>{state.playerPokemon?.name} fainted!</h2>
        <p>Choose your next Pokémon:</p>
        <div className="bag-target-grid">
          {choices.map(({ p, idx }) => (
            <button
              key={p.id}
              onClick={() =>
                dispatch({
                  type: "SWITCH_PLAYER_POKEMON",
                  payload: { partyIndex: idx },
                })
              }
            >
              <img
                src={pokemonSpriteUrl(p.speciesKey, false, p.isShiny)}
                alt={p.name}
                width={48}
                height={48}
                style={{ imageRendering: "pixelated" }}
              />
              <span>
                {p.name} L{p.level}
              </span>
              <small>
                {p.currentHp} / {p.maxHp}
              </small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
