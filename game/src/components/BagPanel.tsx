import { useState } from "react";
import { useGame } from "../state/GameContext";
import { evolutionStones } from "../data/evolutionStones";
import { consumables } from "../data/consumables";
import { evolutions } from "../data/evolutions";
import { pokemonTable } from "../data/pokemon";
import { encounters } from "../data/encounters";
import { pokemonSpriteUrl } from "../utils/sprites";
import { getItemInfo } from "../utils/items";
import { pushToast } from "./Toast";

// Bag — use stones on party members, apply repels/honey to encounter species
// on the current route.
export function BagPanel() {
  const { state, dispatch } = useGame();
  const [pickStone, setPickStone] = useState<string | null>(null);
  const [pickEffect, setPickEffect] = useState<string | null>(null);

  const stones = Object.keys(evolutionStones).filter(
    (id) => (state.inventory[id] ?? 0) > 0
  );
  const effectItems = Object.keys(consumables).filter(
    (id) => (state.inventory[id] ?? 0) > 0
  );

  // Stones are applied from the Pokémon detail popup (click any party / box
  // Pokemon → Evolve button appears if they react). Bag just shows the count.
  void pickStone; void setPickStone; void evolutions;

  function applyEffect(speciesKey: string) {
    if (!pickEffect) return;
    const itemName = consumables[pickEffect]?.name ?? pickEffect;
    dispatch({
      type: "USE_EFFECT_ITEM",
      payload: { itemId: pickEffect, speciesKey, routeKey: state.currentRoute },
    });
    pushToast({ kind: "success", icon: "✓", text: `Used ${itemName}` });
    setPickEffect(null);
  }

  const routeEncounters = encounters[state.currentRoute]?.encounters ?? [];

  return (
    <div className="bag-panel">
      <h2>Bag</h2>

      <h3>Evolution stones</h3>
      {stones.length === 0 ? (
        <p className="dim">No stones. Buy them from the Reward Shop after gym wins.</p>
      ) : (
        <>
          <ul className="bag-list">
            {stones.map((id) => (
              <li key={id}>
                <span>{getItemInfo(id).name}</span>
                <span>× {state.inventory[id]}</span>
              </li>
            ))}
          </ul>
          <p className="dim small">
            Click a Pokémon in your party or box to use a stone.
          </p>
        </>
      )}

      <h3>Repel / Honey (current route)</h3>
      {effectItems.length === 0 ? (
        <p className="dim">No consumables. Buy them from a Mart.</p>
      ) : pickEffect ? (
        <>
          <p>Apply {getItemInfo(pickEffect).name} to which species on this route?</p>
          <div className="bag-target-grid">
            {routeEncounters.map((e) => (
              <button key={e.speciesKey} onClick={() => applyEffect(e.speciesKey)}>
                <img
                  src={pokemonSpriteUrl(e.speciesKey)}
                  alt={e.speciesKey}
                  width={48}
                  height={48}
                  style={{ imageRendering: "pixelated" }}
                />
                <span>{pokemonTable[e.speciesKey]?.name ?? e.speciesKey}</span>
              </button>
            ))}
          </div>
          <button onClick={() => setPickEffect(null)}>Cancel</button>
        </>
      ) : (
        <ul className="bag-list">
          {effectItems.map((id) => (
            <li key={id}>
              <span>
                {getItemInfo(id).name} × {state.inventory[id]} —{" "}
                <span className="dim">{getItemInfo(id).description}</span>
              </span>
              <button onClick={() => setPickEffect(id)}>Use</button>
            </li>
          ))}
        </ul>
      )}

      <h3>Active effects</h3>
      {state.activeEffects.length === 0 ? (
        <p className="dim">None.</p>
      ) : (
        <ul className="bag-list">
          {state.activeEffects.map((e, i) => (
            <li key={i}>
              {getItemInfo(e.itemId).name} on{" "}
              {pokemonTable[e.speciesKey]?.name ?? e.speciesKey}
              {e.routeKey ? ` @ ${e.routeKey}` : ""} — {e.battlesRemaining} battles left
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
