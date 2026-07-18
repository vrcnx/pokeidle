import { useEffect, useMemo, useState } from "react";
import { useGame } from "../state/GameContext";
import { useModalEnter } from "../utils/animate";
import { useT } from "../i18n/useT";
import { computeUnlocked } from "../state/achievements";
import {
  ACHIEVEMENTS, ACHIEVEMENTS_BY_CATEGORY, CATEGORY_LABEL, TIER_COLOR,
  tierOrder,
  type Achievement, type AchievementCategory, type AchievementExtras,
} from "../data/achievements";
import { api } from "../net/api";

// Module-scoped open/close so any code path can pop the gallery.
let _open = false;
const _listeners = new Set<(o: boolean) => void>();
export function openAchievements() {
  _open = true;
  for (const l of _listeners) l(true);
}
export function closeAchievements() {
  _open = false;
  for (const l of _listeners) l(false);
}
function useOpen(): boolean {
  const [o, setO] = useState(_open);
  useEffect(() => {
    _listeners.add(setO);
    return () => { _listeners.delete(setO); };
  }, []);
  return o;
}

type CategoryFilter = "all" | AchievementCategory;

export function AchievementsModal() {
  const isOpen = useOpen();
  const dialogRef = useModalEnter(".achievement-card");
  const { state } = useGame();
  const t = useT();
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [showLocked, setShowLocked] = useState(true);
  const [extras, setExtras] = useState<AchievementExtras>({});

  // Pull PvP + trade snapshots so the gallery shows real progress on
  // those achievements instead of "0".
  useEffect(() => {
    if (!isOpen) return;
    Promise.allSettled([api.myRating(), api.myPvpHistory(50), api.myTradeHistory()])
      .then(([r, h, t]) => {
        const next: AchievementExtras = {};
        if (r.status === "fulfilled" && !r.value.unranked) {
          next.pvpRating = r.value.rating;
          next.pvpWins   = r.value.wins;
          next.pvpLosses = r.value.losses;
        }
        if (h.status === "fulfilled") {
          next.pvpWins   = h.value.matches.filter((m) => m.result === "win").length;
          next.pvpLosses = h.value.matches.filter((m) => m.result === "loss").length;
        }
        if (t.status === "fulfilled") {
          next.tradeCount = t.value.trades.length;
        }
        setExtras(next);
      });
  }, [isOpen]);

  // Press Escape to close.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeAchievements(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  const unlockedIds = useMemo(() => new Set(computeUnlocked(state, extras)), [state, extras]);
  const totalCount = ACHIEVEMENTS.length;
  const unlockedCount = unlockedIds.size;
  const completion = totalCount > 0 ? (unlockedCount / totalCount) * 100 : 0;

  const categories: CategoryFilter[] = ["all", ...Object.keys(ACHIEVEMENTS_BY_CATEGORY) as AchievementCategory[]];

  const list = useMemo(() => {
    const all = filter === "all" ? ACHIEVEMENTS : (ACHIEVEMENTS_BY_CATEGORY[filter] ?? []);
    return all
      .filter((a) => showLocked || unlockedIds.has(a.id))
      .slice()
      .sort((a, b) => {
        // Unlocked items rise to the top, then tier descending.
        const ua = unlockedIds.has(a.id) ? 0 : 1;
        const ub = unlockedIds.has(b.id) ? 0 : 1;
        if (ua !== ub) return ua - ub;
        return tierOrder(b.tier) - tierOrder(a.tier);
      });
  }, [filter, showLocked, unlockedIds]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={closeAchievements}>
      <div
        ref={dialogRef}
        className="g-modal achievements-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("Achievements")}
      >
        <header className="achievements-head">
          <div>
            <span className="achievements-eyebrow">{t("TROPHY GALLERY")}</span>
            <h2>{t("Achievements")}</h2>
          </div>
          <div className="achievements-summary">
            <div className="achievements-ring">
              <svg viewBox="0 0 36 36" className="achievements-ring-svg" aria-hidden>
                <path
                  className="achievements-ring-track"
                  d="M18 2.5 a 15.5 15.5 0 1 1 0 31 a 15.5 15.5 0 1 1 0 -31"
                />
                <path
                  className="achievements-ring-fill"
                  d="M18 2.5 a 15.5 15.5 0 1 1 0 31 a 15.5 15.5 0 1 1 0 -31"
                  style={{ strokeDasharray: `${completion}, 100` }}
                />
              </svg>
              <span className="achievements-ring-text">{Math.round(completion)}%</span>
            </div>
            <div className="achievements-count">
              <strong className="tabular">{unlockedCount}</strong>
              <span className="dim small">{t("of")} {totalCount} {t("unlocked")}</span>
            </div>
          </div>
          <button className="g-modal-close" onClick={closeAchievements} aria-label={t("Close")}>×</button>
        </header>

        <nav className="achievements-categories" role="tablist">
          {categories.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={filter === c}
              className={`achievements-category ${filter === c ? "active" : ""}`}
              onClick={() => setFilter(c)}
            >
              {c === "all" ? t("All") : CATEGORY_LABEL[c]}
            </button>
          ))}
          <label className="achievements-toggle" title={t("Show locked achievements")}>
            <input
              type="checkbox"
              checked={showLocked}
              onChange={(e) => setShowLocked(e.target.checked)}
            />
            {t("Show locked")}
          </label>
        </nav>

        <div className="achievements-grid">
          {list.map((a) => (
            <AchievementCard
              key={a.id}
              achievement={a}
              unlocked={unlockedIds.has(a.id)}
              progress={a.progress?.(state, extras)}
            />
          ))}
          {list.length === 0 && (
            <p className="dim small" style={{ gridColumn: "1 / -1", textAlign: "center", padding: 24 }}>
              {t("Nothing here yet — flip \"Show locked\" on to see what's available.")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AchievementCard({
  achievement, unlocked, progress,
}: {
  achievement: Achievement;
  unlocked: boolean;
  progress?: [number, number];
}) {
  const tierColor = TIER_COLOR[achievement.tier];
  const pct = progress ? Math.min(100, (progress[0] / Math.max(1, progress[1])) * 100) : 0;
  return (
    <article
      className={`achievement-card tier-${achievement.tier} ${unlocked ? "unlocked" : "locked"}`}
      style={{ "--tier-color": tierColor } as React.CSSProperties}
    >
      <div className="achievement-card-icon">{achievement.icon}</div>
      <div className="achievement-card-body">
        <strong className="achievement-card-name">{achievement.name}</strong>
        <p className="achievement-card-desc">{achievement.description}</p>
        {!unlocked && progress && (
          <div className="achievement-card-progress">
            <div className="achievement-card-bar">
              <div className="achievement-card-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="dim small tabular">{progress[0].toLocaleString()} / {progress[1].toLocaleString()}</span>
          </div>
        )}
      </div>
      <span className="achievement-card-tier">{achievement.tier.toUpperCase()}</span>
      {unlocked && <span className="achievement-card-check">✓</span>}
    </article>
  );
}
