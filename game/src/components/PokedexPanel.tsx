import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { caughtObtainableCount, obtainableCount } from "../utils/obtainable";
import { PokemonSprite } from "./Sprite";
import { useT } from "../i18n/useT";

export function PokedexPanel() {
  const { state } = useGame();
  const t = useT();
  const all = Object.values(pokemonTable).sort((a, b) => a.id - b.id);
  // The grid still lists every entry in the table, but the headline counts
  // against what can actually be caught — the same numerator/denominator the
  // Dex tab, Settings and the trainer card use, so no two surfaces disagree
  // about what "complete" means.
  return (
    <div className="pokedex-panel">
      <h2>
        {t("Pokédex — Caught ")}{caughtObtainableCount(state.pokedexCaught)} / {obtainableCount()}{t(" · Seen")}{" "}
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
                <PokemonSprite
                  speciesKey={key}
                  isShiny={shiny}
                  alt={sp.name}
                  width={48}
                  height={48}
                  style={{ imageRendering: "pixelated" }}
                />
              ) : (
                <div className="dex-cell-blank">?</div>
              )}
              <small>#{String(sp.id).padStart(3, "0")}</small>
              <small>{caught ? sp.name : seen ? t("(seen)") : "—"}</small>
              {shiny && <span className="dex-shiny">✨</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
