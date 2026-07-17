import { useEffect, useRef, useState } from "react";

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
  const [available, setAvailable] = useState(false);
  const availableRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (cancelled || availableRef.current) return;
      if (await isNewBuildAvailable() && !cancelled) {
        availableRef.current = true;
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

  if (!available) return null;

  return (
    <div className="update-notice" role="status" aria-live="polite">
      <span className="update-notice-icon" aria-hidden>✨</span>
      <span className="update-notice-text">A new version of the game is available.</span>
      <button className="update-notice-btn" type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
