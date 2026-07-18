import { useState } from "react";
import { useGame } from "../state/GameContext";
import { gymLeaders } from "../data/gymLeaders";
import { TrainerCardModal } from "./TrainerCardModal";
import { useAuth } from "../auth/AuthContext";
import { IconStar, IconCoin, IconMedal, IconTicket, IconCrown } from "./Icon";
import { CountUp } from "../utils/animate";
import { useT } from "../i18n/useT";

// Bottom-right profile strip — clickable, opens the Trainer Card.
// Shows account level (cloud-derived), money, badges, plus optional
// victory tokens / champion crown. Save status lives in the chat
// column's ChannelHeader now (Twitch-stream layout), so this strip
// is just the 64px profile footer.
export function InventoryRibbon() {
  const { state } = useGame();
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <>
      <button
        type="button"
        className="profile-strip"
        aria-label={t("Open trainer card")}
        title={t("Open trainer card")}
        onClick={() => setOpen(true)}
      >
        {me && (
          <>
            <span className="profile-stat profile-stat-level">
              <IconStar size={13} className="profile-stat-icon" />
              <strong>{t("Lv ")}{me.accountLevel}</strong>
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
