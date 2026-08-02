import type { Promo } from "../net/api";
import { PrizeChips } from "./PrizeChips";
import { useT } from "../i18n/useT";

// A free reward for doing something outside the game.
//
// ── WHY IT LOOKS DIFFERENT FROM A GIVEAWAY CARD ─────────────────────
// A giveaway is a competition: you enter, you wait, you probably lose. A promo
// is a transaction: do the thing, get the thing, guaranteed. Rendering them
// identically would be the interface telling a small lie about the odds — so a
// promo has no entry count, no countdown, no draw language, and its button is
// a link out rather than a submit.

/** Brand marks, not emoji. An emoji Discord logo reads as a placeholder. */
function PromoIcon({ icon }: { icon: string }) {
  if (icon === "discord") {
    return (
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
        <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .079.009c.12.099.245.198.372.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
      </svg>
    );
  }
  return <span aria-hidden>🎁</span>;
}

export function PromoCard({ promo }: { promo: Promo }) {
  const t = useT();
  const done = promo.state === "claimed";

  return (
    <article className={`promo-card promo-card--${promo.state}`}>
      <span className={`promo-icon promo-icon--${promo.icon}`}>
        <PromoIcon icon={promo.icon} />
      </span>

      <div className="promo-main">
        <div className="promo-title-row">
          <h3 className="promo-title">{promo.title}</h3>
          {done && <span className="promo-done">{t("Collected")}</span>}
        </div>
        <p className="promo-blurb">{promo.blurb}</p>
        {/* The prize is the reason anyone reads this card, so it is not
            buried under the copy the way a giveaway's is — a giveaway has a
            countdown and an entry count competing for that slot; this has
            nothing else to say. */}
        <PrizeChips prizes={promo.prizes} />
        {promo.note && <p className="promo-note">{promo.note}</p>}
      </div>

      {promo.cta && (
        // A real link, not a button with an onClick. It navigates to a page
        // that exists at its own URL, so it should be shareable, openable in
        // a new tab, and visible in the status bar before it is clicked.
        <a className="promo-cta" href={promo.cta.href}>
          {promo.cta.label}
          <span className="promo-cta-arrow" aria-hidden>→</span>
        </a>
      )}
    </article>
  );
}
