import { useEffect } from "react";
import { PartyColumn } from "./PartyColumn";
import { CenterColumn } from "./CenterColumn";
import { LocationColumn } from "./LocationColumn";
import { MobileShell } from "./MobileShell";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { bindTradeSocket } from "../state/trade";
import { EvolutionModal } from "./EvolutionModal";
import { ChangelogModal } from "./ChangelogModal";
import { PokemonDetailModal } from "./PokemonDetailModal";
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
import { ReportBugModal } from "./ReportBugModal";

// Three-column dashboard layout. A floating <GlobalDock> at the top-right
// holds every "open a drawer" action (Settings, Mart, Bag, PC, Pokédex,
// Info) plus the immediate Heal button — so the persistent UI stays
// focused on game state (party, battle, location).

export function GameShell() {
  const isMobile = useMediaQuery("(max-width: 900px)");
  // Bind trade socket listeners once GameShell mounts (i.e. once the
  // user is authenticated). The bind is idempotent — the module guards
  // against double-subscribing if GameShell unmounts and remounts.
  useEffect(() => {
    bindTradeSocket();
  }, []);
  return (
    <div className="game-window">
      <AppBackground />
      {isMobile ? (
        <MobileShell />
      ) : (
        <div className="dashboard">
          <PartyColumn />
          <CenterColumn />
          <LocationColumn />
        </div>
      )}

      <EvolutionModal />
      <ChangelogModal />
      <PokemonDetailModal />
      <ManageMovesModal />
      <CatchSettingsModal />
      <RewardShopModal />
      <LegalModal />
      <TradeAnimation />
      <BattleLogModal />
      <PublicTrainerCardMount />
      <TradeRoomModal />
      <TradeInviteToast />
      <ReportBugModal />
    </div>
  );
}
