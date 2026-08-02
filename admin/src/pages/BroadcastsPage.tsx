import { navigateTo } from "../App";
import { PageActions } from "../components/PageChrome";
import { ChatModerationPage } from "./ChatModerationPage";
import { AnnouncementsPage } from "./AnnouncementsPage";
import { PollsPage } from "./PollsPage";

// Global chat, and everything that gets posted into it.
//
// ── WHY THESE THREE ARE ONE PAGE ────────────────────────────────────
// They share a DESTINATION. A chat message, a pinned banner, a one-off
// broadcast and a poll all land in the same place in front of the same
// players; they differ only in how long the card stays and whether it
// answers back. The chat page's own composer already offers "Announce",
// so the overlap existed before this — it was just split across two nav
// entries.
//
// The practical win is that composing and watching are now the same visit.
// Writing an announcement while the room you are announcing into is one tab
// away means you can see whether it landed, and whether it was needed.
//
// ── WHY THEY ARE STILL SEPARATE TABS ────────────────────────────────
// Watching is a monitoring surface you leave open, with polling and a
// keyboard-driven bulk workflow. Composing is a form you visit to do one
// thing. Stacking a form under a live feed would push the feed off screen
// exactly when you want both.
//
// ── NOT THE SAME AS "Twitch stream" ─────────────────────────────────
// The Tools group has a page that was called Broadcast; it drives the 24/7
// Twitch renderer and has nothing to do with messaging players.

export function BroadcastsPage({ tab }: { tab: "chat" | "announcements" | "polls" }) {
  return (
    <div className={`page broadcasts-page broadcasts-page--${tab}`}>
      <PageActions>
        <div className="seg-toggle" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === "chat"}
                  className={`seg-tab ${tab === "chat" ? "active" : ""}`}
                  onClick={() => navigateTo("chat")}>Chat</button>
          <button role="tab" aria-selected={tab === "announcements"}
                  className={`seg-tab ${tab === "announcements" ? "active" : ""}`}
                  onClick={() => navigateTo("announcements")}>Announcements</button>
          <button role="tab" aria-selected={tab === "polls"}
                  className={`seg-tab ${tab === "polls" ? "active" : ""}`}
                  onClick={() => navigateTo("polls")}>Polls</button>
        </div>
      </PageActions>
      {tab === "chat" && <ChatModerationPage />}
      {tab === "announcements" && <AnnouncementsPage />}
      {tab === "polls" && <PollsPage />}
    </div>
  );
}
