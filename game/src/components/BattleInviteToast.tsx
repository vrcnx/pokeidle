import { useEffect, useState } from "react";
import { usePvpState, respondToBattleInvite } from "../state/pvp";
import { useGame } from "../state/GameContext";

// Toast for incoming PvP battle invites. Mirrors the trade-invite
// toast — top-right float, auto-dismiss on the 60s server expiry,
// live countdown so the recipient can decide. Accepting sends the
// recipient's current party as their team; if their party is too
// small (<1 healthy mon) the accept button is disabled.
export function BattleInviteToast() {
  const { invite, cancelMessage } = usePvpState();
  const { state } = useGame();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!invite) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [invite]);

  if (cancelMessage) {
    return (
      <div className="trade-toast trade-toast-cancel battle-toast-cancel" role="status">
        <strong>Battle cancelled</strong>
        <small>{cancelMessage}</small>
      </div>
    );
  }
  if (!invite) return null;

  const secondsLeft = Math.max(0, Math.ceil((invite.expiresAt - now) / 1000));
  const team = state.party;
  const ready = team.length >= 1;

  return (
    <div className="trade-toast battle-toast" role="alert" aria-live="polite">
      <div className="trade-toast-head">
        <strong>Battle challenge</strong>
        <span className="dim small trade-toast-timer">{secondsLeft}s</span>
      </div>
      <div className="trade-toast-body">
        <strong>{invite.from.username}</strong> wants to battle.
      </div>
      <div className="trade-toast-actions">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => respondToBattleInvite(invite.battleId, false)}
        >
          Decline
        </button>
        <button
          className="g-btn-primary g-btn-small"
          disabled={!ready}
          title={ready ? undefined : "Your party is empty."}
          onClick={() => respondToBattleInvite(invite.battleId, true, team)}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
