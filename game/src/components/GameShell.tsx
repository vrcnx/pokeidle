import { useEffect } from "react";
import { PartyColumn } from "./PartyColumn";
import { useLayoutMode } from "../state/layoutMode";
import { CenterColumn } from "./CenterColumn";
import { LocationColumn } from "./LocationColumn";
import { MobileShell } from "./MobileShell";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useGame } from "../state/GameContext";
import { bindTradeSocket } from "../state/trade";
import { bindPresenceSocket } from "../state/presence";
import { bindAnnouncementSocket } from "../state/announcement";
import { bindPvpSocket } from "../state/pvp";
import { bindAuctionUiSocket } from "../state/auctions";
import { AuctionNotifyToast } from "./AuctionNotifyToast";
import { warmupParty, warmupSpecies } from "../utils/spriteWarmup";
import { useAchievementTracker } from "../state/achievements";
import { AchievementToast } from "./AchievementToast";
import { AchievementsModal } from "./AchievementsModal";
import { GameHub } from "./GameHub";
import { EvolutionModal } from "./EvolutionModal";
import { RegionStarterSelect } from "./RegionStarterSelect";
import { ChangelogModal } from "./ChangelogModal";
import { HowToPlayModal } from "./HowToPlayModal";
import { DailyRewardModal } from "./DailyRewardModal";
import { WelcomeBackRouter } from "./WelcomeBackModal";
import { beginWelcomeBack } from "../state/welcomeBack";
import { PokemonDetailModal } from "./PokemonDetailModal";
import { UseItemMount } from "./UseItemModal";
import { ManageMovesModal } from "./ManageMovesModal";
import { CatchSettingsModal } from "./CatchSettingsModal";
import { AppBackground } from "./AppBackground";
import { RewardShopModal } from "./RewardShopPanel";
import { LegalModal } from "./LegalModal";
import { TradeAnimation } from "./TradeAnimation";
import { BattleLogModal } from "./BattleLogModal";
import { PublicTrainerCardMount } from "./TrainerCardModal";
import { TradeInviteToast } from "./TradeInviteToast";
import { TradeRoomModal } from "./TradeRoomModal";
import { BattleInviteToast } from "./BattleInviteToast";
import { TeamBuilderModal } from "./TeamBuilderModal";
import { RandomBattleQueueToast } from "./RandomBattleQueueToast";
import { PvpReplayModal } from "./PvpReplayModal";
import { PvpSpectatorModal } from "./PvpSpectatorModal";
import { ReportBugModal } from "./ReportBugModal";

// Three-column dashboard layout. A floating <GlobalDock> at the top-right
// holds every "open a drawer" action (Settings, Mart, Bag, PC, Pokédex,
// Info) plus the immediate Heal button — so the persistent UI stays
// focused on game state (party, battle, location).

export function GameShell() {
  const isMobile = useMediaQuery("(max-width: 900px)");
  // Opt-in wide desktop layout. Classic stays the default.
  const layout = useLayoutMode();
  const { state } = useGame();
  // Bind trade socket listeners once GameShell mounts (i.e. once the
  // user is authenticated). The bind is idempotent — the module guards
  // against double-subscribing if GameShell unmounts and remounts.
  useEffect(() => {
    bindTradeSocket();
    bindPresenceSocket();
    bindAnnouncementSocket();
    bindPvpSocket();
    bindAuctionUiSocket();
    // Arms the welcome-back collection window. Order-independent: the sources
    // may already have reported by now (React runs child effects first), and
    // the decision reads everything it needs when it is made.
    beginWelcomeBack();
  }, []);
  // Warm Pokémon-sprite browser cache for everything the player is
  // likely to see soon: party (both facings + shiny variant) on every
  // change, plus the species the player has already seen at idle.
  // This is what makes the wild-encounter sprite render instantly
  // rather than flickering in mid-battle. See utils/spriteWarmup for
  // why we chose preload-into-browser-cache over IndexedDB/SW.
  useEffect(() => {
    warmupParty(state.party);
  }, [state.party]);
  useEffect(() => {
    // Cap the seen-list warm to the first 30 species so we don't
    // hammer the CDN on Pokédex-complete saves. The player's RECENT
    // encounters are the ones we actually need warm; the long-tail
    // (Tauros they caught once last week) can take the normal hit.
    const seen = state.pokedexSeen.slice(-30).map((speciesKey) => ({ speciesKey }));
    warmupSpecies(seen);
  }, [state.pokedexSeen]);

  // Achievement tracker — derives unlocked-id set from GameState +
  // PvP/trade snapshots and fires unlock-toast events for any newly
  // unlocked achievements relative to localStorage. First-run pass is
  // silent so historical unlocks don't spam the player at boot.
  useAchievementTracker(state, {});
  return (
    <div className="game-window">
      <AppBackground />
      {isMobile ? (
        <MobileShell />
      ) : (
        <div className={`dashboard ${layout === "wide" ? "dashboard-wide" : ""}`}>
          {/* Twitch-stream layout: chat LEFT (elastic watch surface),
              arena CENTER (focal point), control panel RIGHT (party +
              actions + goal + profile). Chat absorbs all vertical
              slack so the left rail never reads half-empty. */}
          <LocationColumn wide={layout === "wide"} />
          <CenterColumn wide={layout === "wide"} />
          <PartyColumn showProfileStrip={false} wide={layout === "wide"} />
        </div>
      )}

      <EvolutionModal />
      <RegionStarterSelect />
      {/* The one surface allowed to open itself on return. The daily reward,
          the away stipend, the release notes and the gift toast used to each
          decide independently, so they stacked — see state/welcomeBack.ts.
          DailyRewardModal and ChangelogModal are still mounted because both
          are reachable from Settings; neither auto-opens any more. */}
      <WelcomeBackRouter />
      <ChangelogModal />
      <HowToPlayModal />
      <DailyRewardModal />
      <PokemonDetailModal />
      <UseItemMount />
      <ManageMovesModal />
      <CatchSettingsModal />
      <RewardShopModal />
      <LegalModal />
      <TradeAnimation />
      <BattleLogModal />
      <PublicTrainerCardMount />
      <TradeRoomModal />
      <TradeInviteToast />
      <AuctionNotifyToast />
      {/* PvpBattleModal is retired: the arena (CenterColumn + PartyColumn)
          renders a PvP battle in place now. Leaving it mounted meant BOTH
          rendered during a battle, and since it is a .modal-overlay it sat on
          top and hid the arena completely. */}
      <BattleInviteToast />
      <TeamBuilderModal />
      <RandomBattleQueueToast />
      <PvpReplayModal />
      <PvpSpectatorModal />
      <ReportBugModal />
      <AchievementsModal />
      {/* One dialog for PvP, Rewards, Social and Settings. It replaced four,
          three of which were mounted here and one inside the dock. */}
      <GameHub />
      <AchievementToast />
    </div>
  );
}
