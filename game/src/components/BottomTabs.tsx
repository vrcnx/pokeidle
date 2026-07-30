import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { RouteCardList } from "./RouteCardList";
import { itemSpriteUrl, pokemonStaticSpriteUrl } from "../utils/sprites";
import { PokemonSprite, Sprite } from "./Sprite";
import { pokemonTable } from "../data/pokemon";
import { obtainableCount, obtainableSpecies } from "../utils/obtainable";
import { ownedSpecies } from "../utils/pokemon";
import { hasShinyCharm } from "../utils/shinyCharm";
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
import {
  IconMap, IconCart, IconBackpack, IconMonitor, IconBook,
  IconSliders, IconGridLarge, IconGridSmall,
} from "./Icon";
import { TabPaneHead } from "./TabPaneHead";
import { pushToast } from "./Toast";
import { animatePop, useModalEnter } from "../utils/animate";
import { openContextMenu } from "./ContextMenu";
import { useDraggable, useDropTarget } from "../hooks/useDrag";
import { useT } from "../i18n/useT";
import {
  bulkReleaseConfirmMessage, isBulkReleasable, needsReleaseConfirm,
} from "../utils/releaseConfirm";
import type { Pokemon, PokemonType } from "../types";
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
// So each cell carries its level and (at comfortable density) its name, and
// the box can be narrowed by name, shininess, and IV quality. The three
// combine with each other and sit on top of the existing SORT_BOX ordering
// (sorting mutates the box itself; filtering is purely a view).
//
// Two things about the layout are load-bearing:
//
//   1. BoxSlot always receives the REAL index into state.box, never a
//      position in the filtered/windowed view. REORDER_BOX, SWAP_PARTY_BOX
//      and RELEASE_POKEMON all address the box directly, so an index that
//      drifted with the view would move or delete the WRONG Pokémon. Every
//      path that produces a cell goes through the same two-line mapping
//      below, and nothing else may.
//
//   2. The grid is windowed, not paged. The cap is 9,999, which was 334
//      pages of 30; rendering all of them instead would be 9,999 remote GIF
//      requests. Since every row is one height and every column is 1fr, the
//      window is arithmetic over the row pitch plus two spacer divs.
// ---------------------------------------------------------------------------

/** IVs are six stats capped at 31 each. */
const IV_MAX_TOTAL = 186;

/** The server's own MAX_BOX (server/src/lib/saveValidation.ts). Past it a
 *  save comes back 400, so there is nothing to deposit into and the trailing
 *  deposit slot would be a lie. */
const BOX_CAPACITY = 9999;

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

type SortMode = "id" | "level" | "name";

/** Cell density. A device preference, not save state — same reasoning as
 *  layoutMode: it describes the screen you're sitting at. */
type Density = "comfy" | "compact";
const DENSITY_KEY = "pokemon-idle-pc-density";

/** Per-density cell geometry, in px.
 *   `min`  — the smallest acceptable cell width; drives the column count.
 *   `name` — height of the name strip under the square sprite plate
 *            (0 = no strip, which is what makes compact compact).
 *   `gap`  — grid gutter, and therefore part of the row pitch. */
const DENSITY_METRICS: Record<Density, { min: number; name: number; gap: number }> = {
  comfy:   { min: 72, name: 15, gap: 4 },
  compact: { min: 48, name: 0,  gap: 3 },
};

/** Rows rendered above and below the visible window. Two covers a fast
 *  flick between frames without ever painting a blank band. */
const OVERSCAN_ROWS = 2;

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfy";
  } catch {
    return "comfy";
  }
}

/**
 * Which ordering is the box CURRENTLY in, if any — so the sort menu can tick
 * the live answer instead of "whichever button you last pressed".
 *
 * SORT_BOX mutates state.box and keeps no record of the mode, and a
 * drag-reorder can undo the ordering at any time, so remembering the last
 * click would go stale silently. Deriving it is O(n) with an early exit and
 * runs only when the menu opens — one pass over 9,999 entries, once, on a
 * deliberate click.
 */
function currentSortMode(box: Pokemon[]): SortMode | null {
  if (box.length < 2) return null;
  let byId = true;
  let byLevel = true;
  let byName = true;
  for (let i = 1; i < box.length; i++) {
    const a = box[i - 1];
    const b = box[i];
    if (byId && (pokemonTable[a.speciesKey]?.id ?? 0) > (pokemonTable[b.speciesKey]?.id ?? 0)) byId = false;
    if (byLevel && a.level < b.level) byLevel = false;
    if (byName && a.name.localeCompare(b.name) > 0) byName = false;
    if (!byId && !byLevel && !byName) return null;
  }
  return byId ? "id" : byLevel ? "level" : byName ? "name" : null;
}

/** Menu rows reserve the tick column whether or not they're ticked, so the
 *  labels don't shuffle sideways as the active row moves. */
function tick(on: boolean) {
  return <span aria-hidden>{on ? "✓" : " "}</span>;
}

export function PCTab() {
  const { state, dispatch } = useGame();
  const t = useT();
  const [query, setQuery] = useState("");
  const [shinyOnly, setShinyOnly] = useState(false);
  const [ivTier, setIvTier] = useState<IvTier>("any");
  const [density, setDensity] = useState<Density>(readDensity);

  // Bulk release (br_ff6112fc5180462b81 — two players asked, one with 500
  // Magikarp to clear). Selection is a set of POKÉMON IDS, never indices: the
  // grid is filtered, sorted and windowed, an index means nothing once any of
  // those move, and the reducer's RELEASE_MANY is id-addressed for the same
  // reason (a loop over ascending indices provably deletes the wrong mon).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const box = state.box;
  const filtering = query.trim() !== "" || shinyOnly || ivTier !== "any";

  // `null` means "no filter active" — deliberately NOT a copy of the box.
  // Materialising a 9,999-entry array of wrappers on every render (the box
  // identity changes whenever the reducer touches it) is the one thing here
  // that would actually cost something, and in the common case we don't
  // need it: the raw box is already indexable by view offset.
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

  // ---- Grid geometry ------------------------------------------------------
  // The column count is computed here rather than left to `auto-fill` because
  // the scroll window needs to know it: rows only line up with the spacers if
  // JS and CSS agree on how many cells are in a row.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, padTop: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      // clientWidth, not offsetWidth — it already excludes the scrollbar, so
      // the column count doesn't flip the moment one appears.
      const w = el.clientWidth - padL - padR;
      const h = el.clientHeight - padT - padB;
      setSize((prev) => (prev.w === w && prev.h === h && prev.padTop === padT ? prev : { w, h, padTop: padT }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = DENSITY_METRICS[density];
  const gap = metrics.gap;
  const cols = Math.max(1, Math.floor((size.w + gap) / (metrics.min + gap)));
  const cellW = size.w > 0 ? (size.w - gap * (cols - 1)) / cols : metrics.min;
  // Square sprite plate, plus the name strip. Rounded so the row pitch stays
  // an integer and 300 rows of accumulated halves can't drift the window off
  // the spacers.
  const rowH = Math.round(cellW) + metrics.name;
  const pitch = rowH + gap;

  // One trailing slot so the party still has somewhere to be dropped. It is
  // not a box position: PARTY_TO_BOX picks the first free slot itself, and
  // `index === box.length` makes every box→box drop reject it (see BoxSlot).
  // The old grid padded to 30 invisible cells to get this one behaviour.
  const canDeposit = box.length < BOX_CAPACITY;
  // Nothing to show is its own layout, so the deposit slot only joins the
  // grid when the grid exists. It still gets rendered in the empty state —
  // dropping a party member into an empty box has to keep working.
  const total = shown > 0 ? shown + (canDeposit ? 1 : 0) : 0;

  // ---- Scroll window ------------------------------------------------------
  // Row-indexed rather than pixel-indexed on purpose: React bails out of the
  // re-render when the value is unchanged, so a scroll costs one render per
  // row crossed instead of one per scroll event.
  const [topRow, setTopRow] = useState(0);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const row = Math.max(0, Math.floor((e.currentTarget.scrollTop - size.padTop) / pitch));
    setTopRow((prev) => (prev === row ? prev : row));
  };
  // Narrowing the filter while parked deep in the box would otherwise leave
  // the player staring at blank space below the last match.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setTopRow(0);
  }, [query, shinyOnly, ivTier, density]);

  const totalRows = Math.ceil(total / cols);
  // Clamp for THIS render as well as via the scroll reset above: the effect
  // runs after commit, so a filter that shrinks the list painted one frame of
  // empty grid before correcting itself. Same bug the old page clamp fixed.
  const anchorRow = Math.min(topRow, Math.max(0, totalRows - 1));
  const firstRow = Math.max(0, anchorRow - OVERSCAN_ROWS);
  const lastRow = Math.min(
    totalRows,
    anchorRow + Math.ceil(size.h / pitch) + 1 + OVERSCAN_ROWS
  );
  const from = firstRow * cols;
  const to = Math.min(total, lastRow * cols);

  // Cells for the window only. The index mapping is byte-for-byte the one the
  // paged version used — `at` is a position in the (filtered) view, and the
  // index handed to BoxSlot is always the REAL index in state.box. Only the
  // range of `at` has changed.
  const cells: { p: Pokemon | undefined; index: number }[] = [];
  for (let at = from; at < to; at++) {
    if (at >= shown) {
      cells.push({ p: undefined, index: box.length });
    } else if (view) {
      const entry = view[at];
      cells.push({ p: entry.p, index: entry.index });
    } else {
      cells.push({ p: box[at], index: at });
    }
  }

  const openSortMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const active = currentSortMode(box);
    const sort = (mode: SortMode) => dispatch({ type: "SORT_BOX", payload: { mode } });
    openContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      { label: t("Pokédex number"), icon: tick(active === "id"), onClick: () => sort("id") },
      { label: t("Level, highest first"), icon: tick(active === "level"), onClick: () => sort("level") },
      { label: t("Name, A–Z"), icon: tick(active === "name"), onClick: () => sort("name") },
    ]);
  };

  const openFilterMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      {
        label: t("Shiny only"),
        icon: tick(shinyOnly),
        onClick: () => setShinyOnly((v) => !v),
      },
      // A disabled row is the only section heading this menu has. It's skipped
      // by the arrow keys, which is exactly right for a label.
      { label: t("IV quality"), disabled: true, onClick: () => undefined },
      ...IV_TIERS.map((tier) => ({
        label: t(IV_TIER_LABEL[tier]),
        icon: tick(ivTier === tier),
        onClick: () => setIvTier(tier),
      })),
      {
        label: t("Clear filters"),
        disabled: !filtering,
        onClick: () => { setQuery(""); setShinyOnly(false); setIvTier("any"); },
      },
    ]);
  };

  const toggleDensity = () => {
    setDensity((prev) => {
      const next: Density = prev === "comfy" ? "compact" : "comfy";
      try { localStorage.setItem(DENSITY_KEY, next); } catch { /* private mode — session only */ }
      return next;
    });
  };

  // ---- Bulk release ------------------------------------------------------
  // Everything the CURRENT filter shows that is legal to bulk-release. Derived
  // from `view`/`box` rather than from the rendered window, so "Select all"
  // means the whole match set, not just the ~40 cells on screen.
  const selectableIds = useMemo(() => {
    const listed = state.listedPokemonIds ?? [];
    const out: string[] = [];
    const push = (p: Pokemon | undefined) => {
      if (p && isBulkReleasable(p, listed)) out.push(p.id);
    };
    if (view) for (const entry of view) push(entry.p);
    else for (const p of box) push(p);
    return out;
  }, [view, box, state.listedPokemonIds]);

  // Selection is pruned against what still EXISTS and is still selectable.
  // A release, an auction settling or a cloud reconcile can remove a selected
  // mon while the bar is open, and a count that includes ghosts would make the
  // confirmation lie about how many are about to be destroyed.
  const liveSelected = useMemo(() => {
    if (selected.size === 0) return [] as string[];
    const allowed = new Set(selectableIds);
    return [...selected].filter((id) => allowed.has(id));
  }, [selected, selectableIds]);

  // How many of the currently-visible Pokémon are shiny or auction-listed, and
  // so cannot be bulk-released. `shown` counts the filtered view.
  const blockedCount = Math.max(0, shown - selectableIds.length);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const releaseSelected = () => {
    const count = liveSelected.length;
    if (count === 0) return;
    // NEVER skippable, and it names the exact number. `skipReleaseConfirm` is
    // not consulted here by design — see utils/releaseConfirm.ts.
    if (!window.confirm(bulkReleaseConfirmMessage(count))) return;
    dispatch({ type: "RELEASE_MANY", payload: { source: "box", pokemonIds: liveSelected } });
    exitSelectMode();
  };

  // Leaving the filter behind would leave a selection the player can no longer
  // see. Drop it rather than release something off-screen later.
  useEffect(() => { setSelected(new Set()); }, [query, shinyOnly, ivTier]);

  return (
    <div className="tab-pane pc-tab">
      {/* One row, not three. The title, the sort trio, the pager, the two
          filter controls and the drag hint used to stack 155px of chrome
          above the first sprite — on a 768px screen that left the grid 22px
          for thirty Pokémon. Search earns permanent space because it is the
          only navigation that scales to 9,999; everything else folds into a
          menu. */}
      <div className="pc-toolbar">
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
        <button type="button" className="pc-tool" onClick={openSortMenu} title={t("Sort the box")}>
          <span aria-hidden>⇅</span> {t("Sort")}
        </button>
        <button
          type="button"
          className={`pc-tool pc-tool-icon ${filtering ? "on" : ""}`}
          onClick={openFilterMenu}
          title={t("Filter by shininess and IVs")}
          aria-label={t("Filter by shininess and IVs")}
        >
          <IconSliders size={14} />
          {filtering && <span className="pc-tool-dot" aria-hidden />}
        </button>
        <button
          type="button"
          className="pc-tool pc-tool-icon"
          onClick={toggleDensity}
          title={density === "comfy" ? t("Switch to compact cells") : t("Switch to comfortable cells")}
          aria-label={density === "comfy" ? t("Switch to compact cells") : t("Switch to comfortable cells")}
        >
          {/* Shows the density it will switch TO. Real icons rather than
              ▪ / ▦: U+25AA measures 5px wide however large the font is set,
              which read as a speck of dust in the toolbar. */}
          {density === "comfy" ? <IconGridSmall size={14} /> : <IconGridLarge size={14} />}
        </button>
        {/* Icon-only, like the filter and density buttons either side of it. A
            text label pushed this row past a 320px pane and wrapping it cost
            grid height at 360px (both measured) — and the PC is already the
            subject of a small-monitor report. The bulk bar that drops in on
            click is what makes the mode legible; this button only has to be
            reachable and to show whether it is on. */}
        <button
          type="button"
          className={`pc-tool pc-tool-icon ${selectMode ? "on" : ""}`}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          title={
            selectMode
              ? t("Leave selection mode")
              : t("Select several Pokémon to release at once")
          }
          aria-label={
            selectMode
              ? t("Leave selection mode")
              : t("Select several Pokémon to release at once")
          }
          aria-pressed={selectMode}
        >
          <span aria-hidden>☑</span>
        </button>
        <span className="pc-count" title={filtering ? t("Matches / stored") : t("Stored")}>
          {filtering ? `${shown} / ${box.length}` : box.length}
        </span>
      </div>

      {/* Bulk release bar. Only mounted in selection mode, and it is the ONLY
          route to RELEASE_MANY — there is no keyboard shortcut and no context
          menu entry, so the count in the confirmation is always something the
          player built by hand. Shinies and auction-listed Pokémon are not
          selectable (isBulkReleasable) and the reducer refuses them again. */}
      {selectMode && (
        <div className="pc-bulk-bar">
          <span className="pc-bulk-count">
            {liveSelected.length === 0
              ? t("Tap Pokémon to select them")
              : `${liveSelected.length} ${t("selected")}`}
          </span>
          <button
            type="button"
            className="pc-tool"
            onClick={() => setSelected(new Set(selectableIds))}
            disabled={selectableIds.length === 0}
            title={
              filtering
                ? t("Select every Pokémon matching the current filters")
                : t("Select every Pokémon in the box")
            }
          >
            {t("Select all")}
            {filtering ? ` (${selectableIds.length})` : ""}
          </button>
          <button
            type="button"
            className="pc-tool"
            onClick={() => setSelected(new Set())}
            disabled={liveSelected.length === 0}
          >
            {t("Clear")}
          </button>
          <button
            type="button"
            className="pc-tool pc-bulk-release"
            onClick={releaseSelected}
            disabled={liveSelected.length === 0}
          >
            {t("Release")} {liveSelected.length > 0 ? liveSelected.length : ""}
          </button>
        </div>
      )}
      {/* Only when something in view actually IS blocked, and it says how many.
          As an unconditional row it cost 13px of the grid's height on every
          selection (26px at 320px wide) to explain a rule that usually applies
          to nothing on screen — and this pane is already the subject of a
          small-monitor complaint (br_50f99cbac7f106d571). */}
      {selectMode && blockedCount > 0 && (
        <p className="pc-bulk-note">
          {blockedCount === 1
            ? t("1 Pokémon here can't be selected — it's shiny, or listed at the auction house.")
            : `${blockedCount} ${t("Pokémon here can't be selected — they're shiny, or listed at the auction house.")}`}
        </p>
      )}

      <div className="pc-box-scroll" ref={scrollRef} onScroll={onScroll}>
        {total === 0 ? (
          <div className="pc-box-empty">
            <p>
              {filtering
                ? t("No stored Pokémon match these filters.")
                : t("Your PC is empty. Drag a Pokémon here from your party to deposit it.")}
            </p>
            {filtering && (
              <button
                type="button"
                className="pc-tool"
                onClick={() => { setQuery(""); setShinyOnly(false); setIvTier("any"); }}
              >
                {t("Clear filters")}
              </button>
            )}
            {/* The deposit target survives the empty state, filter or no
                filter. Dropping a party member into an empty box used to
                work only because the grid padded itself with thirty
                invisible cells; losing it here would be a real regression. */}
            {canDeposit && (
              <div className="pc-empty-drop">
                <BoxSlot pokemon={undefined} index={box.length} showName={false} />
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Spacers stand in for the rows outside the window. Every row is
                the same height and every column is 1fr, so the whole
                virtualiser is this arithmetic — no library, no rect cache. */}
            <div style={{ height: firstRow * pitch }} aria-hidden />
            <div
              className="pc-box-grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridAutoRows: `${rowH}px`,
                gap: `${gap}px`,
              }}
            >
              {cells.map((cell, i) => (
                // Keyed on the real box index (not the Pokémon id) so a cell
                // keeps its identity across renders even if a save ever
                // carried duplicate ids, and so drag state survives an
                // in-place REORDER_BOX.
                <BoxSlot
                  key={cell.p ? `p${cell.index}` : `deposit${from + i}`}
                  pokemon={cell.p}
                  index={cell.index}
                  showName={metrics.name > 0}
                  selectMode={selectMode}
                  selected={!!cell.p && selected.has(cell.p.id)}
                  onToggleSelect={toggleSelected}
                />
              ))}
            </div>
            <div style={{ height: Math.max(0, (totalRows - lastRow) * pitch) }} aria-hidden />
          </>
        )}
      </div>
    </div>
  );
}

function BoxSlot({
  pokemon: p,
  index: real,
  showName,
  selectMode = false,
  selected = false,
  onToggleSelect,
}: {
  pokemon: Pokemon | undefined;
  index: number;
  showName: boolean;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { state, dispatch } = useGame();
  const t = useT();
  const listedIds = state.listedPokemonIds ?? [];
  const isListed = !!p && listedIds.includes(p.id);
  const bulkOk = !!p && isBulkReleasable(p, listedIds);

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
    // Dragging is disabled in selection mode. A long-press that starts a drag
    // and a tap that toggles a checkbox are the same gesture on a touchscreen,
    // and the one that loses that race would be a mon dragged into the party
    // while the player thought they were ticking it for release.
    enabled: !!p && !selectMode,
  });

  return (
    <div
      ref={slotRef}
      className={`pc-slot pc-box-slot ${!p ? "empty" : ""}`}
      title={!p ? t("Drag a Pokémon from your party here to deposit it.") : undefined}
    >
      {/* The trailing slot used to be one of twenty-seven fully transparent
          cells, which read as "the PC is broken" rather than "this is the
          end of the box". One dashed plate says the same thing on purpose. */}
      {!p && <span className="pc-deposit" aria-hidden>+</span>}
      {p && (
        <button
          ref={cellRef}
          className={`pc-cell${selectMode ? " selecting" : ""}${
            selected ? " selected" : ""
          }${selectMode && !bulkOk ? " unselectable" : ""}${isListed ? " listed" : ""}`}
          aria-pressed={selectMode ? selected : undefined}
          disabled={selectMode && !bulkOk}
          onClick={() => {
            // In selection mode a tap ticks the cell instead of opening the
            // detail modal. `bulkOk` already gates shinies and auction-listed
            // mons, and the button is disabled for them, so this cannot select
            // something RELEASE_MANY would then refuse.
            if (selectMode) {
              if (bulkOk && p) onToggleSelect?.(p.id);
              return;
            }
            openPokemonDetail({ type: "box", index: real });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            if (selectMode) return;
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
                disabled: isListed,
                onClick: () => {
                  // needsReleaseConfirm, not the raw setting: a SHINY always
                  // asks even with "skip confirmation" on. See
                  // utils/releaseConfirm.ts.
                  if (
                    needsReleaseConfirm(p, state.skipReleaseConfirm) &&
                    !window.confirm(`Release ${p.nickname ?? p.name}? This cannot be undone.`)
                  ) {
                    return;
                  }
                  // `pokemonId` alongside the index: this closure was frozen
                  // when the menu opened, and an auction settling or a cloud
                  // reconcile in between shifts `real` onto another Pokémon.
                  dispatch({
                    type: "RELEASE_POKEMON",
                    payload: { source: "box", index: real, pokemonId: p.id },
                  });
                },
              },
            ]);
          }}
          title={`${p.nickname ?? p.name} · Lv.${p.level} · IV ${Math.round(
            (ivTotal(p) / IV_MAX_TOTAL) * 100
          )}% · tap for details · hold-and-drag to move · right-click for actions`}
        >
          {/* Square plate. It, not the cell, is what the sprite is measured
              against — the cell used to be 1:0.85 in one layout and 1:1.87 in
              another, and a 74px Gyarados was squashed to 50px on a phone
              while half the cell sat empty. */}
          <span className="pc-cell-plate">
            {/* The GIF→static-PNG fallback that used to live here inline is
                now PokemonSprite's job, along with the retry that makes a
                transient CDN failure recoverable. */}
            <PokemonSprite
              className="pc-cell-sprite"
              speciesKey={p.speciesKey}
              isShiny={p.isShiny}
              alt={p.name}
              style={{ imageRendering: "pixelated" }}
              draggable={false}
            />
            {/* Level, corner-mounted so it costs the row no height. Bottom
                LEFT, not right: the held-item badge already owns the bottom
                right. It used to be a max-contrast white-on-black pill in the
                top-left — the first thing the eye landed on in a cell whose
                whole job is showing a Pokémon. */}
            <span className="pc-cell-lv">{p.level}</span>
            {p.isShiny && <span className="pc-cell-shiny" aria-hidden>✦</span>}
            {/* Selection tick. Rendered inside the plate so it scales with the
                cell at both densities. A cell that cannot be bulk-released
                shows a lock rather than an empty box, so "why won't this one
                tick" answers itself. */}
            {selectMode && (
              <span
                className={`pc-cell-check${selected ? " on" : ""}${!bulkOk ? " locked" : ""}`}
                aria-hidden
              >
                {!bulkOk ? "🔒" : selected ? "✓" : ""}
              </span>
            )}
            {isListed && !selectMode && (
              <span className="pc-cell-listed" title={t("Listed at the auction house")} aria-hidden>⚖</span>
            )}
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
          </span>
          {/* The literal answer to "make it easier to see the Pokémon we
              have": at a 44px median sprite most species are not tellable
              apart, and the box had no names anywhere. */}
          {showName && <span className="pc-cell-label">{p.nickname ?? p.name}</span>}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pokédex — tri-state grid (unseen black / seen gray / caught color).
//
// Rebuilt on the PC's recipe, for the PC's reasons. The hero ring, the
// 18-type completion strip, the filter pills and the legend stacked
// 338–613px of chrome above the first sprite — at every desktop size the
// grid opened below the fold — and all 288 cells mounted at once as
// animated GIFs (~11MB of sprite traffic for one full scroll). Now the
// chrome is one toolbar row, the grid is a scroll window over static
// PNGs, and the trophy case (ring, milestones, per-type bars) lives one
// tap away behind the progress chip instead of taxing every open.
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

/** Dex cell geometry per density — same contract as DENSITY_METRICS above:
 *  `min` drives the column count, `name` is the label strip under the sprite
 *  plate (0 = no strip), `gap` is part of the row pitch. Slightly tighter
 *  than the PC's: dex cells carry no drag affordance or held-item badge. */
const DEX_DENSITY_KEY = "pokemon-idle-dex-density";
const DEX_DENSITY_METRICS: Record<Density, { min: number; name: number; gap: number }> = {
  comfy:   { min: 64, name: 14, gap: 4 },
  compact: { min: 44, name: 0,  gap: 3 },
};

function readDexDensity(): Density {
  try {
    return localStorage.getItem(DEX_DENSITY_KEY) === "compact" ? "compact" : "comfy";
  } catch {
    return "comfy";
  }
}

/**
 * One dex entry. Memoised, with primitive props only, on purpose: DexTab
 * re-renders on every battle tick (the owned set reads state.party, whose
 * identity changes each tick), and without the memo every mounted cell
 * reconciled several times a second for a grid that almost never changes.
 * With it, a tick that changes nothing stops at zero re-rendered cells.
 */
const DexCell = memo(function DexCell({
  speciesKey, id, name, caught, seen, owned, shiny, unreleased, showName, onPick, t,
}: {
  speciesKey: string;
  id: number;
  name: string;
  caught: boolean;
  seen: boolean;
  owned: boolean;
  shiny: boolean;
  unreleased: boolean;
  showName: boolean;
  onPick: (key: string) => void;
  t: (str: string) => string;
}) {
  const filterCss = caught
    ? "none"
    : seen
    ? "grayscale(1) brightness(0.85)"
    : "brightness(0)";
  return (
    <button
      type="button"
      className={[
        "dex3-cell",
        caught ? "caught" : seen ? "seen" : "unknown",
        // Registered but gone: still a completed dex entry, so it
        // keeps its colour — it just stops claiming you have one.
        caught && !owned ? "registered-only" : "",
        shiny ? "is-shiny" : "",
        /* Unreleased species are marked so a completionist doesn't hunt
           for something that has no encounter yet — they're excluded
           from the counts, but still occupy their dex number. */
        unreleased ? "unreleased" : "",
      ].filter(Boolean).join(" ")}
      /* Unseen cells open the modal too. It reveals location leads only
         (see DexSpeciesModal) — a disabled cell was a dead end: the exact
         entries a completionist needs to hunt were the only ones the dex
         refused to say anything about. */
      onClick={() => onPick(speciesKey)}
      title={dexCellTitle(name, { owned, caught, seen, released: !unreleased }, t)}
    >
      <span className="dex3-plate">
        {/* Static PNG, not the animated GIF: identifying a species is the
            grid's job and the modal hero keeps the animation. 288 looping
            GIFs measured ~11MB for one full scroll of the old grid. */}
        <Sprite
          className="dex3-sprite"
          src={pokemonStaticSpriteUrl(id, shiny && caught)}
          alt={caught || seen ? name : "???"}
          style={{ imageRendering: "pixelated", filter: filterCss }}
          draggable={false}
        />
        <small className="dex3-id tabular">#{String(id).padStart(3, "0")}</small>
        {shiny && <span className="dex-cell-shiny" aria-hidden>✨</span>}
      </span>
      {showName && <span className="dex3-name">{name}</span>}
    </button>
  );
});

/**
 * The trophy case — completion ring, seen/shiny counters, milestones and
 * the per-type bars, unchanged in code and semantics, just moved behind
 * the toolbar's progress chip. It used to be 210–513px of every open;
 * it's consulted occasionally, so it pays for itself only on request.
 */
function DexProgressSheet({ onClose }: { onClose: () => void }) {
  const { state } = useGame();
  const t = useT();
  const dialogRef = useModalEnter(".dex-hero, .dex-types");

  const all = useMemo(() => Object.entries(pokemonTable).sort(([, a], [, b]) => a.id - b.id), []);
  const caughtSet = useMemo(() => new Set(state.pokedexCaught), [state.pokedexCaught]);

  // Declared ahead of typeCompletion: that memo runs during this render and
  // reads `obtainable`, so a later `const` would hit the temporal dead zone
  // and throw before the sheet could paint.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, caughtSet]);

  const dexTotal = obtainableCount();
  const caughtObtainable = state.pokedexCaught.filter((k) => obtainable.has(k)).length;
  const completion = Math.min(100, (caughtObtainable / Math.max(1, dexTotal)) * 100);
  // Master lands exactly on 100% — the same moment the Shiny Charm is granted
  // and the full-dex trophy unlocks, so all three agree.
  const milestones = [
    ...DEX_MILESTONES.filter((m) => m.count < dexTotal),
    { count: dexTotal, label: "Master", icon: "🏆" },
  ];
  const nextMilestone = milestones.find((m) => caughtObtainable < m.count);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="g-modal dex-progress-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Pokédex progress")}
      >
        <header className="g-modal-head">
          <h2>{t("Pokédex progress")}</h2>
          <button className="g-modal-close" onClick={onClose} aria-label={t("Close")}>×</button>
        </header>
        <div className="g-modal-body">
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

          <section className="dex-types">
            {DEX_TYPES.map((ty) => {
              const bucket = typeCompletion[ty];
              if (!bucket || bucket.total === 0) return null;
              const pct = (bucket.caught / Math.max(1, bucket.total)) * 100;
              const complete = bucket.caught === bucket.total;
              return (
                <div key={ty} className={`dex-type-pill type-${ty.toLowerCase()} ${complete ? "complete" : ""}`} title={`${ty}: ${bucket.caught} / ${bucket.total}`}>
                  <span className="dex-type-name">{ty}</span>
                  <span className="dex-type-bar">
                    <span className="dex-type-bar-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="dex-type-num tabular">{bucket.caught}/{bucket.total}</span>
                </div>
              );
            })}
          </section>
        </div>
      </div>
    </div>
  );
}

export function DexTab() {
  const { state } = useGame();
  const t = useT();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<DexFilter>("all");
  const [typeFilter, setTypeFilter] = useState<PokemonType | null>(null);
  const [density, setDensity] = useState<Density>(readDexDensity);
  const [progressOpen, setProgressOpen] = useState(false);

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

  const obtainable = obtainableSpecies();
  const filtering = filter !== "all" || typeFilter !== null || q !== "";

  const filtered = useMemo(() => {
    let base = all;
    if (filter === "caught")  base = base.filter(([k]) => caughtSet.has(k));
    if (filter === "seen")    base = base.filter(([k]) => seenSet.has(k) && !caughtSet.has(k));
    if (filter === "shiny")   base = base.filter(([k]) => shinySet.has(k));
    if (filter === "unknown") base = base.filter(([k]) => !seenSet.has(k));
    if (typeFilter) base = base.filter(([, sp]) => sp.types.includes(typeFilter));
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
  }, [all, filter, typeFilter, caughtSet, seenSet, shinySet, q]);

  // Count against species that can ACTUALLY be caught. Using the raw
  // pokemonTable size meant ~35 Johto entries that exist for dex numbering but
  // have no encounter table were in the denominator, so a player who had
  // caught literally everything available was shown ~234/288 and could never
  // reach 100%. obtainableSpecies() derives this from the data, so the total
  // grows by itself the moment those species are released.
  const dexTotal = obtainableCount();
  const caughtObtainable = state.pokedexCaught.filter((k) => obtainable.has(k)).length;
  const completion = Math.min(100, (caughtObtainable / Math.max(1, dexTotal)) * 100);

  // ---- Grid geometry ------------------------------------------------------
  // The PC box's spacer arithmetic, dex-sized — see PCTab above for why the
  // column count is computed here instead of left to `auto-fill`.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, padTop: 0 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el);
      const padT = parseFloat(cs.paddingTop) || 0;
      const padB = parseFloat(cs.paddingBottom) || 0;
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      const w = el.clientWidth - padL - padR;
      const h = el.clientHeight - padT - padB;
      setSize((prev) => (prev.w === w && prev.h === h && prev.padTop === padT ? prev : { w, h, padTop: padT }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = DEX_DENSITY_METRICS[density];
  const gap = metrics.gap;
  const cols = Math.max(1, Math.floor((size.w + gap) / (metrics.min + gap)));
  const cellW = size.w > 0 ? (size.w - gap * (cols - 1)) / cols : metrics.min;
  const rowH = Math.round(cellW) + metrics.name;
  const pitch = rowH + gap;

  const [topRow, setTopRow] = useState(0);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const row = Math.max(0, Math.floor((e.currentTarget.scrollTop - size.padTop) / pitch));
    setTopRow((prev) => (prev === row ? prev : row));
  };
  // Narrowing the filter while parked deep in the grid would otherwise leave
  // the player staring at blank space below the last match.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setTopRow(0);
  }, [query, filter, typeFilter, density]);

  const total = filtered.length;
  const totalRows = Math.ceil(total / cols);
  const anchorRow = Math.min(topRow, Math.max(0, totalRows - 1));
  const firstRow = Math.max(0, anchorRow - OVERSCAN_ROWS);
  const lastRow = Math.min(
    totalRows,
    anchorRow + Math.ceil(size.h / pitch) + 1 + OVERSCAN_ROWS
  );
  const from = firstRow * cols;
  const to = Math.min(total, lastRow * cols);

  const onPick = useCallback((key: string) => setPicked(key), []);

  const clearFilters = () => { setQuery(""); setFilter("all"); setTypeFilter(null); };

  const toggleDensity = () => {
    setDensity((prev) => {
      const next: Density = prev === "comfy" ? "compact" : "comfy";
      try { localStorage.setItem(DEX_DENSITY_KEY, next); } catch { /* private mode — session only */ }
      return next;
    });
  };

  // Legend swatch, worn by the filter rows — the menu doubles as the legend,
  // which used to be its own permanent strip above the grid.
  const swatch = (cls: string) => <span className={`dex-swatch ${cls}`} aria-hidden />;
  const filterIcon = (on: boolean, cls: string) => (
    <span className="dex-menu-ic">{tick(on)}{swatch(cls)}</span>
  );

  const openTypeMenu = (at: { clientX: number; clientY: number }) => {
    openContextMenu(at, [
      { label: t("Any type"), icon: tick(typeFilter === null), onClick: () => setTypeFilter(null) },
      ...DEX_TYPES.map((ty) => ({
        label: ty as string,
        icon: tick(typeFilter === ty),
        onClick: () => setTypeFilter(ty),
      })),
    ]);
  };

  const openFilterMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = { clientX: r.left, clientY: r.bottom + 4 };
    openContextMenu(at, [
      { label: t("All"), icon: tick(filter === "all"), onClick: () => setFilter("all") },
      { label: t("Caught"), icon: filterIcon(filter === "caught", "owned"), onClick: () => setFilter("caught") },
      { label: t("Seen only"), icon: filterIcon(filter === "seen", "seen"), onClick: () => setFilter("seen") },
      { label: t("✨ Shiny"), icon: filterIcon(filter === "shiny", "shiny"), onClick: () => setFilter("shiny") },
      { label: t("Undiscovered"), icon: filterIcon(filter === "unknown", "unknown"), onClick: () => setFilter("unknown") },
      // Legend-only row: the fourth sprite treatment has no filter of its
      // own (registered-but-gone is a sub-state of Caught). A disabled row
      // is the closest thing this menu has to a footnote.
      { label: t("Faded = registered, none owned"), icon: swatch("registered"), disabled: true, onClick: () => undefined },
      {
        label: typeFilter ? `${t("Type")}: ${typeFilter}` : t("Type: any"),
        hint: "›",
        // Reopened one tick later on purpose: the menu host runs onClick and
        // THEN closes itself, so a synchronous openContextMenu here would be
        // wiped by that close.
        onClick: () => { setTimeout(() => openTypeMenu(at), 0); },
      },
      { label: t("Clear filters"), disabled: !filtering, onClick: clearFilters },
    ]);
  };

  const emptyMessage = (): string => {
    if (filter === "shiny" && !q) {
      // Real numbers from rollShiny (utils/pokemon.ts) — the empty state
      // doubles as the pitch for why the shiny filter exists at all.
      return hasShinyCharm(state)
        ? t("No shinies yet — every encounter rolls 1 in 4,096 with your Shiny Charm.")
        : t("No shinies yet — every encounter rolls 1 in 8,192.");
    }
    if (filter === "unknown" && !q) return t("Nothing left undiscovered.");
    return t("Nothing matches the current filter.");
  };

  const cells: ReactNode[] = [];
  for (let at = from; at < to; at++) {
    const [key, sp] = filtered[at];
    cells.push(
      <DexCell
        key={key}
        speciesKey={key}
        id={sp.id}
        name={sp.name}
        caught={caughtSet.has(key)}
        seen={seenSet.has(key)}
        // Not gated on `caught` — ownership is a fact about your boxes, and
        // gating it would make this cell disagree with the species modal,
        // which reads the same lists.
        owned={ownedSet.has(key)}
        shiny={shinySet.has(key)}
        unreleased={!obtainable.has(key)}
        showName={metrics.name > 0}
        onPick={onPick}
        t={t}
      />
    );
  }

  return (
    <div className="tab-pane dex-tab dex-tab-v3">
      {/* One row, not four. The hero, the type strip, the pills and the
          legend spent 338px (desktop) to 613px (wide rail) before the first
          sprite — the entire pane and then some. Search keeps permanent
          space because it is the only navigation that scales to 288 entries;
          the progress headline shrinks to a chip; everything else folds into
          the filter menu. */}
      <div className="dex-toolbar">
        <button
          type="button"
          className="dex-progress-chip"
          onClick={() => setProgressOpen(true)}
          title={t("Pokédex progress — open the full breakdown")}
        >
          <span className="dex-chip-count tabular">
            {caughtObtainable}<span className="dex-chip-dim"> / {dexTotal}</span>
          </span>
          <span className="dex-progress-track" aria-hidden>
            <span className="dex-progress-fill" style={{ width: `${completion}%` }} />
          </span>
        </button>
        <div className="dex-search-wrap">
          <input
            type="search"
            className="dex-search"
            placeholder={t("Search by name or dex #")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("Search by name or dex #")}
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
        <button
          type="button"
          className={`dex-tool ${filtering && !q ? "on" : ""}`}
          onClick={openFilterMenu}
          title={t("Filter by state and type")}
          aria-label={t("Filter by state and type")}
        >
          <IconSliders size={14} />
          {(filter !== "all" || typeFilter) && <span className="dex-tool-dot" aria-hidden />}
        </button>
        <button
          type="button"
          className="dex-tool"
          onClick={toggleDensity}
          title={density === "comfy" ? t("Switch to compact cells") : t("Switch to comfortable cells")}
          aria-label={density === "comfy" ? t("Switch to compact cells") : t("Switch to comfortable cells")}
        >
          {density === "comfy" ? <IconGridSmall size={14} /> : <IconGridLarge size={14} />}
        </button>
      </div>

      <div className="dex-scroll" ref={scrollRef} onScroll={onScroll}>
        {total === 0 ? (
          <div className="dex-empty">
            <p>{emptyMessage()}</p>
            {filtering && (
              <button type="button" className="dex-tool" onClick={clearFilters}>
                {t("Clear filters")}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Spacers stand in for the rows outside the window — the same
                no-library virtualiser as the PC box grid. */}
            <div style={{ height: firstRow * pitch }} aria-hidden />
            <div
              className="dex-grid"
              style={{
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gridAutoRows: `${rowH}px`,
                gap: `${gap}px`,
              }}
            >
              {cells}
            </div>
            <div style={{ height: Math.max(0, (totalRows - lastRow) * pitch) }} aria-hidden />
          </>
        )}
      </div>

      {progressOpen && <DexProgressSheet onClose={() => setProgressOpen(false)} />}
      {picked && <DexSpeciesModal speciesKey={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}
