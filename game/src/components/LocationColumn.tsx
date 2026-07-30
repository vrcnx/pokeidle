import { MiniChat } from "./MiniChat";
import { MetaDock } from "./GlobalDock";
import { ChannelHeader } from "./ChannelHeader";
import { InventoryRibbon } from "./InventoryRibbon";
import { UnlockHint } from "./ContextPanel";
import { GiveawayRail } from "./GiveawayRail";

// LEFT rail (Twitch-stream layout): chat is the elastic watch surface
// that absorbs all vertical slack. The profile strip (Lv / $ / badges) and
// the Next Goal card sit at the very top of this rail, above the chat card
// — the right rail hides its copies so they aren't shown twice. Below them
// a 44px ChannelHeader ("CHAT" label + save status + online count), then
// the chat itself.
export function LocationColumn({ wide = false }: { wide?: boolean }) {
  return (
    <div className="location-column chat-column">
      <InventoryRibbon />
      {/* Wide: PvP / Settings / Social sit directly under the trainer card. */}
      {wide && <MetaDock />}
      <UnlockHint />
      {/* The only always-present way into giveaways. It sits here, between
          the goal card and chat, because a giveaway announcement arrives IN
          chat — so the standing control and the thing that announces it are
          adjacent, and a player who scrolled past the announcement still has
          somewhere to go. 42px, flex:0 0 auto; .chat-card below is the single
          elastic child of this column and absorbs everything else. */}
      <GiveawayRail />
      {/* One card, not two. These were siblings of the flex column, so the
          column's `gap` drove a visible seam between them no matter what the
          borders did — CSS can't close a gap for a single pair. Wrapping them
          makes them a single flex child that owns its own internal spacing. */}
      <div className="chat-card">
        <ChannelHeader />
        <MiniChat />
      </div>
    </div>
  );
}
