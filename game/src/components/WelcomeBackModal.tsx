import { useEffect, useRef, useState } from "react";
import { openHub, closeHub } from "./HubModal";
import { useGame } from "../state/GameContext";
import { api } from "../net/api";
import { setDailyStatus } from "../state/dailies";
import {
  closeWelcomeBack,
  updateWelcomeDaily,
  useWelcomeBack,
  type WelcomeBackData,
} from "../state/welcomeBack";
import { openChangelog } from "./ChangelogModal";
import { openGiveaways } from "./GiveawayModal";
import { CURRENT_VERSION } from "../data/changelog";
import { useT } from "../i18n/useT";
import { pushToast } from "./Toast";
import { useModalEnter } from "../utils/animate";
import { useAnnouncement } from "../state/announcement";
import { useGiveaways } from "../utils/giveawayStore";
import type { Announcement, PublicGiveaway } from "../net/api";

/**
 * One dialog for everything that happened while the player was gone.
 *
 * ── WHY ONE ────────────────────────────────────────────────────────
 * Four surfaces used to compete for the same moment: the daily reward, the
 * away stipend, the release notes and a gift toast. Stacked, in DOM order, at
 * the same z-index. Coming back after an update to an unclaimed daily meant
 * three overlays to dismiss before touching the game — which turns a set of
 * rewards into a set of chores.
 *
 * The sections here are the same information, ordered by what the player
 * actually wants to know, with ONE way out.
 *
 * ── THE ORDER IS DELIBERATE ────────────────────────────────────────
 *   1. What you were given while gone (stipend, gifts) — already banked,
 *      needs no decision, and is the reason to be pleased about coming back.
 *   2. The streak — the only thing here with an action attached, so it sits
 *      next to the button that performs it.
 *   3. What changed — real, but nobody has ever come back to a game FOR the
 *      patch notes. Summarised, with the full text a click away.
 *
 * ── ONE BUTTON ─────────────────────────────────────────────────────
 * The footer claims the daily and closes. Two separate actions ("Claim" then
 * "Close") is the stacked-modal problem in miniature: it makes the player
 * confirm twice that they would like their reward.
 */

const ANNOUNCE_ICON: Record<string, string> = {
  info: "📣", event: "✨", giveaway: "🎁", warning: "⚠️", maintenance: "🔧",
};

/** "8h 12m", "42m" — compact enough for a sentence. */
function humanDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/**
 * Connected half: stores, the game reducer, the network.
 *
 * Split from the dialog itself so the presentation can be mounted with mock
 * data by the preview harness (src/welcome-preview.tsx) — reaching this
 * screen for real needs a signed-in session, a save, an away period and an
 * unclaimed daily, which is not a loop anyone can iterate a layout in. The
 * REAL component is previewed; only the wiring is replaced.
 */
/**
 * Takes a returning player to the Rewards page instead of interrupting them.
 *
 * This was a popup. It arrived over the game, unasked, in front of whatever
 * the player had come back to do — and everything in it (a daily to claim,
 * a giveaway win, gifts waiting) is Rewards' subject already. A modal that
 * duplicates a page is a page that opens itself.
 *
 * Renders nothing. It only decides where you land; RewardsBody draws it.
 */
export function WelcomeBackRouter() {
  const { open } = useWelcomeBack();
  // Once per arrival. `open` stays true until the player deals with it, so
  // reacting to the value rather than the EDGE would reopen the hub every
  // time they closed it to go and play.
  const sent = useRef(false);
  useEffect(() => {
    if (!open) { sent.current = false; return; }
    if (sent.current) return;
    sent.current = true;
    openHub("rewards");
  }, [open]);
  return null;
}

export function WelcomeBackModal({ inline = false }: { inline?: boolean } = {}) {
  const { open, data } = useWelcomeBack();
  const { dispatch } = useGame();
  // Read live rather than collected: an announcement never JUSTIFIES opening
  // this dialog (it has its own banner), it is context to include once the
  // dialog is opening for another reason. Putting it in the collector would
  // have made "an admin pinned a notice" enough to interrupt everyone.
  const announcement = useAnnouncement();
  // Same reasoning: a live giveaway does not justify interrupting anyone, but
  // "you won" and "there is one open you have not entered" are the two most
  // useful things a returning player can be told, and both are already in a
  // store the game keeps warm.
  const { giveaways } = useGiveaways();
  const [busy, setBusy] = useState(false);
  const t = useT();
  // Guards the claim against a double-fire from Enter plus a click.
  const claiming = useRef(false);

  if (!open) return null;

  const canClaim = !!data.daily && !data.daily.claimedToday;

  /**
   * Dismiss the welcome AND leave the hub.
   *
   * ── THE BUTTON SAYS "LET'S PLAY" ──────────────────────────────────────
   * WelcomeBackRouter opens the hub on Rewards so this can render at the top
   * of it. Closing only the welcome therefore left the player standing in a
   * shop — the one screen the button promised to take them away from. The
   * hub was opened to show this; dismissing this should close it again.
   *
   * Only on the primary action. The rail, the × and the backdrop are the
   * player navigating the hub on purpose and must not be hijacked.
   */
  const leave = () => {
    closeWelcomeBack();
    closeHub();
  };

  const finish = async () => {
    if (claiming.current) { leave(); return; }
    if (!canClaim) { leave(); return; }
    claiming.current = true;
    setBusy(true);
    try {
      const res = await api.claimDaily();
      dispatch({ type: "APPLY_DAILY_REWARD", payload: { money: res.reward.money, items: res.reward.items } });
      setDailyStatus(res.status);
      updateWelcomeDaily(res.status);
      pushToast({ kind: "success", icon: "🎁", text: `${res.reward.label} claimed` });
      // "Claim & play" is the same promise as "Let's play", so it exits too.
      leave();
    } catch (e: any) {
      // 409 = already claimed, typically on another device. Correct the UI
      // rather than leaving a button that will keep failing, and do not close
      // — the player should see why nothing happened.
      if (e?.status === 409 && e?.body?.status) {
        setDailyStatus(e.body.status);
        updateWelcomeDaily(e.body.status);
        pushToast({ kind: "warn", text: t("Already claimed today — on another device, perhaps.") });
      } else {
        pushToast({ kind: "warn", text: t("Couldn't claim right now — try again in a moment.") });
      }
      claiming.current = false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <WelcomeBackDialog
      inline={inline}
      data={data}
      announcement={announcement}
      giveaways={giveaways}
      busy={busy}
      onFinish={finish}
      onClose={closeWelcomeBack}
      onOpenChangelog={() => { closeWelcomeBack(); openChangelog(); }}
      onOpenGiveaway={(id) => { closeWelcomeBack(); openGiveaways(id); }}
    />
  );
}

/** Presentation. No stores, no network — everything it shows is a prop. */
export function WelcomeBackDialog({
  data, announcement, giveaways, busy, onFinish, onClose, onOpenChangelog, onOpenGiveaway,
  inline = false,
}: {
  inline?: boolean;
  data: WelcomeBackData;
  announcement: Announcement | null;
  giveaways: PublicGiveaway[] | null;
  busy: boolean;
  onFinish: () => void;
  onClose: () => void;
  onOpenChangelog: () => void;
  onOpenGiveaway: (id: string) => void;
}) {
  const t = useT();
  const ref = useModalEnter(".wb-stagger");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { away, daily, news, gifts, returning } = data;
  const canClaim = !!daily && !daily.claimedToday;
  const closeWelcomeBack = onClose;
  const finish = onFinish;

  const dayOfCycle = daily ? ((daily.streakIfClaimed - 1) % 7) + 1 : 1;
  const shownStreak = daily ? (daily.claimedToday ? daily.streak : daily.streakIfClaimed) : 0;

  // ── What goes in the second column ────────────────────────────────
  // Ordered by how much it matters to someone who just walked back in. A win
  // they have not collected beats an open draw, which beats server news,
  // which beats release notes — nobody has ever come back to a game for the
  // patch notes.
  const won = (giveaways ?? []).filter((g) => g.youWon);
  const enterable = (giveaways ?? []).filter((g) => g.status === "open" && !g.hasEntered && !g.youWon);
  // Two columns require TWO columns of content. Widening for a full right
  // column and an empty left one is the same failure as the reverse — and it
  // is reachable: someone who returns to nothing but release notes has an
  // empty rewards column. When only one side has anything, it runs down the
  // middle of the narrow card instead.
  const hasMain = !!away || gifts.length > 0 || !!daily;
  const asideContent = won.length > 0 || enterable.length > 0 || !!announcement || news.length > 0;
  const twoUp = hasMain && asideContent;

  return (
    // Inline: no overlay and no backdrop. It is a card at the top of the
    // Rewards pane, inside a dialog that already has both — a second scrim
    // over the first would dim the hub twice, and there is nothing behind
    // this to dismiss by clicking anyway.
    <div
      className={inline ? "wb-inline" : "modal-overlay wb-overlay"}
      onClick={inline ? undefined : () => closeWelcomeBack()}
    >
      <div
        className={`g-modal wb-modal${twoUp ? " has-aside" : ""}`}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("Welcome back")}
      >
        <header className="wb-head wb-stagger">
          <span className="wb-eyebrow">
            {away
              ? `${t("Away for")} ${humanDuration(away.elapsedMs)}`
              : t("Good to see you")}
          </span>
          {/* "Welcome back" to someone who has never been here is a small lie
              they notice. The greeting follows the evidence. */}
          <h2>{returning ? t("Welcome back") : t("Welcome")}</h2>
        </header>

        <div className="wb-body">
         {/* Omitted entirely when empty, so a single-column dialog carrying
             only aside content does not leave a phantom grid cell above it. */}
         {hasMain && (
         <div className="wb-main">
          {/* ── 1. Banked while gone ───────────────────────────── */}
          {(away || gifts.length > 0) && (
            <section className="wb-section wb-stagger">
              <h3 className="wb-section-title">{t("While you were gone")}</h3>
              <div className="wb-rewards">
                {away && (
                  <div className="wb-reward">
                    <span className="wb-reward-icon" aria-hidden>🌙</span>
                    <span className="wb-reward-text">
                      <strong>${away.money.toLocaleString()}</strong>
                      <span className="wb-reward-sub">
                        {t("idle earnings")}
                        {away.capped && <> · {t("capped at")} {Math.round(away.capMs / 3_600_000)}h</>}
                      </span>
                    </span>
                  </div>
                )}
                {gifts.map((g, i) => (
                  <div className="wb-reward" key={i}>
                    <span className="wb-reward-icon" aria-hidden>🎁</span>
                    <span className="wb-reward-text">
                      <strong>{g}</strong>
                      <span className="wb-reward-sub">{t("gift")}</span>
                    </span>
                  </div>
                ))}
              </div>
              {away && (
                // Said out loud because a capped stipend deliberately far
                // below active income reads as stingy unless the trade-off is
                // explained — and a player who thinks idling competes will
                // idle, then feel cheated.
                <p className="wb-note">
                  {t("Idle time pays a small stipend only — no battles, EXP or catches happen while the game is closed. It grows with each Gym Badge.")}
                </p>
              )}
            </section>
          )}

          {/* ── 2. Streak ──────────────────────────────────────── */}
          {daily && (
            <section className="wb-section wb-stagger">
              <div className="wb-section-head">
                <h3 className="wb-section-title">{t("Daily reward")}</h3>
                {shownStreak > 0 && (
                  <span className="wb-streak" title={t("Consecutive days claimed")}>
                    🔥 {shownStreak}
                    {daily.longestStreak > shownStreak && (
                      <span className="wb-streak-best"> / {daily.longestStreak}</span>
                    )}
                  </span>
                )}
              </div>

              <div className="wb-week" role="img"
                   aria-label={`${t("Day")} ${dayOfCycle} ${t("of a 7-day cycle")}`}>
                {Array.from({ length: 7 }, (_, i) => {
                  const day = i + 1;
                  const isToday = !daily.claimedToday && day === dayOfCycle;
                  const isPast = daily.claimedToday
                    ? day <= (((daily.streak - 1) % 7) + 1)
                    : day < dayOfCycle;
                  return (
                    <span key={day}
                          className={`wb-day${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}${day === 7 ? " is-bonus" : ""}`}>
                      {isPast ? "✓" : day}
                    </span>
                  );
                })}
              </div>

              <div className="wb-daily-prize">
                <span className="wb-reward-icon" aria-hidden>{daily.claimedToday ? "✓" : "🎁"}</span>
                <span className="wb-reward-text">
                  <strong>{daily.todayReward.label}</strong>
                  <span className="wb-reward-sub">
                    {daily.claimedToday
                      ? `${t("claimed — next in")} ${humanDuration(daily.nextClaimInMs)}`
                      : `${t("day")} ${dayOfCycle} ${t("reward")}`}
                  </span>
                </span>
              </div>
            </section>
          )}

         </div>
         )}

         {/* ── Second column: what is happening NOW ─────────────────
             The left column is a receipt for time already passed. This one
             is the reason to stay: a prize waiting to be collected, a draw
             still open, what the server is telling everyone. Release notes
             sit at the bottom because that is where they rank. */}
         {asideContent && (
          <aside className="wb-aside wb-stagger">
            <h3 className="wb-section-title">{t("Happening now")}</h3>

            {won.map((g) => (
              <button className="wb-card wb-card--win" key={g.id} onClick={() => onOpenGiveaway(g.id)}>
                <span className="wb-card-icon" aria-hidden>🏆</span>
                <span className="wb-card-text">
                  <strong>{t("You won!")}</strong>
                  <span className="wb-card-sub">{g.title} · {g.prizeSummary}</span>
                </span>
              </button>
            ))}

            {enterable.slice(0, 2).map((g) => (
              <button className="wb-card wb-card--action" key={g.id} onClick={() => onOpenGiveaway(g.id)}>
                <span className="wb-card-icon" aria-hidden>🎟️</span>
                <span className="wb-card-text">
                  <strong>{g.title}</strong>
                  <span className="wb-card-sub">
                    {g.prizeSummary} · {g.entryCount.toLocaleString()} {t("entered")}
                  </span>
                </span>
                <span className="wb-card-cta">{t("Enter")}</span>
              </button>
            ))}

            {announcement && (
              <div className={`wb-card wb-card--note wb-note-${announcement.type}`}>
                <span className="wb-card-icon" aria-hidden>{ANNOUNCE_ICON[announcement.type] ?? "📣"}</span>
                <span className="wb-card-text">
                  <strong>{announcement.message}</strong>
                </span>
              </div>
            )}

            {news.length > 0 && (
              <div className="wb-news-block">
                <div className="wb-section-head">
                  <h4 className="wb-news-title">{t("What's new")}</h4>
                  <span className="wb-version">v{CURRENT_VERSION}</span>
                </div>
                {/* A summary, not the notes. They should be reachable, not
                    unavoidable. */}
                <ul className="wb-news">
                  {news.slice(0, 2).flatMap((entry) =>
                    entry.sections.flatMap((sec) => sec.items),
                  ).slice(0, 3).map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
                <button className="wb-link" onClick={onOpenChangelog}>
                  {t("Read the full notes")}
                </button>
              </div>
            )}
          </aside>
         )}
        </div>

        <footer className="wb-foot">
          <button className="wb-cta" onClick={finish} disabled={busy}>
            {busy
              ? t("Claiming…")
              : canClaim
                ? <>{t("Claim & play")} <span className="wb-cta-arrow" aria-hidden>→</span></>
                : <>{t("Let's play")} <span className="wb-cta-arrow" aria-hidden>→</span></>}
          </button>
        </footer>
      </div>
    </div>
  );
}
