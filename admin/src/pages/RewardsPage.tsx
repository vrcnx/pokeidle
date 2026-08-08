import { navigateTo } from "../App";
import { PageActions } from "../components/PageChrome";
import { GiveawaysPage } from "./GiveawaysPage";
import { MassGiftPage } from "./MassGiftPage";
import { ReferralPanel } from "../components/ReferralPanel";
import { RedditPanel } from "../components/RedditPanel";

// Giving players things, on one page.
//
// ── WHY THEY ARE ONE PAGE ───────────────────────────────────────────
// A giveaway and a mass gift are the same act with a different selection
// rule: build a prize, choose who gets it, deliver it through PendingGrant.
// They share the prize builder, the delivery path, the audit shape and the
// announce-in-chat option — and an operator deciding "should this be a draw
// or should everyone get it?" was having to pick a NAV ITEM before they could
// see either tool.
//
// Referrals is the third: same act again, with the selection rule handed to
// the players themselves — they choose who gets invited, and the prize is
// paid for bringing somebody rather than for being chosen. It is a standing
// programme rather than a one-off act, which is why it is a settings panel
// where the other two are forms.
//
// ── WHY THEY ARE STILL SEPARATE TABS ────────────────────────────────
// The difference that remains is the one that matters: a giveaway is opt-in
// and drawn once from a stored seed, a mass gift lands in every targeted save
// immediately. Merging the forms would mean one screen where a checkbox
// changes whether the thing you are about to do is reversible.

export function RewardsPage({ tab }: { tab: "giveaways" | "massgift" | "referrals" | "reddit" }) {
  return (
    <div className="page rewards-page">
      <PageActions>
        <div className="seg-toggle" role="tablist" aria-label="View">
          <button role="tab" aria-selected={tab === "giveaways"}
                  className={`seg-tab ${tab === "giveaways" ? "active" : ""}`}
                  onClick={() => navigateTo("giveaways")}>Giveaways</button>
          <button role="tab" aria-selected={tab === "massgift"}
                  className={`seg-tab ${tab === "massgift" ? "active" : ""}`}
                  onClick={() => navigateTo("massgift")}>Mass gift</button>
          <button role="tab" aria-selected={tab === "referrals"}
                  className={`seg-tab ${tab === "referrals" ? "active" : ""}`}
                  onClick={() => navigateTo("referrals")}>Referrals</button>
          {/* Its own tab rather than a section of Referrals: this is the one
              promotion here whose payout is UNVERIFIED, so the page that
              reviews it should be somewhere an operator goes deliberately. */}
          <button role="tab" aria-selected={tab === "reddit"}
                  className={`seg-tab ${tab === "reddit" ? "active" : ""}`}
                  onClick={() => navigateTo("reddit")}>Reddit</button>
        </div>
      </PageActions>
      {tab === "giveaways" ? <GiveawaysPage />
        : tab === "massgift" ? <MassGiftPage />
        : tab === "referrals" ? <ReferralPanel />
        : <RedditPanel />}
    </div>
  );
}
