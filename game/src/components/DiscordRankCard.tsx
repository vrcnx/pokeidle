import { useEffect, useState } from "react";
import { api, type DiscordRankStatus } from "../net/api";
import { useT } from "../i18n/useT";
import { ProgressionTrack } from "./ProgressionTrack";

// "Discord rank" — the reward for being part of the community rather than for
// playing.
//
// ── WHY THE PRIZES ARE ALL POKÉ BALLS AND NEVER MONEY ───────────────
// Discord XP is earned by talking, and the server's own rule (see
// server/src/lib/discordXp.ts) is that it must not become anything the game
// economy can observe. Money would break that: it is fungible, and a farmed
// million devalues everybody else's. A consumable does not — it buys one
// catch attempt and is gone. That compromise is what lets this card exist at
// all, and it is why nothing here shows a currency figure.
//
// ── THE UNLINKED STATE IS THE POINT OF THE CARD ─────────────────────
// Most people looking at this have no Discord linked, so the version of this
// card that gets seen most is the one with no ladder in it. It is written as
// an invitation rather than as an empty state: showing a greyed-out track to
// somebody who cannot earn any of it advertises a locked door.

/**
 * The status, or null while loading / on failure.
 *
 * A hook like the other two on this page, because the PANE decides its own
 * "nothing free right now" copy and needs to know whether this card will
 * render.
 */
export function useDiscordRankStatus(): DiscordRankStatus | null {
  const [data, setData] = useState<DiscordRankStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.discordRankStatus()
      .then((r) => { if (!cancelled) setData(r); })
      // Silent: one card on a page of them, and a failed fetch should cost the
      // card rather than the page.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return data;
}

export function DiscordRankCard({ data, inviteUrl }: {
  data: DiscordRankStatus;
  inviteUrl?: string | null;
}) {
  const t = useT();

  if (!data.linked) {
    return (
      <article className="promo-card discord-rank-card">
        <div className="promo-card-body">
          <h3 className="promo-title">{t("Discord rank")}</h3>
          <p className="promo-blurb">
            {t("Talk in the Discord to earn ranks, and every few ranks pays out Poké Balls here. Link your account to start collecting.")}
          </p>
          <p className="promo-note">
            {/* The instruction, not just the door. Somebody who joins the
                server and is not told to run /link stops there, and the card
                has spent its one chance. */}
            {t("Join the server, then run")} <code>/link</code> {t("to connect your account.")}
          </p>
          {inviteUrl && (
            <a className="btn btn-primary discord-rank-join" href={inviteUrl} target="_blank" rel="noreferrer noopener">
              {t("Join the Discord")}
            </a>
          )}
        </div>
      </article>
    );
  }

  // Already paid out to somebody else's Discord account. There is nothing to
  // work toward, so no track is drawn — a ladder that cannot move is a worse
  // answer than a sentence saying why.
  if (data.claimedByAnother) {
    return (
      <article className="promo-card discord-rank-card">
        <div className="promo-card-body">
          <h3 className="promo-title">{t("Discord rank")}</h3>
          <p className="promo-blurb">
            {t("This account has already collected its Discord rank rewards through a different Discord account. They can only be claimed once.")}
          </p>
        </div>
      </article>
    );
  }

  const toGo = Math.max(0, data.nextRank - data.rank);
  // The window between crossing a rank and the payout landing. Small, but
  // saying so beats the two lies available: claiming it is collected, or
  // showing nothing while a player stares at a rank they can see they hold.
  const owed = data.reachedTier - data.paidTier;

  return (
    <article className="promo-card discord-rank-card">
      <div className="promo-card-body">
        <h3 className="promo-title">{t("Discord rank")}</h3>
        <p className="promo-blurb">
          {t("Every few ranks in the Discord pays out here. Keep talking and they keep coming.")}
        </p>

        <div className="progression-now">
          <span className="progression-level">
            <span className="dim">{t("Rank")}</span> <strong>{data.rank.toLocaleString()}</strong>
          </span>
          <span className="progression-next">
            {toGo > 0
              ? <>{toGo} {toGo === 1 ? t("rank to go") : t("ranks to go")}</>
              : t("Reward on its way")}
          </span>
        </div>

        {/* The same renderer the level ladder uses. Both servers emit the same
            stop shape precisely so this is one component and not two that
            drift. */}
        <ProgressionTrack data={data} />

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
