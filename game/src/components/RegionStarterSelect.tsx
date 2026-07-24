import { useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl } from "../utils/sprites";
import { rollShiny, hasShinyCharm } from "../utils/pokemon";
import { regions, regionForLocation } from "../data/regions";
import { useModalEnter } from "../utils/animate";
import { useStreamMode } from "../state/streamMode";
import { useT } from "../i18n/useT";

// Mid-game counterpart to StarterSelect — offered once, automatically,
// the first time the player is standing in a new region's starting town
// (see pendingRegionStarter in utils/unlocks.ts for the trigger). Unlike
// StarterSelect this doesn't replace the party; it gifts the chosen mon
// alongside whatever the player already has.
export function RegionStarterSelect() {
  const { state, dispatch } = useGame();
  const t = useT();
  const dialogRef = useModalEnter();
  const isStream = useStreamMode();
  const autoPicked = useRef(false);

  const inPhase = state.phase === "regionStarterSelect";
  const regionId = inPhase ? regionForLocation(state.currentLocation) : null;
  const region = regionId ? regions[regionId] : undefined;
  const charm = hasShinyCharm(state.pokedexCaught);

  // Stream accounts can't click — auto-pick the region starter so the
  // broadcast keeps advancing when it reaches a new region's town.
  useEffect(() => {
    if (!isStream || autoPicked.current) return;
    if (!inPhase || !region || !region.starters[0]) return;
    autoPicked.current = true;
    const id = setTimeout(() => {
      dispatch({
        type: "SELECT_REGION_STARTER",
        payload: { region: region.id, speciesKey: region.starters[0], isShiny: rollShiny(charm) },
      });
    }, 2500);
    return () => clearTimeout(id);
  }, [isStream, inPhase, region, charm, dispatch]);

  if (!inPhase) return null;
  if (!region) return null;

  return (
    <div className="modal-overlay">
      <div ref={dialogRef} className="g-modal starter-select region-starter-select" role="dialog" aria-label={t("Choose your starter")}>
        <h1>{t("A new region, a new partner!")}</h1>
        <p>{t("Choose your starter:")}</p>
        <div className="starter-options">
          {region.starters.map((key) => {
            const sp = pokemonTable[key];
            if (!sp) return null;
            return (
              <button
                key={key}
                className="starter-card"
                onClick={() =>
                  dispatch({
                    type: "SELECT_REGION_STARTER",
                    payload: { region: region.id, speciesKey: key, isShiny: rollShiny(charm) },
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
    </div>
  );
}
