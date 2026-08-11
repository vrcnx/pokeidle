import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { encounters } from "../data/encounters";
import { routes } from "../data/routes";
import { pokemonTable } from "../data/pokemon";
import { itemSpriteUrl } from "../utils/sprites";
import { PokemonSprite } from "./Sprite";
import { CATCH_MODE_OPTIONS, resolveCatchSettings } from "../utils/catchSettings";
import { autoCatchOutlook } from "../utils/catching";
import { BALL_ORDER } from "../utils/items";
import { pokeballs } from "../data/pokeballs";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import type { CatchMode, CatchSettings } from "../types";
import { NATURE_NAMES } from "../data/natures";

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


// Per-species badge wording, keyed off autoCatchOutlook. "⊘ NO MATCH" is the
// state that did not exist before and is the reason this modal was lying: on,
// but the mode's own condition can never be true for this species again, so no
// ball will ever be thrown at it. The hints name the fix (change the Mode
// above) rather than the symptom, because the row's own toggle is not it.
const OUTLOOK_LABEL = {
  on:    "✓ CATCH",
  inert: "⊘ NO MATCH",
  off:   "✗ SKIP",
} as const;

const OUTLOOK_HINT = {
  on: "Auto-catch is ON for this species. Click to skip.",
  off: "Auto-catch is OFF for this species. Click to enable.",
  no_balls: "Auto-catch is on, but no ball is selected above — nothing can be thrown.",
  already_registered:
    "Auto-catch is on, but Mode is \"Not registered\" and this species is already in your Pokédex — nothing will be thrown. Change the Mode above to catch it again.",
  already_owned:
    "Auto-catch is on, but Mode is \"Not owned\" and you are already holding one — nothing will be thrown. Change the Mode above to catch more.",
} as const;

// Appended whenever autoCatchOutlook reports shinyOverride on a row that is
// otherwise throwing nothing. "Always catch shinies" is checked ABOVE `enabled`,
// above the ball list and above the mode, so every hint above overstates its
// case for a shiny encounter — the row really does still throw at one.
const SHINY_NET_HINT =
  "A SHINY of this species is still caught, though — \"Always catch shinies\" overrides every rule on this screen.";

// Catch Settings — opens from the "Catch" button on the Wild Pokemon header.
// Layout matches the original: shiny toggle → mode radios → ball selector
// → per-species toggle list with All / None batch actions.
export function CatchSettingsModal() {
  const { state, dispatch } = useGame();
  const routeKey = useRouteKey();
  if (!routeKey) return null;

  const enc = encounters[routeKey]?.encounters ?? [];

  /** Drop a species' override so it follows the route default again. */
  function clearRule(speciesKey: string) {
    dispatch({ type: "CLEAR_CATCH_RULE", payload: { routeKey: routeKey!, speciesKey } });
  }

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
      // routeKey so this also refreshes mode/threshold/balls on any
      // per-species override already on THIS route — otherwise a
      // species that has ever been individually toggled (or hit by
      // "All"/"None") stays frozen on whatever settings existed the
      // moment that override was created, ignoring every change made
      // here afterward. See reducer.ts's case for the full story.
      payload: { settings: { ...defaults, ...patch }, routeKey: routeKey! },
    });
  }

  return (
    <div className="modal-overlay" onClick={closeCatchSettings}>
      <CatchSettingsDialog
        routeKey={routeKey}
        encList={enc}
        setRule={setRule}
        clearRule={clearRule}
        defaults={defaults}
        updateDefault={updateDefault}
      />
    </div>
  );
}

function CatchSettingsDialog({
  routeKey, encList, setRule, clearRule, defaults, updateDefault,
}: {
  routeKey: string;
  encList: { speciesKey: string; weight: number; minLevel: number; maxLevel: number }[];
  setRule: (speciesKey: string, settings: CatchSettings) => void;
  clearRule: (speciesKey: string) => void;
  defaults: CatchSettings;
  updateDefault: (patch: Partial<CatchSettings>) => void;
}) {
  const { state, dispatch } = useGame();
  const dialogRef = useModalEnter(".g-card");
  const t = useT();
  const routeName = routes[routeKey]?.name ?? routeKey;
  const f = defaults.filters ?? {};
  const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n) || 0));
  /** Patch the filter set, and drop it entirely once nothing is left — an
   *  empty `filters` object is the same as none, and keeping one around
   *  makes every save carry a dead key. */
  function setFilters(patch: Partial<NonNullable<CatchSettings["filters"]>>) {
    const next = { ...f, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) {
      if (next[k] === undefined) delete next[k];
    }
    updateDefault({ filters: Object.keys(next).length ? next : undefined });
  }

  return (
    <div ref={dialogRef} className="g-modal catch-settings-modal-v2" onClick={(e) => e.stopPropagation()}>
      <header className="g-modal-head">
        <h2>{t("Catch Settings")} <span className="dim" style={{ fontWeight: 500, fontSize: 13 }}>· {routeName}</span></h2>
        <button className="g-modal-close" onClick={closeCatchSettings} aria-label={t("Close")}>×</button>
      </header>

      <div className="g-modal-body">
        <div className="g-grid">
          <section className="g-card">
            <h3>{t("Mode")}</h3>
            <button
              className={`shiny-toggle ${state.alwaysCatchShinies ? "active" : ""}`}
              onClick={() =>
                dispatch({
                  type: "SET_ALWAYS_CATCH_SHINIES",
                  payload: { value: !state.alwaysCatchShinies },
                })
              }
            >
              {t("★ Always catch shinies")}
            </button>
            <div className="catch-mode-section">
              {CATCH_MODE_OPTIONS.map((m) => (
                <label key={m.value} className="catch-mode-row">
                  <input
                    type="radio"
                    checked={defaults.mode === m.value}
                    onChange={() => updateDefault({ mode: m.value })}
                  />
                  <span>
                    {t(m.label)}
                    <small className="dim" style={{ display: "block", fontWeight: 400 }}>
                      {t(m.hint)}
                    </small>
                  </span>
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


          {/* ── Extra conditions ───────────────────────────────────
              These AND with the rule above. `mode` only ever expressed ONE
              condition, and the request was explicitly about combining them:
              "Adamant male Charmander with IVs above 85%" is four rules, and
              a single-select could never say it.

              Every one is opt-out: absent means "do not care", so a save
              with none of these set behaves exactly as it always did. */}
          <section className="g-card">
            <h3>{t("Only catch if…")}</h3>
            <p className="g-help">
              {t("Extra conditions on top of the rule above. All of them must match.")}
            </p>

            <label className="catch-filter-row">
              <input
                type="checkbox"
                checked={f.minIvPct != null}
                onChange={(e) =>
                  setFilters({ minIvPct: e.target.checked ? 85 : undefined })
                }
              />
              <span>{t("IVs at least")}</span>
              <input
                className="catch-filter-num"
                type="number"
                min={0}
                max={100}
                step={5}
                disabled={f.minIvPct == null}
                value={f.minIvPct ?? 85}
                onChange={(e) => setFilters({ minIvPct: clampPct(Number(e.target.value)) })}
              />
              <span className="dim">%</span>
            </label>

            <label className="catch-filter-row">
              <input
                type="checkbox"
                checked={!!f.gender}
                onChange={(e) => setFilters({ gender: e.target.checked ? "M" : undefined })}
              />
              <span>{t("Gender")}</span>
              <select
                className="catch-filter-sel"
                disabled={!f.gender}
                value={f.gender ?? "M"}
                onChange={(e) => setFilters({ gender: e.target.value as "M" | "F" })}
              >
                <option value="M">{t("Male")}</option>
                <option value="F">{t("Female")}</option>
              </select>
              {/* Said out loud, because it is the one rule with a surprising
                  consequence: a gender filter excludes Magnemite entirely. */}
              {f.gender && (
                <small className="dim">{t("genderless species are skipped")}</small>
              )}
            </label>

            <div className="catch-filter-natures">
              <label className="catch-filter-row">
                <input
                  type="checkbox"
                  checked={!!f.natures?.length}
                  onChange={(e) => setFilters({ natures: e.target.checked ? ["Adamant"] : undefined })}
                />
                <span>{t("Nature is one of")}</span>
                {!!f.natures?.length && (
                  <small className="dim">{f.natures.length} {t("selected")}</small>
                )}
              </label>
              {!!f.natures?.length && (
                <div className="catch-nature-grid">
                  {NATURE_NAMES.map((n) => {
                    const on = f.natures!.includes(n);
                    return (
                      <button
                        key={n}
                        type="button"
                        className={`catch-nature${on ? " is-on" : ""}`}
                        onClick={() => {
                          const next = on
                            ? f.natures!.filter((x) => x !== n)
                            : [...f.natures!, n];
                          // Never leave an empty list: "nature is one of
                          // NOTHING" matches nothing, which would silently
                          // stop auto-catch. Unticking the last one turns the
                          // whole filter off instead.
                          setFilters({ natures: next.length ? next : undefined });
                        }}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
          <section className="g-card">
            <h3>{t("Balls")}</h3>
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
              {t("Auto-throws cycle through enabled balls in this order — Master > Ultra > Great > Poké.")}
            </p>
            <label className="catch-mode-row" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={!!defaults.weakenFirst}
                onChange={(e) => updateDefault({ weakenFirst: e.target.checked })}
              />
              <span>{t("Weaken before catching")}</span>
            </label>
            <p className="g-help" style={{ marginTop: 4 }}>
              {t("Auto-battle chips wild Pokémon down to low HP before throwing, boosting catch odds. Shinies are always caught immediately.")}
            </p>
          </section>
        </div>

        <section className="g-card g-card-full">
          <header className="ctx-row-head" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{t("Pokémon on this route")}</h3>
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
                {t("All")}
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
                {t("None")}
              </button>
            </div>
          </header>
          {encList.length === 0 ? (
            <p className="g-help">{t("No wild Pokémon on this route.")}</p>
          ) : (
            <ul className="catch-species-list">
              {encList.map((e) => {
                const sp = pokemonTable[e.speciesKey];
                const rule = resolveCatchSettings(state, routeKey, e.speciesKey);
                // ── WHY THIS BADGE EXISTS ────────────────────────────
                // resolveCatchSettings is
                //   catchSettings[route]?.[species] ?? globalCatchDefaults
                // so a per-species override COMPLETELY shadows the default,
                // and changing the default only refreshes overrides on the
                // route you happen to be looking at. A player who set a rule
                // for Zubat on Mt. Moon months ago, then switched everything
                // to "only shinies", kept catching Zubat and had no way to
                // see why — the screen showed the setting they had chosen and
                // the game obeyed a different one.
                //
                // The shadowing is right. Being unable to SEE it was the bug.
                const overridden = !!state.catchSettings[routeKey]?.[e.speciesKey];
                const outlook = autoCatchOutlook(state, routeKey, e.speciesKey);
                const hintKey = outlook.verdict === "inert" ? outlook.reason : outlook.verdict;
                const seen = state.pokedexSeen.includes(e.speciesKey);
                return (
                  <li key={e.speciesKey}>
                    {seen ? (
                      <PokemonSprite
                        speciesKey={e.speciesKey}
                        alt={sp.name}
                        width={32}
                        height={32}
                        style={{ imageRendering: "pixelated" }}
                      />
                    ) : (
                      <span className="catch-mystery">?</span>
                    )}
                    <div className="catch-name-col">
                      <span className="catch-name">
                        {seen ? sp.name : "???"}
                        {overridden && (
                          <button
                            type="button"
                            className="catch-override-badge"
                            title={t("This species has its own rule and ignores the route default. Click to clear it.")}
                            onClick={() => clearRule(e.speciesKey)}
                          >
                            {t("own rule ✕")}
                          </button>
                        )}
                      </span>
                      {rule.mode === "level_threshold" && (
                        <label className="catch-lvl">
                          {t("≥ Lv")}
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
                    {/* The badge reports the RESOLVED decision, not `enabled`.
                        Reading it off the checkbox is br_6fcb7c411f3c317ccc:
                        a "Not registered" rule on an already-registered species
                        showed a green ✓ CATCH and a tooltip promising auto-catch
                        was on, while the engine correctly threw nothing. The
                        click target is still `enabled` — that is the only field
                        this row owns — so an inert row explains itself instead
                        of pretending the toggle is the problem. */}
                    <button
                      className={`catch-toggle ${outlook.verdict}${
                        outlook.shinyOverride && outlook.verdict !== "on" ? " shiny-net" : ""
                      }`}
                      title={
                        t(OUTLOOK_HINT[hintKey]) +
                        (outlook.shinyOverride && outlook.verdict !== "on"
                          ? " " + t(SHINY_NET_HINT)
                          : "")
                      }
                      onClick={() =>
                        setRule(e.speciesKey, { ...rule, enabled: !rule.enabled })
                      }
                    >
                      {outlook.shinyOverride && outlook.verdict !== "on"
                        ? t("★ SHINY ONLY")
                        : t(OUTLOOK_LABEL[outlook.verdict])}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <footer className="g-modal-foot">
        <button className="g-btn-primary" onClick={closeCatchSettings}>{t("Done")}</button>
      </footer>
    </div>
  );
}
