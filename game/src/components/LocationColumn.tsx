import { MiniChat } from "./MiniChat";
import { ChannelHeader } from "./ChannelHeader";
import { InventoryRibbon } from "./InventoryRibbon";

// LEFT rail (Twitch-stream layout): chat is the elastic watch surface
// that absorbs all vertical slack. The profile strip (Lv / $ / badges)
// sits at the very top of this rail, above the chat card — the right
// rail hides its copy so it isn't shown twice. Below it, a 44px
// ChannelHeader ("CHAT" label + green-dot save status + live online
// count) then the chat itself.
export function LocationColumn() {
  return (
    <div className="location-column chat-column">
      <InventoryRibbon />
      <ChannelHeader />
      <MiniChat />
    </div>
  );
}
