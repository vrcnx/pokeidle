import { useEffect, useState } from "react";
import { api, type PublicAuction, type AuctionBid } from "../net/api";
import { useGame } from "../state/GameContext";
import { PokemonSprite } from "./Sprite";
import { genderSymbol } from "../data/gender";
import { HubViews } from "./HubModal";
import { valuePokemon, suggestedStartingBid, explain } from "../utils/pokemonValue";
import { abilityInfo } from "../data/abilities";
import {
  watchAuction, unwatchAuction, onAuctionBid, onAuctionOutbid, onAuctionProxyDropped,
} from "../state/auctions";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";
import {
  MIN_STARTING_BID, baseStepFor, bidFloorFor, concentrationRatio, conservativeMinBid,
  contestMultiplier, formatMoney, minIncrementFor, prefillBidAmount,
} from "../utils/auctionBidRules";
import "./auctionBoard.css";

type BoardView = "browse" | "list" | "mine";

/** Fold a live bid tick into a card, recomputing the displayed minimum.
 *  `conservativeMinBid` deliberately errs HIGH — see its doc comment. */
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
      setAuctions((prev) => prev.map((a) => (a.id === e.auctionId ? applyBidTick(a, e) : a)));
    });
    // Losing the lead is the ONE thing a bid tick cannot tell us (a tick may
    // equally be our own proxy defending), so take it from the server.
    const offOutbid = onAuctionOutbid((e) => {
      setAuctions((prev) => prev.map((a) => (a.id === e.auctionId
        ? { ...a, youAreHighBidder: false, yourMax: null } : a)));
    });
    return () => {
      off();
      offOutbid();
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
        selling: prev.selling.map((a) => (a.id === e.auctionId ? applyBidTick(a, e) : a)),
        bidding: prev.bidding.map((a) => (a.id === e.auctionId ? applyBidTick(a, e) : a)),
      }));
    });
    const offOutbid = onAuctionOutbid((e) => {
      setMine((prev) => prev && ({
        selling: prev.selling,
        bidding: prev.bidding.map((a) => (a.id === e.auctionId
          ? { ...a, youAreHighBidder: false, yourMax: null } : a)),
      }));
    });
    return () => { off(); offOutbid(); for (const a of watched) unwatchAuction(a.id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, (mine?.bidding ?? []).map((a) => a.id).join(","), (mine?.selling ?? []).map((a) => a.id).join(",")]);

  // A maximum the player's synced balance can no longer cover. Held here so
  // the badge survives re-renders of the card; GET /mine's balance check
  // (see AuctionCard) is the durable half that survives a reload.
  const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());
  useEffect(() => onAuctionProxyDropped((e) => {
    setPausedIds((prev) => new Set(prev).add(e.auctionId));
  }), []);

  return (
    <div className="auction-board">
      {/* The board's own controls go on the dialog's header bar, like every
          other hub section. In the chat rail this row cost 44px of a 300px
          column; here it was a second bar under the title saying which of
          three views you were in. */}
      <HubViews>
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
      </HubViews>

      {view === "browse" && (
        <div className="auction-board-list">
          {loading && auctions.length === 0 && <div className="dim small">{t("Loading…")}</div>}
          {!loading && auctions.length === 0 && <div className="dim small">{t("No active auctions right now.")}</div>}
          {auctions.map((a) => (
            <AuctionCard key={a.id} auction={a} onBid={load} proxyPaused={pausedIds.has(a.id)} />
          ))}
        </div>
      )}

      {view === "mine" && (
        /* MY AUCTIONS, rebuilt.
           It was two flat lists — "Selling" and "Bidding on" — rendering the
           same browse card, which meant the four questions a player actually
           opens this tab to ask were all unanswered:

             am I about to lose something?   (outbid, ending soon)
             did I win?                      (sold/settled, nothing said so)
             what am I owed?                 (no money anywhere)
             what is stuck?                  (an expired lot with no bids
                                              reads identically to a live one)

           So it leads with a summary line of the numbers, then groups by
           WHAT NEEDS ATTENTION rather than by which side of the trade you
           are on. A lot you are winning and a lot you have been outbid on
           are the same "bidding" row to a data model and completely
           different news to a person. */
        <MineView
          mine={mine}
          pausedIds={pausedIds}
          onChanged={loadMine}
        />
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

/**
 * The proxy-bidding rules, as exported constants.
 *
 * They are constants because the explanation is now collapsed behind "How
 * bidding works" — 74 words under every lot on the board is read once and
 * scrolled past forever after — and a test that asserts on the RENDERED
 * card would have to drive component state to see them.
 *
 * The property being protected has nothing to do with visibility: an
 * earlier version promised "Nobody else can see this number", which is
 * false and provably so (a rival who bids and watches where the price stops
 * reads the maximum exactly — 9 probes for $950,000, 17 for $2,345,678,
 * losing both times). Probing is inherent to every sealed-max auction; the
 * overclaim was the defect. Pinning these strings here keeps that fix from
 * silently reverting no matter where the copy is displayed.
 */
export const PROXY_RULE_SECRECY =
  "We'll bid the minimum needed to keep you in front, up to your maximum. " +
  "Your number is never shown to anyone — though a determined rival can " +
  "narrow it down by bidding against you. The price only rises as far as a " +
  "rival actually pushes it.";

export const PROXY_RULE_HINT =
  "If another player has set a higher maximum you may be outbid immediately. " +
  "You can raise your maximum later, but you can't lower or cancel it.";

/**
 * The "My auctions" tab.
 *
 * Everything here is derived from the two lists the server already returns;
 * there is no new endpoint. What is new is the reading: `status`, `endsAt`
 * and `youAreHighBidder` were all on the wire and none of them were shown.
 */
function MineView({
  mine, pausedIds, onChanged,
}: {
  mine: { selling: PublicAuction[]; bidding: PublicAuction[] } | null;
  pausedIds: Set<string>;
  onChanged: () => void;
}) {
  const t = useT();
  const selling = mine?.selling ?? [];
  const bidding = mine?.bidding ?? [];

  const active = (a: PublicAuction) => a.status === "active";
  // Grouped by what the player has to DO about it, not by which side of
  // the trade they are on.
  const outbid      = bidding.filter((a) => active(a) && !a.youAreHighBidder);
  const winning     = bidding.filter((a) => active(a) && a.youAreHighBidder);
  const won         = bidding.filter((a) => a.status === "sold" && a.youAreHighBidder);
  const lost        = bidding.filter((a) => a.status !== "active" && !a.youAreHighBidder);
  const liveListing = selling.filter(active);
  const soldListing = selling.filter((a) => a.status === "sold");
  // An expired or cancelled lot came back unsold. It is not a failure the
  // player can see anywhere else, and the mon is still theirs.
  const unsold      = selling.filter((a) => a.status === "expired" || a.status === "cancelled");

  // Money, both directions. Committed = what the player is currently on the
  // hook for if every lot they lead closes now; earned = what their sold
  // listings actually fetched.
  const committed = winning.reduce((n, a) => n + a.currentBid, 0);
  const earned    = soldListing.reduce((n, a) => n + a.currentBid, 0);

  if (!mine) return <div className="dim small">{t("Loading…")}</div>;
  if (selling.length === 0 && bidding.length === 0) {
    return (
      <div className="auc-mine-empty">
        <strong>{t("Nothing on the block")}</strong>
        <p className="dim small">
          {t("Bids you place and Pokémon you list both show up here — what you are winning, what you have been outbid on, and what has sold.")}
        </p>
      </div>
    );
  }

  return (
    <div className="auc-mine">
      {/* The four numbers, before any list. */}
      <div className="auc-mine-summary">
        <span className={`auc-mine-fig${outbid.length > 0 ? " is-warn" : ""}`}>
          <strong>{outbid.length}</strong><em>{t("outbid")}</em>
        </span>
        <span className={`auc-mine-fig${winning.length > 0 ? " is-good" : ""}`}>
          <strong>{winning.length}</strong><em>{t("winning")}</em>
        </span>
        <span className="auc-mine-fig">
          <strong>{liveListing.length}</strong><em>{t("listed")}</em>
        </span>
        <span className="auc-mine-money">
          {committed > 0 && (
            <span>{t("Committed")} <strong>{formatMoney(committed)}</strong></span>
          )}
          {earned > 0 && (
            <span>{t("Earned")} <strong className="is-good">{formatMoney(earned)}</strong></span>
          )}
        </span>
      </div>

      <MineGroup
        title={t("Outbid — act now")}
        tone="warn"
        list={outbid}
        empty={null}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={onChanged} proxyPaused={pausedIds.has(a.id)} />}
      />
      <MineGroup
        title={t("You're winning")}
        tone="good"
        list={winning}
        empty={null}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={onChanged} proxyPaused={pausedIds.has(a.id)} />}
      />
      <MineGroup
        title={t("Won")}
        tone="good"
        list={won}
        empty={null}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={onChanged} readOnly />}
      />
      <MineGroup
        title={t("Your listings")}
        list={liveListing}
        empty={t("You have nothing listed.")}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={() => {}} readOnly />}
      />
      <MineGroup
        title={t("Sold")}
        tone="good"
        list={soldListing}
        empty={null}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={() => {}} readOnly />}
      />
      {/* Deliberately last and deliberately present: a lot that ended with
          no bids currently looks identical to a live one. */}
      <MineGroup
        title={t("Ended without a sale")}
        list={unsold}
        empty={null}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={() => {}} readOnly />}
      />
      <MineGroup
        title={t("Didn't win")}
        list={lost}
        empty={null}
        render={(a) => <AuctionCard key={a.id} auction={a} onBid={() => {}} readOnly />}
      />
    </div>
  );
}

/** A titled group that renders nothing at all when it is empty and has no
 *  empty message — an "Outbid (0)" heading is a heading about nothing. */
function MineGroup({
  title, list, empty, tone, render,
}: {
  title: string;
  list: PublicAuction[];
  empty: string | null;
  tone?: "warn" | "good";
  render: (a: PublicAuction) => React.ReactNode;
}) {
  if (list.length === 0 && !empty) return null;
  return (
    <section className="auc-mine-group">
      <h4 className={`auc-mine-head${tone ? ` is-${tone}` : ""}`}>
        {title}
        {list.length > 0 && <span className="auc-mine-count">{list.length}</span>}
      </h4>
      {list.length === 0 ? <p className="dim small">{empty}</p> : list.map(render)}
    </section>
  );
}

export function AuctionCard({ auction, onBid, readOnly, proxyPaused }: {
  auction: PublicAuction; onBid: () => void; readOnly?: boolean; proxyPaused?: boolean;
}) {
  const t = useT();
  const { state, syncNow } = useGame();
  const mon = auction.pokemon as (Pokemon & { speciesKey: string }) | null;
  // THE PREFILLED NUMBER, which differs by state and must never be a number
  // the server will refuse:
  //   * challenging  -> the minimum acceptable bid;
  //   * already leading -> your OWN maximum plus a meaningful raise, because
  //     a maximum can only be RAISED. Seeding this from minNextBid (which is
  //     computed against the public price, far below your hidden maximum)
  //     prefilled a number the server rejects outright — caught by rendering
  //     the real card, not by any typecheck.
  const [amount, setAmount] = useState<number>(() => prefillBidAmount(auction));
  const floor = bidFloorFor(auction);
  // Whether the player has edited the field. An untouched field TRACKS the
  // live minimum; a touched one is left alone so a half-typed number is
  // never clobbered mid-keystroke.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBids, setShowBids] = useState(false);
  /** The proxy-bidding explanation, collapsed by default. */
  const [showRules, setShowRules] = useState(false);
  const [bids, setBids] = useState<AuctionBid[] | null>(null);

  // THE PREFILL FIX. AuctionCard previously had NO effect at all, so `amount`
  // kept its mount-time value forever: the parent re-rendered the card with a
  // fresh `auction` prop on every socket tick and 20-second poll, but React
  // preserved the state because `key={a.id}` keeps the same instance alive.
  // The player then clicked Bid with a stale number and got a bare rejection.
  // That was off by $1 under the old +1 rule; under the new increments it
  // would be off by up to $50,000, so this is a prerequisite for shipping
  // them rather than a nicety.
  useEffect(() => {
    const target = prefillBidAmount(auction);
    setAmount((prev) => (touched && prev >= floor ? prev : target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auction.minNextBid, auction.currentBid, auction.yourMax, auction.youAreHighBidder, floor, touched]);

  const money = state.money ?? 0;
  const isLeading = auction.youAreHighBidder;
  // The escalation has engaged. Computed conservatively (as for a returning
  // bidder) so the notice never under-claims.
  const multiplier = auction.currentBid > 0
    ? contestMultiplier(concentrationRatio(auction.bidCount, auction.distinctBidders, false))
    : 1;
  // Durable half of the "your maximum is paused" signal: survives a reload,
  // unlike the socket event, because it is derived from live balance vs the
  // live minimum rather than from an event the player may have been offline for.
  const cannotCoverMinimum = !readOnly && auction.status === "active"
    && !isLeading && money < auction.minNextBid;

  const bid = async () => {
    setBusy(true);
    try {
      // Flush the player's live money to the cloud FIRST — the server checks
      // the bid against last-uploaded saveData, so without this a player who
      // just earned money (but hasn't autosaved yet) gets a wrong "insufficient
      // funds" rejection. This is the "no funds despite 67M" fix.
      await syncNow();
      const res = await api.placeBid(auction.id, amount);
      if (!res.priceMoved) {
        pushToast({ kind: "success", text: t("Maximum raised to") + ` ${formatMoney(res.yourMax ?? amount)}.` });
      } else if (res.outbidImmediately) {
        // Without this the player is outbid in the same second they bid and
        // it reads as a bug rather than as somebody else valuing it higher.
        pushToast({
          kind: "warn",
          text: t("Outbid — another player's hidden maximum is higher. The price is now")
            + ` ${formatMoney(res.currentBid)}.`,
        });
      } else {
        pushToast({ kind: "success", text: t("You're the highest bidder at") + ` ${formatMoney(res.currentBid)}.` });
      }
      setTouched(false);
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
        <div className="auction-card-monmeta">
          <strong>
            {mon?.isShiny ? "✨ " : ""}{mon?.nickname ?? mon?.name ?? "?"}
            {mon && genderSymbol(mon.gender) && (
              <span className={`mon-gender is-${mon.gender === "M" ? "male" : "female"}`}>
                {genderSymbol(mon.gender)}
              </span>
            )}
          </strong>
          <div className="dim small">Lv{mon?.level ?? "?"} · {auction.sellerUsername ?? "?"}</div>
          {/* WHAT YOU ARE ACTUALLY BUYING.
              The listing carried all of this from the day it was written —
              the whole Pokemon is stored as a snapshot at listing time — and
              showed a name and a level. So the one thing that decides what a
              competitive Pokemon is worth was the one thing a bidder could
              not see, and the only way to find out was to win it. */}
          {mon && (
            <div className="auction-card-tags">
              {mon.nature && <span className="auction-tag">{mon.nature}</span>}
              {mon.ability && <span className="auction-tag">{prettyAbility(mon.ability)}</span>}
              {mon.ivs && (
                <span
                  className={`auction-tag is-iv${ivPct(mon) >= 90 ? " is-great" : ""}`}
                  title={ivBreakdown(mon)}
                >
                  {t("IV")} {Math.round(ivPct(mon))}%
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="auction-card-bid-info">
        <div>
          <span className="dim small">{auction.bidCount > 0 ? t("Current bid") : t("Starting bid")}</span>
          {/* GROUPED. This was a bare `${number}`, so the headline price read
              "$90000000" three lines above "$90,250,000" on the same card —
              measured in a browser. At these magnitudes the player has to
              count digits to tell $9M from $90M, and the whole point of the
              rule text below is that the numbers are legible. */}
          <strong className="auction-card-amount">
            {formatMoney(auction.currentBid > 0 ? auction.currentBid : auction.startingBid)}
          </strong>
        </div>
        {/* WHO is in front, not just how many bids there were. "3 bids" is a
            count; "3 bids, ma62087 in front at $600" is the state of the
            auction, and it was hidden behind "Show bids" — a click to learn
            the one thing every visitor to this card came to find out. */}
        {auction.bidCount > 0 && auction.currentBidderUsername && (
          <div className="auction-card-lastbid">
            <span className="auction-card-lastbid-who">{auction.currentBidderUsername}</span>
            <span className="dim">{t("in front")}</span>
          </div>
        )}
        <div className="dim small">
          {t("Ends in")} {timeLeft(auction.endsAt)} {"·"} {auction.bidCount} {auction.bidCount === 1 ? t("bid") : t("bids")}
        </div>
        <button type="button" className="auction-card-bidlink" onClick={toggleBids}>
          {showBids ? t("Hide bids") : t("Show bids")}
        </button>
        {showBids && bids && (
          <ul className="auction-card-bid-history">
            {bids.length === 0 && <li className="dim small">{t("No bids yet.")}</li>}
            {bids.map((b) => <li key={b.id}>{b.username} — {formatMoney(b.amount)}</li>)}
          </ul>
        )}
      </div>
      {/* YOUR OWN LISTING. The server has always refused this bid; what it
          could not do was stop the client OFFERING it. Browse used to render a
          full, enabled bid box on your own Pokemon and the only feedback was a
          lowercase toast after a round trip. */}
      {!readOnly && auction.youAreSeller && auction.status === "active" && (
        <div className="auction-card-actions auc2-bidbox">
          <div className="auc2-own">
            <strong className="auc2-own-title">{t("This is your listing")}</strong>
            {t("You can't bid on your own auction. It settles automatically when the timer runs out.")}
          </div>
        </div>
      )}
      {!readOnly && !auction.youAreSeller && auction.status === "active" && (
        <div className="auction-card-actions auc2-bidbox">
          {proxyPaused && (
            <div className="auc2-paused">
              <strong className="auc2-paused-title">{t("Maximum paused")}</strong>
              {t("Bidding has passed your synced balance, so we stopped raising for you. Sync and set a higher maximum to stay in.")}
            </div>
          )}
          {isLeading ? (
            <>
              <div className="auc2-leading">
                <span className="auc2-leading-badge">{t("You're the highest bidder")}</span>
                <span className="dim">{t("at")} {formatMoney(auction.currentBid)}</span>
              </div>
              {auction.yourMax !== null && (
                <div className="auc2-yourmax">
                  {t("Your maximum")}: {formatMoney(auction.yourMax)} <span className="dim">({t("only you can see this")})</span>
                </div>
              )}
              <div className="auc2-hint">
                {t("You can't bid against yourself. Raise your maximum instead — the price only moves if someone challenges you.")}
              </div>
              <div className="auc2-bidrow">
                <input
                  type="number"
                  aria-label={t("Raise your maximum")}
                  min={floor}
                  value={amount}
                  onChange={(e) => { setTouched(true); setAmount(parseInt(e.target.value, 10) || 0); }}
                />
                <button
                  className="g-btn-primary g-btn-small"
                  disabled={busy || amount < floor}
                  onClick={bid}
                >
                  {t("Raise my maximum")}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* THE RULE, STATED BEFORE THE PLAYER TYPES. `min={}` on the
                  input is invisible here — the Bid button is not a form
                  submit, so native validation never fires. It has to be text. */}
              <div className="auc2-min">
                <span className="auc2-min-label">{t("Minimum bid")}:</span>
                <span className="auc2-min-amount">{formatMoney(auction.minNextBid)}</span>
                {auction.currentBid > 0 && (
                  <span className="auc2-min-breakdown">
                    ({formatMoney(auction.currentBid)} + {formatMoney(auction.minIncrement)})
                  </span>
                )}
                {auction.currentBid === 0 && (
                  <span className="auc2-min-breakdown">({t("the seller's starting bid")})</span>
                )}
              </div>
              {multiplier > 1 && (
                <div className="auc2-heating">
                  {t("Bidding is heating up — a small group keeps raising, so the minimum raise has risen to")}
                  {" "}<strong>{formatMoney(auction.minIncrement)}</strong>.
                </div>
              )}
              {cannotCoverMinimum && (
                <div className="auc2-paused">
                  <strong className="auc2-paused-title">{t("You can't cover the minimum")}</strong>
                  {t("Your balance is")} {formatMoney(money)} {t("and the minimum bid is")} {formatMoney(auction.minNextBid)}.
                </div>
              )}
              <div className="auc2-maxrow">
                <label className="auc2-maxlabel" htmlFor={`auc2-max-${auction.id}`}>
                  {t("Your maximum")}
                </label>
                {/* The rules were two paragraphs under every card on the
                    board — 74 words a player reads once and then scrolls past
                    forever, on every lot. They are still exactly as true and
                    exactly as available; they are just not shouted at
                    somebody who already knows how it works. */}
                <button
                  type="button"
                  className="auc2-info-btn"
                  aria-expanded={showRules}
                  onClick={() => setShowRules((v) => !v)}
                >
                  {t("How bidding works")}
                </button>
              </div>
              <div className="auc2-bidrow">
                <input
                  id={`auc2-max-${auction.id}`}
                  type="number"
                  min={auction.minNextBid}
                  /* NO CONTRADICTORY PAIR. When the minimum is above what you
                     hold, `max={money}` sat BELOW `min`, so the field carried
                     two native constraints that no value can satisfy at once.
                     The "you can't cover the minimum" panel above already says
                     so in words; the attribute is simply dropped rather than
                     made nonsense. The button stays enabled on purpose — the
                     local balance lags the server (which is why `bid()` calls
                     syncNow() first), and disabling on a stale number would
                     lock out a player who just earned the money. */
                  max={money >= auction.minNextBid ? money : undefined}
                  value={amount}
                  onChange={(e) => { setTouched(true); setAmount(parseInt(e.target.value, 10) || 0); }}
                />
                <button
                  className="g-btn-primary g-btn-small"
                  disabled={busy || amount < floor}
                  onClick={bid}
                >
                  {t("Bid")}
                </button>
              </div>
              {/* The secrecy promise is the whole reason the mechanism works,
                  so it belongs on screen and not in a help page — and it has
                  to be TRUE. It used to say "nobody else can see this number"
                  while a rival could read it exactly by probing with bids. The
                  price a losing bid produces is now that bidder's own number,
                  so the promise below is the literal behaviour: the only way
                  to move the price to your maximum is for somebody to actually
                  commit that much. */}
              {showRules && (
              <>
              <div className="auc2-secret">
                {/* This used to promise "Nobody else can see this number." That was
                    FALSE, and provably so: a rival who bids against you and watches
                    where the price stops can read your maximum exactly — measured at
                    9 probes to read $950,000 and 17 to read $2,345,678, in both cases
                    while still losing. That is inherent to every sealed-max auction,
                    eBay included; it is not a defect in this one. But promising
                    secrecy the mechanism cannot deliver is worse than not promising
                    it, because a player sets their true ceiling on the strength of
                    it. Say what is actually true instead. */}
                {t(PROXY_RULE_SECRECY)}
              </div>
              <div className="auc2-hint">
                {t(PROXY_RULE_HINT)}
              </div>
              </>
              )}
            </>
          )}
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

export function ListPokemonForm({
  party, box, onDone, onCancel,
}: { party: Pokemon[]; box: Pokemon[]; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const { syncNow, dispatch } = useGame();
  const [picked, setPicked] = useState<Pokemon | null>(null);
  // STARTS EMPTY, deliberately. This was `useState(100)`, and that untouched
  // default is directly responsible for 24 of 240 production listings — 13 of
  // which expired unsold, and one of which was a Lv100 unown with a 186 IV
  // total that sold for $100. The $100 spike in the data is the shape of a
  // form field nobody edited, not a market. A default of $500 would just move
  // the spike, so there is no default at all: the submit button stays
  // disabled until the seller actually names a price.
  const [startingBidText, setStartingBidText] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [busy, setBusy] = useState(false);

  const startingBid = Number.parseInt(startingBidText, 10);
  const startingBidValid = Number.isFinite(startingBid) && startingBid >= MIN_STARTING_BID;
  const startingBidTooLow = startingBidText.trim() !== "" && !startingBidValid;

  const eligible = [
    ...party.map((p) => ({ mon: p, from: "party" as const })),
    ...box.map((p) => ({ mon: p, from: "box" as const })),
  ];

  const submit = async () => {
    if (!picked || !startingBidValid) return;
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
        <input
          type="number"
          min={MIN_STARTING_BID}
          max={999999999}
          placeholder={String(MIN_STARTING_BID)}
          value={startingBidText}
          onChange={(e) => setStartingBidText(e.target.value)}
        />
      </label>
      {/* A SUGGESTION, and it does NOT prefill the field.
          That is the whole design constraint here. The comment above records
          why there is no default at all: a prefilled value put 24 of 240
          listings on the same number, 13 of which expired unsold and one of
          which was a Lv100 Unown with a perfect IV total that sold for $100.
          A suggestion that types itself in is the same bug with a better
          number — the seller still never makes a decision.
          So it offers, and the seller presses it or ignores it. The field
          stays empty until somebody names a price.

          It shows its working, because a suggested price a player cannot
          interrogate is one they will assume is rigged the first time it
          disagrees with them. */}
      <div className="auc2-suggest">
        <span className="dim small">{t("Suggested")}</span>
        <strong title={explain(valuePokemon(picked)).join(", ")}>
          {formatMoney(suggestedStartingBid(picked))}
        </strong>
        <button
          type="button"
          className="auc2-suggest-use"
          onClick={() => setStartingBidText(String(suggestedStartingBid(picked)))}
        >
          {t("Use")}
        </button>
        <span className="dim small auc2-suggest-why">
          {t("worth about")} {formatMoney(valuePokemon(picked).value)} — {explain(valuePokemon(picked)).join(", ")}
        </span>
      </div>
      {/* The floor in words. `min={}` alone is invisible — this form's submit
          is a button handler, not a native form submission. */}
      <div className={`auc2-floor ${startingBidTooLow ? "auc2-floor-bad" : ""}`}>
        {startingBidTooLow
          ? `${t("Starting bid must be at least")} ${formatMoney(MIN_STARTING_BID)}.`
          : `${t("Minimum starting bid")}: ${formatMoney(MIN_STARTING_BID)}.`}
      </div>
      {startingBidValid && (
        <div className="auc2-floor">
          {t("Bids on your listing will rise in steps of at least")}
          {" "}{formatMoney(minIncrementFor(startingBid, {
            bidCount: 1, distinctBidders: 1, bidderIsNew: true,
          }) || baseStepFor(startingBid))}.
        </div>
      )}
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
        <button
          className="g-btn-primary g-btn-small"
          disabled={busy || !startingBidValid}
          onClick={submit}
        >
          {t("List for auction")}
        </button>
      </div>
    </div>
  );
}

/** IV total as a percentage of perfect. */
function ivPct(p: Pokemon): number {
  const iv = p.ivs;
  if (!iv) return 0;
  const t = iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed;
  return (t / (31 * 6)) * 100;
}

/** Per-stat IVs, for the hover. The percentage is the headline; a buyer
 *  comparing two 90% Pokemon needs to know WHICH stats are the good ones,
 *  and that is a tooltip's worth of detail rather than a card's. */
function ivBreakdown(p: Pokemon): string {
  const iv = p.ivs;
  if (!iv) return "";
  return [
    `HP ${iv.hp}`, `Atk ${iv.attack}`, `Def ${iv.defense}`,
    `SpA ${iv.spAttack}`, `SpD ${iv.spDefense}`, `Spe ${iv.speed}`,
  ].join("  ·  ") + `\n${iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed} / 186`;
}

/** "shellarmor" -> "Shell Armor". Ability ids are keys, not labels. */
function prettyAbility(id: string): string {
  const known = abilityInfo[id]?.name;
  if (known) return known;
  return id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}
