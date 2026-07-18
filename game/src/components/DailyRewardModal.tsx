import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { useDailyStatus, setDailyStatus, bindDailies } from "../state/dailies";
import { api } from "../net/api";
import { pushToast } from "./Toast";
import { useT } from "../i18n/useT";

// Daily reward. Auto-opens once on login when a claim is available (wired via
// bindDailies), and can be reopened from Settings. The server owns the streak
// and the once-a-day gate; claiming here just applies the returned reward to
// the save.

function countdown(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

export function DailyRewardModal() {
  const { dispatch } = useGame();
  const status = useDailyStatus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const t = useT();

  useEffect(() => {
    bindDailies(() => setOpen(true));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !status) return null;

  const claim = async () => {
    setBusy(true);
    try {
      const res = await api.claimDaily();
      dispatch({ type: "APPLY_DAILY_REWARD", payload: { money: res.reward.money, items: res.reward.items } });
      setDailyStatus(res.status);
      pushToast({ kind: "success", text: `Daily reward claimed: ${res.reward.label}`, icon: "🎁" });
    } catch (e: any) {
      // 409 = already claimed (e.g. claimed on another device). Refresh so
      // the UI reflects reality instead of offering a claim that will fail.
      if (e?.status === 409 && e?.body?.status) setDailyStatus(e.body.status);
      else pushToast({ kind: "warn", text: t("Couldn't claim right now — try again in a moment.") });
    } finally {
      setBusy(false);
    }
  };

  const dayOfCycle = ((status.streakIfClaimed - 1) % 7) + 1;

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="g-modal daily-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("Daily reward")}>
        <header className="daily-head">
          <span className="daily-eyebrow">{t("Daily reward")}</span>
          <h2>{status.claimedToday ? t("See you tomorrow") : t("Welcome back")}</h2>
          {status.streak > 0 && (
            <p className="daily-streak" title={t("Consecutive days claimed")}>
              🔥 {status.claimedToday ? status.streak : status.streakIfClaimed}-day streak
              {status.longestStreak > status.streak && <span className="dim small"> · best {status.longestStreak}</span>}
            </p>
          )}
        </header>

        <div className="daily-week">
          {Array.from({ length: 7 }, (_, i) => {
            const day = i + 1;
            const isToday = !status.claimedToday && day === dayOfCycle;
            const isPast = status.claimedToday
              ? day <= (((status.streak - 1) % 7) + 1)
              : day < dayOfCycle;
            return (
              <div key={day} className={`daily-day${isToday ? " is-today" : ""}${isPast ? " is-past" : ""}`}>
                <span className="daily-day-n">Day {day}</span>
                <span className="daily-day-mark">{isPast ? "✓" : day === 7 ? "★" : "•"}</span>
              </div>
            );
          })}
        </div>

        <div className="daily-reward-box">
          <span className="dim small">{status.claimedToday ? t("Claimed today") : `Day ${dayOfCycle} reward`}</span>
          <strong className="daily-reward-label">{status.todayReward.label}</strong>
        </div>

        <footer className="daily-foot">
          {status.claimedToday
            ? (
              <button className="g-btn-ghost" disabled>
                Next reward in {countdown(status.nextClaimInMs)}
              </button>
            )
            : (
              <button className="g-btn-primary daily-claim" onClick={claim} disabled={busy}>
                {busy ? t("Claiming…") : t("Claim reward")}
              </button>
            )}
        </footer>
      </div>
    </div>
  );
}
