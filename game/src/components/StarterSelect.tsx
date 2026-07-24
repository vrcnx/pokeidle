import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl } from "../utils/sprites";
import { rollShiny, hasShinyCharm } from "../utils/pokemon";
import { STARTER_KEYS } from "../state/initialState";
import { useStreamMode } from "../state/streamMode";
import { useT } from "../i18n/useT";

export function StarterSelect() {
  const { state, dispatch } = useGame();
  const charm = hasShinyCharm(state.pokedexCaught);
  const isStream = useStreamMode();
  const autoPicked = useRef(false);
  const t = useT();

  // A stream account can't click, so an unattended fresh stream would sit
  // forever on this screen. Auto-pick a starter after a short beat so the
  // broadcast starts playing on its own.
  useEffect(() => {
    if (!isStream || autoPicked.current) return;
    autoPicked.current = true;
    const id = setTimeout(() => {
      dispatch({ type: "SELECT_STARTER", payload: { speciesKey: STARTER_KEYS[0], isShiny: rollShiny(charm) } });
    }, 2500);
    return () => clearTimeout(id);
  }, [isStream, charm, dispatch]);
  return (
    <div className="game-window starter-select">
      <h1>{t("Pokémon Idle")}</h1>
      <p>{t("Choose your starter:")}</p>
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
