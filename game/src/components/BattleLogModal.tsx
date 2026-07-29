import { useState, useEffect, useRef } from "react";
import { useGame } from "../state/GameContext";
import { useT } from "../i18n/useT";
import { REWARD_LINE } from "./BattleLog";

// Floating "Log" button + modal. The log used to live inline in the centre
// column but it ate vertical space and duplicated the parchment status bar.
// Now it lives behind a single icon — click to open the full scrollback.
export function BattleLogModal() {
  const { state } = useGame();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [open, state.battleLog]);

  return (
    <>
      <button className="floating-log-btn" onClick={() => setOpen(true)} title={t("Battle log")}>
        📜
      </button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
            <header className="info-head">
              <h2>{t("Battle Log")}</h2>
              <button className="info-close" onClick={() => setOpen(false)} aria-label={t("Close")}>×</button>
            </header>
            <div className="battle-log full" ref={ref}>
              {state.battleLog.length === 0 ? (
                <p className="dim small" style={{ padding: 16 }}>{t("Nothing has happened yet.")}</p>
              ) : (
                state.battleLog.map((line, i) => (
                  <div
                    key={i}
                    className={`battle-log-line${REWARD_LINE.test(line) ? " log-exp" : ""}`}
                  >
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
