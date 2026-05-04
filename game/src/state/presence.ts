import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";

// Tiny module-scoped store for the global online-user count. The server
// broadcasts presence:count to every connected socket on connect and
// disconnect (so the value updates live as players come and go), and
// also pushes the current count to each socket the moment it connects
// so the UI has a real value to show without waiting for traffic.

let _count = 0;
const _listeners = new Set<(n: number) => void>();

function emit() {
  for (const fn of _listeners) fn(_count);
}

export function useOnlineCount(): number {
  const [n, setN] = useState(_count);
  useEffect(() => {
    _listeners.add(setN);
    return () => { _listeners.delete(setN); };
  }, []);
  return n;
}

let _bound = false;
export function bindPresenceSocket() {
  if (_bound) return;
  _bound = true;
  const sock = getSocket();
  sock.on("presence:count", (payload: { count: number }) => {
    if (typeof payload?.count !== "number") return;
    _count = payload.count;
    emit();
  });
}
