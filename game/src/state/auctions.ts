import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";

// UI-facing auction state: a notification queue (outbid/won/sold/
// cancelled/expired toasts) plus thin socket wrappers for watching a
// listing's live bid feed. Mirrors state/trade.ts's module-scoped
// pub/sub shape.
//
// "won"/"sold" are the two events that mutate local save state (money +
// a Pokemon moving in/out of party or box) — those are bound directly in
// GameContext.tsx instead of here, since only that component holds the
// dispatch + cloudVersionRef needed to reconcile correctly. This module
// still queues a notification for them (via pushAuctionNotification,
// called from GameContext.tsx after it reconciles) so the toast has one
// place to read from regardless of which event produced it.

export interface AuctionNotification {
  id: string;
  kind: "outbid" | "won" | "sold" | "cancelled" | "expired";
  auctionId: string;
  text: string;
}

interface AuctionUiState {
  notifications: AuctionNotification[];
}

const _state: AuctionUiState = { notifications: [] };
const _listeners = new Set<(s: AuctionUiState) => void>();
function emit() {
  const snap = { notifications: [..._state.notifications] };
  for (const fn of _listeners) fn(snap);
}

export function useAuctionNotifications(): AuctionNotification[] {
  const [s, setS] = useState<AuctionUiState>(_state);
  useEffect(() => {
    _listeners.add(setS);
    return () => { _listeners.delete(setS); };
  }, []);
  return s.notifications;
}

let _seq = 0;
export function pushAuctionNotification(kind: AuctionNotification["kind"], auctionId: string, text: string): void {
  const id = `an_${_seq++}`;
  _state.notifications = [..._state.notifications, { id, kind, auctionId, text }];
  emit();
  setTimeout(() => dismissAuctionNotification(id), 6000);
}

export function dismissAuctionNotification(id: string): void {
  _state.notifications = _state.notifications.filter((n) => n.id !== id);
  emit();
}

export function watchAuction(auctionId: string): void {
  getSocket().emit("auction:watch", { auctionId });
}
export function unwatchAuction(auctionId: string): void {
  getSocket().emit("auction:unwatch", { auctionId });
}

export interface AuctionBidEvent {
  auctionId: string;
  amount: number;
  username: string;
  endsAt: string;
}
type BidListener = (e: AuctionBidEvent) => void;
const _bidListeners = new Set<BidListener>();
// Live bid ticks for whichever auction(s) a component is currently
// watching (paired with watchAuction/unwatchAuction above).
export function onAuctionBid(fn: BidListener): () => void {
  _bidListeners.add(fn);
  return () => { _bidListeners.delete(fn); };
}

let _bound = false;
export function bindAuctionUiSocket(): void {
  if (_bound) return;
  _bound = true;
  const sock = getSocket();

  sock.on("auction:bid", (payload: AuctionBidEvent) => {
    for (const fn of _bidListeners) fn(payload);
  });
  sock.on("auction:outbid", (payload: { auctionId: string; amount: number; username: string }) => {
    pushAuctionNotification("outbid", payload.auctionId, `${payload.username} outbid you at $${payload.amount}.`);
  });
  sock.on("auction:cancelled", (payload: { auctionId: string; reason: string }) => {
    pushAuctionNotification("cancelled", payload.auctionId, `An auction was cancelled (${payload.reason.replace(/_/g, " ")}).`);
  });
  sock.on("auction:expired", (payload: { auctionId: string }) => {
    pushAuctionNotification("expired", payload.auctionId, "Your auction ended with no bids.");
  });
}
