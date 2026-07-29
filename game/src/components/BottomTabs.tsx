import { useEffect, useMemo, useState } from "react";
import { useGame } from "../state/GameContext";
import { RouteCardList } from "./RouteCardList";
import { itemSpriteUrl } from "../utils/sprites";
import { PokemonSprite, Sprite } from "./Sprite";
import { pokemonTable } from "../data/pokemon";
import { obtainableCount, obtainableSpecies } from "../utils/obtainable";
import { ownedSpecies } from "../utils/pokemon";
import { routes } from "../data/routes";
import { buildUnifiedShop } from "../data/regions";
import { pokeballs } from "../data/pokeballs";
import { consumables } from "../data/consumables";
import { openPokemonDetail } from "./PokemonDetailModal";
import { DexSpeciesModal } from "./DexSpeciesModal";
import { getItemInfo, itemSpriteSlug } from "../utils/items";
import {
  itemsCatalog,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  getCatalogCategory,
  type ItemCategory,
} from "../data/itemsCatalog";
import { IconMap, IconCart, IconBackpack, IconMonitor, IconBook } from "./Icon";
import { TabPaneHead } from "./TabPaneHead";
import { pushToast } from "./Toast";
import { animatePop } from "../utils/animate";
import { openContextMenu } from "./ContextMenu";
import { useDraggable, useDropTarget } from "../hooks/useDrag";
import { useT } from "../i18n/useT";
import type { Pokemon } from "../types";
import type { ReactNode } from "react";

// Bottom of the center column — used to be just the Town Map. Now it's a
// tab strip that hosts the five "always-available" surfaces:
//   Town Map | Mart | Bag | PC | Pokédex
//
// Replaces the standalone PCModal / PokedexModal / Mart / Bag popups so the
// player can flip between them without losing the battle scene above.
type TabId = "map" | "mart" | "bag" | "pc" | "dex";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "map",  label: "Map",   icon: <IconMap size={16} /> },
  { id: "mart", label: "Mart",  icon: <IconCart size={16} /> },
  { id: "bag",  label: "Bag",   icon: <IconBackpack size={16} /> },
  { id: "pc",   label: "PC",    icon: <IconMonitor size={16} /> },
  { id: "dex",  label: "Dex",   icon: <IconBook size={16} /> },
];

export function BottomTabs() {
  const [active, setActive] = useState<TabId>("map");
  const t = useT();

  return (
    <div className="bottom-tabs">
      <nav className="bottom-tab-strip" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active === tab.id}
            className={`bottom-tab ${active === tab.id ? "active" : ""}`}
            onClick={() => setActive(tab.id)}
          >
            <span className="bottom-tab-icon">{tab.icon}</span>
            <span className="bottom-tab-label">{t(tab.label)}</span>
          </button>
        ))}
      </nav>
      <div className="bottom-tab-body">
        {active === "map"  && <RouteCardList />}
        {active === "mart" && <MartTab />}
        {active === "bag"  && <BagTab />}
        {active === "pc"   && <PCTab />}
        {active === "dex"  && <DexTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mart — UNIVERSAL / PROGRESSIONAL. The previous town-only stub forced
// players to travel to a specific city to access its stock; the operator
// flagged that as friction. Now the mart shows the UNION of every shop
// the player has unlocked (any town they've visited). Per-item
// wildBattlesWon gates still fire on top.
// ---------------------------------------------------------------------------
export function MartTab() {
  const { state, dispatch } = useGame();
  const t = useT();
  const here = state.currentLocation;
  const route = routes[here];
  // When the player hits Buy, the row swaps into a quantity adjuster so
  // they can buy in bulk. Only one row can be pending at a time.
  const [pending, setPending] = useState<{ itemId: string; qty: number } | null>(null);

  // Cancel the pending row whenever the player travels — prevents the row
  // sticking around when the shop changes underneath it.
  useEffect(() => { setPending(null); }, [here]);

  // Unified inventory across every shop the player has visited. Each
  // entry remembers the first town that stocked it so we can show a
  // small "First found at Pewter Mart" hint.
  const unified = useMemo(
    () => buildUnifiedShop(state.unlockedLocations),
    [state.unlockedLocations],
  );

  const resolve = (id: string): { price: number; description: string } | null => {
    const cat = itemsCatalog[id];
    if (cat?.buyPrice != null) {
      return { price: cat.buyPrice, description: cat.description };
    }
    const ball = pokeballs[id];
    const consumable = consumables[id];
    const legacy = ball ?? consumable;
    if (legacy?.buyPrice) return { price: legacy.buyPrice, description: legacy.description ?? "" };
    return null;
  };

  // Sort items by price ascending so the cheapest balls / repels land
  // at the top of the list — typical buy-bulk-of-cheap-balls flow.
  const sortedItems = useMemo(() => {
    return unified.items.slice().sort((a, b) => {
      const ra = resolve(a.itemId)?.price ?? Infinity;
      const rb = resolve(b.itemId)?.price ?? Infinity;
      return ra - rb;
    });
  }, [unified]);

  return (
    <div className="tab-pane mart-tab">
      <TabPaneHead
        title={t("Poké Mart")}
        meta={
          <span className="mart-wallet">
            💰 ${state.money.toLocaleString()}
            <span className="dim small" style={{ marginLeft: 8 }}>
              · {unified.visitedTownsWithMart} {t("town")}{unified.visitedTownsWithMart === 1 ? "" : "s"} {t("visited")}
            </span>
          </span>
        }
      />
      {unified.visitedTownsWithMart === 0 ? (
        <p className="dim small">{t("No mart has opened to you yet. Visit Viridian City to unlock your first stock.")}</p>
      ) : sortedItems.length === 0 ? (
        <p className="dim small">{t("No items available yet.")}</p>
      ) : (
        <ul className="mart-list">
          {sortedItems.map((entry) => {
            const resolved = resolve(entry.itemId);
            if (!resolved) return null;
            const locked =
              entry.unlockWildBattlesWon !== undefined &&
              state.wildBattlesWon < entry.unlockWildBattlesWon;
            const info = getItemInfo(entry.itemId);
            const maxAffordable = Math.max(1, Math.floor(state.money / resolved.price));
            const isPending = pending?.itemId === entry.itemId;
            const qty = isPending ? pending!.qty : 1;
            const total = resolved.price * qty;
            const cantBuy = locked || total > state.money;
            return (
              <li key={entry.itemId} className={`mart-row ${locked ? "locked" : ""}`} title={resolved.description}>
                <img
                  src={itemSpriteUrl(entry.itemId, itemSpriteSlug(entry.itemId))}
                  alt=""
                  width={28}
                  height={28}
                  style={{ imageRendering: "pixelated" }}
                />
                <div className="mart-row-info">
                  <strong>
                    {info.name}
                    {/* Descriptions are long and pushed every row tall enough
                        that only a few items fit on screen. Behind an info
                        icon they're one hover away without costing the list
                        its density. The row still carries `title` for touch. */}
                    <span
                      className="mart-info"
                      tabIndex={0}
                      /* Native title, not a positioned element: the mart list
                         scrolls, so an absolutely-positioned tooltip was
                         clipped by that overflow and showed as a stray bar.
                         The browser renders `title` outside any clipping
                         context, so it works everywhere. */
                      title={`${resolved.description}

${t("First found at")} ${entry.firstSoldAtName}`}
                      aria-label={`${resolved.description}. ${t("First found at")} ${entry.firstSoldAtName}`}
                    >
                      <span aria-hidden>i</span>
                    </span>
                  </strong>
                  {locked ? (
                    <small className="dim">
                      {t("Unlocks at")} {entry.unlockWildBattlesWon} {t("wild battles")} ({state.wildBattlesWon}/{entry.unlockWildBattlesWon})
                    </small>
                  ) : null}
                </div>
                <span className="mart-price">${resolved.price.toLocaleString()}</span>
                {/* Restocking 99 balls used to be 98 clicks on "+".
                    maxAffordable was already computed and only used as a
                    cap, so the shortcuts below cost nothing to offer.
                    Shift/Ctrl-click steps by 10 for people who never find
                    the ×10 button. */}
                <div className="mart-qty-controls">
                  <button
                    type="button"
                    className="mart-qty-step"
                    onClick={(e) =>
                      setPending({
                        itemId: entry.itemId,
                        qty: Math.max(1, qty - (e.shiftKey || e.ctrlKey ? 10 : 1)),
                      })
                    }
                    disabled={qty <= 1 || locked}
                    title={t("Shift-click for −10")}
                    aria-label={t("Decrease quantity")}
                  >
                    −
                  </button>
                  <span className="mart-qty-value">{qty}</span>
                  <button
                    type="button"
                    className="mart-qty-step"
                    onClick={(e) =>
                      setPending({
                        itemId: entry.itemId,
                        qty: Math.min(maxAffordable, qty + (e.shiftKey || e.ctrlKey ? 10 : 1)),
                      })
                    }
                    disabled={qty >= maxAffordable || locked}
                    title={t("Shift-click for +10")}
                    aria-label={t("Increase quantity")}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="mart-qty-jump"
                    onClick={() =>
                      setPending({ itemId: entry.itemId, qty: Math.min(maxAffordable, qty + 10) })
                    }
                    disabled={qty >= maxAffordable || locked}
                    aria-label={t("Add ten")}
                  >
                    +10
                  </button>
                  <button
                    type="button"
                    className="mart-qty-jump"
                    onClick={() => setPending({ itemId: entry.itemId, qty: maxAffordable })}
                    disabled={qty >= maxAffordable || locked}
                    title={`Buy as many as you can afford (${maxAffordable})`}
                    aria-label={t("Maximum affordable")}
                  >
                    {t("Max")}
                  </button>
                  <button
                    type="button"
                    className="mart-buy-btn"
                    disabled={cantBuy}
                    onClick={() => {
                      const can = state.money >= total;
                      dispatch({
                        type: "BUY_ITEM",
                        payload: { itemId: entry.itemId, quantity: qty },
                      });
                      if (can) {
                        const itemName = info?.name ?? entry.itemId;
                        pushToast({
                          kind: "success",
                          icon: "🛒",
                          text: qty > 1
                            ? `Bought ${qty}× ${itemName}`
                            : `Bought ${itemName}`,
                        });
                      }
                      // Reset stepper back to 1 after a purchase so the
                      // next buy starts fresh — no surprise multi-buys.
                      setPending(null);
                    }}
                    title={qty === 1
                      ? `Buy 1 for $${resolved.price.toLocaleString()}`
                      : `Buy ${qty} for $${total.toLocaleString()}`}
                  >
                    {t("Buy")}{qty > 1 ? ` ${qty}` : ""}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bag — flat inventory list with inline sell controls.
// ---------------------------------------------------------------------------
export function BagTab() {
  const { state, dispatch } = useGame();
  const t = useT();
  const items = Object.entries(state.inventory).filter(([, n]) => n > 0);
  // Group by catalog category. Items the catalog doesn't know about land in
  // "utility" so the Bag still shows them.
  const groups: Record<ItemCategory, [string, number][]> = {
    pokeball: [], medicine: [], status: [], battle: [], berry: [],
    held: [], stone: [], utility: [], treasure: [], tm: [], hm: [], key: [],
  };
  for (const [id, count] of items) groups[getCatalogCategory(id)].push([id, count]);

  // Active "sell" row — at most one at a time, like the mart's buy
  // stepper. Click "Sell" on a row to open the stepper; commit to fire
  // SELL_ITEM, cancel to close without selling.
  const [sellPending, setSellPending] = useState<{ itemId: string; qty: number } | null>(null);

  return (
    <div className="tab-pane bag-tab">
      <TabPaneHead
        title={t("Bag")}
        meta={`${items.length} item type${items.length === 1 ? "" : "s"}`}
      />

      {/* Active effects — temporary buffs that aren't held items, like
          Exp Share. Toggleable so the player can pause the countdown
          when they don't want it consuming battles. */}
      {state.activeEffects.length > 0 && (
        <section className="bag-category bag-effects">
          <h4 className="bag-category-head">{t("Active Effects")}</h4>
          <ul className="bag-list-v2">
            {state.activeEffects.map((eff) => {
              const info = getItemInfo(eff.itemId);
              // Repel/Honey are per-species and per-route, so name the target.
              // Without it the list showed a bare "Max Repel" and the player
              // had no way to tell which Pokémon on which route it was on.
              const target = eff.speciesKey
                ? `${pokemonTable[eff.speciesKey]?.name ?? eff.speciesKey}${
                    eff.routeKey ? ` · ${routes[eff.routeKey]?.name ?? eff.routeKey}` : ""
                  }`
                : "";
              return (
                <li
                  key={`${eff.itemId}|${eff.speciesKey}|${eff.routeKey ?? ""}`}
                  className={`bag-row-v2 ${eff.paused ? "paused" : ""}`}
                >
                  <img
                    src={itemSpriteUrl(eff.itemId, itemSpriteSlug(eff.itemId))}
                    alt=""
                    width={28}
                    height={28}
                    style={{ imageRendering: "pixelated", opacity: eff.paused ? 0.5 : 1 }}
                  />
                  <span className="bag-row-name">
                    {info.name}
                    {target && <small className="dim" style={{ marginLeft: 8 }}>{target}</small>}
                    {eff.paused && <small className="dim" style={{ marginLeft: 8 }}>{t("paused")}</small>}
                  </span>
                  <span className="bag-row-count">{eff.battlesRemaining.toLocaleString()} {t("battles")}</span>
                  <button
                    type="button"
                    className="effect-toggle-btn"
                    onClick={() =>
                      dispatch({
                        type: "TOGGLE_EFFECT_PAUSED",
                        // Target this exact effect — an id-only toggle paused
                        // every repel on every species at once.
                        payload: {
                          itemId: eff.itemId,
                          speciesKey: eff.speciesKey,
                          routeKey: eff.routeKey ?? "",
                        },
                      })
                    }
                    title={eff.paused ? t("Resume — start ticking down again") : t("Pause — keep battles remaining without consuming")}
                  >
                    {eff.paused ? t("Resume") : t("Pause")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {items.length === 0 ? (
        <p className="dim small">{t("Nothing in your bag.")}</p>
      ) : (
        <div className="bag-categories">
          {CATEGORY_ORDER.map((cat) => {
            const list = groups[cat];
            if (!list || list.length === 0) return null;
            return (
              <section key={cat} className="bag-category">
                <h4 className="bag-category-head">{CATEGORY_LABELS[cat]}</h4>
                <ul className="bag-list-v2">
                  {list.map(([id, count]) => {
                    const info = getItemInfo(id);
                    const cat = itemsCatalog[id];
                    const notReady = cat && cat.implemented === false;
                    // Repel tiers and Honey are activated from the Wild
                    // Pokémon panel, not from here. The Bag offers only
                    // "Sell", which is why players reported buying a Max
                    // Repel and finding no way to use it.
                    const usedFromWildPanel = id in consumables && id !== "expShare";
                    const sellPrice = cat?.sellPrice ?? 0;
                    const canSell = sellPrice > 0;
                    const isPending = sellPending?.itemId === id;
                    const sellQty = isPending ? sellPending!.qty : 1;
                    const sellTotal = sellPrice * sellQty;
                    return (
                      <li
                        key={id}
                        className={`bag-row-v2 ${notReady ? "not-ready" : ""}`}
                        title={`${info.name} — ${info.description}${
                          usedFromWildPanel
                            ? "\nTo use it: open the Wild Pokémon panel and click the species you want it applied to."
                            : ""
                        }${notReady ? " (catalog only — mechanic not implemented yet)" : ""}`}
                      >
                        <Sprite
                          src={itemSpriteUrl(id, itemSpriteSlug(id))}
                          alt=""
                          width={28}
                          height={28}
                          style={{ imageRendering: "pixelated" }}
                        />
                        <span className="bag-row-name">{info.name}</span>
                        <span className="bag-row-count">×{count}</span>
                        {canSell && !isPending && (
                          <button
                            type="button"
                            className="bag-sell-btn"
                            onClick={() => setSellPending({ itemId: id, qty: 1 })}
                            title={`Sell for $${sellPrice.toLocaleString()} each`}
                          >
                            {t("Sell")}
                          </button>
                        )}
                        {isPending && (
                          <div className="bag-sell-controls" role="group" aria-label={`Sell ${info.name}`}>
                            <button
                              type="button"
                              className="mart-qty-step"
                              onClick={() => setSellPending({ itemId: id, qty: Math.max(1, sellQty - 1) })}
                              disabled={sellQty <= 1}
                              aria-label={t("Decrease quantity")}
                            >
                              −
                            </button>
                            <span className="mart-qty-value">{sellQty}</span>
                            <button
                              type="button"
                              className="mart-qty-step"
                              onClick={() => setSellPending({ itemId: id, qty: Math.min(count, sellQty + 1) })}
                              disabled={sellQty >= count}
                              aria-label={t("Increase quantity")}
                            >
                              +
                            </button>
                            <button
                              type="button"
                              className="bag-sell-confirm"
                              onClick={() => {
                                dispatch({ type: "SELL_ITEM", payload: { itemId: id, quantity: sellQty } });
                                pushToast({
                                  kind: "success",
                                  icon: "💰",
                                  text:
                                    sellQty > 1
                                      ? `Sold ${sellQty}× ${info.name} for $${sellTotal.toLocaleString()}`
                                      : `Sold ${info.name} for $${sellTotal.toLocaleString()}`,
                                });
                                setSellPending(null);
                              }}
                              title={`Sell ${sellQty} for $${sellTotal.toLocaleString()}`}
                            >
                              {t("Sell")} ${sellTotal.toLocaleString()}
                            </button>
                            <button
                              type="button"
                              className="bag-sell-cancel"
                              onClick={() => setSellPending(null)}
                              aria-label={t("Cancel selling")}
                            >
                              ×
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PC — the storage box. Party stays in the left column; drag a party row
// into the box (or a box cell into a party row) to move/swap.
// Uses the custom dragController (touch-friendly) — see useDrag.ts.
//
// Box contents can run to thousands of entries, at which point "which of
// these nine Rattata is the good one" is unanswerable from sprites alone.
// So each cell carries its level, and the box can be narrowed by name,
// shininess, and IV quality. The three combine with each other and sit on
// top of the existing SORT_BOX ordering (sorting mutates the box itself;
// filtering is purely a view).
// ---------------------------------------------------------------------------

/** IVs are six stats capped at 31 each. */
const IV_MAX_TOTAL = 186;

const IV_TIERS = ["any", "60", "80", "90", "perfect"] as const;
type IvTier = (typeof IV_TIERS)[number];

const IV_TIER_LABEL: Record<IvTier, string> = {
  any: "Any IV",
  "60": "IV 60%+",
  "80": "IV 80%+",
  "90": "IV 90%+",
  perfect: "IV perfect",
};

/** Minimum IV total for a tier. "perfect" demands all six maxed. */
const IV_TIER_MIN: Record<IvTier, number> = {
  any: 0,
  "60": Math.ceil(IV_MAX_TOTAL * 0.6),
  "80": Math.ceil(IV_MAX_TOTAL * 0.8),
  "90": Math.ceil(IV_MAX_TOTAL * 0.9),
  perfect: IV_MAX_TOTAL,
};

function ivTotal(p: Pokemon): number {
  const iv = p.ivs;
  if (!iv) return 0;
  return iv.hp + iv.attack + iv.defense + iv.spAttack + iv.spDefense + iv.speed;
}

/** One filtered box entry: the Pokémon plus its REAL index in state.box. */
interface BoxView {
  p: Pokemon;
  index: number;
}

export function PCTab() {
  const { state, dispatch } = useGame();
  const t = useT();
  const PER_PAGE = 30;
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [shinyOnly, setShinyOnly] = useState(false);
  const [ivTier, setIvTier] = useState<IvTier>("any");

  const box = state.box;
  const filtering = query.trim() !== "" || shinyOnly || ivTier !== "any";

  // `null` means "no filter active" — deliberately NOT a copy of the box.
  // Materialising a 9,999-entry array of wrappers on every render (the box
  // identity changes whenever the reducer touches it) is the one thing here
  // that would actually cost something, and in the common case we don't
  // need it: the raw box is already indexable by page offset.
  const view = useMemo<BoxView[] | null>(() => {
    if (!filtering) return null;
    const q = query.trim().toLowerCase();
    const minIv = IV_TIER_MIN[ivTier];
    const out: BoxView[] = [];
    for (let i = 0; i < box.length; i++) {
      const p = box[i];
      if (!p) continue;
      if (shinyOnly && !p.isShiny) continue;
      if (minIv > 0 && ivTotal(p) < minIv) continue;
      if (q) {
        const nick = p.nickname?.toLowerCase();
        if (
          !p.name.toLowerCase().includes(q) &&
          !(nick && nick.includes(q)) &&
          !p.speciesKey.toLowerCase().includes(q)
        ) {
          continue;
        }
      }
      out.push({ p, index: i });
    }
    return out;
  }, [box, filtering, query, shinyOnly, ivTier]);

  const shown = view ? view.length : box.length;
  const pageCount = Math.max(1, Math.ceil(shown / PER_PAGE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  // ...and clamp for THIS render too. The effect above runs after commit, so
  // narrowing a filter while parked past the new end painted one frame of
  // empty grid ("Box 61/2") before correcting itself.
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  // Narrowing the box while parked on page 12 would otherwise land the
  // player on an empty page until the clamp above catches up.
  useEffect(() => { setPage(0); }, [query, shinyOnly, ivTier]);

  // Always exactly PER_PAGE cells so the grid keeps its 6×5 shape. Cells
  // past the end of the (filtered) list are empty, and carry an index past
  // the end of the box so drag targets treat them as trailing slots.
  const cells: { p: Pokemon | undefined; index: number }[] = [];
  for (let i = 0; i < PER_PAGE; i++) {
    const at = safePage * PER_PAGE + i;
    if (view) {
      const entry = view[at];
      cells.push(entry ? { p: entry.p, index: entry.index } : { p: undefined, index: box.length + i });
    } else {
      cells.push({ p: box[at], index: at });
    }
  }

  return (
    <div className="tab-pane pc-tab">
      <TabPaneHead
        title={t("Pokémon Storage")}
        meta={filtering ? `${shown} / ${box.length} shown` : `${box.length} stored`}
        tools={
          <>
            <span className="dim small" style={{ marginRight: 4 }}>{t("Sort")}</span>
            <button title={t("Sort by Pokédex number")} onClick={() => dispatch({ type: "SORT_BOX", payload: { mode: "id" } })}>
              {t("Dex#")}
            </button>
            <button title={t("Sort by level (highest first)")} onClick={() => dispatch({ type: "SORT_BOX", payload: { mode: "level" } })}>
              {t("Lv")}
            </button>
            <button title={t("Sort alphabetically")} onClick={() => dispatch({ type: "SORT_BOX", payload: { mode: "name" } })}>
              {t("A–Z")}
            </button>
            {pageCount > 1 && (
              <span className="pc-pager" style={{ marginLeft: "auto" }}>
                <button onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}>‹</button>
                <span className="dim small">{t("Box")} {safePage + 1}/{pageCount}</span>
                <button onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1}>›</button>
              </span>
            )}
          </>
        }
      />
      <div className="pc-filters">
        <div className="pc-search-wrap">
          <input
            type="search"
            className="pc-search"
            placeholder={t("Search your box")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("Search your box")}
          />
          {query && (
            <button
              type="button"
              className="pc-search-clear"
              onClick={() => setQuery("")}
              aria-label={t("Clear search")}
            >×</button>
          )}
        </div>
        <button
          type="button"
          className={`pc-filter ${shinyOnly ? "active" : ""}`}
          aria-pressed={shinyOnly}
          onClick={() => setShinyOnly((v) => !v)}
          title={t("Show only shiny Pokémon")}
        >
          ✨ {t("Shiny")}
        </button>
        <select
          className="pc-filter-select"
          value={ivTier}
          onChange={(e) => setIvTier(e.target.value as IvTier)}
          title={t("Filter by IV quality")}
          aria-label={t("Filter by IV quality")}
        >
          {IV_TIERS.map((tier) => (
            <option key={tier} value={tier}>{t(IV_TIER_LABEL[tier])}</option>
          ))}
        </select>
        {filtering && (
          <button
            type="button"
            className="pc-filter"
            onClick={() => { setQuery(""); setShinyOnly(false); setIvTier("any"); }}
            title={t("Clear all filters")}
          >
            {t("Reset")}
          </button>
        )}
      </div>
      <div className="pc-box-grid box-mode tab-box-grid">
        {cells.map((cell, i) => (
          // Keyed on the real box index (not the Pokémon id) so a cell keeps
          // its identity across renders even if a save ever carried duplicate
          // ids, and so drag state survives an in-place REORDER_BOX.
          <BoxSlot key={cell.p ? `p${cell.index}` : `e${i}`} pokemon={cell.p} index={cell.index} />
        ))}
      </div>
      <p className="dim small" style={{ margin: "6px 0 0", textAlign: "center" }}>
        {filtering && shown === 0
          ? t("No stored Pokémon match these filters.")
          : t("Drag from your party (left column) to deposit, or drag from here to your party.")}
      </p>
    </div>
  );
}

function BoxSlot({ pokemon: p, index: real }: { pokemon: Pokemon | undefined; index: number }) {
  const { state, dispatch } = useGame();
  const t = useT();

  // The slot div is a drop target whether or not it holds a Pokémon —
  // empty cells accept party deposits, occupied cells swap.
  const slotRef = useDropTarget<HTMLDivElement>({
    accept: (payload) => {
      if (payload.kind === "party") {
        // Refuse to empty the party.
        return state.party.length > 1;
      }
      if (payload.kind === "box") {
        const fromIdx = (payload.data as { index: number }).index;
        // Only a slot REORDER_BOX will actually accept. It rejects an
        // out-of-range target, so lighting up a trailing empty cell would
        // promise a move and then silently do nothing on release.
        return fromIdx !== real && real < state.box.length;
      }
      return false;
    },
    onDrop: (payload) => {
      if (payload.kind === "party") {
        const fromIdx = (payload.data as { index: number }).index;
        if (state.box[real]) {
          dispatch({
            type: "SWAP_PARTY_BOX",
            payload: { partyIndex: fromIdx, boxIndex: real },
          });
        } else {
          // Note: PARTY_TO_BOX puts the mon in the first empty slot, not
          // necessarily `real`. Matches the original behaviour — sort
          // buttons handle in-box reordering.
          dispatch({ type: "PARTY_TO_BOX", payload: { partyIndex: fromIdx } });
        }
      }
      // Box→box reordering. The drag already worked end to end — the cell
      // was a drag source, this target already accepted the payload, the
      // slot lit up — but nothing was ever dispatched, so releasing did
      // nothing and the box looked broken. REORDER_BOX has existed and
      // been correct the whole time; only this call was missing.
      if (payload.kind === "box") {
        const fromIdx = (payload.data as { index: number }).index;
        if (fromIdx !== real) {
          dispatch({ type: "REORDER_BOX", payload: { from: fromIdx, to: real } });
        }
      }
      if (slotRef.current) requestAnimationFrame(() => animatePop(slotRef.current!, 1.08));
    },
  });

  // The inner button only exists when the cell has a Pokémon — that's the
  // drag source. Has its own ref because the controller needs a stable
  // element to attach pointerdown to.
  const cellRef = useDraggable<HTMLButtonElement>({
    payload: () => ({ kind: "box", data: { index: real } }),
    enabled: !!p,
  });

  return (
    <div ref={slotRef} className={`pc-slot pc-box-slot ${!p ? "empty" : ""}`}>
      {p && (
        <button
          ref={cellRef}
          className="pc-cell"
          onClick={() => openPokemonDetail({ type: "box", index: real })}
          onContextMenu={(e) => {
            e.preventDefault();
            const partyFull = state.party.length >= 6;
            openContextMenu(e, [
              {
                label: t("View details"),
                onClick: () => openPokemonDetail({ type: "box", index: real }),
              },
              {
                label: partyFull ? t("Send to party (full)") : t("Send to party"),
                disabled: partyFull,
                onClick: () =>
                  dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: real } }),
              },
              {
                label: t("Release"),
                danger: true,
                onClick: () => {
                  if (window.confirm(`Release ${p.name}? This cannot be undone.`)) {
                    dispatch({
                      type: "RELEASE_POKEMON",
                      payload: { source: "box", index: real },
                    });
                  }
                },
              },
            ]);
          }}
          title={`${p.nickname ?? p.name} · Lv.${p.level} · IV ${Math.round(
            (ivTotal(p) / IV_MAX_TOTAL) * 100
          )}% · tap for details · hold-and-drag to move · right-click for actions`}
        >
          {/* The GIF→static-PNG fallback that used to live here inline is
              now PokemonSprite's job, along with the retry that makes a
              transient CDN failure recoverable. */}
          <PokemonSprite
            speciesKey={p.speciesKey}
            isShiny={p.isShiny}
            alt={p.name}
            width={40}
            height={40}
            style={{ imageRendering: "pixelated" }}
            draggable={false}
          />
          {/* Level, corner-mounted rather than inline, so it costs the cell
              no layout and the 6×5 grid keeps its shape. Four separate
              players asked for this: a box full of the same species is
              otherwise indistinguishable. */}
          <span className="pc-cell-lv">L{p.level}</span>
          {p.heldItem && itemsCatalog[p.heldItem] && (
            <img
              className="held-item-badge"
              src={itemSpriteUrl(p.heldItem, itemSpriteSlug(p.heldItem))}
              alt=""
              title={itemsCatalog[p.heldItem]?.name ?? p.heldItem}
              width={16}
              height={16}
              draggable={false}
            />
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pokédex — tri-state grid (unseen black / seen gray / caught color).
// ---------------------------------------------------------------------------
type DexFilter = "all" | "caught" | "seen" | "shiny" | "unknown";

const DEX_TYPES = [
  "Normal","Fire","Water","Electric","Grass","Ice",
  "Fighting","Poison","Ground","Flying","Psychic","Bug",
  "Rock","Ghost","Dragon","Dark","Steel","Fairy",
] as const;

// Fixed rungs only. "Master" is appended at render time AT the obtainable
// count — it used to be a hardcoded 245 sitting 43 species below the ring's
// own 100%, so the trophy lit up while the ring still read 85%.
const DEX_MILESTONES: { count: number; label: string; icon: string }[] = [
  { count: 10,  label: "Squad Builder", icon: "🧩" },
  { count: 25,  label: "Roster",        icon: "📘" },
  { count: 50,  label: "Half-way",      icon: "📚" },
  { count: 100, label: "Centurion",     icon: "💯" },
  { count: 151, label: "Kanto Master",  icon: "🥇" },
];

// The four states a dex entry can be in, worded so none of them claims
// more than it knows. "Caught" alone used to cover both of the middle two,
// which is what made a released or traded-away species read as if it were
// still sitting in a box somewhere.
function dexCellTitle(
  name: string,
  s: { owned: boolean; caught: boolean; seen: boolean; released: boolean },
  t: (str: string) => string
): string {
  if (s.owned)  return `${name} — ${t("in your party or PC")}`;
  if (s.caught) return `${name} — ${t("registered, but you don't have one right now")}`;
  if (s.seen)   return `${name} — ${t("seen in the wild, not caught yet")}`;
  return s.released ? t("Not found yet") : t("Not yet available");
}

export function DexTab() {
  const { state } = useGame();
  const t = useT();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<DexFilter>("all");

  const all = useMemo(() => Object.entries(pokemonTable).sort(([, a], [, b]) => a.id - b.id), []);
  const q = query.trim().toLowerCase();

  const seenSet   = useMemo(() => new Set(state.pokedexSeen),   [state.pokedexSeen]);
  const caughtSet = useMemo(() => new Set(state.pokedexCaught), [state.pokedexCaught]);
  const shinySet  = useMemo(() => new Set(state.shinyCaught),   [state.shinyCaught]);
  // Registration is permanent; ownership is not. Without this the grid
  // said "caught" for a species you released ten hours ago and had no way
  // to say it, which is the complaint that asked for a Living Dex.
  const ownedSet  = useMemo(
    () => ownedSpecies(state.party, state.box),
    [state.party, state.box]
  );

  // Per-type completion counts.
  // Declared ahead of typeCompletion: that memo runs during this render and
  // reads `obtainable`, so a later `const` would hit the temporal dead zone
  // and throw before the Dex could paint.
  const obtainable = obtainableSpecies();

  const typeCompletion = useMemo(() => {
    const byType: Record<string, { caught: number; total: number }> = {};
    for (const t of DEX_TYPES) byType[t] = { caught: 0, total: 0 };
    for (const [key, sp] of all) {
      // Unreleased species would make a type bucket unfinishable.
      if (!obtainable.has(key)) continue;
      for (const t of sp.types) {
        const bucket = byType[t];
        if (!bucket) continue;
        bucket.total++;
        if (caughtSet.has(key)) bucket.caught++;
      }
    }
    return byType;
  }, [all, caughtSet]);

  const filtered = useMemo(() => {
    let base = all;
    if (filter === "caught")  base = base.filter(([k]) => caughtSet.has(k));
    if (filter === "seen")    base = base.filter(([k]) => seenSet.has(k) && !caughtSet.has(k));
    if (filter === "shiny")   base = base.filter(([k]) => shinySet.has(k));
    if (filter === "unknown") base = base.filter(([k]) => !seenSet.has(k));
    if (!q) return base;
    return base.filter(([key, sp]) => {
      const idStr = String(sp.id);
      const padded = idStr.padStart(3, "0");
      return (
        sp.name.toLowerCase().includes(q) ||
        key.toLowerCase().includes(q) ||
        idStr.includes(q.replace(/^#/, "")) ||
        padded.includes(q.replace(/^#/, ""))
      );
    });
  }, [all, filter, caughtSet, seenSet, shinySet, q]);

  // Count against species that can ACTUALLY be caught. Using the raw
  // pokemonTable size meant ~35 Johto entries that exist for dex numbering but
  // have no encounter table were in the denominator, so a player who had
  // caught literally everything available was shown ~234/288 and could never
  // reach 100%. obtainableSpecies() derives this from the data, so the total
  // grows by itself the moment those species are released.
  const dexTotal = obtainableCount();
  const caughtObtainable = state.pokedexCaught.filter((k) => obtainable.has(k)).length;
  const completion = Math.min(100, (caughtObtainable / Math.max(1, dexTotal)) * 100);
  // Master lands exactly on 100% — the same moment the Shiny Charm is granted
  // and the full-dex trophy unlocks, so all three now agree.
  const milestones = [
    ...DEX_MILESTONES.filter((m) => m.count < dexTotal),
    { count: dexTotal, label: "Master", icon: "🏆" },
  ];
  const nextMilestone = milestones.find((m) => caughtObtainable < m.count);

  return (
    <div className="tab-pane dex-tab dex-tab-v2">
      {/* HERO STRIP — completion ring + milestones */}
      <header className="dex-hero">
        <div className="dex-hero-ring">
          <svg viewBox="0 0 36 36" className="dex-hero-ring-svg" aria-hidden>
            <path
              className="dex-hero-ring-track"
              d="M18 2.5 a 15.5 15.5 0 1 1 0 31 a 15.5 15.5 0 1 1 0 -31"
            />
            <path
              className="dex-hero-ring-fill"
              d="M18 2.5 a 15.5 15.5 0 1 1 0 31 a 15.5 15.5 0 1 1 0 -31"
              style={{ strokeDasharray: `${completion}, 100` }}
            />
          </svg>
          <span className="dex-hero-ring-text">{Math.round(completion)}%</span>
        </div>
        <div className="dex-hero-stats">
          <div>
            <span className="dex-hero-label">{t("Caught")}</span>
            <strong className="tabular">{caughtObtainable}<span className="dim"> / {dexTotal}</span></strong>
          </div>
          <div>
            <span className="dex-hero-label">{t("Seen")}</span>
            <strong className="tabular">{state.pokedexSeen.length}</strong>
          </div>
          <div>
            <span className="dex-hero-label">{t("Shinies")}</span>
            <strong className="tabular">{state.shinyCaught.length}</strong>
          </div>
        </div>
        <div className="dex-hero-milestones" aria-label={t("Milestones")}>
          {milestones.map((m) => {
            const done = caughtObtainable >= m.count;
            const active = nextMilestone && nextMilestone.count === m.count;
            return (
              <div
                key={m.count}
                className={`dex-milestone ${done ? "done" : ""} ${active ? "active" : ""}`}
                title={`${m.label} — ${m.count}`}
              >
                <span className="dex-milestone-icon">{done ? m.icon : "🔒"}</span>
                <span className="dex-milestone-count tabular">{m.count}</span>
              </div>
            );
          })}
        </div>
      </header>

      {/* TYPE COMPLETION STRIP */}
      <section className="dex-types">
        {DEX_TYPES.map((t) => {
          const bucket = typeCompletion[t];
          if (!bucket || bucket.total === 0) return null;
          const pct = (bucket.caught / Math.max(1, bucket.total)) * 100;
          const complete = bucket.caught === bucket.total;
          return (
            <div key={t} className={`dex-type-pill type-${t.toLowerCase()} ${complete ? "complete" : ""}`} title={`${t}: ${bucket.caught} / ${bucket.total}`}>
              <span className="dex-type-name">{t}</span>
              <span className="dex-type-bar">
                <span className="dex-type-bar-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="dex-type-num tabular">{bucket.caught}/{bucket.total}</span>
            </div>
          );
        })}
      </section>

      {/* FILTERS + SEARCH */}
      <div className="dex-controls">
        <div className="dex-filter-pills" role="tablist">
          {(["all", "caught", "seen", "shiny", "unknown"] as DexFilter[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              className={`dex-filter ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all"     ? t("All")
                : f === "caught"  ? t("Caught")
                : f === "seen"    ? t("Seen")
                : f === "shiny"   ? t("✨ Shiny")
                :                   "???"}
            </button>
          ))}
        </div>
        <div className="dex-search-wrap">
          <input
            type="search"
            className="dex-search"
            placeholder={t("Search by name or dex #")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="dex-search-clear"
              onClick={() => setQuery("")}
              aria-label={t("Clear search")}
            >×</button>
          )}
        </div>
      </div>

      {/* LEGEND — four states, four words. The grid has always encoded them
          in the sprite treatment; nothing said what the treatments meant, so
          "caught but no longer owned" read as a rendering glitch. */}
      <div className="dex-legend">
        <span className="dex-legend-item owned">{t("In your collection")}</span>
        <span className="dex-legend-item registered">{t("Registered, none owned")}</span>
        <span className="dex-legend-item seen">{t("Seen only")}</span>
        <span className="dex-legend-item unknown">{t("Undiscovered")}</span>
      </div>

      {/* GRID */}
      <div className="dex-tab-grid">
        {filtered.length === 0 && (
          <p className="dim small" style={{ gridColumn: "1 / -1" }}>
            {t("Nothing matches the current filter.")}
          </p>
        )}
        {filtered.map(([key, sp]) => {
          const caught = caughtSet.has(key);
          const seen   = seenSet.has(key);
          const shiny  = shinySet.has(key);
          // Not gated on `caught` — ownership is a fact about your boxes, and
          // gating it would make this cell disagree with the species modal,
          // which reads the same lists.
          const owned  = ownedSet.has(key);
          const filterCss = caught
            ? "none"
            : seen
            ? "grayscale(1) brightness(0.85)"
            : "brightness(0)";
          const clickable = seen || caught;
          return (
            <button
              key={key}
              type="button"
              className={[
                "dex-cell",
                caught ? "caught" : seen ? "seen" : "unknown",
                // Registered but gone: still a completed dex entry, so it
                // keeps its colour — it just stops claiming you have one.
                caught && !owned ? "registered-only" : "",
                shiny ? "is-shiny" : "",
                !obtainable.has(key) ? "unreleased" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => clickable && setPicked(key)}
              disabled={!clickable}
              /* Unreleased species are marked so a completionist doesn't hunt
                 for something that has no encounter yet — they're excluded
                 from the counts above, but still occupy their dex number. */
              title={dexCellTitle(sp.name, { owned, caught, seen, released: obtainable.has(key) }, t)}
            >
              <PokemonSprite
                speciesKey={key}
                isShiny={shiny && caught}
                alt={clickable ? sp.name : "???"}
                width={36}
                height={36}
                style={{ imageRendering: "pixelated", filter: filterCss }}
              />
              <small>#{String(sp.id).padStart(3, "0")}</small>
              {shiny && <span className="dex-cell-shiny" aria-hidden>✨</span>}
            </button>
          );
        })}
      </div>
      {picked && <DexSpeciesModal speciesKey={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}
