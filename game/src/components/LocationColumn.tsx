import { MiniChat } from "./MiniChat";
import { PlayerCard } from "./PlayerCard";
import { ChannelHeader } from "./ChannelHeader";
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
      {/* THE TRAINER CARD, top-left.
          It replaces both the profile strip and the PvP/Settings/Social
          dock that used to sit here. The strip showed Lv, money and badges
          — all three of which this card shows — so keeping both would have
          printed the same numbers twice, 40px apart. The strip's action
          (open the trainer card) is what pressing this card does.
          The dock's three buttons are the second row of shortcuts: they
          point at hub sections like the other five, so a separate toolbar
          for them was one toolbar too many. */}
      <PlayerCard />
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
