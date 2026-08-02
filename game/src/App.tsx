import { useGame } from "./state/GameContext";
import { useBattleLoop } from "./hooks/useBattleLoop";
import { useIsPvpBattle } from "./state/pvp";
import { useEventDriver } from "./hooks/useEventDriver";
import { useAutoProceed } from "./hooks/useAutoProceed";
import { useCatchAnimation } from "./hooks/useCatchAnimation";
import { useShinyAnnounce } from "./hooks/useShinyAnnounce";
import { useAutoEvolve } from "./hooks/useAutoEvolve";
import { useStreamStartRoute } from "./hooks/useStreamStartRoute";
import { useStreamAutoPlay } from "./hooks/useStreamAutoPlay";
import { useTradeDeepLink } from "./hooks/useTradeDeepLink";
import { StarterSelect } from "./components/StarterSelect";
import { GameShell } from "./components/GameShell";
import { ContextMenuHost } from "./components/ContextMenu";
import { MusicPlayer } from "./components/MusicPlayer";
import { ToastHost } from "./components/Toast";
import { UpdateNotice } from "./components/UpdateNotice";
import { VersionBadge } from "./components/VersionBadge";

// useAutoEvolve runs level evolutions on their own (default on, per-Pokémon
// opt-out); stones and the Link Cable stay manual because they cost an item.
// EventDriver consumes pendingEvents at typewriter pace.
// useAutoProceed travels to newly unlocked routes when the toggle is on.
// useCatchAnimation resolves manual catches after the throw/shake animation.
export function App() {
  const { state } = useGame();
  // A PvP battle suspends idle turn PRODUCTION. Without this the idle game
  // keeps grinding invisibly behind the arena — the loop is mounted here,
  // above GameShell, so swapping the centre column does not stop it.
  // useEventDriver and useCatchAnimation are deliberately NOT suspended:
  // they only CONSUME, so an in-flight turn or ball throw finishes cleanly
  // instead of being stranded half-resolved.
  const pvpBattle = useIsPvpBattle();
  useBattleLoop(pvpBattle);
  useEventDriver();
  useAutoProceed();
  useAutoEvolve(pvpBattle);
  useCatchAnimation();
  // Announces a shiny catch in global chat. Mounted here beside the other
  // consumers rather than inside a chat component: it must fire whether or
  // not the chat panel is on screen, and on mobile it usually is not.
  useShinyAnnounce();
  useStreamStartRoute();
  useStreamAutoPlay();
  // `?trade=<username>` from a Discord noticeboard listing. One-shot, and it
  // consumes the query param before firing so a refresh can't re-invite.
  useTradeDeepLink();

  return (
    <>
      {state.phase === "starterSelect" ? <StarterSelect /> : <GameShell />}
      <ContextMenuHost />
      <MusicPlayer />
      <ToastHost />
      <UpdateNotice />
      <VersionBadge />
    </>
  );
}
