import { useEffect, useState } from "react";
import { usePvpState, respondToBattleInvite } from "../state/pvp";
import { useGame } from "../state/GameContext";
import { openTeamBuilder } from "./TeamBuilderModal";
import { useT } from "../i18n/useT";

// Toast for incoming PvP battle invites. Mirrors the trade-invite
// toast — top-right float, auto-dismiss on the 60s server expiry,
// live countdown so the recipient can decide. Accepting opens the
// team builder so the recipient picks their team (party + box)
// rather than auto-shipping their current party.
export function BattleInviteToast() {
  const { invite, cancelMessage } = usePvpState();
  const { state } = useGame();
  const [now, setNow] = useState(Date.now());
  const t = useT();
  useEffect(() => {
    if (!invite) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [invite]);

  if (cancelMessage) {
    return (
      <div className="trade-toast trade-toast-cancel battle-toast-cancel" role="status">
        <strong>{t("Battle cancelled")}</strong>
        <small>{cancelMessage}</small>
      </div>
    );
  }
  if (!invite) return null;

  const secondsLeft = Math.max(0, Math.ceil((invite.expiresAt - now) / 1000));
  const hasMons = state.party.length + state.box.length >= 1;
  const formatLabel =
    invite.format === "random50"  ? t("Random Lv 50")
    : invite.format === "tournament" ? t("Tournament")
    :                                  t("Custom");
  const levelCap = invite.format === "random50" ? 50 : undefined;

  const accept = () => {
    openTeamBuilder({
      mode: "accept",
      levelCap,
      onConfirm: (team) => {
        respondToBattleInvite(invite.battleId, true, team);
      },
      onCancel: () => {
        respondToBattleInvite(invite.battleId, false);
      },
    });
  };

  return (
    <div className="trade-toast battle-toast" role="alert" aria-live="polite">
      <div className="trade-toast-head">
        <strong>{t("Battle challenge")}</strong>
        <span className="dim small trade-toast-timer">{secondsLeft}s</span>
      </div>
      <div className="trade-toast-body">
        <strong>{invite.from.username}</strong>{t(" wants to battle.")}
        <div className="dim small">{formatLabel}</div>
      </div>
      <div className="trade-toast-actions">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => respondToBattleInvite(invite.battleId, false)}
        >
          {t("Decline")}
        </button>
        <button
          className="g-btn-primary g-btn-small"
          disabled={!hasMons}
          title={hasMons ? undefined : t("You need at least one Pokémon.")}
          onClick={accept}
        >
          {t("Accept")}
        </button>
      </div>
    </div>
  );
}
