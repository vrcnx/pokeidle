import { useEffect, useRef, useState } from "react";
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
import { CURRENT_VERSION } from "../data/changelog";
import { useT } from "../i18n/useT";
import { pushToast } from "./Toast";
import { useModalEnter } from "../utils/animate";

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
export function WelcomeBackModal() {
  const { open, data } = useWelcomeBack();
  const { dispatch } = useGame();
  const [busy, setBusy] = useState(false);
  const t = useT();
  // Guards the claim against a double-fire from Enter plus a click.
  const claiming = useRef(false);

  if (!open) return null;

  const canClaim = !!data.daily && !data.daily.claimedToday;

  const finish = async () => {
    if (claiming.current) { closeWelcomeBack(); return; }
    if (!canClaim) { closeWelcomeBack(); return; }
    claiming.current = true;
    setBusy(true);
    try {
      const res = await api.claimDaily();
      dispatch({ type: "APPLY_DAILY_REWARD", payload: { money: res.reward.money, items: res.reward.items } });
      setDailyStatus(res.status);
      updateWelcomeDaily(res.status);
      pushToast({ kind: "success", icon: "🎁", text: `${res.reward.label} claimed` });
      closeWelcomeBack();
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
      data={data}
      busy={busy}
      onFinish={finish}
      onClose={closeWelcomeBack}
      onOpenChangelog={() => { closeWelcomeBack(); openChangelog(); }}
    />
  );
}

/** Presentation. No stores, no network — everything it shows is a prop. */
export function WelcomeBackDialog({ data, busy, onFinish, onClose, onOpenChangelog }: {
  data: WelcomeBackData;
  busy: boolean;
  onFinish: () => void;
  onClose: () => void;
  onOpenChangelog: () => void;
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

  return (
    <div className="modal-overlay wb-overlay" onClick={() => closeWelcomeBack()}>
      <div
        className="g-modal wb-modal"
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

          {/* ── 3. What changed ────────────────────────────────── */}
          {news.length > 0 && (
            <section className="wb-section wb-stagger">
              <div className="wb-section-head">
                <h3 className="wb-section-title">{t("What's new")}</h3>
                <span className="wb-version">v{CURRENT_VERSION}</span>
              </div>
              {/* A summary, not the notes. Nobody comes back to a game for
                  the patch notes, but they should be able to reach them. */}
              <ul className="wb-news">
                {news.slice(0, 2).flatMap((entry) =>
                  entry.sections.flatMap((sec) => sec.items),
                ).slice(0, 4).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
              <button className="wb-link" onClick={onOpenChangelog}>
                {t("Read the full notes")}
              </button>
            </section>
          )}
        </div>

        <footer className="wb-foot">
          <button className="g-btn-primary wb-cta" onClick={finish} disabled={busy}>
            {busy
              ? t("Claiming…")
              : canClaim
                ? t("Claim & play")
                : t("Let's play")}
          </button>
        </footer>
      </div>
    </div>
  );
}
