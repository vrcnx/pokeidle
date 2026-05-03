import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { encounters } from "../data/encounters";
import { routes } from "../data/routes";
import { pokemonTable } from "../data/pokemon";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { resolveCatchSettings } from "../utils/catchSettings";
import { BALL_ORDER } from "../utils/items";
import { pokeballs } from "../data/pokeballs";
import { useModalEnter } from "../utils/animate";
import type { CatchMode, CatchSettings } from "../types";

// Imperative open/close for modal state, matching ManageMovesModal pattern.
let _routeKey: string | null = null;
const _listeners = new Set<(s: string | null) => void>();
export function openCatchSettings(routeKey: string) {
  _routeKey = routeKey;
  _listeners.forEach((l) => l(routeKey));
}
export function closeCatchSettings() {
  _routeKey = null;
  _listeners.forEach((l) => l(null));
}
function useRouteKey(): string | null {
  const [r, setR] = useState<string | null>(_routeKey);
  useEffect(() => {
    _listeners.add(setR);
    return () => { _listeners.delete(setR); };
  }, []);
  return r;
}

const MODES: { value: CatchMode; label: string }[] = [
  { value: "always",          label: "Always catch" },
  { value: "shiny_only",      label: "Only if shiny" },
  { value: "level_threshold", label: "Above level:" },
  { value: "pokedex_new",     label: "Not caught yet" },
];

// Catch Settings — opens from the "Catch" button on the Wild Pokemon header.
// Layout matches the original: shiny toggle → mode radios → ball selector
// → per-species toggle list with All / None batch actions.
export function CatchSettingsModal() {
  const { state, dispatch } = useGame();
  const routeKey = useRouteKey();
  if (!routeKey) return null;

  const enc = encounters[routeKey]?.encounters ?? [];

  function setRule(speciesKey: string, settings: CatchSettings) {
    dispatch({
      type: "SET_CATCH_RULE",
      payload: { routeKey: routeKey!, speciesKey, settings },
    });
  }

  // The "global default" used when no per-species override exists. We update
  // it via the same modal so it stays in sync with the route's overall
  // behaviour. Most fields here apply to BOTH the default and (optionally)
  // override the per-species rules.
  const defaults = state.globalCatchDefaults;
  function updateDefault(patch: Partial<CatchSettings>) {
    dispatch({
      type: "SET_GLOBAL_CATCH_DEFAULTS",
      payload: { settings: { ...defaults, ...patch } },
    });
  }

  return (
    <div className="modal-overlay" onClick={closeCatchSettings}>
      <CatchSettingsDialog
        routeKey={routeKey}
        encList={enc}
        setRule={setRule}
        defaults={defaults}
        updateDefault={updateDefault}
      />
    </div>
  );
}

function CatchSettingsDialog({
  routeKey, encList, setRule, defaults, updateDefault,
}: {
  routeKey: string;
  encList: { speciesKey: string; weight: number; minLevel: number; maxLevel: number }[];
  setRule: (speciesKey: string, settings: CatchSettings) => void;
  defaults: CatchSettings;
  updateDefault: (patch: Partial<CatchSettings>) => void;
}) {
  const { state, dispatch } = useGame();
  const dialogRef = useModalEnter(".g-card");
  const routeName = routes[routeKey]?.name ?? routeKey;
  return (
    <div ref={dialogRef} className="g-modal catch-settings-modal-v2" onClick={(e) => e.stopPropagation()}>
      <header className="g-modal-head">
        <h2>Catch Settings <span className="dim" style={{ fontWeight: 500, fontSize: 13 }}>· {routeName}</span></h2>
        <button className="g-modal-close" onClick={closeCatchSettings} aria-label="Close">×</button>
      </header>

      <div className="g-modal-body">
        <div className="g-grid">
          <section className="g-card">
            <h3>Mode</h3>
            <button
              className={`shiny-toggle ${state.alwaysCatchShinies ? "active" : ""}`}
              onClick={() =>
                dispatch({
                  type: "SET_ALWAYS_CATCH_SHINIES",
                  payload: { value: !state.alwaysCatchShinies },
                })
              }
            >
              ★ Always catch shinies
            </button>
            <div className="catch-mode-section">
              {MODES.map((m) => (
                <label key={m.value} className="catch-mode-row">
                  <input
                    type="radio"
                    checked={defaults.mode === m.value}
                    onChange={() => updateDefault({ mode: m.value })}
                  />
                  <span>{m.label}</span>
                  {m.value === "level_threshold" && defaults.mode === "level_threshold" && (
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={defaults.levelThreshold}
                      onChange={(e) =>
                        updateDefault({ levelThreshold: Number(e.target.value) })
                      }
                    />
                  )}
                </label>
              ))}
            </div>
          </section>

          <section className="g-card">
            <h3>Balls</h3>
            <div className="catch-balls-row">
              {BALL_ORDER.map((b) => {
                const owned = state.inventory[b] ?? 0;
                const enabled = defaults.enabledBalls.includes(b);
                const disabled = owned === 0 && b !== "pokeball";
                return (
                  <button
                    key={b}
                    className={`ball-pick ${enabled ? "enabled" : ""} ${
                      disabled ? "disabled" : ""
                    }`}
                    disabled={disabled}
                    title={`${pokeballs[b].name} · owned: ${owned}`}
                    onClick={() => {
                      const next = enabled
                        ? defaults.enabledBalls.filter((id) => id !== b)
                        : [...defaults.enabledBalls, b];
                      updateDefault({ enabledBalls: next });
                    }}
                  >
                    <img
                      className="ball-icon"
                      src={itemSpriteUrl(b)}
                      alt={pokeballs[b].name}
                      width={20}
                      height={20}
                      draggable={false}
                    />
                  </button>
                );
              })}
            </div>
            <p className="g-help" style={{ marginTop: 6 }}>
              Auto-throws cycle through enabled balls in this order — Master &gt; Ultra &gt; Great &gt; Poké.
            </p>
          </section>
        </div>

        <section className="g-card g-card-full">
          <header className="ctx-row-head" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Pokémon on this route</h3>
            <div className="catch-bulk">
              <button
                className="g-btn-ghost g-btn-small"
                onClick={() =>
                  dispatch({
                    type: "TOGGLE_ROUTE_CATCH_ALL",
                    payload: { routeKey, enabled: true },
                  })
                }
              >
                All
              </button>
              <button
                className="g-btn-ghost g-btn-small"
                onClick={() =>
                  dispatch({
                    type: "TOGGLE_ROUTE_CATCH_ALL",
                    payload: { routeKey, enabled: false },
                  })
                }
              >
                None
              </button>
            </div>
          </header>
          {encList.length === 0 ? (
            <p className="g-help">No wild Pokémon on this route.</p>
          ) : (
            <ul className="catch-species-list">
              {encList.map((e) => {
                const sp = pokemonTable[e.speciesKey];
                const rule = resolveCatchSettings(state, routeKey, e.speciesKey);
                const seen = state.pokedexSeen.includes(e.speciesKey);
                return (
                  <li key={e.speciesKey}>
                    {seen ? (
                      <img
                        src={pokemonSpriteUrl(e.speciesKey)}
                        alt={sp.name}
                        width={32}
                        height={32}
                        style={{ imageRendering: "pixelated" }}
                      />
                    ) : (
                      <span className="catch-mystery">?</span>
                    )}
                    <div className="catch-name-col">
                      <span className="catch-name">{seen ? sp.name : "???"}</span>
                      {rule.mode === "level_threshold" && (
                        <label className="catch-lvl">
                          ≥ Lv
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={rule.levelThreshold}
                            onChange={(ev) =>
                              setRule(e.speciesKey, {
                                ...rule,
                                levelThreshold: Number(ev.target.value),
                              })
                            }
                          />
                        </label>
                      )}
                    </div>
                    <button
                      className={`catch-toggle ${rule.enabled ? "on" : "off"}`}
                      onClick={() =>
                        setRule(e.speciesKey, { ...rule, enabled: !rule.enabled })
                      }
                    >
                      CATCH
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <footer className="g-modal-foot">
        <button className="g-btn-primary" onClick={closeCatchSettings}>Done</button>
      </footer>
    </div>
  );
}
