import { useEffect, useState } from "react";
import { api, type PublicAuction, type AuctionBid } from "../net/api";
import { useGame } from "../state/GameContext";
import { PokemonSprite } from "./Sprite";
import { watchAuction, unwatchAuction, onAuctionBid } from "../state/auctions";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";

type BoardView = "browse" | "list" | "mine";

function timeLeft(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "ending…";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Replaces the old free-text "offering X for Y" trade cards: pick a
// specific Pokemon (by its stable id), other players bid real in-game
// money, highest bid when the timer runs out wins. Settlement is fully
// server-side (see server/src/lib/auctionSettlement.ts) — a listing
// resolves whether or not either party is online when it ends.
export function AuctionBoard() {
  const { state, dispatch } = useGame();
  const t = useT();
  const [view, setView] = useState<BoardView>("browse");
  const [auctions, setAuctions] = useState<PublicAuction[]>([]);
  const [mine, setMine] = useState<{ selling: PublicAuction[]; bidding: PublicAuction[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.listAuctions()
      .then((res) => setAuctions(res.auctions))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };
  // Refetch the "My Auctions" lists (Selling + Bidding on). Used after the
  // player places a bid from that view — previously it called `load`, which
  // refetches the BROWSE list instead, so the player's own bid never showed
  // until they manually refreshed the page (reported by RaQaR).
  const loadMine = () => {
    api.myAuctions().then((res) => {
      setMine(res);
      // The authoritative refresh of the escrow guard. The server escrows a
      // listed Pokémon but the client keeps it in the box, so without this it
      // stays releasable, depositable and sweepable by a bulk release while it
      // is already sold. GET /mine returns listings of ANY status, so only
      // "active" ones are still escrowed — a sold or cancelled one must drop off
      // the list or the mon would stay locked forever.
      dispatch({
        type: "SET_LISTED_POKEMON_IDS",
        payload: {
          ids: res.selling
            .filter((a) => a.status === "active")
            .map((a) => (a.pokemon as Pokemon | null)?.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        },
      });
    }).catch(() => undefined);
  };
  useEffect(load, []);
  useEffect(() => {
    if (view !== "browse") return;
    const interval = window.setInterval(load, 20_000);
    return () => window.clearInterval(interval);
  }, [view]);

  // Live bid ticks for whichever auctions are currently on screen.
  useEffect(() => {
    if (view !== "browse") return;
    for (const a of auctions) watchAuction(a.id);
    const off = onAuctionBid((e) => {
      setAuctions((prev) => prev.map((a) => a.id === e.auctionId
        ? { ...a, currentBid: e.amount, currentBidderUsername: e.username, endsAt: e.endsAt, bidCount: a.bidCount + 1 }
        : a));
    });
    return () => {
      off();
      for (const a of auctions) unwatchAuction(a.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, auctions.map((a) => a.id).join(",")]);

  useEffect(() => {
    if (view !== "mine") return;
    loadMine();
    // Live bid ticks for the auctions the player is bidding on / selling, so
    // the amounts update in place instead of only after a manual refresh.
    const watched = [...(mine?.bidding ?? []), ...(mine?.selling ?? [])];
    for (const a of watched) watchAuction(a.id);
    const off = onAuctionBid((e) => {
      setMine((prev) => prev && ({
        selling: prev.selling.map((a) => a.id === e.auctionId
          ? { ...a, currentBid: e.amount, currentBidderUsername: e.username, endsAt: e.endsAt, bidCount: a.bidCount + 1 } : a),
        bidding: prev.bidding.map((a) => a.id === e.auctionId
          ? { ...a, currentBid: e.amount, currentBidderUsername: e.username, endsAt: e.endsAt, bidCount: a.bidCount + 1 } : a),
      }));
    });
    return () => { off(); for (const a of watched) unwatchAuction(a.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, (mine?.bidding ?? []).map((a) => a.id).join(","), (mine?.selling ?? []).map((a) => a.id).join(",")]);

  return (
    <div className="auction-board">
      <div className="auction-board-tabs">
        <div className="auction-board-seg" role="tablist">
          <button
            role="tab"
            aria-selected={view === "browse"}
            className={`auction-board-tab ${view === "browse" ? "active" : ""}`}
            onClick={() => setView("browse")}
          >
            {t("Browse")}
          </button>
          <button
            role="tab"
            aria-selected={view === "mine"}
            className={`auction-board-tab ${view === "mine" ? "active" : ""}`}
            onClick={() => setView("mine")}
          >
            {t("My Auctions")}
          </button>
        </div>
        <button className="g-btn-primary g-btn-small auction-board-list-btn" onClick={() => setView("list")}>
          + {t("List a Pokemon")}
        </button>
      </div>

      {view === "browse" && (
        <div className="auction-board-list">
          {loading && auctions.length === 0 && <div className="dim small">{t("Loading…")}</div>}
          {!loading && auctions.length === 0 && <div className="dim small">{t("No active auctions right now.")}</div>}
          {auctions.map((a) => (
            <AuctionCard key={a.id} auction={a} onBid={load} />
          ))}
        </div>
      )}

      {view === "mine" && (
        <div className="auction-board-list">
          <h4 className="auction-board-subhead">{t("Selling")}</h4>
          {(mine?.selling.length ?? 0) === 0 && <div className="dim small">{t("You have no listings.")}</div>}
          {mine?.selling.map((a) => <AuctionCard key={a.id} auction={a} onBid={() => {}} readOnly />)}
          <h4 className="auction-board-subhead">{t("Bidding on")}</h4>
          {(mine?.bidding.length ?? 0) === 0 && <div className="dim small">{t("You haven't bid on anything.")}</div>}
          {mine?.bidding.map((a) => <AuctionCard key={a.id} auction={a} onBid={loadMine} />)}
        </div>
      )}

      {view === "list" && (
        <ListPokemonForm
          party={state.party}
          box={state.box}
          onDone={() => { setView("browse"); load(); }}
          onCancel={() => setView("browse")}
        />
      )}
    </div>
  );
}

function AuctionCard({ auction, onBid, readOnly }: { auction: PublicAuction; onBid: () => void; readOnly?: boolean }) {
  const t = useT();
  const { syncNow } = useGame();
  const mon = auction.pokemon as (Pokemon & { speciesKey: string }) | null;
  const [amount, setAmount] = useState<number>(auction.currentBid > 0 ? auction.currentBid + 1 : auction.startingBid);
  const [busy, setBusy] = useState(false);
  const [showBids, setShowBids] = useState(false);
  const [bids, setBids] = useState<AuctionBid[] | null>(null);

  const bid = async () => {
    setBusy(true);
    try {
      // Flush the player's live money to the cloud FIRST — the server checks
      // the bid against last-uploaded saveData, so without this a player who
      // just earned money (but hasn't autosaved yet) gets a wrong "insufficient
      // funds" rejection. This is the "no funds despite 67M" fix.
      await syncNow();
      await api.placeBid(auction.id, amount);
      pushToast({ kind: "success", text: t("Bid placed!") });
      onBid();
    } catch (e: any) {
      pushToast({ kind: "warn", text: e?.message ?? t("Couldn't place bid.") });
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setBusy(true);
    api.cancelAuction(auction.id)
      .then(() => { pushToast({ kind: "success", text: t("Listing cancelled.") }); onBid(); })
      .catch((e) => pushToast({ kind: "warn", text: e?.message ?? t("Couldn't cancel.") }))
      .finally(() => setBusy(false));
  };
  const toggleBids = () => {
    if (!showBids && !bids) {
      api.getAuction(auction.id).then((res) => setBids(res.bids)).catch(() => undefined);
    }
    setShowBids((s) => !s);
  };

  return (
    <div className="auction-card">
      <div className="auction-card-mon">
        {mon && (
          <PokemonSprite
            speciesKey={mon.speciesKey}
            isShiny={!!mon.isShiny}
            alt=""
            className="auction-card-sprite"
            loading="lazy"
          />
        )}
        <div>
          <strong>{mon?.isShiny ? "✨ " : ""}{mon?.nickname ?? mon?.name ?? "?"}</strong>
          <div className="dim small">Lv{mon?.level ?? "?"} · {auction.sellerUsername ?? "?"}</div>
        </div>
      </div>
      <div className="auction-card-bid-info">
        <div>
          <span className="dim small">{auction.bidCount > 0 ? t("Current bid") : t("Starting bid")}</span>
          <strong className="auction-card-amount">${auction.currentBid > 0 ? auction.currentBid : auction.startingBid}</strong>
        </div>
        <div className="dim small">{t("Ends in")} {timeLeft(auction.endsAt)} · {auction.bidCount} {t("bids")}</div>
        <button type="button" className="auction-card-bidlink" onClick={toggleBids}>
          {showBids ? t("Hide bids") : t("Show bids")}
        </button>
        {showBids && bids && (
          <ul className="auction-card-bid-history">
            {bids.length === 0 && <li className="dim small">{t("No bids yet.")}</li>}
            {bids.map((b) => <li key={b.id}>{b.username} — ${b.amount}</li>)}
          </ul>
        )}
      </div>
      {!readOnly && (
        <div className="auction-card-actions">
          <input
            type="number"
            min={auction.currentBid > 0 ? auction.currentBid + 1 : auction.startingBid}
            value={amount}
            onChange={(e) => setAmount(parseInt(e.target.value, 10) || 0)}
          />
          <button className="g-btn-primary g-btn-small" disabled={busy} onClick={bid}>{t("Bid")}</button>
        </div>
      )}
      {readOnly && auction.currentBidderUsername === null && auction.status === "active" && (
        <div className="auction-card-actions">
          <button className="g-btn-ghost g-btn-small" disabled={busy} onClick={cancel}>{t("Cancel listing")}</button>
        </div>
      )}
    </div>
  );
}

function ListPokemonForm({
  party, box, onDone, onCancel,
}: { party: Pokemon[]; box: Pokemon[]; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const { syncNow, dispatch } = useGame();
  const [picked, setPicked] = useState<Pokemon | null>(null);
  const [startingBid, setStartingBid] = useState(100);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [busy, setBusy] = useState(false);

  const eligible = [
    ...party.map((p) => ({ mon: p, from: "party" as const })),
    ...box.map((p) => ({ mon: p, from: "box" as const })),
  ];

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      // Flush the live save first so the server can see (and escrow) the
      // Pokémon — a just-caught mon that hasn't autosaved yet would otherwise
      // fail the "you don't own that Pokemon" ownership check.
      await syncNow();
      await api.createAuction({ pokemonId: picked.id, startingBid, durationMinutes });
      // Optimistic half of the escrow guard, so the mon is protected the instant
      // it is listed rather than whenever the player next opens the "mine" tab.
      // loadMine's SET_LISTED_POKEMON_IDS is the authoritative correction.
      dispatch({ type: "MARK_POKEMON_LISTED", payload: { pokemonId: picked.id } });
      pushToast({ kind: "success", text: t("Listed!") });
      onDone();
    } catch (e: any) {
      pushToast({ kind: "warn", text: e?.message ?? t("Couldn't list that Pokemon.") });
    } finally {
      setBusy(false);
    }
  };

  if (!picked) {
    return (
      <div className="auction-list-form">
        <p className="dim small">{t("Pick a Pokemon to list.")}</p>
        <div className="auction-picker-grid">
          {eligible.map(({ mon, from }) => (
            <button
              key={mon.id}
              type="button"
              className="auction-picker-item"
              disabled={from === "party" && party.length <= 1}
              title={from === "party" && party.length <= 1 ? t("Can't list your only Pokemon") : undefined}
              onClick={() => setPicked(mon)}
            >
              <PokemonSprite speciesKey={mon.speciesKey} isShiny={!!mon.isShiny} alt="" loading="lazy" />
              <span>{mon.isShiny ? "✨ " : ""}{mon.nickname ?? mon.name} <span className="dim">Lv{mon.level}</span></span>
            </button>
          ))}
        </div>
        <button className="g-btn-ghost g-btn-small" onClick={onCancel}>{t("Cancel")}</button>
      </div>
    );
  }

  return (
    <div className="auction-list-form">
      <div className="auction-card-mon">
        <PokemonSprite speciesKey={picked.speciesKey} isShiny={!!picked.isShiny} alt="" className="auction-card-sprite" />
        <div>
          <strong>{picked.isShiny ? "✨ " : ""}{picked.nickname ?? picked.name}</strong>
          <div className="dim small">Lv{picked.level}</div>
        </div>
      </div>
      <label className="auction-list-field">
        {t("Starting bid")}
        <input type="number" min={1} max={999999999} value={startingBid} onChange={(e) => setStartingBid(parseInt(e.target.value, 10) || 1)} />
      </label>
      <label className="auction-list-field">
        {t("Duration")}
        <select value={durationMinutes} onChange={(e) => setDurationMinutes(parseInt(e.target.value, 10))}>
          <option value={60}>{t("1 hour")}</option>
          <option value={360}>{t("6 hours")}</option>
          <option value={1440}>{t("24 hours")}</option>
          <option value={2880}>{t("48 hours")}</option>
        </select>
      </label>
      <div className="auction-list-actions">
        <button className="g-btn-ghost g-btn-small" onClick={() => setPicked(null)}>{t("Back")}</button>
        <button className="g-btn-primary g-btn-small" disabled={busy} onClick={submit}>{t("List for auction")}</button>
      </div>
    </div>
  );
}
