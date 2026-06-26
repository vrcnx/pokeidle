import { MiniChat } from "./MiniChat";
import { ChannelHeader } from "./ChannelHeader";

// LEFT rail (Twitch-stream layout): chat is the elastic watch surface
// that absorbs all vertical slack. A 44px ChannelHeader sits on top —
// "CHAT" label + green-dot save status + live online count — so the
// column shares its top line with the right-rail dock and the arena
// header. Dock actions, Next Goal, profile strip, and inventory
// ribbon all moved to the RIGHT rail.
export function LocationColumn() {
  return (
    <div className="location-column chat-column">
      <ChannelHeader />
      <MiniChat />
    </div>
  );
}
