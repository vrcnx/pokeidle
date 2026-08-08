import { useEffect, useState } from "react";
import { api, type ProgressionStatus } from "../net/api";
import { useT } from "../i18n/useT";

// "Keep playing" — the reward you earn simply by getting stronger.
//
// ── WHY IT SHOWS A LEVEL AND NOT A CLAIM BUTTON ─────────────────────
// There is no claim endpoint and there should not be. Tiers are paid by the
// save upload that observes the level (server/src/lib/progression.ts), which
// means the reward is already on its way before this card can be looked at.
// A button would be a second path to the same payment, and this is the one
// reward in the game whose trigger the player controls directly.
//
// So the card's whole job is to answer two questions: how far to the next
// one, and what it pays.

/**
 * The status, or null while loading.
 *
 * A hook, like the referral card's, so the Rewards pane can decide its empty
 * state knowing whether this card will render.
 */
export function useProgressionStatus(): ProgressionStatus | null {
  const [data, setData] = useState<ProgressionStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.progressionStatus()
      .then((r) => { if (!cancelled) setData(r); })
      // Silent: one card on a page of them, and a failed fetch should cost
      // the card rather than the page.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return data;
}

export function ProgressionCard({ data }: { data: ProgressionStatus }) {
  const t = useT();
  const pct = Math.round(data.progress * 100);
  const toGo = Math.max(0, data.nextLevel - data.level);

  // The window between crossing a tier and the upload that pays it. Saying so
  // is better than either lie available: pretending it is already collected,
  // or showing nothing and letting the player think a level they can see they
  // reached was missed.
  const owed = data.reachedTier - data.paidTier;

  return (
    <article className="promo-card progression-card">
      <div className="promo-card-body">
        <h3 className="promo-title">{t("Keep playing")}</h3>
        <p className="promo-blurb">
          {t("Every milestone level pays out, and they never stop — the rewards grow with you.")}
        </p>

        <div className="progression-now">
          <span className="progression-level">
            <span className="dim">{t("Level")}</span> <strong>{data.level.toLocaleString()}</strong>
          </span>
          <span className="progression-next">
            {toGo > 0
              ? <>{toGo} {toGo === 1 ? t("level to go") : t("levels to go")}</>
              : t("Reward on its way")}
          </span>
        </div>

        <div className="progression-bar" aria-hidden>
          <span className="progression-fill" style={{ width: `${pct}%` }} />
        </div>

        <p className="progression-target">
          {t("Level")} <strong>{data.nextLevel.toLocaleString()}</strong>
          {" — "}
          <span className="progression-prize">{data.nextSummary}</span>
        </p>

        {owed > 0 && (
          <p className="promo-note">
            {owed === 1
              ? t("1 reward is queued — it lands the next time the game saves.")
              : `${owed} ${t("rewards are queued — they land the next time the game saves.")}`}
          </p>
        )}
      </div>
    </article>
  );
}
