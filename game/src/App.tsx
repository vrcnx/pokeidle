import { useGame } from "./state/GameContext";
import { useBattleLoop } from "./hooks/useBattleLoop";
import { useEventDriver } from "./hooks/useEventDriver";
import { useAutoProceed } from "./hooks/useAutoProceed";
import { useCatchAnimation } from "./hooks/useCatchAnimation";
import { useStreamStartRoute } from "./hooks/useStreamStartRoute";
import { StarterSelect } from "./components/StarterSelect";
import { GameShell } from "./components/GameShell";
import { ContextMenuHost } from "./components/ContextMenu";
import { MusicPlayer } from "./components/MusicPlayer";
import { ToastHost } from "./components/Toast";
import { UpdateNotice } from "./components/UpdateNotice";
import { VersionBadge } from "./components/VersionBadge";

// Evolution is opt-in. EventDriver consumes pendingEvents at typewriter pace.
// useAutoProceed travels to newly unlocked routes when the toggle is on.
// useCatchAnimation resolves manual catches after the throw/shake animation.
export function App() {
  const { state } = useGame();
  useBattleLoop();
  useEventDriver();
  useAutoProceed();
  useCatchAnimation();
  useStreamStartRoute();

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
