import { useEffect, useState } from "react";

// Stream-mode singleton.
//
// True when the current session is a restricted OBS/24-7 stream auto-login
// (server sets isStream on /api/profile/me). Kept as a module singleton +
// subscribe hook rather than only on the Auth context so ANY component can
// gate stream-only behaviour — including ones that mount before the profile
// resolves (e.g. FirstVisitDisclaimer) or sit outside the Auth provider.
//
// Stream sessions use this to auto-dismiss nuisance popups (What's New,
// daily reward, first-visit disclaimer) and hide sensitive UI (trades,
// auctions, account settings) so an unattended stream never gets stuck
// behind a dialog and a leaked link can't reach a destructive control.

let _isStream = false;
const subs = new Set<() => void>();

export function setStreamMode(v: boolean): void {
  if (_isStream === v) return;
  _isStream = v;
  for (const f of subs) {
    try { f(); } catch { /* subscriber threw — ignore */ }
  }
}

export function isStreamMode(): boolean {
  return _isStream;
}

export function useStreamMode(): boolean {
  const [v, setV] = useState(_isStream);
  useEffect(() => {
    const f = () => setV(_isStream);
    subs.add(f);
    f(); // sync in case it flipped between initial render and effect
    return () => { subs.delete(f); };
  }, []);
  return v;
}
