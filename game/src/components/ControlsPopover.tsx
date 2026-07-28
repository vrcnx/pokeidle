import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { IconSliders } from "./Icon";
import { useT } from "../i18n/useT";

// Lightweight controls dropdown — replaces the old "More" popover.
// Holds battle mode (manual/auto), auto-proceed and auto-evolve. Catch
// settings are now a top-level toolbar button; manual ball-throw + party-swap
// are accessed via right-click on a Pokémon and drag-and-drop on the
// party list, so they no longer need their own tabs.
//
// Auto-evolve is duplicated in Settings → Game (GlobalDock) on purpose. This
// is where the other two automation toggles live, so it is where a player
// mid-session looks; Settings is where a player who wants to turn something
// OFF looks. Both dispatch the same SET_AUTO_EVOLVE — one field, two doors.

export function ControlsPopover() {
  const { state, dispatch } = useGame();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="more-actions-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`more-actions-trigger ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t("Battle and travel controls")}
      >
        <IconSliders size={13} />
        <span>{t("Controls")}</span>
      </button>
      {open && (
        <div className="more-actions-popover" role="dialog" aria-label={t("Controls")}>
          <div className="more-actions-body">
            <div className="hud-section">
              <span className="hud-label">{t("Battle")}</span>
              <div className="hud-row">
                <button
                  className={state.battleMode === "manual" ? "active" : ""}
                  onClick={() => dispatch({ type: "SET_BATTLE_MODE", payload: { mode: "manual" } })}
                >
                  {t("Manual")}
                </button>
                <button
                  className={state.battleMode === "auto" ? "active" : ""}
                  onClick={() => dispatch({ type: "SET_BATTLE_MODE", payload: { mode: "auto" } })}
                >
                  {t("Auto")}
                </button>
              </div>
            </div>
            <div className="hud-section">
              <span className="hud-label">{t("Travel")}</span>
              <div className="hud-row">
                <button
                  className={state.autoProceed ? "active" : ""}
                  onClick={() => dispatch({ type: "TOGGLE_AUTO_PROCEED" })}
                >
                  {state.autoProceed ? t("Auto-Proceed: ON") : t("Auto-Proceed: OFF")}
                </button>
              </div>
            </div>
            <div className="hud-section">
              <span className="hud-label">{t("Evolution")}</span>
              <div className="hud-row">
                <button
                  className={state.autoEvolve ? "active" : ""}
                  title={t("Level-up evolutions happen on their own. Evolution stones and the Link Cable always stay manual.")}
                  onClick={() =>
                    dispatch({ type: "SET_AUTO_EVOLVE", payload: { value: !state.autoEvolve } })
                  }
                >
                  {state.autoEvolve ? t("Auto-Evolve: ON") : t("Auto-Evolve: OFF")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
