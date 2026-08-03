// One copy of the auction house's state, shared by the two halves of the page.
//
// ── WHY A STORE AND NOT COMPONENT STATE ───────────────────────────────────
// The redesign is master/detail: a grid of lots on the left, and the selected
// lot's full detail and bid form in the hub's third column. The hub renders
// Body and Aside as SIBLINGS — it composes them itself — so they cannot share
// React state through a common parent, and a context provider would have to
// wrap the hub frame rather than the section.
//
// Everything they both need therefore lives here: the lots, the selection,
// and the live bid ticks. One fetch, one socket subscription, two readers.
//
// The alternative — fetching in both halves — was rejected on a precedent
// this codebase has already paid for once: the serializer's doc comment
// records a Postgres connection-ceiling incident caused by exactly that shape
// of duplicated query.

import { useCallback, useSyncExternalStore } from "react";
import { api, type PublicAuction } from "../net/api";
import {
  watchAuction, unwatchAuction, onAuctionBid, onAuctionOutbid, onAuctionProxyDropped,
} from "./auctions";
import { conservativeMinBid } from "../utils/auctionBidRules";

export interface AuctionStoreState {
  lots: PublicAuction[];
  /** id of the lot open in the detail panel, or null. */
  selectedId: string | null;
  loading: boolean;
  /** Lots whose stored maximum the player's balance can no longer cover. */
  pausedIds: ReadonlySet<string>;
  /** Bumped on every mutation so subscribers re-read. */
  rev: number;
}

let state: AuctionStoreState = {
  lots: [],
  selectedId: null,
  loading: true,
  pausedIds: new Set(),
  rev: 0,
};

const listeners = new Set<() => void>();
function emit(next: Partial<AuctionStoreState>) {
  state = { ...state, ...next, rev: state.rev + 1 };
  for (const fn of listeners) fn();
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const snapshot = () => state;

export function useAuctionStore(): AuctionStoreState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The selected lot, re-read from the live list so its price stays current. */
export function useSelectedLot(): PublicAuction | null {
  const s = useAuctionStore();
  return s.lots.find((l) => l.id === s.selectedId) ?? null;
}

export function selectLot(id: string | null) {
  emit({ selectedId: id });
}

/**
 * Fold a live bid tick into a lot, recomputing the displayed minimum.
 * `conservativeMinBid` deliberately errs HIGH — see its doc comment.
 */
function applyBidTick(a: PublicAuction, e: {
  amount: number; username: string; endsAt: string; bidCount?: number; distinctBidders?: number;
}): PublicAuction {
  const next = {
    ...a,
    currentBid: e.amount,
    currentBidderUsername: e.username,
    endsAt: e.endsAt,
    bidCount: e.bidCount ?? a.bidCount + 1,
    distinctBidders: e.distinctBidders ?? a.distinctBidders,
  };
  const minNextBid = conservativeMinBid(next);
  return { ...next, minNextBid, minIncrement: next.currentBid > 0 ? minNextBid - next.currentBid : 0 };
}

/** Replace one lot in place, keeping selection and order. */
export function patchLot(id: string, patch: Partial<PublicAuction>) {
  emit({ lots: state.lots.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
}

export async function refreshLots(): Promise<void> {
  emit({ loading: true });
  try {
    const res = await api.listAuctions();
    emit({ lots: res.auctions, loading: false });
    // A lot can settle or be cancelled while the panel is open. Keeping a
    // selection that is no longer in the list would leave the detail panel
    // showing a price nobody can bid on.
    if (state.selectedId && !res.auctions.some((a) => a.id === state.selectedId)) {
      emit({ selectedId: null });
    }
  } catch {
    emit({ loading: false });
  }
}

/**
 * Start the live layer: poll, watch every visible lot, and fold in ticks.
 * Returns a teardown. Called once by the page.
 */
export function startAuctionFeed(): () => void {
  let cancelled = false;
  void refreshLots();
  const poll = window.setInterval(() => { if (!cancelled) void refreshLots(); }, 20_000);

  const offBid = onAuctionBid((e) => {
    emit({ lots: state.lots.map((a) => (a.id === e.auctionId ? applyBidTick(a, e) : a)) });
  });
  // Losing the lead is the ONE thing a bid tick cannot tell us — a tick may
  // equally be our own proxy defending — so it comes from the server.
  const offOutbid = onAuctionOutbid((e) => {
    emit({
      lots: state.lots.map((a) => (a.id === e.auctionId
        ? { ...a, youAreHighBidder: false, yourMax: null }
        : a)),
    });
  });
  const offDropped = onAuctionProxyDropped((e) => {
    const next = new Set(state.pausedIds);
    next.add(e.auctionId);
    emit({ pausedIds: next });
  });

  // Watch/unwatch follows the visible set. Recomputed from the store rather
  // than captured, so a poll that brings in new lots subscribes them too.
  let watched: string[] = [];
  const syncWatch = () => {
    const ids = state.lots.map((a) => a.id);
    for (const id of ids) if (!watched.includes(id)) watchAuction(id);
    for (const id of watched) if (!ids.includes(id)) unwatchAuction(id);
    watched = ids;
  };
  const offWatch = subscribe(syncWatch);

  return () => {
    cancelled = true;
    window.clearInterval(poll);
    offBid(); offOutbid(); offDropped(); offWatch();
    for (const id of watched) unwatchAuction(id);
    watched = [];
  };
}

/** Stable callback for selecting, so cards don't re-render on every tick. */
export function useSelectLot() {
  return useCallback((id: string | null) => selectLot(id), []);
}
