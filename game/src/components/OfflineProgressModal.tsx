import { useEffect } from "react";
import { useGame } from "../state/GameContext";

// "While you were away." Shown once on load when the player was gone long
// enough for their team to have trained (see utils/offlineProgress). The
// reducer has already applied the EXP; this just reports what happened.

function formatAway(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  const h = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rem === 0 ? h : `${h} ${rem} min`;
}

export function OfflineProgressModal() {
  const { state, dispatch } = useGame();
  const summary = state.offlineSummary;

  useEffect(() => {
    if (!summary) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dispatch({ type: "CLEAR_OFFLINE_SUMMARY" }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summary, dispatch]);

  if (!summary) return null;

  const close = () => dispatch({ type: "CLEAR_OFFLINE_SUMMARY" });
  const levels = summary.toLevel - summary.fromLevel;
  const capped = summary.creditedMs < summary.awayMs;

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="g-modal offline-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="While you were away">
        <header className="offline-head">
          <span className="offline-eyebrow">Welcome back</span>
          <h2>While you were away</h2>
          <p className="offline-away">
            Your team trained for {formatAway(summary.creditedMs)}
            {capped && <span className="dim small"> (capped)</span>}.
          </p>
        </header>

        <div className="offline-stats">
          <div className="offline-stat">
            <span className="offline-stat-value">+{summary.exp.toLocaleString()}</span>
            <span className="offline-stat-label">EXP earned</span>
          </div>
          <div className="offline-stat">
            <span className="offline-stat-value">~{summary.battles.toLocaleString()}</span>
            <span className="offline-stat-label">battles fought</span>
          </div>
          <div className="offline-stat">
            <span className="offline-stat-value">{levels > 0 ? `+${levels}` : "0"}</span>
            <span className="offline-stat-label">levels gained</span>
          </div>
        </div>

        <p className="offline-lead">
          {levels > 0
            ? <><strong>{summary.leadName}</strong> grew from level {summary.fromLevel} to <strong>{summary.toLevel}</strong>.</>
            : <><strong>{summary.leadName}</strong> banked EXP toward the next level.</>}
        </p>

        <footer className="offline-foot">
          <button className="g-btn-primary offline-dismiss" onClick={close}>Keep going</button>
        </footer>
      </div>
    </div>
  );
}
