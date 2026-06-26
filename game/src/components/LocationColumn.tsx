import { MiniChat } from "./MiniChat";

// LEFT rail (Twitch-stream layout): chat is the elastic watch surface
// that absorbs all vertical slack. Dock actions, Next Goal, profile
// strip, and inventory ribbon all moved to the RIGHT rail
// (PartyColumn) so chat finally gets the full column to itself.
export function LocationColumn() {
  return (
    <div className="location-column chat-column">
      <MiniChat />
    </div>
  );
}
