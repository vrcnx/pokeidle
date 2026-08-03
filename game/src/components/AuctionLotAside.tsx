// The selected lot, in the hub's third column.
//
// This is the ONLY place the auction house accepts a bid. The old page put a
// full bid form on every card, which meant the commit control was repeated
// once per listing and the thing being sold was squeezed into whatever space
// the form left — a 24px sprite under four lines of input.
//
// Splitting it costs one click and buys three things: the cards become
// comparable at a glance, the form gets room to explain itself (the minimum,
// the increment rule, your standing, the bid history) without that
// explanation being repeated thirty times, and there is exactly one input on
// screen, so "the number I typed" is never ambiguous.

import { useEffect, useState } from "react";
import { api, type AuctionBid, type PublicAuction } from "../net/api";
import { useGame } from "../state/GameContext";
import { PokemonSprite, Sprite } from "./Sprite";
import { itemSpriteUrl } from "../utils/sprites";
import { itemSpriteSlug } from "../utils/items";
import { genderSymbol } from "../data/gender";
import { abilityInfo } from "../data/abilities";
import { machines } from "../data/tms";
import { machineEffectText } from "../utils/machines";
import { machineLearnsets } from "../data/tms";
import { moves as movesTable } from "../data/moves";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";
import {
  bidFloorFor, concentrationRatio, contestMultiplier, formatMoney, prefillBidAmount,
} from "../utils/auctionBidRules";
import { useAuctionStore, useSelectedLot, refreshLots } from "../state/auctionStore";
import { lotName, timeLeft, ivPercent } from "./AuctionHouse";
import "./auctionHouse.css";

export function AuctionLotAside() {
  const lot = useSelectedLot();
  const store = useAuctionStore();
  const t = useT();
  // While the Body is selling, this panel must describe THAT, not the browse
  // screen behind it.
  if (store.mode === "sell") {
    return (
      <div className="ah-aside is-empty">
        <div className="ah-aside-hint">
          <span className="ah-aside-hint-mark" aria-hidden="true">🔨</span>
          <p className="ah-aside-hint-head">{t("Setting up a lot")}</p>
          <p className="ah-aside-hint-sub">
            {t("Pick what to sell, then name your opening price. Nothing leaves you until you list it.")}
          </p>
        </div>
      </div>
    );
  }
  if (!lot) {
    return (
      <div className="ah-aside is-empty">
        <div className="ah-aside-hint">
          <span className="ah-aside-hint-mark" aria-hidden="true">◈</span>
          <p className="ah-aside-hint-head">{t("Pick a lot")}</p>
          <p className="ah-aside-hint-sub">
            {t("Everything about it — stats, bid history, and the one place you bid — opens here.")}
          </p>
        </div>
      </div>
    );
  }
  return <LotDetail key={lot.id} lot={lot} />;
}

/** Exported for the render tests, which drive it directly with a lot rather
 *  than seeding the store — the same way the old suite drove AuctionCard. */
export function LotDetail({ lot }: { lot: PublicAuction }) {
  const { state, syncNow } = useGame();
  const t = useT();
  const store = useAuctionStore();
  const mon = lot.lotKind === "pokemon" ? (lot.pokemon as Pokemon | null) : null;
  const machine = lot.lotKind === "item" && lot.item ? machines[lot.item.itemId] : undefined;

  const floor = bidFloorFor(lot);
  const [amount, setAmount] = useState<number>(() => prefillBidAmount(lot));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bids, setBids] = useState<AuctionBid[] | null>(null);
  const [showRules, setShowRules] = useState(false);

  // THE PREFILL FIX, carried over verbatim in intent. The card instance
  // survives every socket tick and 20-second poll, so without this the input
  // keeps its mount-time value and the player clicks Bid with a stale number.
  // Off by up to $50,000 under the current increments.
  useEffect(() => {
    const target = prefillBidAmount(lot);
    setAmount((prev) => (touched && prev >= floor ? prev : target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot.minNextBid, lot.currentBid, lot.yourMax, lot.youAreHighBidder, floor, touched]);

  // Bid history is fetched once per lot, on open — it is the one thing here
  // that needs a round trip, and it was a per-card toggle before.
  useEffect(() => {
    let cancelled = false;
    api.getAuction(lot.id)
      .then((res) => { if (!cancelled) setBids(res.bids); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [lot.id]);

  const money = state.money ?? 0;
  const isLeading = lot.youAreHighBidder;
  const paused = store.pausedIds.has(lot.id);
  const multiplier = lot.currentBid > 0
    ? contestMultiplier(concentrationRatio(lot.bidCount, lot.distinctBidders, false))
    : 1;
  const cannotCoverMinimum = lot.status === "active" && !isLeading && money < lot.minNextBid;

  const submit = async () => {
    setBusy(true);
    try {
      // Flush live money to the cloud FIRST — the server checks the bid
      // against last-uploaded saveData, so without this a player who just
      // earned money gets a wrong "insufficient funds".
      await syncNow();
      const res = await api.placeBid(lot.id, amount);
      if (!res.priceMoved) {
        pushToast({ kind: "success", text: `${t("Maximum raised to")} ${formatMoney(res.yourMax ?? amount)}.` });
      } else if (res.outbidImmediately) {
        pushToast({
          kind: "warn",
          text: `${t("Outbid — another player's hidden maximum is higher. The price is now")} ${formatMoney(res.currentBid)}.`,
        });
      } else {
        pushToast({ kind: "success", text: `${t("You're the highest bidder at")} ${formatMoney(res.currentBid)}.` });
      }
      setTouched(false);
      await refreshLots();
      api.getAuction(lot.id).then((r) => setBids(r.bids)).catch(() => undefined);
    } catch (e: any) {
      pushToast({ kind: "warn", text: e?.message ?? t("Couldn't place bid.") });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm(t("Pull this listing? You get it straight back."))) return;
    setBusy(true);
    try {
      await api.cancelAuction(lot.id);
      pushToast({ kind: "success", text: t("Listing cancelled.") });
      await refreshLots();
    } catch (e: any) {
      pushToast({ kind: "warn", text: e?.message ?? t("Couldn't cancel.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ah-aside">
      {/* ── The lot, large ──────────────────────────────────────────
          This is what you are buying. It gets the top of the panel and a
          real size, because the whole complaint about the old page was that
          the product was the smallest thing on it. */}
      <div className="ah-hero">
        {mon ? (
          <PokemonSprite
            speciesKey={mon.speciesKey}
            isShiny={!!mon.isShiny}
            alt=""
            width={112}
            height={112}
            style={{ imageRendering: "pixelated" }}
          />
        ) : machine ? (
          <Sprite
            src={itemSpriteUrl(machine.id, itemSpriteSlug(machine.id))}
            alt=""
            width={80}
            height={80}
            style={{ imageRendering: "pixelated" }}
          />
        ) : null}
      </div>

      <h3 className="ah-hero-name">
        {mon?.isShiny && <span className="ah-shiny">✨</span>}
        {lotName(lot)}
        {mon && genderSymbol(mon.gender) && (
          <span className={`mon-gender is-${mon.gender === "M" ? "male" : "female"}`}>
            {genderSymbol(mon.gender)}
          </span>
        )}
      </h3>
      <p className="ah-hero-sub">
        {mon ? `Lv ${mon.level}` : machine ? machine.label : ""}
        {lot.sellerUsername ? ` · ${t("from")} ${lot.sellerUsername}` : ""}
      </p>

      {mon && <MonFacts mon={mon} />}
      {machine && <MachineFacts machineId={machine.id} />}

      {/* ── Price and clock ─────────────────────────────────────── */}
      <div className="ah-money">
        <div className="ah-money-main">
          <span className="ah-money-label">
            {lot.currentBid > 0 ? t("Current bid") : t("Starting bid")}
          </span>
          <strong className="ah-money-value">
            {formatMoney(lot.currentBid || lot.startingBid)}
          </strong>
          {lot.currentBidderUsername && (
            <span className="ah-money-who">
              {isLeading ? t("You're in front") : `${lot.currentBidderUsername} ${t("in front")}`}
            </span>
          )}
        </div>
        <div className="ah-money-side">
          <span className="ah-money-label">{t("Ends in")}</span>
          <strong className="ah-money-value is-small">{timeLeft(lot.endsAt)}</strong>
          <span className="ah-money-who">
            {lot.bidCount} {lot.bidCount === 1 ? t("bid") : t("bids")}
            {lot.distinctBidders > 1 ? ` · ${lot.distinctBidders} ${t("bidders")}` : ""}
          </span>
        </div>
      </div>

      {/* ── The one bid form ────────────────────────────────────── */}
      {lot.youAreSeller ? (
        <div className="ah-own">
          <p className="ah-own-note">{t("This is your listing — you can't bid on it.")}</p>
          {lot.bidCount === 0 ? (
            <button type="button" className="ah-btn is-ghost" disabled={busy} onClick={cancel}>
              {t("Pull the listing")}
            </button>
          ) : (
            <p className="ah-hint">{t("Someone has bid, so it has to run to the end now.")}</p>
          )}
        </div>
      ) : lot.status !== "active" ? (
        <p className="ah-hint">{t("This lot has ended.")}</p>
      ) : (
        <div className="ah-bid">
          <label className="ah-bid-label" htmlFor={`ah-max-${lot.id}`}>
            {isLeading ? t("Raise your maximum") : t("Your maximum")}
          </label>
          <div className="ah-bid-row">
            <span className="ah-bid-currency">$</span>
            <input
              id={`ah-max-${lot.id}`}
              className="ah-bid-input"
              type="number"
              inputMode="numeric"
              min={floor}
              value={amount}
              onChange={(e) => { setTouched(true); setAmount(Math.floor(Number(e.target.value) || 0)); }}
            />
            <button
              type="button"
              className="ah-btn is-primary"
              disabled={busy || amount < floor || amount > money}
              onClick={submit}
            >
              {busy ? t("…") : isLeading ? t("Raise") : t("Bid")}
            </button>
          </div>

          {/* Every refusal the server can give, said BEFORE the click. */}
          {amount < floor && (
            <p className="ah-bid-warn">
              {t("Minimum is")} {formatMoney(floor)}.
            </p>
          )}
          {amount > money && (
            <p className="ah-bid-warn">
              {t("That's more than your")} {formatMoney(money)}.
            </p>
          )}
          {cannotCoverMinimum && (
            <p className="ah-bid-warn">
              {t("You can't cover the current minimum of")} {formatMoney(lot.minNextBid)}.
            </p>
          )}
          {paused && (
            <p className="ah-bid-warn">
              {t("Your stored maximum can no longer be covered by your balance, so it stopped defending.")}
            </p>
          )}
          {isLeading && lot.yourMax !== null && (
            <p className="ah-bid-ok">
              {t("Your hidden maximum is")} {formatMoney(lot.yourMax)}. {t("You only pay what it takes.")}
            </p>
          )}

          <button
            type="button"
            className="ah-rules-toggle"
            aria-expanded={showRules}
            onClick={() => setShowRules((v) => !v)}
          >
            {showRules ? "▾" : "▸"} {t("How bidding works")}
          </button>
          {showRules && (
            <div className="ah-rules">
              <p>{t("You enter a MAXIMUM, not a price. The server raises for you by the smallest step needed, and stops at your number — so a later click can't beat a higher maximum.")}</p>
              <p>{t("A bid in the last minute pushes the end out by a minute, so nothing can be sniped in the closing seconds.")}</p>
              {multiplier > 1 && (
                <p>{t("Bidding is heating up here, so the minimum raise has gone up with it.")}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Who has bid ─────────────────────────────────────────── */}
      {bids && bids.length > 0 && (
        <div className="ah-history">
          <h4>{t("Bids")}</h4>
          <ul>
            {bids.slice(0, 8).map((b) => (
              <li key={b.id}>
                <span className="ah-history-who">{b.username}</span>
                <span className="ah-history-amt">{formatMoney(b.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The stats a buyer is actually valuing. */
function MonFacts({ mon }: { mon: Pokemon }) {
  const t = useT();
  const iv = mon.ivs;
  return (
    <div className="ah-facts">
      <div className="ah-facts-row">
        {mon.nature && <span className="ah-tag">{mon.nature}</span>}
        {mon.ability && <span className="ah-tag">{abilityInfo[mon.ability]?.name ?? mon.ability}</span>}
        {iv && (
          <span className={`ah-tag ah-is-iv${ivPercent(mon) >= 90 ? " ah-is-great" : ""}`}>
            {t("IV")} {Math.round(ivPercent(mon))}%
          </span>
        )}
      </div>
      {iv && (
        // Per-stat, not just the percentage. Two 90% Pokémon are not the
        // same Pokémon, and which stats are the good ones is the difference.
        <ul className="ah-ivs">
          {([
            ["HP", iv.hp], ["Atk", iv.attack], ["Def", iv.defense],
            ["SpA", iv.spAttack], ["SpD", iv.spDefense], ["Spe", iv.speed],
          ] as const).map(([label, v]) => (
            <li key={label} className={v >= 31 ? "is-max" : ""}>
              <span className="ah-iv-label">{label}</span>
              <span className="ah-iv-bar"><span style={{ width: `${(v / 31) * 100}%` }} /></span>
              <span className="ah-iv-n">{v}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the machine teaches, and whether it is any use to this buyer. */
function MachineFacts({ machineId }: { machineId: string }) {
  const { state } = useGame();
  const t = useT();
  const m = machines[machineId];
  const def = m ? movesTable[m.moveId] : undefined;
  if (!m || !def) return null;

  const owned = (state.inventory[machineId] ?? 0) > 0;
  const eligible = [...state.party, ...state.box].filter(
    (p) => p && (machineLearnsets[p.speciesKey] ?? []).includes(machineId),
  ).length;

  return (
    <div className="ah-facts">
      <div className="ah-facts-row">
        <span className={`ah-tag type-${def.type.toLowerCase()}`}>{def.type}</span>
        <span className="ah-tag">{def.category}</span>
        <span className="ah-tag">{def.power || "—"} {t("pwr")}</span>
        <span className="ah-tag">{def.accuracy}%</span>
      </div>
      <p className="ah-machine-effect">{machineEffectText(machineId)}</p>
      {/* The two things that decide whether this is worth money TO YOU. */}
      <p className={`ah-machine-fit${owned || eligible === 0 ? " is-warn" : ""}`}>
        {owned
          ? t("You already have this machine — a second does nothing.")
          : eligible === 0
            ? t("Nothing you own can learn this move.")
            : `${eligible} ${t("of your Pokémon could learn it.")}`}
      </p>
    </div>
  );
}
