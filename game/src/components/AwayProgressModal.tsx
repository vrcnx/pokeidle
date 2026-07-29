import { useEffect } from "react";
import { clearAwayReport, useAwayReport } from "../state/awayProgress";
import { useT } from "../i18n/useT";
import { useStreamMode } from "../state/streamMode";

/**
 * "While you were away" — the report for catch-up progress the server paid for
 * time the player spent with the game closed, backgrounded, or the PC off
 * (br_876bae56ef21c9021c).
 *
 * This modal REPORTS; it never grants. The claim already happened server-side
 * during boot (state/awayProgress.ts) and the money is delivered through the
 * pending-grant inbox, so there is no button here that can pay twice, and
 * closing this without reading it loses nothing.
 */

/** Compact duration for the report line: "8h 0m", "42m". */
function humanDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

export function AwayProgressModal() {
  const report = useAwayReport();
  const isStream = useStreamMode();
  const t = useT();

  useEffect(() => {
    if (!report) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearAwayReport(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [report]);

  // An unattended OBS box has nobody to dismiss a modal, and the stream would
  // sit behind it. The stipend still landed — it was granted server-side before
  // this component ever ran — so discarding the REPORT costs the account
  // nothing. Same reasoning as the daily-reward popup.
  useEffect(() => {
    if (report && isStream) clearAwayReport();
  }, [report, isStream]);

  if (!report || isStream) return null;

  const hours = report.capMs / 3_600_000;

  return (
    <div className="modal-overlay" onClick={clearAwayReport}>
      <div className="g-modal away-progress-modal" onClick={(e) => e.stopPropagation()}>
        <header className="g-modal-head">
          <h2>🌙 {t("While you were away")}</h2>
          <button className="g-modal-close" onClick={clearAwayReport} aria-label={t("Close")}>×</button>
        </header>

        <div className="g-modal-body">
          <p>
            {t("You were away for")} <strong>{humanDuration(report.elapsedMs)}</strong>
            {/* One key with the number outside it — a split phrase
                ("counted up to the" + N + "maximum") cannot be reordered by a
                translator, and pt/es both want the number last. */}
            {report.capped && (
              <>
                {" "}
                <span className="dim">({t("capped at")} {hours}h)</span>
              </>
            )}
            .
          </p>

          <div className="g-card" style={{ marginTop: 12 }}>
            <div className="g-row">
              <span>{t("Away earnings")}</span>
              <strong>${report.money.toLocaleString()}</strong>
            </div>
            <div className="g-row">
              <span>{t("Your rate")}</span>
              <strong>${report.moneyPerHour.toLocaleString()}{t(" / hour")}</strong>
            </div>
          </div>

          {/* Saying this out loud is the point. A capped stipend that is
              deliberately far below active income WILL read as stingy unless
              the trade-off is explained, and a player who thinks idling might
              be competitive will idle and then feel cheated. */}
          <p className="dim small" style={{ marginTop: 12 }}>
            {t("Away time pays a small stipend only — no battles, EXP or catches happen while the game is closed, and the rate is far below what you earn actually playing. It grows with each Gym Badge, and stops accruing after")}{" "}
            {hours}h.
          </p>
          <p className="dim small">
            {t("The money is added to your save on your next autosave.")}
          </p>

        </div>

        {/* Reuses the shared modal footer instead of adding a class the
            stylesheet would have to grow a rule for. */}
        <div className="g-modal-foot">
          <button className="g-btn-primary" onClick={clearAwayReport}>
            {t("Nice")}
          </button>
        </div>
      </div>
    </div>
  );
}
