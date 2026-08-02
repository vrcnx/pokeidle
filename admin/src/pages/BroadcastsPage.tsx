import { navigateTo } from "../App";
import { PageActions } from "../components/PageChrome";
import { AnnouncementsPage } from "./AnnouncementsPage";
import { PollsPage } from "./PollsPage";

// Things you send to every player, on one page.
//
// ── WHY THEY ARE ONE PAGE ───────────────────────────────────────────
// A banner, a chat broadcast and a poll are three ways of putting a card in
// front of the whole player base. They differ in how long it stays and
// whether it answers back — not in what the operator is doing, which is
// "tell everyone something". Two nav slots for that was one too many, and
// the choice between "post this as a broadcast" and "post this as a poll"
// is exactly the kind of decision you want to make with both options in
// view.
//
// ── NOT THE SAME AS "Twitch stream" ─────────────────────────────────
// The Tools group has a page that was called Broadcast; it drives the 24/7
// Twitch renderer and has nothing to do with messaging players. It is now
// called Twitch stream, because two unrelated things called Broadcast in one
// nav is a trap regardless of which one you are looking for.

export function BroadcastsPage({ tab }: { tab: "announcements" | "polls" }) {
  return (
    <div className="page broadcasts-page">
      <PageActions>
        <div className="seg-toggle" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === "announcements"}
                  className={`seg-tab ${tab === "announcements" ? "active" : ""}`}
                  onClick={() => navigateTo("announcements")}>Announcements</button>
          <button role="tab" aria-selected={tab === "polls"}
                  className={`seg-tab ${tab === "polls" ? "active" : ""}`}
                  onClick={() => navigateTo("polls")}>Polls</button>
        </div>
      </PageActions>
      {tab === "announcements" ? <AnnouncementsPage /> : <PollsPage />}
    </div>
  );
}
