import { useEffect, useState } from "react";
import { getSocket } from "../net/socket";
import type { Pokemon } from "../types";

// Module-scoped state for an in-flight peer trade. One trade at a time
// is enough — the server enforces the same rule. The shape mirrors what
// the server broadcasts in trade:state events plus the local-side
// metadata we need (the trade id, the other player's identity, etc.).

export interface TradeOffer {
  id: string;
  speciesKey: string;
  level: number;
  name: string;
  nickname?: string | null;
  isShiny: boolean;
  heldItem: string | null;
  // Plus everything else on the Pokemon — the actual Pokemon shape is
  // round-tripped through the server unchanged. We don't bother typing
  // every field here; consumers cast it back to Pokemon when they
  // commit it via TRADE_COMPLETE.
  [extra: string]: unknown;
}

export interface IncomingInvite {
  tradeId: string;
  from: { id: string; username: string };
  expiresAt: number;
}

export interface RoomState {
  tradeId: string;
  other: { id: string; username: string };
  expiresAt: number;
  // Mirror of what the server broadcasts in trade:state.
  // null on offer means "not picked yet"; locked is each side's lock-in.
  myOffer: TradeOffer | null;
  myLocked: boolean;
  theirOffer: TradeOffer | null;
  theirLocked: boolean;
  // When both sides lock and both have offers, the server fires a
  // trade:complete event which gets stashed here so the UI can play the
  // animation + dispatch the swap.
  completion: TradeCompletion | null;
}

export interface TradeCompletion {
  tradeId: string;
  sentMonId: string;
  received: TradeOffer;
  otherUser: { id: string; username: string };
}

interface TradeState {
  // Active invite a friend just sent us — toast component shows accept/decline.
  invite: IncomingInvite | null;
  // Active trade room (after either side accepts).
  room: RoomState | null;
  // Last-shown banner when a trade was cancelled — string survives a
  // beat so the user can see why before it disappears.
  cancelMessage: string | null;
}

const _state: TradeState = { invite: null, room: null, cancelMessage: null };
const _listeners = new Set<(s: TradeState) => void>();

function emit() {
  const snap = { ..._state };
  for (const fn of _listeners) fn(snap);
}

export function useTradeState(): TradeState {
  const [s, setS] = useState<TradeState>(_state);
  useEffect(() => {
    _listeners.add(setS);
    return () => { _listeners.delete(setS); };
  }, []);
  return s;
}

// Public actions — small wrappers around socket emits so components don't
// have to know the wire format.

export function sendTradeInvite(toUserId: string, ack?: (r: { ok: boolean; error?: string }) => void) {
  getSocket().emit("trade:invite", { toUserId }, ack);
}
export function respondToInvite(tradeId: string, accept: boolean, ack?: (r: { ok: boolean; error?: string }) => void) {
  getSocket().emit("trade:respond", { tradeId, accept }, ack);
  if (!accept) {
    _state.invite = null;
    emit();
  }
}
export function dismissInvite() {
  _state.invite = null;
  emit();
}
export function setOffer(tradeId: string, mon: Pokemon | null) {
  // Send the full Pokemon as-is; the server just relays it back to the
  // other side, so all of nickname/IVs/EVs/totalExp/heldItem ride along.
  const offer = mon ? (mon as unknown as TradeOffer) : null;
  getSocket().emit("trade:offer", { tradeId, offer });
}
export function setLock(tradeId: string, locked: boolean) {
  getSocket().emit("trade:lock", { tradeId, locked });
}
export function cancelTrade(tradeId: string) {
  getSocket().emit("trade:cancel", { tradeId });
}
export function clearRoom() {
  _state.room = null;
  emit();
}
export function clearCancelMessage() {
  _state.cancelMessage = null;
  emit();
}

// Bind socket listeners exactly once. Called from main.tsx (or any
// component that mounts at startup) so the trade state stays live for
// the whole session — incoming invites can land while the user is
// looking at any screen.
let _bound = false;
// Handle for the cancel-banner auto-dismiss timer. Tracked at module
// scope so a back-to-back cancel can clear the prior pending dismiss
// instead of leaving an orphaned timer that fires later and stomps
// the new banner.
let _cancelBannerTimer: ReturnType<typeof setTimeout> | null = null;
export function bindTradeSocket() {
  if (_bound) return;
  _bound = true;
  const sock = getSocket();

  sock.on("trade:invite", (payload: IncomingInvite) => {
    _state.invite = payload;
    _state.cancelMessage = null;
    emit();
  });

  sock.on(
    "trade:start",
    (payload: { tradeId: string; other: { id: string; username: string }; expiresAt: number }) => {
      _state.invite = null;
      _state.room = {
        tradeId: payload.tradeId,
        other: payload.other,
        expiresAt: payload.expiresAt,
        myOffer: null,
        myLocked: false,
        theirOffer: null,
        theirLocked: false,
        completion: null,
      };
      _state.cancelMessage = null;
      emit();
    }
  );

  sock.on(
    "trade:state",
    (payload: {
      tradeId: string;
      a: { userId: string; hasOffer: boolean; locked: boolean; offer: TradeOffer | null };
      b: { userId: string; hasOffer: boolean; locked: boolean; offer: TradeOffer | null };
    }) => {
      const room = _state.room;
      if (!room || room.tradeId !== payload.tradeId) return;
      const me = payload.a.userId === room.other.id ? payload.b : payload.a;
      const them = payload.a.userId === room.other.id ? payload.a : payload.b;
      _state.room = {
        ...room,
        myOffer: me.offer,
        myLocked: me.locked,
        theirOffer: them.offer,
        theirLocked: them.locked,
      };
      emit();
    }
  );

  sock.on("trade:complete", (payload: TradeCompletion) => {
    if (_state.room && _state.room.tradeId === payload.tradeId) {
      _state.room = { ..._state.room, completion: payload };
      emit();
    }
  });

  sock.on("trade:cancelled", (payload: { tradeId: string; reason: string }) => {
    // Only show banner if it affected us.
    const affected =
      _state.invite?.tradeId === payload.tradeId ||
      _state.room?.tradeId === payload.tradeId;
    if (!affected) return;
    _state.invite = null;
    _state.room = null;
    _state.cancelMessage = payload.reason;
    emit();
    // Clear the banner after a few seconds so it doesn't linger.
    // Replace any in-flight dismiss timer first so a quick re-cancel
    // doesn't leave a stale timer that wipes the newer banner.
    if (_cancelBannerTimer) clearTimeout(_cancelBannerTimer);
    _cancelBannerTimer = setTimeout(() => {
      _cancelBannerTimer = null;
      if (_state.cancelMessage === payload.reason) {
        _state.cancelMessage = null;
        emit();
      }
    }, 5000);
  });
}
