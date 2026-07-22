// Shared between MiniChat.tsx and SocialPanel.tsx — both render the
// same system-voice chat kinds (server announcements, giveaway/gift
// broadcasts), and a divergent copy in one file but not the other is
// exactly the kind of bug this codebase has hit before.
export function isSystemKind(kind: string | undefined): boolean {
  return kind === "announcement" || kind === "giveaway" || kind === "giveawayOpen" || kind === "gift" || kind === "pollOpen";
}

export const SYSTEM_CARD_META: Record<string, { icon: string; label: string }> = {
  giveawayOpen: { icon: "🎁", label: "New Giveaway" },
  giveaway: { icon: "🎉", label: "Giveaway" },
  gift: { icon: "🎀", label: "Gift" },
  announcement: { icon: "📢", label: "Announcement" },
  pollOpen: { icon: "🗳️", label: "Poll" },
};
