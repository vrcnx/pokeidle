import { useEffect, useState } from "react";
import { usePvpState, leaveRandomQueue } from "../state/pvp";
import { useT } from "../i18n/useT";

// Floating status pill rendered while the player is waiting in the
// random matchmaking queue. Dismisses itself when the queue produces
// a match (battle:start clears state.queue) or when the player taps
// Leave. Sibling to BattleInviteToast — same top-right corner, same
// motion language so the area doesn't fight itself when both can
// possibly be visible.
export function RandomBattleQueueToast() {
  const { queue } = usePvpState();
  const [now, setNow] = useState(Date.now());
  const t = useT();

  useEffect(() => {
    if (!queue) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [queue]);

  if (!queue) return null;

  const elapsedSec = Math.max(0, Math.floor((now - queue.joinedAt) / 1000));
  const min = Math.floor(elapsedSec / 60);
  const sec = elapsedSec % 60;
  const elapsed = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

  return (
    <div className="trade-toast battle-queue-toast" role="status" aria-live="polite">
      <div className="trade-toast-head">
        <strong>{t("Searching for opponent…")}</strong>
        <span className="dim small">{elapsed}</span>
      </div>
      <div className="trade-toast-body">
        <span className="dim small">
          {queue.queueSize === 1
            ? t("You're alone in the queue. Waiting for a challenger.")
            : `Position ${queue.position} of ${queue.queueSize} waiting.`}
        </span>
        <div className="dim small">{t("All Pokémon are clamped to ")}<strong>{t("Lv 50")}</strong>.</div>
      </div>
      <div className="trade-toast-actions">
        <button className="g-btn-ghost g-btn-small" onClick={() => leaveRandomQueue()}>
          {t("Leave queue")}
        </button>
      </div>
    </div>
  );
}
