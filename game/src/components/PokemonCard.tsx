import type { Pokemon } from "../types";
import { pokemonSpriteUrl } from "../utils/sprites";
import { pokemonTable } from "../data/pokemon";

interface Props {
  pokemon: Pokemon;
  isBack?: boolean;
  small?: boolean;
}

export function PokemonCard({ pokemon, isBack = false, small = false }: Props) {
  const sp = pokemonTable[pokemon.speciesKey];
  const hpPct = Math.max(0, (pokemon.currentHp / pokemon.maxHp) * 100);
  const hpClass = hpPct > 50 ? "ok" : hpPct > 20 ? "warn" : "low";
  return (
    <div className={`pokemon-card ${small ? "small" : ""}`}>
      <div className="pokemon-card-header">
        <strong>
          {pokemon.name}
          {pokemon.isShiny ? " ✨" : ""}
        </strong>
        <span>Lv. {pokemon.level}</span>
      </div>
      <div className="pokemon-card-types">{sp?.types.join(" / ")}</div>
      <img
        src={pokemonSpriteUrl(pokemon.speciesKey, isBack, pokemon.isShiny)}
        alt={pokemon.name}
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
