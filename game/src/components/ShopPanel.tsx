import { useGame } from "../state/GameContext";
import { shops } from "../data/shops";
import { pokeballs } from "../data/pokeballs";
import { consumables } from "../data/consumables";
import { getItemInfo } from "../utils/items";

export function ShopPanel() {
  const { state, dispatch } = useGame();
  const shop = shops[state.currentLocation];
  if (!shop) {
    return (
      <div className="shop-panel">
        <h2>Shop</h2>
        <p>No shop in {state.currentLocation}. Travel to a town with a Poké Mart.</p>
      </div>
    );
  }
  return (
    <div className="shop-panel">
      <h2>{shop.name}</h2>
      <p>Money: ${state.money.toLocaleString()}</p>
      <ul className="shop-items">
        {shop.items.map((entry) => {
          const ball = pokeballs[entry.itemId];
          const consumable = consumables[entry.itemId];
          const def = ball ?? consumable;
          if (!def || !def.buyPrice) return null;
          const owned = state.inventory[entry.itemId] ?? 0;
          const locked =
            entry.unlockWildBattlesWon !== undefined &&
            state.wildBattlesWon < entry.unlockWildBattlesWon;
          const info = getItemInfo(entry.itemId);
          return (
            <li key={entry.itemId} className={locked ? "locked" : ""}>
              <div>
                <strong>{info.name}</strong> — ${def.buyPrice}
                <div className="shop-item-desc">{info.description}</div>
                {locked && (
                  <small>Unlocks at {entry.unlockWildBattlesWon} wild battles won.</small>
                )}
              </div>
              <div>
                <span>× {owned}</span>
                <button
                  disabled={locked || state.money < (def.buyPrice ?? Infinity)}
                  onClick={() =>
                    dispatch({
                      type: "BUY_ITEM",
                      payload: { itemId: entry.itemId, quantity: 1 },
                    })
                  }
                >
                  Buy 1
                </button>
                <button
                  disabled={locked || state.money < (def.buyPrice ?? Infinity) * 10}
                  onClick={() =>
                    dispatch({
                      type: "BUY_ITEM",
                      payload: { itemId: entry.itemId, quantity: 10 },
                    })
                  }
                >
                  Buy 10
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
