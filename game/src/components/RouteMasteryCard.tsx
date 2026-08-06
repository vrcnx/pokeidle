import "./routeMastery.css";
import { useGame } from "../state/GameContext";
import { useT } from "../i18n/useT";
import { itemSpriteUrl } from "../utils/sprites";
import { getItemInfo } from "../utils/items";
import {
  MASTERY_TIERS, claimable, earnedLevel, masteryScore, nextTier, winsOn, isMasterable,
} from "../data/routeMastery";

/**
 * Route mastery, on the panel for the route you are standing on.
 *
 * ── WHY HERE AND NOT IN A TROPHY DRAWER ──────────────────────────────────
 * The reward is for grinding THIS route, so it belongs next to the route,
 * where the number it tracks is already going up in front of you. Put behind
 * a menu it becomes a thing you check occasionally; here it is a progress bar
 * that fills while you watch, which is the entire point of the mechanic.
 *
 * Rewards you have earned but not taken are listed FIRST, and for every route
 * rather than just this one — an unclaimed payout you have to go and stand on
 * the right route to collect is a chore, not a reward.
 */
export function RouteMasteryCard() {
  const { state, dispatch } = useGame();
  const t = useT();

  const here = state.currentRoute;
  const ready = claimable(state);
  const showHere = isMasterable(here);

  // Nothing to say on a town or in a raid, with nothing banked anywhere.
  if (!showHere && ready.length === 0) return null;

  const wins = winsOn(state, here);
  const level = earnedLevel(wins);
  const next = nextTier(wins);
  const pct = next
    ? Math.min(100, Math.round((wins / next.wins) * 100))
    : 100;

  return (
    <div className="mastery-card">
      <div className="mastery-head">
        <h3>{t("Route Mastery")}</h3>
        <span className="mastery-score" title={t("Tiers earned across every route")}>
          {masteryScore(state)}
        </span>
      </div>

      {ready.length > 0 && (
        <ul className="mastery-ready">
          {ready.map((c) => (
            <li key={c.key}>
              <span className="mastery-ready-what">
                {c.routeName} · {t(c.tier.label)}
              </span>
              <button
                type="button"
                className="mastery-claim"
                onClick={() => dispatch({ type: "CLAIM_MASTERY", payload: { key: c.key } })}
              >
                {c.tier.reward.kind === "item" ? (
                  <>
                    <img
                      src={itemSpriteUrl(c.tier.reward.itemId)}
                      alt=""
                      width={16}
                      height={16}
                      draggable={false}
                    />
                    {t("Claim")} {c.tier.reward.quantity}×
                  </>
                ) : (
                  <>🎟 {t("Claim")} {c.tier.reward.amount}</>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {showHere && (
        <div className="mastery-here">
          <div className="mastery-bar" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="mastery-line">
            {next ? (
              <>
                <strong>{wins.toLocaleString()}</strong>
                {" / "}
                {next.wins.toLocaleString()} {t("wins")} — {t(next.label)}
                {next.reward.kind === "item" && (
                  <span className="mastery-next-prize">
                    {" · "}
                    {next.reward.quantity}× {getItemInfo(next.reward.itemId).name}
                  </span>
                )}
                {next.reward.kind === "tokens" && (
                  <span className="mastery-next-prize">
                    {" · "}{next.reward.amount} {t("Victory Token")}
                  </span>
                )}
              </>
            ) : (
              <>{t("Fully mastered")} — {wins.toLocaleString()} {t("wins")}</>
            )}
          </p>
          <div className="mastery-pips" aria-hidden>
            {MASTERY_TIERS.map((tier) => (
              <span key={tier.level} className={tier.level <= level ? "mastery-on" : ""} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
