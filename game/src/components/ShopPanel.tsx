import { useMemo, useState } from "react";
import { useGame } from "../state/GameContext";
import { buildUnifiedShop } from "../data/regions";
import { pokeballs } from "../data/pokeballs";
import { consumables } from "../data/consumables";
import { getItemInfo } from "../utils/items";
import { itemSpriteUrl } from "../utils/sprites";
import { itemSpriteSlug } from "../utils/items";
import { useT } from "../i18n/useT";

// "Progressional" Poké Mart — instead of having to travel to a specific
// town to access its stock, the mart shows the UNION of every town the
// player has visited. New items unlock the moment the player walks into
// a town that sells them; per-item wild-battle gates still apply on top.
//
// UI layout:
//   - Header: name, money, badge counter for "visited X marts"
//   - Category filter row: Pokéballs / Repels / Stones / Held Items / All
//   - Items grid: locked items grey out + show their unlock criterion
//                 with a small "Where" hint pointing at the originating town
//
// One panel for the whole region — players never see "no shop here"
// again, which was a recurring complaint.

type Category = "all" | "balls" | "repels" | "stones" | "held" | "special";

function categorize(itemId: string): Category {
  if (itemId.endsWith("ball") || itemId.includes("ball")) return "balls";
  if (itemId.includes("repel") || itemId === "honey")     return "repels";
  if (itemId.endsWith("stone"))                            return "stones";
  if (["leftovers","lifeorb","focussash","charcoal","mysticwater","magnet","miracleseed",
       "nevermeltice","blackbelt","poisonbarb","softsand","sharpbeak","twistedspoon",
       "silverpowder","hardstone","spelltag","dragonfang","blackglasses","silkscarf"]
      .includes(itemId)) return "held";
  return "special";
}

const CATEGORY_LABEL: Record<Category, string> = {
  all:     "All",
  balls:   "Poké Balls",
  repels:  "Repels",
  stones:  "Evolution Stones",
  held:    "Held Items",
  special: "Special",
};

export function ShopPanel() {
  const { state, dispatch } = useGame();
  const [category, setCategory] = useState<Category>("all");

  const unified = useMemo(
    () => buildUnifiedShop(state.unlockedLocations),
    [state.unlockedLocations],
  );

  const t = useT();

  if (unified.visitedTownsWithMart === 0) {
    return (
      <div className="shop-panel">
        <header className="shop-panel-head">
          <h2>{t("Poké Mart")}</h2>
        </header>
        <p className="dim">{t("No mart has opened to you yet. Visit Viridian City to unlock your first stock.")}</p>
      </div>
    );
  }

  // Sort: unlocked first by category, then by buy price (cheapest first).
  const items = unified.items.slice().sort((a, b) => {
    const aDef = pokeballs[a.itemId] ?? consumables[a.itemId];
    const bDef = pokeballs[b.itemId] ?? consumables[b.itemId];
    return (aDef?.buyPrice ?? Infinity) - (bDef?.buyPrice ?? Infinity);
  });

  const filtered = category === "all" ? items : items.filter((i) => categorize(i.itemId) === category);

  const lockedCount = filtered.filter((i) =>
    i.unlockWildBattlesWon !== undefined && state.wildBattlesWon < i.unlockWildBattlesWon,
  ).length;

  return (
    <div className="shop-panel mart-v2">
      <header className="mart-head">
        <div className="mart-head-title">
          <h2>{t("Poké Mart")}</h2>
          <p className="dim small">
            Universal stock · {unified.visitedTownsWithMart} town{unified.visitedTownsWithMart === 1 ? "" : "s"} visited
          </p>
        </div>
        <div className="mart-money" title={t("Money on hand")}>
          <span className="mart-money-coin">$</span>
          <strong>{state.money.toLocaleString()}</strong>
        </div>
      </header>

      <nav className="mart-categories" role="tablist" aria-label={t("Mart category")}>
        {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => {
          const count = c === "all" ? items.length : items.filter((i) => categorize(i.itemId) === c).length;
          if (c !== "all" && count === 0) return null;
          return (
            <button
              key={c}
              role="tab"
              aria-selected={category === c}
              className={`mart-category ${category === c ? "active" : ""}`}
              onClick={() => setCategory(c)}
            >
              {t(CATEGORY_LABEL[c])}
              <span className="mart-category-count">{count}</span>
            </button>
          );
        })}
      </nav>

      <ul className="mart-items">
        {filtered.map((entry) => {
          const ball = pokeballs[entry.itemId];
          const consumable = consumables[entry.itemId];
          const def = ball ?? consumable;
          if (!def || !def.buyPrice) return null;
          const owned = state.inventory[entry.itemId] ?? 0;
          const locked =
            entry.unlockWildBattlesWon !== undefined &&
            state.wildBattlesWon < entry.unlockWildBattlesWon;
          const info = getItemInfo(entry.itemId);
          const price = def.buyPrice;
          const canBuy1  = !locked && state.money >= price;
          const canBuy10 = !locked && state.money >= price * 10;
          return (
            <li key={entry.itemId} className={`mart-item ${locked ? "locked" : ""}`}>
              <div className="mart-item-sprite">
                <img
                  src={itemSpriteUrl(entry.itemId, itemSpriteSlug(entry.itemId))}
                  alt=""
                  width={36}
                  height={36}
                  style={{ imageRendering: "pixelated" }}
                />
              </div>
              <div className="mart-item-info">
                <div className="mart-item-name">
                  <strong>{info.name}</strong>
                  <span className="mart-item-price tabular">${price.toLocaleString()}</span>
                </div>
                <div className="mart-item-desc dim small">{info.description}</div>
                {locked
                  ? (
                    <div className="mart-item-lock">
                      <span className="mart-lock-icon">🔒</span>
                      <span>{state.wildBattlesWon} / {entry.unlockWildBattlesWon} wild battles won</span>
                    </div>
                  )
                  : (
                    <div className="mart-item-hint dim small">
                      Stock × {owned} · First found at {entry.firstSoldAtName}
                    </div>
                  )
                }
              </div>
              <div className="mart-item-buy">
                <button
                  className="mart-buy-btn"
                  disabled={!canBuy1}
                  onClick={() => dispatch({ type: "BUY_ITEM", payload: { itemId: entry.itemId, quantity: 1 } })}
                >
                  {t("Buy")}
                </button>
                <button
                  className="mart-buy-btn mart-buy-x10"
                  disabled={!canBuy10}
                  onClick={() => dispatch({ type: "BUY_ITEM", payload: { itemId: entry.itemId, quantity: 10 } })}
                >
                  ×10
                </button>
              </div>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="dim small mart-empty">{t("No items in this category yet.")}</li>
        )}
      </ul>

      {lockedCount > 0 && category !== "all" && (
        <p className="dim small" style={{ marginTop: 12 }}>
          {lockedCount} item{lockedCount === 1 ? "" : "s"} locked · keep battling wild Pokémon to unlock.
        </p>
      )}
    </div>
  );
}
