import { useEffect, useState } from "react";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import { useStreamMode } from "../state/streamMode";

// First-visit fan-game disclaimer. Shown once per browser (localStorage-
// flagged). Doesn't gate the app — the user clicks "I understand" and
// it goes away forever. Distinct from the existing Sign-up checkbox
// because it should hit returning anonymous viewers AND already-signed-
// in players who never went through signup (e.g. the original alpha
// cohort that predates the consent gate).

const STORAGE_KEY = "pkmn-disclaimer-ack-v1";

function isAcked(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private browsing / disabled storage — treat as acked so we don't
    // pester the user every reload (they've effectively opted in by
    // continuing past the splash anyway).
    return true;
  }
}

function setAcked(): void {
  try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* */ }
}

export function FirstVisitDisclaimer() {
  const [open, setOpen] = useState(() => !isAcked());
  const dialogRef = useModalEnter();
  const isStream = useStreamMode();
  const t = useT();

  // Stream auto-login sessions must never sit behind the disclaimer — an
  // unattended OBS box can't click "I understand". Once the profile
  // resolves and flags the session as a stream, silently ack + close.
  useEffect(() => {
    if (isStream && open) { setAcked(); setOpen(false); }
  }, [isStream, open]);

  // Lock body scroll while the disclaimer is open so the player can't
  // scroll the page underneath. Restore on unmount.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const accept = () => {
    setAcked();
    setOpen(false);
  };

  return (
    <div className="modal-overlay disclaimer-overlay">
      <div
        ref={dialogRef}
        className="g-modal disclaimer-modal"
        role="dialog"
        aria-label={t("Fan-game disclaimer")}
        aria-modal="true"
      >
        <header className="g-modal-head">
          <h2>{t("Welcome, trainer")}</h2>
        </header>
        <div className="g-modal-body disclaimer-body">
          <p className="disclaimer-lead">
            {t("Pokémon Idle is an ")}<strong>{t("unofficial fan project")}</strong>{t(". It isn't affiliated with, endorsed by, or sponsored by Nintendo, Game Freak, Creatures Inc., or The Pokémon Company.")}
          </p>
          <ul className="disclaimer-points">
            <li>
              {t("Pokémon names, sprites, and type icons are trademarks of their respective owners. They're used here non-commercially in a fan-built browser game.")}
            </li>
            <li>
              {t("No copyrighted Pokémon assets are stored on our servers — sprites load at runtime from public third-party CDNs.")}
            </li>
            <li>
              {t("The Service is free. No ads, no payments, no virtual currency that maps to real money.")}
            </li>
          </ul>
          <p className="disclaimer-contact">
            {t("Issues, bug reports, or takedown requests?")}{" "}
            <a href="mailto:contact@pokeidle.com">contact@pokeidle.com</a>
          </p>
        </div>
        <footer className="g-modal-foot disclaimer-foot">
          <button
            type="button"
            className="g-btn-primary disclaimer-accept"
            onClick={accept}
            autoFocus
          >
            {t("I understand — let me play")}
          </button>
        </footer>
      </div>
    </div>
  );
}
