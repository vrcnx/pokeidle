import { useEffect, useState } from "react";
import {
  changelog,
  changesSince,
  CURRENT_VERSION,
  LAST_SEEN_VERSION_KEY,
} from "../data/changelog";
import { useT } from "../i18n/useT";
import { isStreamMode } from "../state/streamMode";
import type { ChangelogEntry } from "../types";

// What's New.
//
// Two ways in:
//   1. Automatically, once, the first time a returning player loads the
//      game after a version bump — showing ONLY what shipped since they
//      were last here.
//   2. On demand from Settings, showing the full history.
//
// Three rules this has to get right, all of which the first version got
// wrong:
//   * A brand-new player must NOT be shown release notes. They have
//     never played; a wall of "we fixed X" is a terrible first screen.
//     We silently record their version instead.
//   * Dismissing must stick until the NEXT version, not just this
//     session.
//   * A returning player should see what changed for THEM, not the
//     entire history back to 0.1 every single time.

let _openFull: (() => void) | null = null;

/** Open the full changelog on demand (from Settings). */
export function openChangelog() { _openFull?.(); }

function readSeen(): string | null {
  try { return localStorage.getItem(LAST_SEEN_VERSION_KEY); } catch { return null; }
}
function writeSeen(v: string) {
  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, v); } catch { /* private mode */ }
}

export function ChangelogModal() {
  // "auto" = fired by a version bump (scoped to what's new for them).
  // "full" = opened from Settings (whole history).
  const [mode, setMode] = useState<null | "auto" | "full">(null);
  const [newEntries, setNewEntries] = useState<ChangelogEntry[]>([]);
  const t = useT();

  useEffect(() => {
    _openFull = () => setMode("full");
    return () => { _openFull = null; };
  }, []);

  // No auto-open any more.
  //
  // "What's new" is a section of the welcome-back dialog now
  // (state/welcomeBack.ts), which summarises it and offers a link here for
  // the full text. This modal used to fire on mount, synchronously from
  // localStorage — so it opened FIRST and was then covered by the daily and
  // away modals as their requests resolved, leaving release notes the player
  // never saw underneath two overlays they had to clear.
  //
  // The three rules the old auto-open enforced still hold; they moved rather
  // than disappeared. Brand-new players are marked current without being
  // shown anything (welcomeBack.beginWelcomeBack), dismissal sticks until the
  // next version (welcomeBack.closeWelcomeBack writes the seen version), and
  // a returning player sees only what shipped since they were last here
  // (changesSince, called there).
  //
  // `openChangelog()` from Settings and from the welcome dialog is now the
  // only way in — hence "full" being the only reachable mode.

  // Escape closes, like every other modal in the app.
  useEffect(() => {
    if (!mode) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function dismiss() {
    // Mark caught-up on ANY close path — including the Settings view, so
    // reading the changelog manually also silences the auto-popup.
    // Closing it is the player saying "I have seen this".
    writeSeen(CURRENT_VERSION);
    setMode(null);
  }

  if (!mode) return null;

  const entries = mode === "auto" ? newEntries : changelog;
  const isAuto = mode === "auto";

  return (
    <div className="modal-overlay" onClick={dismiss}>
      <div
        className="g-modal changelog-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("What's new")}
      >
        <header className="changelog-head">
          <div className="changelog-head-text">
            <span className="changelog-eyebrow">
              {isAuto ? t("Updated while you were away") : t("Release history")}
            </span>
            <h2>
              {isAuto ? t("What's new") : t("Changelog")}
              <span className="changelog-version-pill">v{CURRENT_VERSION}</span>
            </h2>
          </div>
          <button className="g-modal-close" onClick={dismiss} aria-label={t("Close")}>×</button>
        </header>

        <div className="changelog-body">
          {entries.map((entry) => (
            <article
              key={entry.version}
              className={`changelog-entry ${entry.highlight ? "is-highlight" : ""}`}
            >
              <header className="changelog-entry-head">
                <span className="changelog-version-tag">v{entry.version}</span>
                {entry.subtitle && <span className="changelog-subtitle">{entry.subtitle}</span>}
                {entry.date && (
                  <time className="changelog-date dim small" dateTime={entry.date}>
                    {new Date(entry.date).toLocaleDateString(undefined, {
                      year: "numeric", month: "short", day: "numeric",
                    })}
                  </time>
                )}
              </header>
              {entry.sections.map((sec) => (
                <section key={sec.heading} className="changelog-section">
                  <h4>{sec.heading}</h4>
                  <ul>
                    {sec.items.map((it, i) => <li key={i}>{it}</li>)}
                  </ul>
                </section>
              ))}
            </article>
          ))}
          {entries.length === 0 && (
            <p className="dim">{t("Nothing to report yet — you're up to date.")}</p>
          )}
        </div>

        <footer className="changelog-foot">
          {isAuto && (
            <button className="g-btn-ghost g-btn-small" onClick={() => setMode("full")}>
              {t("See full history")}
            </button>
          )}
          <button className="g-btn-primary changelog-dismiss" onClick={dismiss}>
            {isAuto ? t("Let's play") : t("Close")}
          </button>
        </footer>
      </div>
    </div>
  );
}
