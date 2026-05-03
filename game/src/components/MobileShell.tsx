import { useEffect, useRef, useState } from "react";
import { useGame } from "../state/GameContext";
import { gymLeaders } from "../data/gymLeaders";
import { BattleScene } from "./BattleScene";
import { MovesPanel, MovesToolbar } from "./MovesPanel";
import { TownMap } from "./TownMap";
import { PartyColumn } from "./PartyColumn";
import { ContextPanel } from "./ContextPanel";
import { BottomTabs } from "./BottomTabs";
import { MetaDock } from "./GlobalDock";
import { MiniChat } from "./MiniChat";
import { IconPin, IconBag, IconMap, IconChat } from "./Icon";

// Mobile single-column layout. Battle scene + moves are always pinned at the
// top; the bottom area is a swappable panel driven by the tab bar.
//   Here    = adaptive ContextPanel (mirrors right column on desktop)
//   Party   = party list + bottom-tabs (Map / Mart / Bag / PC / Dex)
//   Map     = town map (full-screen for navigation)
//   Chat    = mini-chat (Global + Local)
type MobileTab = "here" | "party" | "map" | "chat";
const TABS: { id: MobileTab; label: string }[] = [
  { id: "here",  label: "Here" },
  { id: "party", label: "Party" },
  { id: "map",   label: "Map" },
  { id: "chat",  label: "Chat" },
];

function tabIcon(id: MobileTab) {
  switch (id) {
    case "here":  return <IconPin size={18} />;
    case "party": return <IconBag size={18} />;
    case "map":   return <IconMap size={18} />;
    case "chat":  return <IconChat size={18} />;
  }
}

export function MobileShell() {
  const { state } = useGame();
  const [tab, setTab] = useState<MobileTab>("here");

  // Auto-hop to "Here" on the FIRST entry into a boss battle (gym leaders,
  // E4, champion) so the player notices, but not on every wild/trainer
  // tick — those happen constantly and yanking the user is annoying.
  const lastBossPhase = useRef(state.phase === "bossBattle");
  useEffect(() => {
    const isBoss = state.phase === "bossBattle";
    if (isBoss && !lastBossPhase.current) setTab("here");
    lastBossPhase.current = isBoss;
  }, [state.phase]);

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="mobile-stats">
          <span><span className="mobile-stat-icon">💰</span> ${state.money.toLocaleString()}</span>
          <span><span className="mobile-stat-icon">🏅</span> {state.defeatedGyms.length}/{gymLeaders.length}</span>
          {state.victoryTokens > 0 && (
            <span><span className="mobile-stat-icon">🎟</span> {state.victoryTokens}</span>
          )}
          {state.championDefeated && <span title="Champion">👑</span>}
        </div>
        <div className="mobile-meta-buttons">
          <MetaDock />
        </div>
      </header>

      <div className="mobile-arena">
        <BattleScene />
        <MovesToolbar />
        <MovesPanel />
      </div>

      <div className="mobile-content">
        {tab === "here" && <ContextPanel />}
        {tab === "party" && (
          <>
            <PartyColumn />
            <BottomTabs />
          </>
        )}
        {tab === "map" && <TownMap />}
        {tab === "chat" && <MiniChat />}
      </div>

      <nav className="mobile-tabbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon">{tabIcon(t.id)}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
