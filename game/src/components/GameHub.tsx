import { HubModal, type HubSectionContent, type HubSection } from "./HubModal";
import { RewardsBody, RewardsHeaderRight } from "./GiveawayModal";
import { SocialPane } from "./SocialPanel";
import { PvpHubPane, PvpHeaderRight } from "./PvpHubModal";
import { SettingsPane } from "./GlobalDock";
import { MartTab, BagTab, PCTab, DexTab } from "./BottomTabs";
import { RouteCardList } from "./RouteCardList";
import { usePvpState } from "../state/pvp";
import { useGame } from "../state/GameContext";
import { useAuth } from "../auth/AuthContext";
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
  // The five that used to be a tab strip pinned under the battle scene.
  // They were always the same five destinations the hub is for — they just
  // had their own navigation, in their own corner, competing with it.
  // `fill` on all of them: each already manages its own scrolling region
  // (a route list, a box grid, a dex), and an outer scroll on top of an
  // inner one is how the PC ended up with two scrollbars.
  map:  { Body: RouteCardList, fill: true },
  mart: { Body: MartTab, fill: true },
  bag:  { Body: BagTab, fill: true },
  pc:   { Body: PCTab, fill: true },
  dex:  { Body: DexTab, fill: true },
  pvp: {
    Body: PvpHubPane,
    HeaderRight: PvpHeaderRight,
    note: "Ranked ladder, casual matches and tournaments.",
  },
  rewards: {
    Body: RewardsBody,
    HeaderRight: RewardsHeaderRight,
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

/**
 * The player, at the top of the rail.
 *
 * The frame takes this as a slot rather than reading it, so HubModal.tsx
 * still knows nothing about saves, auth or currency — but the rail's first
 * block is the one place in this dialog where naming the person looking at
 * it is worth more than naming the dialog.
 */
function HubIdentity() {
  const { state } = useGame();
  const { me } = useAuth();
  const t = useT();
  const name = me?.name ?? me?.username ?? t("Trainer");
  const initial = name[0]?.toUpperCase() ?? "?";
  return (
    <div className="hub-me">
      <span className="hub-me-avatar" aria-hidden>{initial}</span>
      <span className="hub-me-text">
        <span className="hub-me-name">{name}</span>
        <span className="hub-me-meta">
          <span>{t("Lv")} <strong>{me?.accountLevel ?? 1}</strong></span>
          <span className="is-gold">${state.money.toLocaleString()}</span>
        </span>
      </span>
    </div>
  );
}

export function GameHub() {
  const t = useT();
  const pvp = usePvpState();

  // Battle is unusable while a battle is in progress — the pane's entire
  // subject is starting one. The reason travels with the flag so the rail can
  // put it in a tooltip instead of just grey­ing a row out and leaving the
  // player to guess.
  const disabled = pvp.room ? { pvp: t("You're already in a PvP battle") } : undefined;

  return <HubModal sections={SECTIONS} disabled={disabled} identity={<HubIdentity />} />;
}
