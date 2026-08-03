import { HubModal, type HubSectionContent, type HubSection } from "./HubModal";
import { RewardsBody, RewardsHeaderRight } from "./GiveawayModal";
import { SocialPane } from "./SocialPanel";
import { PvpHubPane, PvpHeaderRight } from "./PvpHubModal";
import { SettingsPane } from "./GlobalDock";
import { TrainerSelfPane } from "./TrainerCardModal";
import { MartTab, BagTab, PCTab, DexTab } from "./BottomTabs";
import { PcPartyAside } from "./PcPartyAside";
import { AuctionBoard } from "./AuctionBoard";
import { PokemonDetailModal } from "./PokemonDetailModal";
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
/** The auction house as a hub section rather than a tab inside the chat
 *  panel. Same component; it was only ever mounted in the wrong place. */
function AuctionBoardPane() {
  return <AuctionBoard />;
}

/** The detail sheet, drawn inside the PC rather than on top of the game. */
function PcDetailLayer() {
  return <PokemonDetailModal inline />;
}

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
  // The one section with a working third column instead of a picture: the
  // box and the party are two halves of one job, and a drag between them
  // only works if both are on screen.
  pc:   {
    Body: PCTab,
    fill: true,
    Aside: PcPartyAside,
    // Details open over the box, not over the whole screen. Mounting it here
    // also makes it the sheet's host for as long as the PC is open — the
    // global copy in GameShell stands down. See PokemonDetailModal.
    Layer: PcDetailLayer,
  },
  dex:  { Body: DexTab, fill: true },
  pvp: {
    Body: PvpHubPane,
    HeaderRight: PvpHeaderRight,
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
  },
  auctions: {
    Body: AuctionBoardPane,
    fill: true,
  },
  // No rail row — the identity block at the top of the rail IS this
  // section's door. See `rail: false` in HubModal's SECTIONS.
  trainer: {
    Body: TrainerSelfPane,
    note: "Badges, records, and everything you have caught.",
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
  // ── Locked out during a PvP battle ────────────────────────────────
  // A ranked battle is played against another person on a server that holds
  // the authoritative team. Travelling, buying, selling, depositing or
  // reorganising mid-match changes the save under a fight that has already
  // been handed a copy of it — so the two disagree, and the disagreement is
  // resolved in whichever direction the reconcile happens to run.
  //
  // Battle itself stays OPEN, and that is the point of the list: everything
  // that acts on your save is closed, and the one section that tells you
  // about the match you are in is not.
  const busy = pvp.room ? t("Not while you're in a battle") : null;
  const disabled = busy
    ? { map: busy, mart: busy, bag: busy, pc: busy, dex: busy }
    : undefined;

  return <HubModal sections={SECTIONS} disabled={disabled} identity={<HubIdentity />} identitySection="trainer" />;
}
