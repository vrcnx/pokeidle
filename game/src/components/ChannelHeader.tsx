import { useEffect, useState } from "react";
import { useGame } from "../state/GameContext";
import { useOnlineCount } from "../state/presence";
import type { SaveStatus } from "../state/GameContext";

// 44px header row at the top of the chat column. Twitch-stream layout
// wants this band to match the height of the right-rail dock and the
// arena header so the three columns share a single top line.
//
// Left: "CHAT" uppercase label so the rail reads anatomy at a glance.
// Right: a green-dot Saved status + the live online count. Both are
// glanceable in idle play and disappear gracefully if data is missing.
export function ChannelHeader() {
  const { saveStatus, lastSavedAt } = useGame();
  const online = useOnlineCount();
  return (
    <div className="channel-header" role="banner" aria-label="Chat">
      <span className="channel-header-label">CHAT</span>
      <span className="channel-header-meta">
        <SaveStatusDot status={saveStatus} lastSavedAt={lastSavedAt} />
        {online > 0 && (
          <span className="channel-header-online" title={`${online} player${online === 1 ? "" : "s"} online`}>
            <span className="channel-header-online-dot" />
            <span className="tabular">{online}</span>
            <span className="dim small">online</span>
          </span>
        )}
      </span>
    </div>
  );
}

// Compact dot+text save status — sits inside the ChannelHeader rather
// than competing for vertical space with its own row. Mirrors the
// state machine used by the original SaveStatusBadge.
function SaveStatusDot({
  status,
  lastSavedAt,
}: {
  status: SaveStatus;
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
  // "pending" (debounce armed) and "saving" (request in flight) are an
  // implementation detail. To a player both mean "it's handling it", so
  // both read "Saving…". The old "Unsaved" label described the debounce
  // accurately and reassured nobody — it reads as "your progress is lost",
  // which is how players took it.
  if (status === "pending" || status === "saving") { label = "Saving…"; kind = "saving"; }
  else if (status === "error")  { label = "Offline"; kind = "error"; }
  else {
    const ago = lastSavedAt ? Math.max(0, Math.round((now - lastSavedAt) / 1000)) : 0;
    label = ago < 5 ? "Saved" : ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
    kind = "saved";
  }
  return (
    <span className={`channel-header-save save-status-${kind}`} role="status" aria-live="polite" title={`Save status: ${label}`}>
      <span className="channel-header-save-dot" aria-hidden />
      <span>{label}</span>
    </span>
  );
}
