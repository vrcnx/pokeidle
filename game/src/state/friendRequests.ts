import { useEffect, useState } from "react";
import { api } from "../net/api";

// Tiny module-scoped store for the incoming friend-request count, so
// the MetaDock Social button can light up with a badge when a request
// arrives — DrWhy reported the Social tab "doesn't light up if a
// request is there unless you hit it", which was true: the dock had
// no awareness of friend state.
//
// We poll /api/friends every 30s instead of pushing via socket because
// the server doesn't currently emit a friend:request event — polling
// is simple, low-cost, and survives reconnects without extra wiring.
// SocialPanel already calls listFriends() on open, so the polled
// value just keeps the dock badge fresh while the modal is closed.

let _count = 0;
const _listeners = new Set<(n: number) => void>();
let _pollTimer: number | null = null;
let _refCount = 0;

function emit() {
  for (const fn of _listeners) fn(_count);
}

async function refresh() {
  try {
    const list = await api.listFriends();
    const next = list.incoming.length;
    if (next !== _count) {
      _count = next;
      emit();
    }
  } catch {
    // Network blip — leave stale count alone.
  }
}

function ensurePolling() {
  if (_pollTimer != null) return;
  void refresh();
  _pollTimer = window.setInterval(() => {
    if (!document.hidden) void refresh();
  }, 30_000);
}
function stopPolling() {
  if (_pollTimer != null) {
    window.clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// Hook returns the live count + a `refresh` poker. Mounts ref-count
// so polling stops when no consumer is listening (signed-out state).
export function useIncomingRequestCount(): { count: number; refresh: () => Promise<void> } {
  const [n, setN] = useState(_count);
  useEffect(() => {
    _listeners.add(setN);
    _refCount++;
    ensurePolling();
    return () => {
      _listeners.delete(setN);
      _refCount--;
      if (_refCount <= 0) stopPolling();
    };
  }, []);
  return { count: n, refresh };
}

// One-shot refresh hook for code paths that act on a request (accept,
// decline) — bumps the count down immediately rather than waiting for
// the next poll tick.
export function refreshIncomingRequests(): Promise<void> {
  return refresh();
}
