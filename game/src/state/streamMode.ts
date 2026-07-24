import { useEffect, useState } from "react";

// Stream automation config (admin-set per StreamKey). Mirrors the server's
// StreamConfig; delivered to the client on /api/profile/me for a stream
// session. Applied on boot: travel to startRoute, auto-buy balls when low.
export interface StreamConfig {
  startRoute?: string;
  autoBuyBalls?: { enabled: boolean; ballId: string; restockTo: number };
  autoProceed?: boolean;
  autoCatch?: boolean;
  speed?: number;
}

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
let _config: StreamConfig | null = null;
const subs = new Set<() => void>();

function notify() {
  for (const f of subs) {
    try { f(); } catch { /* subscriber threw — ignore */ }
  }
}

export function setStreamMode(v: boolean, config: StreamConfig | null = null): void {
  const changed = _isStream !== v || _config !== config;
  _isStream = v;
  _config = v ? config : null;
  if (changed) notify();
}

export function isStreamMode(): boolean {
  return _isStream;
}

export function getStreamConfig(): StreamConfig | null {
  return _config;
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

export function useStreamConfig(): StreamConfig | null {
  const [v, setV] = useState(_config);
  useEffect(() => {
    const f = () => setV(_config);
    subs.add(f);
    f();
    return () => { subs.delete(f); };
  }, []);
  return v;
}
