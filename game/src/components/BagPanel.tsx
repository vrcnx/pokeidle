import { useState } from "react";
import { useGame } from "../state/GameContext";
import { evolutionStones } from "../data/evolutionStones";
import { consumables } from "../data/consumables";
import { stoneTargets, evolutions } from "../data/evolutions";
import { pokemonTable } from "../data/pokemon";
import { encounters } from "../data/encounters";
import { pokemonSpriteUrl } from "../utils/sprites";
import { getItemInfo } from "../utils/items";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";

// Bag — use stones on party members, apply repels/honey to encounter species
// on the current route.
export function BagPanel() {
  const { state, dispatch } = useGame();
  const t = useT();
  const [pickStone, setPickStone] = useState<string | null>(null);
  const [pickEffect, setPickEffect] = useState<string | null>(null);
  const [pickCable, setPickCable] = useState(false);

  const stones = Object.keys(evolutionStones).filter(
    (id) => (state.inventory[id] ?? 0) > 0
  );
  const cableCount = state.inventory.linkcable ?? 0;
  // A Pokémon can use a Link Cable if it has any trade-based evolution.
  function hasTradeEvo(speciesKey: string): boolean {
    return (evolutions[speciesKey] ?? []).some((e) => "trade" in e);
  }
  function applyCable(partyIndex: number) {
    dispatch({ type: "USE_LINK_CABLE", payload: { partyIndex } });
    setPickCable(false);
  }
  const effectItems = Object.keys(consumables).filter(
    (id) => (state.inventory[id] ?? 0) > 0
  );

  // Stones can be used item-first from here (pick a stone → pick a valid
  // party member) or Pokémon-first from the detail popup. Both dispatch the
  // same validated USE_STONE action.
  function applyStone(partyIndex: number) {
    if (!pickStone) return;
    dispatch({ type: "USE_STONE", payload: { itemId: pickStone, partyIndex } });
    setPickStone(null);
  }

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
      <h2>{t("Bag")}</h2>

      <h3>{t("Evolution stones")}</h3>
      {stones.length === 0 ? (
        <p className="dim">{t("No stones. Buy them from the Reward Shop after gym wins.")}</p>
      ) : pickStone ? (
        <>
          <p>{t("Use")} {getItemInfo(pickStone).name} {t("on which Pokémon?")}</p>
          <div className="bag-target-grid">
            {state.party.map((mon, i) => {
              const eligible = stoneTargets(pickStone).includes(mon.speciesKey);
              return (
                <button
                  key={mon.id}
                  disabled={!eligible}
                  title={eligible ? "" : t("No effect")}
                  onClick={() => applyStone(i)}
                  style={{ opacity: eligible ? 1 : 0.4 }}
                >
                  <img
                    src={pokemonSpriteUrl(mon.speciesKey)}
                    alt={mon.speciesKey}
                    width={48}
                    height={48}
                    style={{ imageRendering: "pixelated" }}
                  />
                  <span>{mon.name} <span className="dim">Lv{mon.level}</span></span>
                </button>
              );
            })}
          </div>
          {state.party.every((mon) => !stoneTargets(pickStone!).includes(mon.speciesKey)) && (
            <p className="dim small">
              {state.box.some((mon) => stoneTargets(pickStone!).includes(mon.speciesKey))
                ? t("A Pokémon in your PC can use this — move it to your party first.")
                : t("None of your Pokémon react to this stone.")}
            </p>
          )}
          <button onClick={() => setPickStone(null)}>{t("Cancel")}</button>
        </>
      ) : (
        <ul className="bag-list">
          {stones.map((id) => {
            const targets = stoneTargets(id).map((k) => pokemonTable[k]?.name ?? k);
            return (
              <li key={id}>
                <span>
                  {getItemInfo(id).name} × {state.inventory[id]}
                  {targets.length > 0 && (
                    <><br /><span className="dim small">{t("Evolves")}: {targets.join(", ")}</span></>
                  )}
                </span>
                <button onClick={() => setPickStone(id)}>{t("Use")}</button>
              </li>
            );
          })}
        </ul>
      )}

      {cableCount > 0 && (
        <>
          <h3>{t("Link Cable")}</h3>
          {pickCable ? (
            <>
              <p>{t("Use a Link Cable on which Pokémon?")}</p>
              <div className="bag-target-grid">
                {state.party.map((mon, i) => {
                  const eligible = hasTradeEvo(mon.speciesKey);
                  return (
                    <button
                      key={mon.id}
                      disabled={!eligible}
                      title={eligible ? "" : t("No trade evolution")}
                      onClick={() => applyCable(i)}
                      style={{ opacity: eligible ? 1 : 0.4 }}
                    >
                      <img
                        src={pokemonSpriteUrl(mon.speciesKey)}
                        alt={mon.speciesKey}
                        width={48}
                        height={48}
                        style={{ imageRendering: "pixelated" }}
                      />
                      <span>{mon.name} <span className="dim">Lv{mon.level}</span></span>
                    </button>
                  );
                })}
              </div>
              {state.party.every((mon) => !hasTradeEvo(mon.speciesKey)) && (
                <p className="dim small">
                  {state.box.some((mon) => hasTradeEvo(mon.speciesKey))
                    ? t("A Pokémon in your PC can use this — move it to your party first.")
                    : t("None of your party Pokémon evolve by trade.")}
                </p>
              )}
              <button onClick={() => setPickCable(false)}>{t("Cancel")}</button>
            </>
          ) : (
            <ul className="bag-list">
              <li>
                <span>
                  {getItemInfo("linkcable").name} × {cableCount}
                  <br /><span className="dim small">{t("Evolves trade-only Pokémon (Haunter, Kadabra, Machoke, Graveler, Onix + Metal Coat, …). Consumed on use.")}</span>
                </span>
                <button onClick={() => setPickCable(true)}>{t("Use")}</button>
              </li>
            </ul>
          )}
        </>
      )}

      {((state.inventory.goldbottlecap ?? 0) > 0 ||
        (state.inventory.silverbottlecap ?? 0) > 0) && (
        <>
          <h3>{t("Bottle Caps (Hyper Training)")}</h3>
          <ul className="bag-list">
            {(state.inventory.goldbottlecap ?? 0) > 0 && (
              <li>
                <span>
                  {getItemInfo("goldbottlecap").name} × {state.inventory.goldbottlecap}
                  <br />
                  <span className="dim small">
                    {t("Perfects every IV. Open a Pokémon's details to use it.")}
                  </span>
                </span>
              </li>
            )}
            {(state.inventory.silverbottlecap ?? 0) > 0 && (
              <li>
                <span>
                  {getItemInfo("silverbottlecap").name} × {state.inventory.silverbottlecap}
                  <br />
                  <span className="dim small">
                    {t("Maxes one IV of your choice. Open a Pokémon's details to use it.")}
                  </span>
                </span>
              </li>
            )}
          </ul>
        </>
      )}

      <h3>{t("Repel / Honey (current route)")}</h3>
      {effectItems.length === 0 ? (
        <p className="dim">{t("No consumables. Buy them from a Mart.")}</p>
      ) : pickEffect ? (
        <>
          <p>{t("Apply")} {getItemInfo(pickEffect).name} {t("to which species on this route?")}</p>
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
          <button onClick={() => setPickEffect(null)}>{t("Cancel")}</button>
        </>
      ) : (
        <ul className="bag-list">
          {effectItems.map((id) => (
            <li key={id}>
              <span>
                {getItemInfo(id).name} × {state.inventory[id]} —{" "}
                <span className="dim">{getItemInfo(id).description}</span>
              </span>
              <button onClick={() => setPickEffect(id)}>{t("Use")}</button>
            </li>
          ))}
        </ul>
      )}

      <h3>{t("Active effects")}</h3>
      {state.activeEffects.length === 0 ? (
        <p className="dim">{t("None.")}</p>
      ) : (
        <ul className="bag-list">
          {state.activeEffects.map((e, i) => (
            <li key={i}>
              {getItemInfo(e.itemId).name} {t("on")}{" "}
              {pokemonTable[e.speciesKey]?.name ?? e.speciesKey}
              {e.routeKey ? ` @ ${e.routeKey}` : ""} — {e.battlesRemaining} {t("battles left")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
