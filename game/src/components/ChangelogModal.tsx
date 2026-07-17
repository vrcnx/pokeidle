import { useEffect, useState } from "react";
import {
  changelog,
  changesSince,
  CURRENT_VERSION,
  LAST_SEEN_VERSION_KEY,
} from "../data/changelog";
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

  useEffect(() => {
    _openFull = () => setMode("full");
    return () => { _openFull = null; };
  }, []);

  useEffect(() => {
    const seen = readSeen();
    if (seen === CURRENT_VERSION) return;         // already caught up

    if (!seen) {
      // Brand-new player (or someone who cleared storage). Do not greet
      // them with release notes — they have never played, so "we fixed
      // the Safari Zone Dratini bug" is meaningless and in the way.
      // Mark them current so their first real update is the first thing
      // they ever see.
      writeSeen(CURRENT_VERSION);
      return;
    }

    const fresh = changesSince(seen);
    if (fresh.length === 0) {
      // Version moved but nothing player-facing to report (or their
      // stored version is somehow ahead of ours). Record and stay quiet.
      writeSeen(CURRENT_VERSION);
      return;
    }
    setNewEntries(fresh);
    setMode("auto");
  }, []);

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
        aria-label="What's new"
      >
        <header className="changelog-head">
          <div className="changelog-head-text">
            <span className="changelog-eyebrow">
              {isAuto ? "Updated while you were away" : "Release history"}
            </span>
            <h2>
              {isAuto ? "What's new" : "Changelog"}
              <span className="changelog-version-pill">v{CURRENT_VERSION}</span>
            </h2>
          </div>
          <button className="g-modal-close" onClick={dismiss} aria-label="Close">×</button>
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
            <p className="dim">Nothing to report yet — you're up to date.</p>
          )}
        </div>

        <footer className="changelog-foot">
          {isAuto && (
            <button className="g-btn-ghost g-btn-small" onClick={() => setMode("full")}>
              See full history
            </button>
          )}
          <button className="g-btn-primary changelog-dismiss" onClick={dismiss}>
            {isAuto ? "Let's play" : "Close"}
          </button>
        </footer>
      </div>
    </div>
  );
}
