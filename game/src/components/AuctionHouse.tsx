// The Auction House.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// The old page put a COMPLETE BID FORM ON EVERY CARD. Six listings meant six
// "Your maximum" inputs, six Bid buttons, six "How bidding works" links and
// six "Show bids" toggles, stacked down the page. The thing being sold — the
// Pokémon, which is the entire reason anyone is here — was a 24px sprite, and
// on most cards it had not finished loading. Every line of text was the same
// weight, so nothing said "this is the price" or "this ends in three
// minutes". There was no search, no sort and no filter, so past the first
// screen the only way to find a lot was to read every card.
//
// ── WHAT THIS IS INSTEAD ──────────────────────────────────────────────────
// A market: a wall of lots you can scan, and ONE place to act. Cards carry
// the four things that decide whether you care — what it is, what it costs,
// how long is left, and whether you are winning — at four clearly different
// weights. Selecting one opens it in the third column (see AuctionLotAside)
// with the full detail and a single bid form.
//
// That split is the whole design. A card is for comparing; the panel is for
// committing. Putting the commit control on every card made the page look
// like a tax return and made the actual products invisible.

import { useEffect, useMemo, useState } from "react";
import { api, type PublicAuction } from "../net/api";
import { useGame } from "../state/GameContext";
import { HubViews } from "./HubModal";
import { PokemonSprite, Sprite } from "./Sprite";
import { itemSpriteUrl } from "../utils/sprites";
import { itemSpriteSlug } from "../utils/items";
import { genderSymbol } from "../data/gender";
import { machines } from "../data/tms";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";
import { formatMoney } from "../utils/auctionBidRules";
import {
  startAuctionFeed, useAuctionStore, useSelectLot, refreshLots, setAuctionMode,
} from "../state/auctionStore";
import { SellFlow } from "./AuctionSell";
import "./auctionHouse.css";

export type LotFilter = "all" | "pokemon" | "machine" | "mine";
export type LotSort = "ending" | "price-low" | "price-high" | "newest";

/** Time remaining, in the largest unit that still reads as urgent. */
export function timeLeft(endsAt: string): string {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return "ending…";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** How close to closing, 0..1 — drives the urgency bar on each card. */
function urgency(endsAt: string, createdAt: string): number {
  const end = new Date(endsAt).getTime();
  const start = new Date(createdAt).getTime();
  const now = Date.now();
  if (!(end > start)) return 1;
  return Math.max(0, Math.min(1, (now - start) / (end - start)));
}

export function ivPercent(p: Pokemon): number {
  const iv = p.ivs;
  if (!iv) return 0;
  const total = iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed;
  return (total / (31 * 6)) * 100;
}

export function AuctionHousePane() {
  const { state, dispatch } = useGame();
  const t = useT();
  const store = useAuctionStore();
  const select = useSelectLot();

  const [filter, setFilter] = useState<LotFilter>("all");
  const [sort, setSort] = useState<LotSort>("ending");
  const [q, setQ] = useState("");
  // Re-render once a minute so "3h 12m" and the urgency bars stay true
  // without a per-second timer repainting the whole wall.
  const [, setTick] = useState(0);

  useEffect(() => startAuctionFeed(), []);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // ── THE ESCROW GUARD ───────────────────────────────────────────────
  // The server escrows a listed Pokémon but the client keeps it in the box,
  // so without this it stays releasable, depositable and sweepable by a bulk
  // release while it is already sold. /mine returns listings of ANY status,
  // so only "active" ones are still escrowed — a sold or cancelled one must
  // drop off the list or the mon would stay locked forever.
  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      api.myAuctions().then((res) => {
        if (cancelled) return;
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
    sync();
    const id = window.setInterval(sync, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [dispatch]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = store.lots.filter((a) => {
      if (filter === "pokemon" && a.lotKind !== "pokemon") return false;
      if (filter === "machine" && a.lotKind !== "item") return false;
      if (filter === "mine" && !a.youAreSeller && !a.youAreHighBidder) return false;
      if (!needle) return true;
      return lotName(a).toLowerCase().includes(needle)
        || (a.sellerUsername ?? "").toLowerCase().includes(needle);
    });
    const by: Record<LotSort, (a: PublicAuction, b: PublicAuction) => number> = {
      ending: (a, b) => new Date(a.endsAt).getTime() - new Date(b.endsAt).getTime(),
      "price-low": (a, b) => (a.currentBid || a.startingBid) - (b.currentBid || b.startingBid),
      "price-high": (a, b) => (b.currentBid || b.startingBid) - (a.currentBid || a.startingBid),
      newest: (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    };
    return [...out].sort(by[sort]);
  }, [store.lots, filter, sort, q]);

  const counts = useMemo(() => ({
    all: store.lots.length,
    pokemon: store.lots.filter((a) => a.lotKind === "pokemon").length,
    machine: store.lots.filter((a) => a.lotKind === "item").length,
    mine: store.lots.filter((a) => a.youAreSeller || a.youAreHighBidder).length,
  }), [store.lots]);

  // Mode lives in the store so the Aside can follow — see the note there.
  if (store.mode === "sell") {
    return (
      <SellFlow
        onDone={() => { setAuctionMode("browse"); void refreshLots(); }}
        onCancel={() => setAuctionMode("browse")}
      />
    );
  }

  return (
    <div className="tab-pane ah-pane">
      {/* `hub-views--stack` — two rows, which is the whole reason Sell can be
          up here at all. It was pulled out of this header once because the
          slot is a fixed 800px and, on one line with four category tabs, a
          search box, a sort control and the wallet, Sell was laid out past
          the end and clipped. The stacked variant (the PC and the Pokedex use
          it for the same reason) gives the toolbar a second row, so the
          page's primary action fits without crowding anything.

          Selling is the one thing here you cannot discover by browsing —
          every other control acts on lots that are already in front of you —
          so it belongs where a player looks first rather than at the bottom
          of a panel they have to select a lot to see. */}
      <HubViews className="hub-views--stack">
        <div className="ah-head-row">
          <div className="g-tabs" role="tablist" aria-label={t("Auction categories")}>
            {([
              ["all", t("All"), counts.all],
              ["pokemon", t("Pokémon"), counts.pokemon],
              ["machine", t("TMs"), counts.machine],
              ["mine", t("Yours"), counts.mine],
            ] as const).map(([key, label, n]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={`g-tab${filter === key ? " active" : ""}`}
                onClick={() => setFilter(key as LotFilter)}
              >
                {label} <span className="dim">{n}</span>
              </button>
            ))}
          </div>
          <span className="ah-head-spacer" />
          <span className="mart-wallet-chip" title={t("Your money")}>
            ${state.money.toLocaleString()}
          </span>
          <button
            type="button"
            className="ah-sell-btn ah-sell-btn--head"
            onClick={() => setAuctionMode("sell")}
          >
            <span aria-hidden="true">+</span>
            {/* Named, not "Sell something". Beside a wall of other people's
                lots, a bare "Sell" reads as though it might act on one of
                them. */}
            {t("Sell a Pokémon or TM")}
          </button>
        </div>
        {/* No search box. Pulled for now — with the floor at this size the four
            category tabs already cut it down to something you can read, and a
            text field that mostly returns everything is a control that costs
            header room without earning it. The filtering code below is left in
            place and `q` stays empty, so putting it back is one element. */}
        <div className="ah-head-row ah-head-row--filters">
          <select
            className="ah-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as LotSort)}
            aria-label={t("Sort lots")}
          >
            <option value="ending">{t("Ending soonest")}</option>
            <option value="newest">{t("Newest")}</option>
            <option value="price-low">{t("Cheapest")}</option>
            <option value="price-high">{t("Priciest")}</option>
          </select>
        </div>
      </HubViews>

      {store.loading && store.lots.length === 0 ? (
        <p className="ah-note">{t("Loading the floor…")}</p>
      ) : shown.length === 0 ? (
        <div className="ah-empty">
          <p className="ah-empty-head">
            {store.lots.length === 0 ? t("Nothing is up for auction.") : t("No lot matches that.")}
          </p>
          <p className="ah-empty-sub">
            {store.lots.length === 0
              ? t("Be the first — list a Pokémon or a spare TM and set your own opening price.")
              : t("Try a different category, or clear the search.")}
          </p>
          {store.lots.length === 0 && (
            <button type="button" className="ah-sell-btn" onClick={() => setAuctionMode("sell")}>
              {t("Sell something")}
            </button>
          )}
        </div>
      ) : (
        <ul className="ah-grid">
          {shown.map((a) => (
            <LotCard
              key={a.id}
              lot={a}
              selected={store.selectedId === a.id}
              paused={store.pausedIds.has(a.id)}
              onSelect={() => select(a.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The lot's headline name, for search and for the card. */
export function lotName(a: PublicAuction): string {
  if (a.lotKind === "item") {
    const m = a.item ? machines[a.item.itemId] : undefined;
    return m ? `${m.label} ${m.moveName}` : (a.item?.itemId ?? "Machine");
  }
  const p = a.pokemon as Pokemon | null;
  return p?.nickname ?? p?.name ?? "?";
}

/**
 * One lot on the wall.
 *
 * NO FORM. A card's whole job is to be compared against the card next to it,
 * so it carries exactly four things and gives each a different weight: the
 * thing, the price, the clock, and your standing in it. Everything else —
 * bid history, the increment rule, the seller's other listings — lives in
 * the panel, where there is room for it and where it is not repeated
 * thirty times down the page.
 */
export function LotCard({ lot, selected, paused, onSelect }: {
  lot: PublicAuction;
  selected: boolean;
  paused: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const mon = lot.lotKind === "pokemon" ? (lot.pokemon as Pokemon | null) : null;
  const machine = lot.lotKind === "item" && lot.item ? machines[lot.item.itemId] : undefined;
  const price = lot.currentBid || lot.startingBid;
  const unbid = lot.currentBid <= 0;
  const pct = urgency(lot.endsAt, lot.createdAt);
  const closing = new Date(lot.endsAt).getTime() - Date.now() < 15 * 60_000;

  return (
    <li className={`ah-card${selected ? " is-selected" : ""}${closing ? " is-closing" : ""}`}>
      <button type="button" className="ah-card-hit" onClick={onSelect} aria-pressed={selected}>
        {/* THE PRODUCT, at a size you can actually see. The old card gave it
            24px and buried it under four lines of form. */}
        <span className={`ah-card-art${lot.lotKind === "item" ? " is-machine" : ""}`}>
          {mon ? (
            <PokemonSprite
              speciesKey={mon.speciesKey}
              isShiny={!!mon.isShiny}
              alt=""
              width={72}
              height={72}
              style={{ imageRendering: "pixelated" }}
            />
          ) : machine ? (
            <Sprite
              src={itemSpriteUrl(machine.id, itemSpriteSlug(machine.id))}
              alt=""
              width={56}
              height={56}
              style={{ imageRendering: "pixelated" }}
            />
          ) : null}
        </span>

        <span className="ah-card-body">
          <span className="ah-card-title">
            {mon?.isShiny && <span className="ah-shiny" title={t("Shiny")}>✨</span>}
            <strong>{lotName(lot)}</strong>
            {mon && genderSymbol(mon.gender) && (
              <span className={`mon-gender is-${mon.gender === "M" ? "male" : "female"}`}>
                {genderSymbol(mon.gender)}
              </span>
            )}
          </span>

          {/* One line of identity. For a Pokémon that is level, nature and
              IV%; for a machine it is the move's type and power, which is
              the equivalent question — "how good is this actually". */}
          <span className="ah-card-tags">
            {mon ? (
              <>
                <span className="ah-tag">Lv{mon.level}</span>
                {mon.nature && <span className="ah-tag">{mon.nature}</span>}
                {mon.ivs && (
                  <span className={`ah-tag ah-is-iv${ivPercent(mon) >= 90 ? " ah-is-great" : ""}`}>
                    {t("IV")} {Math.round(ivPercent(mon))}%
                  </span>
                )}
              </>
            ) : machine ? (
              <>
                <span className={`ah-tag type-${machine.moveType.toLowerCase()}`}>{machine.moveType}</span>
                <span className="ah-tag">{t("reusable")}</span>
              </>
            ) : null}
          </span>

          {/* The label and the clock share a line; the PRICE gets its own.
              They were all on one row and the two collided the moment a lot
              passed seven figures — "$4,000,0001h 25m", with no gap at all,
              because a flex `gap` collapses once the content overflows. A
              price cannot be truncated and a clock cannot be dropped, so the
              fix is structural rather than a smaller font: nothing shares a
              line with a number that has no upper bound. */}
          <span className="ah-card-foot">
            <span className="ah-card-meta">
              <span className="ah-price-label">{unbid ? t("Starting") : t("Current")}</span>
              <span className="ah-clock" title={new Date(lot.endsAt).toLocaleString()}>
                {timeLeft(lot.endsAt)}
              </span>
            </span>
            <strong className="ah-price">{formatMoney(price)}</strong>
          </span>

          {/* The clock, drawn. A number alone does not tell you whether "12m"
              is most of the listing or the last scrap of it. */}
          <span className="ah-urgency" aria-hidden="true">
            <span style={{ width: `${Math.round(pct * 100)}%` }} />
          </span>
        </span>

        {/* Your standing, if you have one. Absent on a lot you have not
            touched, which is most of them — a badge on every card would say
            nothing. */}
        {lot.youAreSeller ? (
          <span className="ah-badge is-yours">{t("Your listing")}</span>
        ) : paused ? (
          <span className="ah-badge is-warn">{t("Max too low")}</span>
        ) : lot.youAreHighBidder ? (
          <span className="ah-badge is-winning">{t("Winning")}</span>
        ) : lot.bidCount > 0 && lot.yourMax === null && lot.currentBidderUsername ? null : null}
      </button>
    </li>
  );
}
