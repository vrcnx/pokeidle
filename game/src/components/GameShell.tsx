import { useEffect } from "react";
import { MinimalShell } from "./MinimalShell";
import { MobileShell } from "./MobileShell";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { bindTradeSocket } from "../state/trade";
import { bindPresenceSocket } from "../state/presence";
import { bindPvpSocket } from "../state/pvp";
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
import { BattleInviteToast } from "./BattleInviteToast";
import { PvpBattleModal } from "./PvpBattleModal";
import { TeamBuilderModal } from "./TeamBuilderModal";
import { RandomBattleQueueToast } from "./RandomBattleQueueToast";
import { PvpHubModal } from "./PvpHubModal";
import { PvpReplayModal } from "./PvpReplayModal";
import { PvpSpectatorModal } from "./PvpSpectatorModal";
import { ReportBugModal } from "./ReportBugModal";

// Minimal "AAA-feeling" desktop shell. The battle scene fills the
// viewport and every UI affordance floats over it as a transparent
// overlay — top-bar nav, left party rail, bottom action bar, and
// edge-anchored hints for chat & TAB. Mobile keeps its own dedicated
// single-column shell.

export function GameShell() {
  const isMobile = useMediaQuery("(max-width: 900px)");
  // Bind trade socket listeners once GameShell mounts (i.e. once the
  // user is authenticated). The bind is idempotent — the module guards
  // against double-subscribing if GameShell unmounts and remounts.
  useEffect(() => {
    bindTradeSocket();
    bindPresenceSocket();
    bindPvpSocket();
  }, []);
  return (
    <div className="game-window">
      <AppBackground />
      {isMobile ? (
        <MobileShell />
      ) : (
        <MinimalShell />
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
      <PvpBattleModal />
      <BattleInviteToast />
      <TeamBuilderModal />
      <RandomBattleQueueToast />
      <PvpHubModal />
      <PvpReplayModal />
      <PvpSpectatorModal />
      <ReportBugModal />
    </div>
  );
}
