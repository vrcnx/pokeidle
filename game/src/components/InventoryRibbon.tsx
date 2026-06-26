import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { gymLeaders } from "../data/gymLeaders";
import { TrainerCardModal } from "./TrainerCardModal";
import { useAuth } from "../auth/AuthContext";
import { IconStar, IconCoin, IconMedal, IconTicket, IconCrown } from "./Icon";
import { CountUp } from "../utils/animate";

// Bottom-right profile strip — clickable, opens the Trainer Card.
// Shows account level (cloud-derived), money, badges, plus optional
// victory tokens / champion crown. Above it sits a thin save-status
// indicator (Saving… / Saved · 12s ago / Offline) so the player has
// constant visibility into whether their progress is persisted.
export function InventoryRibbon() {
  const { state, saveStatus, lastSavedAt } = useGame();
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <>
      <SaveStatusBadge status={saveStatus} lastSavedAt={lastSavedAt} />
      <button
        type="button"
        className="profile-strip"
        aria-label="Open trainer card"
        title="Open trainer card"
        onClick={() => setOpen(true)}
      >
        {me && (
          <>
            <span className="profile-stat profile-stat-level">
              <IconStar size={13} className="profile-stat-icon" />
              <strong>Lv {me.accountLevel}</strong>
            </span>
            <span className="profile-stat-divider" />
          </>
        )}
        <span className="profile-stat">
          <IconCoin size={13} className="profile-stat-icon" />
          <strong>$<CountUp value={state.money} /></strong>
        </span>
        <span className="profile-stat-divider" />
        <span className="profile-stat">
          <IconMedal size={13} className="profile-stat-icon" />
          <strong>{state.defeatedGyms.length}/{gymLeaders.length}</strong>
        </span>
        {state.victoryTokens > 0 && (
          <>
            <span className="profile-stat-divider" />
            <span className="profile-stat">
              <IconTicket size={13} className="profile-stat-icon" />
              <strong>{state.victoryTokens}</strong>
            </span>
          </>
        )}
        {state.championDefeated && (
          <>
            <span className="profile-stat-divider" />
            <span className="profile-stat">
              <IconCrown size={13} className="profile-stat-icon" />
            </span>
          </>
        )}
      </button>
      {open && <TrainerCardModal onClose={() => setOpen(false)} />}
    </>
  );
}

// Tiny strip showing cloud-save progress. Re-renders every 10s while
// "saved" so the relative-time label stays fresh; suppresses itself
// in the "idle" state (no save has been needed yet this session) to
// avoid drawing the player's eye to a no-op indicator.
function SaveStatusBadge({
  status,
  lastSavedAt,
}: {
  status: import("../state/GameContext").SaveStatus;
  lastSavedAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "saved") return;
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [status]);

  if (status === "idle") return null;

  let label: string;
  let kind: string;
  if (status === "pending") { label = "Unsaved changes";    kind = "pending"; }
  else if (status === "saving")  { label = "Saving…";             kind = "saving"; }
  else if (status === "error")   { label = "Couldn't save — offline?"; kind = "error"; }
  else {
    // saved
    const ago = lastSavedAt ? Math.max(0, Math.round((now - lastSavedAt) / 1000)) : 0;
    label = ago < 5 ? "Saved" : ago < 60 ? `Saved · ${ago}s ago` : `Saved · ${Math.round(ago / 60)}m ago`;
    kind = "saved";
  }

  return (
    <div className={`save-status-badge save-status-${kind}`} role="status" aria-live="polite">
      <span className="save-status-dot" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
