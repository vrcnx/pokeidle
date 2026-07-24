import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import { isStreamMode } from "../state/streamMode";

// Detects when a newer build has deployed and prompts the player to reload.
//
// How: every build bakes a unique __BUILD_ID__ into the bundle AND writes
// the same id into /version.json. A running client polls version.json; when
// the id there no longer matches the one it booted with, a newer build is
// live and the player is holding stale code. We surface a persistent,
// one-tap "Reload" — never a forced reload, which would nuke unsaved UI
// state mid-action.
//
// In dev there is no version.json (it's emitted only at build), so the
// check simply no-ops — no false prompts.

async function isNewBuildAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { buildId?: unknown };
    return (
      typeof data?.buildId === "string" &&
      data.buildId.length > 0 &&
      typeof __BUILD_ID__ === "string" &&
      data.buildId !== __BUILD_ID__
    );
  } catch {
    return false;
  }
}

export function UpdateNotice() {
  const t = useT();
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const availableRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (cancelled || availableRef.current) return;
      if (await isNewBuildAvailable() && !cancelled) {
        availableRef.current = true;
        // A stream has nobody to click "reload", so it would sit on a stale
        // build indefinitely after a frontend deploy. Reload it automatically
        // — the save is server-backed and the stream session re-authenticates
        // from its cookie, so nothing is lost. Short delay so an in-flight
        // autosave lands first.
        if (isStreamMode()) {
          setTimeout(() => window.location.reload(), 3000);
          return;
        }
        setAvailable(true);
      }
    };
    // Check on mount, every 5 minutes, and whenever the tab regains focus —
    // players leave the game open for hours, so a poll plus a focus check
    // catches a deploy without hammering the network.
    void check();
    const iv = window.setInterval(check, 5 * 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!available || dismissed) return null;

  return (
    <div className="update-notice" role="status" aria-live="polite">
      <span className="update-notice-icon" aria-hidden>✨</span>
      <span className="update-notice-text">{t("A new version of the game is available.")}</span>
      <button className="update-notice-btn" type="button" onClick={() => window.location.reload()}>
        {t("Reload")}
      </button>
      {/* This is a fixed-position pill that used to have no way to go away
          short of reloading — on mobile it sat directly over the bottom
          tab bar (see the CSS: it's repositioned above it there too), so
          without this a deploy could make navigation unreliable for the
          rest of the session. Dismissing just hides it; the next reload
          the player does on their own picks up the new build regardless. */}
      <button className="update-notice-dismiss" type="button" onClick={() => setDismissed(true)} aria-label={t("Dismiss")}>
        ×
      </button>
    </div>
  );
}
