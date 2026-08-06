import "./routeMastery.css";
import { useState } from "react";
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

  // ── THE LIST HAS NO CEILING ────────────────────────────────────────────
  // `claimable` returns every unclaimed tier on every route, and because this
  // shipped reading a counter the game has kept since launch, an established
  // save opens it with a backlog — three tiers across forty-odd routes is a
  // hundred-row list where a four-row card should be. So it shows a few and
  // folds the rest.
  //
  // Claim-all is not a shortcut past a decision: every row pays out and none
  // of them can be declined, so making somebody tap a hundred times is
  // ceremony, not consent. Each dispatch still goes through the same guard,
  // so the bulk path cannot pay anything the single path would not.
  const [expanded, setExpanded] = useState(false);
  const VISIBLE = 3;
  const shown = expanded ? ready : ready.slice(0, VISIBLE);
  const hidden = ready.length - shown.length;

  const claimAll = () => {
    for (const c of ready) {
      dispatch({ type: "CLAIM_MASTERY", payload: { key: c.key } });
    }
  };

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

      {ready.length > 1 && (
        <button type="button" className="mastery-claim-all" onClick={claimAll}>
          {t("Claim all")} · {ready.length}
        </button>
      )}

      {ready.length > 0 && (
        <ul className="mastery-ready">
          {shown.map((c) => (
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
          {(hidden > 0 || expanded) && (
            <li className="mastery-more">
              <button type="button" onClick={() => setExpanded((v) => !v)}>
                {expanded ? t("Show fewer") : `+${hidden} ${t("more")}`}
              </button>
            </li>
          )}
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
