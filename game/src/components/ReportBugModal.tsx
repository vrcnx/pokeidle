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

// Draft persistence. The dialog unmounts the instant it closes, so every
// word typed used to die with it — and the people who report the most bugs
// are exactly the ones who close this to go re-check something in the game
// and come back. The draft is written as you type (so a reload or a crash
// costs nothing either) and only cleared when the report is sent or the
// player says to throw it away.
const DRAFT_KEY = "pokemon-idle-bug-report-draft";

interface Draft { title: string; description: string }

function readDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    const title = typeof parsed.title === "string" ? parsed.title : "";
    const description = typeof parsed.description === "string" ? parsed.description : "";
    if (!title && !description) return null;
    return { title, description };
  } catch {
    // Private mode, or a draft written by an older shape. Either way an
    // unreadable draft must never stop the form from opening.
    return null;
  }
}

function writeDraft(draft: Draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* private mode */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* private mode */ }
}

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
  // The overlay's click-to-dismiss lives inside the dialog now: closing
  // has to go through the same keep-or-discard guard as the buttons.
  return <ReportBugDialog />;
}

function ReportBugDialog() {
  const { state } = useGame();
  const t = useT();
  const dialogRef = useModalEnter(".g-card");
  const [restored] = useState(() => readDraft());
  const [title, setTitle] = useState(() => restored?.title ?? "");
  const [description, setDescription] = useState(() => restored?.description ?? "");
  const [showRestored, setShowRestored] = useState(() => !!restored);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const hasDraft = title.trim().length > 0 || description.trim().length > 0;

  // Persist as they type, debounced so a fast typist isn't hitting
  // localStorage on every keystroke. An emptied form clears the stored
  // draft rather than leaving a blank one to "restore" next time.
  useEffect(() => {
    if (submitted) return;
    const id = window.setTimeout(() => {
      if (hasDraft) writeDraft({ title, description });
      else clearDraft();
    }, 400);
    return () => window.clearTimeout(id);
  }, [title, description, hasDraft, submitted]);

  const keepAndClose = () => {
    writeDraft({ title, description });
    closeReportBug();
  };

  const requestClose = () => {
    // Nothing to lose (empty form, or already sent) — just go.
    if (submitted || !hasDraft) {
      clearDraft();
      closeReportBug();
      return;
    }
    // Already asking, and they clicked outside again: take that as "yes,
    // close" and keep the draft. Refusing to close twice in a row reads as
    // the dialog being stuck, and keeping is the answer that loses nothing.
    if (confirmClose) { keepAndClose(); return; }
    setConfirmClose(true);
  };

  const discardAndClose = () => {
    clearDraft();
    closeReportBug();
  };

  const startFresh = () => {
    setTitle("");
    setDescription("");
    setShowRestored(false);
    clearDraft();
  };

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
      // Sent — the draft has served its purpose and must not come back
      // the next time this form is opened.
      clearDraft();
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
    <div className="modal-overlay" onClick={requestClose}>
      <div
        ref={dialogRef}
        className="g-modal report-bug-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Report a bug")}
      >
        <header className="g-modal-head">
          <h2>{t("Report a bug")}</h2>
          <button className="g-modal-close" onClick={requestClose} aria-label={t("Close")}>×</button>
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
                {showRestored && (
                  <div className="report-bug-restored">
                    <span>{t("Picked up where you left off — this is your unsent draft.")}</span>
                    <button type="button" className="g-btn-ghost" onClick={startFresh}>
                      {t("Start fresh")}
                    </button>
                  </div>
                )}
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
          {confirmClose ? (
            /* Keep-or-discard, inline rather than a second stacked dialog —
               the answer is one word and the form stays visible behind it,
               which is the thing being decided about. */
            <>
              <span className="report-bug-confirm">{t("Keep this report as a draft?")}</span>
              <span style={{ flex: 1 }} />
              <button className="g-btn-ghost" onClick={discardAndClose}>{t("Discard it")}</button>
              <button className="g-btn-primary" onClick={keepAndClose}>{t("Keep draft")}</button>
            </>
          ) : submitted ? (
            <>
              <span style={{ flex: 1 }} />
              <button className="g-btn-primary" onClick={requestClose}>{t("Close")}</button>
            </>
          ) : (
            <>
              <button className="g-btn-ghost" onClick={requestClose}>{t("Cancel")}</button>
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
    </div>
  );
}
