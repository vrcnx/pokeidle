import { useAuctionNotifications, dismissAuctionNotification } from "../state/auctions";
import { useT } from "../i18n/useT";

const ICON: Record<string, string> = {
  outbid: "⚠️",
  won: "🏆",
  sold: "💰",
  cancelled: "✖️",
  expired: "⌛",
};

// Stack of transient toasts for auction events that aren't already
// covered by the settlement's own reducer log line — outbid warnings,
// won/sold confirmations, and cancel/expiry notices. Each entry
// auto-dismisses itself (see state/auctions.ts's pushAuctionNotification).
export function AuctionNotifyToast() {
  const notifications = useAuctionNotifications();
  const t = useT();
  if (notifications.length === 0) return null;
  return (
    <div className="auction-toast-stack" aria-live="polite">
      {notifications.map((n) => (
        <div key={n.id} className={`auction-toast auction-toast-${n.kind}`} role="status">
          <span className="auction-toast-icon">{ICON[n.kind] ?? "🔔"}</span>
          <span className="auction-toast-text">{n.text}</span>
          <button
            type="button"
            className="auction-toast-close"
            aria-label={t("Dismiss")}
            onClick={() => dismissAuctionNotification(n.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
