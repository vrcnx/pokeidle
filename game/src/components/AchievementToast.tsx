import { useEffect, useState } from "react";
import { subscribeUnlock } from "../state/achievements";
import { TIER_COLOR, type Achievement } from "../data/achievements";
import { useT } from "../i18n/useT";

// Top-right slide-in toast that fires whenever a fresh achievement
// unlock is detected. Auto-dismisses after 5s. Up to 3 toasts can
// stack — earlier ones slide up as new ones arrive.

interface ToastItem {
  id: string;
  achievement: Achievement;
  bornAt: number;
}

const TOAST_TTL_MS = 5200;
const MAX_STACK = 3;

export function AchievementToast() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeUnlock((a) => {
      setItems((prev) => {
        const next = [
          ...prev.slice(-(MAX_STACK - 1)),
          { id: `${a.id}-${Date.now()}-${Math.random()}`, achievement: a, bornAt: Date.now() },
        ];
        return next;
      });
    });
  }, []);

  // Sweep expired items every 200ms.
  useEffect(() => {
    if (items.length === 0) return;
    const t = window.setInterval(() => {
      const now = Date.now();
      setItems((prev) => prev.filter((it) => now - it.bornAt < TOAST_TTL_MS));
    }, 250);
    return () => window.clearInterval(t);
  }, [items.length]);

  const t = useT();

  if (items.length === 0) return null;

  return (
    <div className="achievement-toast-stack" role="status" aria-live="polite">
      {items.map((it) => {
        const tierColor = TIER_COLOR[it.achievement.tier];
        return (
          <div
            key={it.id}
            className={`achievement-toast tier-${it.achievement.tier}`}
            style={{ "--tier-color": tierColor } as React.CSSProperties}
            onClick={() => setItems((prev) => prev.filter((i) => i.id !== it.id))}
            role="button"
            tabIndex={0}
          >
            <div className="achievement-toast-glow" />
            <div className="achievement-toast-icon">{it.achievement.icon}</div>
            <div className="achievement-toast-body">
              <span className="achievement-toast-eyebrow">{t("Achievement unlocked")}</span>
              <strong className="achievement-toast-name">{it.achievement.name}</strong>
              <span className="achievement-toast-desc">{it.achievement.description}</span>
            </div>
            <span className="achievement-toast-tier">{it.achievement.tier.toUpperCase()}</span>
          </div>
        );
      })}
    </div>
  );
}
