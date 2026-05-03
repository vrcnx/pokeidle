import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl } from "../utils/sprites";

export function PokedexPanel() {
  const { state } = useGame();
  const all = Object.values(pokemonTable).sort((a, b) => a.id - b.id);
  return (
    <div className="pokedex-panel">
      <h2>
        Pokédex — Caught {state.pokedexCaught.length} / {all.length} · Seen{" "}
        {state.pokedexSeen.length}
      </h2>
      <div className="pokedex-grid">
        {all.map((sp) => {
          const key = Object.entries(pokemonTable).find(([, v]) => v.id === sp.id)?.[0];
          if (!key) return null;
          const caught = state.pokedexCaught.includes(key);
          const seen = state.pokedexSeen.includes(key);
          const shiny = state.shinyCaught.includes(key);
          return (
            <div
              key={sp.id}
              className={`dex-cell ${caught ? "caught" : seen ? "seen" : "unknown"}`}
              title={sp.name}
            >
              {(caught || seen) ? (
                <img
                  src={pokemonSpriteUrl(key, false, shiny)}
                  alt={sp.name}
                  width={48}
                  height={48}
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <div className="dex-cell-blank">?</div>
              )}
              <small>#{String(sp.id).padStart(3, "0")}</small>
              <small>{caught ? sp.name : seen ? "(seen)" : "—"}</small>
              {shiny && <span className="dex-shiny">✨</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
