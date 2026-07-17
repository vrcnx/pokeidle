import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";
import { api, type Announcement } from "../net/api";

// Module-scoped store for the pinned server-wide banner, mirroring
// presence.ts. Three inputs keep it live:
//   1. a REST fetch on bind, so the very first paint (before the socket
//      has connected) already shows a live banner;
//   2. `announcement:set` socket events, pushed when an admin publishes or
//      clears one, and pushed to each socket on connect;
//   3. a local expiry timer, so a banner with an expiresAt vanishes on time
//      without needing the server to send a clear.

let _current: Announcement | null = null;
const _listeners = new Set<(a: Announcement | null) => void>();
let _expiryTimer: number | undefined;

function emit() {
  for (const fn of _listeners) fn(_current);
}

function isLive(a: Announcement | null, now = Date.now()): boolean {
  if (!a) return false;
  if (a.expiresAt && new Date(a.expiresAt).getTime() <= now) return false;
  return true;
}

function scheduleExpiry() {
  if (_expiryTimer !== undefined) {
    window.clearTimeout(_expiryTimer);
    _expiryTimer = undefined;
  }
  if (!_current?.expiresAt) return;
  const ms = new Date(_current.expiresAt).getTime() - Date.now();
  if (ms <= 0) return; // already handled by set()
  // setTimeout caps at ~24.8 days; anything beyond that we simply re-check
  // on the next set/fetch. Real banners expire in minutes to hours.
  _expiryTimer = window.setTimeout(() => {
    _current = null;
    emit();
  }, Math.min(ms, 2_147_483_647));
}

function set(next: Announcement | null) {
  _current = isLive(next) ? next : null;
  scheduleExpiry();
  emit();
}

export function useAnnouncement(): Announcement | null {
  const [a, setA] = useState(_current);
  useEffect(() => {
    _listeners.add(setA);
    return () => { _listeners.delete(setA); };
  }, []);
  return a;
}

let _bound = false;
// The socket is the authority (it delivers live publishes AND a push on
// connect). The REST fetch only exists to paint faster before the socket
// handshake completes. If the socket answers first — including a clear that
// the REST call can't see because it was already in flight — the late REST
// response must NOT resurrect a stale banner. So REST only applies while the
// socket has said nothing.
let _socketSpoke = false;

export function bindAnnouncementSocket() {
  if (_bound) return;
  _bound = true;

  api.getActiveAnnouncement()
    .then((r) => { if (!_socketSpoke) set(r.announcement); })
    .catch(() => { /* offline / not signed in — the socket push will cover it */ });

  const sock = getSocket();
  sock.on("announcement:set", (payload: { announcement: Announcement | null }) => {
    _socketSpoke = true;
    set(payload?.announcement ?? null);
  });
}
