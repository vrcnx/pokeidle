import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { api, ApiError } from "../net/api";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";

// "Report a bug" modal opened from the Settings card. Captures a title +
// description from the user, plus auto-includes the URL, user agent,
// and a small condensed game-state snapshot so the admin can reproduce.
//
// Imperative open API mirrors the rest of the modal pattern in this app
// (LegalModal, RewardShopPanel, etc.) so any component can fire it
// without prop-drilling state.

let _open = false;
const _listeners = new Set<(v: boolean) => void>();
export function openReportBug() {
  _open = true;
  for (const fn of _listeners) fn(true);
}
export function closeReportBug() {
  _open = false;
  for (const fn of _listeners) fn(false);
}
function useReportBugOpen(): boolean {
  const [v, setV] = useState(_open);
  useEffect(() => {
    _listeners.add(setV);
    return () => { _listeners.delete(setV); };
  }, []);
  return v;
}

export function ReportBugModal() {
  const open = useReportBugOpen();
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={closeReportBug}>
      <ReportBugDialog />
    </div>
  );
}

function ReportBugDialog() {
  const { state } = useGame();
  const t = useT();
  const dialogRef = useModalEnter(".g-card");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (title.trim().length < 3) { setError(t("Title is too short.")); return; }
    if (description.trim().length < 10) { setError(t("Please describe the bug a bit more (10+ chars).")); return; }
    setBusy(true);
    try {
      await api.submitBugReport({
        title: title.trim(),
        description: description.trim(),
        page: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        context: JSON.stringify({
          phase: state.phase,
          location: state.currentLocation,
          partySpeciesAndLevels: state.party.map((p) => ({ species: p.speciesKey, level: p.level })),
          enemy: state.enemyPokemon ? { species: state.enemyPokemon.speciesKey, level: state.enemyPokemon.level } : null,
          inRaid: state.inRaid,
          raidLegendary: state.raidLegendary,
          lastBattleLog: state.battleLog.slice(-10),
        }).slice(0, 20_000),
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError(t("You've sent a few reports recently — try again in an hour."));
        } else {
          setError(err.message || `Couldn't submit (${err.status})`);
        }
      } else {
        setError(t("Couldn't reach the server. Check your connection."));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="g-modal report-bug-modal"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={t("Report a bug")}
    >
      <header className="g-modal-head">
        <h2>{t("Report a bug")}</h2>
        <button className="g-modal-close" onClick={closeReportBug} aria-label={t("Close")}>×</button>
      </header>

      <div className="g-modal-body">
        {submitted ? (
          <section className="g-card g-card-full">
            <h3>{t("Thanks!")}</h3>
            <p>{t("We've got it. The admin team will look at this — no need to repost.")}</p>
          </section>
        ) : (
          <form onSubmit={submit} className="report-bug-form">
            <section className="g-card g-card-full">
              <p className="g-help" style={{ marginTop: 0 }}>
                {t("Tell us what went wrong. We'll automatically include your current URL, browser, and a snapshot of your party + last few battle log lines so the admin can reproduce.")}
              </p>
              <label className="auth-label">
                <span>{t("Title")}</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  minLength={3}
                  maxLength={120}
                  autoFocus
                  placeholder={t("Short summary (e.g. 'Trade animation freezes mid-swap')")}
                />
              </label>
              <label className="auth-label">
                <span>{t("Description")}</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  minLength={10}
                  maxLength={4000}
                  rows={6}
                  placeholder={t("Steps to reproduce — what did you do, what happened, what did you expect?")}
                />
              </label>
              {error && <div className="auth-error">{error}</div>}
            </section>
          </form>
        )}
      </div>

      <footer className="g-modal-foot">
        {submitted ? (
          <>
            <span style={{ flex: 1 }} />
            <button className="g-btn-primary" onClick={closeReportBug}>{t("Close")}</button>
          </>
        ) : (
          <>
            <button className="g-btn-ghost" onClick={closeReportBug}>{t("Cancel")}</button>
            <span style={{ flex: 1 }} />
            <button
              className="g-btn-primary"
              onClick={submit as any}
              disabled={busy}
            >
              {busy ? "…" : t("Submit report")}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
