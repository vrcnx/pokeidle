import { navigateTo } from "../App";
import { PageActions } from "../components/PageChrome";
import { GiveawaysPage } from "./GiveawaysPage";
import { MassGiftPage } from "./MassGiftPage";

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
// ── WHY THEY ARE STILL TWO TABS ─────────────────────────────────────
// The difference that remains is the one that matters: a giveaway is opt-in
// and drawn once from a stored seed, a mass gift lands in every targeted save
// immediately. Merging the forms would mean one screen where a checkbox
// changes whether the thing you are about to do is reversible.

export function RewardsPage({ tab }: { tab: "giveaways" | "massgift" }) {
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
        </div>
      </PageActions>
      {tab === "giveaways" ? <GiveawaysPage /> : <MassGiftPage />}
    </div>
  );
}
