import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { TownMap } from "./TownMap";
import { pokemonSpriteUrl, itemSpriteUrl } from "../utils/sprites";
import { pokemonTable } from "../data/pokemon";
import { routes } from "../data/routes";
import { shops } from "../data/shops";
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

  return (
    <div className="bottom-tabs">
      <nav className="bottom-tab-strip" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`bottom-tab ${active === t.id ? "active" : ""}`}
            onClick={() => setActive(t.id)}
          >
            <span className="bottom-tab-icon">{t.icon}</span>
            <span className="bottom-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="bottom-tab-body">
        {active === "map"  && <TownMap />}
        {active === "mart" && <MartTab />}
        {active === "bag"  && <BagTab />}
        {active === "pc"   && <PCTab />}
        {active === "dex"  && <DexTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mart — town-only stub for now.
// ---------------------------------------------------------------------------
export function MartTab() {
  const { state, dispatch } = useGame();
  const here = state.currentLocation;
  const route = routes[here];
  const isTown = route?.type === "town";
  const shop = isTown ? shops[here] : null;
  // When the player hits Buy, the row swaps into a quantity adjuster so
  // they can buy in bulk. Only one row can be pending at a time.
  const [pending, setPending] = useState<{ itemId: string; qty: number } | null>(null);

  // Cancel the pending row whenever the player travels — prevents the row
  // sticking around when the shop changes underneath it.
  useEffect(() => { setPending(null); }, [here]);

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

  return (
    <div className="tab-pane mart-tab">
      <TabPaneHead
        title={`${route?.name ?? "Mart"} · Mart`}
        meta={<span className="mart-wallet">💰 ${state.money.toLocaleString()}</span>}
      />
      {!isTown ? (
        <p className="dim small">Marts are only open in towns. Travel to a city to shop.</p>
      ) : !shop ? (
        <p className="dim small">No mart in this town yet.</p>
      ) : (
        <ul className="mart-list">
          {shop.items.map((entry) => {
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
                  <strong>{info.name}</strong>
                  {locked ? (
                    <small className="dim">
                      Unlocks at {entry.unlockWildBattlesWon} wild battles
                    </small>
                  ) : (
                    <small className="dim">{resolved.description}</small>
                  )}
                </div>
                <span className="mart-price">${resolved.price.toLocaleString()}</span>
                <div className="mart-qty-controls">
                  <button
                    type="button"
                    className="mart-qty-step"
                    onClick={() =>
                      setPending({ itemId: entry.itemId, qty: Math.max(1, qty - 1) })
                    }
                    disabled={qty <= 1 || locked}
                    aria-label="Decrease quantity"
                  >
                    −
                  </button>
                  <span className="mart-qty-value">{qty}</span>
                  <button
                    type="button"
                    className="mart-qty-step"
                    onClick={() =>
                      setPending({ itemId: entry.itemId, qty: Math.min(maxAffordable, qty + 1) })
                    }
                    disabled={qty >= maxAffordable || locked}
                    aria-label="Increase quantity"
                  >
                    +
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
                    Buy{qty > 1 ? ` ${qty}` : ""}
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
        title="Bag"
        meta={`${items.length} item type${items.length === 1 ? "" : "s"}`}
      />

      {/* Active effects — temporary buffs that aren't held items, like
          Exp Share. Toggleable so the player can pause the countdown
          when they don't want it consuming battles. */}
      {state.activeEffects.length > 0 && (
        <section className="bag-category bag-effects">
          <h4 className="bag-category-head">Active Effects</h4>
          <ul className="bag-list-v2">
            {state.activeEffects.map((eff) => {
              const info = getItemInfo(eff.itemId);
              return (
                <li key={eff.itemId} className={`bag-row-v2 ${eff.paused ? "paused" : ""}`}>
                  <img
                    src={itemSpriteUrl(eff.itemId, itemSpriteSlug(eff.itemId))}
                    alt=""
                    width={28}
                    height={28}
                    style={{ imageRendering: "pixelated", opacity: eff.paused ? 0.5 : 1 }}
                  />
                  <span className="bag-row-name">
                    {info.name}
                    {eff.paused && <small className="dim" style={{ marginLeft: 8 }}>paused</small>}
                  </span>
                  <span className="bag-row-count">{eff.battlesRemaining} battles</span>
                  <button
                    type="button"
                    className="effect-toggle-btn"
                    onClick={() => dispatch({ type: "TOGGLE_EFFECT_PAUSED", payload: { itemId: eff.itemId } })}
                    title={eff.paused ? "Resume — start ticking down again" : "Pause — keep battles remaining without consuming"}
                  >
                    {eff.paused ? "Resume" : "Pause"}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {items.length === 0 ? (
        <p className="dim small">Nothing in your bag.</p>
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
                    const sellPrice = cat?.sellPrice ?? 0;
                    const canSell = sellPrice > 0;
                    const isPending = sellPending?.itemId === id;
                    const sellQty = isPending ? sellPending!.qty : 1;
                    const sellTotal = sellPrice * sellQty;
                    return (
                      <li
                        key={id}
                        className={`bag-row-v2 ${notReady ? "not-ready" : ""}`}
                        title={`${info.name} — ${info.description}${notReady ? " (catalog only — mechanic not implemented yet)" : ""}`}
                      >
                        <img
                          src={itemSpriteUrl(id, itemSpriteSlug(id))}
                          alt=""
                          width={28}
                          height={28}
                          style={{ imageRendering: "pixelated" }}
                          onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0.2")}
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
                            Sell
                          </button>
                        )}
                        {isPending && (
                          <div className="bag-sell-controls" role="group" aria-label={`Sell ${info.name}`}>
                            <button
                              type="button"
                              className="mart-qty-step"
                              onClick={() => setSellPending({ itemId: id, qty: Math.max(1, sellQty - 1) })}
                              disabled={sellQty <= 1}
                              aria-label="Decrease quantity"
                            >
                              −
                            </button>
                            <span className="mart-qty-value">{sellQty}</span>
                            <button
                              type="button"
                              className="mart-qty-step"
                              onClick={() => setSellPending({ itemId: id, qty: Math.min(count, sellQty + 1) })}
                              disabled={sellQty >= count}
                              aria-label="Increase quantity"
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
                              Sell ${sellTotal.toLocaleString()}
                            </button>
                            <button
                              type="button"
                              className="bag-sell-cancel"
                              onClick={() => setSellPending(null)}
                              aria-label="Cancel selling"
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
// PC — just the storage box. Party stays in the left column; drag a party
// row into the box (or a box cell into a party row) to move/swap.
// Uses the custom dragController (touch-friendly) — see useDrag.ts.
// ---------------------------------------------------------------------------
export function PCTab() {
  const { state, dispatch } = useGame();
  const PER_PAGE = 30;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(state.box.length / PER_PAGE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const slice = state.box.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  return (
    <div className="tab-pane pc-tab">
      <TabPaneHead
        title="Pokémon Storage"
        meta={`${state.box.length} stored`}
        tools={
          <>
            <span className="dim small" style={{ marginRight: 4 }}>Sort</span>
            <button title="Sort by Pokédex number" onClick={() => dispatch({ type: "SORT_BOX", payload: { mode: "id" } })}>
              Dex#
            </button>
            <button title="Sort by level (highest first)" onClick={() => dispatch({ type: "SORT_BOX", payload: { mode: "level" } })}>
              Lv
            </button>
            <button title="Sort alphabetically" onClick={() => dispatch({ type: "SORT_BOX", payload: { mode: "name" } })}>
              A–Z
            </button>
            {pageCount > 1 && (
              <span className="pc-pager" style={{ marginLeft: "auto" }}>
                <button onClick={() => setPage((i) => Math.max(0, i - 1))} disabled={page === 0}>‹</button>
                <span className="dim small">Box {page + 1}/{pageCount}</span>
                <button onClick={() => setPage((i) => Math.min(pageCount - 1, i + 1))} disabled={page >= pageCount - 1}>›</button>
              </span>
            )}
          </>
        }
      />
      <div className="pc-box-grid box-mode tab-box-grid">
        {Array.from({ length: PER_PAGE }, (_, i) => {
          const real = page * PER_PAGE + i;
          const p = slice[i];
          return <BoxSlot key={real} pokemon={p} index={real} />;
        })}
      </div>
      <p className="dim small" style={{ margin: "6px 0 0", textAlign: "center" }}>
        Drag from your party (left column) to deposit, or drag from here to your party.
      </p>
    </div>
  );
}

function BoxSlot({ pokemon: p, index: real }: { pokemon: Pokemon | undefined; index: number }) {
  const { state, dispatch } = useGame();

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
        return fromIdx !== real;
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
      // box→box reordering isn't a separate action; sort buttons cover it.
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
                label: "View details",
                onClick: () => openPokemonDetail({ type: "box", index: real }),
              },
              {
                label: partyFull ? "Send to party (full)" : "Send to party",
                disabled: partyFull,
                onClick: () =>
                  dispatch({ type: "BOX_TO_PARTY", payload: { boxIndex: real } }),
              },
              {
                label: "Release",
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
          title={`${p.name} · Lv.${p.level} · tap for details · hold-and-drag to move · right-click for actions`}
        >
          <img
            src={pokemonSpriteUrl(p.speciesKey, false, p.isShiny)}
            alt={p.name}
            width={40}
            height={40}
            style={{ imageRendering: "pixelated" }}
            draggable={false}
          />
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
export function DexTab() {
  const { state } = useGame();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const all = Object.entries(pokemonTable).sort(([, a], [, b]) => a.id - b.id);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? all.filter(([key, sp]) => {
        // Match name + dex number ("char", "006", "#6")
        const idStr = String(sp.id);
        const padded = idStr.padStart(3, "0");
        return (
          sp.name.toLowerCase().includes(q) ||
          key.toLowerCase().includes(q) ||
          idStr.includes(q.replace(/^#/, "")) ||
          padded.includes(q.replace(/^#/, ""))
        );
      })
    : all;

  return (
    <div className="tab-pane dex-tab">
      <TabPaneHead
        title="Pokédex"
        meta={`${state.pokedexCaught.length}/${all.length} caught · ${state.pokedexSeen.length} seen`}
      />
      <div className="dex-search-wrap">
        <input
          type="search"
          className="dex-search"
          placeholder="Search by name or dex #"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="dex-search-clear"
            onClick={() => setQuery("")}
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>
      <div className="dex-tab-grid">
        {filtered.length === 0 && (
          <p className="dim small" style={{ gridColumn: "1 / -1" }}>
            No Pokémon match "{query}".
          </p>
        )}
        {filtered.map(([key, sp]) => {
          const caught = state.pokedexCaught.includes(key);
          const seen = state.pokedexSeen.includes(key);
          const shiny = state.shinyCaught.includes(key);
          const filter = caught
            ? "none"
            : seen
            ? "grayscale(1) brightness(0.85)"
            : "brightness(0)";
          const clickable = seen || caught;
          return (
            <button
              key={key}
              type="button"
              className={`dex-cell ${caught ? "caught" : seen ? "seen" : "unknown"}`}
              onClick={() => clickable && setPicked(key)}
              disabled={!clickable}
              title={clickable ? sp.name : "???"}
            >
              <img
                src={pokemonSpriteUrl(key, false, shiny && caught)}
                alt={clickable ? sp.name : "???"}
                width={36}
                height={36}
                style={{ imageRendering: "pixelated", filter }}
              />
              <small>#{String(sp.id).padStart(3, "0")}</small>
            </button>
          );
        })}
      </div>
      {picked && <DexSpeciesModal speciesKey={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}
