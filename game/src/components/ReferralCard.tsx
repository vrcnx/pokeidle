import { useEffect, useRef, useState } from "react";
import { api, type ReferralSummary } from "../net/api";
import { useT } from "../i18n/useT";
import { PrizeChips } from "./PrizeChips";

// "Invite a friend" — the one reward on this page you earn by bringing
// somebody else rather than by doing something yourself.
//
// ── WHY IT IS NOT A `Promo` ─────────────────────────────────────────
// Every other card here is a static offer with a button: a title, a prize, a
// place to go. This one carries a value unique to the player (their link),
// something to DO with it that is not navigation (copy it), and progress that
// changes while they are looking at it. Squeezing that into the Promo shape
// would have meant a per-player field on a type that describes offers, and a
// CTA that means "copy" for exactly one card.
//
// ── THE CARD IS THE ONLY PLACE THE CODE IS SHOWN ────────────────────
// There is no endpoint that maps a code back to a player, deliberately: a
// referral link gets posted in public channels, and anything that resolves
// one to an account turns that into a way to name whoever posted it. So the
// card reads its own summary and nothing reads anyone else's.

/**
 * The summary, or null while loading / when the programme is off.
 *
 * A hook rather than state inside the card because the PANE has to know too:
 * "Nothing free right now" is the wrong thing to print underneath an invite
 * card, so whoever decides that empty state needs the same answer this card
 * does. One fetch, two readers.
 */
export function useReferralSummary(): ReferralSummary | null {
  const [data, setData] = useState<ReferralSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.referralSummary()
      .then((r) => { if (!cancelled) setData(r); })
      // Silent: this is one card on a page of them, and a failed fetch should
      // cost the card, not the page.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  // Off is off: an operator who paused the programme should not have it
  // advertised, and a card describing rewards nobody will be paid is worse
  // than no card.
  return data?.enabled ? data : null;
}

export function ReferralCard({ data }: { data: ReferralSummary }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  // Built from the page the player is on, not from a configured base URL: this
  // game answers on more than one hostname, and a hardcoded one would hand
  // somebody on the wrong host a link that logs their friend out.
  const link = `${window.location.origin}/?ref=${data.code}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard is permissioned and absent over plain http. Falling back to
      // selecting the text lets the player copy it themselves, which is worse
      // than a click and much better than a button that does nothing.
      const el = document.getElementById("referral-link-field") as HTMLInputElement | null;
      el?.select();
      return;
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const pct = Math.min(100, Math.round((data.total / data.cap) * 100));
  const left = Math.max(0, data.cap - data.total);

  return (
    <article className="promo-card referral-card">
      <div className="promo-card-body">
        <h3 className="promo-title">{t("Invite your friends")}</h3>
        <p className="promo-blurb">
          {t("Every friend who starts playing from your link gets you:")}
        </p>
        {/* The SAME chips every other reward on this page uses. The card first
            shipped printing describePrizes() as text, which put "1x
            masterball" — a catalog id — directly above a Discord card showing
            a Master Ball with its sprite. */}
        <PrizeChips prizes={data.perReferral} />

        <p className="promo-blurb referral-milestone-line">
          {t("Reach")} <strong>{data.cap}</strong>{t(" friends and you also get:")}
        </p>
        <span className="referral-milestone-prizes">
          <PrizeChips prizes={data.milestone} />
          {/* A chip for the shiny, in the same row, because it IS one of the
              prizes. Not a PrizeChip proper: the pool holds several mons and
              the draw has not happened, so there is no species to name yet
              and naming one would be a promise we might not keep. */}
          {data.milestoneHasShiny && (
            <span className="gw-chip referral-shiny-chip">
              <span aria-hidden>✨</span>
              {t("a random shiny")}
            </span>
          )}
        </span>

        <div className="referral-link-row">
          <input
            id="referral-link-field"
            className="referral-link-field"
            value={link}
            readOnly
            // Selecting the whole thing on focus makes the manual path (and
            // the clipboard-blocked fallback above) one gesture.
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t("Your referral link")}
          />
          <button type="button" className="referral-copy" onClick={() => void copy()}>
            {copied ? t("Copied") : t("Copy")}
          </button>
        </div>

        <div className="referral-progress">
          <span className="referral-progress-text">
            <strong>{data.total}</strong>/{data.cap} {t("friends joined")}
          </span>
          <span className="referral-progress-bar">
            <span className="referral-progress-fill" style={{ width: `${pct}%` }} />
          </span>
        </div>

        <p className="promo-note">
          {data.milestoneReached
            ? t("You've had the full bonus — thanks for bringing people in.")
            : left > 0
              // Names the number left rather than the number done: the thing
              // the player wants to know is how far there is to go.
              ? `${left} ${left === 1 ? t("more friend to go.") : t("more friends to go.")}`
              : t("Rewards land the next time the game saves.")}
        </p>
      </div>
    </article>
  );
}
