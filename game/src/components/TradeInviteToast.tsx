import { useEffect, useState } from "react";
import { useTradeState, respondToInvite } from "../state/trade";
import { useT } from "../i18n/useT";

// Toast that floats in the top-right when another player invites you to
// trade. Auto-dismisses on the server-side 60s expiry; the client also
// shows a live countdown so the user can decide before time runs out.
export function TradeInviteToast() {
  const { invite, cancelMessage } = useTradeState();
  const [now, setNow] = useState(Date.now());
  const t = useT();
  useEffect(() => {
    if (!invite) return;
    const intervalId = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(intervalId);
  }, [invite]);

  if (cancelMessage) {
    return (
      <div className="trade-toast trade-toast-cancel" role="status">
        <strong>{t("Trade cancelled")}</strong>
        <small>{cancelMessage}</small>
      </div>
    );
  }
  if (!invite) return null;

  const secondsLeft = Math.max(0, Math.ceil((invite.expiresAt - now) / 1000));

  return (
    <div className="trade-toast" role="alert" aria-live="polite">
      <div className="trade-toast-head">
        <strong>{t("Trade request")}</strong>
        <span className="dim small trade-toast-timer">{secondsLeft}s</span>
      </div>
      <div className="trade-toast-body">
        <strong>{invite.from.username}</strong>{t(" wants to trade with you.")}
      </div>
      <div className="trade-toast-actions">
        <button
          className="g-btn-ghost g-btn-small"
          onClick={() => respondToInvite(invite.tradeId, false)}
        >
          {t("Decline")}
        </button>
        <button
          className="g-btn-primary g-btn-small"
          onClick={() => respondToInvite(invite.tradeId, true)}
        >
          {t("Accept")}
        </button>
      </div>
    </div>
  );
}
