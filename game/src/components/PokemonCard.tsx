import type { Pokemon } from "../types";
import { displayName } from "../utils/pokemon";
import { PokemonSprite } from "./Sprite";
import { pokemonTable } from "../data/pokemon";
import { useT } from "../i18n/useT";

interface Props {
  pokemon: Pokemon;
  isBack?: boolean;
  small?: boolean;
}

export function PokemonCard({ pokemon, isBack = false, small = false }: Props) {
  const t = useT();
  const sp = pokemonTable[pokemon.speciesKey];
  const hpPct = Math.max(0, (pokemon.currentHp / pokemon.maxHp) * 100);
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  return (
    <div className={`pokemon-card ${small ? "small" : ""}`}>
      <div className="pokemon-card-header">
        <strong>
          {displayName(pokemon)}
          {pokemon.isShiny ? " ✨" : ""}
        </strong>
        <span>{t("Lv. ")}{pokemon.level}</span>
      </div>
      <div className="pokemon-card-types">{sp?.types.join(" / ")}</div>
      <PokemonSprite
        speciesKey={pokemon.speciesKey}
        isBack={isBack}
        isShiny={pokemon.isShiny}
        alt={displayName(pokemon)}
        width={small ? 64 : 96}
        height={small ? 64 : 96}
        style={{ imageRendering: "pixelated" }}
      />
      <div className={`hp-bar ${hpClass}`}>
        <div className="hp-bar-fill" style={{ width: `${hpPct}%` }} />
      </div>
      <div className="hp-text">
        {pokemon.currentHp} / {pokemon.maxHp}
      </div>
    </div>
  );
}
