import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { rewardShopCatalog } from "../data/eliteFour";
import { getItemInfo, itemSpriteSlug } from "../utils/items";
import { itemSpriteUrl } from "../utils/sprites";
import { useModalEnter } from "../utils/animate";

// The Reward Shop trades Victory Tokens (earned from gym + champion wins)
// for utility items: Exp Share and evolution stones (including Moon
// Stone). Opened from the League card at Indigo Plateau via
// `openRewardShop()`.

let _open = false;
const _listeners = new Set<(v: boolean) => void>();
export function openRewardShop() {
  _open = true;
  for (const fn of _listeners) fn(true);
}
export function closeRewardShop() {
  _open = false;
  for (const fn of _listeners) fn(false);
}
function useRewardShopOpen(): boolean {
  const [v, setV] = useState(_open);
  useEffect(() => {
    _listeners.add(setV);
    return () => { _listeners.delete(setV); };
  }, []);
  return v;
}

export function RewardShopModal() {
  const open = useRewardShopOpen();
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={closeRewardShop}>
      <RewardShopDialog />
    </div>
  );
}

function RewardShopDialog() {
  const { state, dispatch } = useGame();
  const dialogRef = useModalEnter(".g-card");
  return (
    <div
      ref={dialogRef}
      className="g-modal reward-shop-modal-v2"
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Reward Shop"
    >
      <header className="g-modal-head">
        <h2>Reward Shop</h2>
        <button className="g-modal-close" onClick={closeRewardShop} aria-label="Close">×</button>
      </header>

      <div className="g-modal-body">
        <section className="g-card g-card-full">
          <div className="reward-token-row">
            <strong className="reward-token-count">{state.victoryTokens}</strong>
            <span className="dim">Victory Tokens</span>
          </div>
          <p className="g-help" style={{ marginTop: 0 }}>
            Earn tokens by defeating Gym Leaders and the Champion. Trade
            them here for utility items not sold in any town mart.
          </p>
        </section>

        <section className="g-card g-card-full">
          <h3>Catalog</h3>
          <ul className="reward-shop-list">
            {rewardShopCatalog.map((entry) => {
              const info = getItemInfo(entry.itemId);
              const owned = state.inventory[entry.itemId] ?? 0;
              const canAfford = state.victoryTokens >= entry.tokenCost;
              return (
                <li key={entry.itemId} className={canAfford ? "" : "locked"}>
                  <img
                    className="reward-item-icon"
                    src={itemSpriteUrl(entry.itemId, itemSpriteSlug(entry.itemId))}
                    alt=""
                    width={28}
                    height={28}
                  />
                  <div className="reward-item-info">
                    <strong>{info.name}</strong>
                    <small className="dim">{info.description}</small>
                  </div>
                  <span className="reward-item-owned">×{owned}</span>
                  <span className="reward-item-cost">
                    {entry.tokenCost} <span className="dim">Token{entry.tokenCost > 1 ? "s" : ""}</span>
                  </span>
                  <button
                    className="g-btn-primary g-btn-small"
                    disabled={!canAfford}
                    onClick={() =>
                      dispatch({
                        type: "BUY_REWARD_ITEM",
                        payload: { itemId: entry.itemId, cost: entry.tokenCost },
                      })
                    }
                  >
                    Buy
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <footer className="g-modal-foot">
        <button className="g-btn-primary" onClick={closeRewardShop}>Done</button>
      </footer>
    </div>
  );
}
