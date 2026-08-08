import { useEffect, useState } from "react";
import { api, type RedditRewardStatus } from "../net/api";
import { useT } from "../i18n/useT";
import { PrizeChips } from "./PrizeChips";
import { pushToast } from "./Toast";

// "Post about us on Reddit" — a reward for a link.
//
// ── THE CARD IS HONEST ABOUT WHAT IT ASKS FOR ───────────────────────
// The server does not verify the link (see server/src/lib/redditReward.ts),
// and this card does not pretend otherwise: it asks for a post, it takes a
// link, and it pays. What it does NOT do is imply a check that is not
// happening — no "verifying…", no spinner theatre, no "we'll review it and get
// back to you". The prize arrives immediately because that is what actually
// happens.
//
// It is one per account, and the card says so up front rather than after
// somebody has posted a second time expecting a second reward.

export function useRedditReward(): RedditRewardStatus | null {
  const [data, setData] = useState<RedditRewardStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.redditReward()
      .then((r) => { if (!cancelled) setData(r); })
      // Silent, like the other cards on this page: a failed fetch should cost
      // the card rather than the page.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  // Off is off. A card describing a reward nobody will be paid is worse than
  // no card — same rule as the referral programme.
  return data?.enabled ? data : null;
}

export function RedditRewardCard({
  data, onClaimed,
}: {
  data: RedditRewardStatus;
  onClaimed?: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.claimRedditReward(url.trim());
      pushToast({ kind: "success", text: `${t("Thanks! On its way:")} ${res.summary}` });
      setUrl("");
      onClaimed?.();
    } catch (e) {
      // The server's `reason` is written for a human and distinguishes the two
      // refusals that matter — "you already claimed" and "that post was
      // already claimed" are different situations and the second one has an
      // innocent explanation. Showing it verbatim beats inventing a summary.
      setErr((e as Error).message || t("Couldn't claim that."));
    } finally {
      setBusy(false);
    }
  };

  if (data.claimed) {
    return (
      <article className="promo-card reddit-card">
        <div className="promo-card-body">
          <h3 className="promo-title">{t("Posted on Reddit")}</h3>
          <p className="promo-blurb">{t("Thanks for spreading the word — this one is collected.")}</p>
          {data.url && (
            <a className="reddit-link" href={data.url} target="_blank" rel="noreferrer noopener">
              {data.url}
            </a>
          )}
        </div>
      </article>
    );
  }

  return (
    <article className="promo-card reddit-card">
      <div className="promo-card-body">
        <h3 className="promo-title">{t("Post about us on Reddit")}</h3>
        <p className="promo-blurb">
          {t("Write a post about the game anywhere on Reddit, then paste the link here.")}
        </p>

        {data.prizes.length > 0 && (
          <div className="reddit-prize">
            <PrizeChips prizes={data.prizes} size="sm" />
          </div>
        )}

        <div className="reddit-form">
          <input
            className="reddit-input"
            type="url"
            inputMode="url"
            placeholder="https://reddit.com/r/…"
            value={url}
            disabled={busy}
            onChange={(e) => { setUrl(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            aria-label={t("Link to your Reddit post")}
          />
          <button
            type="button"
            className="btn btn-primary reddit-submit"
            disabled={busy || !url.trim()}
            onClick={() => void submit()}
          >
            {busy ? t("Sending…") : t("Claim")}
          </button>
        </div>

        {err && <p className="reddit-err">{err}</p>}
        {/* Said before they post, not after they try to claim twice. */}
        <p className="promo-note">{t("One reward per account.")}</p>
      </div>
    </article>
  );
}
