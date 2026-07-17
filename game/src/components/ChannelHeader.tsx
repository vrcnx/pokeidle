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
  const { saveStatus } = useGame();
  const online = useOnlineCount();
  return (
    <div className="channel-header" role="banner" aria-label="Chat">
      <span className="channel-header-label">CHAT</span>
      <span className="channel-header-meta">
        <SaveStatusDot status={saveStatus} />
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
function SaveStatusDot({ status }: { status: SaveStatus }) {
  // WHEN SAVING WORKS, SAVING IS INVISIBLE.
  //
  // There is no "Saved", no "Saving…", no "12s ago". A status light exists
  // to apologise for a save system you do not trust, and narrating a
  // debounce gives the player an implementation detail they cannot act on.
  // Autosave is a guarantee; you do not put a light on a guarantee.
  //
  // What is left is only the cases where the game genuinely cannot keep the
  // player's progress and they deserve to know. Those are not decoration,
  // so they are not a dot — they say what broke and what to do.
  if (status === "rejected") {
    // Permanent: the server refuses this save and always will. Retrying is
    // pointless, and the player must not be told to check their wifi.
    return (
      <span className="channel-header-save save-status-error" role="alert" title="This game's servers rejected your save. Your progress is safe on this device, but it is not being backed up. Please report this.">
        <span className="channel-header-save-dot" aria-hidden />
        <span>Not backing up</span>
      </span>
    );
  }
  if (status === "conflict") {
    // Another device wrote. Progress is intact locally; the cloud copy is
    // simply not ours right now.
    return (
      <span className="channel-header-save save-status-error" role="alert" title="Your progress is open in another tab or on another device, which is the one saving to the cloud. Close the others and reload to sync this one.">
        <span className="channel-header-save-dot" aria-hidden />
        <span>Open elsewhere</span>
      </span>
    );
  }
  // "error" is transient (offline / 5xx). It retries on its own, and
  // localStorage is written unconditionally regardless, so there is nothing
  // for the player to do and nothing at risk. Say nothing.
  return null;
}
