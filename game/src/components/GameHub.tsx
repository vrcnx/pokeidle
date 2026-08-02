import { HubModal, type HubSectionContent, type HubSection } from "./HubModal";
import { RewardsBody, RewardsHeaderRight } from "./GiveawayModal";
import { SocialPane } from "./SocialPanel";
import { PvpHubPane, PvpHeaderRight } from "./PvpHubModal";
import { SettingsPane } from "./GlobalDock";
import { usePvpState } from "../state/pvp";
import { useT } from "../i18n/useT";

// Where the four sections meet the frame.
//
// This file exists so that HubModal.tsx knows nothing about PvP, Social,
// Settings or Rewards, and none of those four knows about the other three.
// The frame draws a shell; the sections draw panes; this is the only module
// that has heard of both. Adding a fifth section is one entry here and one
// line in HubModal's SECTIONS — nothing else in the game changes.
//
// Every value is a COMPONENT, so the frame mounts only the section a player
// is actually looking at. That is not a micro-optimisation: Social opens a
// socket subscription and polls the friends list, Battle polls the queue and
// the leaderboard, and Rewards refetches promos. Building all four to render
// one would put three subsystems on the wire so somebody could change the
// music volume.
const SECTIONS: Record<HubSection, HubSectionContent> = {
  pvp: {
    Body: PvpHubPane,
    HeaderRight: PvpHeaderRight,
    note: "Ranked ladder, casual matches and tournaments.",
  },
  rewards: {
    Body: RewardsBody,
    HeaderRight: RewardsHeaderRight,
    note: "Everything you can get for free — no purchase, ever.",
  },
  social: {
    Body: SocialPane,
    // Chat lays out to the pane's full height and scrolls its own message
    // list; an outer scroll would push the composer below the fold.
    fill: true,
  },
  settings: {
    Body: SettingsPane,
    note: "Your account, your game, and the knobs.",
  },
};

export function GameHub() {
  const t = useT();
  const pvp = usePvpState();

  // Battle is unusable while a battle is in progress — the pane's entire
  // subject is starting one. The reason travels with the flag so the rail can
  // put it in a tooltip instead of just grey­ing a row out and leaving the
  // player to guess.
  const disabled = pvp.room ? { pvp: t("You're already in a PvP battle") } : undefined;

  return <HubModal sections={SECTIONS} disabled={disabled} />;
}
