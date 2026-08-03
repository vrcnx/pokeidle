// Shared between MiniChat.tsx and SocialPanel.tsx — both render the
// same system-voice chat kinds (server announcements, giveaway/gift
// broadcasts), and a divergent copy in one file but not the other is
// exactly the kind of bug this codebase has hit before.
export function isSystemKind(kind: string | undefined): boolean {
  return kind === "announcement" || kind === "giveaway" || kind === "giveawayOpen"
    || kind === "gift" || kind === "pollOpen" || kind === "shiny";
}

export const SYSTEM_CARD_META: Record<string, { icon: string; label: string }> = {
  giveawayOpen: { icon: "🎁", label: "New Giveaway" },
  giveaway: { icon: "🎉", label: "Giveaway" },
  gift: { icon: "🎀", label: "Gift" },
  announcement: { icon: "📢", label: "Announcement" },
  pollOpen: { icon: "🗳️", label: "Poll" },
  // KEPT AFTER THE FEATURE WAS REMOVED. Nothing produces `kind: "shiny"`
  // any more — the announcement flooded global chat and was taken out — but
  // months of rows carrying that kind are still in the database. Without
  // this entry they would fall through to the ordinary chat-bubble path and
  // render as something the player typed, which is precisely what the
  // system-card treatment existed to prevent.
  shiny: { icon: "✨", label: "Shiny" },
};
