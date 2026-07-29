import { useGame } from "../state/GameContext";
import { encounters } from "../data/encounters";
import { pokemonTable } from "../data/pokemon";
import { PokemonSprite } from "./Sprite";
import { CATCH_MODE_OPTIONS, catchModeHint, resolveCatchSettings } from "../utils/catchSettings";
import { BALL_ORDER } from "../utils/items";
import { pokeballs } from "../data/pokeballs";
import type { CatchMode, CatchSettings } from "../types";
import { useT } from "../i18n/useT";


// Per-route, per-species rules. Default falls through to globalCatchDefaults.
export function CatchSettingsPanel() {
  const { state, dispatch } = useGame();
  const t = useT();
  const route = state.currentRoute;
  const list = encounters[route]?.encounters ?? [];

  function update(speciesKey: string, settings: CatchSettings) {
    dispatch({
      type: "SET_CATCH_RULE",
      payload: { routeKey: route, speciesKey, settings },
    });
  }

  function toggleAll(enabled: boolean) {
    dispatch({
      type: "TOGGLE_ROUTE_CATCH_ALL",
      payload: { routeKey: route, enabled },
    });
  }

  function updateGlobalDefaults(settings: CatchSettings) {
    dispatch({ type: "SET_GLOBAL_CATCH_DEFAULTS", payload: { settings } });
  }

  return (
    <div className="catch-settings-panel">
      <h2>{t("Catch settings — ")}{route}</h2>
      <p className="dim">{t("Per-species rules for this route. Falls back to global defaults.")}</p>

      <div className="catch-row global">
        <strong>{t("Global default")}</strong>
        <CatchEditor settings={state.globalCatchDefaults} onChange={updateGlobalDefaults} />
      </div>

      {list.length === 0 ? (
        <p className="dim">{t("No wild encounters configured for this route.")}</p>
      ) : (
        <>
          <div className="catch-bulk">
            <button onClick={() => toggleAll(true)}>{t("Enable all on this route")}</button>
            <button onClick={() => toggleAll(false)}>{t("Disable all")}</button>
          </div>
          <ul className="catch-list">
            {list.map((e) => {
              const rule = resolveCatchSettings(state, route, e.speciesKey);
              return (
                <li key={e.speciesKey}>
                  <PokemonSprite
                    speciesKey={e.speciesKey}
                    alt={e.speciesKey}
                    width={48}
                    height={48}
                    style={{ imageRendering: "pixelated" }}
                  />
                  <div>
                    <strong>{pokemonTable[e.speciesKey]?.name ?? e.speciesKey}</strong>
                    <small className="dim">
                      L{e.minLevel}–{e.maxLevel}{t(" · weight ")}{e.weight}
                    </small>
                  </div>
                  <CatchEditor
                    settings={rule}
                    onChange={(s) => update(e.speciesKey, s)}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function CatchEditor({
  settings,
  onChange,
}: {
  settings: CatchSettings;
  onChange: (s: CatchSettings) => void;
}) {
  const t = useT();
  return (
    <div className="catch-editor">
      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => onChange({ ...settings, enabled: e.target.checked })}
        />{" "}
        {t("Auto-catch")}
      </label>
      {/* The two dex-based modes are a coin-flip from their names alone, so the
          selected one explains itself in the tooltip and in the hint below. */}
      <select
        value={settings.mode}
        title={t(catchModeHint(settings.mode))}
        onChange={(e) =>
          onChange({ ...settings, mode: e.target.value as CatchMode })
        }
      >
        {CATCH_MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={t(o.hint)}>{t(o.label)}</option>
        ))}
      </select>
      {settings.mode === "level_threshold" && (
        <input
          type="number"
          min={1}
          max={100}
          value={settings.levelThreshold}
          onChange={(e) =>
            onChange({ ...settings, levelThreshold: Number(e.target.value) })
          }
        />
      )}
      <div className="catch-balls">
        {BALL_ORDER.map((b) => {
          const enabled = settings.enabledBalls.includes(b);
          return (
            <label key={b}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={() => {
                  const next = enabled
                    ? settings.enabledBalls.filter((id) => id !== b)
                    : [...settings.enabledBalls, b];
                  onChange({ ...settings, enabledBalls: next });
                }}
              />{" "}
              {pokeballs[b].name.replace(" Ball", "")}
            </label>
          );
        })}
      </div>
    </div>
  );
}
