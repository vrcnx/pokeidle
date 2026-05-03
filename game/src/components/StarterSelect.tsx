import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl } from "../utils/sprites";
import { rollShiny, hasShinyCharm } from "../utils/pokemon";
import { STARTER_KEYS } from "../state/initialState";

export function StarterSelect() {
  const { state, dispatch } = useGame();
  const charm = hasShinyCharm(state.pokedexCaught);
  return (
    <div className="game-window starter-select">
      <h1>Pokémon Idle</h1>
      <p>Choose your starter:</p>
      <div className="starter-options">
        {STARTER_KEYS.map((key) => {
          const sp = pokemonTable[key];
          return (
            <button
              key={key}
              className="starter-card"
              onClick={() =>
                dispatch({
                  type: "SELECT_STARTER",
                  payload: { speciesKey: key, isShiny: rollShiny(charm) },
                })
              }
            >
              <img
                src={pokemonSpriteUrl(key, false, false)}
                alt={sp.name}
                width={96}
                height={96}
                style={{ imageRendering: "pixelated" }}
              />
              <span>{sp.name}</span>
              <small>{sp.types.join(" / ")}</small>
            </button>
          );
        })}
      </div>
    </div>
  );
}
