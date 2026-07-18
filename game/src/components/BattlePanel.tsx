import { useGame } from "../state/GameContext";
import { PokemonCard } from "./PokemonCard";
import { pokeballs } from "../data/pokeballs";
import { BALL_ORDER } from "../utils/items";
import { routes } from "../data/routes";
import { encounters } from "../data/encounters";
import { useT } from "../i18n/useT";

export function BattlePanel() {
  const { state, dispatch } = useGame();
  const t = useT();
  const route = routes[state.currentRoute];
  const routeName = encounters[state.currentRoute]?.name ?? route?.name ?? state.currentRoute;
  const bgImg = backgroundFor(route?.type);

  return (
    <div className="battle-panel" style={{ backgroundImage: `url(${bgImg})` }}>
      <div className="battle-panel-header">
        <span>{routeName}</span>
        <span>{t("Phase: ")}{state.phase}</span>
        {state.paused && <span className="badge-paused">{t("PAUSED")}</span>}
      </div>
      <div className="battle-arena">
        <div className="enemy-slot">
          {state.enemyPokemon ? (
            <PokemonCard pokemon={state.enemyPokemon} />
          ) : (
            <div className="placeholder">{t("Looking for wild Pokémon…")}</div>
          )}
        </div>
        <div className="player-slot">
          {state.playerPokemon && <PokemonCard pokemon={state.playerPokemon} isBack />}
        </div>
      </div>

      {state.phase === "battle" && state.enemyPokemon && (
        <div className="ball-row">
          {BALL_ORDER.map((id) => {
            const owned = state.inventory[id] ?? 0;
            return (
              <button
                key={id}
                disabled={owned <= 0}
                onClick={() => dispatch({ type: "CATCH_POKEMON", payload: { ballId: id } })}
              >
                {pokeballs[id].name} × {owned}
              </button>
            );
          })}
        </div>
      )}
      {(state.phase === "trainerBattle" || state.phase === "bossBattle") && state.enemyPokemon && (
        <div className="ball-row">
          <span className="dim">{t("Trainer battle — can't catch.")}</span>
        </div>
      )}

      <div className="battle-controls">
        <button onClick={() => dispatch({ type: "TOGGLE_PAUSE" })}>
          {state.paused ? t("Resume") : t("Pause")}
        </button>
        {[1, 2, 5].map((s) => (
          <button
            key={s}
            className={state.speed === s ? "active" : ""}
            onClick={() => dispatch({ type: "SET_SPEED", payload: { speed: s } })}
          >
            ×{s}
          </button>
        ))}
        <button onClick={() => dispatch({ type: "HEAL_PARTY" })}>{t("Heal Party")}</button>
      </div>
    </div>
  );
}

function backgroundFor(type?: string): string {
  switch (type) {
    case "town":         return "/backgrounds/town.webp";
    case "cave":         return "/backgrounds/cave.webp";
    case "victoryRoad":  return "/backgrounds/mountain.webp";
    case "raid":         return "/backgrounds/town_port.webp";
    default:             return "/backgrounds/grassland.webp";
  }
}
